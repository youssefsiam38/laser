import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AGENT_EVENT_MESSAGE_TYPE, PRODUCT_NAME, type AgentRun, type ClientRequests, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";

function fakeProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "durable answer" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
  }));
}

class Client {
  private socket!: WebSocket;
  private nextId = 1;
  readonly inbound: JsonRpcMessage[] = [];
  async connect(url: string): Promise<void> {
    this.socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.socket.on("message", (data) => this.inbound.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => this.socket.once("open", resolve));
  }
  async request<R>(method: string, params: unknown): Promise<R> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const message = await this.waitFor((candidate) => "id" in candidate && candidate.id === id);
    const reply = message as { result?: R; error?: { message: string } };
    if (reply.error) throw new Error(reply.error.message);
    return reply.result as R;
  }
  async waitFor(predicate: (message: JsonRpcMessage) => boolean, timeoutMs = 60_000): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.inbound.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for host message");
  }
  close(): void { this.socket.close(); }
}

let base: string;
let provider: Awaited<ReturnType<typeof fakeProvider>>;
let host: HostServer | undefined;
let client: Client | undefined;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-worker-oom-e2e-`));
  for (const directory of ["agent", "project", "sessions", "state"]) mkdirSync(join(base, directory), { recursive: true });
  provider = await fakeProvider();
  writeFileSync(join(base, "agent", "models.json"), JSON.stringify({ providers: {
    stub: { baseUrl: provider.url, api: "openai-completions", apiKey: "scratch", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 200 }] },
  } }));
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }));
});

afterEach(async () => {
  client?.close();
  await host?.close().catch(() => undefined);
  await new Promise<void>((resolve) => provider.server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for canonical reopen");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function liveChildRun(projectCwd: string, parent: SessionState): AgentRun {
  return {
    agentName: "reviewer", subagentName: "review-auth", sessionId: "child-1", runId: "recovery-run",
    sessionPath: join(base, "sessions", "child.jsonl"), projectCwd, rootSessionPath: parent.path, depth: 1,
    parent: { sessionPath: parent.path, sessionId: parent.id }, worktree: null, origin: "agent", status: "running",
    task: "review auth", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe.skipIf(!existsSync(defaultWorkerMain()))("built worker heap-loss convergence", () => {
  it("reopens the same durable revision, leaf and entries after bounded retained allocation", async () => {
    const trigger = join(base, "trigger-oom");
    const consumed = join(base, "oom-consumed");
    const wrapper = join(base, "worker-wrapper.mjs");
    writeFileSync(wrapper, `
import { existsSync, writeFileSync } from "node:fs";
import ${JSON.stringify(pathToFileURL(defaultWorkerMain()).href)};
const trigger = ${JSON.stringify(trigger)};
const consumed = ${JSON.stringify(consumed)};
const timer = setInterval(() => {
  if (!existsSync(trigger) || existsSync(consumed)) return;
  clearInterval(timer);
  writeFileSync(consumed, "once");
  const held = [];
  for (let i = 0; i < 192; i += 1) held.push(new Array(1024 * 1024).fill(i));
}, 25);
`);

    host = new HostServer({
      agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), stateDir: join(base, "state"),
      workerMain: wrapper, workerOldSpaceMiB: 384, workerIdleMs: 600_000, workerSweepMs: 0, log: () => undefined,
    });
    client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    const created = await client.request<{ state: SessionState }>("session/new", { cwd });
    await client.request("session/prompt", { path: created.state.path, content: [{ type: "text", text: "write a short durable answer" }] });
    await client.waitFor((message) => "method" in message && message.method === "session/update"
      && (message.params as { sessionPath?: string; update?: { kind?: string } }).sessionPath === created.state.path
      && (message.params as { update?: { kind?: string } }).update?.kind === "agent_settled");

    const beforeRevision = await client.request<{ revision: string }>("session/revision", { path: created.state.path });
    const beforeEntries = await client.request<ClientRequests["pi/session/entries"]["result"]>("pi/session/entries", { path: created.state.path });
    writeFileSync(trigger, "go");

    await client.waitFor((message) => "method" in message && message.method === "pi/worker/status"
      && (message.params as { status?: string; message?: string }).status === "crashed"
      && /ran out of memory/i.test((message.params as { message?: string }).message ?? ""));
    await waitFor(() => host!.pool.openSessions(cwd).includes(created.state.path));

    const afterRevision = await client.request<{ revision: string }>("session/revision", { path: created.state.path });
    const afterEntries = await client.request<ClientRequests["pi/session/entries"]["result"]>("pi/session/entries", { path: created.state.path });
    expect(afterRevision).toEqual(beforeRevision);
    expect(afterEntries.leafId).toBe(beforeEntries.leafId);
    expect(afterEntries.entries).toEqual(beforeEntries.entries);
  }, 120_000);

  it("persists one ordinary parent agent event through the exact successor after worker loss", async () => {
    host = new HostServer({
      agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), stateDir: join(base, "state"),
      workerOldSpaceMiB: 384, workerIdleMs: 600_000, workerSweepMs: 0, log: () => undefined,
    });
    client = new Client();
    await client.connect((await host.listen()).url);
    const cwd = join(base, "project");
    const created = await client.request<{ state: SessionState }>("session/new", { cwd });
    await client.request("session/prompt", { path: created.state.path, content: [{ type: "text", text: "hold the parent conversation" }] });
    await client.waitFor((message) => "method" in message && message.method === "session/update"
      && (message.params as { sessionPath?: string; update?: { kind?: string } }).sessionPath === created.state.path
      && (message.params as { update?: { kind?: string } }).update?.kind === "agent_settled");

    host.runs.upsert(liveChildRun(cwd, created.state));
    const first = await host.pool.get(cwd);
    process.kill(first.pid!, "SIGKILL");
    await client.waitFor((message) => "method" in message && message.method === "pi/worker/status"
      && (message.params as { status?: string }).status === "crashed");
    await waitFor(() => host!.pool.openSessions(cwd).includes(created.state.path));
    await waitFor(() => readFileSync(created.state.path, "utf8").includes(AGENT_EVENT_MESSAGE_TYPE));

    expect(host.runs.get("recovery-run")).toMatchObject({ status: "failed", endedBy: { initiator: "harness" } });
    const lines = readFileSync(created.state.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
    const recovered = lines.filter((line) => {
      const text = JSON.stringify(line);
      return text.includes(AGENT_EVENT_MESSAGE_TYPE) && text.includes("recovery-run") && text.includes('"initiator":"harness"');
    });
    expect(recovered).toHaveLength(1);
  }, 120_000);
});
