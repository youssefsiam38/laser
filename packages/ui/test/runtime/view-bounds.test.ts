/**
 * RP-5b acceptance A1–A5, A12: the bound is a bound.
 *
 * Every hydrated view — current, running, streaming, holding a draft — settles
 * at or under the per-view byte bound, and every view together at or under the
 * total, with a workload built from the same shapes that put the renderer at
 * 2.5 GiB before this: a multi-megabyte reply, a multi-megabyte reasoning
 * trace, a twelve-megabyte tool result, two hundred partial updates and twelve
 * full-size images. No test here accepts an overflow value as a substitute.
 */
import { describe, expect, it } from "vitest";
import type { SessionState } from "@lasercode/protocol";

import { createStateStore } from "../../src/runtime/LaserProvider.js";
import { createViewCache, VIEW_CACHE_LIMITS, type ViewCacheEnvironment } from "../../src/runtime/view-cache.js";
import { initialState, isDormantView, reduce, type AppState, type Block } from "../../src/store.js";
import { BODY_EXCERPT_MAX_BYTES, LIVE_TAIL_MAX_BYTES, omittedBytes } from "../../src/runtime/body-excerpt.js";
import { measureView, measurementWork, resetMeasurementWork } from "../../src/runtime/view-measure.js";

const CWD = "/p";
const path = `${CWD}/heavy.jsonl`;
const MIB = 1024 * 1024;

const sessionState = (over: Partial<SessionState> = {}): SessionState => ({
  path, id: "id-heavy", cwd: CWD, messageCount: 12, pendingMessageCount: 0, isStreaming: false, isCompacting: false, ...over,
} as SessionState);

const update = (state: AppState, seq: number, value: unknown): AppState =>
  reduce(state, { type: "notification", method: "session/update", params: { sessionPath: path, seq, at: "2026-09-15T00:00:00.000Z", update: value } } as never);

/** A conversation the way scenario 4 builds one: huge reply, huge tool output, images. */
function heavyView(): AppState {
  let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
  state = { ...state, current: path };
  // A settled history of ordinary turns, then the enormous ones.
  const entries: unknown[] = [];
  for (let index = 0; index < 20; index++) {
    entries.push({
      id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, type: "message",
      message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `turn ${index} ${"x".repeat(4096)}` }] },
    });
  }
  entries.push({
    id: "e-huge", parentId: "e19", type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "R".repeat(2 * MIB) }, { type: "thinking", thinking: "T".repeat(2 * MIB) }] },
  });
  entries.push({
    id: "e-images", parentId: "e-huge", type: "message",
    message: { role: "user", content: [{ type: "text", text: "look" },
      ...Array.from({ length: 12 }, () => ({ type: "image", mimeType: "image/png", data: "A".repeat(4 * MIB / 3) }))] },
  });
  state = reduce(state, { type: "hydrate", path, entries, leafId: "e-images" });
  return state;
}

function cacheOver(state: AppState, environment: ViewCacheEnvironment = { scoped: () => [], hasDraft: () => false }) {
  const store = createStateStore(state);
  let deferred: (() => void) | undefined;
  const cache = createViewCache({
    read: () => store.getSnapshot(),
    dispatch: store.dispatch,
    environment,
    now: () => new Date("2026-09-15T02:00:00.000Z"),
    defer: (run) => { deferred = run; return () => { deferred = undefined; }; },
    deliver: (run) => { run(); return () => {}; },
  });
  store.observeTransactions((action, before, after) => { cache.observeTransaction(action, before, after); return false; });
  return { store, cache, run: () => { const next = deferred; deferred = undefined; next?.(); } };
}

const bytesOf = (state: AppState): number => measureView(state.open[path]!).bytes;

describe("A1 · every hydrated view settles inside the bound", () => {
  it("bounds a current, running, draft-pinned conversation carrying megabytes", () => {
    const h = cacheOver(heavyView(), { scoped: () => [], hasDraft: (candidate) => candidate === path });
    // Pinned three times over: current, a live turn, and the person's draft.
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 5, at: "",
      update: { kind: "state", state: { ...sessionState(), isStreaming: true } } } } as never);
    h.run();
    h.cache.maintain();

    const view = h.store.getSnapshot().open[path]!;
    expect(isDormantView(view)).toBe(false);
    const measure = measureView(view);
    expect(measure.bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
    expect(h.cache.counters().bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.bytes);
    // The bound is met by holding excerpts and references, not by hiding data.
    expect(measure.referencedBytes).toBeGreaterThan(4 * MIB);
    // And nothing claims permission to stay over it.
    expect(h.cache.counters().overflow).toBeUndefined();
  });

  it("holds no body over the excerpt bound, and no image bytes at all", () => {
    const state = heavyView();
    const view = state.open[path]!;
    for (const block of view.blocks) {
      if (block.kind === "assistant") {
        expect(new TextEncoder().encode(block.text).byteLength).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES);
        expect(new TextEncoder().encode(block.thinking).byteLength).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES);
      }
      if (block.kind === "user") for (const image of block.images) expect(image.data).toBe("");
    }
    // The oversized records are pointed at, never rewritten to fit.
    expect((view.stubs ?? []).map(stub => stub.id).sort()).toEqual(["e-huge", "e-images"]);
    for (const entry of view.entries) {
      expect(JSON.stringify(entry).length).toBeLessThan(BODY_EXCERPT_MAX_BYTES * 2);
    }
  });

  it("keeps the total inside its bound across many heavy conversations", () => {
    let state: AppState = { ...initialState, connection: "open" };
    for (let index = 0; index < 5; index++) {
      const heavy = heavyView();
      const view = heavy.open[path]!;
      state = { ...state, open: { ...state.open, [`${CWD}/s${index}.jsonl`]: { ...view, path: `${CWD}/s${index}.jsonl` } } };
    }
    state = { ...state, current: `${CWD}/s0.jsonl` };
    const h = cacheOver(state);
    h.cache.maintain();
    expect(h.cache.counters().bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.bytes);
    expect(h.cache.counters().overflow).toBeUndefined();
  });
});

describe("A2 · one fold's own work is bounded", () => {
  it("excerpts a twelve-megabyte tool result without holding or re-walking it", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
    state = update(state, 1, { kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    resetMeasurementWork();
    const before = bytesOf(state);
    state = update(state, 2, { kind: "tool_execution_end", toolCallId: "t1", result: "Z".repeat(12 * MIB), isError: false });
    const after = bytesOf(state);

    expect(after - before).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES + 1024);
    // The estimator never re-walks the body it was handed.
    expect(measurementWork().bytes).toBeLessThan(2 * MIB);
    const tool = state.open[path]!.blocks.find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>;
    expect(omittedBytes(tool.bodies?.result)).toBeGreaterThan(11 * MIB);
  });
});

describe("A3 · a live turn is bounded while it streams", () => {
  it("keeps the tail of eight megabytes of deltas and counts the rest exactly", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    state = update(state, 1, { kind: "message_start", role: "assistant" });
    const chunk = "d".repeat(64 * 1024);
    for (let index = 0; index < 128; index++) state = update(state, 2 + index, { kind: "text_delta", delta: chunk });
    for (let index = 0; index < 32; index++) state = update(state, 200 + index, { kind: "thinking_delta", delta: chunk });

    const block = state.open[path]!.blocks.at(-1) as Extract<Block, { kind: "assistant" }>;
    expect(new TextEncoder().encode(block.text).byteLength).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(new TextEncoder().encode(block.thinking).byteLength).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(block.bodies?.text?.totalBytes).toBe(128 * 64 * 1024);
    expect(block.bodies?.text?.live).toBe(true);
    // The newest bytes are what a person watching is reading.
    expect(block.text.endsWith("d")).toBe(true);
    expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);

    // Two hundred partial updates never accumulate either.
    state = update(state, 400, { kind: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: {} });
    for (let index = 0; index < 200; index++) state = update(state, 401 + index, { kind: "tool_execution_update", toolCallId: "t9", partial: "p".repeat(200_000) });
    expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);

    // The turn ends: the final text replaces the streamed one, still bounded.
    state = update(state, 700, { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text: "F".repeat(8 * MIB) }] } });
    const settled = state.open[path]!.blocks.find(block => block.kind === "assistant") as Extract<Block, { kind: "assistant" }>;
    expect(new TextEncoder().encode(settled.text).byteLength).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(settled.bodies?.text?.totalBytes).toBe(8 * MIB);
    expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("never cancels the turn it bounds", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    state = update(state, 1, { kind: "message_start", role: "assistant" });
    state = update(state, 2, { kind: "text_delta", delta: "x".repeat(4 * MIB) });
    expect(state.open[path]!.state.isStreaming).toBe(true);
    expect(state.open[path]!.blocks.at(-1)).toMatchObject({ kind: "assistant", streaming: true });
  });
});

describe("A4 · an authoritative rebuild never puts a body back", () => {
  it("folds a page whose oversized records the producer elided", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
    state = reduce(state, { type: "historyBegin", path, token: "t" });
    const window = {
      epoch: "w1", seq: 4, revision: "r1.env.4", environmentKey: "e1.key", userOffset: 0, complete: true,
      branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [],
      elided: [{ id: "e-big", parentId: "e0", type: "message", role: "assistant",
        bodies: [{ component: { kind: "assistant_text" as const }, totalBytes: 9_000_000, contentDigest: "abc" }] }],
    };
    state = reduce(state, { type: "historySnapshot", path, token: "t", window, leafId: "e-big",
      entries: [{ id: "e0", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }] });

    const view = state.open[path]!;
    expect(view.stubs?.map(stub => stub.id)).toEqual(["e-big"]);
    expect(view.entries).toHaveLength(1);
    const reply = view.blocks.find(block => block.kind === "assistant") as Extract<Block, { kind: "assistant" }>;
    expect(reply.text).toBe("");
    expect(reply.bodies?.text).toMatchObject({ entryId: "e-big", totalBytes: 9_000_000, revision: "r1.env.4" });
    expect(measureView(view).bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("folds a page a producer delivered whole, without keeping the record", () => {
    const state = heavyView();
    const view = state.open[path]!;
    expect(view.stubs?.length).toBeGreaterThan(0);
    expect(view.entries.some(entry => JSON.stringify(entry).length > 1_000_000)).toBe(false);
    expect(measureView(view).bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });
});

describe("A5 · identity, ordinals and actions are untouched", () => {
  it("keeps entry ids, order, prompts and the branch of a bounded conversation", () => {
    const state = heavyView();
    const view = state.open[path]!;
    const ids = view.blocks.flatMap(block => "entryId" in block && block.entryId ? [block.entryId] : []);
    // Every record is still a row, in the conversation's own order.
    expect(ids).toEqual([...Array.from({ length: 20 }, (_, index) => `e${index}`), "e-huge", "e-images"]);
    // Prompts keep their ordinals, so message actions address the same entries.
    const prompts = view.blocks.filter(block => block.kind === "user");
    expect(prompts).toHaveLength(11);
    expect(view.leafId).toBe("e-images");
  });
});

describe("A12 · images are references, never bytes", () => {
  it("charges nothing for a referenced image and says how large it is", () => {
    const view = heavyView().open[path]!;
    const prompt = view.blocks.find(block => block.kind === "user" && block.images.length > 0) as Extract<Block, { kind: "user" }>;
    expect(prompt.images).toHaveLength(12);
    for (const image of prompt.images) expect(image.data).toBe("");
    const refs = prompt.bodies?.images ?? [];
    expect(refs.filter(Boolean)).toHaveLength(12);
    for (const ref of refs) expect(ref?.totalBytes).toBeGreaterThan(1_000_000);
    expect(measureView(view).imagesBytes).toBe(0);
  });
});
