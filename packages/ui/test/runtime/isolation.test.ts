/**
 * M2-T3: "a delta in one session must not re-render another".
 *
 * The per-thread runtime subscribes with `useSyncExternalStore` over
 * `open[path]`, so React re-renders a thread exactly when that view's identity
 * changes. This pins the reducer property that makes that true — every action
 * must leave untouched views referentially identical.
 */
import { describe, expect, it } from "vitest";
import type { SessionState } from "@piorbit/protocol";
import { reduce, type AppState } from "../../src/store.js";

const sessionState = (path: string): SessionState => ({
  path,
  id: path,
  cwd: "/p/one",
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
});

function twoOpenSessions(): AppState {
  let state = reduce(
    { connection: "open", sessions: [], sessionsLoaded: true, open: {}, current: undefined, workers: {}, toasts: [] },
    { type: "opened", state: sessionState("/s/a.jsonl") },
  );
  state = reduce(state, { type: "opened", state: sessionState("/s/b.jsonl") });
  return state;
}

const update = (state: AppState, sessionPath: string, seq: number) =>
  reduce(state, {
    type: "notification",
    method: "session/update",
    params: { sessionPath, seq, at: "2026-09-05T10:00:00.000Z", update: { kind: "text_delta", delta: "x", contentIndex: 0 } },
  });

describe("session isolation", () => {
  it("keeps other views identical across a transcript delta", () => {
    const before = twoOpenSessions();
    const after = update(before, "/s/a.jsonl", 1);
    expect(after.open["/s/a.jsonl"]).not.toBe(before.open["/s/a.jsonl"]);
    expect(after.open["/s/b.jsonl"]).toBe(before.open["/s/b.jsonl"]);
  });

  it("keeps every view identical across a worker status change", () => {
    const before = twoOpenSessions();
    const after = reduce(before, {
      type: "notification",
      method: "pi/worker/status",
      params: { cwd: "/p/one", status: "crashed", message: "exit 1" },
    });
    expect(after.workers["/p/one"]).toMatchObject({ status: "crashed" });
    expect(after.open["/s/a.jsonl"]).toBe(before.open["/s/a.jsonl"]);
    expect(after.open["/s/b.jsonl"]).toBe(before.open["/s/b.jsonl"]);
  });

  it("ignores a replayed update instead of allocating a new view", () => {
    const first = update(twoOpenSessions(), "/s/a.jsonl", 1);
    const replayed = update(first, "/s/a.jsonl", 1);
    // `updateView` still rebuilds the top-level state object, but no view
    // changes identity, so no thread re-renders.
    expect(replayed.open["/s/a.jsonl"]).toBe(first.open["/s/a.jsonl"]);
    expect(replayed.open["/s/b.jsonl"]).toBe(first.open["/s/b.jsonl"]);
  });

  it("leaves views alone when a dialog is answered elsewhere", () => {
    const before = twoOpenSessions();
    const after = reduce(before, { type: "dialogAnswered", id: "not-here" });
    expect(after.open["/s/a.jsonl"]).toBe(before.open["/s/a.jsonl"]);
    expect(after.open["/s/b.jsonl"]).toBe(before.open["/s/b.jsonl"]);
  });
});
