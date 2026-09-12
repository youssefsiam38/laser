/**
 * Regressions for the resume / optimistic-state defects found in review:
 * a worker's `seq` epoch reset, a hydrate that raced live updates, and the
 * optimistic user block's reconciliation and rollback.
 */
import { describe, expect, it } from "vitest";
import type { SessionState, SessionUpdate } from "@lasercode/protocol";
import { initialState, reduce, type Action, type AppState, type SessionView } from "../../src/store.js";

const sessionState: SessionState = {
  path: "/s.jsonl",
  id: "s",
  cwd: "/p",
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

const view = (over: Partial<SessionView> = {}): SessionView => ({
  path: "/s.jsonl",
  state: sessionState,
  blocks: [],
  lastSeq: 0,
  running: false,
  queue: { steering: [], followUp: [] },
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-05T00:00:00.000Z",
  hydrated: true,
  entries: [],
  ...over,
});

const withView = (over: Partial<SessionView> = {}): AppState => ({
  ...initialState,
  open: { "/s.jsonl": view(over) },
  current: "/s.jsonl",
});

const update = (seq: number, u: SessionUpdate): Action => ({
  type: "notification",
  method: "session/update",
  params: { sessionPath: "/s.jsonl", seq, at: "2026-09-05T00:00:00.000Z", update: u },
});

const run = (state: AppState, actions: Action[]): SessionView =>
  actions.reduce(reduce, state).open["/s.jsonl"]!;

// ---------------------------------------------------------------------------

describe("seq epoch", () => {
  const restarted: Action[] = [
    update(1, { kind: "message_start", role: "assistant" }),
    update(2, { kind: "text_delta", delta: "back", contentIndex: 0 }),
    update(3, { kind: "agent_end" }),
  ];

  it("freezes the session when a respawned worker restarts at 1 and we do not resync", () => {
    const v = run(withView({ lastSeq: 87 }), restarted);
    expect(v.blocks).toHaveLength(0);
    expect(v.lastSeq).toBe(87);
  });

  it("adopts the worker's epoch on resync and applies its updates again", () => {
    const v = run(withView({ lastSeq: 87 }), [{ type: "resync", path: "/s.jsonl", lastSeq: 0 }, ...restarted]);
    expect(v.blocks.map((b) => b.kind)).toEqual(["assistant"]);
    expect(v.blocks[0]).toMatchObject({ text: "back" });
    expect(v.lastSeq).toBe(3);
  });

  it("marks the view unhydrated so the transcript is reloaded from the snapshot", () => {
    const v = run(withView({ lastSeq: 87, hydrated: true }), [{ type: "resync", path: "/s.jsonl", lastSeq: 0 }]);
    expect(v.hydrated).toBe(false);
  });

  it("never raises lastSeq (a stale resume result must not skip live updates)", () => {
    const v = run(withView({ lastSeq: 4 }), [{ type: "resync", path: "/s.jsonl", lastSeq: 9 }]);
    expect(v.lastSeq).toBe(4);
    expect(v.hydrated).toBe(true);
  });
});

describe("hydrate", () => {
  const live: Action[] = [
    update(1, { kind: "message_start", role: "assistant" }),
    update(2, { kind: "text_delta", delta: "hi", contentIndex: 0 }),
    update(3, { kind: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} }),
  ];

  it("keeps blocks that arrived while the entries snapshot was in flight", () => {
    const before = run(withView({ hydrated: false }), live);
    expect(before.blocks.map((b) => b.kind)).toEqual(["assistant", "tool"]);

    // The snapshot was requested at seq 0; three updates landed since.
    const after = reduce({ ...initialState, open: { "/s.jsonl": before } }, {
      type: "hydrate",
      path: "/s.jsonl",
      entries: [],
      expectSeq: 0,
    }).open["/s.jsonl"]!;

    expect(after.blocks.map((b) => b.kind)).toEqual(["assistant", "tool"]);
    expect(after.hydrated).toBe(true);
    expect(after.entries).toEqual([]);

    // …and the tool row still resolves, instead of being lost for good.
    const settled = reduce({ ...initialState, open: { "/s.jsonl": after } }, update(4, {
      kind: "tool_execution_end",
      toolCallId: "t1",
      result: "ok",
      isError: false,
    })).open["/s.jsonl"]!;
    expect(settled.blocks[1]).toMatchObject({ kind: "tool", done: true, result: "ok" });
  });

  it("replaces blocks when nothing raced the snapshot", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "persisted" }] } },
    ];
    const v = run(withView({ hydrated: false }), [{ type: "hydrate", path: "/s.jsonl", entries, expectSeq: 0 }]);
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0]).toMatchObject({ kind: "user", files: [], text: "persisted" });
  });
});

describe("optimistic user block", () => {
  it("reconciles the real message even when deltas landed in between", () => {
    const v = run(withView({ running: true }), [
      { type: "optimisticUser", path: "/s.jsonl", id: "o1", text: "stop", images: [] },
      update(1, { kind: "text_delta", delta: "still going", contentIndex: 0 }),
      update(2, { kind: "message_start", role: "user" }),
      update(3, { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "stop" }] } }),
    ]);
    expect(v.blocks.filter((b) => b.kind === "user")).toHaveLength(1);
    expect(v.blocks[0]).toMatchObject({ kind: "user", files: [], id: "o1", text: "stop", optimistic: false });
  });

  it("rolls the block back when the prompt never reached the worker", () => {
    const v = run(withView(), [
      { type: "optimisticUser", path: "/s.jsonl", id: "o1", text: "hi", images: [] },
      { type: "optimisticFailed", path: "/s.jsonl", id: "o1" },
    ]);
    expect(v.blocks).toHaveLength(0);
  });

  it("leaves a settled user block alone when a later prompt fails", () => {
    const v = run(withView(), [
      { type: "optimisticUser", path: "/s.jsonl", id: "o1", text: "first", images: [] },
      update(1, { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "first" }] } }),
      { type: "optimisticUser", path: "/s.jsonl", id: "o2", text: "second", images: [] },
      { type: "optimisticFailed", path: "/s.jsonl", id: "o2" },
    ]);
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0]).toMatchObject({ id: "o1", text: "first", optimistic: false });
  });
});

describe("dialogAnswered", () => {
  const request = (path: string, id: string): Action => ({
    type: "notification",
    method: "pi/ui/request",
    params: { path, method: "confirm", id, title: "Sure?" },
  });

  it("only clears the session that owns the id", () => {
    const other: SessionView = { ...view(), path: "/other.jsonl" };
    let s: AppState = { ...initialState, open: { "/s.jsonl": view(), "/other.jsonl": other } };
    s = reduce(s, request("/s.jsonl", "ui-1"));
    s = reduce(s, request("/other.jsonl", "ui-1"));
    s = reduce(s, { type: "dialogAnswered", id: "ui-1", path: "/s.jsonl" });
    expect(s.open["/s.jsonl"]!.dialogs).toHaveLength(0);
    expect(s.open["/other.jsonl"]!.dialogs).toHaveLength(1);
  });
});
