import { describe, expect, it } from "vitest";

import { buildAgentTree } from "../../../src/agents/index.js";
import {
  compositionFor,
  CONSTRAINED_HEIGHT,
  CONSTRAINED_WIDTH,
  directionFor,
  FULL_WIDTH,
  layoutTree,
  NODE_BOX,
  structureKey,
  visibleTreeOf,
} from "../../../src/components/agents/map/layout.js";
import { run } from "../fixtures.js";
import { family, ROOT } from "./harness.js";

const treeOf = (runs = family().runs, sessions = family().sessions) => buildAgentTree({ rootPath: ROOT, sessions, runs });

describe("compositionFor", () => {
  it("lists under 520 wide or 360 tall, draws a panel between, and goes full from 960", () => {
    expect(compositionFor({ width: CONSTRAINED_WIDTH - 1, height: 800 })).toBe("constrained");
    expect(compositionFor({ width: 1400, height: CONSTRAINED_HEIGHT - 1 })).toBe("constrained");
    expect(compositionFor({ width: CONSTRAINED_WIDTH, height: CONSTRAINED_HEIGHT })).toBe("panel");
    expect(compositionFor({ width: FULL_WIDTH - 1, height: 700 })).toBe("panel");
    expect(compositionFor({ width: FULL_WIDTH, height: 700 })).toBe("full");
  });
  it("keeps a narrow fullscreen on the canvas", () => {
    expect(compositionFor({ width: 390, height: 800 }, { canvas: true })).toBe("panel");
    expect(compositionFor({ width: 1200, height: 800 }, { canvas: true })).toBe("full");
  });
});

describe("visibleTreeOf", () => {
  it("folds ended agents until asked, counting what it hid", () => {
    const tree = treeOf();
    const folded = visibleTreeOf(tree, false);
    expect(folded.nodes.map((n) => n.id)).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl"]);
    expect(folded.hidden).toBe(1);
    expect(folded.ended).toBe(1);
    const shown = visibleTreeOf(tree, true);
    expect(shown.nodes.map((n) => n.id)).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl", "/p/b.jsonl"]);
    expect(shown.hidden).toBe(0);
    expect(shown.edges).toEqual([
      { from: ROOT, to: "/p/a.jsonl" },
      { from: "/p/a.jsonl", to: "/p/c.jsonl" },
      { from: ROOT, to: "/p/b.jsonl" },
    ]);
  });
  it("keeps an ended parent whose child is still going", () => {
    const { runs, sessions } = family();
    const ended = runs.map((r) => (r.runId === "r-a" ? { ...r, status: "completed" as const, endedAt: "2026-09-08T10:30:00.000Z" } : r));
    const folded = visibleTreeOf(buildAgentTree({ rootPath: ROOT, sessions, runs: ended }), false);
    expect(folded.nodes.map((n) => n.id)).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl"]);
    expect(folded.hidden).toBe(1);
  });
});

describe("layoutTree", () => {
  it("puts the root at the top, children in creation order left to right, and a parent centred over its children", () => {
    const visible = visibleTreeOf(treeOf(), true);
    const box = NODE_BOX.panel;
    const layout = layoutTree(visible, box, "TB");
    const at = (id: string) => layout.positions.get(id)!;
    expect(at(ROOT).y).toBe(0);
    expect(at("/p/a.jsonl").y).toBe(box.height + box.level);
    expect(at("/p/c.jsonl").y).toBe(2 * (box.height + box.level));
    // a before b: creation order, whatever their status.
    expect(at("/p/a.jsonl").x).toBeLessThan(at("/p/b.jsonl").x);
    // The root sits over the middle of its children's span.
    const span = at("/p/b.jsonl").x + box.width - at("/p/a.jsonl").x;
    expect(at(ROOT).x).toBeCloseTo(at("/p/a.jsonl").x + (span - box.width) / 2);
    // The grandchild sits under its parent.
    expect(at("/p/c.jsonl").x).toBe(at("/p/a.jsonl").x);
    expect(layout.width).toBe(2 * box.width + box.gap);
    expect(layout.height).toBe(3 * box.height + 2 * box.level);
  });

  it("does not move on a status-only update", () => {
    const { runs, sessions } = family();
    const before = layoutTree(visibleTreeOf(treeOf(runs, sessions), true), NODE_BOX.full);
    const changed = runs.map((r) => (r.runId === "r-a" ? { ...r, status: "blocked" as const, activity: { turns: 3, tools: 9, currentTool: "bash", lastAt: "2026-09-08T10:05:00.000Z" } } : r));
    const afterTree = visibleTreeOf(treeOf(changed, sessions), true);
    const after = layoutTree(afterTree, NODE_BOX.full);
    expect(structureKey(afterTree)).toBe(structureKey(visibleTreeOf(treeOf(runs, sessions), true)));
    for (const [id, pos] of before.positions) expect(after.positions.get(id)).toEqual(pos);
  });

  it("changes the key, and only then the geometry, when a node arrives", () => {
    const { runs, sessions } = family();
    const base = visibleTreeOf(treeOf(runs, sessions), true);
    const more = visibleTreeOf(treeOf([...runs, run({ runId: "r-d", sessionPath: "/p/d.jsonl", subagentName: "docs-1", startedAt: "2026-09-08T10:03:00.000Z" })], sessions), true);
    expect(structureKey(more)).not.toBe(structureKey(base));
    const layout = layoutTree(more, NODE_BOX.panel);
    const xs = ["/p/a.jsonl", "/p/b.jsonl", "/p/d.jsonl"].map((id) => layout.positions.get(id)!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("lays out sideways when asked, with depth along x", () => {
    const visible = visibleTreeOf(treeOf(), true);
    const box = NODE_BOX.panel;
    const layout = layoutTree(visible, box, "LR");
    expect(layout.positions.get(ROOT)!.x).toBe(0);
    expect(layout.positions.get("/p/a.jsonl")!.x).toBe(box.width + box.level);
    expect(layout.positions.get("/p/c.jsonl")!.x).toBe(2 * (box.width + box.level));
    expect(layout.positions.get("/p/a.jsonl")!.y).toBeLessThan(layout.positions.get("/p/b.jsonl")!.y);
  });
});

describe("directionFor", () => {
  const deepRuns = () => {
    const runs = [run({ runId: "r-1", sessionPath: "/p/1.jsonl", subagentName: "one" })];
    for (let i = 2; i <= 6; i += 1) {
      runs.push(
        run({
          runId: `r-${i}`,
          sessionPath: `/p/${i}.jsonl`,
          subagentName: `n${i}`,
          depth: i,
          parent: { sessionPath: `/p/${i - 1}.jsonl`, sessionId: `/p/${i - 1}.jsonl`, runId: `r-${i - 1}` },
          startedAt: `2026-09-08T10:0${i}:00.000Z`,
        }),
      );
    }
    return runs;
  };
  it("turns a deep, narrow tree sideways in a short, wide panel and keeps it upright in a tall one", () => {
    const visible = visibleTreeOf(buildAgentTree({ rootPath: ROOT, sessions: family().sessions, runs: deepRuns() }), true);
    expect(directionFor(visible, NODE_BOX.panel, { width: 900, height: 380 }, "panel")).toBe("LR");
    expect(directionFor(visible, NODE_BOX.panel, { width: 600, height: 900 }, "panel")).toBe("TB");
  });
  it("keeps its current direction until the other way fits a tenth better", () => {
    const visible = visibleTreeOf(buildAgentTree({ rootPath: ROOT, sessions: family().sessions, runs: deepRuns() }), true);
    // Sideways is only marginally better here: an upright map stays upright.
    expect(directionFor(visible, NODE_BOX.panel, { width: 900, height: 380 }, "panel", "TB")).toBe("TB");
    // And a sideways map stays sideways in a box where upright is only marginally better.
    expect(directionFor(visible, NODE_BOX.panel, { width: 900, height: 420 }, "panel", "LR")).toBe("LR");
    expect(directionFor(visible, NODE_BOX.panel, { width: 600, height: 900 }, "panel", "LR")).toBe("TB");
  });
  it("never turns the full composition or a list", () => {
    const visible = visibleTreeOf(buildAgentTree({ rootPath: ROOT, sessions: family().sessions, runs: deepRuns() }), true);
    expect(directionFor(visible, NODE_BOX.full, { width: 1400, height: 400 }, "full")).toBe("TB");
    expect(directionFor(visible, NODE_BOX.panel, { width: 400, height: 300 }, "constrained")).toBe("TB");
  });
});
