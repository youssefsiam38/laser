/**
 * What crosses the RP-10 seam: a frozen, bounded record of strings, captured
 * from bytes that are still there and sharing nothing with the view it came
 * from.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "@lasercode/protocol";

import { captureViewTail, installViewTailSink, NO_TAIL_SINK, VIEW_TAIL_MAX_BYTES, VIEW_TAIL_MAX_ENTRIES, viewTailSink } from "../../src/runtime/view-tail.js";
import type { SessionView, ValidatedRevision } from "../../src/store.js";

const AT = "2026-09-15T02:00:00.000Z";
const validated: ValidatedRevision = { revision: "r1.env.abc", environmentKey: "e1.key", epoch: "w1", seq: 12, hasHistory: true, at: AT };

const view = (over: Partial<SessionView> = {}): SessionView => ({
  path: "/p/a.jsonl",
  state: { path: "/p/a.jsonl", cwd: "/p", messageCount: 2, pendingMessageCount: 0, isStreaming: false, isCompacting: false } as SessionState,
  blocks: [], lastSeq: 12, running: false, queue: { steering: [], followUp: [] }, pending: [], dialogs: [],
  statuses: {}, widgets: {}, openedAt: AT, hydrated: true, entries: [], capabilities: [], goal: null, namerLabels: {},
  leafId: "e3", validated,
  ...over,
});

const entries = (count: number, size = 16): unknown[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, type: "message",
    message: { role: "user", content: [{ type: "text", text: "x".repeat(size) }] },
  }));

describe("the released tail", () => {
  it("is frozen, carries only strings, and keeps the newest rows", () => {
    const tail = captureViewTail(view({ entries: entries(10) }), AT);
    expect(Object.isFrozen(tail)).toBe(true);
    expect(Object.isFrozen(tail.entries)).toBe(true);
    expect(tail.entries.every((entry) => Object.isFrozen(entry) && typeof entry.json === "string")).toBe(true);
    expect(tail.entries.map((entry) => entry.id)).toEqual(entries(10).map((row) => (row as { id: string }).id));
    expect(tail.revision).toBe("r1.env.abc");
    expect(tail.environmentKey).toBe("e1.key");
    expect(tail.leafId).toBe("e3");
    expect(tail.truncated).toBe(false);
    expect(tail.bytes).toBeGreaterThan(0);
  });

  it("shares nothing with the view it was taken from", () => {
    const rows = entries(3);
    const tail = captureViewTail(view({ entries: rows }), AT);
    for (const entry of tail.entries) {
      expect(rows.includes(entry as unknown)).toBe(false);
      expect(typeof entry.json).toBe("string");
    }
    // Mutating the source afterwards cannot change what was captured.
    (rows[0] as { message: { content: unknown[] } }).message.content = [{ type: "text", text: "changed" }];
    expect(tail.entries[0]!.json.includes("changed")).toBe(false);
  });

  it("stops at the entry bound, newest first", () => {
    const tail = captureViewTail(view({ entries: entries(VIEW_TAIL_MAX_ENTRIES + 25) }), AT);
    expect(tail.entries).toHaveLength(VIEW_TAIL_MAX_ENTRIES);
    expect(tail.truncated).toBe(true);
    expect(tail.entries.at(-1)!.id).toBe(`e${VIEW_TAIL_MAX_ENTRIES + 24}`);
  });

  it("stops at the byte bound", () => {
    const tail = captureViewTail(view({ entries: entries(20, 40_000) }), AT);
    expect(tail.bytes).toBeLessThanOrEqual(VIEW_TAIL_MAX_BYTES);
    expect(tail.truncated).toBe(true);
    expect(tail.entries.length).toBeLessThan(20);
  });

  it("writes nothing it could not validate later", () => {
    const tail = captureViewTail(view({ entries: entries(4), validated: undefined }), AT);
    expect(tail.omitted).toBe("no-revision");
    expect(tail.entries).toEqual([]);
    expect(tail.bytes).toBe(0);
  });

  it("skips an entry it cannot serialize rather than failing the release", () => {
    const circular: Record<string, unknown> = { id: "bad", parentId: null, type: "message" };
    circular["self"] = circular;
    const tail = captureViewTail(view({ entries: [...entries(2), circular] }), AT);
    expect(tail.entries.map((entry) => entry.id)).toEqual(["e0", "e1"]);
  });
});

describe("the sink RP-10 installs", () => {
  it("defaults to nothing, takes a replacement, and hands back what it replaced", () => {
    const first = { release: vi.fn() };
    const second = { release: vi.fn() };
    const original = installViewTailSink(first);
    expect(original).toBe(NO_TAIL_SINK);
    expect(viewTailSink()).toBe(first);

    const replaced = installViewTailSink(second);
    expect(replaced).toBe(first);
    expect(viewTailSink()).toBe(second);

    // Restoring is the same call with what it gave back.
    installViewTailSink(replaced);
    expect(viewTailSink()).toBe(first);
    installViewTailSink(original);
    expect(viewTailSink()).toBe(NO_TAIL_SINK);
    // The default takes a tail and does nothing with it.
    expect(() => viewTailSink().release(captureViewTail(view(), AT))).not.toThrow();
    expect(first.release).not.toHaveBeenCalled();
    expect(second.release).not.toHaveBeenCalled();
  });

  it("is read when a tail is delivered, not when the release was decided", () => {
    const late = { release: vi.fn() };
    const original = installViewTailSink(undefined);
    try {
      // What a cache installed between the release and its delivery sees.
      const tail = captureViewTail(view({ entries: entries(2) }), AT);
      installViewTailSink(late);
      viewTailSink().release(tail);
      expect(late.release).toHaveBeenCalledWith(tail);
      // And a cache that has gone by then sees nothing.
      installViewTailSink(undefined);
      viewTailSink().release(tail);
      expect(late.release).toHaveBeenCalledTimes(1);
    } finally {
      installViewTailSink(original);
    }
  });
});
