/**
 * RP-4 end to end, with a real worker and a real engine: a conversation whose
 * runtime is released comes back exactly as it was, and one that is holding
 * work is not released at all.
 *
 * The strongest statement available is the durable revision (RP-9): it is bound
 * to the session's identity and its visible history, and it is stable across a
 * restart when the canonical content has not changed. If the revision, the
 * branch leaf and the entries all come back equal, the release cost the person
 * nothing but a reload.
 */
import { PRODUCT_NAME, isSessionRevision, type SessionState, type SessionUpdateParams } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage } from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";

function stubProvider(): Promise<{ server: Server; url: string; requests: number }> {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      state.requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      for (const piece of ["Hello ", "from ", "the stub"]) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, get requests() { return state.requests; }, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }),
    ),
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
  waitFor(predicate: (message: JsonRpcMessage) => boolean, ms = 30_000): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const hit = this.inbound.find(predicate);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout; last: ${JSON.stringify(this.inbound.slice(-2))}`)), ms);
      const listener = () => {
        const found = this.inbound.find(predicate);
        if (found) { clearTimeout(timer); this.ws.off("message", listener); resolve(found); }
      };
      this.ws.on("message", listener);
    });
  }
  updates(): SessionUpdateParams[] {
    return this.inbound
      .filter((message) => "method" in message && message.method === "session/update")
      .map((message) => (message as { params: SessionUpdateParams }).params);
  }
  close() { this.ws.close(); }
}

let base: string;
let host: HostServer;
let stub: Awaited<ReturnType<typeof stubProvider>>;

/** The same host, started again over the same directories. */
function restartedHost(): HostServer {
  return new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    workerIdleMs: 600_000,
    workerSweepMs: 0,
    log: () => {},
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-unload-`));
  for (const dir of ["project", "agent"]) mkdirSync(join(base, dir), { recursive: true });
  stub = await stubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
  );
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }));
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    // Long enough that nothing retires underneath these tests: the releases
    // here are asked for explicitly, which is what the policy does on a timer.
    workerIdleMs: 600_000,
    workerSweepMs: 0,
    log: () => {},
  });
});

afterEach(async () => {
  await host.close();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(defaultWorkerMain()))("releasing a session's runtime, end to end", () => {
  it("brings the same conversation back: same revision, same branch, same durable records", async () => {
    let client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    try {
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "hello" }] });
      await client.waitFor((message) => "method" in message && message.method === "session/update"
        && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled");

      const before = await client.request<{ revision: string; environmentKey: string; authority: string }>("session/revision", { path: state.path });
      expect(isSessionRevision(before.revision)).toBe(true);
      expect(before.authority).toBe("live");
      const entriesBefore = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", { path: state.path });
      expect(entriesBefore.entries.length).toBeGreaterThan(0);
      const bytesBefore = readFileSync(state.path, "utf8");
      const seqBefore = client.updates().at(-1)!.seq;
      const epochBefore = client.updates().at(-1)!.epoch;
      const messagesBefore = client.updates()
        .map((params) => (params.update.kind === "state" ? params.update.state.messageCount : undefined))
        .filter((count): count is number => count !== undefined)
        .at(-1)!;
      expect(messagesBefore).toBeGreaterThan(0);

      // The person leaves: the membership authority (RP-6) stops holding it,
      // and only then may the runtime go.
      await client.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);

      // With no naming model connected, this worker is still holding the queued
      // naming work for that first prompt, and it says so rather than dropping
      // it (RP-4, review §5). The honest cost: with a model never connected,
      // this one runtime stays until the conversation is closed.
      const naming = await host.pool.unloadSession(cwd, state.path, "idle");
      expect(naming).toMatchObject({ unloaded: false, pins: [{ kind: "naming" }] });

      // A new host is a new worker with nothing queued, which is the ordinary
      // way that intent ends: the conversation is loaded again from its record.
      client.close();
      await host.close();
      host = restartedHost();
      const second = new Client();
      await second.connect((await host.listen()).url);
      await second.request("session/load", { path: state.path });
      await second.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);
      const released = await host.pool.unloadSession(cwd, state.path, "idle");
      expect(released).toEqual({ unloaded: true, pins: [] });
      client = second;
      expect(host.pool.openSessions(cwd)).toEqual([]);
      // Nothing was written, moved or deleted by the release itself.
      expect(readFileSync(state.path, "utf8")).toBe(bytesBefore);

      // Coming back re-opens it from the canonical record.
      const reopened = await client.request<{ state: SessionState; seq: number; replayFrom: number; revision?: string }>("session/load", {
        path: state.path,
        fromSeq: seqBefore,
      });
      expect(reopened.state.path).toBe(state.path);
      expect(reopened.state.messageCount).toBe(messagesBefore);
      // A fresh generation numbers from zero and says so, which is the client's
      // signal to re-read rather than believe it missed nothing.
      expect(reopened.replayFrom).not.toBe(seqBefore);
      expect(reopened.revision).toBe(before.revision);

      const after = await client.request<{ revision: string; environmentKey: string }>("session/revision", { path: state.path });
      expect(after.revision).toBe(before.revision);
      expect(after.environmentKey).toBe(before.environmentKey);
      const entriesAfter = await client.request<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", { path: state.path });
      expect(entriesAfter.leafId).toBe(entriesBefore.leafId);
      expect(entriesAfter.entries).toEqual(entriesBefore.entries);

      // And it is a working conversation again, on a new epoch.
      await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "again" }] });
      const settled = await client.waitFor((message) => "method" in message && message.method === "session/update"
        && (message as { params: SessionUpdateParams }).params.sessionPath === state.path
        && (message as { params: SessionUpdateParams }).params.update.kind === "agent_settled"
        && (message as { params: SessionUpdateParams }).params.epoch !== epochBefore);
      expect(settled).toBeDefined();
    } finally {
      client.close();
    }
  }, 120_000);

  it("refuses while a client is following it, and while a message waits in the tray", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    try {
      const { state } = await client.request<{ state: SessionState }>("session/new", { cwd });
      // A followed session is never even asked about: membership decides that.
      expect(host.sessionMembership().holders(state.path)).toBeGreaterThan(0);

      await client.request("session/pending/add", { path: state.path, content: [{ type: "text", text: "later" }] });
      await client.request("pi/session/detach", { path: state.path });
      expect(host.sessionMembership().holders(state.path)).toBe(0);

      const refused = await host.pool.unloadSession(cwd, state.path, "idle");
      expect(refused.unloaded).toBe(false);
      expect(refused.pins.map((pin) => pin.kind)).toContain("pending_tray");
      expect(host.pool.openSessions(cwd)).toEqual([state.path]);

      // The tray is memory only, so the refusal is what keeps the message.
      const tray = await client.request<{ messages: unknown[] }>("session/pending/list", { path: state.path });
      expect(tray.messages).toHaveLength(1);
    } finally {
      client.close();
    }
  }, 120_000);

  it("refuses a client's own attempt to manage runtimes", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    try {
      await expect(client.request("pi/session/unload", { path: join(base, "sessions", "nothing.jsonl") })).rejects.toThrow(
        /app manages its own session runtimes/,
      );
      await expect(client.request("pi/worker/safety", {})).rejects.toThrow(/app manages its own session runtimes/);
    } finally {
      client.close();
    }
  }, 60_000);
});
