import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { McpAuthorizationRegistry, mcpAuthorizationIdentity } from "../../src/mcp/authorization.js";
import type { McpConfiguredServer } from "../../src/mcp/store.js";

let root: string;
const server: McpConfiguredServer = { name: "notion", transport: { kind: "http", url: "https://example.test/mcp" } };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), `${PRODUCT_NAME}-mcp-authorization-`)); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("MCP authorization identities and durable generations", () => {
  it("separates scopes, projects and endpoints, not display names or credentials", async () => {
    const a = await mcpAuthorizationIdentity("project", join(root, "a"), server);
    const b = await mcpAuthorizationIdentity("project", join(root, "b"), server);
    const global = await mcpAuthorizationIdentity("global", root, server);
    expect(new Set([a, b, global]).size).toBe(3);
    expect(await mcpAuthorizationIdentity("global", join(root, "b"), server)).toBe(global);
    expect(await mcpAuthorizationIdentity("global", root, { ...server, name: "other", label: "New label", auth: { kind: "bearer", token: "secret-sentinel" } })).toBe(global);
    expect(await mcpAuthorizationIdentity("global", root, { ...server, transport: { kind: "http", url: "https://other.test/mcp" } })).not.toBe(global);
    expect(global).not.toContain("example");
  });

  it("canonicalizes project aliases", async () => {
    const project = join(root, "project");
    await mkdir(project);
    await symlink(project, join(root, "alias"), "dir");
    expect(await mcpAuthorizationIdentity("project", project, server)).toBe(await mcpAuthorizationIdentity("project", join(root, "alias"), server));
  });

  it("separates command arguments and transport kinds", async () => {
    const command: McpConfiguredServer = { name: "x", transport: { kind: "stdio", command: "node", args: ["server-a.mjs"] } };
    const a = await mcpAuthorizationIdentity("global", root, command);
    const b = await mcpAuthorizationIdentity("global", root, { ...command, transport: { kind: "stdio", command: "node", args: ["server-b.mjs"] } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(await mcpAuthorizationIdentity("global", root, server));
  });

  it("revokes snapshots held by independent worker registries without changing other identities", async () => {
    const workerA = new McpAuthorizationRegistry(root);
    const workerB = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const other = await mcpAuthorizationIdentity("project", root, server);
    const first = await workerA.establish(id);
    const unaffected = await workerB.establish(other);
    expect(await workerB.current(first)).toBe(true);
    const second = await workerB.bump(id);
    expect(second.generation.counter).toBe(first.generation.counter + 1);
    expect(await workerA.current(first)).toBe(false);
    expect(await workerA.current(second)).toBe(true);
    expect(await workerA.current(unaffected)).toBe(true);
    expect(await new McpAuthorizationRegistry(root).establish(id)).toEqual(second);
    const persisted = JSON.parse(await readFile(join(workerA.directory, `${id}.json`), "utf8"));
    expect(Object.keys(persisted).sort()).toEqual(["generation", "identity", "updatedAt"]);
  });

  it.each(["{torn", "{}", "x".repeat(1_024)])("fails stale on corrupt state and repairs only for fresh authorization (%s)", async (contents) => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const old = await registry.establish(id);
    await writeFile(join(registry.directory, `${id}.json`), contents);
    expect(await registry.current(old)).toBe(false);
    const repaired = await registry.establish(id);
    expect(repaired.generation.epoch).not.toBe(old.generation.epoch);
    expect(await registry.current(old)).toBe(false);
    expect(await registry.current(repaired)).toBe(true);
  });

  it("does not wait for a contended writer and treats its cache snapshots as stale", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const snapshot = await registry.establish(id);
    const release = await lockfile.lock(join(registry.directory, `${id}.json`), { realpath: false, retries: 0 });
    try {
      await expect(registry.bump(id)).rejects.toThrow("being updated");
      expect(await registry.current(snapshot)).toBe(false);
    } finally { await release(); }
    expect(await registry.current(await registry.bump(id))).toBe(true);
  });
});
