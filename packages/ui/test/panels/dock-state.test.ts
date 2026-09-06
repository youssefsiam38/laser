import { describe, expect, it } from "vitest";

import {
  DOCK_CHROME,
  DOCK_DEFAULT_WIDTH,
  columnsFor,
  defaultDockWidth,
  expandedIn,
  initialDock,
  reduceDock,
  renderedSize,
  type DockAction,
  type DockState,
} from "../../src/panels/dock-state.js";
import { layoutDock } from "../../src/panels/layout.js";

const run = (state: DockState, ...actions: DockAction[]): DockState => actions.reduce(reduceDock, state);
const registered = (...keys: string[]): DockState => run(initialDock, ...keys.map((key, i) => ({ type: "register", key, now: i } as const)));

describe("dock state", () => {
  it("islands start minimal, in creation order, and never reshuffle", () => {
    const s = run(registered("a", "b", "c"), { type: "setSize", key: "c", size: "expanded", now: 10 });
    expect(s.order).toEqual(["a", "b", "c"]);
    expect(renderedSize(s, "a")).toBe("minimal");
    expect(renderedSize(s, "c")).toBe("expanded");
  });

  it("reorders an island without losing its identity or geometry state", () => {
    const before = run(
      registered("a", "b", "c"),
      { type: "setSize", key: "c", size: "expanded", now: 10 },
      { type: "reorder", key: "c", over: "a" },
    );
    expect(before.order).toEqual(["c", "a", "b"]);
    expect(before.islands["c"]!.size).toBe("expanded");
    expect(run(before, { type: "reorder", key: "missing", over: "a" })).toBe(before);
  });

  it("a third expanding in a column shrinks the least recently watched to minimal, never evicts", () => {
    let s = registered("a", "b", "c");
    s = run(s, { type: "setSize", key: "a", size: "expanded", now: 10 }, { type: "setSize", key: "b", size: "expanded", now: 20 });
    s = run(s, { type: "watched", key: "a", now: 30 }); // a was looked at after b
    s = run(s, { type: "setSize", key: "c", size: "expanded", now: 40 });
    expect(expandedIn(s, 0).map((i) => i.key)).toEqual(["a", "c"]);
    expect(s.islands["b"]!.size).toBe("minimal");
    expect(s.order).toEqual(["a", "b", "c"]);
  });

  it("two columns: expansion goes to the emptier column; collapsing to one column re-applies the rule", () => {
    let s = run(registered("a", "b", "c", "d"), { type: "setColumns", columns: 2 });
    s = run(
      s,
      { type: "setSize", key: "a", size: "expanded", now: 1 },
      { type: "setSize", key: "b", size: "expanded", now: 2 },
      { type: "setSize", key: "c", size: "expanded", now: 3 },
      { type: "setSize", key: "d", size: "expanded", now: 4 },
    );
    expect(s.islands["a"]!.column).toBe(0);
    expect(s.islands["b"]!.column).toBe(1);
    expect(s.islands["c"]!.column).toBe(0);
    expect(s.islands["d"]!.column).toBe(1);
    expect(expandedIn(s, 0)).toHaveLength(2);
    expect(expandedIn(s, 1)).toHaveLength(2);

    s = run(s, { type: "setColumns", columns: 1 });
    const expanded = expandedIn(s, 0).map((i) => i.key);
    expect(expanded).toEqual(["c", "d"]); // the two most recently watched survive
    expect(s.islands["a"]!.size).toBe("minimal");
    expect(s.islands["b"]!.size).toBe("minimal");
  });

  it("columns follow the dock width or the window width", () => {
    expect(columnsFor(384, 1440)).toBe(1);
    expect(columnsFor(640, 1440)).toBe(2);
    // A wide window is why the dock *opens* wider, not a licence to split a
    // narrow one into two columns too thin to read.
    expect(columnsFor(384, 1600)).toBe(1);
    expect(defaultDockWidth(1440)).toBe(DOCK_DEFAULT_WIDTH);
    // Wide enough that the *content* clears the threshold, padding included:
    // opening at exactly 640 laid out one column and looked like a bug.
    expect(columnsFor(defaultDockWidth(1600) - DOCK_CHROME)).toBe(2);
    expect(columnsFor(defaultDockWidth(1860) - DOCK_CHROME)).toBe(2);
  });

  it("maximize is a flag over expanded; restore returns exactly; Esc-style restore is idempotent", () => {
    let s = run(registered("a"), { type: "maximize", key: "a", now: 1 });
    expect(renderedSize(s, "a")).toBe("maximized");
    expect(s.islands["a"]!.size).toBe("expanded");
    s = run(s, { type: "restore" });
    expect(renderedSize(s, "a")).toBe("expanded");
    expect(run(s, { type: "restore" })).toBe(s);
  });

  it("pop out shrinks to minimal and points elsewhere; a later size change pops it back in", () => {
    let s = run(registered("a"), { type: "setSize", key: "a", size: "expanded", now: 1 }, { type: "popOut", key: "a", now: 2 });
    expect(s.islands["a"]).toMatchObject({ size: "minimal", poppedOut: true });
    s = run(s, { type: "setSize", key: "a", size: "expanded", now: 3 });
    expect(s.islands["a"]!.poppedOut).toBe(false);
  });

  it("the divider is clamped so a pane never shrinks below its header, and snaps to the midpoint", () => {
    let s = run(initialDock, { type: "setDivider", column: 0, ratio: 0.02 });
    expect(s.dividers[0]).toBe(0.15);
    s = run(s, { type: "setDivider", column: 0, ratio: 0.51 });
    expect(s.dividers[0]).toBe(0.5);
    s = run(s, { type: "setDivider", column: 1, ratio: 0.7 });
    expect(s.dividers).toEqual([0.5, 0.7]);
  });

  it("dismissal hides until the panel resurfaces; unregister forgets everything about a key", () => {
    let s = run(registered("a", "b"), { type: "dismiss", key: "a" });
    expect(s.dismissed).toEqual(["a"]);
    s = run(s, { type: "resurface", key: "a", now: 5 });
    expect(s.dismissed).toEqual([]);
    s = run(s, { type: "dismiss", key: "b" }, { type: "unregister", key: "b" });
    expect(s.order).toEqual(["a"]);
    expect(s.dismissed).toEqual([]);
  });
});

describe("layoutDock", () => {
  it("wraps minimal islands to two rows, then folds the rest into +N", () => {
    // 384 wide: inner 368 → two 164px pills per row (2·164 + 8 = 336 ≤ 368).
    const s = registered("a", "b", "c", "d", "e", "f");
    const layout = layoutDock(s, 384, 600);
    expect(layout.rects["a"]).toMatchObject({ top: 8, left: 8, width: 164, height: 28, hidden: false });
    expect(layout.rects["b"]).toMatchObject({ top: 8, left: 180 });
    expect(layout.rects["c"]).toMatchObject({ top: 44, left: 8 });
    // Four slots, six islands: three pills and a "+3" island.
    expect(layout.overflow).toEqual(["d", "e", "f"]);
    expect(layout.overflowRect).toMatchObject({ top: 44, left: 180 });
    expect(layout.rects["d"]!.hidden).toBe(true);
    expect(layout.stripHeight).toBe(8 + 28 * 2 + 8);
  });

  it("an expanded island alone fills the column; two share it by the divider; compact rows sit above", () => {
    let s = run(registered("a", "b", "c"), { type: "setSize", key: "a", size: "expanded", now: 1 });
    let layout = layoutDock(s, 384, 600);
    expect(layout.stripHeight).toBe(8 + 28 + 0); // b and c are pills on one row
    expect(layout.rects["a"]).toMatchObject({ top: 8 + 28 + 8, left: 8, width: 368 });
    expect(layout.rects["a"]!.top + layout.rects["a"]!.height).toBe(600 - 8);

    s = run(s, { type: "setSize", key: "b", size: "compact", now: 2 }, { type: "setSize", key: "c", size: "expanded", now: 3 });
    layout = layoutDock(s, 384, 600);
    // b and c left the strip: no pills, no strip.
    expect(layout.stripHeight).toBe(0);
    expect(layout.rects["b"]).toMatchObject({ top: 8, height: 36 });
    expect(layout.rects["a"]!.top).toBe(8 + 36 + 8);
    expect(layout.dividers).toHaveLength(1);
    expect(layout.dividers[0]!.keys).toEqual(["a", "c"]);
    expect(layout.rects["a"]!.height).toBe(layout.rects["c"]!.height); // 50/50 by default
    expect(layout.rects["c"]!.top + layout.rects["c"]!.height).toBe(600 - 8);
  });

  it("uses occupancy-aware full, stacked, and quadrant layouts", () => {
    let s = run(registered("a"), { type: "setColumns", columns: 2 });
    s = run(
      s,
      { type: "setSize", key: "a", size: "expanded", now: 1 },
    );
    let layout = layoutDock(s, 800, 600);
    expect(layout.rects["a"]).toMatchObject({ top: 8, left: 8, width: 784, height: 584 });

    s = run(s, { type: "register", key: "b", now: 2 }, { type: "setSize", key: "b", size: "expanded", now: 2 });
    layout = layoutDock(s, 800, 600);
    expect(layout.rects["a"]).toMatchObject({ left: 8, width: 784, height: 288 });
    expect(layout.rects["b"]).toMatchObject({ top: 304, left: 8, width: 784, height: 288 });
    expect(layout.dividers).toHaveLength(1);

    s = run(s, { type: "register", key: "c", now: 3 }, { type: "setSize", key: "c", size: "expanded", now: 3 });
    layout = layoutDock(s, 800, 600);
    expect(layout.rects["a"]).toMatchObject({ top: 8, left: 8, width: 388, height: 288 });
    expect(layout.rects["b"]).toMatchObject({ top: 304, left: 8, width: 388, height: 288 });
    expect(layout.rects["c"]).toMatchObject({ top: 8, left: 404, width: 388, height: 288 });

    s = run(s, { type: "register", key: "d", now: 4 }, { type: "setSize", key: "d", size: "expanded", now: 4 });
    layout = layoutDock(s, 800, 600);
    expect(layout.rects["d"]).toMatchObject({ top: 304, left: 404, width: 388, height: 288 });
    expect(layout.dividers.map((divider) => divider.keys)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("keeps compact islands from both stored columns in the one-column projection", () => {
    let s = run(registered("a", "b"), { type: "setColumns", columns: 2 });
    s = run(
      s,
      { type: "setSize", key: "a", size: "expanded", now: 1 },
      { type: "setSize", key: "b", size: "expanded", now: 2 },
      { type: "setSize", key: "b", size: "compact", now: 3 },
    );
    expect(s.islands["b"]!.column).toBe(1);

    const layout = layoutDock(s, 800, 600);
    expect(layout.rects["b"]).toMatchObject({ top: 8, left: 8, width: 784, height: 36 });
    expect(layout.rects["a"]).toMatchObject({ top: 52, left: 8, width: 784, height: 540 });
  });
});
