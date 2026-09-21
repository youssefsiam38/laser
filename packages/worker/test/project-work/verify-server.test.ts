/**
 * M21-T19 · the verification Command, through the real worker server.
 *
 * The three lines that only exist in `server.ts` are what this covers, and it
 * covers them through the server's own dispatch rather than around it:
 *
 *   - `pi/project/verify/start` refuses a run no conversation owns, with the
 *     sentence that says which act gets one — never an invisible Command;
 *   - a run that does have one publishes its fleet row as the same
 *     `lasercode/task/update` extension message every Command row travels on
 *     (M21-T13), under the session that owns it;
 *   - `pi/task/stop` with that row's id stops *this* run, and a row id this
 *     worker does not hold answers `delivered: false` rather than silently.
 *
 * The host link is deliberately left unanswered: what is under test is the
 * Command's visibility and its Stop, not what a report says. The run therefore
 * never gets past asking the host what to check, which is exactly what a
 * person would see if the app could not reach its own authority — and the row
 * still says what is going on.
 */
import { describe, expect, it } from "vitest";
import { isVerificationFleetTaskId, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { WorkerServer } from "../../src/server.js";
import type { DriverListener, SessionDriver } from "../../src/driver.js";

const CWD = "/tmp/verify-seam";

/**
 * The smallest driver a session can be opened on. Nothing in this file
 * prompts, so everything past `open`/`state`/`subscribe` is never reached.
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
  } as unknown as SessionDriver;
}

interface RowMessage {
  params: { path: string; message: { type: string; task: { id: string; status: string; activity?: string; terminalReason?: string; outputBytes: number } } };
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
  return { server, out, call, rows };
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

  it("publishes the run's fleet row under its own conversation, and stops it from that row", async () => {
    const h = harness();
    const created = (await h.call(1, "session/new", { cwd: CWD })).result as { state: { path: string } } | undefined;
    const path = (created?.state.path ?? "") as string;
    expect(path, "the harness opened a session to own the run").not.toBe("");

    const started = (await h.call(2, "pi/project/verify/start", { cwd: CWD, key: "TASK-1", sessionPath: path })).result as
      | { run: { runId: string; fleetTaskId: string; sessionPath: string } }
      | undefined;
    expect(started, "the run started").toBeDefined();
    expect(started!.run.sessionPath).toBe(path);
    expect(isVerificationFleetTaskId(started!.run.fleetTaskId)).toBe(true);

    const first = h.rows()[0];
    expect(first, "a row is published the moment the run exists").toBeDefined();
    expect(first!.params.path, "under the conversation that owns it").toBe(path);
    expect(first!.params.message.task.id).toBe(started!.run.fleetTaskId);
    expect(first!.params.message.task.status).toBe("running");
    expect(first!.params.message.task.activity, "the row says what it is doing, in words").toBeTruthy();
    expect(first!.params.message.task.outputBytes, "the row is not a log").toBe(0);

    // Stop from the fleet row: the id is this worker's own, so it is answered
    // here rather than delivered to the companion extension.
    const stopped = (await h.call(3, "pi/task/stop", { path, id: started!.run.fleetTaskId })).result as { delivered: boolean } | undefined;
    expect(stopped?.delivered).toBe(true);
    const last = h.rows().at(-1)!;
    expect(last.params.message.task.status).toBe("stopped");
    expect(last.params.message.task.terminalReason).toBe("you stopped it");

    // A row id nobody here holds is said so, never silently swallowed.
    const unknown = (await h.call(4, "pi/task/stop", { path, id: "verify-ver_9999" })).result as { delivered: boolean } | undefined;
    expect(unknown?.delivered).toBe(false);
  });
});
