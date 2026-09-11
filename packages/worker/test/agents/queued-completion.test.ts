/**
 * M13-T98 · queued completion ownership, against the real pinned engine.
 *
 * The incident: a child called `complete_agent_run` while two of its parent's
 * follow-ups sat in the engine's queue; the released harness published
 * `completed` at once, aborted one turn, and Pi's post-run loop carried the
 * queued messages on under a run that had ended. The parent's correction and
 * its `interrupt: true` request then became fresh runs that failed busy, and
 * the child's real completion was answered "This run already ended."
 *
 * Every step here is a barrier — a held provider request, a tool blocked on
 * a marker file, a promise the harness resolves — never a sleep. The child
 * is a real Pi session executing real tool calls from the stub provider; the
 * parent is a harness entry whose bridge is driven directly, so nothing but
 * the child's engine ever talks to the provider and every request index is
 * the child's.
 */
import { createServer, type Server } from "node:http";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentRun, type JsonRpcMessage, type SessionUpdate } from "@lasercode/protocol";
import type { AgentHarnessBridge, AgentModelEvent, CompleteRunResult } from "../../src/agents/bridge.js";
import { fallbackSnapshot } from "../../src/agents/definitions.js";
import { NUDGE_TEXT } from "../../src/agents/harness.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import type { DriverInvocationRef } from "../../src/driver.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { WorkerServer } from "../../src/server.js";
import { writeStubModels, type StubRequest } from "./stub-provider.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

type ToolCall = { name: string; args: Record<string, unknown>; id?: string };
type Answer = { text: string } | { toolCall: ToolCall } | { toolCalls: ToolCall[] };

interface BarrierProvider {
  server: Server;
  url: string;
  requests: StubRequest[];
  /** Hold request `index` until the returned function is called. */
  hold(index: number): () => void;
  /** Hold the first request that satisfies `predicate`; `arrived` resolves when it is held. */
  holdWhen(predicate: (request: StubRequest) => boolean): { release: () => void; arrived: Promise<StubRequest> };
  answer(index: number, answer: Answer): void;
  /** The answer for any request without an indexed one. */
  route(respond: (request: StubRequest, index: number) => Answer): void;
  arrived(index: number): Promise<void>;
  close(): Promise<void>;
}

function startBarrierProvider(): Promise<BarrierProvider> {
  const requests: StubRequest[] = [];
  const gates = new Map<number, ReturnType<typeof deferred>>();
  const answers = new Map<number, Answer>();
  const arrivals = new Map<number, ReturnType<typeof deferred>>();
  const conditional: Array<{ predicate: (request: StubRequest) => boolean; gate: ReturnType<typeof deferred>; arrived: ReturnType<typeof deferred<StubRequest>> }> = [];
  let router: (request: StubRequest, index: number) => Answer = (_request, index) => ({ text: `step ${index + 1}` });
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
      const request = JSON.parse(body) as StubRequest;
      requests.push(request);
      arrivals.get(index)?.resolve();
      const gate = gates.get(index);
      if (gate) await gate.promise;
      const held = conditional.findIndex((candidate) => candidate.predicate(request));
      if (held >= 0) {
        const [entry] = conditional.splice(held, 1);
        entry!.arrived.resolve(request);
        await entry!.gate.promise;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: `qc-${index}`, object: "chat.completion.chunk", created: 1, model: "stub-1" };
      const answer = answers.get(index) ?? router(request, index);
      const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      const calls = "toolCalls" in answer ? answer.toolCalls : "toolCall" in answer ? [answer.toolCall] : undefined;
      if (!calls) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { content: answer.text }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
      } else {
        calls.forEach((call, position) => {
          const id = call.id ?? `call-${index}-${position}`;
          res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: position, id, type: "function", function: { name: call.name, arguments: "" } }] }, finish_reason: null }] }));
          res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: position, function: { arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] }));
        });
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }));
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
        holdWhen: (predicate) => {
          const gate = deferred();
          const waiting = deferred<StubRequest>();
          conditional.push({ predicate, gate, arrived: waiting });
          return { release: gate.resolve, arrived: waiting.promise };
        },
        answer: (index, answer) => answers.set(index, answer),
        route: (respond) => { router = respond; },
        arrived,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------

let base: string;
let provider: BarrierProvider;
let server: WorkerServer;
let out: JsonRpcMessage[];
let childPath: string;
let childSessionId: string;
let parentPath: string;
let parentBridge: AgentHarnessBridge;
let nextId: number;
let liveDriver: StableSdkDriver;
let extensionActions: {
  sendUserMessage(content: string): Promise<void>;
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "steer"; triggerTurn: boolean }): Promise<void>;
};
/** Every lifecycle-shaped driver event — and every dialog raised or resolved — with the engine epoch it carried. */
let driverEvents: Array<{ kind: SessionUpdate["kind"] | "ui_request" | "ui_event"; invocation?: DriverInvocationRef; toolName?: string; toolCallId?: string; isError?: boolean; text?: string; dialogId?: string; method?: string }>;
/**
 * A question a loose test tool scheduled from inside its own invocation and
 * raises only when the test says so: `release()` fires the continuation the
 * tool registered, `answer` is what the dialog resolved to.
 */
let detached: { release(): void; answer: Promise<string | undefined> } | undefined;
/** What reached the parent's model, and what the child looked like at that moment. */
let parentEvents: Array<{ event: AgentModelEvent; activeRunId: string | undefined; runStatuses: Record<string, string> }>;
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

/** A driver event that has not happened yet. */
function waitForDriverEvent(predicate: (event: (typeof driverEvents)[number]) => boolean): Promise<void> {
  if (driverEvents.some(predicate)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    driverEventObservers.add((event) => {
      if (!predicate(event)) return false;
      resolve();
      return true;
    });
  });
}
const driverEventObservers = new Set<(event: (typeof driverEvents)[number]) => boolean>();

async function call(method: string, params?: unknown) {
  const id = nextId++;
  await server.handle({ jsonrpc: "2.0", id, method, params });
  return out.find((message) => "id" in message && message.id === id) as { result?: unknown; error?: { message: string } };
}

function sessionUpdates(): SessionUpdate[] {
  return out
    .filter((message) => "method" in message && message.method === "session/update")
    .map((message) => (message as { params: { update: SessionUpdate } }).params.update);
}

function queueUpdates(): Array<{ steering: string[]; followUp: string[] }> {
  return sessionUpdates().flatMap((update) => (update.kind === "queue_update" ? [{ steering: update.steering, followUp: update.followUp }] : []));
}

/** The harness's structured lifecycle diagnostics for the child, in order. */
function lifecycleLogs(): Array<{ level: string; line: string }> {
  return out
    .filter((message) => "method" in message && message.method === "pi/extension/message")
    .map((message) => (message as { params: { path: string; message: { type: string; level?: string; message?: string } } }).params)
    .filter((params) => params.path === childPath && params.message.type === "lasercode/module/log" && typeof params.message.message === "string" && params.message.message.startsWith("lifecycle "))
    .map((params) => ({ level: params.message.level!, line: params.message.message! }));
}

/** Every `module:subagents` log line the worker emitted, for any session: the harness's lifecycle lines and the companion module's own. */
function moduleLogs(): string[] {
  return out
    .filter((message) => "method" in message && message.method === "pi/extension/message")
    .map((message) => (message as { params: { message: { type?: string; module?: string; message?: string } } }).params.message)
    .filter((message) => message.type === "lasercode/module/log" && message.module === "subagents" && typeof message.message === "string")
    .map((message) => message.message!);
}

/** No diagnostic line ever carries a task, a prompt, a message or a question body (contract 7). */
function expectNoBodiesInModuleLogs(texts: readonly string[]): void {
  const lines = moduleLogs();
  expect(lines.length).toBeGreaterThan(0);
  for (const text of texts) {
    expect(lines.filter((line) => line.includes(text)), `a module:subagents line carries "${text}"`).toEqual([]);
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("");
  return "";
}

/** The text of a request's last message when it is the user's, else undefined. */
function lastUserText(request: StubRequest): string | undefined {
  const last = request.messages.at(-1);
  return last?.role === "user" ? textOfContent(last.content) : undefined;
}

/** How many times `text` appears as a user message in `request`'s full history. */
function userOccurrences(request: StubRequest, text: string): number {
  return request.messages.filter((message) => message.role === "user" && textOfContent(message.content) === text).length;
}

/**
 * No two engine invocations ever overlapped: an `agent_start` carrying a new
 * epoch never arrives while an older epoch has started and not settled. A
 * second `agent_start` of the *same* epoch is Pi continuing one run and is
 * not an overlap.
 */
function assertNoOverlappingInvocations(): void {
  let open: string | undefined;
  for (const event of driverEvents) {
    if (!event.invocation) continue;
    if (event.kind === "agent_start") {
      expect(open === undefined || open === event.invocation.id, `invocation ${event.invocation.id} started while ${open} was still running`).toBe(true);
      open = event.invocation.id;
    } else if (event.kind === "agent_settled") {
      expect(event.invocation.id, "a settle for an epoch that never started").toBe(open);
      open = undefined;
    }
  }
}

async function prepareChild(): Promise<void> {
  parentPath = join(base, "parent.jsonl");
  const preparer = new StableSdkDriver();
  const state = await preparer.open({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    features: ["subagents", "goals"],
  });
  await preparer.appendEntry(SESSION_AGENT_ENTRY_TYPE, {
    agentName: "worker",
    kind: "child",
    subagentName: "owned-child",
    parentPath,
    parentSessionId: "parent",
    rootPath: parentPath,
    runId: "run_seed",
  });
  await preparer.setModel({ provider: "stub", id: "stub-1" });
  await preparer.prompt([{ type: "text", text: "Seed the saved child session." }]);
  childPath = preparer.state().path || state.path;
  await preparer.dispose();
  provider.requests.splice(0);

  const snapshot = fallbackSnapshot();
  const model = { provider: "stub", id: "stub-1" };
  const lead = { ...snapshot.agents[0]!, name: "lead", engineInstructions: false, instructions: "You lead.", model, supportsSubagents: true, allowedAgents: ["worker"] };
  const worker = { ...snapshot.agents[0]!, name: "worker", engineInstructions: false, instructions: "Work, then call complete_agent_run.", model, supportsSubagents: false, allowedAgents: [] };
  await call("agents/sync", { snapshot: { ...snapshot, revision: 1, agents: [lead, worker, ...snapshot.agents.slice(1)], defaultAgent: "worker" } });
  const loaded = await call("session/load", { path: childPath });
  expect(loaded.error).toBeUndefined();
  childSessionId = (loaded.result as { state: { id: string } }).state.id;
  driverEvents.splice(0);

  // The parent: a harness entry at the path the child's record names, whose
  // bridge the test drives the way the companion's tools would. No engine
  // runs for it, so every provider request is the child's.
  const handle = server.agents().prepareSession({ role: rootRole("lead"), definition: lead, record: rootRecord("lead"), projectCwd: join(base, "project") });
  handle.attach(parentPath, "parent");
  parentBridge = handle.bridge;
  parentBridge.onEvent((event) => {
    parentEvents.push({
      event,
      activeRunId: server.agents().activeRun(childPath)?.runId,
      runStatuses: Object.fromEntries(server.agents().runs().filter((run) => run.sessionPath === childPath).map((run) => [run.runId, run.status])),
    });
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-queued-completion-`));
  for (const path of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, path), { recursive: true });
  provider = await startBarrierProvider();
  writeStubModels(join(base, "agent"), provider.url);
  out = [];
  nextId = 1;
  driverEvents = [];
  parentEvents = [];
  runWaiters.clear();
  runObservers.clear();
  messageObservers.clear();
  driverEventObservers.clear();
  detached = undefined;
  const captureActions: InlineExtension = (pi) => {
    extensionActions = {
      sendUserMessage: pi.sendUserMessage.bind(pi),
      sendMessage: (message, options) => pi.sendMessage(message, options),
    };
    // Two loose tools. `ask_later` returns at once but leaves a continuation
    // behind in its own async context — the prompt invocation it ran under —
    // and that continuation asks a question when the test releases it: a
    // dialog raised by an invocation after it has finished. `ask_now` asks
    // and waits, giving the dialog its abort signal.
    pi.registerTool({
      name: "ask_later",
      label: "Ask later",
      description: "Schedules a question that is raised from this tool's own async context after the tool has returned.",
      parameters: { type: "object", properties: {} } as never,
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const gate = deferred();
        let settle!: (value: string | undefined) => void;
        const answer = new Promise<string | undefined>((resolve) => { settle = resolve; });
        void gate.promise.then(() => ctx.ui.select("Later?", ["a", "b"])).then(settle, () => settle(undefined));
        detached = { release: gate.resolve, answer };
        return { content: [{ type: "text", text: "scheduled" }], details: undefined };
      },
    });
    pi.registerTool({
      name: "ask_now",
      label: "Ask now",
      description: "Asks the person a question and waits for the answer, giving up on abort.",
      parameters: { type: "object", properties: {} } as never,
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const answer = await ctx.ui.select("Now?", ["x", "y"], { signal });
        return { content: [{ type: "text", text: answer === undefined ? "no answer" : `answer: ${answer}` }], details: undefined };
      },
    });
  };
  server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => {
      liveDriver = new StableSdkDriver([captureActions]);
      liveDriver.subscribe((event) => {
        if (event.type === "ui_request" || event.type === "ui_event") {
          const record: (typeof driverEvents)[number] = {
            kind: event.type,
            ...(event.invocation ? { invocation: event.invocation } : {}),
            ...(event.type === "ui_request" ? { dialogId: event.request.id, method: event.request.method } : { method: event.event.method, ...("id" in event.event ? { dialogId: event.event.id } : {}) }),
          };
          driverEvents.push(record);
          for (const observe of [...driverEventObservers]) if (observe(record)) driverEventObservers.delete(observe);
          return;
        }
        if (event.type !== "update") return;
        const update = event.update;
        if (!["agent_start", "agent_end", "agent_settled", "turn_start", "tool_execution_start", "tool_execution_end", "message_end"].includes(update.kind)) return;
        const record: (typeof driverEvents)[number] = { kind: update.kind, ...(event.invocation ? { invocation: event.invocation } : {}) };
        if (update.kind === "tool_execution_start") Object.assign(record, { toolName: update.toolName, toolCallId: update.toolCallId });
        if (update.kind === "tool_execution_end") Object.assign(record, { toolCallId: update.toolCallId, isError: update.isError, text: textOfContent((update.result as { content?: unknown } | undefined)?.content) });
        driverEvents.push(record);
        for (const observe of [...driverEventObservers]) if (observe(record)) driverEventObservers.delete(observe);
      });
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

/** Replace the child's `completeRun` so the test can look at the world at the exact moment the tool returns. */
function observeCompletions(afterEach?: (result: CompleteRunResult, ordinal: number) => Promise<void> | void): { results: CompleteRunResult[]; first: Promise<void> } {
  const bridge = server.agents().bridgeOf(childPath)!;
  const complete = bridge.completeRun;
  const results: CompleteRunResult[] = [];
  const first = deferred();
  bridge.completeRun = async (input) => {
    const result = await complete(input);
    results.push(result);
    await afterEach?.(result, results.length);
    if (results.length === 1) first.resolve();
    return result;
  };
  return { results, first: first.promise };
}

const F1 = "Also check the refresh path.";
const F2 = "Then run the unit tests.";
const CORRECTION = "Correction: the config lives under packages/host.";
const INTERRUPT = "Stop: do not touch the migration files.";

describe("queued completion ownership against the real engine", () => {
  it("keeps a completing run owned until its invocation stops, carries both queued follow-ups plus a correction and an interrupt to one successor in order, and lets that successor complete", async () => {
    const marker = join(base, "release-old-bash");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo released`;
    const releaseFirst = provider.hold(0);
    // The child's first answer is a mixed batch: the terminating tool and a
    // command that blocks. Pi runs both (terminate needs every call), so the
    // old invocation is demonstrably still executing after completion.
    provider.answer(0, {
      toolCalls: [
        { name: "complete_agent_run", args: { status: "completed", message: "old done" }, id: "call-complete" },
        { name: "bash", args: { command }, id: "call-bash" },
      ],
    });
    provider.route((request) => {
      const last = lastUserText(request);
      if (last === INTERRUPT) return { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } };
      if (last !== undefined) return { text: `noted: ${last}` };
      return { text: "nothing to add" };
    });

    // Step 4 is observed from inside the tool: the world at the exact moment
    // `completeRun` returns to `complete_agent_run`, before Pi sees its result.
    let atCompletion: {
      status: string | undefined;
      parentEvents: number;
      fleetRow: { runId: string; state: string; status: string } | undefined;
      childRuns: Array<{ runId: string; status: string; task: string }>;
      sessionInfo: { runId?: string; runStatus?: string } | undefined;
      pendingInEngine: number;
      logs: string[];
    } | undefined;
    const completions = observeCompletions(async (_result, ordinal) => {
      if (ordinal !== 1) return;
      const fleet = await parentBridge.inspectFleet();
      const row = fleet.rows[0];
      atCompletion = {
        status: server.agents().run(oldRunId)?.status,
        parentEvents: parentEvents.length,
        fleetRow: row && row.kind === "agent" ? { runId: row.runId, state: row.state, status: row.status } : undefined,
        childRuns: server.agents().runs().filter((run) => run.sessionPath === childPath).map((run) => ({ runId: run.runId, status: run.status, task: run.task })),
        sessionInfo: server.agents().sessionInfo(childPath),
        pendingInEngine: liveDriver.state().pendingMessageCount,
        logs: lifecycleLogs().map((log) => log.line),
      };
    });

    // 1. The child is streaming: its first provider request is held.
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start the work.", interrupt: false });
    expect(started).toMatchObject({ delivery: "delivered", status: "running" });
    const oldRunId = started.runId;
    // "delivered" means the engine owns it as its next turn: it is streaming now.
    expect(liveDriver.state().isStreaming).toBe(true);
    await provider.arrived(0);

    // 2. Two follow-ups while it streams: both queued, both in the engine.
    const queuedFollowUps = waitForMessage((message) => {
      if (!("method" in message) || message.method !== "session/update") return false;
      const update = (message as { params: { update: SessionUpdate } }).params.update;
      return update.kind === "queue_update" && update.followUp.length === 2;
    });
    const first = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: F1, interrupt: false });
    const second = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: F2, interrupt: false });
    expect(first).toMatchObject({ delivery: "queued", runId: oldRunId, status: "running" });
    expect(second).toMatchObject({ delivery: "queued", runId: oldRunId, status: "running" });
    await queuedFollowUps;
    expect(queueUpdates().at(-1)).toEqual({ steering: [], followUp: [F1, F2] });
    expect(liveDriver.state().pendingMessageCount).toBe(2);
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(1);

    // 3. The child's answer is complete_agent_run (plus the blocking command)
    //    while both follow-ups are still pending in the engine.
    releaseFirst();
    await completions.first;

    // 4. At the moment completeRun returned to the tool.
    expect(atCompletion).toBeDefined();
    expect(atCompletion!.status).toBe("running");
    expect(atCompletion!.parentEvents).toBe(0);
    expect(atCompletion!.fleetRow).toEqual({ runId: oldRunId, state: "running", status: "Working" });
    expect(atCompletion!.sessionInfo).toMatchObject({ runId: oldRunId, runStatus: "running" });
    expect(atCompletion!.pendingInEngine).toBe(0);
    expect(atCompletion!.childRuns).toHaveLength(2);
    const successor = atCompletion!.childRuns.find((run) => run.runId !== oldRunId)!;
    expect(successor).toMatchObject({ status: "queued", task: F1 });
    // Both messages left the engine's queue once and went to one successor.
    expect(queueUpdates().at(-1)).toEqual({ steering: [], followUp: [] });
    expect(atCompletion!.logs.filter((line) => line.includes("successor-reserved"))).toHaveLength(1);
    expect(atCompletion!.logs.some((line) => /queue-transferred .*reason=complete successor=run_[0-9a-f]+ clearedSteering=0 clearedFollowUp=2 local=2 preserved=2/.test(line))).toBe(true);
    expect(atCompletion!.logs.some((line) => line.includes(`terminal-declared runId=${oldRunId} status=completed invoking=true phase=terminal-pending`))).toBe(true);
    expect(atCompletion!.logs.some((line) => line.includes("terminal-published"))).toBe(false);

    // 5. Across the boundary — the old invocation is still executing bash —
    //    an ordinary correction and an interrupt. Both are truthfully queued
    //    on the one successor; the interrupt aborts the old invocation.
    const bashAborted = waitForDriverEvent((event) => event.kind === "tool_execution_end" && event.toolCallId === "call-bash");
    const correction = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: CORRECTION, interrupt: false });
    expect(correction).toMatchObject({ delivery: "queued", runId: successor.runId, status: "queued" });
    expect(server.agents().run(oldRunId)?.status).toBe("running");
    const interrupt = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: INTERRUPT, interrupt: true });
    expect(interrupt).toMatchObject({ delivery: "queued", runId: successor.runId, status: "queued" });
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(2);
    await bashAborted;
    const bashEnd = driverEvents.find((event) => event.kind === "tool_execution_end" && event.toolCallId === "call-bash")!;
    expect(bashEnd.isError).toBe(true);
    expect(bashEnd.text).toMatch(/aborted/i);
    expect(existsSync(marker)).toBe(false);
    // Nothing was steered into the engine under the ended run.
    expect(queueUpdates().some((update) => update.steering.includes(INTERRUPT) || update.followUp.includes(CORRECTION))).toBe(false);
    expect(lifecycleLogs().some((log) => log.line.includes(`abort-requested runId=${oldRunId} reason=interrupt-during-terminal-pending`))).toBe(true);

    // 6. The old prompt promise resolves: one completion, delivered only once
    //    the successor is the live run; the successor consumes every message
    //    exactly once, in order.
    await waitForTerminal(oldRunId);
    expect(server.agents().run(oldRunId)).toMatchObject({ status: "completed", result: { status: "completed", message: "old done" } });
    const completed = parentEvents.filter((entry) => entry.event.type === "agent.completed" && entry.event.runId === oldRunId);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.activeRunId).toBe(successor.runId);
    expect(completed[0]!.runStatuses).toEqual({ [oldRunId]: "completed", [successor.runId]: "running" });
    expect(parentEvents.filter((entry) => entry.event.type !== "agent.completed")).toEqual([]);
    expect(lifecycleLogs().filter((log) => log.line.includes(`terminal-published runId=${oldRunId}`))).toHaveLength(1);

    // 7. The successor completes through complete_agent_run — never "This run already ended."
    await waitForTerminal(successor.runId);
    expect(completions.results).toEqual([{ ok: true, runId: oldRunId }, { ok: true, runId: successor.runId }]);
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" } });
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(2);
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.completed", oldRunId], ["agent.completed", successor.runId]]);

    // Five provider requests in all: the task, then one per successor message.
    // The abort of the old invocation never became a provider round-trip.
    expect(provider.requests.map(lastUserText)).toEqual(["Start the work.", F1, F2, CORRECTION, INTERRUPT]);
    const consumed = provider.requests.slice(1).map(lastUserText).filter((text): text is string => text !== undefined);
    expect(consumed).toEqual([F1, F2, CORRECTION, INTERRUPT]);
    const history = provider.requests.at(-1)!;
    for (const text of [F1, F2, CORRECTION, INTERRUPT]) expect(userOccurrences(history, text), text).toBe(1);
    expect(userOccurrences(history, NUDGE_TEXT)).toBe(0);
    assertNoOverlappingInvocations();
    for (const event of driverEvents) {
      if (event.kind === "agent_start" || event.kind === "tool_execution_start") {
        expect(event.invocation?.runId, `${event.kind} without a run that owns it`).toMatch(/^run_/);
        expect([oldRunId, successor.runId]).toContain(event.invocation!.runId);
      }
    }
    // The old invocation went on after its end was declared (the blocked
    // command); the harness said so instead of hiding it.
    expect(lifecycleLogs().some((log) => log.level === "warn" && log.line.includes(`executing-after-declared-end runId=${oldRunId}`))).toBe(true);

    // 8. Late callbacks stamped with the old invocation, after the successor
    //    owned and finished: nothing about the successor moves.
    const oldRef = driverEvents.find((event) => event.kind === "agent_start" && event.invocation?.runId === oldRunId)!.invocation!;
    const before = JSON.stringify(server.agents().run(successor.runId));
    const eventsBefore = parentEvents.length;
    const runsBefore = server.agents().runs().length;
    server.agents().onDriverEvent(childPath, { type: "update", update: { kind: "agent_settled" }, invocation: oldRef });
    server.agents().onDriverEvent(childPath, { type: "update", update: { kind: "message_end", role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "late words" }] }, stopReason: "error", errorMessage: "late error" }, invocation: oldRef });
    server.agents().onDriverEvent(childPath, { type: "update", update: { kind: "extension_error", extension: "late", message: "late extension error" }, invocation: oldRef });
    server.agents().onDriverEvent(childPath, { type: "update", update: { kind: "tool_execution_start", toolCallId: "late-tool", toolName: "bash", args: {} }, invocation: oldRef });
    expect(JSON.stringify(server.agents().run(successor.runId))).toBe(before);
    expect(server.agents().run(successor.runId)).not.toHaveProperty("question");
    expect(parentEvents).toHaveLength(eventsBefore);
    expect(server.agents().runs()).toHaveLength(runsBefore);
    expect(lifecycleLogs().filter((log) => log.line.includes("late-callback-dropped") && log.line.includes(`invocation=${oldRef.id}`)).map((log) => /kind=(\S+)/.exec(log.line)?.[1])).toEqual(["agent_settled", "message_end", "extension_error", "tool_execution_start"]);

    // 9. Every diagnostic line of the scenario names identities and counts,
    //    never the task, a message or a result (contract 7).
    expectNoBodiesInModuleLogs(["Start the work.", F1, F2, CORRECTION, INTERRUPT, "old done", "successor done", "late words", "late error", "late extension error"]);
  }, 60_000);

  it("ignores late predecessor callbacks while the successor is still working, not only once it has ended", async () => {
    provider.answer(0, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "old done" } } });
    const heldSuccessor = provider.holdWhen((request) => lastUserText(request) === F1);
    provider.route((request) => (lastUserText(request) === F1 ? { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } } : { text: "ok" }));
    const completions = observeCompletions();
    const releaseFirst = provider.hold(0);
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start.", interrupt: false });
    await provider.arrived(0);
    await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: F1, interrupt: false });
    releaseFirst();
    await completions.first;
    await waitForTerminal(started.runId);
    const successor = server.agents().activeRun(childPath)!;
    expect(successor).toMatchObject({ status: "running", task: F1 });
    await heldSuccessor.arrived;

    // The successor owns the session and is mid-turn. The old epoch speaks late.
    const oldRef = driverEvents.find((event) => event.kind === "agent_start" && event.invocation?.runId === started.runId)!.invocation!;
    const before = JSON.stringify(server.agents().run(successor.runId));
    const eventsBefore = parentEvents.length;
    server.agents().onDriverEvent(childPath, { type: "update", update: { kind: "agent_settled" }, invocation: oldRef });
    server.agents().onDriverEvent(childPath, { type: "update", update: { kind: "extension_error", extension: "late", message: "late extension error" }, invocation: oldRef });
    server.agents().onDriverEvent(childPath, { type: "update", update: { kind: "message_end", role: "assistant", message: { role: "assistant", content: [] }, stopReason: "error", errorMessage: "late error" }, invocation: oldRef });
    expect(JSON.stringify(server.agents().run(successor.runId))).toBe(before);
    expect(server.agents().run(successor.runId)?.status).toBe("running");
    expect(parentEvents).toHaveLength(eventsBefore);
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(2);

    heldSuccessor.release();
    await waitForTerminal(successor.runId);
    expect(completions.results.at(-1)).toEqual({ ok: true, runId: successor.runId });
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" } });
    assertNoOverlappingInvocations();
  }, 60_000);

  it("admits an extension-generated triggerTurn send during terminal-pending only after the fence, under the successor", async () => {
    const WAKE = "background wake: the long command exited";
    provider.answer(0, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "old done" } } });
    provider.route((request) => {
      const last = request.messages.at(-1);
      // A custom message the engine delivers as the successor's turn: Pi
      // renders it as a user-role message carrying the extension's text.
      if (last?.role === "user" && textOfContent(last.content).includes(WAKE)) return { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } };
      return { text: "ok" };
    });
    let admission: Promise<void> | undefined;
    let admitted = false;
    const completions = observeCompletions((_result, ordinal) => {
      if (ordinal !== 1) return;
      // Inside the terminating tool: the session is demonstrably terminal-pending.
      admission = extensionActions.sendMessage({ customType: "test/wake", content: WAKE, display: true }, { deliverAs: "steer", triggerTurn: true }).then(() => { admitted = true; });
    });
    const releaseFirst = provider.hold(0);
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start.", interrupt: false });
    await provider.arrived(0);
    releaseFirst();
    await completions.first;
    expect(admission).toBeDefined();
    expect(admitted).toBe(false);
    const successor = server.agents().runs().find((run) => run.sessionPath === childPath && run.runId !== started.runId);
    // The successor belongs to the parent's work: the run that owned the
    // invocation was the parent's, whatever the driver stamps on the epoch.
    expect(successor).toMatchObject({ status: "queued", origin: "agent" });
    expect(lifecycleLogs().some((log) => log.line.includes("admission source=extension kind=custom decision=queued-successor"))).toBe(true);

    await waitForTerminal(started.runId);
    expect(server.agents().run(started.runId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    await admission;
    expect(admitted).toBe(true);
    expect(server.agents().activeRun(childPath)?.runId).toBe(successor!.runId);
    await waitForTerminal(successor!.runId);
    expect(completions.results).toEqual([{ ok: true, runId: started.runId }, { ok: true, runId: successor!.runId }]);
    // The wake ran once, under the successor, after the old run had ended.
    const wakeRequests = provider.requests.filter((request) => request.messages.some((message) => textOfContent(message.content).includes(WAKE)));
    expect(wakeRequests).toHaveLength(1);
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.completed", started.runId], ["agent.completed", successor!.runId]]);
    assertNoOverlappingInvocations();
  }, 60_000);

  it("carries a goal's automatic continuation across a declared completion to the successor, never under the completed run", async () => {
    // A goal's engine continues the objective from its agent_settled hook
    // with an extension follow-up — inside the old prompt, after the
    // terminating tool: exactly the terminal-pending window.
    const releaseFirst = provider.hold(0);
    provider.answer(0, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "old done" } } });
    const heldContinuation = provider.holdWhen((_request, ) => provider.requests.length >= 2);
    provider.route(() => ({ toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } }));
    const completions = observeCompletions();

    const goalStarted = await call("session/goal/action", { path: childPath, action: { action: "start", objective: "Inspect the project" } });
    expect(goalStarted.error).toBeUndefined();
    const old = server.agents().activeRun(childPath)!;
    expect(old).toMatchObject({ origin: "user", status: "running" });
    await provider.arrived(0);
    releaseFirst();
    await completions.first;
    await waitForTerminal(old.runId);
    expect(server.agents().run(old.runId)).toMatchObject({ status: "completed", result: { message: "old done" } });

    const continuation = await heldContinuation.arrived;
    const successor = server.agents().activeRun(childPath)!;
    expect(successor.runId).not.toBe(old.runId);
    expect(successor.status).toBe("running");
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(2);
    // The continuation is the successor's request, not the old run's second turn.
    expect(provider.requests.indexOf(continuation)).toBe(1);
    expect(lifecycleLogs().some((log) => log.line.includes("admission source=extension kind=user decision=queued-successor"))).toBe(true);
    expect(lifecycleLogs().filter((log) => log.line.includes("successor-reserved"))).toHaveLength(1);

    await call("session/goal/action", { path: childPath, action: { action: "clear" } });
    heldContinuation.release();
    await waitForTerminal(successor.runId);
    expect(completions.results).toEqual([{ ok: true, runId: old.runId }, { ok: true, runId: successor.runId }]);
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" } });
    assertNoOverlappingInvocations();
  }, 60_000);

  it("wakes a background command's exit under the successor and delivers the old completion only once the successor is live", async () => {
    const marker = join(base, "release-background");
    const OUTPUT = "exit-token-9c1d";
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo ${OUTPUT}`;
    provider.answer(0, { toolCall: { name: "bash", args: { command, background: true } } });
    provider.answer(1, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "old done" } } });
    // The third request can only be the successor's: the old run's tool batch
    // terminated and its queue was empty. The successor answers the wake by finishing.
    provider.answer(2, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } });
    const taskFinished = waitForMessage((message) => {
      if (!("method" in message) || message.method !== "pi/extension/message") return false;
      const value = message as { params?: { message?: { type?: string; task?: { status?: string } } } };
      return value.params?.message?.type === "lasercode/task/update" && value.params.message.task?.status === "completed";
    });
    const successorQueued = waitForRun((run) => run.sessionPath === childPath && run.status === "queued");
    const completions = observeCompletions(async (_result, ordinal) => {
      if (ordinal !== 1) return;
      // The command exits while the terminating tool is still executing: its
      // wake arrives during terminal-pending and must wait behind the fence.
      writeFileSync(marker, "go\n");
      await taskFinished;
      await successorQueued;
    });

    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start background work then finish.", interrupt: false });
    await provider.arrived(1);
    const old = server.agents().run(started.runId)!;
    expect(old).toMatchObject({ origin: "agent", status: "running" });
    const successor = await successorQueued;
    expect(successor.task).toContain("Background task");
    await completions.first;
    expect(server.agents().run(old.runId)?.status).toBe("running");
    expect(parentEvents).toEqual([]);

    await waitForTerminal(old.runId);
    expect(server.agents().run(old.runId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    const completed = parentEvents.find((entry) => entry.event.type === "agent.completed" && entry.event.runId === old.runId)!;
    expect(completed.activeRunId).toBe(successor.runId);
    expect(completed.runStatuses[successor.runId]).toBe("running");
    await provider.arrived(2);
    expect(server.agents().activeRun(childPath)?.runId).toBe(successor.runId);
    await waitForTerminal(successor.runId);
    expect(completions.results).toEqual([{ ok: true, runId: old.runId }, { ok: true, runId: successor.runId }]);
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    // The wake — the command's output, delivered as a message that wakes the
    // model — is in the successor's request only: the old run's two requests
    // never carried it as a message, and the old invocation never continued
    // past its declared end. (The command text itself is in the tool call.)
    const wakeMessages = (request: StubRequest) => request.messages.filter((message) => message.role === "user" && textOfContent(message.content).includes(OUTPUT));
    expect(provider.requests.slice(0, 2).flatMap(wakeMessages)).toEqual([]);
    expect(wakeMessages(provider.requests[2]!)).toHaveLength(1);
    expect(driverEvents.filter((event) => event.kind === "agent_start" && event.invocation?.runId === successor.runId)).toHaveLength(1);
    expect(lifecycleLogs().some((log) => log.line.includes("executing-after-declared-end"))).toBe(false);
    assertNoOverlappingInvocations();
  }, 60_000);

  it("stops a completing run's blocked tool on a person's stop, keeps its declared completion, and still runs the queued successor", async () => {
    const marker = join(base, "release-stopped-bash");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo released`;
    const releaseFirst = provider.hold(0);
    provider.answer(0, {
      toolCalls: [
        { name: "complete_agent_run", args: { status: "completed", message: "old done" }, id: "call-complete" },
        { name: "bash", args: { command }, id: "call-bash" },
      ],
    });
    provider.route((request) => (lastUserText(request) === F1 ? { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } } : { text: "ok" }));
    const completions = observeCompletions();
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start.", interrupt: false });
    await provider.arrived(0);
    const queued = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: F1, interrupt: false });
    expect(queued.delivery).toBe("queued");
    releaseFirst();
    await completions.first;
    const successor = server.agents().runs().find((run) => run.sessionPath === childPath && run.runId !== started.runId)!;
    expect(successor.status).toBe("queued");

    const bashAborted = waitForDriverEvent((event) => event.kind === "tool_execution_end" && event.toolCallId === "call-bash");
    const stopped = await call("agents/runs/stop", { runId: started.runId, reason: "enough" });
    expect(stopped.error).toBeUndefined();
    // The stop reached the blocked command; the tool's declared result stood.
    await bashAborted;
    expect(driverEvents.find((event) => event.kind === "tool_execution_end" && event.toolCallId === "call-bash")).toMatchObject({ isError: true, text: expect.stringMatching(/aborted/i) });
    expect(existsSync(marker)).toBe(false);
    expect((stopped.result as { run: AgentRun }).run).toMatchObject({ runId: started.runId, status: "completed", result: { message: "old done" } });
    expect(lifecycleLogs().some((log) => log.line.includes(`stop-after-declared-end runId=${started.runId} initiator=user declared=completed`))).toBe(true);

    await waitForTerminal(successor.runId);
    expect(completions.results).toEqual([{ ok: true, runId: started.runId }, { ok: true, runId: successor.runId }]);
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.completed", started.runId], ["agent.completed", successor.runId]]);
    assertNoOverlappingInvocations();
  }, 60_000);

  it("cancels the waiting successor on a person's stop of it, without touching the completing run", async () => {
    const marker = join(base, "release-bash-after-cancel");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo released`;
    const releaseFirst = provider.hold(0);
    provider.answer(0, {
      toolCalls: [
        { name: "complete_agent_run", args: { status: "completed", message: "old done" }, id: "call-complete" },
        { name: "bash", args: { command }, id: "call-bash" },
      ],
    });
    provider.route(() => ({ text: "nothing more" }));
    const completions = observeCompletions();
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start.", interrupt: false });
    await provider.arrived(0);
    const queued = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: F1, interrupt: false });
    releaseFirst();
    await completions.first;
    const successorId = queued.runId === started.runId ? server.agents().runs().find((run) => run.sessionPath === childPath && run.runId !== started.runId)!.runId : queued.runId;
    expect(server.agents().run(successorId)?.status).toBe("queued");

    const stopped = await call("agents/runs/stop", { runId: successorId, reason: "never mind" });
    expect((stopped.result as { run: AgentRun }).run).toMatchObject({ runId: successorId, status: "cancelled", endedBy: { initiator: "user", reason: "never mind" } });
    expect(server.agents().run(started.runId)?.status).toBe("running");
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.cancelled", successorId]]);

    writeFileSync(marker, "go\n");
    await waitForTerminal(started.runId);
    expect(server.agents().run(started.runId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    expect(server.agents().activeRun(childPath)).toBeUndefined();
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.cancelled", successorId], ["agent.completed", started.runId]]);
    // F1 never reached the engine as a prompt of its own.
    expect(provider.requests.some((request) => lastUserText(request) === F1)).toBe(false);
    assertNoOverlappingInvocations();
  }, 60_000);

  it("keeps the declared completion and fails the waiting successor with a readable error when the session closes during terminal-pending", async () => {
    const marker = join(base, "release-bash-after-close");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo released`;
    const releaseFirst = provider.hold(0);
    provider.answer(0, {
      toolCalls: [
        { name: "complete_agent_run", args: { status: "completed", message: "old done" }, id: "call-complete" },
        { name: "bash", args: { command }, id: "call-bash" },
      ],
    });
    provider.route(() => ({ text: "nothing more" }));
    // A person's queued prompt during terminal-pending waits behind the fence
    // on the successor (a *bare* prompt to a streaming child is refused up
    // front, `promptWithFence`; the UI always queues explicitly then). Sent
    // from inside the terminating tool, so the window is certain.
    let person: Promise<{ result?: unknown; error?: { message: string } }> | undefined;
    const completions = observeCompletions((_result, ordinal) => {
      if (ordinal !== 1) return;
      person = call("session/prompt", { path: childPath, content: [{ type: "text", text: "from the person" }], streamingBehavior: "followUp" });
    });
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start.", interrupt: false });
    await provider.arrived(0);
    await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: F1, interrupt: false });
    releaseFirst();
    await completions.first;
    const successor = server.agents().runs().find((run) => run.sessionPath === childPath && run.runId !== started.runId)!;
    expect(successor.status).toBe("queued");
    expect(person).toBeDefined();
    let personSettled = false;
    void person!.then(() => { personSettled = true; });
    await Promise.resolve();
    expect(personSettled).toBe(false);

    // The session's driver closes underneath a still-executing invocation.
    const settledLate = waitForDriverEvent((event) => event.kind === "agent_settled" && event.invocation?.runId === started.runId);
    server.agents().onDriverEvent(childPath, { type: "closed", reason: "the engine went away" });
    expect(server.agents().run(started.runId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "failed", error: "The agent's session closed before this queued message could start.", task: F1 });
    expect((await person!).error?.message).toMatch(/closed before this queued message could start/);
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId, entry.event.message])).toEqual([
      ["agent.completed", started.runId, "old done"],
      ["agent.failed", successor.runId, "The agent's session closed before this queued message could start."],
    ]);
    expect(server.agents().sessionInfo(childPath)).toBeUndefined();

    // The real invocation ends later; its late fence changes nothing.
    writeFileSync(marker, "go\n");
    await settledLate;
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath).map((run) => [run.runId, run.status])).toEqual([[started.runId, "completed"], [successor.runId, "failed"]]);
    expect(parentEvents).toHaveLength(2);
    expect(completions.results).toEqual([{ ok: true, runId: started.runId }]);
  }, 60_000);

  it("carries a person's steer and follow-up from the child's own chat through the fence: the engine's lanes while it streams, the successor during terminal-pending, never the ended run", async () => {
    const STEER = "Person: prefer the smaller diff.";
    const FOLLOW = "Person: also update the changelog.";
    const LATE = "Person: and say which files changed.";
    const marker = join(base, "release-person-bash");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo released`;
    const releaseFirst = provider.hold(0);
    provider.answer(0, {
      toolCalls: [
        { name: "complete_agent_run", args: { status: "completed", message: "old done" }, id: "call-complete" },
        { name: "bash", args: { command }, id: "call-bash" },
      ],
    });
    provider.route((request) => {
      const last = lastUserText(request);
      if (last === LATE) return { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } };
      return { text: last !== undefined ? `noted: ${last}` : "nothing to add" };
    });
    const text = (value: string) => [{ type: "text", text: value }];

    // The person's follow-up typed during terminal-pending, from inside the
    // terminating tool so the window is certain. Its request stays open until
    // the engine holds the message — under the successor, never the old run.
    let late: ReturnType<typeof call> | undefined;
    let atCompletion: { pendingInEngine: number; queue: { steering: string[]; followUp: string[] } | undefined; childRuns: Array<{ runId: string; status: string; task: string; origin: string }> } | undefined;
    const completions = observeCompletions(async (_result, ordinal) => {
      if (ordinal !== 1) return;
      late = call("pi/session/follow_up", { path: childPath, content: text(LATE) });
      await waitForMessage((message) => "method" in message && message.method === "pi/extension/message" && ((message as { params: { message: { message?: string } } }).params.message.message ?? "").includes("admission source=person decision=queued-successor"));
      atCompletion = {
        pendingInEngine: liveDriver.state().pendingMessageCount,
        queue: queueUpdates().at(-1),
        childRuns: server.agents().runs().filter((run) => run.sessionPath === childPath).map((run) => ({ runId: run.runId, status: run.status, task: run.task, origin: run.origin })),
      };
    });

    // 1. The child streams under the parent's run; the person steers and follows up in its chat.
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start the work.", interrupt: false });
    const oldRunId = started.runId;
    await provider.arrived(0);
    const bothQueued = waitForMessage((message) => {
      if (!("method" in message) || message.method !== "session/update") return false;
      const update = (message as { params: { update: SessionUpdate } }).params.update;
      return update.kind === "queue_update" && update.steering.length === 1 && update.followUp.length === 1;
    });
    // Each request answers once the engine holds the message, while the turn still runs.
    expect((await call("pi/session/steer", { path: childPath, content: text(STEER) })).result).toEqual({});
    expect((await call("pi/session/follow_up", { path: childPath, content: text(FOLLOW) })).result).toEqual({});
    await bothQueued;
    expect(queueUpdates().at(-1)).toEqual({ steering: [STEER], followUp: [FOLLOW] });
    expect(liveDriver.state().pendingMessageCount).toBe(2);
    expect(liveDriver.state().isStreaming).toBe(true);
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(1);
    expect(lifecycleLogs().filter((log) => log.line.includes("admission source=person decision=engine-queue"))).toHaveLength(2);

    // 2. Completion declared while both wait in the engine: both leave it once,
    //    for one successor the person's steer starts; the late follow-up joins
    //    that successor without touching the engine.
    releaseFirst();
    await completions.first;
    expect(atCompletion).toBeDefined();
    expect(atCompletion!.pendingInEngine).toBe(0);
    expect(atCompletion!.queue).toEqual({ steering: [], followUp: [] });
    expect(atCompletion!.childRuns).toHaveLength(2);
    const successor = atCompletion!.childRuns.find((run) => run.runId !== oldRunId)!;
    expect(successor).toMatchObject({ status: "queued", task: STEER, origin: "user" });
    expect(lifecycleLogs().some((log) => /queue-transferred .*reason=complete .*clearedSteering=1 clearedFollowUp=1 local=2 preserved=2/.test(log.line))).toBe(true);
    expect(lifecycleLogs().filter((log) => log.line.includes("successor-reserved"))).toHaveLength(1);
    let lateSettled = false;
    void late!.then(() => { lateSettled = true; });
    await Promise.resolve();
    expect(lateSettled).toBe(false);
    expect(server.agents().run(oldRunId)?.status).toBe("running");

    // 3. The old invocation finishes; the successor runs the three messages in
    //    order, each its own prompt, each once; the late request answers at
    //    the moment the engine took its message.
    writeFileSync(marker, "go\n");
    await waitForTerminal(oldRunId);
    expect(server.agents().run(oldRunId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    const reply = await late!;
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({});
    await waitForTerminal(successor.runId);
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" }, origin: "user" });
    expect(completions.results).toEqual([{ ok: true, runId: oldRunId }, { ok: true, runId: successor.runId }]);
    // Five requests: the task; the old invocation's one call after its mixed
    // batch (a terminating tool beside a plain one keeps the loop going — its
    // last message is the tool result, not anything of the person's); then
    // one per successor message.
    expect(provider.requests.map(lastUserText)).toEqual(["Start the work.", undefined, STEER, FOLLOW, LATE]);
    expect(provider.requests[1]!.messages.at(-1)?.role).toBe("tool");
    for (const request of provider.requests.slice(0, 2)) for (const value of [STEER, FOLLOW, LATE]) expect(userOccurrences(request, value), `${value} under the old run`).toBe(0);
    const history = provider.requests.at(-1)!;
    for (const value of [STEER, FOLLOW, LATE]) expect(userOccurrences(history, value), value).toBe(1);
    expect(userOccurrences(history, NUDGE_TEXT)).toBe(0);
    // The late follow-up never sat in the engine's queue: it was the successor's own prompt.
    expect(queueUpdates().some((update) => update.steering.includes(LATE) || update.followUp.includes(LATE))).toBe(false);
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.completed", oldRunId], ["agent.completed", successor.runId]]);
    assertNoOverlappingInvocations();
    for (const event of driverEvents) {
      if (event.kind === "agent_start" || event.kind === "tool_execution_start") expect([oldRunId, successor.runId]).toContain(event.invocation?.runId);
    }
    expectNoBodiesInModuleLogs(["Start the work.", STEER, FOLLOW, LATE, "old done", "successor done"]);
  }, 60_000);

  it("fences a dialog raised by an invocation the session no longer owns: not the successor's question, cancelled rather than left hanging", async () => {
    provider.answer(0, {
      toolCalls: [
        { name: "complete_agent_run", args: { status: "completed", message: "old done" }, id: "call-complete" },
        { name: "ask_later", args: {}, id: "call-ask-later" },
      ],
    });
    const heldSuccessor = provider.holdWhen((request) => lastUserText(request) === F1);
    provider.route((request) => (lastUserText(request) === F1 ? { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } } : { text: "ok" }));
    const completions = observeCompletions();
    const releaseFirst = provider.hold(0);
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start.", interrupt: false });
    await provider.arrived(0);
    await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: F1, interrupt: false });
    releaseFirst();
    await completions.first;
    await waitForTerminal(started.runId);
    const successor = server.agents().activeRun(childPath)!;
    expect(successor).toMatchObject({ status: "running", task: F1 });
    await heldSuccessor.arrived;
    expect(detached, "ask_later ran inside the old invocation").toBeDefined();
    const oldRef = driverEvents.find((event) => event.kind === "agent_start" && event.invocation?.runId === started.runId)!.invocation!;

    // The successor owns the session and is mid-turn. The old invocation's
    // continuation asks its question now.
    const eventsBefore = parentEvents.length;
    const raised = waitForDriverEvent((event) => event.kind === "ui_request");
    detached!.release();
    await raised;
    const request = driverEvents.find((event) => event.kind === "ui_request")!;
    // Stamped with the old epoch — the old run — by the driver.
    expect(request.invocation).toEqual(oldRef);
    expect(request.method).toBe("select");
    // Cancelled, not hung: the asker gets its fallback, and nothing is left open.
    expect(await detached!.answer).toBeUndefined();
    expect(liveDriver.pendingUi()).toEqual([]);
    // Nothing of it reached the successor or its parent.
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "running" });
    expect(server.agents().run(successor.runId)).not.toHaveProperty("question");
    expect(server.agents().sessionInfo(childPath)).toMatchObject({ runId: successor.runId, runStatus: "running" });
    expect(parentEvents).toHaveLength(eventsBefore);
    expect(parentEvents.some((entry) => entry.event.type === "agent.needs_input")).toBe(false);
    expect(lifecycleLogs().some((log) => log.line.includes(`late-callback-dropped kind=ui_request:select invocation=${oldRef.id} invocationRun=${started.runId} owner=${successor.runId}`) && log.line.includes(`dialog=${request.dialogId}`))).toBe(true);
    expect((await call("pi/ui/response", { id: request.dialogId, value: "a" })).result).toEqual({ delivered: false });

    heldSuccessor.release();
    await waitForTerminal(successor.runId);
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" } });
    expect(completions.results).toEqual([{ ok: true, runId: started.runId }, { ok: true, runId: successor.runId }]);
    assertNoOverlappingInvocations();
    expectNoBodiesInModuleLogs(["Start.", F1, "old done", "successor done", "Later?"]);
  }, 60_000);

  it("attributes a dialog and its resolution to the epoch that raised it, so the owning run asks and is answered by the same stamp", async () => {
    provider.answer(0, { toolCall: { name: "ask_now", args: {}, id: "call-ask-now" } });
    provider.route(() => ({ text: "ok" }));
    const asked = waitForRun((run) => run.sessionPath === childPath && run.status === "needs_input");
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Ask.", interrupt: false });
    const paused = await asked;
    expect(paused).toMatchObject({ runId: started.runId, question: { kind: "select", title: "Now?", options: ["x", "y"], toolName: "ask_now", toolCallId: "call-ask-now" } });
    const request = driverEvents.find((event) => event.kind === "ui_request")!;
    const owning = driverEvents.find((event) => event.kind === "agent_start" && event.invocation?.runId === started.runId)!.invocation!;
    expect(request.invocation).toEqual(owning);
    expect(parentEvents.map((entry) => entry.event.type)).toEqual(["agent.needs_input"]);

    // The person stops the run: the abort reaches the dialog through the
    // tool's signal, and its resolution carries the stamp its request took.
    const resolved = waitForDriverEvent((event) => event.kind === "ui_event" && event.method === "dialogResolved");
    const stopped = await call("agents/runs/stop", { runId: started.runId, reason: "never mind" });
    expect(stopped.error).toBeUndefined();
    await resolved;
    const resolution = driverEvents.find((event) => event.kind === "ui_event" && event.method === "dialogResolved")!;
    expect(resolution).toMatchObject({ dialogId: request.dialogId, invocation: owning });
    await waitForTerminal(started.runId);
    expect(server.agents().run(started.runId)).toMatchObject({ status: "cancelled", endedBy: { initiator: "user", reason: "never mind" } });
    expect(server.agents().run(started.runId)).not.toHaveProperty("question");
    expect(liveDriver.pendingUi()).toEqual([]);
    expect(lifecycleLogs().some((log) => log.line.includes("late-callback-dropped kind=ui_"))).toBe(false);
    assertNoOverlappingInvocations();
    expectNoBodiesInModuleLogs(["Ask.", "Now?", "never mind"]);
  }, 60_000);

  it("releases a person's admission lease the moment their message is parked, so a tray message behind an extension's wake on the successor cannot wedge the session", async () => {
    // The shipped route to the deadlock the review found (F1): the person
    // writes into a child's chat while it works (the pending tray), the child
    // completes with a blocking tool in the same batch, an extension's wake
    // lands first on the successor, and the tray drains at agent_settled. The
    // drain's prompt took the session's admission lease; parked behind the
    // wake, it must not keep it — the wake's start waits for that lease, and
    // the lease waited for an acceptance only the wake's turn could bring.
    const WAKE = "wake: the long command exited";
    const TRAY = "Person: written into the tray while it worked.";
    const marker = join(base, "release-tray-bash");
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo released`;
    const releaseFirst = provider.hold(0);
    provider.answer(0, {
      toolCalls: [
        { name: "complete_agent_run", args: { status: "completed", message: "old done" }, id: "call-complete" },
        { name: "bash", args: { command }, id: "call-bash" },
      ],
    });
    provider.route((request) => (lastUserText(request) === TRAY ? { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } } : { text: "ok" }));
    let admission: Promise<void> | undefined;
    let admitted = false;
    const completions = observeCompletions((_result, ordinal) => {
      if (ordinal !== 1) return;
      // Inside the terminating tool: a background wake / grandchild ending
      // shape — a custom trigger nothing waits on — is first on the successor.
      admission = extensionActions.sendMessage({ customType: "test/wake", content: WAKE, display: true }, { deliverAs: "steer", triggerTurn: true }).then(() => { admitted = true; });
    });

    // 1. The child streams under the parent's run; the person writes into
    //    its chat meanwhile. The UI's queue is the tray, delivered at settle.
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start.", interrupt: false });
    const oldRunId = started.runId;
    await provider.arrived(0);
    expect((await call("session/pending/add", { path: childPath, content: [{ type: "text", text: TRAY }] })).error).toBeUndefined();
    releaseFirst();
    await completions.first;
    const successor = server.agents().runs().find((run) => run.sessionPath === childPath && run.runId !== oldRunId)!;
    expect(successor).toMatchObject({ status: "queued", task: WAKE, origin: "agent" });
    expect(lifecycleLogs().some((log) => log.line.includes("admission source=extension kind=custom decision=queued-successor"))).toBe(true);

    // 2. The blocked command ends; at agent_settled the tray drains and the
    //    person's message is parked behind the wake (on the successor, or
    //    locally under it if its activation won the lock first). The lease
    //    that delivery took is released there and then: a request that needs
    //    the same lease answers while the tray row is still on its way.
    const parked = waitForMessage((message) => "method" in message && message.method === "pi/extension/message"
      && new RegExp(`admission source=person decision=(queued-successor|local-queue) runId=${successor.runId}`).test((message as { params: { message: { message?: string } } }).params.message.message ?? ""));
    writeFileSync(marker, "go\n");
    await parked;
    const tray = (await call("session/pending/list", { path: childPath })).result as { messages: Array<{ state: string }> };
    expect(tray.messages.map((message) => message.state)).toEqual(["delivering"]);
    const leaseFree = call("pi/thinking/set", { path: childPath, level: liveDriver.state().thinkingLevel });

    // 3. The old prompt resolves; the successor starts with the wake, the
    //    tray message follows under it, and the lease-bound request answered.
    await waitForTerminal(oldRunId);
    expect(server.agents().run(oldRunId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    await waitForDriverEvent((event) => event.kind === "agent_start" && event.invocation?.runId === successor.runId);
    await admission!;
    expect(admitted).toBe(true);
    expect((await leaseFree).error).toBeUndefined();
    await waitForTerminal(successor.runId);
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" } });
    expect(completions.results).toEqual([{ ok: true, runId: oldRunId }, { ok: true, runId: successor.runId }]);
    // The wake's turn came first under the successor, then the tray message,
    // each exactly once; the old run's requests carried neither.
    const wakeIndex = provider.requests.findIndex((request) => request.messages.some((message) => textOfContent(message.content).includes(WAKE)));
    const trayIndex = provider.requests.findIndex((request) => lastUserText(request) === TRAY);
    expect(wakeIndex).toBeGreaterThan(-1);
    expect(trayIndex).toBeGreaterThan(wakeIndex);
    for (const request of provider.requests.slice(0, wakeIndex)) {
      expect(request.messages.some((message) => textOfContent(message.content).includes(WAKE) || textOfContent(message.content) === TRAY)).toBe(false);
    }
    const history = provider.requests.at(-1)!;
    expect(history.messages.filter((message) => textOfContent(message.content).includes(WAKE))).toHaveLength(1);
    expect(userOccurrences(history, TRAY)).toBe(1);
    expect(userOccurrences(history, NUDGE_TEXT)).toBe(0);
    // The tray is empty — its message was accepted under the successor — and
    // nothing holds the child's admission lease: a person's stop answers.
    expect(((await call("session/pending/list", { path: childPath })).result as { messages: unknown[] }).messages).toEqual([]);
    expect((await call("session/cancel", { path: childPath })).error).toBeUndefined();
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.completed", oldRunId], ["agent.completed", successor.runId]]);
    assertNoOverlappingInvocations();
    expectNoBodiesInModuleLogs(["Start.", WAKE, TRAY, "old done", "successor done"]);
  }, 60_000);

  it("takes back a custom wake the engine queued out of sight of its own queue, so a terminal declaration carries it to the successor instead of dropping it", async () => {
    // F5: a background command started in an earlier turn exits while a later
    // turn streams. Its wake is not causal to that turn, so the harness lets
    // the engine decide, and Pi's `sendCustomMessage` puts it straight into
    // agent-core's steering queue — where the session's own `clearQueue()`
    // cannot see it and its `clearAllQueues()` would drop it. The transfer at
    // completion reads that queue first, says so, and keeps the wake.
    const marker = join(base, "release-bg-wake");
    const OUTPUT = "bg-exit-token-77";
    const command = `while [ ! -f '${marker}' ]; do sleep 0.02; done; echo ${OUTPUT}`;
    // Turn 1 starts the command and stops without the tool → turn 2 is the
    // nudge, held; the command exits meanwhile; turn 2 completes through the tool.
    provider.answer(0, { toolCall: { name: "bash", args: { command, background: true } } });
    provider.answer(1, { text: "started it; done for now" });
    const releaseNudge = provider.hold(2);
    provider.answer(2, { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "old done" } } });
    provider.route((request) => {
      const last = request.messages.at(-1);
      if (last?.role === "user" && textOfContent(last.content).includes(OUTPUT)) return { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "successor done" } } };
      return { text: "ok" };
    });
    const taskFinished = waitForMessage((message) => {
      if (!("method" in message) || message.method !== "pi/extension/message") return false;
      const value = message as { params?: { message?: { type?: string; task?: { status?: string } } } };
      return value.params?.message?.type === "lasercode/task/update" && value.params.message.task?.status === "completed";
    });
    const started = await parentBridge.sendAgentMessage({ sessionId: childSessionId, message: "Start background work.", interrupt: false });
    await provider.arrived(2);
    expect(lastUserText(provider.requests[2]!)).toBe(NUDGE_TEXT);
    // The engine's queue as agent-core holds it: the very thing the session's
    // own `pendingMessageCount` and `queue_update` never show.
    const agent = (liveDriver as unknown as { runtime: { session: { agent: { steeringQueue: { hasItems(): boolean } } } } }).runtime.session.agent;
    expect(agent.steeringQueue.hasItems()).toBe(false);
    expect(liveDriver.state().isStreaming).toBe(true);

    writeFileSync(marker, "go\n");
    await taskFinished;
    await waitForMessage((message) => "method" in message && message.method === "pi/extension/message" && ((message as { params: { message: { message?: string } } }).params.message.message ?? "").includes("admission source=extension kind=custom decision=engine-decides"));
    expect(agent.steeringQueue.hasItems()).toBe(true);
    expect(liveDriver.state().pendingMessageCount).toBe(0);
    expect(queueUpdates().some((update) => update.steering.length > 0)).toBe(false);

    releaseNudge();
    await waitForTerminal(started.runId);
    expect(server.agents().run(started.runId)).toMatchObject({ status: "completed", result: { message: "old done" } });
    // The transfer found what the engine's own queue could not list, said so
    // as a warning (counts only), and kept it as the successor's message.
    const transfer = lifecycleLogs().find((log) => log.line.includes("queue-transferred"))!;
    expect(transfer.line).toMatch(/reason=complete successor=run_[0-9a-f]+ clearedSteering=0 clearedFollowUp=0 local=0 preserved=1 custom=1/);
    expect(lifecycleLogs().some((log) => log.level === "warn" && log.line.includes(`engine-custom-queued runId=${started.runId} reason=complete steering=1 followUp=0`))).toBe(true);
    const successor = server.agents().runs().find((run) => run.sessionPath === childPath && run.runId !== started.runId)!;
    expect(successor).toMatchObject({ origin: "agent" });
    expect(successor.task).toContain("Background task");
    await waitForTerminal(successor.runId);
    expect(server.agents().run(successor.runId)).toMatchObject({ status: "completed", result: { message: "successor done" } });
    expect(agent.steeringQueue.hasItems()).toBe(false);
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(2);
    // The wake reached the model exactly once — as the successor's own
    // request, never under the completed run's two turns.
    expect(provider.requests).toHaveLength(4);
    const wakeRequests = provider.requests.filter((request) => request.messages.some((message) => textOfContent(message.content).includes(OUTPUT)));
    expect(wakeRequests).toHaveLength(1);
    expect(provider.requests.indexOf(wakeRequests[0]!)).toBe(3);
    expect(provider.requests[3]!.messages.filter((message) => textOfContent(message.content).includes(OUTPUT))).toHaveLength(1);
    expect(parentEvents.map((entry) => [entry.event.type, entry.event.runId])).toEqual([["agent.completed", started.runId], ["agent.completed", successor.runId]]);
    assertNoOverlappingInvocations();
    expectNoBodiesInModuleLogs(["Start background work.", OUTPUT, "old done", "successor done"]);
  }, 60_000);
});
