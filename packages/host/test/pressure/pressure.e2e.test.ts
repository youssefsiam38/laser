import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { ErrorCodes, PRODUCT_NAME, type JsonRpcMessage, type SessionState, type SessionUpdateParams } from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../../src/index.js";

const MiB = 1024 * 1024;
function provider(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => body += chunk.toString());
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body.includes("keep running")) {
        // An active turn the pressure pass must not cancel. afterEach closes it.
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1", choices: [{ index: 0, delta: { role: "assistant", content: "working" }, finish_reason: null }] })}\n\n`);
        return;
      }
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })));
}

class Client {
  private ws!: WebSocket;
  readonly inbound: JsonRpcMessage[] = [];
  private id = 1;
  async connect(url: string) {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.ws.on("message", (data) => this.inbound.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => this.ws.once("open", resolve));
  }
  async response<R>(method: string, params?: unknown): Promise<{ result?: R; error?: { code: number; message: string } }> {
    const id = this.id++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return await this.waitFor((message) => "id" in message && message.id === id) as { result?: R; error?: { code: number; message: string } };
  }
  request<R>(method: string, params?: unknown): Promise<R> {
    return this.response<R>(method, params).then((answer) => {
      if (answer.error) throw new Error(answer.error.message);
      return answer.result as R;
    });
  }
  waitFor(predicate: (message: JsonRpcMessage) => boolean, ms = 30_000): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const ready = this.inbound.find(predicate);
      if (ready) return resolve(ready);
      const timer = setTimeout(() => reject(new Error(`timeout; last=${JSON.stringify(this.inbound.slice(-4))}`)), ms);
      const check = () => {
        const found = this.inbound.find(predicate);
        if (!found) return;
        clearTimeout(timer); this.ws.off("message", check); resolve(found);
      };
      this.ws.on("message", check);
    });
  }
  close() { this.ws.close(); }
}

let base: string;
let host: HostServer;
let stub: Awaited<ReturnType<typeof provider>>;
let client: Client;
let physicalBytes: number;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-pressure-pass-`));
  for (const dir of ["project", "active-project", "agent"]) mkdirSync(join(base, dir), { recursive: true });
  stub = await provider();
  physicalBytes = 900 * MiB;
  writeFileSync(join(base, "agent", "models.json"), JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }));
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }));
  host = new HostServer({
    agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), stateDir: join(base, "state"),
    workerIdleMs: 600_000, workerSweepMs: 0, sessionLifetime: { sessionIdleMs: 1, sweepMs: 60_000 }, log: () => {},
    pressureSample: async () => ({
      atMs: Date.now(),
      physical: { status: "available", value: physicalBytes }, heapUsed: { status: "available", value: 100 * MiB }, heapLimit: { status: "available", value: 1_000 * MiB },
      machineAvailable: { status: "available", value: 8_000 * MiB },
    }),
  });
  client = new Client();
  await client.connect((await host.listen()).url);
});

afterEach(async () => {
  client.close();
  await host.close();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

/**
 * Naming is work of its own: it appends one durable `session_info` record
 * after the turn has settled. A revision taken before that append and entries
 * read after it describe two different files, so wait for the record itself.
 */
async function named(path: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.some((line) => {
      try {
        return (JSON.parse(line) as { type?: string }).type === "session_info";
      } catch {
        return false;
      }
    })) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`session ${path} was never named`);
}

describe.skipIf(!existsSync(defaultWorkerMain()))("the host pressure pass, end to end", () => {
  it("journals a real worker directive, unloads one idle runtime, and leaves an active turn untouched", async () => {
    const cwd = join(base, "project");
    const dormant = await client.request<{ state: SessionState }>("session/new", { cwd });
    await client.request("session/prompt", { path: dormant.state.path, content: [{ type: "text", text: "finish this" }] });
    await client.waitFor((message) => "method" in message && message.method === "session/update" && (message as { params: SessionUpdateParams }).params.sessionPath === dormant.state.path && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled");
    await named(dormant.state.path);
    const revision = await client.request<{ revision: string }>("session/revision", { path: dormant.state.path });
    // The UI's bounded ensure shape remains a live-worker operation even at
    // critical pressure; only the worker-free durable all-window path refuses.
    const entries = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", {
      path: dormant.state.path,
      authority: "any",
      window: { all: true },
      bodyLimit: 64 * 1024,
    });
    await client.request("pi/session/detach", { path: dormant.state.path });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const activeCwd = join(base, "active-project");
    const active = await client.request<{ state: SessionState }>("session/new", { cwd: activeCwd });
    void client.request("session/prompt", { path: active.state.path, content: [{ type: "text", text: "keep running" }] }).catch(() => {});
    await client.waitFor((message) => "method" in message && message.method === "session/update" && (message as { params: SessionUpdateParams }).params.update.kind === "text_delta" && (message as { params: SessionUpdateParams & { update: { kind: "text_delta"; delta: string } } }).params.update.delta === "working");

    await host.memoryPressure.probeNow();
    await host.memoryPressure.probeNow();

    const page = host.memoryPressure.journalPage();
    expect(page.events.some((event) => event.role === "project_worker" && event.project?.match(/^[0-9a-f]{16}$/))).toBe(true);
    expect(page.events.filter((event) => event.action === "idle_session_unload" && event.outcome === "released")).toHaveLength(1);
    expect(host.pool.openSessions(activeCwd)).toContain(active.state.path);
    expect(host.pool.openSessions(cwd)).not.toContain(dormant.state.path);

    expect(client.inbound.some((message) => "method" in message && message.method === "session/update" && (message as { params: SessionUpdateParams }).params.sessionPath === active.state.path && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled")).toBe(false);
    const reopened = await client.request<{ revision?: string }>("session/load", { path: dormant.state.path });
    expect(reopened.revision).toBe(revision.revision);
    const after = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", {
      path: dormant.state.path,
      authority: "any",
      window: { all: true },
      bodyLimit: 64 * 1024,
    });
    expect(after.leafId).toBe(entries.leafId);
    expect(after.entries).toEqual(entries.entries);
  }, 60_000);

  it("guards only the four heavy admissions and preserves the UI history actions", async () => {
    const cwd = join(base, "project");
    const state = (await client.request<{ state: SessionState }>("session/new", { cwd })).state;
    await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "one turn" }] });
    await client.waitFor((message) => "method" in message && message.method === "session/update"
      && (message as { params: SessionUpdateParams }).params.sessionPath === state.path
      && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled");

    const initial = await client.request<{ entries: Array<{ id?: string; type?: string; message?: { role?: string } }>; leafId: string | null }>(
      "pi/session/entries",
      { path: state.path, window: { tail: 8 }, bodyLimit: 64 * 1024 },
    );
    const entryIds = initial.entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string");
    expect(entryIds.length).toBeGreaterThanOrEqual(2);
    const beforeRefusal = readFileSync(state.path);
    const workersBefore = host.pool.reservedWorkerCount();

    physicalBytes = 600 * MiB;
    await host.memoryPressure.probeNow();
    await host.memoryPressure.probeNow();
    expect(host.memoryPressure.counters().level).toBe("warning");

    const refused = await client.response("pi/session/entries", { path: state.path });
    expect(refused.error).toMatchObject({ code: ErrorCodes.SessionBusy, message: expect.stringMatching(/bounded recent window/) });
    await client.response("pi/session/entries", { path: state.path });
    await client.response("pi/session/entries", { path: state.path });
    expect(readFileSync(state.path)).toEqual(beforeRefusal);
    expect(host.pool.reservedWorkerCount()).toBe(workersBefore);
    expect(host.memoryPressure.journalPage().events.filter((event) => event.refusal === "whole_transcript")).toHaveLength(1);
    expect(host.memoryPressure.counters().admissionSuppressed).toBe(2);

    const speculative = join(base, "speculative");
    mkdirSync(speculative);
    expect(await client.request("pi/worker/prepare", { cwd: speculative })).toEqual({});
    expect(host.pool.reservedWorkerCount()).toBe(workersBefore);

    // The UI's shared last-prompt helper sends a bounded live tail with no
    // authority override. At warning it still finds the fork point while the
    // otherwise identical windowless read above is refused.
    const bounded = await client.request<{ entries: Array<{ id?: string; type?: string; message?: { role?: string } }> }>(
      "pi/session/entries",
      { path: state.path, window: { tail: 8 }, bodyLimit: 64 * 1024 },
    );
    const lastPrompt = bounded.entries
      .filter((entry) => entry.type === "message" && entry.message?.role === "user")
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string")
      .at(-1);
    expect(lastPrompt).toBeDefined();
    const moved = await client.response("pi/session/navigate", { path: state.path, entryId: lastPrompt! });
    expect(moved.error).toBeUndefined();
    const forked = await client.request<{ state: SessionState }>("pi/session/fork", { path: state.path, entryId: lastPrompt! });
    expect(forked.state.path).not.toBe(state.path);
    await client.request("pi/session/entries", { path: forked.state.path, window: { tail: 8 }, bodyLimit: 64 * 1024 });

    const newProject = join(base, "new-project");
    mkdirSync(newProject);
    await client.request("pi/project/add", { cwd: newProject });
    physicalBytes = 900 * MiB;
    await host.memoryPressure.probeNow();
    await host.memoryPressure.probeNow();
    expect(host.memoryPressure.counters().level).toBe("critical");

    // The actual bounded UI shape remains available at critical too.
    const liveEnsure = await client.response("pi/session/entries", {
      path: forked.state.path,
      window: { tail: 8 },
      bodyLimit: 64 * 1024,
    });
    expect(liveEnsure.error).toBeUndefined();

    const stableBytes = readFileSync(state.path);
    const stableWorkers = host.pool.reservedWorkerCount();
    const newSession = await client.response("session/new", { cwd: newProject });
    expect(newSession.error).toMatchObject({ code: ErrorCodes.SessionBusy, message: expect.stringMatching(/open project/) });
    expect(readFileSync(state.path)).toEqual(stableBytes);
    expect(host.pool.reservedWorkerCount()).toBe(stableWorkers);

    const beamRoot = host.agents.workspaces.beam;
    const beamBefore = readdirSync(beamRoot).sort();
    const beamSession = await client.response("session/new", { cwd: beamRoot, agentName: "beam" });
    expect(beamSession.error).toMatchObject({ code: ErrorCodes.SessionBusy });
    expect(readdirSync(beamRoot).sort()).toEqual(beamBefore);
    expect(host.pool.reservedWorkerCount()).toBe(stableWorkers);
  }, 60_000);
});
