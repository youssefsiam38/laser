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

function loader(state: { current: AppState }, reply: () => Promise<unknown>) {
  const request = vi.fn(async () => (await reply()) as never);
  const dispatch = vi.fn((action: never) => { state.current = reduce(state.current, action); });
  const history = createHistoryLoader({
    get: (path: string) => state.current.open[path],
    request: request as never,
    dispatch: dispatch as never,
    adoptEpoch: () => {},
    track: () => {},
  });
  return { history, request, dispatch };
}

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

  it("spends at most two reads for one stamp, and a person may still ask", async () => {
    const state = { current: trimmed("u10") };
    const { history, request } = loader(state, async () => ({ entries: [entry("u58", "u57", "tail")], leafId: "u59", window: window() }));
    for (let attempt = 0; attempt < 5; attempt++) await history.reconcile(PATH);
    expect(request).toHaveBeenCalledTimes(RECONCILE_MAX_READS);
    expect(state.current.open[PATH]!.trimmed?.reads).toBe(RECONCILE_MAX_READS);
    // Explicitly asked for: allowed, and it succeeds this time.
    const containing = [entry("u10", "u9", "kept"), entry("u59", "u10", "tail")];
    const explicit = loader(state, async () => ({ entries: containing, leafId: "u59", window: window() }));
    await explicit.history.reconcile(PATH, () => true, { explicit: true });
    expect(explicit.request).toHaveBeenCalledTimes(1);
    expect(state.current.open[PATH]!.trimmed).toBeUndefined();
    // And the cursor is back: ordinary paging works from here.
    expect(state.current.open[PATH]!.history).toBeDefined();
  });

  it("does nothing for a background view, and nothing for a failed read beyond spending it", async () => {
    const state = { current: trimmed("u10", { path: OTHER }) };
    const { history, request } = loader(state, async () => { throw new Error("network"); });
    const before = measureView(state.current.open[OTHER]!).bytes;
    await history.reconcile(OTHER);
    expect(request).toHaveBeenCalledTimes(1);
    const view = state.current.open[OTHER]!;
    expect(view.trimmed?.deferred).toBe(true);
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

  it("refuses a page that belongs to another stamp", async () => {
    const state = { current: trimmed("u58") };
    const at = state.current.open[PATH]!.trimmed!.at;
    const kept = [entry("u58", "u57", "tail")];
    state.current = reduce(state.current, { type: "views/reconcile", path: PATH, at: `${at}-other`, entries: kept, leafId: "u59", window: window() as never });
    expect(state.current.open[PATH]!.trimmed?.at).toBe(at);
    expect(state.current.open[PATH]!.entries.length).toBeGreaterThan(kept.length);
  });
});
