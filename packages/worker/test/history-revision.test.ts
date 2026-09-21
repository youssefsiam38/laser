/**
 * The live half of the durable revision contract (RP-9).
 *
 * The interesting cases are the ones only a live engine can produce: a leaf
 * that sits behind the last stored record because someone jumped, and the
 * fold being continued across many reads rather than recomputed.
 */
import { describe, expect, it } from "vitest";
import { environmentTagOf, isEnvironmentKey, isSessionRevision, sessionRevisionOf } from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";
import { SessionRevisionTracker, branchIds } from "../src/history-revision.js";

const header = { id: "session-1", cwd: "/project", version: 3 };
const entry = (id: string, parentId: string | null, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";
const history = [entry("e0", null, "one"), entry("e1", "e0", "two"), entry("e2", "e1", "three")];

describe("a live conversation's revision", () => {
  it("is the same value whether it was folded in one read or grown over many", () => {
    const grown = new SessionRevisionTracker(ENVIRONMENT);
    grown.compute(header, history.slice(0, 1), "e0");
    grown.compute(header, history.slice(0, 2), "e1");
    const incremental = grown.compute(header, history, "e2");
    const fresh = new SessionRevisionTracker(ENVIRONMENT).compute(header, history, "e2");
    expect(incremental.revision).toBe(fresh.revision);
    expect(isSessionRevision(incremental.revision)).toBe(true);
    expect(isEnvironmentKey(incremental.environmentKey)).toBe(true);
    // The same fold a worker-free reader would produce from the same records.
    expect(incremental.revision).toBe(sessionRevisionOf(nodeRevisionHasher, environmentTagOf(nodeRevisionHasher, ENVIRONMENT), incremental.state));
  });

  it("treats Pi-shaped compaction and branch-summary appends as replacement barriers", () => {
    for (const type of ["compaction", "branch_summary"] as const) {
      const tracker = new SessionRevisionTracker(ENVIRONMENT);
      const before = tracker.compute(header, history, "e2").revision;
      const barrier = {
        type,
        id: `${type}-1`,
        parentId: "e2",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: "Earlier context summarized",
        tokensBefore: 1000,
      };
      const appended = [...history, barrier];
      const after = tracker.compute(header, appended, barrier.id);
      expect(after.revision).not.toBe(before);
      expect(tracker.classify(before, header, appended, barrier.id)).toBe("stale");
      // Stale for a suffix merge, but the state behind the base is still
      // proved: the rows before it are unchanged, so an older page against it
      // is exact. This is what keeps "scroll up" alive after an auto-compaction.
      const resolved = tracker.resolve(before, header, appended, barrier.id);
      expect(resolved).toMatchObject({ base: "stale", barrier: true, state: { count: history.length, leafId: "e2" } });
      // A base whose leaf left the branch carries nothing, barrier or not.
      const forked = [...appended, entry("f0", "e0", "elsewhere")];
      expect(tracker.resolve(before, header, forked, "f0")).toEqual({ base: "stale" });
    }
  });

  it("belongs to one environment, and to one session", () => {
    const mine = new SessionRevisionTracker(ENVIRONMENT).compute(header, history, "e2");
    const theirs = new SessionRevisionTracker("22222222-2222-3333-4444-555555555555").compute(header, history, "e2");
    expect(theirs.revision).not.toBe(mine.revision);
    expect(theirs.environmentKey).not.toBe(mine.environmentKey);
    const forked = new SessionRevisionTracker(ENVIRONMENT).compute({ ...header, id: "session-2" }, history, "e2");
    expect(forked.revision).not.toBe(mine.revision);
  });

  it("distinguishes a leaf the file cannot show, and still proves what extends it", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const atTail = tracker.compute(header, history, "e2").revision;
    // A jump moves the leaf without appending anything: a state that exists in
    // this process and nowhere on disk.
    const jumped = tracker.compute(header, history, "e1").revision;
    expect(jumped).not.toBe(atTail);
    expect(tracker.classify(jumped, header, history, "e1")).toBe("current");
    // The view that was at the tail is now on an abandoned branch.
    expect(tracker.classify(atTail, header, history, "e1")).toBe("stale");

    // Work continues from the jumped-to leaf. The client cached at that exact
    // live state, which no checkpoint could reconstruct, is still a prefix.
    const continued = [...history, entry("e3", "e1", "four")];
    expect(tracker.classify(jumped, header, continued, "e3")).toBe("prefix");
    expect(tracker.classify(atTail, header, continued, "e3")).toBe("stale");
  });

  it("keeps a prefix across a 909-row turn, and still invalidates on compaction", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const before = tracker.compute(header, history, "e2").revision;
    const long: unknown[] = [...history];
    let parent = "e2";
    for (let i = 0; i < 909; i++) {
      const id = `t${i}`;
      long.push(entry(id, parent, `step ${i}`));
      parent = id;
    }
    expect(tracker.classify(before, header, long, parent)).toBe("prefix");
    const compacted = [...long, {
      type: "compaction",
      id: "compact-1",
      parentId: parent,
      timestamp: "2026-01-01T00:00:02.000Z",
      summary: "Earlier context summarized",
      tokensBefore: 1000,
    }];
    expect(tracker.classify(before, header, compacted, "compact-1")).toBe("stale");
    expect(tracker.resolve(before, header, compacted, "compact-1")).toMatchObject({ base: "stale", barrier: true, state: { count: history.length } });
    const tip = tracker.compute(header, long, parent).revision;
    expect(tracker.classify(tip, header, compacted, "compact-1")).toBe("stale");
    expect(tracker.resolve(tip, header, compacted, "compact-1")).toMatchObject({ base: "stale", barrier: true, state: { count: long.length, leafId: parent } });
  });

  it("refuses a base it cannot prove instead of assuming it is old", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    tracker.compute(header, history, "e2");
    expect(tracker.classify("r1.ZZZZZZZZ.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ", header, history, "e2")).toBe("stale");
    expect(tracker.classify("nonsense", header, history, "e2")).toBe("stale");
    const elsewhere = new SessionRevisionTracker("33333333-2222-3333-4444-555555555555").compute(header, history.slice(0, 2), "e1").revision;
    expect(tracker.classify(elsewhere, header, history, "e2")).toBe("stale");
  });
});

describe("the branch a delta may extend", () => {
  it("is the path from the leaf to the root, and nothing beside it", () => {
    const sibling = entry("other", "e0", "another version");
    expect(branchIds([...history, sibling], "e2")).toEqual(new Set(["e0", "e1", "e2"]));
    expect(branchIds([...history, sibling], "other")).toEqual(new Set(["e0", "other"]));
    expect(branchIds(history, null)).toEqual(new Set());
    // A broken chain stops where it breaks rather than looping forever.
    expect(branchIds([entry("a", "b", "x"), entry("b", "a", "y")], "a")).toEqual(new Set(["a", "b"]));
  });
});
