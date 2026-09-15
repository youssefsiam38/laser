// @vitest-environment happy-dom
/**
 * RP-5b §2: a prompt shown in part is never edited from what is shown, and the
 * room its whole body needs is taken from the renderer's own accounting before
 * a byte of it is read.
 */
import { describe, expect, it, vi } from "vitest";
import { createStateStore } from "../../src/runtime/LaserProvider.js";
import { createViewCache, VIEW_CACHE_LIMITS } from "../../src/runtime/view-cache.js";
import { initialState, reduce } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";

const PATH = "/project/session.jsonl";

function harness() {
  const store = createStateStore(reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: PATH }) as never }));
  const cache = createViewCache({
    read: store.getSnapshot,
    dispatch: store.dispatch,
    environment: { hasDraft: () => false, heldPaths: () => [], environmentKey: () => "env" } as never,
    schedule: (run: () => void) => { run(); return () => {}; },
  } as never);
  return { store, cache };
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
