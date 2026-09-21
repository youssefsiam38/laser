/**
 * M21-T15: the Plan's Task graph, and the scope arithmetic behind conflicts.
 *
 * These are the decisions that must be identical everywhere they are made —
 * the host refuses a write with them, the workspace draws a board with them —
 * so they live in the protocol as pure functions and are pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeScopePath,
  overlappingScope,
  scopePathsOverlap,
  taskActionTransition,
  taskTransition,
  validatePlanGraph,
  type PlanGraphInput,
  type ProjectWorkKind,
  type ProjectWorkState,
} from "../src/project-work.js";

type Known = PlanGraphInput["known"];

function known(rows: Array<[string, ProjectWorkKind, ProjectWorkState]>): Known {
  return new Map(
    rows.map(([key, kind, state]) => [
      key,
      { kind, state, entityId: `ent_${key.toLowerCase().replace("-", "_")}`, title: `${key} title` },
    ]),
  );
}

const threeTasks = known([
  ["TASK-1", "task", "done"],
  ["TASK-2", "task", "ready"],
  ["TASK-3", "task", "draft"],
]);

describe("the Plan's Task graph", () => {
  it("accepts a plan whose tasks exist and whose dependencies can be ordered", () => {
    const report = validatePlanGraph({
      phases: [{ taskKeys: ["TASK-1", "TASK-2", "TASK-3"] }],
      dependencies: [
        { from: "TASK-3", to: "TASK-2" },
        { from: "TASK-2", to: "TASK-1" },
      ],
      known: threeTasks,
    });
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    // Dependencies first: TASK-3 waits on TASK-2, which waits on TASK-1.
    expect(report.order).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
  });

  it("names the keys the cycle goes round (D-355)", () => {
    const report = validatePlanGraph({
      phases: [{ taskKeys: ["TASK-1", "TASK-2", "TASK-3"] }],
      dependencies: [
        { from: "TASK-1", to: "TASK-2" },
        { from: "TASK-2", to: "TASK-3" },
        { from: "TASK-3", to: "TASK-1" },
      ],
      known: threeTasks,
    });
    expect(report.ok).toBe(false);
    const cycle = report.problems.find((problem) => problem.problem === "cycle");
    expect(cycle?.keys).toEqual(["TASK-1", "TASK-2", "TASK-3", "TASK-1"]);
    expect(cycle?.message).toContain("TASK-1 → TASK-2 → TASK-3 → TASK-1");
    // A graph with a cycle has no order at all, and does not pretend to.
    expect(report.order).toEqual([]);
  });

  it("refuses a self-dependency by name", () => {
    const report = validatePlanGraph({
      phases: [{ taskKeys: ["TASK-1"] }],
      dependencies: [{ from: "TASK-1", to: "TASK-1" }],
      known: threeTasks,
    });
    expect(report.problems).toEqual([
      { problem: "self_dependency", keys: ["TASK-1"], message: "TASK-1 cannot depend on itself." },
    ]);
  });

  it("refuses a key this project never minted, and a key that is not a task", () => {
    const report = validatePlanGraph({
      phases: [{ taskKeys: ["TASK-1", "TASK-9", "SPEC-1"] }],
      dependencies: [],
      known: known([
        ["TASK-1", "task", "draft"],
        ["SPEC-1", "spec", "approved"],
      ]),
    });
    expect(report.problems.map((problem) => problem.problem)).toEqual(["unknown_task", "not_a_task"]);
    expect(report.problems[0]?.message).toBe("TASK-9 is not in this project, so this plan cannot name it.");
    expect(report.problems[1]?.message).toBe("SPEC-1 is not a task. A plan's phases and dependencies name tasks.");
  });

  it("refuses a dependency on a task the plan does not list", () => {
    const report = validatePlanGraph({
      phases: [{ taskKeys: ["TASK-2"] }],
      dependencies: [{ from: "TASK-2", to: "TASK-1" }],
      known: threeTasks,
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.problem).toBe("dependency_outside_plan");
    expect(report.problems[0]?.message).toContain("TASK-1 is named by a dependency");
  });

  it("records — never refuses — a task this revision stopped listing", () => {
    const report = validatePlanGraph({
      phases: [{ taskKeys: ["TASK-1"] }],
      dependencies: [],
      known: threeTasks,
      claimed: ["TASK-1", "TASK-2"],
    });
    expect(report.ok).toBe(true);
    expect(report.orphans).toEqual([
      { key: "TASK-2", entityId: "ent_task_2", title: "TASK-2 title", state: "ready", reason: "removed_from_plan" },
    ]);
  });
});

describe("scope overlap", () => {
  it("treats the same place written two ways as one place", () => {
    expect(normalizeScopePath("./packages/ui/")).toBe("packages/ui");
    expect(scopePathsOverlap("packages/ui", "./packages/ui/")).toBe(true);
    expect(scopePathsOverlap("packages/ui", "packages/ui/src/workspace")).toBe(true);
    expect(scopePathsOverlap("packages/ui", "packages/uikit")).toBe(false);
    expect(scopePathsOverlap("packages/ui", "packages/host")).toBe(false);
  });

  it("reports the narrower path the two tasks meet at, and the shared packages", () => {
    const overlap = overlappingScope(
      { packages: ["@lasercode/ui", "@lasercode/host"], paths: ["packages/ui"] },
      { packages: ["@lasercode/ui"], paths: ["packages/ui/src/workspace", "packages/worker"] },
    );
    expect(overlap).toEqual({ packages: ["@lasercode/ui"], paths: ["packages/ui/src/workspace"] });
  });

  it("finds nothing when two tasks work in different places", () => {
    expect(overlappingScope({ packages: ["a"], paths: ["packages/ui"] }, { packages: ["b"], paths: ["packages/host"] })).toEqual({
      packages: [],
      paths: [],
    });
  });
});

describe("the refusals a stale upstream writes", () => {
  const upstream = { entityId: "ent_plan", kind: "plan" as const, key: "PLAN-3", revisionId: "rev_7" };

  it("names the upstream by key when it knows it", () => {
    const refusal = taskTransition({ from: "ready", to: "in_progress", trigger: "person", planStale: true, staleUpstream: upstream });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toBe("PLAN-3 changed after this task was planned. Reconcile it before starting this task.");
    const done = taskActionTransition("complete", {
      from: "needs_review",
      trigger: "person",
      hasAcceptanceEvidence: true,
      planStale: true,
      staleUpstream: upstream,
    });
    expect(done.ok === false && done.reason).toContain("PLAN-3 changed after this task was planned");
  });

  it("still says something useful with no upstream to name", () => {
    const refusal = taskTransition({ from: "ready", to: "in_progress", trigger: "person", designStale: true });
    expect(refusal.ok === false && refusal.reason).toBe(
      "The design this task implements changed after this task was planned. Reconcile it before starting this task.",
    );
  });
});

describe("review needs evidence when an agent asks for it", () => {
  it("refuses an agent's submit with nothing to show, and allows it with a passing verification", () => {
    const empty = taskTransition({ from: "in_progress", to: "needs_review", trigger: "agent" });
    expect(empty.ok).toBe(false);
    expect(empty.ok === false && empty.reason).toBe("Report the evidence for this task before sending it for review.");
    expect(taskTransition({ from: "in_progress", to: "needs_review", trigger: "agent", hasPassingVerification: true }).ok).toBe(true);
    // A person may always send their own work for review.
    expect(taskTransition({ from: "in_progress", to: "needs_review", trigger: "person" }).ok).toBe(true);
  });
});
