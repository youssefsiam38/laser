/**
 * The Plan's declared graph, laid out (M21-T16).
 *
 * The rules under test are the leap's: only declared edges, a node's column is
 * the longest chain of dependencies behind it, the host's orphans and problems
 * are carried through untouched, and a cycle is survivable rather than fatal.
 */
import { describe, expect, it } from "vitest";
import type { PlanBody, PlanGraphReport } from "@lasercode/protocol";

import { layoutPlanGraph, planGraphOrder, planGraphStep } from "../../src/project-work/plan-graph.js";

import { item } from "./fixture.js";

const plan = (over: Partial<PlanBody> = {}): PlanBody => ({
  brief: "Ship the workspace",
  phases: [],
  dependencies: [],
  boundaries: [],
  migrations: [],
  risks: [],
  verification: [],
  ...over,
});

const rows = [
  item({ entityId: "t1", kind: "task", number: 1, title: "The store", state: "done" }),
  item({ entityId: "t2", kind: "task", number: 2, title: "The shell", state: "ready" }),
  item({ entityId: "t3", kind: "task", number: 3, title: "The board", state: "draft" }),
];

describe("the plan graph's layout", () => {
  it("puts a task to the right of everything it waits on", () => {
    const layout = layoutPlanGraph({
      body: plan({
        phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-1", "TASK-2", "TASK-3"] }],
        dependencies: [
          { from: "TASK-2", to: "TASK-1" },
          { from: "TASK-3", to: "TASK-2" },
        ],
      }),
      items: rows,
    });
    const columns = Object.fromEntries(layout.nodes.map((node) => [node.key, node.column]));
    expect(columns).toEqual({ "TASK-1": 0, "TASK-2": 1, "TASK-3": 2 });
    expect(layout.columns).toBe(3);
    expect(layout.cyclic).toBe(false);
    expect(layout.edges).toHaveLength(2);
  });

  it("carries each node's key, title and state from the rows this window holds", () => {
    const layout = layoutPlanGraph({
      body: plan({ phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-1", "TASK-9"] }] }),
      items: rows,
    });
    const known = layout.nodes.find((node) => node.key === "TASK-1");
    expect(known).toMatchObject({ title: "The store", state: "done", known: true, entityId: "t1", phase: "Spine" });
    // A key this window has not read is kept and says so, rather than vanishing.
    const unread = layout.nodes.find((node) => node.key === "TASK-9");
    expect(unread).toMatchObject({ known: false, state: undefined, entityId: undefined });
  });

  it("marks the nodes a host problem names, and survives a cycle", () => {
    const report: PlanGraphReport = {
      ok: false,
      problems: [{ problem: "cycle", keys: ["TASK-1", "TASK-2", "TASK-1"], message: "TASK-1 → TASK-2 → TASK-1 is a loop." }],
      orphans: [],
      order: [],
    };
    const layout = layoutPlanGraph({
      body: plan({
        phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-1", "TASK-2"] }],
        dependencies: [
          { from: "TASK-1", to: "TASK-2" },
          { from: "TASK-2", to: "TASK-1" },
        ],
      }),
      items: rows,
      report,
    });
    expect(layout.cyclic).toBe(true);
    expect(layout.nodes.every((node) => node.inProblem)).toBe(true);
    expect(layout.edges.every((edge) => edge.problem)).toBe(true);
  });

  it("keeps a task the plan no longer lists, as an orphan", () => {
    const report: PlanGraphReport = {
      ok: true,
      problems: [],
      orphans: [{ key: "TASK-3", entityId: "t3", title: "The board", state: "draft", reason: "removed_from_plan" }],
      order: ["TASK-1"],
    };
    const layout = layoutPlanGraph({ body: plan({ phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-1"] }] }), items: rows, report });
    const orphan = layout.nodes.find((node) => node.key === "TASK-3");
    expect(orphan).toMatchObject({ orphan: true, title: "The board", entityId: "t3" });
  });

  it("declares no edges when the plan declares none", () => {
    const layout = layoutPlanGraph({ body: plan({ phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-1", "TASK-2"] }] }), items: rows });
    expect(layout.edges).toEqual([]);
    expect(layout.nodes.map((node) => node.column)).toEqual([0, 0]);
  });
});

describe("moving around the graph with a keyboard", () => {
  const layout = layoutPlanGraph({
    body: plan({
      phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-1", "TASK-2", "TASK-3"] }],
      dependencies: [{ from: "TASK-3", to: "TASK-1" }],
    }),
    items: rows,
  });

  it("reads column by column, top to bottom", () => {
    expect(planGraphOrder(layout).map((node) => node.key)).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
  });

  it("steps within a column and across columns, and stops at the edges", () => {
    const first = layout.nodes.find((node) => node.key === "TASK-1")!;
    expect(planGraphStep(layout, first, "down").key).toBe("TASK-2");
    expect(planGraphStep(layout, first, "up").key).toBe("TASK-1");
    expect(planGraphStep(layout, first, "after").key).toBe("TASK-3");
    expect(planGraphStep(layout, first, "before").key).toBe("TASK-1");
  });
});
