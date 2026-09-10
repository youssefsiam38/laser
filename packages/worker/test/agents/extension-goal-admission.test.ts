import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentRun, type JsonRpcMessage } from "@lasercode/protocol";
import { fallbackSnapshot } from "../../src/agents/definitions.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { WorkerServer } from "../../src/server.js";
import { writeStubModels, type StubRequest } from "./stub-provider.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

interface BarrierProvider {
  server: Server;
  url: string;
  requests: StubRequest[];
  holdNext(): () => void;
  arrived(index: number): Promise<void>;
  close(): Promise<void>;
}

function startBarrierProvider(): Promise<BarrierProvider> {
  const requests: StubRequest[] = [];
  const gates: Array<ReturnType<typeof deferred>> = [];
  const arrivals = new Map<number, ReturnType<typeof deferred>>();
  const arrived = (index: number) => {
    let value = arrivals.get(index);
    if (!value) {
      value = deferred();
      arrivals.set(index, value);
    }
    if (requests.length > index) value.resolve();
    return value.promise;
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const index = requests.length;
      requests.push(JSON.parse(body) as StubRequest);
      arrivals.get(index)?.resolve();
      const gate = gates.shift();
      if (gate) await gate.promise;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: `goal-${index}`, object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      res.write(sse({ ...base, choices: [{ index: 0, delta: { content: `step ${index + 1}` }, finish_reason: null }] }));
      res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        holdNext: () => {
          const gate = deferred();
          gates.push(gate);
          return gate.resolve;
        },
        arrived,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

let base: string;
let provider: BarrierProvider;
let server: WorkerServer;
let out: JsonRpcMessage[];
let childPath: string;
let nextId: number;
const runWaiters = new Map<string, Array<() => void>>();

function waitForTerminal(runId: string): Promise<void> {
  if (["completed", "blocked", "failed", "cancelled"].includes(server.agents().run(runId)?.status ?? "")) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const waiters = runWaiters.get(runId) ?? [];
    waiters.push(resolve);
    runWaiters.set(runId, waiters);
  });
}

async function call(method: string, params?: unknown) {
  const id = nextId++;
  await server.handle({ jsonrpc: "2.0", id, method, params });
  return out.find((message) => "id" in message && message.id === id) as { result?: unknown; error?: { message: string } };
}

async function prepareChild(): Promise<void> {
  const preparer = new StableSdkDriver();
  const state = await preparer.open({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    features: ["goals"],
  });
  await preparer.appendEntry(SESSION_AGENT_ENTRY_TYPE, {
    agentName: "worker",
    kind: "child",
    subagentName: "goal-worker",
    parentPath: join(base, "parent.jsonl"),
    parentSessionId: "parent",
    rootPath: join(base, "parent.jsonl"),
    runId: "run_seed",
  });
  await preparer.setModel({ provider: "stub", id: "stub-1" });
  await preparer.prompt([{ type: "text", text: "Seed the saved child session." }]);
  childPath = preparer.state().path || state.path;
  await preparer.dispose();
  provider.requests.splice(0);

  const snapshot = fallbackSnapshot();
  const model = { provider: "stub", id: "stub-1" };
  const worker = {
    ...snapshot.agents[0]!,
    name: "worker",
    engineInstructions: false,
    instructions: "Work on the active goal and finish only when asked.",
    model,
    supportsSubagents: false,
    allowedAgents: [],
  };
  await call("agents/sync", { snapshot: { ...snapshot, revision: 1, agents: [worker, ...snapshot.agents.slice(1)], defaultAgent: "worker" } });
  const loaded = await call("session/load", { path: childPath });
  expect(loaded.error).toBeUndefined();
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-extension-goal-`));
  for (const path of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, path), { recursive: true });
  provider = await startBarrierProvider();
  writeStubModels(join(base, "agent"), provider.url);
  out = [];
  nextId = 1;
  runWaiters.clear();
  server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => new StableSdkDriver(),
    send: (message) => {
      out.push(message);
      if (!("method" in message) || message.method !== "agents/run") return;
      const run = (message as { params: { run: AgentRun } }).params.run;
      if (!["completed", "blocked", "failed", "cancelled"].includes(run.status)) return;
      for (const resolve of runWaiters.get(run.runId) ?? []) resolve();
      runWaiters.delete(run.runId);
    },
    features: ["goals"],
    projectTrusted: true,
  });
  await prepareChild();
});

afterEach(async () => {
  await server.dispose();
  await provider.close();
  rmSync(base, { recursive: true, force: true });
});

describe("extension-generated goal admission through the real server", () => {
  it("owns start and automatic continuation under one user run before provider work", async () => {
    const releaseFirst = provider.holdNext();
    const started = await call("session/goal/action", { path: childPath, action: { action: "start", objective: "Inspect the project" } });
    expect(started.error).toBeUndefined();
    const run = server.agents().activeRun(childPath);
    expect(run).toMatchObject({ origin: "user", status: "running", task: "Inspect the project" });

    await provider.arrived(0);
    expect(server.agents().activeRun(childPath)?.runId).toBe(run?.runId);
    const releaseContinuation = provider.holdNext();
    releaseFirst();
    await provider.arrived(1);
    expect(server.agents().activeRun(childPath)?.runId).toBe(run?.runId);
    expect(server.agents().runs().filter((candidate) => candidate.sessionPath === childPath)).toHaveLength(1);

    await call("session/goal/action", { path: childPath, action: { action: "clear" } });
    await call("pi/session/clear_queue", { path: childPath });
    await server.agents().bridgeOf(childPath)!.completeRun({ status: "completed", message: "continuation stayed owned" });
    releaseContinuation();
    await provider.arrived(1);
  }, 30_000);

  it("releases accepted goal admission before existing close/cancel checks", async () => {
    const release = provider.holdNext();
    await call("session/goal/action", { path: childPath, action: { action: "start", objective: "Hold this turn" } });
    await provider.arrived(0);
    const closed = await call("pi/session/close", { path: childPath });
    expect(closed.error?.message).toMatch(/still answering/);
    const cancelled = await call("session/cancel", { path: childPath });
    expect(cancelled.error).toBeUndefined();
    release();
  }, 30_000);

  it("owns resume as a new user run and keeps an active edit on that run", async () => {
    const releaseStart = provider.holdNext();
    await call("session/goal/action", { path: childPath, action: { action: "start", objective: "Original objective" } });
    const first = server.agents().activeRun(childPath)!;
    expect(first.origin).toBe("user");
    await call("session/goal/action", { path: childPath, action: { action: "pause" } });
    await server.agents().bridgeOf(childPath)!.completeRun({ status: "completed", message: "paused cleanly" });
    const firstTerminal = waitForTerminal(first.runId);
    releaseStart();
    await firstTerminal;
    expect(server.agents().run(first.runId)).toMatchObject({ status: "completed" });

    const releaseResume = provider.holdNext();
    await call("session/goal/action", { path: childPath, action: { action: "resume" } });
    const resumed = server.agents().activeRun(childPath)!;
    expect(resumed).toMatchObject({ origin: "user", status: "running" });
    expect(resumed.runId).not.toBe(first.runId);
    await provider.arrived(1);
    const runsBeforeEdit = server.agents().runs().length;
    const edited = await call("session/goal/action", { path: childPath, action: { action: "edit", objective: "Revised objective" } });
    expect(edited.error).toBeUndefined();
    expect(server.agents().activeRun(childPath)?.runId).toBe(resumed.runId);
    expect(server.agents().runs()).toHaveLength(runsBeforeEdit);

    await call("session/goal/action", { path: childPath, action: { action: "clear" } });
    await call("pi/session/clear_queue", { path: childPath });
    await server.agents().bridgeOf(childPath)!.completeRun({ status: "completed", message: "resume and edit stayed owned" });
    releaseResume();
  }, 30_000);
});
