/**
 * M1-T1 done-when, end to end: a WebSocket client connects to the host, lists
 * sessions, opens one (spawning a real worker + Pi), prompts a stub provider,
 * and receives seq-numbered updates. Requires `pnpm -r build` (spawns the
 * worker's dist). Sandboxed dirs; never touches ~/.pi/agent.
 */
import { PRODUCT_NAME, PRODUCT_VERSION } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage, SessionState, SessionUpdateParams } from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";

const REPLY = ["Hi ", "from ", "host"];

function stubProvider(): Promise<{ server: Server; url: string; requests: Record<string, unknown>[]; search: { status: number; calls: number } }> {
  const requests: Record<string, unknown>[] = [];
  const search = { status: 200, calls: 0 };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/search?")) {
      search.calls++;
      res.writeHead(search.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Connection test", url: "https://example.com", content: "Verified source" }] }));
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const request = JSON.parse(body) as Record<string, unknown>;
      requests.push(request);
      const reply = body.includes("present-progressive") ? ["Searching ", "auth ", "handlers"] : REPLY;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      for (const p of reply) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, search, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })),
  );
}

class Client {
  private ws!: WebSocket;
  readonly inbound: JsonRpcMessage[] = [];
  private nextId = 1;
  async connect(url: string) {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.ws.on("message", (d) => this.inbound.push(JSON.parse(d.toString()) as JsonRpcMessage));
    await new Promise<void>((r) => this.ws.once("open", () => r()));
  }
  request<R>(method: string, params?: unknown, clientVersion?: string): Promise<R> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, clientVersion }));
    return this.waitFor((m) => "id" in m && m.id === id).then((m) => {
      const r = m as { result?: R; error?: { message: string } };
      if (r.error) throw new Error(r.error.message);
      return r.result as R;
    });
  }
  waitFor(pred: (m: JsonRpcMessage) => boolean, ms = 30_000): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const hit = this.inbound.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout; last: ${JSON.stringify(this.inbound.slice(-2))}`)), ms);
      const on = () => {
        const h = this.inbound.find(pred);
        if (h) { clearTimeout(timer); this.ws.off("message", on); resolve(h); }
      };
      this.ws.on("message", on);
    });
  }
  updates(): SessionUpdateParams[] {
    return this.inbound.filter((m) => "method" in m && m.method === "session/update").map((m) => (m as { params: SessionUpdateParams }).params);
  }
  close() { this.ws.close(); }
}

let base: string;
let host: HostServer;
let stub: Awaited<ReturnType<typeof stubProvider>>;
let logs: string[];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-host-`));
  for (const d of ["project", "agent"]) mkdirSync(join(base, d), { recursive: true });
  stub = await stubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
  );
  // Only the stub is enabled. A developer machine may have a real provider
  // configured from its environment, and Namer benchmarks whatever is
  // connected when a worker comes up — this keeps that offer to the stub, so
  // the run stays hermetic and costs nothing.
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ enabledModels: ["stub/stub-1"] }));
  logs = [];
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    workerIdleMs: 1_000,
    workerSweepMs: 10,
    log: (l) => logs.push(l),
  });
});

afterEach(async () => {
  await host.close();
  await new Promise<void>((r) => stub.server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(defaultWorkerMain()))("host end to end", () => {
  it("reopens genuine empty project, Beam and Chat sessions after worker retirement and a full host restart", async () => {
    // Give a later host a different default. The saved empty-session tuple,
    // not that changed default, must win on reopen.
    writeFileSync(
      join(base, "agent", "models.json"),
      JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [
        { id: "stub-1", contextWindow: 8000, maxTokens: 500, reasoning: true },
        { id: "stub-2", contextWindow: 8000, maxTokens: 500, reasoning: true },
      ] } } }),
    );
    writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1", "stub/stub-2"], defaultThinkingLevel: "low" }));

    let client = new Client();
    await client.connect((await host.listen()).url);
    const roots = [
      { name: "default", cwd: join(base, "project"), kind: "root" },
      { name: "beam", cwd: join(base, "state", "workspaces", "beam"), kind: "beam" },
      { name: "chat", cwd: join(base, "state", "workspaces", "chat"), kind: "chat" },
    ] as const;
    const created: SessionState[] = [];
    const bytesByPath = new Map<string, string>();
    const pidByCwd = new Map<string, number | undefined>();
    try {
      for (const item of roots) {
        const { state } = await client.request<{ state: SessionState }>("session/new", { cwd: item.cwd, agentName: item.name });
        expect(state).toMatchObject({ messageCount: 0, model: { provider: "stub", id: "stub-1" }, thinkingLevel: "low", agent: { agentName: item.name, kind: item.kind } });
        expect(existsSync(state.path)).toBe(true);
        const bytes = readFileSync(state.path, "utf8");
        const entries = bytes.trim().split("\n").map((line) => JSON.parse(line) as { type?: string; id?: string; cwd?: string });
        expect(entries[0]).toMatchObject({ type: "session", id: state.id, cwd: state.cwd });
        expect(entries.some((entry) => entry.type === "message")).toBe(false);
        bytesByPath.set(state.path, bytes);
        pidByCwd.set(state.cwd, host.pool.workerInfo(state.cwd)?.pid);
        created.push(state);
        await client.request("pi/session/detach", { path: state.path });
      }

      // Exercise the production lifecycle: explicit detach, idle threshold,
      // timer sweep, orderly worker retirement, then reopen from disk.
      const deadline = Date.now() + 10_000;
      while (created.some((state) => host.pool.workerInfo(state.cwd)?.status !== "retired")) {
        if (Date.now() > deadline) throw new Error(`workers did not retire: ${JSON.stringify(host.pool.status())}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (const state of created) {
        const { state: retired } = await client.request<{ state: SessionState }>("session/load", { path: state.path });
        expect(host.pool.workerInfo(state.cwd)?.pid).not.toBe(pidByCwd.get(state.cwd));
        expect(retired).toMatchObject({ id: state.id, path: state.path, cwd: state.cwd, messageCount: 0, model: state.model, thinkingLevel: state.thinkingLevel, agent: state.agent });
        expect(readFileSync(state.path, "utf8")).toBe(bytesByPath.get(state.path));
      }

      client.close();
      await host.close();
      writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-2", enabledModels: ["stub/stub-1", "stub/stub-2"], defaultThinkingLevel: "high" }));
      host = new HostServer({
        agentDir: join(base, "agent"),
        sessionDir: join(base, "sessions"),
        stateDir: join(base, "state"),
        log: (line) => logs.push(line),
      });
      client = new Client();
      await client.connect((await host.listen()).url);

      for (const state of created) {
        const { state: restarted } = await client.request<{ state: SessionState }>("session/load", { path: state.path });
        expect(restarted).toMatchObject({ id: state.id, path: state.path, cwd: state.cwd, messageCount: 0, model: state.model, thinkingLevel: state.thinkingLevel, agent: state.agent });
        await expect(client.request("session/prompt", { path: state.path, content: [{ type: "text", text: `first ${state.agent?.kind ?? "project"}` }] }))
          .resolves.toEqual({ accepted: true, queued: false });
      }
      const firstTurns = stub.requests.filter((request) => JSON.stringify(request).includes('"first '));
      expect(firstTurns).toHaveLength(3);
      expect(firstTurns.map((request) => request.model)).toEqual(["stub-1", "stub-1", "stub-1"]);
    } finally { client.close(); }
  }, 120_000);

  it("keeps deleted, zero-byte and corrupt transcript guards closed without recreating files", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    try {
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      expect(existsSync(state.path)).toBe(true);
      await host.pool.restart(cwd);
      rmSync(state.path);
      // Retire the process that had already resumed it; recovery must now use
      // the missing durable path rather than surviving in-memory state.
      await host.pool.restart(cwd);
      await expect(client.request("session/load", { path: state.path })).rejects.toThrow(/no saved transcript|no project known/);
      expect(existsSync(state.path)).toBe(false);

      const zero = join(base, "sessions", "zero.jsonl");
      const corrupt = join(base, "sessions", "corrupt.jsonl");
      writeFileSync(zero, "");
      writeFileSync(corrupt, "not json\n");
      const worker = await host.pool.get(cwd);
      await expect(worker.request("session/load", { path: zero })).rejects.toThrow(/no saved transcript/);
      await expect(worker.request("session/load", { path: corrupt })).rejects.toThrow(/not a valid/);
      expect(readFileSync(zero, "utf8")).toBe("");
      expect(readFileSync(corrupt, "utf8")).toBe("not json\n");
    } finally { client.close(); }
  }, 60_000);

  it("does not expose internal storage as projects or sessions, while genuine workspace sessions remain listed", async () => {
    const stateDir = join(base, "state");
    const agentDir = join(base, "agent");
    const beamCwd = join(stateDir, "workspaces", "beam", "session-private");
    const chatCwd = join(stateDir, "workspaces", "chat", "session-private");
    mkdirSync(join(base, "sessions"), { recursive: true });
    const paths = [stateDir, agentDir, beamCwd, chatCwd].map((cwd, i) => {
      const path = join(base, "sessions", `${i}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: `s-${i}`, cwd })}\n`);
      return path;
    });
    const before = paths.map(path => readFileSync(path, "utf8"));
    const { url } = await host.listen();
    const client = new Client();
    await client.connect(url);
    try {
      expect(await client.request("pi/project/list", {})).toEqual({ projects: [] });
      const { sessions } = await client.request<{ sessions: Array<{ path: string }> }>("pi/session/list", {});
      expect(sessions.map(s => s.path).sort()).toEqual(paths.slice(2).sort());
      for (const cwd of [stateDir, agentDir, beamCwd, chatCwd]) {
        await expect(client.request("pi/project/add", { cwd })).rejects.toThrow(/internal app storage/);
      }
      await expect(client.request("session/new", { cwd: stateDir })).rejects.toThrow(/internal app storage/);
      await expect(client.request("session/load", { path: paths[0] })).rejects.toThrow(/internal app storage/);
      expect(host.pool.cwds()).toEqual([]);
      expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(before);
    } finally { client.close(); }
  });

  it("keeps projectless Settings working without allowing its internal folder to become a project", async () => {
    const { url } = await host.listen();
    const client = new Client();
    await client.connect(url);
    try {
      const { cwd } = await client.request<{ cwd: string }>("pi/setup/state", {});
      expect(cwd).toBe(join(base, "state", "global"));
      await expect(client.request("pi/models/catalog", { cwd })).resolves.toBeDefined();
      await expect(client.request("session/new", { cwd })).rejects.toThrow(/internal app storage/);
      await expect(client.request("pi/project/add", { cwd })).rejects.toThrow(/internal app storage/);
      expect(await client.request("pi/project/list", {})).toEqual({ projects: [] });
      expect(await client.request("pi/session/list", {})).toEqual({ sessions: [] });
    } finally { client.close(); }
  }, 60_000);

  it("routes search settings through a real worker independently of enablement", async () => {
    const { url } = await host.listen();
    const client = new Client();
    await client.connect(url);
    const cwd = join(base, "project");
    try {
      const initial = await client.request<{ selectedProvider: string; providers: unknown[] }>("web-search/status", { cwd });
      expect(initial.providers).toHaveLength(29);
      const saved = await client.request("web-search/configure", { cwd, change: { action: "configure", provider: "brave", connection: { source: "dedicated" }, apiKey: "private-search-test-key" } });
      expect(JSON.stringify(saved)).not.toContain("private-search-test-key");
      const features = await client.request<{ features: Array<{ manifest: { id: string }; enabled: boolean }> }>("feature/list", { cwd });
      expect(features.features.find((f) => f.manifest.id === "web-search")?.enabled).toBe(false);
      await client.request("web-search/configure", { cwd, change: { action: "configure", provider: "searxng", connection: { source: "none", baseUrl: stub.url.replace(/\/v1$/, "") }, activate: true } });
      expect(stub.search.calls).toBe(1);
      stub.search.status = 503;
      await expect(client.request("feature/set", { id: "web-search", enabled: true, scope: "global", cwd })).rejects.toThrow(/SearXNG/);
      const rejected = await client.request<{ features: Array<{ manifest: { id: string }; enabled: boolean }> }>("feature/list", { cwd });
      expect(rejected.features.find((f) => f.manifest.id === "web-search")?.enabled).toBe(false);
      expect(stub.search.calls).toBe(2);
      stub.search.status = 200;
      await client.request("feature/set", { id: "web-search", enabled: true, scope: "project", cwd });
      expect(stub.search.calls).toBe(3);
      const status = await client.request<{ providers: Array<{ id: string; hasKey: boolean }> }>("web-search/status", { cwd });
      expect(status.providers.find((p) => p.id === "brave")?.hasKey).toBe(true);
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      await client.request("pi/model/set", { path: state.path, model: { provider: "stub", id: "stub-1" } });
      await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "Check available tools" }] });
      await client.waitFor((m) => "method" in m && m.method === "session/update" && (m.params as SessionUpdateParams).update.kind === "agent_settled");
      expect(JSON.stringify(stub.requests.at(-1)?.tools)).toContain("web_search");
      expect(logs.join("\n")).not.toContain("private-search-test-key");
    } finally { client.close(); }
  }, 60_000);

  it("serves health and placeholder UI, lists, opens, prompts, streams, resumes", async () => {
    const { url } = await host.listen();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${url}/healthz`);
    expect(await health.text()).toBe("ok");

    const client = new Client();
    await client.connect(url);

    // Empty catalog before any session exists.
    expect(await client.request("pi/host/version", {})).toEqual({ version: PRODUCT_VERSION });
    await expect(client.request("session/new", { cwd: join(base, "project") }, "99.0.0")).rejects.toThrow(/Refresh this view/);
    expect(await client.request("pi/session/list", {})).toEqual({ sessions: [] });

    // Open a session (spawns the worker) and see the worker come up.
    const { state } = await client.request<{ state: SessionState }>("session/new", { cwd: join(base, "project") });
    expect(state.cwd).toBe(join(base, "project"));
    await client.waitFor((m) => "method" in m && m.method === "pi/worker/status" && (m.params as { status: string }).status === "ready");
    await client.waitFor((m) => "method" in m && m.method === "pi/extension/message");
    expect(host.pool.cwds()).toEqual([join(base, "project")]);

    // Exercise the public route through the actual built worker, not just its
    // dispatcher in isolation. No real account or quota request is needed.
    const quota = await client.request<{ delivered: boolean }>("pi/account-usage/refresh", { path: state.path });
    expect(typeof quota.delivered).toBe("boolean");

    // Prompt through host → worker → Pi → stub provider.
    await client.request("pi/model/set", { path: state.path, model: { provider: "stub", id: "stub-1" } });
    const prompted = await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "hello" }] });
    expect(prompted).toEqual({ accepted: true, queued: false });
    await client.waitFor((m) => "method" in m && m.method === "session/update" && (m.params as SessionUpdateParams).update.kind === "agent_settled");
    // M13-T22: no provider was signed in during this run — the stub's
    // credentials were already on disk — so Namer qualified from the worker
    // coming up, and the session is named from its first prompt.
    const named = await client.waitFor((m) => {
      if (!("method" in m) || m.method !== "session/update") return false;
      const { update } = m.params as SessionUpdateParams;
      return update.kind === "state" && typeof update.state.name === "string" && update.state.name !== "";
    });
    expect((named as { params: SessionUpdateParams }).params.update).toMatchObject({ kind: "state", state: { name: REPLY.join("") } });

    const updates = client.updates();
    expect(updates.map((u) => u.seq)).toEqual(updates.map((_, i) => i + 1)); // contiguous from 1
    const text = updates.filter((u) => u.update.kind === "text_delta").map((u) => (u.update as { delta: string }).delta).join("");
    expect(text).toBe(REPLY.join(""));

    const { entries: transcript } = await client.request<{entries:Array<{type:string;id:string;message?:{role:string}}> }>("pi/session/entries",{path:state.path});
    const promptEntryId=transcript.find(entry=>entry.type==="message"&&entry.message?.role==="user")!.id;
    const requests=await client.request<{entries:Array<{requestContext?:{promptEntryId:string};kind:string}>}>("pi/logs/query",{sessionPath:state.path,kind:"provider_request",promptEntryId});
    expect(requests.entries.length).toBeGreaterThan(0);
    expect(requests.entries.every(entry=>entry.kind==="provider_request"&&entry.requestContext?.promptEntryId===promptEntryId)).toBe(true);

    // Catalog now sees the persisted session, keyed to the project.
    const { sessions } = await client.request<{ sessions: Array<{ path: string; cwd: string }> }>("pi/session/list", {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ path: state.path, cwd: join(base, "project") });

    // A second client reconnects and resumes from a seq it already has.
    const seen = updates.at(-1)!.seq - 2;
    const client2 = new Client();
    await client2.connect(url);
    const loaded = await client2.request<{ replayFrom: number }>("session/load", { path: state.path, fromSeq: seen });
    expect(loaded.replayFrom).toBe(seen);
    await client2.waitFor((m) => "method" in m && m.method === "session/update");
    // Broadcast means client2 sees the replayed tail (seq > seen).
    expect(client2.updates().map((u) => u.seq)).toEqual([seen + 1, seen + 2]);

    client.close();
    client2.close();
  }, 90_000);

  it("answers the agents methods over a real socket, primes the real worker, and keeps the workspaces out of the project list", async () => {
    const { url } = await host.listen();
    const client = new Client();
    await client.connect(url);
    const project = join(base, "project");
    try {
      // The workspaces live under the host's own state dir, and are not projects.
      expect(existsSync(join(base, "state", "workspaces", "beam"))).toBe(true);
      expect(existsSync(join(base, "state", "workspaces", "chat"))).toBe(true);
      const listed = await client.request<{ agents: Array<{ name: string; kind: string }>; defaultAgent: string; workspaces: { beam: string; chat: string } }>("agents/list", {});
      expect(listed.agents.map((a) => `${a.name}:${a.kind}`)).toEqual(["default:custom", "beam:builtin", "chat:builtin", "namer:builtin"]);
      expect(listed.workspaces).toEqual({ beam: join(base, "state", "workspaces", "beam"), chat: join(base, "state", "workspaces", "chat") });
      await expect(client.request("agents/sync", { snapshot: listed })).rejects.toThrow("The app sends this to its own workers.");

      // A save is broadcast to every client and persisted for the next host.
      const saved = await client.request<{ agent: { name: string }; snapshot: { revision: number } }>("agents/save", {
        agent: { name: "reviewer", description: "Reviews", instructions: "Review.", engineInstructions: false, model: null, thinkingLevel: null, supportsSubagents: false, allowedAgents: [], scopedSkills: false, skills: [] },
        originalName: null,
      });
      expect(saved.agent.name).toBe("reviewer");
      await client.waitFor((m) => "method" in m && m.method === "agents/updated" && (m.params as { revision: number }).revision === saved.snapshot.revision);
      await expect(client.request("agents/delete", { name: "default" })).rejects.toThrow("This agent starts new sessions. Choose another default first.");

      // The real worker is primed with the definitions before its first
      // answer; whether or not it knows the method yet, it still runs sessions.
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd: project });
      expect(state.cwd).toBe(project);
      expect(await client.request("agents/runs/list", { path: state.path })).toEqual({ runs: [] });
      const projects = await client.request<{ projects: Array<{ cwd: string }> }>("pi/project/list", {});
      expect(projects.projects.map((p) => p.cwd)).toEqual([project]);
      await expect(client.request("session/new", { cwd: project, agentName: "beam" })).rejects.toThrow(/Beam sessions start in/);
      await expect(client.request("session/new", { cwd: project, agentName: "namer" })).rejects.toThrow(/does not run a session/);

      host.agents.close(); // flush the debounced write, as shutdown does
      expect(JSON.parse(readFileSync(join(base, "state", "agents.json"), "utf8")).agents.map((a: { name: string }) => a.name)).toEqual(["default", "reviewer"]);
      expect(existsSync(join(base, "state", "agent-runs.json"))).toBe(false); // nothing to persist yet
    } finally {
      client.close();
    }
  }, 60_000);

  it("never runs two workers for one cwd", async () => {
    await host.listen();
    const [a, b] = await Promise.all([host.pool.get(join(base, "project")), host.pool.get(join(base, "project"))]);
    expect(a).toBe(b);
    expect(host.pool.cwds()).toHaveLength(1);
  }, 60_000);
});
