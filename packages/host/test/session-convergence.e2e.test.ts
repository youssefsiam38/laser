/**
 * RP-4's done-when, on a real host: opening and leaving many conversations
 * converges on a bounded amount of retained state.
 *
 * Everything here is real — the host, the worker, the engine — and nothing here
 * is credentialed: the only provider is a loopback stub. The policy under test
 * is the shipped one, driven through the internal `sessionLifetime` seam so the
 * thresholds are short enough for a test rather than replaced by a stand-in.
 *
 * The post-GC heap half of the evidence is not here: a heap number belongs to a
 * run that can force a collection, and that is
 * `packages/worker/test/scratch/heap-convergence.mjs`, run by hand against the
 * exact revision under review.
 */
import { PRODUCT_NAME, type ClientRequests, type SessionState } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage } from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";

const SESSIONS = 12;
const MAX_LOADED = 3;

function stubProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      for (const piece of ["a ", "short ", "answer"]) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })),
  );
}

class Client {
  private ws!: WebSocket;
  readonly inbound: JsonRpcMessage[] = [];
  private nextId = 1;
  async connect(url: string) {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.ws.on("message", (data) => this.inbound.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => this.ws.once("open", () => resolve()));
  }
  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return this.waitFor((message) => "id" in message && message.id === id).then((message) => {
      const answer = message as { result?: R; error?: { message: string } };
      if (answer.error) throw new Error(answer.error.message);
      return answer.result as R;
    });
  }
  waitFor(predicate: (message: JsonRpcMessage) => boolean, ms = 60_000): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const hit = this.inbound.find(predicate);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      const listener = () => {
        const found = this.inbound.find(predicate);
        if (found) { clearTimeout(timer); this.ws.off("message", listener); resolve(found); }
      };
      this.ws.on("message", listener);
    });
  }
  close() { this.ws.close(); }
}

let base: string;
let host: HostServer;
let stub: Awaited<ReturnType<typeof stubProvider>>;

function makeHost(): HostServer {
  return new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    // Retirement stays far away: this measures the *session* bound, not the
    // worker's, and the two must not be confused for each other.
    workerIdleMs: 600_000,
    workerSweepMs: 0,
    sessionLifetime: { sessionIdleMs: 150, sweepMs: 50, maxLoadedPerWorker: MAX_LOADED, maxUnloadsPerTick: 8 },
    log: () => {},
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-converge-`));
  for (const dir of ["project", "agent"]) mkdirSync(join(base, dir), { recursive: true });
  stub = await stubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
  );
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }));
  host = makeHost();
});

afterEach(async () => {
  await host.close();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(defaultWorkerMain()))("opening and leaving many conversations", () => {
  it("converges on a bounded number of loaded runtimes and bounded replay, and each one still reopens exactly", async () => {
    const cwd = join(base, "project");
    // Twelve real conversations with real turns, created and then left. The
    // host is restarted once, so the worker under test starts with nothing
    // queued — the same state a person's second session of the day begins in.
    const created: SessionState[] = [];
    let client = new Client();
    await client.connect((await host.listen()).url);
    try {
      for (let index = 0; index < SESSIONS; index += 1) {
        const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
        await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: `hello ${index}` }] });
        await client.waitFor((message) =>
          "method" in message && message.method === "session/update"
          && (message.params as { sessionPath?: string; update?: { kind?: string } }).sessionPath === state.path
          && (message.params as { update?: { kind?: string } }).update?.kind === "agent_settled");
        created.push(state);
      }
    } finally {
      client.close();
    }
    await host.close();

    host = makeHost();
    client = new Client();
    await client.connect((await host.listen()).url);
    try {
      const revisions = new Map<string, string>();
      for (const state of created) {
        await client.request("session/load", { path: state.path });
        const { revision } = await client.request<{ revision: string }>("session/revision", { path: state.path });
        revisions.set(state.path, revision);
        // The person moves on: membership (RP-6) lets go, which is the only
        // thing that makes a runtime a candidate at all.
        await client.request("pi/session/detach", { path: state.path });
      }
      expect(host.sessionMembership().counts().paths).toBe(0);

      // The shipped policy, on its own timer, converges.
      const deadline = Date.now() + 30_000;
      let loaded = host.pool.openSessions(cwd).length;
      while (loaded > MAX_LOADED && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        loaded = host.pool.openSessions(cwd).length;
      }
      expect(loaded, `loaded runtimes after ${SESSIONS} conversations`).toBeLessThanOrEqual(MAX_LOADED);

      // The worker says the same thing about itself, and its replay is inside
      // the worker-wide ceiling rather than the sum of per-session ones.
      const { snapshot } = await client.request<{ snapshot: { stores?: { entries: Record<string, { count?: number; bytes?: number }>; coverage: { complete: boolean } } } }>(
        "resource/snapshot",
        { refresh: true },
      );
      expect(snapshot.stores?.coverage.complete).toBe(true);
      expect(snapshot.stores?.entries.workerSessions?.count).toBeLessThanOrEqual(MAX_LOADED);
      expect(snapshot.stores?.entries.workerReplay?.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);

      // Nothing was lost by any of it: every conversation reopens as itself.
      for (const state of created) {
        const reopened = await client.request<ClientRequests["session/load"]["result"]>("session/load", { path: state.path });
        expect(reopened.state.path).toBe(state.path);
        const { revision } = await client.request<{ revision: string }>("session/revision", { path: state.path });
        expect(revision, state.path).toBe(revisions.get(state.path));
        await client.request("pi/session/detach", { path: state.path });
      }
    } finally {
      client.close();
    }
  }, 180_000);
});
