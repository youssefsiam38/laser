/**
 * RP-5b acceptance A11: what releasing the older part of a conversation costs
 * the person, which is nothing they can lose.
 *
 * The session stays open and usable, the streaming turn and anything waiting
 * for an answer stay, prompts keep their ordinals, and what went is read again
 * through the ordinary bounded tail read — no new request, no new authority.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "@lasercode/protocol";

import { createHistoryLoader } from "../../src/runtime/history-loader.js";
import { initialState, reduce, type Action, type AppState } from "../../src/store.js";
import { trimView } from "../../src/view-summary.js";
import { blockBytes, measureView } from "../../src/runtime/view-measure.js";
import { BODY_EXCERPT_MAX_BYTES } from "../../src/runtime/body-excerpt.js";

const CWD = "/p";
const path = `${CWD}/s.jsonl`;
const state = (over: Partial<SessionState> = {}): SessionState => ({
  path, id: "id", cwd: CWD, messageCount: 12, pendingMessageCount: 0, isStreaming: false, isCompacting: false, ...over,
} as SessionState);

const entry = (index: number) => ({
  id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, type: "message",
  message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${index} ${"x".repeat(2048)}` }] },
});

const window = (over: Record<string, unknown> = {}) => ({
  epoch: "w1", seq: 20, revision: "r1.env.20", environmentKey: "e1.key", userOffset: 0, complete: true,
  branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], anchor: "e0", before: "cursor-older", ...over,
});

function loaded(): AppState {
  let next = reduce({ ...initialState, connection: "open" }, { type: "opened", state: state() });
  next = { ...next, current: path };
  next = reduce(next, { type: "historyBegin", path, token: "t" });
  const entries = Array.from({ length: 20 }, (_, index) => entry(index));
  next = reduce(next, { type: "historySnapshot", path, token: "t", entries, leafId: "e19", window: window() as never });
  return next;
}

describe("releasing the older part of a conversation somebody is using", () => {
  it("keeps the newest turns, raises the prompt offset and drops the cursor it cannot mint", () => {
    const before = loaded().open[path]!;
    const result = trimView(before, { keepBytes: 8 * 1024, measure: blockBytes }, "2026-09-15T00:00:00.000Z");

    expect(result.releasedBlocks).toBeGreaterThan(0);
    const after = result.view;
    expect(after.dormant).toBeUndefined();
    expect(after.blocks.length).toBeLessThan(before.blocks.length);
    // The newest turn is still here, and it is the same block object.
    expect(after.blocks.at(-1)).toBe(before.blocks.at(-1));
    // Ordinals keep their meaning: the offset rises by exactly the prompts released.
    expect(after.history?.userOffset).toBe(result.releasedPrompts);
    expect(after.history?.complete).toBe(false);
    expect(after.history?.before).toBeUndefined();
    expect(after.history?.anchor).toBe((after.entries[0] as { id: string }).id);
    expect(after.trimmed).toEqual({ at: "2026-09-15T00:00:00.000Z", prompts: result.releasedPrompts });
    // Records and blocks go together: no record is left behind without its row.
    const ids = new Set(after.blocks.flatMap(block => "entryId" in block && block.entryId ? [block.entryId] : []));
    for (const record of after.entries) expect(ids.has((record as { id: string }).id)).toBe(true);
  });

  it("never releases the streaming turn, an unsent prompt or a row being asked about", () => {
    let live = loaded();
    live = reduce(live, { type: "optimisticUser", path, text: "mine, not sent yet", images: [], id: "unsent" });
    live = reduce(live, { type: "notification", method: "session/update", params: { sessionPath: path, seq: 30, at: "",
      update: { kind: "message_start", role: "assistant" } } } as never);
    live = reduce(live, { type: "notification", method: "session/update", params: { sessionPath: path, seq: 31, at: "",
      update: { kind: "text_delta", delta: "streaming" } } } as never);

    const view = live.open[path]!;
    const result = trimView(view, { keepBytes: 0, measure: blockBytes }, "2026-09-15T00:00:00.000Z");
    const kept = result.view.blocks;
    expect(kept.some(block => block.kind === "user" && block.optimistic === true)).toBe(true);
    expect(kept.some(block => block.kind === "assistant" && block.streaming)).toBe(true);
    // Nothing was cancelled or answered on the person's behalf.
    expect(result.view.state.isStreaming).toBe(view.state.isStreaming);
    expect(result.view.pending).toEqual(view.pending);
    expect(result.view.queue).toEqual(view.queue);
    expect(result.view.dialogs).toEqual(view.dialogs);
  });

  it("reads the released part again through the ordinary bounded tail read", async () => {
    let store = loaded();
    const dispatch = (action: Action) => { store = reduce(store, action); };
    const trimmed = trimView(store.open[path]!, { keepBytes: 8 * 1024, measure: blockBytes }, "2026-09-15T00:00:00.000Z").view;
    store = { ...store, open: { ...store.open, [path]: trimmed } };

    const entries = Array.from({ length: 6 }, (_, index) => entry(14 + index));
    const request = vi.fn(async () => ({ entries, leafId: "e19", window: window({ userOffset: 14, complete: false, before: "cursor-fresh" }) }));
    const loader = createHistoryLoader({
      get: (candidate) => store.open[candidate],
      request: request as never,
      dispatch,
      adoptEpoch: () => {},
      track: () => {},
    });

    await loader.recent(path, () => true);

    // One ordinary bounded read, carrying the per-body limit this surface can hold.
    expect(request).toHaveBeenCalledWith({ path, window: { tail: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
    const after = store.open[path]!;
    expect(after.trimmed).toBeUndefined();
    // A fresh cursor came back with it, so paging further back works again.
    expect(after.history?.before).toBe("cursor-fresh");
    expect(measureView(after).bytes).toBeGreaterThan(0);
  });
});
