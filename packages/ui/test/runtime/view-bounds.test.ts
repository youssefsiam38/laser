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
import { blocksFromEntries, initialState, isDormantView, reduce, type AppState, type Block } from "../../src/store.js";
import { BODY_EXCERPT_MAX_BYTES, isReadable, LIVE_TAIL_MAX_BYTES, omittedBytes } from "../../src/runtime/body-excerpt.js";
import { measureView, measurementWork, resetMeasurementWork } from "../../src/runtime/view-measure.js";
import { bodyProjectionWork, entryBodyIdentities, resetBodyProjectionWork, TASK_EVENT_MESSAGE_TYPE } from "@lasercode/protocol";
import { createHash } from "node:crypto";

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
  // The acceptance workload, exactly: an eight-megabyte reply with its own
  // reasoning, a twelve-megabyte tool result, and twelve full-size images, all
  // in the one conversation this view is showing.
  entries.push({
    id: "e-huge", parentId: "e19", type: "message",
    message: { role: "assistant", content: [
      { type: "text", text: "R".repeat(8 * MIB) },
      { type: "thinking", thinking: "T".repeat(2 * MIB) },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cat build.log" } },
    ] },
  });
  entries.push({
    id: "e-tool", parentId: "e-huge", type: "message",
    message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "O".repeat(12 * MIB) }] },
  });
  entries.push({
    id: "e-images", parentId: "e-tool", type: "message",
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
    expect((view.stubs ?? []).map(stub => stub.id).sort()).toEqual(["e-huge", "e-images", "e-tool"]);
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
  it("never materialises a structured body before excerpting it", () => {
    // A twelve-megabyte structured result: the old path ran the whole value
    // through JSON.stringify before cutting it, which is the copy this bound
    // exists to prevent.
    const structured = { lines: Array.from({ length: 2000 }, (_, index) => ({ n: index, text: "s".repeat(6000) })) };
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
    state = update(state, 1, { kind: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls" } });
    resetBodyProjectionWork();
    state = update(state, 2, { kind: "tool_execution_end", toolCallId: "t2", result: structured, isError: false });

    const work = bodyProjectionWork();
    const tool = state.open[path]!.blocks.find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>;
    // Exactly the prefix the authority's own text would have, and its size.
    const whole = JSON.stringify(structured, null, 2);
    expect(whole.startsWith(String(tool.result))).toBe(true);
    expect(tool.bodies?.result?.totalBytes).toBe(new TextEncoder().encode(whole).byteLength);
    // What the fold wrote is the excerpt, not the body.
    expect(work.emittedChars).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES + 4096);
    expect(work.emittedChars * 50).toBeLessThan(whole.length);
    expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

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

describe("A2 · every write path is bounded, not only the ones the soak walks", () => {
  const bytesIn = (text: string) => new TextEncoder().encode(text).byteLength;

  it("bounds one enormous delta without ever concatenating the body", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    state = update(state, 1, { kind: "message_start", role: "assistant" });
    state = update(state, 2, { kind: "text_delta", delta: "a".repeat(64 * 1024) });
    // One eight-megabyte delta on top of a tail already at its cap.
    resetBodyProjectionWork();
    state = update(state, 3, { kind: "text_delta", delta: "B".repeat(8 * MIB) });
    const block = state.open[path]!.blocks.at(-1) as Extract<Block, { kind: "assistant" }>;
    expect(bytesIn(block.text)).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(block.text.endsWith("B")).toBe(true);
    expect(block.bodies?.text?.totalBytes).toBe(64 * 1024 + 8 * MIB);
    expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("bounds the first delta of a turn, a tool call's request and a custom payload", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    // A whole reply in the first delta, before any assistant block exists.
    state = update(state, 1, { kind: "text_delta", delta: "F".repeat(4 * MIB) });
    const first = state.open[path]!.blocks.at(-1) as Extract<Block, { kind: "assistant" }>;
    expect(bytesIn(first.text)).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(first.bodies?.text?.totalBytes).toBe(4 * MIB);

    // A call whose request is enormous.
    state = update(state, 2, { kind: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { content: "c".repeat(4 * MIB) } });
    const tool = state.open[path]!.blocks.find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>;
    expect(bytesIn(String(tool.args))).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES + 64);
    expect(tool.bodies?.args?.totalBytes).toBeGreaterThan(4 * MIB);

    // A custom record: both the line the model read and the payload attached.
    state = update(state, 3, { kind: "message_end", message: { role: "custom", customType: TASK_EVENT_MESSAGE_TYPE,
      content: [{ type: "text", text: "D".repeat(2 * MIB) }], details: { output: "e".repeat(2 * MIB) } } });
    const custom = state.open[path]!.blocks.find(block => block.kind === "custom") as Extract<Block, { kind: "custom" }> | undefined;
    if (custom) {
      expect(bytesIn(custom.text)).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES);
      expect(bytesIn(String(custom.details ?? ""))).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES + 64);
      expect(custom.bodies?.text?.totalBytes).toBe(2 * MIB);
    }
    expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("classifies an authoritative page of structured records without building their projections", () => {
    const structured = { rows: Array.from({ length: 2000 }, (_, index) => ({ index, text: "s".repeat(6000) })) };
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
    state = reduce(state, { type: "historyBegin", path, token: "t" });
    resetBodyProjectionWork();
    state = reduce(state, { type: "historySnapshot", path, token: "t", leafId: "r1", window: {
      epoch: "w1", seq: 2, revision: "r1.env.2", environmentKey: "k", userOffset: 0, complete: true,
      branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [],
    } as never, entries: [
      { id: "r0", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
      { id: "r1", parentId: "r0", type: "message", message: { role: "toolResult", toolCallId: "c1", content: [], details: structured } },
    ] });
    const work = bodyProjectionWork();
    // The page was classified and folded; nothing built the twelve-megabyte
    // projection of that result to do it.
    expect(work.emittedChars).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES * 2);
    const view = state.open[path]!;
    expect(view.stubs?.map(stub => stub.id)).toEqual(["r1"]);
    expect(measureView(view).bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("bounds a live message that arrives beside an authoritative page", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
    state = reduce(state, { type: "historyBegin", path, token: "t" });
    state = reduce(state, { type: "historySnapshot", path, token: "t", leafId: "p0", entries: [
      { id: "p0", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    ], window: {
      epoch: "w1", seq: 2, revision: "r1.env.2", environmentKey: "k", userOffset: 0, complete: true,
      branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [],
      live: { running: true, tools: [], message: { id: "live-1", value: { role: "assistant", content: [
        { type: "text", text: "L".repeat(8 * MIB) },
        { type: "thinking", thinking: "T".repeat(8 * MIB) },
      ] } } },
    } as never });
    const live = state.open[path]!.blocks.find(block => block.kind === "assistant" && block.streaming) as Extract<Block, { kind: "assistant" }>;
    expect(live.id).toBe("live-1");
    expect(bytesIn(live.text)).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(bytesIn(live.thinking)).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(live.bodies?.text?.totalBytes).toBe(8 * MIB);
    expect(live.bodies?.text?.live).toBe(true);
    expect(measureView(state.open[path]!).bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("keeps no truncated attachment, and says the prompt is partial", () => {
    const file = `<attached-file name="notes.md" type="text/markdown" size="${new TextEncoder().encode("ü".repeat(40_000)).byteLength}">\n${"ü".repeat(40_000)}\n</attached-file>`;
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
    state = reduce(state, { type: "hydrate", path, leafId: "u1", entries: [
      { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: `prose\n\n${file}` }] } },
    ] });
    const prompt = state.open[path]!.blocks.find(block => block.kind === "user") as Extract<Block, { kind: "user" }>;
    // Nothing half-complete is kept: the prompt is an excerpt with a reference,
    // and no file chip claims to be a whole attachment.
    expect(prompt.files).toEqual([]);
    expect(prompt.bodies?.text?.totalBytes).toBeGreaterThan(BODY_EXCERPT_MAX_BYTES);
    expect(bytesIn(prompt.text)).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES);
  });
});

describe("A2b · a settled body gains the identity its authority published", () => {
  const bytesIn = (text: string) => new TextEncoder().encode(text).byteLength;
  const HUGE = "答".repeat(200_000);
  const digestOf = (text: string) => `sha-${bytesIn(text)}`;

  it("makes an oversized reply readable at once, without reopening the conversation", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    state = update(state, 1, { kind: "message_start", role: "assistant" });
    state = update(state, 2, { kind: "text_delta", delta: HUGE });
    const live = (state.open[path]!.blocks.at(-1) as Extract<Block, { kind: "assistant" }>).bodies?.text;
    // While it streams there is no entry to point at, and it says so.
    expect(live?.live).toBe(true);
    expect(live?.entryId).toBeUndefined();

    state = update(state, 3, { kind: "message_end", role: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: HUGE }] },
      entry: { id: "a1", parentId: "u0", revision: "r7.env.9", bodies: [
        { component: { kind: "assistant_text" }, totalBytes: bytesIn(HUGE), contentDigest: digestOf(HUGE) },
      ] } });
    const settled = (state.open[path]!.blocks.at(-1) as Extract<Block, { kind: "assistant" }>).bodies?.text;
    expect(settled?.live).toBeUndefined();
    expect(settled?.entryId).toBe("a1");
    expect(settled?.contentDigest).toBe(digestOf(HUGE));
    expect(settled?.totalBytes).toBe(bytesIn(HUGE));
    // The body itself did not come back into the view.
    expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("keeps a reference live when the identity does not match, rather than guessing", () => {
    const cases: Array<{ name: string; entry: unknown }> = [
      { name: "no identity at all", entry: { id: "a1", parentId: null } },
      { name: "another component", entry: { id: "a1", parentId: null, revision: "r", bodies: [{ component: { kind: "reasoning" }, totalBytes: bytesIn(HUGE), contentDigest: "x" }] } },
      { name: "another size", entry: { id: "a1", parentId: null, revision: "r", bodies: [{ component: { kind: "assistant_text" }, totalBytes: 12, contentDigest: "x" }] } },
    ];
    for (const shape of cases) {
      let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
      state = update(state, 1, { kind: "message_start", role: "assistant" });
      state = update(state, 2, { kind: "text_delta", delta: HUGE });
      state = update(state, 3, { kind: "message_end", role: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: HUGE }] }, entry: shape.entry } as never);
      const settled = (state.open[path]!.blocks.at(-1) as Extract<Block, { kind: "assistant" }>).bodies?.text;
      expect(settled?.live, shape.name).toBe(true);
      expect(settled?.entryId, shape.name).toBeUndefined();
    }
  });

  it("settles a tool result through the call it answers, and no other row", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    state = update(state, 1, { kind: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } });
    state = update(state, 2, { kind: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "b" } });
    state = update(state, 3, { kind: "tool_execution_end", toolCallId: "t2", result: HUGE, isError: false });
    state = update(state, 4, { kind: "message_end", role: "tool",
      message: { role: "toolResult", toolCallId: "t2", content: [{ type: "text", text: HUGE }] },
      entry: { id: "r2", parentId: "a1", revision: "r8.env.9", bodies: [
        { component: { kind: "tool_result" }, totalBytes: bytesIn(HUGE), contentDigest: digestOf(HUGE) },
        { component: { kind: "tool_output" }, totalBytes: bytesIn(HUGE), contentDigest: digestOf(HUGE) },
      ] } });
    const rows = state.open[path]!.blocks.filter(block => block.kind === "tool") as Array<Extract<Block, { kind: "tool" }>>;
    const answered = rows.find(row => row.id === "t2")!;
    const untouched = rows.find(row => row.id === "t1")!;
    expect(answered.bodies?.result?.entryId).toBe("r2");
    expect(answered.bodies?.result?.live).toBeUndefined();
    expect(answered.entryId).toBe("r2");
    expect(untouched.entryId).toBeUndefined();
    expect(untouched.bodies?.args?.entryId).toBeUndefined();
  });

  // D-275: what the engine actually delivers is an envelope, not a string, and
  // the identity is what the worker publishes for the entry it wrote.
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const hasher = () => { const hash = createHash("sha256"); return { update: (chunk: string) => { hash.update(chunk, "utf8"); }, digest: () => hash.digest("hex") }; };
  const OUTPUT = "line ✓ é 😀\n".repeat(20_000);
  const envelopes: Array<{ name: string; result: { content: unknown[]; details?: unknown } }> = [
    { name: "text only, no details", result: { content: [{ type: "text", text: OUTPUT }] } },
    { name: "details present", result: { content: [{ type: "text", text: OUTPUT }], details: { exitCode: 0, truncation: { lines: 20_000 } } } },
    { name: "several parts", result: { content: [{ type: "text", text: OUTPUT.slice(0, 1001) }, { type: "text", text: OUTPUT.slice(1001) }], details: { exitCode: 2 } } },
  ];
  for (const { name, result } of envelopes) {
    it(`a live tool result becomes readable output once its entry is written (${name})`, () => {
      let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
      state = update(state, 1, { kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "cat" } });
      state = update(state, 2, { kind: "tool_execution_end", toolCallId: "t1", result, isError: false });
      const live = (state.open[path]!.blocks.find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>).bodies?.result;
      // Not written yet: it points at the output, says it is live, and names no entry.
      expect(live).toMatchObject({ component: { kind: "tool_output" }, totalBytes: bytesIn(OUTPUT), live: true });
      expect(live?.entryId).toBeUndefined();
      // The row holds the head of the output itself, never the record's JSON,
      // whatever details ride beside it, so the tool row can show its first lines.
      const heldLive = (state.open[path]!.blocks.find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>).result;
      expect(typeof heldLive).toBe("string");
      expect(OUTPUT.startsWith(heldLive as string)).toBe(true);
      expect(bytesIn(heldLive as string)).toBe(live?.excerpt.bytes);
      expect((live?.excerpt.bytes ?? 0)).toBeGreaterThan(0);

      // The engine writes the entry the way it does (the message carries the
      // result's own content and details) and the worker names its bodies.
      const message = { role: "toolResult", toolCallId: "t1", toolName: "bash", content: result.content, details: result.details, isError: false };
      const identity = entryBodyIdentities({ type: "message", id: "r1", parentId: "a1", message }, hasher);
      state = update(state, 3, { kind: "message_end", role: "toolResult", message, entry: { id: "r1", parentId: "a1", revision: "r9.env.1", bodies: identity.bodies } });

      const tool = state.open[path]!.blocks.find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>;
      const settled = tool.bodies?.result;
      expect(settled).toMatchObject({ entryId: "r1", component: { kind: "tool_output" }, totalBytes: bytesIn(OUTPUT), contentDigest: sha(OUTPUT) });
      expect(settled?.live).toBeUndefined();
      expect(isReadable(settled)).toBe(true);
      expect(omittedBytes(settled)).toBeGreaterThan(0);
      expect(OUTPUT.startsWith(tool.result as string)).toBe(true);
      expect(bytesIn(tool.result as string)).toBe(settled?.excerpt.bytes);
      expect(bytesOf(state)).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
    });
  }

  it("addresses the output of a stored result, and of one the view only points at", () => {
    const message = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: OUTPUT }], details: { exitCode: 0 } };
    const call = { id: "a1", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } };
    const stored = { id: "r1", parentId: "a1", type: "message", message };
    // Held (retained): the reference built from the record itself.
    const held = blocksFromEntries([call, stored], "r1").find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>;
    expect(held.bodies?.result).toMatchObject({ entryId: "r1", component: { kind: "tool_output" }, totalBytes: bytesIn(OUTPUT) });
    expect(OUTPUT.startsWith(held.result as string)).toBe(true);
    expect(bytesIn(held.result as string)).toBe(held.bodies?.result?.excerpt.bytes);
    // Pointed at (a stub): the authority's page named the output.
    const stub = { id: "r1", parentId: "a1", type: "message", role: "toolResult", toolCallId: "c1",
      bodies: [{ component: { kind: "tool_result" as const }, totalBytes: 999_999, contentDigest: "x" }, { component: { kind: "tool_output" as const }, totalBytes: bytesIn(OUTPUT), contentDigest: sha(OUTPUT) }] };
    const pointed = blocksFromEntries([call], "r1", undefined, { stubs: [stub], revision: "r1.env.2" }).find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>;
    expect(pointed.bodies?.result).toMatchObject({ entryId: "r1", component: { kind: "tool_output" }, totalBytes: bytesIn(OUTPUT), contentDigest: sha(OUTPUT) });
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
    expect(ids.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => `e${index}`));
    // The oversized reply is two rows — its prose and its tool call — and the
    // result belongs to that call; every one of them names its own record.
    expect(ids.slice(20)).toEqual(["e-huge", "e-huge", "e-images"]);
    // Prompts keep their ordinals, so message actions address the same entries.
    const prompts = view.blocks.filter(block => block.kind === "user");
    expect(prompts).toHaveLength(11);
    // The tool call is a row of its own, with its result as a reference.
    const tool = view.blocks.find(block => block.kind === "tool") as Extract<Block, { kind: "tool" }>;
    expect(tool.bodies?.result?.totalBytes).toBe(12 * MIB);
    expect(view.leafId).toBe("e-images");
  });
});

describe("A12 · images are references, never bytes", () => {
  it("keeps fitting prompt text inline when its image is oversized", () => {
    const view = heavyView().open[path]!;
    const prompt = view.blocks.find(block => block.kind === "user" && block.images.length > 0) as Extract<Block, { kind: "user" }>;
    expect(prompt.text).toBe("look");
    expect(prompt.bodies?.text?.totalBytes).toBe(4);
    expect(prompt.bodies?.text?.excerpt.bytes).toBe(4);
    expect(omittedBytes(prompt.bodies?.text)).toBe(0);
    const measured = measureView(view);
    expect(measured.bytes).toBeGreaterThanOrEqual(4);
    expect(measured.bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("charges retained prompt stubs honestly without trimming the active logical view", () => {
    const text = "x".repeat(15 * 1024);
    const count = 100;
    const elided = Array.from({ length: count }, (_, index) => ({
      id: `retained-${index}`, parentId: index ? `retained-${index - 1}` : null, type: "message", role: "user",
      bodies: [
        { component: { kind: "user_text" as const }, totalBytes: text.length, contentDigest: "a".repeat(64), text },
        { component: { kind: "image" as const, index: 0 }, totalBytes: 30 * 1024, contentDigest: "b".repeat(64) },
      ],
    }));
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState() });
    state = { ...state, current: path };
    state = reduce(state, { type: "historyBegin", path, token: "retained" });
    state = reduce(state, { type: "historySnapshot", path, token: "retained", entries: [], leafId: `retained-${count - 1}`, window: {
      epoch: "w1", seq: 1, revision: "r1", environmentKey: "e1", userOffset: 0, complete: true,
      branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], elided,
    } } as never);

    const before = measureView(state.open[path]!);
    expect(before.stubsBytes).toBeGreaterThanOrEqual(count * text.length);
    // Only the absent image bytes are referenced (once by the rendered block,
    // once by its retained stub); retained prompt prose is not counted absent.
    expect(before.referencedBytes).toBe(count * 30 * 1024 * 2);
    expect(before.bytes).toBeGreaterThan(VIEW_CACHE_LIMITS.viewBytes);

    const heldEntries = state.open[path]!.entries;
    const heldStubs = state.open[path]!.stubs;
    const h = cacheOver(state);
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 2, at: "",
      update: { kind: "state", state: sessionState() } } } as never);
    h.run();
    h.cache.maintain();
    const active = h.store.getSnapshot().open[path]!;
    expect(active.entries).toBe(heldEntries);
    expect(active.stubs).toBe(heldStubs);
    expect(measureView(active).bytes).toBe(before.bytes);
    expect(h.cache.counters().overflow).toBe("protected");
  });

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
