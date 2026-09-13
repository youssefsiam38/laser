import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { McpAuthorizationRegistry, mcpAuthorizationIdentity, mcpAuthorizationIdentities, mcpAuthorizationAccount, mcpAuthorizationPartition, mcpAuthorizationRevision } from "../../src/mcp/authorization.js";
import type { McpConfiguredServer } from "../../src/mcp/store.js";

let root: string;
const server: McpConfiguredServer = { name: "notion", transport: { kind: "http", url: "https://example.test/mcp" } };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), `${PRODUCT_NAME}-mcp-authorization-`)); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

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

  it("fingerprints the SDK's expanded URLs, arguments and relative transport paths", async () => {
    vi.stubEnv("MCP_IDENTITY_HOST", "EXAMPLE.test:443");
    const expanded = { ...server, transport: { kind: "http" as const, url: "https://${MCP_IDENTITY_HOST}/mcp" } };
    const first = await mcpAuthorizationIdentity("global", root, expanded);
    expect(first).toBe(await mcpAuthorizationIdentity("global", root, server));
    vi.stubEnv("MCP_IDENTITY_HOST", "other.test");
    expect(await mcpAuthorizationIdentity("global", root, expanded)).not.toBe(first);
    vi.stubEnv("MCP_IDENTITY_ARG", "first");
    const command = { name: "x", transport: { kind: "stdio" as const, command: "node", args: ["${MCP_IDENTITY_ARG}"], cwd: "sub" } };
    expect(await mcpAuthorizationIdentity("global", root, command)).toBe(await mcpAuthorizationIdentity("global", root, { ...command, transport: { ...command.transport, args: ["first"], cwd: join(root, "sub") } }));
    expect(await mcpAuthorizationIdentity("global", join(root, "other"), command)).not.toBe(await mcpAuthorizationIdentity("global", root, command));
    const socket = { name: "x", transport: { kind: "socket" as const, path: "~/fixture.sock" } };
    expect(await mcpAuthorizationIdentity("global", root, socket)).toBe(await mcpAuthorizationIdentity("global", root, { ...socket, transport: { ...socket.transport, path: join(homedir(), "fixture.sock") } }));
  });

  it("uses the same relative cwd and expanded argument on real stdio transports in two projects", async () => {
    vi.stubEnv("MCP_IDENTITY_ARG", "expanded-argument");
    const script = join(root, "server.mjs");
    await writeFile(script, `import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", line => {
        const q = JSON.parse(line); if (q.id === undefined) return;
        let result;
        if (q.method === "initialize") result = { protocolVersion: q.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:process.cwd(),version:"1"} };
        else if (q.method === "tools/list") result = {tools:[{name:"where",description:"Working directory",inputSchema:{type:"object"}}]};
        else if (q.method === "tools/call") result = {content:[{type:"text",text:process.cwd()+"|"+process.argv[2]}]};
        else if (q.method === "ping") result = {};
        process.stdout.write(JSON.stringify(result === undefined ? {jsonrpc:"2.0",id:q.id,error:{code:-32601,message:"Unsupported"}} : {jsonrpc:"2.0",id:q.id,result})+"\\n");
      });`);
    const { McpInspector } = await import("../../src/mcp/inspector.js");
    const config: McpConfiguredServer = { name: "where", protocolVersion: "legacy", transport: { kind: "stdio", command: process.execPath, args: [script, "${MCP_IDENTITY_ARG}"], cwd: "nested" } };
    const identities: string[] = [];
    for (const project of [join(root, "a"), join(root, "b")]) {
      await mkdir(join(project, "nested"), { recursive: true });
      const inspector = new McpInspector(project, root);
      try {
        identities.push(await mcpAuthorizationIdentity("global", project, config));
        const result = await inspector.inspect({ scope: "global", config, secrets: new Map() });
        expect(result.server?.name).toBe(join(project, "nested"));
        expect(await inspector.call("global", config, new Map(), "where", {})).toMatchObject({ ok: true, content: [{ type: "text", text: `${join(project, "nested")}|expanded-argument` }] });
      } finally { await inspector.dispose(); }
    }
    expect(identities[0]).not.toBe(identities[1]);
  }, 30_000);

  it("canonicalizes logical partitions independently of order and observation time", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const snapshots = await Promise.all((await mcpAuthorizationIdentities("global", root, server)).map(id => registry.establish(id)));
    const reordered = snapshots.toReversed().map(value => ({ ...value, updatedAt: value.updatedAt + 1 }));
    expect(mcpAuthorizationPartition(reordered)).toBe(mcpAuthorizationPartition(snapshots));
    expect(mcpAuthorizationRevision(reordered)).toBe(mcpAuthorizationRevision(snapshots));
    const primary = snapshots[0]!;
    expect(mcpAuthorizationAccount(primary)).toBe(`${primary.identity}:${primary.generation.epoch}`);
    for (const generation of [{ ...primary.generation, counter: primary.generation.counter + 1 }, { ...primary.generation, epoch: "00000000-0000-0000-0000-000000000000" }]) {
      expect(mcpAuthorizationPartition([{ ...primary, generation }, ...snapshots.slice(1)])).not.toBe(mcpAuthorizationPartition(snapshots));
    }
  });

  it.each([false, true])("coalesces fresh setup without locking established reads (established=%s)", async established => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const before = established ? await registry.establish(id) : undefined;
    const snapshots = await Promise.all(Array.from({ length: 12 }, () => new McpAuthorizationRegistry(root).establish(id)));
    expect(snapshots.every(snapshot => JSON.stringify(snapshot) === JSON.stringify(snapshots[0]))).toBe(true);
    if (before) expect(snapshots[0]).toEqual(before);
    expect(await registry.current(snapshots[0]!)).toBe(true);
  });

  it("locks configuration guards during a credential write without advancing their generations", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const ids = await mcpAuthorizationIdentities("global", root, server);
    const snapshots = await Promise.all(ids.map(id => registry.establish(id)));
    const expected = new Map(snapshots.map(snapshot => [snapshot.identity, snapshot]));
    const committed = await registry.revoke([ids[0]!], async next => {
      expect((await Promise.all(snapshots.map(snapshot => registry.current(snapshot)))).every(value => !value)).toBe(true);
      return next;
    }, expected);
    expect(await registry.current(snapshots[0]!)).toBe(false);
    for (const guard of snapshots.slice(1)) {
      expect(committed.get(guard.identity)).toEqual(guard);
      expect(await registry.current(guard)).toBe(true);
    }
    await registry.bump(ids[1]!);
    let saved = false;
    await expect(registry.revoke([ids[0]!], async () => { saved = true; }, committed)).rejects.toThrow("access changed");
    expect(saved).toBe(false);
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

  it("fences another process before token persistence settles and refuses a stale refresh transaction", async () => {
    const registry = new McpAuthorizationRegistry(root);
    const id = await mcpAuthorizationIdentity("global", root, server);
    const snapshot = await registry.establish(id);
    const source = fileURLToPath(new URL("../../src/mcp/authorization.ts", import.meta.url));
    const readFromProcess = async () => {
      const script = `import {createJiti} from "jiti";
        const {McpAuthorizationRegistry}=await createJiti(import.meta.url,{fsCache:false}).import(${JSON.stringify(source)});
        console.log(JSON.stringify(await new McpAuthorizationRegistry(${JSON.stringify(root)}).current(${JSON.stringify(snapshot)})));`;
      const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
      return JSON.parse(result.stdout.trim());
    };
    expect(await readFromProcess()).toBe(true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = registry.revoke([id], async committed => { entered.resolve(); await release.promise; return committed.get(id)!; }, new Map([[id, snapshot]]));
    await entered.promise;
    try { expect(await readFromProcess()).toBe(false); } finally { release.resolve(); }
    const committed = await write;
    expect(await registry.current(committed)).toBe(true);
    expect(await readFromProcess()).toBe(false);
    let saved = false;
    await expect(registry.revoke([id], async () => { saved = true; }, new Map([[id, snapshot]]))).rejects.toThrow("access changed");
    expect(saved).toBe(false);
    expect(await registry.current(committed)).toBe(true);
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
      await expect(registry.establish(id)).rejects.toThrow("being updated");
      expect(await registry.current(snapshot)).toBe(false);
    } finally { await release(); }
    expect(await registry.current(await registry.bump(id))).toBe(true);
  });
});
