/**
 * What crosses the RP-10 seam: a frozen, bounded record of strings, captured
 * from bytes that are still there and sharing nothing with the view it came
 * from.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "@lasercode/protocol";

import { captureViewTail, installViewTailSink, NO_TAIL_SINK, VIEW_TAIL_MAX_BYTES, VIEW_TAIL_MAX_ENTRIES, VIEW_TAIL_SESSION_ID_MAX, viewTailRetainedBytes, viewTailSink } from "../../src/runtime/view-tail.js";
import type { SessionView, ValidatedRevision } from "../../src/store.js";

const AT = "2026-09-15T02:00:00.000Z";
const validated: ValidatedRevision = { revision: "r1.env.abc", sessionId: "01a0a319-1f1c-75f3", environmentKey: "e1.key", epoch: "w1", seq: 12, hasHistory: true, at: AT };

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
    expect(tail.sessionId).toBe("01a0a319-1f1c-75f3");
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

  it("counts exactly the UTF-8 bytes of what it carries, identity included", () => {
    const rows = entries(3, 24);
    const tail = captureViewTail(view({ entries: rows }), AT);
    const expected = tail.entries.reduce((sum, entry) => sum + new TextEncoder().encode(entry.json).length, 0);
    expect(tail.bytes).toBe(expected);
    // The session id is identity, not content: it changes no byte accounting.
    const other = captureViewTail(view({ entries: rows, validated: { ...validated, sessionId: "a-much-longer-session-identity" } }), AT);
    expect(other.bytes).toBe(tail.bytes);
  });

  it("refuses a record RP-10 could not key: no session id, or one out of bounds", () => {
    const { sessionId: _none, ...withoutId } = validated;
    const anonymous = captureViewTail(view({ entries: entries(4), validated: withoutId }), AT);
    expect(anonymous.omitted).toBe("no-session-id");
    expect(anonymous.sessionId).toBe("");
    expect(anonymous.entries).toEqual([]);

    const huge = captureViewTail(view({ entries: entries(4), validated: { ...validated, sessionId: "x".repeat(VIEW_TAIL_SESSION_ID_MAX + 1) } }), AT);
    expect(huge.omitted).toBe("no-session-id");
    expect(huge.entries).toEqual([]);
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

describe("what holding a record costs", () => {
  const utf8 = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

  it("is the exact UTF-8 size of the whole record, not of the entries in it", () => {
    const tail = captureViewTail(view({ entries: entries(6, 40) }), AT);
    expect(viewTailRetainedBytes(tail)).toBe(utf8(tail));
    // Identity, cursors and structure are memory too: the content contract
    // RP-10 reads is strictly smaller.
    expect(viewTailRetainedBytes(tail)).toBeGreaterThan(tail.bytes);
  });

  it("counts a record that carries no entry at all", () => {
    const longPath = `/p/${"nested/".repeat(20)}conversation.jsonl`;
    const identity = "s".repeat(VIEW_TAIL_SESSION_ID_MAX);
    const omitted = captureViewTail(view({ path: longPath, entries: entries(3), validated: undefined }), AT);
    expect(omitted.bytes).toBe(0);
    expect(viewTailRetainedBytes(omitted)).toBe(utf8(omitted));
    expect(viewTailRetainedBytes(omitted)).toBeGreaterThan(longPath.length);

    const identified = captureViewTail(view({ path: longPath, entries: entries(3), validated: { ...validated, sessionId: identity } }), AT);
    expect(viewTailRetainedBytes(identified)).toBe(utf8(identified));
    expect(viewTailRetainedBytes(identified)).toBeGreaterThan(viewTailRetainedBytes(omitted));
  });

  it("counts the wrapper around many small entries", () => {
    // Long ids and parent ids, tiny content: nearly all of this record is the
    // structure the content contract does not mention.
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `entry-${"0".repeat(40)}${index}`,
      parentId: index === 0 ? null : `entry-${"0".repeat(40)}${index - 1}`,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "." }] },
    }));
    const tail = captureViewTail(view({ entries: rows }), AT);
    const retained = viewTailRetainedBytes(tail);
    expect(retained).toBe(utf8(tail));
    // Every entry's id and parent id are carried twice: once inside its JSON
    // and once beside it, and none of that is in `bytes`.
    expect(retained).toBeGreaterThan(tail.bytes * 1.5);
  });

  it("is stable for the same record and follows its content", () => {
    const small = captureViewTail(view({ entries: entries(2, 8) }), AT);
    const large = captureViewTail(view({ entries: entries(20, 800) }), AT);
    expect(viewTailRetainedBytes(small)).toBe(viewTailRetainedBytes(small));
    expect(viewTailRetainedBytes(large)).toBeGreaterThan(viewTailRetainedBytes(small));
  });
});
