/**
 * RP-5b §7: replacing what a trim released, and refusing to replace it with
 * something that does not contain what the surface is standing on.
 */
import { describe, expect, it, vi } from "vitest";
import { createHistoryLoader, RECONCILE_MAX_READS } from "../../src/runtime/history-loader.js";
import { measureView } from "../../src/runtime/view-measure.js";
import { initialState, reduce, type AppState, type SessionView } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";
import { BODY_EXCERPT_MAX_BYTES } from "../../src/runtime/body-excerpt.js";

const PATH = "/project/session.jsonl";
const OTHER = "/project/other.jsonl";

const entry = (id: string, parentId: string | null, text: string) =>
  ({ id, parentId, type: "message", message: { role: id.startsWith("u") ? "user" : "assistant", content: [{ type: "text", text }] } });

const window = (over: Record<string, unknown> = {}) => ({
  epoch: "w1", seq: 9, revision: "r1.env.9", environmentKey: "env", userOffset: 0, complete: true,
  branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], ...over,
});

/** A long hydrated transcript, before any trim. */
function trimmedSource(): AppState {
  let state: AppState = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: PATH }) as never });
  const entries = Array.from({ length: 60 }, (_, index) => entry(`u${index}`, index === 0 ? null : `u${index - 1}`, "x".repeat(2000)));
  state = reduce(state, { type: "hydrate", path: PATH, entries, leafId: "u59" });
  return state;
}

/** A view with a long transcript, trimmed while the surface stands on `anchor`. */
function trimmed(anchor: string, options: { path?: string } = {}) {
  const path = options.path ?? PATH;
  let state: AppState = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path }) as never });
  const entries = Array.from({ length: 60 }, (_, index) => entry(`u${index}`, index === 0 ? null : `u${index - 1}`, "x".repeat(2000)));
  state = reduce(state, { type: "hydrate", path, entries, leafId: "u59" });
  state = reduce(state, { type: "views/trim", paths: [path], keepBytes: 32 * 1024, at: "2026-01-01T00:00:00.000Z",
    standing: { anchorEntryId: anchor, focusedEntryId: anchor, actionTargetEntryIds: [anchor] } });
  return state;
}

function loader(state: { current: AppState }, reply: () => Promise<unknown>, current = PATH) {
  const request = vi.fn(async () => (await reply()) as never);
  const dispatch = vi.fn((action: never) => { state.current = reduce(state.current, action); });
  const history = createHistoryLoader({
    isCurrent: (path: string) => path === current,
    get: (path: string) => state.current.open[path],
    request: request as never,
    dispatch: dispatch as never,
    adoptEpoch: () => {},
    track: () => {},
  });
  return { history, request, dispatch };
}

describe("what a production trim records", () => {
  it("puts the rows the transcript is standing on into the stamp, through the cache's own pass", async () => {
    const { setStandingRows, resetAnchoredMessages } = await import("../../src/runtime/anchored-messages.js");
    const { createViewCache, VIEW_CACHE_LIMITS } = await import("../../src/runtime/view-cache.js");
    const { createStateStore } = await import("../../src/runtime/LaserProvider.js");
    resetAnchoredMessages();
    const store = createStateStore(reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: PATH }) as never }));
    // What the viewport publishes: message ids, of which only the persisted
    // ones name an entry.
    setStandingRows(PATH, { anchor: "entry:u30", focused: "entry:u31", targets: ["entry:u32", "live-block-7", "entry:u32"] });
    const cache = createViewCache({
      read: store.getSnapshot,
      dispatch: store.dispatch,
      environment: { scoped: () => [], hasDraft: () => false, heldPaths: () => [], environmentKey: () => "env" } as never,
      schedule: (run: () => void) => { run(); return () => {}; },
      limits: { ...VIEW_CACHE_LIMITS, viewBytes: 16 * 1024 },
    } as never);
    // The cache learns about this conversation the way it always does: by
    // watching the transaction that hydrated it.
    const before = store.getSnapshot();
    const entries = Array.from({ length: 60 }, (_, index) => entry(`u${index}`, index === 0 ? null : `u${index - 1}`, "x".repeat(2000)));
    const action = { type: "hydrate", path: PATH, entries, leafId: "u59" } as never;
    store.dispatch(action);
    cache.observeTransaction(action, before, store.getSnapshot());
    cache.maintain();
    const view = store.getSnapshot().open[PATH];
    const stamp = view?.trimmed;
    if (!stamp) throw new Error(`no trim happened: ${JSON.stringify({ blocks: view?.blocks.length, dormant: view?.dormant })}`);
    expect(stamp?.identities?.anchorEntryId).toBe("u30");
    expect(stamp?.identities?.focusedEntryId).toBe("u31");
    // Canonical entry ids, deduplicated, and nothing that names no entry.
    expect(stamp?.identities?.actionTargetEntryIds).toEqual(["u32"]);
    expect(JSON.stringify(stamp).length).toBeLessThan(400);
    resetAnchoredMessages();
    cache.dispose();
  });
});

describe("reconciling a trimmed view", () => {
  it("keeps only identity strings in the stamp, and measures them", () => {
    const state = trimmed("u40");
    const view = state.open[PATH]!;
    expect(view.trimmed?.identities).toEqual({ anchorEntryId: "u40", focusedEntryId: "u40", actionTargetEntryIds: ["u40"], leafId: "u59" });
    // Tens of bytes beside a bounded view, not a page.
    expect(JSON.stringify(view.trimmed).length).toBeLessThan(400);
    expect(measureView(view).bytes).toBeLessThanOrEqual(32 * 1024 + 4096);
  });

  it("reads once for a stamp, asks for the recent tail, and commits when the page contains what was preserved", async () => {
    const state = { current: trimmed("u58") };
    const kept = [entry("u58", "u57", "tail"), entry("u59", "u58", "tail")];
    const { history, request } = loader(state, async () => ({ entries: kept, leafId: "u59", window: window() }));
    await history.reconcile(PATH);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toEqual({ path: PATH, window: { tail: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
    const view = state.current.open[PATH]!;
    expect(view.trimmed).toBeUndefined();
    expect(view.history?.revision).toBe("r1.env.9");
    expect(view.entries.map(row => (row as { id: string }).id)).toEqual(["u58", "u59"]);
    // Asking again for the same (now absent) stamp reads nothing.
    await history.reconcile(PATH);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("discards a page that does not contain what the surface stands on, and keeps the trimmed view", async () => {
    const state = { current: trimmed("u10") };
    const before = measureView(state.current.open[PATH]!).bytes;
    const blocks = state.current.open[PATH]!.blocks.length;
    const { history, request } = loader(state, async () => ({ entries: [entry("u58", "u57", "tail")], leafId: "u59", window: window() }));
    await history.reconcile(PATH);
    const view = state.current.open[PATH]!;
    // Nothing of the refused page is anywhere.
    expect(view.trimmed?.deferred).toBe(true);
    expect(view.trimmed?.reads).toBe(1);
    expect(view.blocks.length).toBe(blocks);
    expect(measureView(view).bytes).toBe(before);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("spends two reads for one stamp and never a third, however it is asked", async () => {
    const state = { current: trimmed("u10") };
    const { history, request } = loader(state, async () => ({ entries: [entry("u58", "u57", "tail")], leafId: "u59", window: window() }));
    for (let attempt = 0; attempt < 5; attempt++) await history.reconcile(PATH);
    expect(request).toHaveBeenCalledTimes(RECONCILE_MAX_READS);
    expect(state.current.open[PATH]!.trimmed?.reads).toBe(RECONCILE_MAX_READS);
    // A person asking is one of the two, not an exception to them: the budget
    // is spent, so nothing more is read for this stamp.
    const asked = loader(state, async () => ({ entries: [entry("u10", "u9", "kept")], leafId: "u59", window: window() }));
    await asked.history.reconcile(PATH);
    expect(asked.request).not.toHaveBeenCalled();
    expect(state.current.open[PATH]!.trimmed?.reads).toBe(RECONCILE_MAX_READS);

    // A genuinely new trim starts a new budget, and a page that contains what
    // the surface stands on is committed with its cursor.
    state.current = trimmed("u58");
    const fresh = loader(state, async () => ({ entries: [entry("u58", "u57", "kept"), entry("u59", "u58", "tail")], leafId: "u59", window: window() }));
    await fresh.history.reconcile(PATH);
    expect(fresh.request).toHaveBeenCalledTimes(1);
    expect(state.current.open[PATH]!.trimmed).toBeUndefined();
    expect(state.current.open[PATH]!.history).toBeDefined();
  });

  it("reads nothing at all for a conversation that is not on screen", async () => {
    const state = { current: trimmed("u10", { path: OTHER }) };
    const before = measureView(state.current.open[OTHER]!).bytes;
    const stamp = state.current.open[OTHER]!.trimmed!.at;
    // PATH is the conversation on screen; OTHER is not.
    const { history, request } = loader(state, async () => ({ entries: [], leafId: null, window: window() }), PATH);
    for (let attempt = 0; attempt < 3; attempt++) await history.reconcile(OTHER);
    expect(request).not.toHaveBeenCalled();
    const background = state.current.open[OTHER]!;
    expect(background.trimmed).toEqual(state.current.open[OTHER]!.trimmed);
    expect(background.trimmed?.reads).toBeUndefined();
    expect(background.trimmed?.deferred).toBeUndefined();
    expect(measureView(background).bytes).toBe(before);

    // Coming back to it makes it eligible, and then it reads once.
    const entered = loader(state, async () => ({ entries: [entry("u10", "u9", "kept")], leafId: "u59", window: window() }), OTHER);
    await entered.history.reconcile(OTHER);
    expect(entered.request).toHaveBeenCalledTimes(1);
    expect(state.current.open[OTHER]!.trimmed?.at).not.toBe(stamp);
  });

  it("spends a read on a failure and keeps not one byte of it", async () => {
    const state = { current: trimmed("u10") };
    const { history, request } = loader(state, async () => { throw new Error("network"); });
    const before = measureView(state.current.open[PATH]!).bytes;
    await history.reconcile(PATH);
    expect(request).toHaveBeenCalledTimes(1);
    const view = state.current.open[PATH]!;
    expect(view.trimmed?.deferred).toBe(true);
    expect(view.trimmed?.reads).toBe(1);
    expect(measureView(view).bytes).toBe(before);
  });

  it("stays bounded through many trims, spending at most two reads each", async () => {
    let state = { current: trimmed("u10") };
    let reads = 0;
    for (let round = 0; round < 6; round++) {
      const stamp = `2026-01-0${round + 1}T00:00:00.000Z`;
      state.current = reduce(state.current, { type: "views/trim", paths: [PATH], keepBytes: 32 * 1024, at: stamp,
        standing: { anchorEntryId: "u10" } });
      const { history, request } = loader(state, async () => ({ entries: [entry("u58", "u57", "tail")], leafId: "u59", window: window() }));
      await history.reconcile(PATH);
      await history.reconcile(PATH);
      await history.reconcile(PATH);
      reads += request.mock.calls.length;
      expect(request.mock.calls.length).toBeLessThanOrEqual(RECONCILE_MAX_READS);
      expect(measureView(state.current.open[PATH]!).bytes).toBeLessThanOrEqual(32 * 1024 + 4096);
    }
    expect(reads).toBeLessThanOrEqual(RECONCILE_MAX_READS * 6);
  });

  it("keeps a streaming turn, a running tool and an unsent prompt that arrived while it was reading", async () => {
    const state = { current: trimmed("u58") };
    // A live turn, a tool and the person's own unsent words land while the
    // replacement page is in flight.
    let release: ((value: unknown) => void) | undefined;
    const gate = new Promise(resolve => { release = resolve; });
    const { history, request } = loader(state, async () => {
      await gate;
      return { entries: [entry("u58", "u57", "kept"), entry("u59", "u58", "tail")], leafId: "u59", window: window({ live: { running: true, tools: [] } }) };
    });
    const reading = history.reconcile(PATH);
    await Promise.resolve();
    const update = (seq: number, value: unknown) => {
      state.current = reduce(state.current, { type: "notification", method: "session/update", params: { sessionPath: PATH, seq, at: "", update: value } } as never);
    };
    update(100, { kind: "message_start", role: "assistant" });
    update(101, { kind: "text_delta", delta: "a live answer", contentIndex: 0 });
    update(102, { kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    state.current = reduce(state.current, { type: "optimisticUser", path: PATH, text: "mine, not sent", images: [], id: "unsent" } as never);
    release!(undefined);
    await reading;

    const view = state.current.open[PATH]!;
    expect(request).toHaveBeenCalledTimes(1);
    expect(view.trimmed).toBeUndefined();
    // Everything that was in flight is still here.
    expect(view.blocks.some(block => block.kind === "assistant" && block.text.includes("a live answer"))).toBe(true);
    expect(view.blocks.some(block => block.kind === "tool" && block.id === "t1")).toBe(true);
    expect(view.blocks.some(block => block.kind === "user" && block.optimistic === true)).toBe(true);
    // And the page itself was committed.
    expect(view.entries.map(row => (row as { id: string }).id)).toEqual(["u58", "u59"]);
    expect(view.lastSeq).toBeGreaterThanOrEqual(102);
  });

  it("settles a turn that ended while it was reading, rather than rewinding it", async () => {
    const state = { current: trimmed("u58") };
    let release: ((value: unknown) => void) | undefined;
    const gate = new Promise(resolve => { release = resolve; });
    const { history } = loader(state, async () => {
      await gate;
      return { entries: [entry("u58", "u57", "kept")], leafId: "u58", window: window() };
    });
    const reading = history.reconcile(PATH);
    await Promise.resolve();
    const update = (seq: number, value: unknown) => {
      state.current = reduce(state.current, { type: "notification", method: "session/update", params: { sessionPath: PATH, seq, at: "", update: value } } as never);
    };
    update(200, { kind: "message_start", role: "assistant" });
    update(201, { kind: "text_delta", delta: "done", contentIndex: 0 });
    update(202, { kind: "message_end", role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    update(203, { kind: "agent_settled" });
    release!(undefined);
    await reading;
    const view = state.current.open[PATH]!;
    expect(view.blocks.some(block => block.kind === "assistant" && block.text.includes("done") && block.streaming !== true)).toBe(true);
    expect(view.lastSeq).toBeGreaterThanOrEqual(203);
  });

  it("sends no page of its own when an ordinary read already replaced the trim", async () => {
    const state = { current: trimmed("u58") };
    const { history, request } = loader(state, async () => ({
      entries: [entry("u58", "u57", "kept"), entry("u59", "u58", "tail")], leafId: "u59", window: window(),
    }));
    // An ordinary history read is already in flight for this path. It clears
    // the trim when it commits, so the reconciliation that queues behind it
    // must ask nothing of its own.
    const ordinary = history.read(PATH);
    const reconciled = history.reconcile(PATH);
    await Promise.all([ordinary, reconciled]);
    expect(state.current.open[PATH]!.trimmed).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses a page that belongs to another stamp", async () => {
    const state = { current: trimmed("u58") };
    const at = state.current.open[PATH]!.trimmed!.at;
    const kept = [entry("u58", "u57", "tail")];
    state.current = reduce(state.current, { type: "views/reconcile", path: PATH, at: `${at}-other`, entries: kept, leafId: "u59", window: window() as never });
    expect(state.current.open[PATH]!.trimmed?.at).toBe(at);
    expect(state.current.open[PATH]!.entries.length).toBeGreaterThan(kept.length);
  });
});
