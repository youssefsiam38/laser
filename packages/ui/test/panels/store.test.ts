import { describe, expect, it } from "vitest";
import type { RunPanel, StreamPanel } from "@piorbit/protocol";

import {
  CLOSED_TTL_MS,
  RING_CAPACITY,
  STALE_MS,
  attentionOfEntry,
  closePanel,
  elapsedOf,
  emptyPanels,
  entriesForPath,
  fleetSummary,
  markSeen,
  panelKey,
  prunePanels,
  pushSnapshot,
  reconcilePath,
  upsertPanel,
  velocityOf,
} from "../../src/panels/store.js";

const stream = (bytes: number, over: Partial<StreamPanel> = {}): StreamPanel => ({
  kind: "stream",
  id: "log",
  source: "bash",
  title: "pnpm test",
  intent: "follow",
  encoding: "text",
  ref: "file:/tmp/out.log",
  bytes,
  follow: true,
  ...over,
});

const run = (over: Partial<RunPanel> = {}): RunPanel => ({
  kind: "run",
  id: "w2",
  source: "pi-subagents",
  title: "worker#2",
  intent: "follow",
  lifecycle: "running",
  ...over,
});

describe("ring", () => {
  it("keeps the newest RING_CAPACITY samples and replaces a same-instant sample", () => {
    let ring = pushSnapshot([], { at: 0, bytes: 0 });
    for (let i = 1; i <= RING_CAPACITY + 3; i++) ring = pushSnapshot(ring, { at: i * 1000, bytes: i * 100 });
    expect(ring).toHaveLength(RING_CAPACITY);
    expect(ring[0]!.at).toBe(4000);
    ring = pushSnapshot(ring, { at: ring.at(-1)!.at, bytes: 9999 });
    expect(ring).toHaveLength(RING_CAPACITY);
    expect(ring.at(-1)!.bytes).toBe(9999);
  });

  it("derives bytes per second over the window, and decays to zero when the stream stalls", () => {
    expect(velocityOf([], 0)).toBeUndefined();
    const ring = [
      { at: 0, bytes: 0 },
      { at: 1000, bytes: 1024 },
      { at: 2000, bytes: 2048 },
    ];
    expect(velocityOf(ring, 2000)).toBe(1024);
    // Fresh enough: the last sample stands.
    expect(velocityOf(ring, 2000 + STALE_MS)).toBe(1024);
    // Stale: the window extends to `now` with no growth.
    expect(velocityOf(ring, 2000 + STALE_MS + 2000)).toBeCloseTo((2048 * 1000) / (4000 + STALE_MS), 3);
    expect(velocityOf(ring, 200_000)).toBeLessThan(11);
    // One sample and stale: rate is zero, not unknown — the thing exists and has not moved.
    expect(velocityOf([{ at: 0, bytes: 500 }], STALE_MS + 1)).toBe(0);
    expect(velocityOf([{ at: 0, bytes: 500 }], 100)).toBeUndefined();
  });
});

describe("upsertPanel", () => {
  it("replaces in place, dedupes identical re-emits, and samples liveness", () => {
    let s = upsertPanel(emptyPanels, "/s", stream(100), 1000);
    const key = panelKey("/s", "log");
    expect(s.order).toEqual([key]);
    expect(s.entries[key]!.ring).toEqual([{ at: 1000, bytes: 100 }]);

    const same = upsertPanel(s, "/s", stream(100), 2000);
    expect(same).toBe(s); // at-least-once delivery is normal (R9)

    s = upsertPanel(s, "/s", stream(300), 3000);
    expect(s.order).toEqual([key]); // never stacks (R6)
    expect(s.entries[key]!.ring).toEqual([
      { at: 1000, bytes: 100 },
      { at: 3000, bytes: 300 },
    ]);
    expect(velocityOf(s.entries[key]!.ring, 3000)).toBe(100);
  });

  it("keeps creation order when an older panel updates", () => {
    let s = upsertPanel(emptyPanels, "/s", run({ id: "a" }), 1);
    s = upsertPanel(s, "/s", run({ id: "b" }), 2);
    s = upsertPanel(s, "/s", run({ id: "a", activity: "reading" }), 3);
    expect(s.order.map((k) => s.entries[k]!.panel.id)).toEqual(["a", "b"]);
  });

  it("resets `seen` when a run reaches a terminal state, so finished_unread lights up", () => {
    let s = upsertPanel(emptyPanels, "/s", run(), 1);
    const key = panelKey("/s", "w2");
    s = markSeen(s, key);
    expect(attentionOfEntry(s.entries[key]!)).toBe("working");
    s = upsertPanel(s, "/s", run({ lifecycle: "done" }), 2);
    expect(s.entries[key]!.seen).toBe(false);
    expect(attentionOfEntry(s.entries[key]!)).toBe("finished_unread");
    s = markSeen(s, key);
    expect(attentionOfEntry(s.entries[key]!)).toBe("idle");
  });
});

describe("close, prune, reconcile", () => {
  it("a closed panel says why for a while, then goes", () => {
    let s = upsertPanel(emptyPanels, "/s", run(), 1);
    const key = panelKey("/s", "w2");
    s = closePanel(s, "/s", "w2", "finished", 10);
    expect(s.entries[key]!.closed).toEqual({ at: 10, reason: "finished" });
    expect(attentionOfEntry(s.entries[key]!)).toBe("idle");
    expect(prunePanels(s, 10 + CLOSED_TTL_MS - 1)).toBe(s);
    const pruned = prunePanels(s, 10 + CLOSED_TTL_MS);
    expect(pruned.order).toEqual([]);
    // A re-emit after a close reopens the same entry rather than stacking a second one.
    const reopened = upsertPanel(s, "/s", run({ activity: "again" }), 20);
    expect(reopened.order).toEqual([key]);
    expect(reopened.entries[key]!.closed).toBeUndefined();
  });

  it("reconciles a session against the host's list without touching fallback panels", () => {
    let s = upsertPanel(emptyPanels, "/s", run({ id: "a" }), 1);
    s = upsertPanel(s, "/s", run({ id: "b" }), 2);
    s = upsertPanel(s, "/s", stream(10, { id: "ui:widget:x" }), 3, { fallback: true });
    s = upsertPanel(s, "/other", run({ id: "c" }), 4);
    s = reconcilePath(s, "/s", [run({ id: "b", activity: "still here" }), run({ id: "d" })], 5);
    const byId = Object.fromEntries(entriesForPath(s, "/s").map((e) => [e.panel.id, e]));
    expect(byId["a"]!.closed?.reason).toBe("ended while you were away");
    expect(byId["b"]!.closed).toBeUndefined();
    expect((byId["b"]!.panel as RunPanel).activity).toBe("still here");
    expect(byId["d"]).toBeDefined();
    expect(byId["ui:widget:x"]!.closed).toBeUndefined();
    expect(entriesForPath(s, "/other")).toHaveLength(1);
  });
});

describe("fleet and elapsed", () => {
  it("counts running runs and anything waiting for you, across sessions", () => {
    let s = upsertPanel(emptyPanels, "/a", run({ id: "1" }), 1);
    s = upsertPanel(s, "/b", run({ id: "2", lifecycle: "queued" }), 1);
    s = upsertPanel(s, "/b", run({ id: "3", lifecycle: "done" }), 1);
    s = upsertPanel(
      s,
      "/c",
      { kind: "decision", id: "d", source: "x", title: "?", intent: "inspect", blocking: "turn", fields: [{ id: "f", label: "f", type: "confirm" }] },
      1,
    );
    expect(fleetSummary(s)).toEqual({ running: 2, needsYou: 1 });
  });

  it("a run's clock runs from startedAt to endedAt, or to now while it runs", () => {
    const s = upsertPanel(emptyPanels, "/s", run({ startedAt: new Date(10_000).toISOString() }), 12_000);
    const entry = s.entries[panelKey("/s", "w2")]!;
    expect(elapsedOf(entry, 15_000)).toBe(5000);
    const done = upsertPanel(s, "/s", run({ startedAt: new Date(10_000).toISOString(), endedAt: new Date(13_000).toISOString(), lifecycle: "done" }), 14_000);
    expect(elapsedOf(done.entries[panelKey("/s", "w2")]!, 99_000)).toBe(3000);
  });
});

describe("a stream that shrank", () => {
  it("starts its ring over instead of reporting a negative rate", () => {
    let s = upsertPanel(emptyPanels, "/s", stream(800), 1000);
    s = upsertPanel(s, "/s", stream(900), 2000);
    s = upsertPanel(s, "/s", stream(0), 3000);
    const key = panelKey("/s", "log");
    expect(s.entries[key]!.ring).toEqual([{ at: 3000, bytes: 0 }]);
    s = upsertPanel(s, "/s", stream(100), 4000);
    expect(velocityOf(s.entries[key]!.ring, 4000)).toBe(100);
  });
});
