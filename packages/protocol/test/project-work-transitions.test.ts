/**
 * M21-T1: the transition rules and the staleness graph.
 *
 * These are the parts of the domain where a mistake is silent and expensive —
 * an agent approving its own work, a finished run closing a Task nobody
 * accepted, a change to one artifact quietly invalidating half a project — so
 * every rule in the leap's "Revision and staleness model" and "Plan and
 * Project Task contract" has a case here.
 */
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_REVIEW_STATES,
  PROJECT_TASK_STATES,
  artifactTransition,
  propagateStale,
  taskActionTransition,
  taskTransition,
  unmetTaskDependencies,
  type ArtifactReviewState,
  type ProjectTaskState,
  type StaleGraphEdge,
  type StaleGraphEntity,
} from "../src/project-work.js";

const artifact = (from: ArtifactReviewState, to: ArtifactReviewState, over: Partial<Parameters<typeof artifactTransition>[0]> = {}) =>
  artifactTransition({ kind: "spec", from, to, trigger: "person", ...over });

const task = (from: ProjectTaskState, to: ProjectTaskState, over: Partial<Parameters<typeof taskTransition>[0]> = {}) =>
  taskTransition({ from, to, trigger: "person", ...over });

describe("artifact review states", () => {
  it("has exactly the six states the contract names", () => {
    expect([...ARTIFACT_REVIEW_STATES]).toEqual(["draft", "needs_review", "approved", "stale", "superseded", "archived"]);
  });

  it("walks the ordinary path and refuses the shortcuts", () => {
    expect(artifact("draft", "needs_review").ok).toBe(true);
    expect(artifact("needs_review", "approved").ok).toBe(true);
    expect(artifact("approved", "draft").ok).toBe(true);
    expect(artifact("draft", "approved").ok).toBe(false);
    expect(artifact("superseded", "approved").ok).toBe(false);
    const refusal = artifact("draft", "approved");
    expect(refusal.ok === false && refusal.reason).toBe("draft cannot become approved.");
  });

  it("lets only a person approve, and only with no blocking comments (D-332)", () => {
    expect(artifact("needs_review", "approved", { trigger: "agent" }).ok).toBe(false);
    expect(artifact("needs_review", "approved", { trigger: "policy" }).ok).toBe(false);
    expect(artifact("needs_review", "approved", { trigger: "system" }).ok).toBe(false);
    const blocked = artifact("needs_review", "approved", { blockingComments: 2 });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.reason).toContain("2 blocking comments");
    expect(artifact("needs_review", "approved", { blockingComments: 0 }).ok).toBe(true);
  });

  it("refuses to approve a design made only of sketches (D-354)", () => {
    expect(artifactTransition({ kind: "design", from: "needs_review", to: "approved", trigger: "person", sketchOnly: true }).ok).toBe(false);
    expect(artifactTransition({ kind: "design", from: "needs_review", to: "approved", trigger: "person", sketchOnly: false }).ok).toBe(true);
  });

  it("makes stale a consequence, never a choice", () => {
    expect(artifact("approved", "stale").ok).toBe(false);
    expect(artifact("approved", "stale", { trigger: "system", upstreamChanged: true }).ok).toBe(true);
    // A draft was never settled, so nothing upstream can stale it.
    expect(artifact("draft", "stale", { trigger: "system", upstreamChanged: true }).ok).toBe(false);
  });

  it("requires an explicit restore to leave the archive", () => {
    expect(artifact("archived", "approved").ok).toBe(false);
    expect(artifact("archived", "approved", { restore: true }).ok).toBe(true);
    expect(artifact("draft", "archived").ok).toBe(true);
  });

  it("refuses to run a Task through the review states at all", () => {
    const refusal = artifactTransition({ kind: "task", from: "draft", to: "needs_review", trigger: "person" });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain("Task uses the Task states");
  });
});

describe("Task states", () => {
  it("has exactly the seven the contract names, and no failed state", () => {
    expect([...PROJECT_TASK_STATES]).toEqual(["draft", "blocked", "ready", "in_progress", "needs_review", "done", "cancelled"]);
    expect((PROJECT_TASK_STATES as readonly string[]).includes("failed")).toBe(false);
  });

  it("names the unmet dependencies by key when readiness is refused (D-355)", () => {
    const refusal = task("draft", "ready", { unmetDependencies: ["TASK-7", "DES-3"] });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toBe("TASK-7, DES-3 must be done first.");
    expect(task("draft", "ready", { unmetDependencies: [] }).ok).toBe(true);
  });

  it("derives readiness from the dependencies' accepted states", () => {
    const states = new Map([
      ["TASK-1", { kind: "task" as const, state: "done" as const }],
      ["TASK-2", { kind: "task" as const, state: "in_progress" as const }],
      ["SPEC-1", { kind: "spec" as const, state: "approved" as const }],
      ["DES-1", { kind: "design" as const, state: "needs_review" as const }],
    ]);
    expect(unmetTaskDependencies(["TASK-1", "SPEC-1"], states)).toEqual([]);
    expect(unmetTaskDependencies(["TASK-2", "DES-1", "PLAN-9"], states)).toEqual(["TASK-2", "DES-1", "PLAN-9"]);
  });

  it("never completes a Task because a run ended", () => {
    const refusal = task("in_progress", "done", { trigger: "run_ended", hasAcceptanceEvidence: true });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain("A finished run is evidence");
    // …and a run ending may still leave the Task somewhere a person can act on.
    expect(task("in_progress", "needs_review", { trigger: "run_ended" }).ok).toBe(true);
    expect(task("in_progress", "blocked", { trigger: "run_ended" }).ok).toBe(true);
  });

  it("requires acceptance evidence for done, and a person or an approved policy", () => {
    expect(task("needs_review", "done", { hasAcceptanceEvidence: false }).ok).toBe(false);
    expect(task("needs_review", "done", { hasAcceptanceEvidence: true }).ok).toBe(true);
    expect(task("needs_review", "done", { trigger: "agent", hasAcceptanceEvidence: true }).ok).toBe(false);
    expect(task("needs_review", "done", { trigger: "policy", hasAcceptanceEvidence: true }).ok).toBe(false);
    expect(task("needs_review", "done", { trigger: "policy", hasAcceptanceEvidence: true, completionPolicy: true }).ok).toBe(true);
    expect(task("needs_review", "done", { trigger: "system", hasAcceptanceEvidence: true }).ok).toBe(false);
  });

  it("refuses done while a blocking comment is open", () => {
    const refusal = task("needs_review", "done", { hasAcceptanceEvidence: true, blockingComments: 1 });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain("1 blocking comment");
  });

  it("lets a stale Plan stop a start but not a running attempt, and blocks done either way", () => {
    expect(task("ready", "in_progress", { planStale: true }).ok).toBe(false);
    expect(task("ready", "in_progress", { designStale: true }).ok).toBe(false);
    // An attempt already running finishes: needs_review is still reachable.
    expect(task("in_progress", "needs_review", { planStale: true }).ok).toBe(true);
    expect(task("in_progress", "done", { planStale: true, hasAcceptanceEvidence: true }).ok).toBe(false);
    expect(task("needs_review", "in_progress", { planStale: true }).ok).toBe(true);
  });

  it("refuses the illegal board drags by name", () => {
    expect(task("draft", "done", { hasAcceptanceEvidence: true }).ok).toBe(false);
    expect(task("ready", "done", { hasAcceptanceEvidence: true }).ok).toBe(false);
    expect(task("blocked", "in_progress").ok).toBe(false);
    expect(task("done", "cancelled").ok).toBe(false);
    expect(task("done", "in_progress").ok).toBe(true);
    expect(task("cancelled", "draft").ok).toBe(true);
  });

  it("maps each explicit action to the state it asks for", () => {
    expect(taskActionTransition("start", { from: "ready", trigger: "person" })).toMatchObject({ ok: true, to: "in_progress" });
    expect(taskActionTransition("complete", { from: "needs_review", trigger: "person", hasAcceptanceEvidence: true })).toMatchObject({
      ok: true,
      to: "done",
    });
    expect(taskActionTransition("complete", { from: "needs_review", trigger: "person" })).toMatchObject({ ok: false, to: "done" });
    expect(taskActionTransition("mark_ready", { from: "draft", trigger: "person", unmetDependencies: ["TASK-2"] })).toMatchObject({
      ok: false,
      to: "ready",
    });
  });
});

describe("stale propagation", () => {
  const entities: StaleGraphEntity[] = [
    { entityId: "spec", kind: "spec", key: "SPEC-1", state: "approved" },
    { entityId: "design", kind: "design", key: "DES-1", state: "approved" },
    { entityId: "plan", kind: "plan", key: "PLAN-1", state: "approved" },
    { entityId: "taskReady", kind: "task", key: "TASK-1", state: "ready" },
    { entityId: "taskRunning", kind: "task", key: "TASK-2", state: "in_progress" },
    { entityId: "draftDoc", kind: "spec", key: "SPEC-2", state: "draft" },
  ];
  const edges: StaleGraphEdge[] = [
    { linkId: "e1", relation: "depends_on", subject: { entityId: "design" }, object: { entityId: "spec" } },
    { linkId: "e2", relation: "depends_on", subject: { entityId: "plan" }, object: { entityId: "design" } },
    { linkId: "e3", relation: "implements", subject: { entityId: "taskReady" }, object: { entityId: "plan" } },
    { linkId: "e4", relation: "implements", subject: { entityId: "taskRunning" }, object: { entityId: "plan" } },
    { linkId: "e5", relation: "derived_from", subject: { entityId: "draftDoc" }, object: { entityId: "spec" } },
  ];

  it("stales only what an approved change can reach, along edges that exist", () => {
    const result = propagateStale({ changed: { entityId: "spec", state: "approved" }, entities, edges });
    expect(result.stale.map((impact) => impact.key).sort()).toEqual(["DES-1", "PLAN-1"]);
    // The draft downstream is left alone: nothing settled was resting on it.
    expect(result.stale.some((impact) => impact.key === "SPEC-2")).toBe(false);
    // A not-started Task is paused; a running attempt is not stopped.
    expect(result.paused.map((impact) => impact.key)).toEqual(["TASK-1"]);
  });

  it("stales nothing when there are no links (D-352)", () => {
    const result = propagateStale({ changed: { entityId: "spec", state: "approved" }, entities, edges: [] });
    expect(result.stale).toEqual([]);
    expect(result.paused).toEqual([]);
  });

  it("stales nothing when the upstream was never approved", () => {
    const result = propagateStale({ changed: { entityId: "spec", state: "draft" }, entities, edges });
    expect(result.stale).toEqual([]);
    expect(result.paused).toEqual([]);
  });

  it("flows the other way for `supports`, where the evidence is upstream", () => {
    const supported: StaleGraphEntity[] = [
      { entityId: "res", kind: "research", key: "RES-1", state: "approved" },
      { entityId: "spec", kind: "spec", key: "SPEC-1", state: "approved" },
    ];
    const supports: StaleGraphEdge[] = [{ linkId: "s1", relation: "supports", subject: { entityId: "res" }, object: { entityId: "spec" } }];
    expect(propagateStale({ changed: { entityId: "res", state: "approved" }, entities: supported, edges: supports }).stale.map((i) => i.key)).toEqual([
      "SPEC-1",
    ]);
    // …and a change to the Spec does not stale the Research that supports it.
    expect(propagateStale({ changed: { entityId: "spec", state: "approved" }, entities: supported, edges: supports }).stale).toEqual([]);
  });

  it("ignores supersedes and survives a cycle", () => {
    const pair: StaleGraphEntity[] = [
      { entityId: "a", kind: "spec", key: "SPEC-1", state: "approved" },
      { entityId: "b", kind: "spec", key: "SPEC-2", state: "approved" },
    ];
    const supersede: StaleGraphEdge[] = [{ linkId: "x", relation: "supersedes", subject: { entityId: "b" }, object: { entityId: "a" } }];
    expect(propagateStale({ changed: { entityId: "a", state: "approved" }, entities: pair, edges: supersede }).stale).toEqual([]);
    const cycle: StaleGraphEdge[] = [
      { linkId: "c1", relation: "depends_on", subject: { entityId: "b" }, object: { entityId: "a" } },
      { linkId: "c2", relation: "depends_on", subject: { entityId: "a" }, object: { entityId: "b" } },
    ];
    const result = propagateStale({ changed: { entityId: "a", state: "approved" }, entities: pair, edges: cycle });
    expect(result.stale.map((impact) => impact.key)).toEqual(["SPEC-2"]);
  });

  it("records the edge and the distance that carried the staleness", () => {
    const result = propagateStale({ changed: { entityId: "spec", state: "approved" }, entities, edges });
    const plan = result.stale.find((impact) => impact.key === "PLAN-1");
    expect(plan).toMatchObject({ viaLinkId: "e2", relation: "depends_on", depth: 2 });
  });
});
