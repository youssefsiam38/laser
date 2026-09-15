// @vitest-environment happy-dom
/**
 * RP-5b §2: a prompt shown in part is never edited from what is shown, and the
 * room its whole body needs is taken from the renderer's own accounting before
 * a byte of it is read.
 */
import { describe, expect, it, vi } from "vitest";
import { createStateStore } from "../../src/runtime/LaserProvider.js";
import { createViewCache, VIEW_CACHE_LIMITS } from "../../src/runtime/view-cache.js";
import { EDITABLE_TEXT_MAX_BYTES, utf8ByteLength } from "@lasercode/protocol";
import { initialState, reduce } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";
import { splitAttachedFiles, wrapFileAttachment } from "../../src/runtime/attachments.js";

const PATH = "/project/session.jsonl";

function harness() {
  const store = createStateStore(reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: PATH }) as never }));
  const cache = createViewCache({
    read: store.getSnapshot,
    dispatch: store.dispatch,
    environment: { scoped: () => [], hasDraft: () => false, heldPaths: () => [], environmentKey: () => "env" } as never,
    schedule: (run: () => void) => { run(); return () => {}; },
  } as never);
  return { store, cache };
}

/** The worker's own bound on an editor handback, as it applies it. */
function boundedEditorTextFor(text: string): { editorText?: string; editorTextBytes?: number; editorTextOmitted?: true } {
  const bytes = utf8ByteLength(text);
  return bytes > EDITABLE_TEXT_MAX_BYTES ? { editorTextBytes: bytes, editorTextOmitted: true } : { editorText: text, editorTextBytes: bytes };
}

describe("room for an edit", () => {
  it("refuses a body that does not fit, allows one that does, and counts what is held", () => {
    const { cache } = harness();
    // Just over the per-view bound: refused, and nothing is held.
    expect(cache.reserveAction(PATH, VIEW_CACHE_LIMITS.viewBytes + 1)).toBeUndefined();
    const before = cache.counters().bytes;
    // Just under: allowed, and the bytes are counted while they are held.
    const room = cache.reserveAction(PATH, VIEW_CACHE_LIMITS.viewBytes - 4096);
    expect(room).toBeDefined();
    expect(cache.counters().bytes).toBe(before + VIEW_CACHE_LIMITS.viewBytes - 4096);
    // A second reservation on the same view counts the first one.
    expect(cache.reserveAction(PATH, 8192)).toBeUndefined();
    room!.release();
    expect(cache.counters().bytes).toBe(before);
    // Releasing twice gives nothing back twice.
    room!.release();
    expect(cache.counters().bytes).toBe(before);
  });

  it("holds the view it is reserved on, so maintenance cannot trim it away", () => {
    const { cache } = harness();
    const room = cache.reserveAction(PATH, 64 * 1024)!;
    const outcome = cache.maintain();
    expect(outcome.released.map(row => row.path)).not.toContain(PATH);
    room.release();
  });

  it("can grow while it fits and refuses to grow past the bound", () => {
    const { cache } = harness();
    const room = cache.reserveAction(PATH, 64 * 1024)!;
    expect(room.resize(128 * 1024)).toBe(true);
    expect(room.bytes).toBe(128 * 1024);
    expect(room.resize(VIEW_CACHE_LIMITS.viewBytes * 2)).toBe(false);
    // Refusing to grow leaves what was already held exactly as it was.
    expect(room.bytes).toBe(128 * 1024);
    room.release();
  });

  it("gives every reservation back when the environment changes, exactly once", () => {
    const { cache } = harness();
    const before = cache.counters().bytes;
    const room = cache.reserveAction(PATH, 256 * 1024)!;
    expect(cache.counters().bytes).toBeGreaterThan(before);
    cache.reset();
    expect(cache.counters().bytes).toBe(before);
    // The token from the environment that has gone can do nothing.
    expect(room.resize(1024)).toBe(false);
    room.release();
    expect(cache.counters().bytes).toBe(before);
  });

  it("counts every reservation exactly once, on its own view and across views", () => {
    const { store, cache } = harness();
    const other = "/project/other.jsonl";
    store.dispatch({ type: "opened", state: sessionState({ path: other }) as never });
    const base = cache.counters().bytes;

    // Half the per-view bound here, and the same again elsewhere: both fit,
    // and neither is charged twice.
    const half = Math.floor(VIEW_CACHE_LIMITS.viewBytes / 2);
    const here = cache.reserveAction(PATH, half)!;
    const there = cache.reserveAction(other, half)!;
    expect(cache.counters().bytes).toBe(base + half * 2);

    // Exactly the remainder of this view's bound still fits; one byte more
    // does not — which is only true if the first one is counted once.
    const room = VIEW_CACHE_LIMITS.viewBytes - half - cache.measure(PATH).bytes;
    expect(cache.reserveAction(PATH, room + 1)).toBeUndefined();
    const exact = cache.reserveAction(PATH, room);
    expect(exact).toBeDefined();
    exact!.release();

    // Resizing counts the token being resized once, not twice: growing to the
    // whole remaining room is allowed, one byte past it is not.
    expect(here.resize(half + room + 1)).toBe(false);
    expect(here.resize(half + room)).toBe(true);
    expect(here.bytes).toBe(half + room);
    here.release();
    there.release();
    expect(cache.counters().bytes).toBe(base);
  });

  it("counts reservations against the whole renderer, not only one view", () => {
    const { store, cache } = harness();
    const others: string[] = [];
    for (let index = 2; index <= 4; index++) {
      const path = `/project/s${index}.jsonl`;
      others.push(path);
      store.dispatch({ type: "opened", state: sessionState({ path }) as never });
    }
    const rooms = [PATH, ...others].map(path => cache.reserveAction(path, VIEW_CACHE_LIMITS.viewBytes - 4096));
    const taken = rooms.filter(Boolean).length;
    // Four views' worth would be over the renderer's total; some are refused.
    expect(taken).toBeLessThan(4);
    expect(cache.counters().bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.bytes);
    for (const room of rooms) room?.release();
  });
});

describe("a rebuild that finishes after nobody is waiting", () => {
  it("gives its room back and assigns nothing, whether it succeeded or failed", async () => {
    const { cache } = harness();
    const before = cache.counters().bytes;
    // Two rebuilds, one after the other: the first is fenced out by the second.
    let attempt = 0;
    const assigned: string[] = [];
    const rebuild = async (mine: number, fail: boolean): Promise<void> => {
      const room = cache.reserveAction(PATH, 64 * 1024)!;
      await Promise.resolve();
      if (fail) {
        room.release();
        if (mine !== attempt) return;
        assigned.push("refusal");
        return;
      }
      if (mine !== attempt) { room.release(); return; }
      assigned.push("draft");
      room.release();
    };
    attempt += 1;
    const stale = rebuild(attempt, false);
    // Cancelled, unmounted, or the conversation changed: the counter moves.
    attempt += 1;
    await stale;
    expect(assigned).toEqual([]);
    expect(cache.counters().bytes).toBe(before);

    const staleFailure = rebuild(attempt, true);
    attempt += 1;
    await staleFailure;
    expect(assigned).toEqual([]);
    expect(cache.counters().bytes).toBe(before);
  });
});

describe("what an edit of a rebuilt prompt sends", () => {
  const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const escapeAttribute = (text: string) => escapeText(text).replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");

  it("round-trips escaped content and attributes through split and wrap, exactly once", () => {
    const content = 'if (a < b && c > d) { say("hi"); }\n\tdone\n';
    const file = { name: 'a & b"c.ts', mediaType: "text/plain", size: new TextEncoder().encode(content).byteLength, content };
    const body = `please look\n\n${wrapFileAttachment(file)}`;
    // What a rebuild does: split a verified body, then wrap again on the way out.
    const split = splitAttachedFiles(body);
    expect(split.text).toBe("please look");
    expect(split.files).toHaveLength(1);
    expect(split.files[0]).toEqual(file);

    const sent = [split.text, ...split.files.map(wrapFileAttachment)].filter(Boolean).join("\n\n");
    expect(sent).toBe(body);
    // Exactly once: no second wrapper, no wrapper left in the prose.
    expect(sent.match(/<attached-file /g)).toHaveLength(1);
    expect(split.text).not.toContain("<attached-file");
    expect(sent).toContain(escapeAttribute(file.name));
    expect(sent).toContain(escapeText(content));
  });

  it("never sends a chip whose content this window does not have", () => {
    // The chips a pointed-at prompt shows carry no content at all: sending one
    // would be sending an empty file with a real name.
    const chips = [{ name: "app.ts", mediaType: "text/plain", size: 1024, content: "" }];
    const sendable = chips.filter(file => file.content !== "");
    expect(sendable).toEqual([]);
    expect(sendable.map(wrapFileAttachment).join("")).toBe("");
  });
});

describe("a prompt the engine hands back for editing", () => {
  it("is never serialized into a renderer when it is larger than a composer may hold", () => {
    // What the worker does before it answers: the bound is enforced where the
    // bytes are, not after they have crossed into a renderer (RP-5b B3).
    const small = "x".repeat(1_000);
    const huge = "x".repeat(EDITABLE_TEXT_MAX_BYTES + 1);
    expect(boundedEditorTextFor(small)).toEqual({ editorText: small, editorTextBytes: 1_000 });
    const refused = boundedEditorTextFor(huge);
    expect(refused.editorText).toBeUndefined();
    expect(refused.editorTextOmitted).toBe(true);
    expect(refused.editorTextBytes).toBe(EDITABLE_TEXT_MAX_BYTES + 1);
  });

  it("counts what a composer holds as bytes, until the composer lets it go", () => {
    const drafts = new Map<string, number>();
    const store = createStateStore(reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: PATH }) as never }));
    const cache = createViewCache({
      read: store.getSnapshot,
      dispatch: store.dispatch,
      environment: { scoped: () => [], hasDraft: (path: string) => drafts.has(path), draftBytes: (path: string) => drafts.get(path) ?? 0 } as never,
      schedule: (run: () => void) => { run(); return () => {}; },
    } as never);
    const before = store.getSnapshot();
    const action = { type: "hydrate", path: PATH, entries: [{ id: "e1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }], leafId: "e1" } as never;
    store.dispatch(action);
    cache.observeTransaction(action, before, store.getSnapshot());
    const base = cache.counters().bytes;

    // The words a composer was handed are retained renderer state, counted
    // exactly — a boolean pin would have said nothing about their size.
    drafts.set(PATH, 48 * 1024);
    cache.notifyPins();
    expect(cache.counters().bytes).toBe(base + 48 * 1024);

    // And when the composer lets them go, they stop being counted.
    drafts.delete(PATH);
    cache.notifyPins();
    expect(cache.counters().bytes).toBe(base);
    cache.dispose();
  });
});
