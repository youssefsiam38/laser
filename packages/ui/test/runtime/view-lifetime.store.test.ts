/**
 * The store's half of RP-5: a session's identity, questions, tray and last
 * validated revision are light and survive; its transcript is what a release
 * takes, and a dormant view never builds a transcript out of the updates that
 * keep arriving for it.
 */
import { describe, expect, it } from "vitest";
import type { HistoryWindow, SessionState } from "@lasercode/protocol";

import {
  initialState,
  isDormantView,
  reduce,
  viewFirstUserText,
  viewHasHistory,
  viewHasUserMessage,
  type AppState,
} from "../../src/store.js";
import { projectSessionView } from "../../src/runtime/projection.js";
import { captureViewTail } from "../../src/runtime/view-tail.js";
import { measureView } from "../../src/runtime/view-measure.js";

/** A 64×64 PNG header with enough payload to be worth releasing. */
const pngBase64 = ((): string => {
  const be = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be(13), 0x49, 0x48, 0x44, 0x52, ...be(64), ...be(64),
    ...Array.from({ length: 4096 }, (_, index) => index % 251)];
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
})();

const PATH = "/p/a.jsonl";
const AT = "2026-09-15T01:00:00.000Z";

const SESSION_ID = "01a0a319-1f1c-75f3";
const sessionState = (over: Partial<SessionState> = {}): SessionState => ({
  path: PATH, id: SESSION_ID, cwd: "/p", messageCount: 2, pendingMessageCount: 0, isStreaming: false, isCompacting: false, ...over,
} as SessionState);

const window = (over: Partial<HistoryWindow> = {}): HistoryWindow => ({
  epoch: "w1", seq: 7, revision: "r1.env.abc", environmentKey: "e1.key", userOffset: 0,
  complete: true, branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], ...over,
});

const entries = [
  { id: "e1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "count the packages" }] } },
  { id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "there are nine" }] } },
];

function opened(over: Partial<SessionState> = {}): AppState {
  return reduce(initialState, { type: "opened", state: sessionState(over) });
}

function hydrated(over: Partial<SessionState> = {}): AppState {
  let state = opened(over);
  state = reduce(state, { type: "historyBegin", path: PATH, token: "t1" });
  state = reduce(state, { type: "historySnapshot", path: PATH, token: "t1", entries, leafId: "e2", window: window() });
  return state;
}

const evict = (state: AppState): AppState => reduce(state, { type: "views/evict", paths: [PATH], reason: "count", at: AT });

describe("releasing one view's transcript", () => {
  it("keeps identity, questions, tray, title and the revision it was valid at", () => {
    let state = hydrated();
    state = reduce(state, { type: "notification", method: "pi/ui/request", params: { path: PATH, id: "q1", method: "confirm", title: "Run it?" } });
    state = reduce(state, { type: "notification", method: "pi/ui/event", params: { path: PATH, method: "setTitle", title: "Counting" } });
    const before = state.open[PATH]!;
    expect(before.validated).toMatchObject({ revision: "r1.env.abc", sessionId: SESSION_ID, environmentKey: "e1.key", epoch: "w1", seq: 7, hasHistory: true });

    const view = evict(state).open[PATH]!;

    expect(isDormantView(view)).toBe(true);
    expect(view.dormant).toEqual({ at: AT, reason: "count" });
    expect(view.blocks).toEqual([]);
    expect(view.entries).toEqual([]);
    expect(view.history).toBeUndefined();
    expect(view.hydrated).toBe(false);
    // Light state, all of it still here.
    expect(view.path).toBe(PATH);
    expect(view.state).toBe(before.state);
    expect(view.dialogs).toBe(before.dialogs);
    expect(view.pending).toBe(before.pending);
    expect(view.queue).toBe(before.queue);
    expect(view.title).toBe("Counting");
    expect(view.validated).toBe(before.validated);
    expect(view.hydrationEpoch).toBe(1);
  });

  it("keeps the words a row is named by", () => {
    const state = hydrated();
    expect(viewFirstUserText(state.open[PATH])).toBe("count the packages");
    const view = evict(state).open[PATH]!;
    expect(view.summary).toEqual({ firstUser: "count the packages", hasUser: true, blocks: 2 });
    expect(viewFirstUserText(view)).toBe("count the packages");
    expect(viewHasUserMessage(view)).toBe(true);
    expect(viewHasHistory(view)).toBe(true);
  });

  it("refuses to release a transcript holding a prompt the engine has not taken", () => {
    let state = hydrated();
    state = reduce(state, { type: "optimisticUser", path: PATH, text: "and the tests?", images: [], id: "sent" });
    const view = evict(state).open[PATH]!;
    expect(isDormantView(view)).toBe(false);
    expect(view.blocks.some((block) => block.kind === "user" && block.optimistic)).toBe(true);
  });

  it("is idempotent, and leaves a view that holds nothing alone", () => {
    const once = evict(hydrated());
    const twice = evict(once);
    expect(twice).toBe(once);
    const empty = opened();
    expect(evict(empty)).toBe(empty);
  });
});

describe("the identity a released record keeps", () => {
  it("takes the session's own id from its authoritative state, not from its path", () => {
    const view = hydrated().open[PATH]!;
    expect(view.validated?.sessionId).toBe(SESSION_ID);
    expect(view.validated?.sessionId).not.toContain("/");
    const tail = captureViewTail(view, AT);
    expect(tail.sessionId).toBe(SESSION_ID);
    expect(tail.omitted).toBeUndefined();
    // And it survives the release, so a dormant record can still be keyed.
    expect(evict(hydrated()).open[PATH]!.validated?.sessionId).toBe(SESSION_ID);
  });

  it("keeps none, and refuses the record, when the state carries no id", () => {
    let state = reduce(initialState, { type: "opened", state: { ...sessionState(), id: undefined } as SessionState });
    state = reduce(state, { type: "historyBegin", path: PATH, token: "t1" });
    state = reduce(state, { type: "historySnapshot", path: PATH, token: "t1", entries, leafId: "e2", window: window() });
    const view = state.open[PATH]!;
    expect(view.validated?.revision).toBe("r1.env.abc");
    expect(view.validated?.sessionId).toBeUndefined();
    expect(captureViewTail(view, AT).omitted).toBe("no-session-id");
  });
});

describe("what a release actually lets go of", () => {
  it("projects nothing, so the assistant-ui messages built from it are gone", () => {
    const state = hydrated();
    expect(projectSessionView(state.open[PATH]).messages).toHaveLength(2);
    const view = evict(state).open[PATH]!;
    const projection = projectSessionView(view);
    expect(projection.messages).toEqual([]);
    expect(projection.isRunning).toBe(false);
  });

  it("lets go of the images an inactive conversation was holding", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: pngBase64 };
    let state = hydrated();
    state = reduce(state, { type: "optimisticUser", path: PATH, text: "look at this", images: [image], id: "shown" });
    // Not an unsent prompt any more: the engine took it.
    state = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: PATH, seq: 20, at: AT,
      update: { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "look at this" }, image] } } } as never });
    const before = measureView(state.open[PATH]!);
    expect(before.images).toBe(1);
    expect(before.imagesBytes).toBeGreaterThan(64 * 64 * 4);

    const view = evict(state).open[PATH]!;

    expect(measureView(view)).toMatchObject({ images: 0, imagesBytes: 0, bytes: 0 });
    expect(projectSessionView(view).messages).toEqual([]);
  });

  it("lets go of a transcript a find expanded to every page", () => {
    let state = hydrated();
    const older = Array.from({ length: 80 }, (_, index) => ({
      id: `old${index}`, parentId: index === 0 ? null : `old${index - 1}`, type: "message",
      message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `older ${index}` }] },
    }));
    state = reduce(state, { type: "historyBegin", path: PATH, token: "all" });
    state = reduce(state, { type: "historySnapshot", path: PATH, token: "all", entries: [...older, ...entries], leafId: "e2", window: window({ complete: true }) });
    expect(state.open[PATH]!.entries.length).toBe(82);

    const view = evict(state).open[PATH]!;

    expect(view.entries).toEqual([]);
    expect(view.history).toBeUndefined();
    expect(measureView(view).bytes).toBe(0);
  });
});

describe("a dormant view and the updates that keep arriving", () => {
  const update = (state: AppState, seq: number, u: unknown): AppState =>
    reduce(state, { type: "notification", method: "session/update", params: { sessionPath: PATH, seq, at: AT, update: u } as never });

  it("takes what its row says and never appends a transcript", () => {
    let state = evict(hydrated());
    const watermark = state.open[PATH]!.lastSeq;
    state = update(state, watermark + 1, { kind: "message_start", role: "assistant" });
    state = update(state, watermark + 2, { kind: "text_delta", delta: "a lonely token", contentIndex: 0 });
    state = update(state, watermark + 3, { kind: "agent_start" });
    const view = state.open[PATH]!;

    expect(view.blocks).toEqual([]);
    expect(view.running).toBe(true);
    // The watermark stands still: the next open reads the session again.
    expect(view.lastSeq).toBe(watermark);
    expect(isDormantView(view)).toBe(true);
  });

  it("still receives a question, and the question can be answered from light state", () => {
    let state = evict(hydrated());
    state = reduce(state, { type: "notification", method: "pi/ui/request", params: { path: PATH, id: "q2", method: "confirm", title: "Delete it?" } });
    expect(state.open[PATH]!.dialogs.map((d) => d.id)).toEqual(["q2"]);
    state = reduce(state, { type: "dialogAnswered", id: "q2", path: PATH });
    expect(state.open[PATH]!.dialogs).toEqual([]);
  });

  it("wakes when its transcript is read again", () => {
    let state = evict(hydrated());
    state = reduce(state, { type: "historyBegin", path: PATH, token: "t2" });
    expect(isDormantView(state.open[PATH])).toBe(false);
    state = reduce(state, { type: "historySnapshot", path: PATH, token: "t2", entries, leafId: "e2", window: window({ seq: 9, revision: "r1.env.def" }) });
    const view = state.open[PATH]!;
    expect(view.hydrated).toBe(true);
    expect(view.blocks).toHaveLength(2);
    expect(view.validated?.revision).toBe("r1.env.def");
    // The fence does not rewind: a late answer for the released read is refused.
    expect(view.hydrationEpoch).toBe(1);
  });
});
