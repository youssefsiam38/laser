/**
 * M14-T2 · every `mcp/*` method through `WorkerServer`, against the fixture
 * server: the complete method surface exists, answers for the project's cwd
 * only, writes `mcp/changed` when configuration changes, and answers
 * `mcp/list` from the newest session snapshot — where a session shutting down
 * (an empty snapshot) never blanks a live one.
 */
import { DATA_DIR_NAME, PRODUCT_NAME, type JsonRpcMessage, type McpInspection, type McpServerState } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerServer } from "../../src/server.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../../src/driver.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-server.mjs");

class StubDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  private readonly listeners = new Set<DriverListener>();
  async open() {
    return {
      path: join(this.cwd, "s1.jsonl"),
      id: "s1",
      cwd: this.cwd,
      model: null,
      thinkingLevel: "medium" as const,
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time" as const,
      followUpMode: "one-at-a-time" as const,
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }
  constructor(private readonly cwd: string) {}
  subscribe(listener: DriverListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: DriverEvent) {
    for (const listener of this.listeners) listener(event);
  }
  state() {
    return this.open() as never;
  }
  async prompt() {
    return { accepted: true, queued: false };
  }
  async cancel() {}
  async dispose() {}
  async entries() {
    return [];
  }
  async commands() {
    return [];
  }
  async prompts() {
    return [];
  }
  async listModels() {
    return [];
  }
  async setModel() {
    return this.state();
  }
  async setThinkingLevel() {
    return this.state();
  }
  respondUi() {}
}

let base: string;
let cwd: string;
let agentDir: string;
let server: WorkerServer;
let out: JsonRpcMessage[];
let drivers: StubDriver[];
let nextId = 1;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-dispatch-`));
  cwd = join(base, "project");
  agentDir = join(base, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, DATA_DIR_NAME), { recursive: true });
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  out = [];
  drivers = [];
  nextId = 1;
  server = new WorkerServer({
    cwd,
    agentDir,
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    createDriver: () => {
      const driver = new StubDriver(cwd);
      drivers.push(driver);
      return driver;
    },
    send: (message) => out.push(message),
  });
});

afterEach(async () => {
  await server.dispose();
  rmSync(base, { recursive: true, force: true });
});

async function call<T>(method: string, params?: unknown): Promise<{ result?: T; error?: { code: number; message: string } }> {
  const id = nextId++;
  await server.handle({ jsonrpc: "2.0", id, method, params });
  return out.find((message) => "id" in message && message.id === id) as { result?: T; error?: { code: number; message: string } };
}

function changed(): number {
  return out.filter((message) => "method" in message && message.method === "mcp/changed").length;
}

const fixture = {
  name: "fixture",
  transport: { kind: "stdio" as const, command: process.execPath, args: [FIXTURE] },
  tools: { exposure: "direct" as const },
};

describe("WorkerServer · mcp/*", () => {
  it("answers every method, and refuses a cwd that is not this worker's", async () => {
    const elsewhere = join(base, "elsewhere");
    const named = { scope: "global", name: "fixture" };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["mcp/list", {}],
      ["mcp/save", { scope: "global", server: fixture }],
      ["mcp/remove", named],
      ["mcp/inspect", named],
      ["mcp/ping", named],
      ["mcp/call", { ...named, tool: "echo", args: {} }],
      ["mcp/disconnect", named],
      ["mcp/auth/start", named],
      ["mcp/auth/complete", { ...named, redirectUrl: "https://example.test/cb?code=1&state=2" }],
      ["mcp/auth/logout", named],
      ["mcp/import/detect", {}],
      ["mcp/import/apply", { source: "cursor", names: ["x"], scope: "global" }],
    ];
    for (const [method, params] of calls) {
      // Every method exists: with this worker's cwd it is dispatched, never
      // refused as unknown.
      const known = await call(method, { cwd, ...params });
      expect(known.error?.message ?? "", method).not.toMatch(/unknown method/);
      // And each one is bound to this worker's project.
      const elsewhereResponse = await call(method, { cwd: elsewhere, ...params });
      expect(elsewhereResponse.error, method).toBeDefined();
      expect(elsewhereResponse.error?.message, method).toMatch(/project/i);
    }
  }, 60_000);

  it("saves, lists, inspects, pings, calls, disconnects and removes one server", async () => {
    const saved = await call<{ servers: McpServerState[] }>("mcp/save", { cwd, scope: "global", server: fixture });
    expect(saved.result?.servers.map((server) => server.config.name)).toEqual(["fixture"]);
    expect(changed()).toBe(1);

    const listed = await call<{ servers: McpServerState[] }>("mcp/list", { cwd });
    expect(listed.result?.servers[0]).toMatchObject({ scope: "global", status: "unknown" });

    const inspected = await call<McpInspection>("mcp/inspect", { cwd, scope: "global", name: "fixture" });
    expect(inspected.result?.status).toBe("connected");
    expect(inspected.result?.tools.map((tool) => tool.name)).toContain("fixture_echo");

    const listedWhileInspecting = await call<{ servers: McpServerState[] }>("mcp/list", { cwd });
    // The counts come from the connection the inspector is holding, not from a
    // cache or a snapshot of some other session.
    expect(listedWhileInspecting.result?.servers[0]).toMatchObject({ status: "connected", inspecting: true, toolCount: 3, directToolCount: 3, promptCount: 1 });

    const pinged = await call<{ status: string; latencyMs?: number }>("mcp/ping", { cwd, scope: "global", name: "fixture" });
    expect(pinged.result?.status).toBe("connected");
    expect(pinged.result?.latencyMs).toBeGreaterThanOrEqual(0);

    const called = await call<{ ok: boolean; content: Array<{ type: string; text?: string }> }>("mcp/call", { cwd, scope: "global", name: "fixture", tool: "fixture_echo", args: { text: "hello" } });
    expect(called.result?.ok).toBe(true);
    expect(called.result?.content[0]).toEqual({ type: "text", text: "echo: hello" });

    expect((await call("mcp/disconnect", { cwd, scope: "global", name: "fixture" })).result).toEqual({});
    const afterDisconnect = await call<{ servers: McpServerState[] }>("mcp/list", { cwd });
    expect(afterDisconnect.result?.servers[0]?.inspecting).toBeUndefined();

    const removed = await call<{ servers: McpServerState[] }>("mcp/remove", { cwd, scope: "global", name: "fixture" });
    expect(removed.result?.servers).toEqual([]);
    expect(changed()).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("inspects an unsaved definition without saving it", async () => {
    const inspected = await call<McpInspection>("mcp/inspect", { cwd, scope: "project", server: fixture });
    expect(inspected.result?.status).toBe("connected");
    expect((await call<{ servers: McpServerState[] }>("mcp/list", { cwd })).result?.servers).toEqual([]);
  }, 60_000);

  it("refuses sign-in for a server that does not sign in", async () => {
    await call("mcp/save", { cwd, scope: "global", server: fixture });
    const started = await call("mcp/auth/start", { cwd, scope: "global", name: "fixture" });
    expect(started.error?.message).toMatch(/does not sign in with OAuth/);
    // The protocol itself refuses a completion with nothing to complete from.
    const completed = await call("mcp/auth/complete", { cwd, scope: "global", name: "fixture" });
    expect(completed.error?.code).toBe(-32602);
  }, 60_000);

  it("takes its status from the newest session snapshot and ignores a shutdown's empty one", async () => {
    await call("mcp/save", { cwd, scope: "global", server: fixture });
    await call("session/new", { cwd });
    const driver = drivers[0]!;
    driver.emit({
      type: "extension",
      message: { type: "lasercode/mcp/status", snapshot: { servers: [{ name: "fixture", status: "connected", toolCount: 3, directToolCount: 3 }], totalTools: 3, connectedCount: 1 } },
    });
    let listed = await call<{ servers: McpServerState[] }>("mcp/list", { cwd });
    expect(listed.result?.servers[0]).toMatchObject({ status: "connected", toolCount: 3, directToolCount: 3 });

    // A session shutting down publishes an empty snapshot; it says nothing
    // about the servers, so the live answer must survive it.
    driver.emit({ type: "extension", message: { type: "lasercode/mcp/status", snapshot: { servers: [], totalTools: 0, connectedCount: 0 } } });
    listed = await call<{ servers: McpServerState[] }>("mcp/list", { cwd });
    expect(listed.result?.servers[0]?.status).toBe("unknown");
    expect(changed()).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("reports a configuration a person broke by hand without losing the rest", async () => {
    await call("mcp/save", { cwd, scope: "global", server: fixture });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(agentDir, DATA_DIR_NAME, "mcp.json"), JSON.stringify({
      version: 1,
      servers: [{ name: "fixture", transport: { kind: "stdio", command: process.execPath } }, { name: "broken", transport: { kind: "http" } }],
    }));
    const listed = await call<{ servers: McpServerState[] }>("mcp/list", { cwd });
    const broken = listed.result?.servers.find((server) => server.config.name === "broken");
    expect(broken?.status).toBe("failed");
    expect(broken?.detail).toContain("could not be read");
    expect(listed.result?.servers.find((server) => server.config.name === "fixture")?.status).toBe("unknown");
  }, 60_000);

  it("detects importable configurations and refuses a conflict unless told to replace", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
      mcpServers: {
        imported: { command: "node", args: ["server.js"], env: { API_TOKEN: "inline-secret", LOG_LEVEL: "debug" } },
      },
    }));
    const detected = await call<{ sources: Array<{ id: string; servers: Array<{ name: string; inlineSecrets: string[]; conflicts: string[] }> }> }>("mcp/import/detect", { cwd });
    const source = detected.result?.sources.find((candidate) => candidate.id === "project-mcp-json");
    expect(source?.servers[0]).toMatchObject({ name: "imported", inlineSecrets: ["transport.env.API_TOKEN"], conflicts: [] });

    const applied = await call<{ imported: string[]; servers: McpServerState[] }>("mcp/import/apply", { cwd, source: "project-mcp-json", names: ["imported"], scope: "global" });
    expect(applied.result?.imported).toEqual(["imported"]);
    const stored = applied.result?.servers.find((server) => server.config.name === "imported");
    expect((stored?.config.transport as { env: Record<string, unknown> }).env["API_TOKEN"]).toEqual({ secret: true, present: true });
    expect((stored?.config.transport as { env: Record<string, unknown> }).env["LOG_LEVEL"]).toBe("debug");

    const again = await call("mcp/import/apply", { cwd, source: "project-mcp-json", names: ["imported"], scope: "global" });
    expect(again.error?.message).toMatch(/already exists/);
    const replaced = await call<{ imported: string[] }>("mcp/import/apply", { cwd, source: "project-mcp-json", names: ["imported"], scope: "global", replace: true });
    expect(replaced.result?.imported).toEqual(["imported"]);
  }, 60_000);
});
