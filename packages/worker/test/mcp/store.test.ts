/**
 * M14-T2 · where MCP configuration lives: two scopes, the overlay between
 * them, secrets that never enter a shared file, and tolerance for a file a
 * person edited by hand.
 */
import { DATA_DIR_NAME, PRODUCT_NAME, PROJECT_DIR_NAME, type McpServerConfigInput } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpStore } from "../../src/mcp/store.js";

let base: string;
let agentDir: string;
let cwd: string;
let store: McpStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-store-`));
  agentDir = join(base, "agent");
  cwd = join(base, "project");
  mkdirSync(join(agentDir, DATA_DIR_NAME), { recursive: true });
  mkdirSync(join(cwd, PROJECT_DIR_NAME), { recursive: true });
  store = new McpStore(agentDir);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const stdio = (name: string, command = "npx"): McpServerConfigInput => ({
  name,
  transport: { kind: "stdio", command, args: ["-y", `${name}-mcp`] },
  tools: { exposure: "direct" },
});

function writeRaw(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("McpStore", () => {
  it("saves to both scopes and lays the project over the global by name", async () => {
    await store.save("global", cwd, stdio("alpha"));
    await store.save("global", cwd, stdio("beta"));
    await store.save("project", cwd, { ...stdio("beta", "bunx"), label: "Project beta" });

    const { servers } = await store.effective(cwd);
    const project = servers.find((server) => server.scope === "project" && server.config.name === "beta");
    const globalBeta = servers.find((server) => server.scope === "global" && server.config.name === "beta");
    const globalAlpha = servers.find((server) => server.scope === "global" && server.config.name === "alpha");
    expect(project?.effective).toBe(true);
    expect(globalBeta?.shadowed).toBe(true);
    expect(globalBeta?.effective).toBe(false);
    expect(globalAlpha?.effective).toBe(true);

    const enabled = await store.enabled(cwd);
    expect(enabled.map((entry) => `${entry.scope}:${entry.config.name}`).sort()).toEqual(["global:alpha", "project:beta"]);
    expect(enabled.find((entry) => entry.config.name === "beta")?.config.transport).toMatchObject({ command: "bunx" });
  });

  it("lets a project entry with only a name and disabled switch a global server off", async () => {
    await store.save("global", cwd, stdio("alpha"));
    writeRaw(join(cwd, PROJECT_DIR_NAME, "mcp.json"), { version: 1, servers: [{ name: "alpha", disabled: true }] });

    const { servers } = await store.effective(cwd);
    expect(servers.find((server) => server.scope === "project")?.overridesGlobal).toBe(true);
    expect(servers.find((server) => server.scope === "global")?.effective).toBe(false);
    expect(await store.enabled(cwd)).toEqual([]);
  });

  it("ignores a project file when the project is not trusted", async () => {
    await store.save("project", cwd, stdio("alpha"));
    expect((await store.read("project", cwd, false)).servers).toEqual([]);
    expect(await store.enabled(cwd, false)).toEqual([]);
    expect((await store.read("project", cwd, true)).servers).toHaveLength(1);
  });

  it("keeps a secret out of the configuration file and hands it back only in memory", async () => {
    await store.save("project", cwd, {
      name: "remote",
      transport: { kind: "http", url: "https://example.test/mcp", headers: { "X-Api-Key": { secret: true, value: "shhh" } } },
      auth: { kind: "bearer", token: { secret: true, value: "token-value" } },
    });
    const file = readFileSync(join(cwd, PROJECT_DIR_NAME, "mcp.json"), "utf8");
    expect(file).not.toContain("shhh");
    expect(file).not.toContain("token-value");
    expect(JSON.parse(file).servers[0].auth.token).toEqual({ secret: true });

    const secrets = await store.secretsFor("project", cwd, "remote");
    expect(secrets.get("auth.token")).toBe("token-value");
    expect(secrets.get("transport.headers.X-Api-Key")).toBe("shhh");
    expect(await store.secretPresence("project", cwd, "remote")).toEqual(new Set(["auth.token", "transport.headers.X-Api-Key"]));
    // The secrets file is the person's alone.
    expect(statSync(store.secretsPath()).mode & 0o777).toBe(0o600);
  });

  it("keeps a stored secret when a save sends the reference back unchanged", async () => {
    await store.save("global", cwd, { name: "remote", transport: { kind: "http", url: "https://example.test/mcp" }, auth: { kind: "bearer", token: { secret: true, value: "first" } } });
    await store.save("global", cwd, { name: "remote", transport: { kind: "http", url: "https://example.test/mcp" }, auth: { kind: "bearer", token: { secret: true } }, startup: "at-start" });
    expect((await store.secretsFor("global", cwd, "remote")).get("auth.token")).toBe("first");
  });

  it("moves secrets when a server is renamed and deletes them when it is removed", async () => {
    await store.save("global", cwd, { name: "old", transport: { kind: "http", url: "https://example.test/mcp" }, auth: { kind: "bearer", token: { secret: true, value: "keep-me" } } });
    await store.save("global", cwd, { name: "renamed", transport: { kind: "http", url: "https://example.test/mcp" }, auth: { kind: "bearer", token: { secret: true } } }, "old");
    expect((await store.secretsFor("global", cwd, "old")).size).toBe(0);
    expect((await store.secretsFor("global", cwd, "renamed")).get("auth.token")).toBe("keep-me");

    await store.remove("global", cwd, "renamed");
    expect((await store.secretsFor("global", cwd, "renamed")).size).toBe(0);
    expect(readFileSync(store.secretsPath(), "utf8")).not.toContain("keep-me");
  });

  it("drops a secret that stopped being one", async () => {
    await store.save("global", cwd, { name: "remote", transport: { kind: "http", url: "https://example.test/mcp" }, auth: { kind: "bearer", token: { secret: true, value: "old" } } });
    await store.save("global", cwd, { name: "remote", transport: { kind: "http", url: "https://example.test/mcp" }, auth: { kind: "bearer", token: "$env:TOKEN" } });
    expect((await store.secretsFor("global", cwd, "remote")).size).toBe(0);
    expect(readFileSync(store.secretsPath(), "utf8")).not.toContain("old");
  });

  it("keeps the servers it can read and reports the entries it cannot", async () => {
    writeRaw(join(agentDir, DATA_DIR_NAME, "mcp.json"), {
      version: 1,
      servers: [
        { name: "good", transport: { kind: "stdio", command: "node" } },
        { name: "broken", transport: { kind: "stdio" } },
        { transport: { kind: "stdio", command: "node" } },
        { name: "good", transport: { kind: "stdio", command: "other" } },
      ],
    });
    const contents = await store.read("global", cwd);
    expect(contents.servers.map((server) => server.name)).toEqual(["good"]);
    expect(contents.malformed).toHaveLength(3);
    expect(contents.malformed[0]?.name).toBe("broken");
    expect(contents.malformed[0]?.detail).toContain("could not be read");
    expect(contents.malformed.at(-1)?.detail).toContain("Two saved servers are named");
  });

  it("treats an unreadable or missing file as no servers, never as an error", async () => {
    writeFileSync(join(agentDir, DATA_DIR_NAME, "mcp.json"), "{ not json");
    expect((await store.read("global", cwd)).servers).toEqual([]);
    rmSync(join(agentDir, DATA_DIR_NAME, "mcp.json"));
    expect((await store.read("global", cwd)).servers).toEqual([]);
  });

  it("refuses a duplicate name and a rename onto an existing one", async () => {
    await store.save("global", cwd, stdio("alpha"));
    await store.save("global", cwd, stdio("beta"));
    await expect(store.save("global", cwd, { ...stdio("beta"), name: "alpha" }, "beta")).rejects.toThrow(/already exists/);
    await expect(store.remove("global", cwd, "gamma")).rejects.toThrow(/No server named/);
  });

  it("refuses sign-in settings on a server that is not reached over HTTP", async () => {
    await expect(store.save("global", cwd, {
      name: "local",
      transport: { kind: "stdio", command: "node" },
      auth: { kind: "bearer", token: { secret: true, value: "x" } },
    })).rejects.toThrow(/HTTP/);
  });

  it("serialises concurrent writes instead of losing one", async () => {
    await Promise.all([
      store.save("global", cwd, stdio("one")),
      store.save("global", cwd, stdio("two")),
      store.save("global", cwd, stdio("three")),
    ]);
    const names = (await store.read("global", cwd)).servers.map((server) => server.name).sort();
    expect(names).toEqual(["one", "three", "two"]);
  });
});
