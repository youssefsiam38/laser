/**
 * Extension admission at the real boundary: a real `StableSdkDriver` inside a
 * real `WorkerServer` on the pinned engine, fed by a barrier provider. The
 * refusal proven here is the engine's own — a bare extension send while a turn
 * is streaming — so what it shows is the whole chain: the engine refuses before
 * acceptance, the harness releases what it held, the server's admission lease
 * is free for the next caller, and the engine's rejection diagnostic arrives
 * with the attribution the driver specifies (none for a top-level send, the
 * causal invocation for a nested one) without touching the run it did not own.
 *
 * The engine never reports a false preflight and then resolves, so that exact
 * path cannot be provoked here; the helper-level fakes pin it.
 */
import { createServer, type Server } from "node:http";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentRun, type JsonRpcMessage } from "@lasercode/protocol";
import { fallbackSnapshot } from "../src/agents/definitions.js";
import type { DriverEvent } from "../src/driver.js";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import { WorkerServer } from "../src/server.js";
import { writeStubModels, type StubAnswer, type StubRequest } from "./agents/stub-provider.js";

const TERMINAL = new Set(["completed", "blocked", "failed", "cancelled"]);
const REFUSAL = /already processing/i;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

interface BarrierProvider {
  url: string;
  requests: StubRequest[];
  hold(index: number): () => void;
  answer(index: number, answer: StubAnswer): void;
  arrived(index: number): Promise<void>;
  close(): Promise<void>;
}

function startBarrierProvider(): Promise<BarrierProvider> {
  const requests: StubRequest[] = [];
  const gates = new Map<number, ReturnType<typeof deferred>>();
  const answers = new Map<number, StubAnswer>();
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
  const server: Server = createServer((req, res) => {
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
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: `admission-${index}`, object: "chat.completion.chunk", created: 1, model: "stub-1" };
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
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        hold: (index) => {
          const gate = deferred();
          gates.set(index, gate);
          return gate.resolve;
        },
        answer: (index, answer) => answers.set(index, answer),
        arrived,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

type Reply = { result?: unknown; error?: { message: string } };

interface World {
  provider: BarrierProvider;
  server: WorkerServer;
  childPath: string;
  actions: { sendUserMessage(content: string): Promise<void> };
  call(method: string, params?: unknown): Promise<Reply>;
  waitForRun(predicate: (run: AgentRun) => boolean): Promise<AgentRun>;
  waitForTerminal(runId: string): Promise<void>;
  waitForMessage(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage>;
  waitForDriverEvent(predicate: (event: DriverEvent) => boolean): Promise<DriverEvent>;
  /** The next `turn_start` makes one bare `sendUserMessage` from inside the turn and reports how it ended. */
  armNestedSend(text: string): Promise<string>;
  dispose(): Promise<void>;
}

function completeRun(message: string): StubAnswer {
  return { toolCall: { name: "complete_agent_run", args: { status: "completed", message } } };
}

function isRefusalDiagnostic(event: DriverEvent): boolean {
  return event.type === "update" && event.update.kind === "extension_error" && REFUSAL.test(event.update.message);
}

async function createWorld(): Promise<World> {
  const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-extension-admission-`));
  for (const path of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, path), { recursive: true });
  const provider = await startBarrierProvider();
  writeStubModels(join(base, "agent"), provider.url);

  const out: JsonRpcMessage[] = [];
  const driverEvents: DriverEvent[] = [];
  const messageObservers = new Set<(message: JsonRpcMessage) => void>();
  const runObservers = new Set<(run: AgentRun) => void>();
  const driverObservers = new Set<(event: DriverEvent) => void>();
  const runWaiters = new Map<string, Array<() => void>>();
  let nextId = 1;
  let actions: World["actions"] | undefined;
  let nested: { text: string; resolve(outcome: string): void } | undefined;

  const capture: InlineExtension = (pi) => {
    actions = { sendUserMessage: pi.sendUserMessage.bind(pi) };
    pi.on("turn_start", async () => {
      const armed = nested;
      if (!armed) return;
      nested = undefined;
      try {
        await pi.sendUserMessage(armed.text);
        armed.resolve("accepted");
      } catch (error) {
        armed.resolve(error instanceof Error ? error.message : String(error));
      }
    });
  };

  const server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => {
      const driver = new StableSdkDriver([capture]);
      driver.subscribe((event) => {
        driverEvents.push(event);
        for (const observe of [...driverObservers]) observe(event);
      });
      return driver;
    },
    send: (message) => {
      out.push(message);
      for (const observe of [...messageObservers]) observe(message);
      if (!("method" in message) || message.method !== "agents/run") return;
      const run = (message as { params: { run: AgentRun } }).params.run;
      for (const observe of [...runObservers]) observe(run);
      if (!TERMINAL.has(run.status)) return;
      for (const resolve of runWaiters.get(run.runId) ?? []) resolve();
      runWaiters.delete(run.runId);
    },
    features: ["goals", "subagents"],
    projectTrusted: true,
  });

  const call: World["call"] = async (method, params) => {
    const id = nextId++;
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((message) => "id" in message && message.id === id) as Reply;
  };

  // Seed a saved child session, then load it through the server so the harness owns it.
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
    subagentName: "admission-worker",
    parentPath: join(base, "parent.jsonl"),
    parentSessionId: "parent",
    rootPath: join(base, "parent.jsonl"),
    runId: "run_seed",
  });
  await preparer.setModel({ provider: "stub", id: "stub-1" });
  await preparer.prompt([{ type: "text", text: "Seed the saved child session." }]);
  const childPath = preparer.state().path || state.path;
  await preparer.dispose();
  provider.requests.splice(0);

  const snapshot = fallbackSnapshot();
  const worker = {
    ...snapshot.agents[0]!,
    name: "worker",
    engineInstructions: false,
    instructions: "Work on the task and finish only when asked.",
    model: { provider: "stub", id: "stub-1" },
    supportsSubagents: false,
    allowedAgents: [],
  };
  await call("agents/sync", { snapshot: { ...snapshot, revision: 1, agents: [worker, ...snapshot.agents.slice(1)], defaultAgent: "worker" } });
  const loaded = await call("session/load", { path: childPath });
  expect(loaded.error).toBeUndefined();
  expect(actions).toBeDefined();

  return {
    provider,
    server,
    childPath,
    actions: actions!,
    call,
    waitForRun: (predicate) => {
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
    },
    waitForTerminal: (runId) => {
      if (TERMINAL.has(server.agents().run(runId)?.status ?? "")) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = runWaiters.get(runId) ?? [];
        waiters.push(resolve);
        runWaiters.set(runId, waiters);
      });
    },
    waitForMessage: (predicate) => {
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
    },
    waitForDriverEvent: (predicate) => {
      const existing = driverEvents.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<DriverEvent>((resolve) => {
        const observer = (event: DriverEvent) => {
          if (!predicate(event)) return;
          driverObservers.delete(observer);
          resolve(event);
        };
        driverObservers.add(observer);
      });
    },
    armNestedSend: (text) => new Promise<string>((resolve) => {
      nested = { text, resolve };
    }),
    dispose: async () => {
      await server.dispose();
      await provider.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

let world: World;

beforeEach(async () => {
  world = await createWorld();
});

afterEach(async () => {
  await world.dispose();
});

describe("extension admission refused by the real engine before acceptance", () => {
  it("releases a bare concurrent send the engine refuses, keeps the diagnostic unowned and the owned run untouched", async () => {
    const { provider, server, childPath, actions, call, waitForRun, waitForTerminal, waitForMessage, waitForDriverEvent } = world;
    const release = provider.hold(0);
    provider.answer(0, completeRun("owned run done"));
    const prompted = call("session/prompt", { path: childPath, content: [{ type: "text", text: "Hold the model." }] });
    await provider.arrived(0);
    const owned = server.agents().activeRun(childPath)!;
    expect(owned).toMatchObject({ origin: "user", status: "running" });

    // The engine refuses the bare concurrent send before any acceptance.
    const diagnostic = waitForDriverEvent(isRefusalDiagnostic);
    await expect(actions.sendUserMessage("bare concurrent send")).rejects.toThrow(REFUSAL);

    // Its diagnostic is a real extension_error, pushed without an invocation stamp…
    const event = await diagnostic;
    expect(Object.keys(event).sort()).toEqual(["type", "update"]);
    expect(event).toMatchObject({ type: "update", update: { kind: "extension_error", extension: "<runtime>", message: expect.stringMatching(REFUSAL) } });
    // …and it still reaches the client.
    await waitForMessage((message) => "method" in message
      && message.method === "session/update"
      && (message as { params?: { update?: { kind?: string; message?: string } } }).params?.update?.kind === "extension_error"
      && REFUSAL.test((message as { params: { update: { message: string } } }).params.update.message));

    // The run that owns the session is untouched: same owner, still running, no phantom run for the refusal.
    expect(server.agents().activeRun(childPath)?.runId).toBe(owned.runId);
    expect(server.agents().run(owned.runId)?.status).toBe("running");
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(1);

    const terminal = waitForTerminal(owned.runId);
    release();
    expect((await prompted).result).toEqual({ accepted: true, queued: false });
    await terminal;
    expect(server.agents().run(owned.runId)).toMatchObject({ status: "completed", result: { message: "owned run done" } });
    expect(server.agents().activeRun(childPath)).toBeUndefined();

    // Ownership and the admission lease are free: a later legitimate extension send is admitted and completes…
    provider.answer(1, completeRun("later send done"));
    const started = waitForRun((run) => run.sessionPath === childPath && run.task === "after the refusal");
    await expect(actions.sendUserMessage("after the refusal")).resolves.toBeUndefined();
    const later = await started;
    await waitForTerminal(later.runId);
    expect(server.agents().run(later.runId)).toMatchObject({ origin: "agent", status: "completed", result: { message: "later send done" } });
    expect(server.agents().activeRun(childPath)).toBeUndefined();

    // …and so is a later session/prompt through the server's own lease.
    provider.answer(2, completeRun("later prompt done"));
    const reply = await call("session/prompt", { path: childPath, content: [{ type: "text", text: "After everything." }] });
    expect(reply.result).toEqual({ accepted: true, queued: false });
    expect(provider.requests).toHaveLength(3);
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(3);
  }, 30_000);

  it("attributes a bare send refused inside a running turn to the invocation it was sent from", async () => {
    const { provider, server, childPath, call, waitForRun, waitForTerminal, waitForDriverEvent, armNestedSend } = world;
    provider.answer(0, { text: "the turn's answer" });
    const nested = armNestedSend("nested bare send");
    const turnStarted = waitForDriverEvent((event) => event.type === "update" && event.update.kind === "turn_start");
    const diagnostic = waitForDriverEvent(isRefusalDiagnostic);
    const prompted = call("session/prompt", { path: childPath, content: [{ type: "text", text: "Start a turn." }] });
    const owned = await waitForRun((run) => run.sessionPath === childPath && run.origin === "user");

    // The turn's own events carry the user prompt's invocation…
    const turn = await turnStarted;
    expect(turn).toMatchObject({ invocation: { id: expect.any(String), runId: owned.runId } });
    // …and the nested send, refused before acceptance, is diagnosed with exactly that invocation:
    // the async context it was sent from, not one derived from its error text.
    expect(await nested).toMatch(REFUSAL);
    const event = await diagnostic;
    expect(event.type === "update" ? event.invocation : undefined).toEqual(turn.type === "update" ? turn.invocation : undefined);

    expect((await prompted).error).toBeUndefined();
    await waitForTerminal(owned.runId);
    expect(server.agents().run(owned.runId)).toMatchObject({ status: "failed", error: expect.stringMatching(REFUSAL) });
    expect(server.agents().runs().filter((run) => run.sessionPath === childPath)).toHaveLength(1);
  }, 30_000);
});
