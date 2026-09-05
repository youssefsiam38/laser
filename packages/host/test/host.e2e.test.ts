/**
 * M1-T1 done-when, end to end: a WebSocket client connects to the host, lists
 * sessions, opens one (spawning a real worker + Pi), prompts a stub provider,
 * and receives seq-numbered updates. Requires `pnpm -r build` (spawns the
 * worker's dist). Sandboxed dirs; never touches ~/.pi/agent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage, SessionState, SessionUpdateParams } from "@piorbit/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";

const REPLY = ["Hi ", "from ", "host"];

function stubProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      for (const p of REPLY) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`);
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
    this.ws.on("message", (d) => this.inbound.push(JSON.parse(d.toString()) as JsonRpcMessage));
    await new Promise<void>((r) => this.ws.once("open", () => r()));
  }
  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
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
  base = mkdtempSync(join(tmpdir(), "piorbit-host-"));
  for (const d of ["project", "agent"]) mkdirSync(join(base, d), { recursive: true });
  stub = await stubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: stub.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
  );
  logs = [];
  host = new HostServer({ agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), log: (l) => logs.push(l) });
});

afterEach(async () => {
  await host.close();
  await new Promise<void>((r) => stub.server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(defaultWorkerMain()))("host end to end", () => {
  it("serves health and placeholder UI, lists, opens, prompts, streams, resumes", async () => {
    const { url } = await host.listen();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${url}/healthz`);
    expect(await health.text()).toBe("ok");

    const client = new Client();
    await client.connect(url);

    // Empty catalog before any session exists.
    expect(await client.request("pi/session/list", {})).toEqual({ sessions: [] });

    // Open a session (spawns the worker) and see the worker come up.
    const { state } = await client.request<{ state: SessionState }>("session/new", { cwd: join(base, "project") });
    expect(state.cwd).toBe(join(base, "project"));
    await client.waitFor((m) => "method" in m && m.method === "pi/worker/status" && (m.params as { status: string }).status === "ready");
    await client.waitFor((m) => "method" in m && m.method === "pi/extension/message");
    expect(host.pool.cwds()).toEqual([join(base, "project")]);

    // Prompt through host → worker → Pi → stub provider.
    await client.request("pi/model/set", { path: state.path, model: { provider: "stub", id: "stub-1" } });
    const prompted = await client.request("session/prompt", { path: state.path, content: [{ type: "text", text: "hello" }] });
    expect(prompted).toEqual({ accepted: true, queued: false });
    await client.waitFor((m) => "method" in m && m.method === "session/update" && (m.params as SessionUpdateParams).update.kind === "agent_settled");

    const updates = client.updates();
    expect(updates.map((u) => u.seq)).toEqual(updates.map((_, i) => i + 1)); // contiguous from 1
    const text = updates.filter((u) => u.update.kind === "text_delta").map((u) => (u.update as { delta: string }).delta).join("");
    expect(text).toBe(REPLY.join(""));

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

  it("never runs two workers for one cwd", async () => {
    await host.listen();
    const [a, b] = await Promise.all([host.pool.get(join(base, "project")), host.pool.get(join(base, "project"))]);
    expect(a).toBe(b);
    expect(host.pool.cwds()).toHaveLength(1);
  }, 60_000);
});
