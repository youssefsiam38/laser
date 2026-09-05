/**
 * The pi-subagents → panel mapping. Tested because it is a table, not a
 * transformation: the state mapping, the capability matrix and the usage
 * honesty are the three places where a silent change would lie to a person
 * (a stop rendered as a failure, a control that does nothing, a cache-read
 * count of zero that was never measured).
 */
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_OF,
  STEP_STATE_OF,
  actionsForChild,
  actionsForRun,
  childPanelId,
  panelsForStatus,
  planPanel,
  singleRunPanel,
  usageOfRun,
  usageOfStep,
} from "../../src/subagents/panels.js";
import type { AsyncStatus, StatusStep } from "../../src/subagents/status.js";

const CAPS = { runnerAlive: true, steerClosed: false, busReachable: false };

function status(overrides: Partial<AsyncStatus> = {}): AsyncStatus {
  return {
    runId: "run-1",
    dir: "/tmp/roots/async-subagent-runs/run-1",
    sessionId: "/sessions/p/a.jsonl",
    cwd: "/p",
    mode: "single",
    state: "running",
    startedAt: 1_000,
    steps: [{ status: "running", agent: "worker" }],
    ...overrides,
  };
}

describe("the state mapping", () => {
  it("keeps the reason instead of collapsing every ending into failure", () => {
    // The contract's own complaint about all four implementations: they lose
    // *why*. These four are the ones that must not merge.
    expect(LIFECYCLE_OF.stopped).toBe("cancelled");
    expect(LIFECYCLE_OF.partial).toBe("done");
    expect(LIFECYCLE_OF.rejected).toBe("failed");
    expect(LIFECYCLE_OF.paused).toBe("paused");
    expect(STEP_STATE_OF.stopped).toBe("skipped");
    expect(STEP_STATE_OF.paused).toBe("blocked");
  });

  it("says in words why a run ended", () => {
    const stopped = singleRunPanel(status({ state: "stopped", stopped: true, steps: [{ status: "stopped", agent: "worker" }] }), { caps: CAPS });
    expect(stopped.lifecycle).toBe("cancelled");
    expect(stopped.terminalReason).toBe("you stopped it");

    const timedOut = singleRunPanel(status({ state: "failed", timedOut: true, steps: [{ status: "failed", agent: "worker" }] }), { caps: CAPS });
    expect(timedOut.terminalReason).toBe("it ran out of time");

    const budget = singleRunPanel(
      status({ state: "failed", steps: [{ status: "failed", agent: "worker", toolBudgetBlocked: true }] }),
      { caps: CAPS },
    );
    expect(budget.terminalReason).toBe("it reached its tool budget");
  });
});

describe("usage is raw, and honest about what was never measured", () => {
  it("prefers the per-attempt ledger, which is the only place cache reads live", () => {
    const step: StatusStep = {
      status: "complete",
      tokens: { input: 1, output: 2 },
      modelAttempts: [{ usage: { input: 100, output: 20, cacheRead: 4000, cacheWrite: 0, cost: 0.5 } }],
    };
    expect(usageOfStep(step)).toEqual({ input: 100, output: 20, cacheRead: 4000, cacheWrite: 0, costUsd: 0.5 });
  });

  it("names what is missing rather than reporting zero cache reads", () => {
    const usage = usageOfStep({ status: "running", tokens: { input: 10, output: 3 } } as StatusStep);
    expect(usage).not.toBeNull();
    expect(usage?.cacheRead).toBeUndefined();
    expect(usage?.unavailableReason).toMatch(/cache reads/);
    expect(usage?.costUsd).toBeNull();
  });

  it("returns null — not zero — when nothing was measured at all", () => {
    expect(usageOfStep({ status: "running" } as StatusStep)).toBeNull();
    expect(usageOfRun({ steps: [{ status: "running" } as StatusStep] })).toBeNull();
  });

  it("sums the children for the run, and carries their caveat up", () => {
    const usage = usageOfRun({
      steps: [
        { status: "complete", tokens: { input: 10, output: 1 } } as StatusStep,
        { status: "complete", tokens: { input: 5, output: 2 } } as StatusStep,
      ],
    });
    expect(usage).toMatchObject({ input: 15, output: 3 });
    expect(usage?.unavailableReason).toMatch(/cache reads/);
  });
});

describe("the capability matrix (R2: hidden, never disabled)", () => {
  it("offers steer, stop and interrupt to a live background run", () => {
    expect(actionsForRun("running", CAPS).map((a) => a.id)).toEqual(["steer", "stop", "interrupt"]);
  });

  it("drops steer once the runner has closed its inbox", () => {
    expect(actionsForRun("running", { ...CAPS, steerClosed: true }).map((a) => a.id)).toEqual(["stop", "interrupt"]);
  });

  it("offers nothing when the runner process is gone", () => {
    expect(actionsForRun("running", { ...CAPS, runnerAlive: false })).toEqual([]);
  });

  it("offers resume only where the owning session's bus is reachable", () => {
    expect(actionsForRun("paused", CAPS)).toEqual([]);
    expect(actionsForRun("paused", { ...CAPS, busReachable: true }).map((a) => a.id)).toEqual(["resume"]);
  });

  it("gives a workflow child steer and stop but not the run-level interrupt", () => {
    const step: StatusStep = { status: "running", agent: "reviewer", workflowKey: "health" };
    expect(actionsForChild(step, "running", CAPS).map((a) => a.id)).toEqual(["steer", "stop"]);
    expect(actionsForChild({ ...step, stopRequested: true }, "running", CAPS)).toEqual([]);
    expect(actionsForChild({ ...step, status: "complete" }, "running", CAPS)).toEqual([]);
  });

  it("gives a stop button a confirmation, because it cannot be undone", () => {
    const stop = actionsForRun("running", CAPS).find((a) => a.id === "stop");
    expect(stop?.destructive).toBe(true);
    expect(stop?.confirm).toBeTruthy();
  });
});

describe("plans", () => {
  const workflow = status({
    mode: "workflow",
    state: "running",
    steps: [
      { status: "running", agent: "reviewer", workflowKey: "health-review", label: "health-review", startedAt: 2_000 },
      { status: "complete", agent: "reviewer", workflowKey: "readiness-review", label: "readiness-review" },
    ],
    preflight: {
      coverage: "complete",
      lanes: [
        { key: "health-review", mode: "review", decision: "general codebase health" },
        { key: "readiness-review", mode: "review", decision: "architecture readiness" },
        { key: "adversarial-review", mode: "review", decision: "adversarial integration" },
      ],
    },
  });

  it("marks a rebuilt plan as inferred, because nothing declared it (R3)", () => {
    const plan = planPanel(workflow, { caps: CAPS });
    expect(plan?.inferred).toBe(true);
    expect(plan?.title).toBe("Workflow · 2 lanes");
  });

  it("keeps a lane that has not started as a pending row — the plan is the intent", () => {
    const plan = planPanel(workflow, { caps: CAPS });
    const adversarial = plan?.steps.find((s) => s.id === "adversarial-review");
    expect(adversarial?.state).toBe("pending");
    expect(adversarial?.runId).toBeUndefined();
  });

  it("links a started lane to its run panel rather than copying its state", () => {
    const plan = planPanel(workflow, { caps: CAPS });
    const health = plan?.steps.find((s) => s.id === "health-review");
    expect(health?.state).toBe("running");
    expect(health?.runId).toBe("subagents:child:run-1:health-review");
    expect(health).not.toHaveProperty("lifecycle");
  });

  it("does not claim to be inferred when pi-subagents persisted a graph", () => {
    const declared = planPanel(
      status({
        mode: "chain",
        steps: [{ status: "complete", agent: "worker" }, { status: "running", agent: "reviewer" }],
        workflowGraph: {
          phases: [{ title: "Build", nodeIds: ["n1"] }],
          nodes: [
            { id: "n1", label: "build", stepIndex: 0, status: "completed" },
            { id: "n2", label: "review", stepIndex: 1, status: "running", phase: "Review" },
          ],
        },
      }),
      { caps: CAPS },
    );
    expect(declared?.inferred).toBeUndefined();
    expect(declared?.steps.map((s) => s.phase)).toEqual(["Build", "Review"]);
  });

  it("makes no plan out of a single-step run", () => {
    expect(planPanel(status(), { caps: CAPS })).toBeUndefined();
  });
});

describe("panel identity (R6/R9: one panel, one id, arriving twice is normal)", () => {
  it("derives child ids from pi-subagents' own identity, not from our order", () => {
    const withChildId = childPanelId("run-1", { status: "running", childId: "c7" }, 3);
    const withKey = childPanelId("run-1", { status: "running", workflowKey: "health" }, 3);
    const positional = childPanelId("run-1", { status: "running" }, 3);
    expect(withChildId).toBe("subagents:child:run-1:c7");
    expect(withKey).toBe("subagents:child:run-1:health");
    expect(positional).toBe("subagents:child:run-1:3");
  });

  it("produces byte-identical panels from the same status, so re-reads dedupe", () => {
    const a = panelsForStatus(status(), { caps: CAPS });
    const b = panelsForStatus(status(), { caps: CAPS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("gives a single-step run one run panel and no plan", () => {
    const panels = panelsForStatus(status(), { caps: CAPS });
    expect(panels.map((p) => p.kind)).toEqual(["run"]);
    expect(panels[0]?.id).toBe("subagents:run:run-1");
  });

  it("gives a workflow one plan and one run per child, each linked to the plan", () => {
    const panels = panelsForStatus(
      status({
        mode: "workflow",
        steps: [
          { status: "running", agent: "reviewer", workflowKey: "a" },
          { status: "pending", agent: "reviewer", workflowKey: "b" },
        ],
      }),
      { caps: CAPS },
    );
    expect(panels.map((p) => p.kind)).toEqual(["plan", "run", "run"]);
    const child = panels[1];
    expect(child?.kind === "run" && child.parent).toEqual({ id: "subagents:plan:run-1", relation: "step-of" });
  });
});

describe("acceptance and the watchdog", () => {
  it("stays quiet when everything passed", () => {
    const panels = panelsForStatus(
      status({
        state: "complete",
        steps: [{ status: "complete", agent: "worker", acceptance: { status: "accepted" } }],
      }),
      { caps: CAPS },
    );
    expect(panels.filter((p) => p.kind === "collection")).toHaveLength(0);
    const run = panels[0];
    expect(run?.kind === "run" && run.terminalReason).toBe("acceptance accepted");
  });

  it("opens a ledger of generic rows when a check failed", () => {
    const panels = panelsForStatus(
      status({
        state: "complete",
        steps: [
          {
            status: "complete",
            agent: "researcher",
            acceptance: {
              status: "rejected",
              runtimeChecks: [
                { id: "evidence:commands-run", status: "failed", message: "commands-run evidence missing from child report." },
                { id: "no-staged-files", status: "passed", message: "No staged files detected." },
              ],
            },
            watchdog: { phase: "stale", reason: "review stale" },
          },
        ],
      }),
      { caps: CAPS },
    );
    const collection = panels.find((p) => p.kind === "collection");
    expect(collection?.kind === "collection" && collection.items.map((i) => i.id)).toEqual([
      "watchdog",
      "evidence:commands-run",
      "no-staged-files",
    ]);
    expect(collection?.kind === "collection" && collection.items[1]?.meta).toEqual([{ label: "status", value: "failed" }]);
    const run = panels[0];
    expect(run?.kind === "run" && run.terminalReason).toMatch(/acceptance rejected — commands-run/);
  });
});
