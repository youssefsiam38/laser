/**
 * M21-T15: the Plan DAG and the Project Task engine, over the wire.
 *
 * Every case here goes through `Router.handle` with a real JSON-RPC envelope
 * against the harness whose worker pool throws — the rules are the host's, and
 * a Plan that cannot be ordered, a Task that is not ready, a run that ended or
 * two Tasks writing the same files are all decided without a worker.
 *
 * The three cases an agent decides (completion, review, accepting shared
 * scope) go through `ProjectWorkMethods.handle` with `source: "worker"`,
 * because that is the only way to be an agent: a client connection is always a
 * person, and the actor kind is never read from a request body (M21-T3).
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExecutionLink,
  PlanGraphReport,
  ProjectWorkAttentionNotification,
  ProjectWorkBody,
  ProjectWorkDetail,
  ProjectWorkEntity,
  ProjectWorkEvidence,
  ProjectWorkKind,
  ProjectWorkListResult,
  ProjectWorkUpdatedNotification,
  ProjectWorkWriteResult,
  TaskAssignment,
  TaskConflict,
  TaskReadiness,
} from "@lasercode/protocol";
import type { ProjectWorkRequest } from "../../src/project-work/methods.js";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody } from "./fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

let keys = 0;
const idem = (): string => `k${++keys}`;

type Detail = ProjectWorkDetail & { readiness?: TaskReadiness; conflicts?: TaskConflict[]; planGraph?: PlanGraphReport };
type WriteResult = ProjectWorkWriteResult & { planGraph?: PlanGraphReport };
type ActionResult = {
  entity: ProjectWorkEntity;
  transition: { from: string; to: string };
  seq: number;
  readiness?: TaskReadiness;
  cascaded?: Array<{ key: string; from: string; to: string }>;
};

function taskBodyWith(
  options: {
    outcome?: string;
    dependencies?: string[];
    paths?: string[];
    packages?: string[];
    planKey?: string;
    sharedWith?: string[];
    assignment?: TaskAssignment;
  } = {},
): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: options.outcome ?? "The review footer is sticky on a phone.",
      nonGoals: [],
      dependencies: options.dependencies ?? [],
      scope: {
        packages: options.packages ?? [],
        repositories: [],
        paths: options.paths ?? [],
        capabilities: [],
        ...(options.sharedWith ? { sharedWith: options.sharedWith } : {}),
      },
      acceptance: [{ id: "a1", text: "Approve is reachable at 320px.", machineVerifiable: true }],
      verificationCommands: ["pnpm -F @lasercode/ui test"],
      visualEvidenceRequired: false,
      assignment: options.assignment ?? { policy: "unassigned" },
      ...(options.planKey ? { planKey: options.planKey } : {}),
    },
  };
}

function planBodyWith(taskKeys: string[], dependencies: Array<{ from: string; to: string }> = []): ProjectWorkBody {
  return {
    kind: "plan",
    plan: {
      brief: "Ship phone review.",
      phases: [{ id: "p1", name: "Spine", taskKeys }],
      dependencies,
      boundaries: [],
      migrations: [],
      risks: [],
      verification: ["pnpm verify"],
    },
  };
}

async function create(kind: ProjectWorkKind, title: string, body: ProjectWorkBody): Promise<WriteResult> {
  return ok<WriteResult>(await h.call("project/work/create", { projectId: h.projectId, kind, title, body, idempotencyKey: idem() }));
}

async function revise(entity: ProjectWorkEntity, body: ProjectWorkBody): Promise<WriteResult> {
  return ok<WriteResult>(
    await h.call("project/work/revise", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      body,
      idempotencyKey: idem(),
    }),
  );
}

async function reviseRefusal(entity: ProjectWorkEntity, body: ProjectWorkBody): Promise<string> {
  return failed(
    await h.call("project/work/revise", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      body,
      idempotencyKey: idem(),
    }),
  ).message;
}

async function detail(entityId: string): Promise<Detail> {
  return ok<Detail>(await h.call("project/work/get", { projectId: h.projectId, entityId }));
}

async function act(
  entity: ProjectWorkEntity,
  action: string,
  extra: { note?: string; evidenceId?: string } = {},
): Promise<ActionResult> {
  return ok<ActionResult>(
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      action,
      ...extra,
      idempotencyKey: idem(),
    }),
  );
}

async function actRefusal(
  entity: ProjectWorkEntity,
  action: string,
  extra: { note?: string; evidenceId?: string } = {},
): Promise<{ code: number; message: string; data?: unknown }> {
  return failed(
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      action,
      ...extra,
      idempotencyKey: idem(),
    }),
  );
}

/** Acceptance evidence a person recorded against the Task's current revision. */
async function acceptanceEvidence(entity: ProjectWorkEntity, outcome: "passed" | "failed" = "passed"): Promise<ProjectWorkEvidence> {
  const result = ok<{ link: { evidence: ProjectWorkEvidence } }>(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: entity.currentRevisionId,
      link: {
        type: "evidence",
        entityId: entity.entityId,
        revisionId: entity.currentRevisionId,
        kind: "test",
        role: "acceptance",
        summary: "pnpm -F @lasercode/ui test",
        outcome,
      },
      idempotencyKey: idem(),
    }),
  );
  return result.link.evidence;
}

async function edge(
  relation: string,
  subject: { entityId: string; revisionId: string },
  object: { entityId: string; revisionId: string },
): Promise<void> {
  ok(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: subject.revisionId,
      link: { type: "edge", relation, subject, object },
      idempotencyKey: idem(),
    }),
  );
}

/** Take an artifact from draft to approved, the way a person does. */
async function approve(write: WriteResult): Promise<void> {
  ok(
    await h.call("project/work/review", {
      projectId: h.projectId,
      entityId: write.entity.entityId,
      expectedRevisionId: write.revision.revisionId,
      action: "request_review",
      idempotencyKey: idem(),
    }),
  );
  ok(
    await h.call("project/work/approve", {
      projectId: h.projectId,
      entityId: write.entity.entityId,
      expectedRevisionId: write.revision.revisionId,
      gate: write.entity.kind === "spec" ? "brief" : "build",
      decision: "approved",
      covers: [
        {
          entityId: write.entity.entityId,
          kind: write.entity.kind,
          key: write.entity.key,
          revisionId: write.revision.revisionId,
          digest: write.revision.digest,
        },
      ],
      idempotencyKey: idem(),
    }),
  );
}

/** The same authority, entered as the worker bridge does: an agent. */
function asAgent(request: ProjectWorkRequest): unknown {
  return h.methods.handle(request, {
    actor: { class: "local_app", id: "l1.app" },
    source: "worker",
    agent: { label: "Builder", sessionId: "ses_1" },
  });
}

// ---------------------------------------------------------------------------

describe("the Plan's task graph is validated before it is stored", () => {
  it("refuses a cycle and names the keys it goes round", async () => {
    h = projectWorkHarness();
    const first = await create("task", "Footer", taskBodyWith());
    const second = await create("task", "Safe area", taskBodyWith());
    const refusal = failed(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "plan",
        title: "Phone review",
        body: planBodyWith(
          [first.entity.key, second.entity.key],
          [
            { from: first.entity.key, to: second.entity.key },
            { from: second.entity.key, to: first.entity.key },
          ],
        ),
        idempotencyKey: idem(),
      }),
    );
    expect(refusal.message).toContain(`${first.entity.key} → ${second.entity.key} → ${first.entity.key}`);
    expect(refusal.message).toContain("dependency-ordered");
    // Nothing was written: the project still holds only the two tasks.
    expect(h.store.list({ projectId: h.projectId }).counts.byKind.plan).toBe(0);
    expect(h.workerAttempts()).toBe(0);
  });

  it("refuses a key this project never minted", async () => {
    h = projectWorkHarness();
    const refusal = failed(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "plan",
        title: "Phone review",
        body: planBodyWith(["TASK-99"]),
        idempotencyKey: idem(),
      }),
    );
    expect(refusal.message).toBe("TASK-99 is not in this project, so this plan cannot name it.");
  });

  it("refuses a revision that drops a task a dependency still names", async () => {
    h = projectWorkHarness();
    const first = await create("task", "Footer", taskBodyWith());
    const second = await create("task", "Safe area", taskBodyWith());
    const plan = await create(
      "plan",
      "Phone review",
      planBodyWith([first.entity.key, second.entity.key], [{ from: second.entity.key, to: first.entity.key }]),
    );
    expect(plan.planGraph?.ok).toBe(true);
    expect(plan.planGraph?.order).toEqual([first.entity.key, second.entity.key]);
    const message = await reviseRefusal(
      plan.entity,
      planBodyWith([second.entity.key], [{ from: second.entity.key, to: first.entity.key }]),
    );
    expect(message).toContain(`${first.entity.key} is named by a dependency`);
    // The stored plan is untouched: it still lists both tasks.
    const stored = await detail(plan.entity.entityId);
    expect(stored.planGraph?.order).toEqual([first.entity.key, second.entity.key]);
  });

  it("records the task a revision stopped listing, rather than losing it", async () => {
    h = projectWorkHarness();
    const plan = await create("plan", "Phone review", planBodyWith([]));
    const first = await create("task", "Footer", taskBodyWith({ planKey: plan.entity.key }));
    const second = await create("task", "Safe area", taskBodyWith({ planKey: plan.entity.key }));
    const listed = await revise(plan.entity, planBodyWith([first.entity.key, second.entity.key]));
    expect(listed.planGraph?.orphans).toEqual([]);

    const dropped = await revise(listed.entity, planBodyWith([first.entity.key]));
    expect(dropped.planGraph?.ok).toBe(true);
    expect(dropped.planGraph?.orphans).toEqual([
      { key: second.entity.key, entityId: second.entity.entityId, title: "Safe area", state: "draft", reason: "removed_from_plan" },
    ]);
    // And every later read of the plan says so too.
    const stored = await detail(plan.entity.entityId);
    expect(stored.planGraph?.orphans.map((orphan) => orphan.key)).toEqual([second.entity.key]);
  });
});

describe("readiness is derived, never stored", () => {
  it("names the unmet dependency on a read, in the list row and in the refusal", async () => {
    h = projectWorkHarness();
    const first = await create("task", "Footer", taskBodyWith());
    const second = await create("task", "Safe area", taskBodyWith({ dependencies: [first.entity.key] }));

    const read = await detail(second.entity.entityId);
    expect(read.readiness).toMatchObject({ ready: false, unmetDependencies: [first.entity.key], hasAcceptanceEvidence: false });
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId, kinds: ["task"] }));
    expect(list.items.find((item) => item.key === second.entity.key)?.unmetDependencies).toEqual([first.entity.key]);
    const refusal = await actRefusal(second.entity, "mark_ready");
    expect(refusal.message).toBe(`${first.entity.key} must be done first.`);
  });

  it("frees what was waiting when the dependency is done, and blocks it again when it is reopened", async () => {
    h = projectWorkHarness();
    const first = await create("task", "Footer", taskBodyWith());
    const second = await create("task", "Safe area", taskBodyWith({ dependencies: [first.entity.key] }));
    const blocked = await act(second.entity, "block");
    expect(blocked.entity.state).toBe("blocked");

    await acceptanceEvidence(first.entity);
    await act(first.entity, "mark_ready");
    await act(first.entity, "start");
    const done = await act(first.entity, "complete");
    expect(done.entity.state).toBe("done");
    expect(done.cascaded).toEqual([{ entityId: second.entity.entityId, key: second.entity.key, from: "blocked", to: "ready" }]);
    expect((await detail(second.entity.entityId)).entity.state).toBe("ready");
    // The board hears about it: the cascade is on the event stream, after the
    // change that caused it, so a client reconciling from the completion's
    // sequence number still sees it.
    const announced = h.notifications
      .filter((notification) => notification.method === "project/work/updated")
      .map((notification) => (notification.params as ProjectWorkUpdatedNotification))
      .filter((notification) => notification.change.entityId === second.entity.entityId && notification.change.change === "state");
    expect(announced.at(-1)?.change.state).toBe("ready");
    expect(announced.at(-1)?.seq).toBeGreaterThan(done.seq);

    const reopened = await act(done.entity, "reopen");
    expect(reopened.cascaded).toEqual([{ entityId: second.entity.entityId, key: second.entity.key, from: "ready", to: "blocked" }]);
    const after = await detail(second.entity.entityId);
    expect(after.entity.state).toBe("blocked");
    expect(after.readiness?.unmetDependencies).toEqual([first.entity.key]);
    // A blocked task is something waiting on a person, and says which sort.
    const attention = h.methods.attention(h.projectId);
    expect(attention.items.find((item) => item.key === second.entity.key)?.reason).toBe("blocked_task");
  });

  it("satisfies a dependency on an artifact only when it is approved", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBody());
    const task = await create("task", "Footer", taskBodyWith({ dependencies: [spec.entity.key] }));
    expect((await detail(task.entity.entityId)).readiness?.unmetDependencies).toEqual([spec.entity.key]);
    await approve(spec);
    const read = await detail(task.entity.entityId);
    expect(read.readiness).toMatchObject({ ready: true, unmetDependencies: [] });
    expect((await act(task.entity, "mark_ready")).entity.state).toBe("ready");
  });
});

describe("a stale upstream pauses a task without failing it", () => {
  it("refuses the start by name, lets the running attempt carry on, and refuses done either way", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBody());
    const plan = await create("plan", "Phone review", planBodyWith([]));
    const waiting = await create("task", "Footer", taskBodyWith());
    const running = await create("task", "Safe area", taskBodyWith());
    await edge("depends_on", { entityId: plan.entity.entityId, revisionId: plan.revision.revisionId }, { entityId: spec.entity.entityId, revisionId: spec.revision.revisionId });
    await edge("implements", { entityId: waiting.entity.entityId, revisionId: waiting.revision.revisionId }, { entityId: plan.entity.entityId, revisionId: plan.revision.revisionId });
    await edge("implements", { entityId: running.entity.entityId, revisionId: running.revision.revisionId }, { entityId: plan.entity.entityId, revisionId: plan.revision.revisionId });
    await approve(spec);
    await approve(plan);
    await act(waiting.entity, "mark_ready");
    await act(running.entity, "mark_ready");
    await act(running.entity, "start");
    await acceptanceEvidence(running.entity);

    // The approved Spec moves: the Plan goes stale, and the Tasks under it feel it.
    await revise(spec.entity, specBody("People cannot review a design away from their desk."));
    const stalePlan = await detail(plan.entity.entityId);
    expect(stalePlan.entity.state).toBe("stale");

    const refusal = await actRefusal(waiting.entity, "start");
    expect(refusal.message).toBe(`${plan.entity.key} changed after this task was planned. Reconcile it before starting this task.`);
    expect(refusal.data).toEqual({
      refused: "stale_upstream",
      upstream: {
        entityId: plan.entity.entityId,
        kind: "plan",
        key: plan.entity.key,
        revisionId: stalePlan.entity.currentRevisionId,
      },
    });
    // The attempt already running may finish and ask for review…
    const review = await act(running.entity, "submit_for_review");
    expect(review.entity.state).toBe("needs_review");
    // …and still cannot reach done until the plan is reconciled.
    const completion = await actRefusal(review.entity, "complete");
    expect(completion.message).toContain(`${plan.entity.key} changed after this task was planned`);

    const paused = await detail(waiting.entity.entityId);
    expect(paused.entity.state).toBe("ready");
    expect(paused.readiness?.stalePausedBy?.key).toBe(plan.entity.key);
    const attention = h.notifications
      .filter((notification) => notification.method === "project/work/attention")
      .map((notification) => notification.params as ProjectWorkAttentionNotification)
      .at(-1);
    expect(attention?.items.find((item) => item.key === waiting.entity.key)?.reason).toBe("stale");
  });
});

describe("what done requires, and what a run ending is", () => {
  it("refuses a drop from in progress with nothing to show, and takes the one with acceptance evidence", async () => {
    h = projectWorkHarness();
    const task = await create("task", "Footer", taskBodyWith());
    await act(task.entity, "mark_ready");
    const started = await act(task.entity, "start");
    expect(started.entity.state).toBe("in_progress");
    const refusal = await actRefusal(started.entity, "complete");
    expect(refusal.message).toBe("Add the acceptance evidence for this task before marking it done.");

    const evidence = await acceptanceEvidence(task.entity);
    const done = await act(started.entity, "complete", { evidenceId: evidence.evidenceId });
    expect(done.transition).toEqual({ from: "in_progress", to: "done" });
    expect(done.readiness?.hasAcceptanceEvidence).toBe(true);
  });

  it("refuses acceptance evidence that did not pass, and keeps the failure as evidence", async () => {
    h = projectWorkHarness();
    const task = await create("task", "Footer", taskBodyWith());
    const refusal = failed(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "evidence",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          kind: "test",
          role: "acceptance",
          summary: "pnpm -F @lasercode/ui test",
          outcome: "failed",
        },
        idempotencyKey: idem(),
      }),
    );
    expect(refusal.message).toContain("a failed attempt is evidence, not a failed task");
    ok(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "evidence",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          kind: "test",
          role: "supporting",
          summary: "pnpm -F @lasercode/ui test",
          outcome: "failed",
        },
        idempotencyKey: idem(),
      }),
    );
    const read = await detail(task.entity.entityId);
    expect(read.evidence).toHaveLength(1);
    expect(read.evidence[0]).toMatchObject({ role: "supporting", outcome: "failed", revisionId: task.revision.revisionId });
    expect(read.entity.state).toBe("draft");
  });

  it("records an attempt that ended as evidence and moves nothing", async () => {
    h = projectWorkHarness();
    const task = await create("task", "Footer", taskBodyWith());
    await act(task.entity, "mark_ready");
    const started = await act(task.entity, "start");
    const linked = ok<{ link: ExecutionLink; entity: ProjectWorkEntity; attemptEvidence?: ProjectWorkEvidence }>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "agent_run", targetId: "run_1", endedAt: "2026-01-01T00:00:00.000Z", outcome: "completed" },
        idempotencyKey: idem(),
      }),
    );
    // The run finished. The Task did not.
    expect(linked.entity.state).toBe("in_progress");
    expect(linked.attemptEvidence).toMatchObject({ role: "supporting", outcome: "passed" });
    expect(linked.attemptEvidence?.summary).toBe("Attempt 1 ended: completed.");
    const refusal = await actRefusal(started.entity, "complete");
    expect(refusal.message).toBe("Add the acceptance evidence for this task before marking it done.");

    const failedAttempt = ok<{ attemptEvidence?: ProjectWorkEvidence; entity: ProjectWorkEntity }>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "agent_run", targetId: "run_2", endedAt: "2026-01-01T01:00:00.000Z", outcome: "failed" },
        idempotencyKey: idem(),
      }),
    );
    expect(failedAttempt.attemptEvidence).toMatchObject({ role: "supporting", outcome: "failed" });
    expect(failedAttempt.entity.state).toBe("in_progress");
  });

  it("wants to know why a task is cancelled, and keeps the answer", async () => {
    h = projectWorkHarness();
    const task = await create("task", "Footer", taskBodyWith());
    const refusal = await actRefusal(task.entity, "cancel");
    expect(refusal.message).toBe("Say why this task is being cancelled, so the record says what happened to it.");
    const cancelled = await act(task.entity, "cancel", { note: "The phone footer moved into the shell instead." });
    expect(cancelled.entity.state).toBe("cancelled");
    const read = await detail(task.entity.entityId);
    expect(read.evidence.map((record) => record.summary)).toEqual(["Cancelled: The phone footer moved into the shell instead."]);
    expect(read.evidence[0]).toMatchObject({ kind: "review", role: "deviation", outcome: "inconclusive" });
  });

  it("lets an agent report and ask, and keeps completion with the person", async () => {
    h = projectWorkHarness();
    const task = await create("task", "Footer", taskBodyWith());
    await act(task.entity, "mark_ready");
    const started = await act(task.entity, "start");
    const action = (name: string): ProjectWorkRequest =>
      ({
        method: "project/task/action",
        params: {
          projectId: h.projectId,
          entityId: task.entity.entityId,
          expectedRevisionId: task.revision.revisionId,
          action: name,
          idempotencyKey: idem(),
        },
      }) as ProjectWorkRequest;

    expect(() => asAgent(action("submit_for_review"))).toThrow(/Report the evidence for this task before sending it for review/);
    await acceptanceEvidence(started.entity);
    expect(asAgent(action("submit_for_review"))).toMatchObject({ transition: { from: "in_progress", to: "needs_review" } });
    expect(() => asAgent(action("complete"))).toThrow(/An agent reports evidence; a person completes the task/);
    expect((await detail(task.entity.entityId)).entity.state).toBe("needs_review");
  });
});

describe("assignment is a policy, never a session", () => {
  it("changes who a task is for without embedding the run it was attempted in", async () => {
    h = projectWorkHarness();
    const task = await create("task", "Footer", taskBodyWith());
    await act(task.entity, "mark_ready");
    const started = await act(task.entity, "start");
    ok(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "session", targetId: "ses_private_1", profileId: "builder" },
        idempotencyKey: idem(),
      }),
    );
    const assigned = await revise(started.entity, taskBodyWith({ assignment: { policy: "agent", agentName: "Builder" } }));
    // A task revision never changes the task's own state…
    expect(assigned.entity.state).toBe("in_progress");
    const stored = h.store.canonicalBody(h.projectId, assigned.revision.revisionId);
    const body = JSON.parse(stored) as ProjectWorkBody;
    expect(body.kind === "task" && body.task.assignment).toEqual({ policy: "agent", agentName: "Builder" });
    // …and the attempt stays a link: no session or run id is in the body.
    expect(stored).not.toContain("ses_private_1");
    expect(stored).not.toContain("sessionId");
    expect(stored).not.toContain("runId");
    const read = await detail(task.entity.entityId);
    expect(read.executionLinks.map((link) => link.targetId)).toEqual(["ses_private_1"]);
  });
});

describe("two tasks writing in the same place", () => {
  it("shows each one the other, and never finds out afterwards", async () => {
    h = projectWorkHarness();
    const first = await create("task", "Footer", taskBodyWith({ paths: ["packages/ui/src/workspace"], packages: ["@lasercode/ui"] }));
    const second = await create("task", "Safe area", taskBodyWith({ paths: ["packages/ui"], packages: ["@lasercode/ui"] }));
    await act(first.entity, "mark_ready");
    const ready = await act(second.entity, "mark_ready");

    const mine = await detail(first.entity.entityId);
    expect(mine.conflicts).toHaveLength(1);
    expect(mine.conflicts?.[0]).toMatchObject({
      key: second.entity.key,
      title: "Safe area",
      state: "ready",
      observed: false,
      accepted: false,
      overlap: { packages: ["@lasercode/ui"], paths: ["packages/ui/src/workspace"] },
    });
    const theirs = await detail(second.entity.entityId);
    expect(theirs.conflicts?.map((conflict) => conflict.key)).toEqual([first.entity.key]);

    // And again the moment an attempt is about to write.
    const linked = ok<{ conflicts?: TaskConflict[] }>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: second.entity.entityId,
        expectedRevisionId: second.revision.revisionId,
        execution: { kind: "session", targetId: "ses_2" },
        idempotencyKey: idem(),
      }),
    );
    expect(linked.conflicts?.map((conflict) => conflict.key)).toEqual([first.entity.key]);
    expect(ready.entity.state).toBe("ready");
  });

  it("marks the conflict accepted only when a person said so", async () => {
    h = projectWorkHarness();
    const first = await create("task", "Footer", taskBodyWith({ paths: ["packages/ui"] }));
    const second = await create("task", "Safe area", taskBodyWith({ paths: ["packages/ui"] }));
    await act(first.entity, "mark_ready");
    await act(second.entity, "mark_ready");

    const agentTried = (): unknown =>
      asAgent({
        method: "project/work/revise",
        params: {
          projectId: h.projectId,
          entityId: second.entity.entityId,
          expectedRevisionId: second.revision.revisionId,
          body: taskBodyWith({ paths: ["packages/ui"], sharedWith: [first.entity.key] }),
          idempotencyKey: idem(),
        },
      } as ProjectWorkRequest);
    expect(agentTried).toThrow(/Only you can accept the risk of two tasks writing the same files/);

    const accepted = await revise(second.entity, taskBodyWith({ paths: ["packages/ui"], sharedWith: [first.entity.key] }));
    expect(accepted.entity.state).toBe("ready");
    expect((await detail(first.entity.entityId)).conflicts?.[0]).toMatchObject({ key: second.entity.key, accepted: true });
    expect((await detail(second.entity.entityId)).conflicts?.[0]).toMatchObject({ key: first.entity.key, accepted: true });
  });

  it("sees an overlap a task never declared, from what its attempt recorded", async () => {
    h = projectWorkHarness();
    const repositoryId = h.store.ensureRepository({
      projectId: h.projectId,
      gitCommonDir: `${h.projectRoot}/.git`,
      rootCommitId: "a".repeat(40),
      name: "alpha",
    });
    const declared = await create("task", "Footer", taskBodyWith({ paths: ["packages/host/src/project-work"] }));
    const quiet = await create("task", "Safe area", taskBodyWith());
    await act(declared.entity, "mark_ready");
    await act(quiet.entity, "mark_ready");
    expect((await detail(declared.entity.entityId)).conflicts).toBeUndefined();

    ok(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: quiet.revision.revisionId,
        link: {
          type: "repository",
          relation: "verified_at",
          subjectEntityId: quiet.entity.entityId,
          subjectRevisionId: quiet.revision.revisionId,
          repositoryId,
          target: {
            state: { vcs: "git", objectFormat: "sha1", commitObjectId: "b".repeat(40), path: "packages/host/src/project-work/store.ts" },
          },
        },
        idempotencyKey: idem(),
      }),
    );
    const conflicts = (await detail(declared.entity.entityId)).conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts?.[0]).toMatchObject({
      key: quiet.entity.key,
      observed: true,
      overlap: { packages: [], paths: ["packages/host/src/project-work/store.ts"] },
    });
    expect(h.workerAttempts()).toBe(0);
  });
});
