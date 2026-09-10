import { createServer, type Server } from "node:http";
import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentRun, type JsonRpcMessage } from "@lasercode/protocol";
import { fallbackSnapshot } from "../../src/agents/definitions.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { WorkerServer } from "../../src/server.js";
import { writeStubModels, type StubAnswer, type StubRequest } from "./stub-provider.js";

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
  hold(index: number): () => void;
  answer(index: number, answer: StubAnswer): void;
  fail(index: number, message: string): void;
  arrived(index: number): Promise<void>;
  close(): Promise<void>;
}

function startBarrierProvider(): Promise<BarrierProvider> {
  const requests: StubRequest[] = [];
  const gates = new Map<number, ReturnType<typeof deferred>>();
  const answers = new Map<number, StubAnswer>();
  const failures = new Map<number, string>();
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
      const gate = gates.get(index);
      if (gate) await gate.promise;
      const failure = failures.get(index);
      if (failure) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: failure } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: `goal-${index}`, object: "chat.completion.chunk", created: 1, model: "stub-1" };
      const answer = answers.get(index) ?? { text: `step ${index + 1}` };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      if ("text" in answer) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { content: answer.text }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
      } else {
        const id = answer.toolCall.id ?? `call-${index}`;
        res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: answer.toolCall.name, arguments: "" } }] }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(answer.toolCall.args) } }] }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
      }
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
        hold: (index) => {
          const gate = deferred();
          gates.set(index, gate);
          return gate.resolve;
        },
        answer: (index, answer) => answers.set(index, answer),
        fail: (index, message) => failures.set(index, message),
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
let liveDriver: StableSdkDriver;
let extensionActions: { sendUserMessage(content: string): Promise<void> };
let consumeNextExtensionInput = false;
const runWaiters = new Map<string, Array<() => void>>();
const runObservers = new Set<(run: AgentRun) => void>();
const messageObservers = new Set<(message: JsonRpcMessage) => void>();

function waitForMessage(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
  const existing = out.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<JsonRpcMessage>((resolve) => {
    const observer = (message: JsonRpcMessage) => {
      if (!predicate(message)) return;
      messageObservers.delete(observer);
      resolve(message);
    };
    messageObservers.add(observer);
  });
}

function waitForRun(predicate: (run: AgentRun) => boolean): Promise<AgentRun> {
  const existing = server.agents().runs().find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<AgentRun>((resolve) => {
    const observer = (run: AgentRun) => {
      if (!predicate(run)) return;
      runObservers.delete(observer);
      resolve(run);
    };
    runObservers.add(observer);
  });
}

function waitForTerminal(runId: string): Promise<void> {
  if (["completed", "blocked", "failed", "cancelled"].includes(server.agents().run(runId)?.status ?? "")) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const waiters = runWaiters.get(runId) ?? [];
    waiters.push(resolve);
    runWaiters.set(runId, waiters);
  });
}

function realSession(): AgentSession {
  return (liveDriver as unknown as { runtime: { session: AgentSession } }).runtime.session;
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
  runObservers.clear();
  messageObservers.clear();
  consumeNextExtensionInput = false;
  const captureActions: InlineExtension = (pi) => {
    extensionActions = { sendUserMessage: pi.sendUserMessage.bind(pi) };
    pi.on("input", (event) => {
      if (!consumeNextExtensionInput || event.source !== "extension") return { action: "continue" };
      consumeNextExtensionInput = false;
      return { action: "handled" };
    });
  };
  server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => {
      liveDriver = new StableSdkDriver([captureActions]);
      return liveDriver;
    },
    send: (message) => {
      out.push(message);
      for (const observe of [...messageObservers]) observe(message);
      if (!("method" in message) || message.method !== "agents/run") return;
      const run = (message as { params: { run: AgentRun } }).params.run;
      for (const observe of [...runObservers]) observe(run);
      if (!["completed", "blocked", "failed", "cancelled"].includes(run.status)) return;
      for (const resolve of runWaiters.get(run.runId) ?? []) resolve();
      runWaiters.delete(run.runId);
    },
    features: ["goals", "subagents"],
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
    const releaseFirst = provider.hold(0);
    const started = await call("session/goal/action", { path: childPath, action: { action: "start", objective: "Inspect the project" } });
    expect(started.error).toBeUndefined();
    const run = server.agents().activeRun(childPath);
    expect(run).toMatchObject({ origin: "user", status: "running", task: "Inspect the project" });

    await provider.arrived(0);
    expect(server.agents().activeRun(childPath)?.runId).toBe(run?.runId);
    const releaseContinuation = provider.hold(1);
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

  it("admits public /goal through its nested send under the original user run", async () => {
    const release = provider.hold(0);
    const prompted = call("session/prompt", { path: childPath, content: [{ type: "text", text: "/goal Inspect nested admission" }] });
    await provider.arrived(0);
    const run = server.agents().activeRun(childPath)!;
    expect(run).toMatchObject({ origin: "user", status: "running", task: "/goal Inspect nested admission" });
    expect(server.agents().runs().filter((candidate) => candidate.sessionPath === childPath)).toHaveLength(1);
    await call("session/goal/action", { path: childPath, action: { action: "clear" } });
    await server.agents().bridgeOf(childPath)!.completeRun({ status: "completed", message: "nested goal done" });
    const terminal = waitForTerminal(run.runId);
    release();
    expect((await prompted).result).toEqual({ accepted: true, queued: false });
    await terminal;
    expect(server.agents().run(run.runId)).toMatchObject({ status: "completed", result: { message: "nested goal done" } });
  }, 30_000);

  it("releases accepted goal admission before existing close/cancel checks", async () => {
    const release = provider.hold(0);
    await call("session/goal/action", { path: childPath, action: { action: "start", objective: "Hold this turn" } });
    await provider.arrived(0);
    const closed = await call("pi/session/close", { path: childPath });
    expect(closed.error?.message).toMatch(/still answering/);
    const cancelled = await call("session/cancel", { path: childPath });
    expect(cancelled.error).toBeUndefined();
    release();
  }, 30_000);

  it("owns resume as a new user run and keeps an active edit on that run", async () => {
    const releaseStart = provider.hold(0);
    await call("session/goal/action", { path: childPath, action: { action: "start", objective: "Original objective" } });
    const first = server.agents().activeRun(childPath)!;
    expect(first.origin).toBe("user");
    await call("session/goal/action", { path: childPath, action: { action: "pause" } });
    await server.agents().bridgeOf(childPath)!.completeRun({ status: "completed", message: "paused cleanly" });
    const firstTerminal = waitForTerminal(first.runId);
    releaseStart();
    await firstTerminal;
    expect(server.agents().run(first.runId)).toMatchObject({ status: "completed" });

    const releaseResume = provider.hold(1);
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

  it("ends real handled input without phantom ownership, provider work or a nudge", async () => {
    consumeNextExtensionInput = true;
    const runStarted = waitForRun((run) => run.sessionPath === childPath && run.task === "consume without model work");
    await expect(extensionActions.sendUserMessage("consume without model work")).resolves.toBeUndefined();
    const run = await runStarted;
    await waitForTerminal(run.runId);
    expect(server.agents().run(run.runId)).toMatchObject({
      origin: "agent",
      status: "failed",
      error: expect.stringContaining("without starting model work"),
    });
    expect(server.agents().activeRun(childPath)).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
  }, 30_000);

  it("keeps extension sends live after real same-session navigation rebinding", async () => {
    const entries = (await liveDriver.entries()).entries as Array<{ id?: string; type?: string }>;
    const message = entries.find((entry) => entry.type === "message" && entry.id);
    expect(message?.id).toBeDefined();
    expect((await liveDriver.navigateTree(message!.id!)).cancelled).toBe(false);
    provider.answer(0, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "rebound done" } } });

    await expect(extensionActions.sendUserMessage("work after navigation")).resolves.toBeUndefined();
    const run = server.agents().activeRun(childPath)!;
    expect(run).toMatchObject({ origin: "agent", status: "running", task: "work after navigation" });
    await waitForTerminal(run.runId);
    expect(server.agents().run(run.runId)).toMatchObject({ status: "completed", result: { message: "rebound done" } });
    expect(provider.requests).toHaveLength(1);
  }, 30_000);

  it("holds accepted ownership before agent_start while concurrent refusal, close and cancel stay deterministic", async () => {
    const session = realSession();
    const agent = session.agent as unknown as { prompt(messages: unknown): Promise<void> };
    const nativePrompt = agent.prompt.bind(agent);
    const nativeAbort = session.abort.bind(session);
    const entered = deferred();
    const abortEntered = deferred();
    const release = deferred();
    let cancelled = false;
    agent.prompt = async (messages) => {
      entered.resolve();
      await release.promise;
      if (cancelled) throw new Error("cancelled at the accepted pre-start barrier");
      return nativePrompt(messages);
    };
    (session as unknown as { abort(): Promise<void> }).abort = async () => {
      cancelled = true;
      abortEntered.resolve();
      await nativeAbort();
    };

    const from = out.length;
    const accepted = extensionActions.sendUserMessage("accepted before start");
    await entered.promise;
    await expect(accepted).resolves.toBeUndefined();
    const run = server.agents().activeRun(childPath)!;
    expect(run).toMatchObject({ origin: "agent", status: "running", task: "accepted before start" });
    expect(out.slice(from).some((message) => "method" in message && message.method === "session/update" && (message as { params?: { update?: { kind?: string } } }).params?.update?.kind === "turn_start")).toBe(false);

    await expect(extensionActions.sendUserMessage("refused while accepted work is held")).rejects.toThrow(/already processing|refused before model ownership/i);
    const closed = await call("pi/session/close", { path: childPath });
    expect(closed.error?.message).toMatch(/still answering/);
    const cancelling = call("session/cancel", { path: childPath });
    await abortEntered.promise;
    const terminal = waitForTerminal(run.runId);
    release.resolve();
    expect((await cancelling).error).toBeUndefined();
    await terminal;
    expect(server.agents().run(run.runId)).toMatchObject({ status: "failed", error: expect.stringContaining("cancelled at the accepted pre-start barrier") });
    expect(out.slice(from).some((message) => "method" in message && message.method === "session/update" && (message as { params?: { update?: { kind?: string } } }).params?.update?.kind === "turn_start")).toBe(false);
  }, 30_000);

  it("distinguishes real pre-start auth failures from an accepted provider failure", async () => {
    const session = realSession();
    const modelRuntime = session.modelRuntime as unknown as {
      hasConfiguredAuth(provider: string): boolean;
      checkAuth(provider: string): Promise<string | undefined>;
    };
    const configured = modelRuntime.hasConfiguredAuth.bind(modelRuntime);
    const check = modelRuntime.checkAuth.bind(modelRuntime);
    modelRuntime.hasConfiguredAuth = () => false;
    modelRuntime.checkAuth = async () => undefined;
    const refused = extensionActions.sendUserMessage("refused before start");
    const refusedRun = server.agents().activeRun(childPath)!;
    await expect(refused).rejects.toThrow(/No API key|authenticate/i);
    await waitForTerminal(refusedRun.runId);
    expect(server.agents().run(refusedRun.runId)?.error).toMatch(/No API key|authenticate/i);
    modelRuntime.hasConfiguredAuth = () => { throw new Error("pre-start auth exception"); };
    const exception = extensionActions.sendUserMessage("exception before start");
    const exceptionRun = server.agents().activeRun(childPath)!;
    await expect(exception).rejects.toThrow("pre-start auth exception");
    await waitForTerminal(exceptionRun.runId);
    expect(server.agents().run(exceptionRun.runId)?.error).toContain("pre-start auth exception");
    modelRuntime.hasConfiguredAuth = configured;
    modelRuntime.checkAuth = check;
    expect(provider.requests).toHaveLength(0);
    expect(server.agents().activeRun(childPath)).toBeUndefined();

    provider.fail(0, "provider failed after acceptance");
    const release = provider.hold(0);
    await expect(extensionActions.sendUserMessage("accepted then provider fails")).resolves.toBeUndefined();
    const accepted = server.agents().activeRun(childPath)!;
    expect(accepted).toMatchObject({ origin: "agent", status: "running" });
    await provider.arrived(0);
    const terminal = waitForTerminal(accepted.runId);
    release();
    await terminal;
    expect(server.agents().run(accepted.runId)).toMatchObject({ status: "failed" });
  }, 30_000);

  it("finishes an old real invocation before starting one late background successor", async () => {
    const marker = join(base, "release-background");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo late`;
    provider.answer(0, { toolCall: { name: "bash", args: { command, background: true } } });
    provider.answer(1, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "old done" } } });
    provider.answer(2, { text: "old invocation may settle" });
    provider.answer(3, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } });

    const taskFinished = waitForMessage((message) => {
      if (!("method" in message) || message.method !== "pi/extension/message") return false;
      const value = message as { params?: { message?: { type?: string; task?: { status?: string } } } };
      return value.params?.message?.type === "lasercode/task/update" && value.params.message.task?.status === "completed";
    });
    const bridge = server.agents().bridgeOf(childPath)!;
    const complete = bridge.completeRun;
    const successorQueued = waitForRun((run) => run.sessionPath === childPath && run.status === "queued");
    bridge.completeRun = async (input) => {
      const result = await complete(input);
      writeFileSync(marker, "go\n");
      await taskFinished;
      await successorQueued;
      return result;
    };

    const oldReply = call("session/prompt", { path: childPath, content: [{ type: "text", text: "Start background work then finish." }] });
    await provider.arrived(1);
    const old = server.agents().activeRun(childPath)!;
    expect(old).toMatchObject({ origin: "user", status: "running" });
    const successor = await successorQueued;
    expect(successor).toMatchObject({ origin: "user", task: expect.stringContaining("Background task") });

    const oldTerminal = waitForTerminal(old.runId);
    expect((await oldReply).result).toEqual({ accepted: true, queued: false });
    await oldTerminal;
    expect(server.agents().run(old.runId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    await provider.arrived(3);
    expect(server.agents().activeRun(childPath)?.runId).toBe(successor.runId);
    await waitForTerminal(successor.runId);
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" } });
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(2);
    expect(provider.requests).toHaveLength(4);
  }, 30_000);

  it("records a real notify:false background exit without creating model ownership", async () => {
    const marker = join(base, "release-quiet-background");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo quiet`;
    provider.answer(0, { toolCall: { name: "bash", args: { command, background: true, notify: false } } });
    provider.answer(1, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "only run done" } } });
    provider.answer(2, { text: "settle quietly" });
    const taskFinished = waitForMessage((message) => {
      if (!("method" in message) || message.method !== "pi/extension/message") return false;
      const value = message as { params?: { message?: { type?: string; task?: { status?: string } } } };
      return value.params?.message?.type === "lasercode/task/update" && value.params.message.task?.status === "completed";
    });
    const bridge = server.agents().bridgeOf(childPath)!;
    const complete = bridge.completeRun;
    bridge.completeRun = async (input) => {
      const result = await complete(input);
      writeFileSync(marker, "go\n");
      await taskFinished;
      return result;
    };

    const reply = call("session/prompt", { path: childPath, content: [{ type: "text", text: "Run quiet background work." }] });
    await provider.arrived(1);
    const only = server.agents().activeRun(childPath)!;
    const terminal = waitForTerminal(only.runId);
    expect((await reply).result).toEqual({ accepted: true, queued: false });
    await terminal;
    expect(server.agents().run(only.runId)).toMatchObject({ status: "completed", result: { message: "only run done" } });
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
  }, 30_000);
});
