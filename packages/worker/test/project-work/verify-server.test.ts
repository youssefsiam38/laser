/**
 * M21-T19 · the verification Command, through the real worker server.
 *
 * What only exists in `server.ts` is what this covers, and it covers it
 * through the server's own dispatch rather than around it:
 *
 *   - `pi/project/verify/start` refuses a run no conversation owns, with the
 *     sentence that says which act gets one — never an invisible Command;
 *   - a run that does have one publishes its fleet row as the same
 *     `lasercode/task/update` extension message every Command row travels on
 *     (M21-T13), into **this worker's own task index first** and the host's
 *     after it — so the conversation that owns a running verification is
 *     pinned, cannot be unloaded, cannot be retired out from under it and
 *     cannot have its file moved while it works;
 *   - `pi/task/stop` with that row's id is delivered because this worker
 *     holds it, and a stop does not pretend the run has ended;
 *   - a fork carries the run to the conversation's new address, and nothing
 *     is ever published under the old one again.
 *
 * The host link is answered by hand here, one request at a time. That is the
 * barrier every timing assertion below rests on: no sleeps, no polling, and
 * every assertion is about an exact point in the run's lifetime.
 */
import { describe, expect, it } from "vitest";
import { isVerificationFleetTaskId, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { WorkerServer } from "../../src/server.js";
import type { DriverListener, SessionDriver } from "../../src/driver.js";

const CWD = "/tmp/verify-seam";

/**
 * The smallest driver a session can be opened on. Nothing in this file
 * prompts, so everything past `open`/`state`/`fork`/`dispose` is never
 * reached.
 */
function fakeDriver(): SessionDriver {
  let state: SessionState = {
    path: `${CWD}/s1.jsonl`,
    id: "s1",
    cwd: CWD,
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
  const listeners = new Set<DriverListener>();
  return {
    kind: "stable-sdk",
    async open(options: { sessionPath?: string }) {
      if (options.sessionPath) state = { ...state, path: options.sessionPath };
      return state;
    },
    state: () => state,
    subscribe(listener: DriverListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respondToUi: () => {},
    async commands() {
      return [];
    },
    async prompts() {
      return [];
    },
    /** A conversation with a durable record, so a release is not pinned on that. */
    async prepareRelease() {
      return { ok: true };
    },
    /** A fork: the same conversation, served from a new file. */
    async fork() {
      state = { ...state, path: `${CWD}/s1-forked.jsonl`, id: "s1f" };
      return { state, entryId: "e1", editorText: "" };
    },
    async dispose() {
      for (const listener of listeners) listener({ type: "closed" });
    },
  } as unknown as SessionDriver;
}

interface RowMessage {
  params: {
    path: string;
    message: {
      type: string;
      task: { id: string; sessionPath?: string; status: string; activity?: string; terminalReason?: string; endedAt?: string; outputBytes: number };
    };
  };
}

interface BridgeRequest {
  id: string;
  method: string;
  params: { request: { method: string }; verify?: { action: string } };
}

function harness() {
  const out: JsonRpcMessage[] = [];
  const server = new WorkerServer({
    cwd: CWD,
    createDriver: () => fakeDriver(),
    send: (message) => out.push(message),
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((message) => "id" in message && message.id === id) as { result?: unknown; error?: { code: number; message: string } };
  };
  const rows = (): RowMessage[] =>
    out.filter(
      (message) =>
        "method" in message &&
        !("id" in message) &&
        message.method === "pi/extension/message" &&
        (message.params as RowMessage["params"]).message.type === "lasercode/task/update",
    ) as unknown as RowMessage[];
  /**
   * One turn of the event loop, so everything the last answer released runs
   * before the next assertion. Not a wait: there is no duration here, and no
   * polling for something that might still be coming.
   */
  const turn = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const until = async (what: string, ready: () => boolean): Promise<void> => {
    for (let step = 0; step < 20 && !ready(); step += 1) await turn();
    expect(ready(), what).toBe(true);
  };
  const answered = new Set<string>();
  /** The host requests this worker has sent and nobody has answered yet. */
  const asked = (): BridgeRequest[] =>
    (out.filter(
      (message) => "method" in message && "id" in message && typeof message.id === "string" && message.method === "project/work/bridge",
    ) as unknown as BridgeRequest[]).filter((request) => !answered.has(request.id));
  /** Answer the oldest unanswered host request. The one barrier in this file. */
  const answer = async (result: unknown): Promise<void> => {
    await until("the worker asked the host something", () => asked().length > 0);
    const request = asked()[0]!;
    answered.add(request.id);
    server.hostResponse({ jsonrpc: "2.0", id: request.id, result });
    await turn();
  };
  return { server, out, call, rows, asked, answer, until };
}

/** A plan with no commands: this file is about the Command's lifetime, not shells. */
const PLAN_ANSWER = {
  projectId: "prj_1",
  result: { entity: { entityId: "ent_1" } },
  verifyResult: {
    plan: {
      task: { authority: "task", entityId: "ent_1", kind: "task", key: "TASK-1", revisionId: "rev_1", digest: "a".repeat(64), title: "A task" },
      authorities: [],
      criteria: [],
      commands: [],
      blockers: [],
      truncated: [],
    },
  },
};

const REPORT_ANSWER = {
  projectId: "prj_1",
  result: { link: { type: "evidence", evidence: {} }, seq: 1 },
  verifyResult: { report: { summary: "Nothing to check.", converged: false }, evidenceId: "evd_1" },
};

/** Open a session and start a run in it, stopped at the plan barrier. */
async function startedRun(h: ReturnType<typeof harness>) {
  const created = (await h.call(1, "session/new", { cwd: CWD })).result as { state: { path: string } } | undefined;
  const path = created!.state.path;
  const started = (await h.call(2, "pi/project/verify/start", { cwd: CWD, key: "TASK-1", sessionPath: path })).result as {
    run: { runId: string; fleetTaskId: string; sessionPath: string };
  };
  // The first host request is the project read every run makes before it can
  // ask what the Task has to satisfy.
  await h.answer({ projectId: "prj_1", result: { items: [] } });
  return { path, run: started.run };
}

describe("a verification run, as the worker dispatches it", () => {
  it("refuses a run no conversation owns, and says which act gets one", async () => {
    const h = harness();
    const answer = await h.call(1, "pi/project/verify/start", { cwd: CWD, key: "TASK-1" });
    expect(answer.error, "a run nobody could watch is refused").toBeDefined();
    expect(answer.error!.message).toContain("Start…");
    expect(h.rows(), "and nothing was published for it").toHaveLength(0);
  });

  it("refuses a conversation this worker is not holding", async () => {
    const h = harness();
    const answer = await h.call(1, "pi/project/verify/start", { cwd: CWD, key: "TASK-1", sessionPath: "/somebody/else.jsonl" });
    expect(answer.error).toBeDefined();
    expect(answer.error!.message).toContain("Open it");
    expect(h.rows()).toHaveLength(0);
  });

  it("publishes the run's fleet row under its own conversation, and a stop from that row is delivered without claiming it has ended", async () => {
    const h = harness();
    const { path, run } = await startedRun(h);
    expect(run.sessionPath).toBe(path);
    expect(isVerificationFleetTaskId(run.fleetTaskId)).toBe(true);

    const first = h.rows()[0];
    expect(first, "a row is published the moment the run exists").toBeDefined();
    expect(first!.params.path, "under the conversation that owns it").toBe(path);
    expect(first!.params.message.task.id).toBe(run.fleetTaskId);
    expect(first!.params.message.task.status).toBe("running");
    expect(first!.params.message.task.activity, "the row says what it is doing, in words").toBeTruthy();
    expect(first!.params.message.task.outputBytes, "the row is not a log").toBe(0);

    // Stop from the fleet row: the id is this worker's own, so it is answered
    // here rather than delivered to the companion extension.
    const stopped = (await h.call(3, "pi/task/stop", { path, id: run.fleetTaskId })).result as { delivered: boolean } | undefined;
    expect(stopped?.delivered, "this worker holds that id").toBe(true);

    const afterStop = h.rows().at(-1)!.params.message.task;
    expect(afterStop.status, "the work is still winding up, so the row is still running").toBe("running");
    expect(afterStop.endedAt, "nothing has ended, so nothing says when it did").toBeUndefined();
    expect(afterStop.activity, "and the line says exactly that").toContain("Stopping");
    expect(
      h.rows().some((row) => row.params.message.task.status === "stopped"),
      "no terminal row was published while the report was still owed",
    ).toBe(false);

    // A second stop is still delivered — this worker plainly holds the run —
    // and changes nothing about it.
    const again = (await h.call(4, "pi/task/stop", { path, id: run.fleetTaskId })).result as { delivered: boolean };
    expect(again.delivered).toBe(true);

    // A row id nobody here holds is said so, never silently swallowed.
    const unknown = (await h.call(5, "pi/task/stop", { path, id: "verify-ver_9999" })).result as { delivered: boolean } | undefined;
    expect(unknown?.delivered).toBe(false);

    // The plan answers, the stopped run reports what it proved, and only then
    // is the ending published.
    await h.answer(PLAN_ANSWER);
    await h.answer(REPORT_ANSWER);
    const last = h.rows().at(-1)!.params.message.task;
    expect(last.status).toBe("stopped");
    expect(last.terminalReason).toBe("you stopped it");
    expect(last.endedAt).toBeDefined();
  });

  it("pins the conversation while the run has not settled, and lets it go once it has", async () => {
    const h = harness();
    const { path } = await startedRun(h);

    const safety = (await h.call(3, "pi/worker/safety")).result as { sessions: Array<{ path: string; pins: Array<{ kind: string; detail?: string }> }> };
    const session = safety.sessions.find((entry) => entry.path === path);
    expect(session, "the session is known to the safety predicate").toBeDefined();
    expect(
      session!.pins.map((pin) => pin.kind),
      "the run is a command of this session, in this worker's own index — which is the list `inspect_fleet` reads",
    ).toContain("task");

    const refused = (await h.call(4, "pi/session/unload", { path })).result as { unloaded: boolean; pins: Array<{ kind: string }> };
    expect(refused.unloaded, "a session with a Command still running is not released").toBe(false);
    expect(refused.pins.map((pin) => pin.kind)).toContain("task");

    const retire = (await h.call(5, "pi/worker/retire", { mode: "explicit" })).result as { retiring: boolean; reason?: string };
    expect(retire.retiring, "nor is the worker retired out from under it").toBe(false);
    expect(retire.reason).toBe("pinned");

    await h.answer(PLAN_ANSWER);
    await h.answer(REPORT_ANSWER);

    const settled = (await h.call(6, "pi/worker/safety")).result as { sessions: Array<{ path: string; pins: Array<{ kind: string }> }> };
    expect(
      settled.sessions.find((entry) => entry.path === path)!.pins.map((pin) => pin.kind),
      "the ending was published, so the pin is gone",
    ).not.toContain("task");
    const unloaded = (await h.call(7, "pi/session/unload", { path })).result as { unloaded: boolean; pins: Array<{ kind: string; detail?: string }> };
    expect(unloaded.pins, "nothing is holding it any more").toEqual([]);
    expect(unloaded.unloaded).toBe(true);
  });

  it("refuses to close a conversation whose run has not settled, and closes it once it has", async () => {
    const h = harness();
    const { path } = await startedRun(h);

    const refused = await h.call(3, "pi/session/close", { path });
    expect(refused.error, "a file move under a live command is refused, not silently done").toBeDefined();
    expect(refused.error!.message).toContain("Stop it and wait");

    await h.answer(PLAN_ANSWER);
    await h.answer(REPORT_ANSWER);

    const closed = (await h.call(4, "pi/session/close", { path })).result as { closed: boolean };
    expect(closed.closed, "once the run has settled, the ordinary close and move works").toBe(true);
  });

  it("carries a running run to the conversation's new address on a fork, and never publishes under the old one again", async () => {
    const h = harness();
    const { path, run } = await startedRun(h);
    const before = h.rows().length;

    const forked = (await h.call(3, "pi/session/fork", { path, entryId: "e1" })).result as { state: { path: string } };
    const moved = forked.state.path;
    expect(moved).not.toBe(path);

    const afterFork = h.rows().slice(before);
    expect(afterFork.length, "the moved conversation is told about the Command it owns").toBeGreaterThan(0);
    for (const row of afterFork) {
      expect(row.params.path, "no row names the path nobody serves any more").toBe(moved);
      expect(row.params.message.task.sessionPath).toBe(moved);
    }

    const state = (await h.call(4, "pi/project/verify/state", { cwd: CWD, runId: run.runId })).result as {
      runs: Array<{ runId: string; sessionPath: string }>;
    };
    expect(state.runs[0]!.sessionPath, "and the run says where it lives now").toBe(moved);

    // It settles at its new address, and the old one is never named again.
    await h.answer(PLAN_ANSWER);
    await h.answer(REPORT_ANSWER);
    expect(h.rows().slice(before).every((row) => row.params.path === moved)).toBe(true);
    expect(h.rows().at(-1)!.params.message.task.status).toBe("completed");
  });
});
