/**
 * M21-T19 · verification and convergence, through the real authority.
 *
 * Every test here goes through `ProjectWorkMethods.handleBridge` with the
 * envelope a verifier really sends, over the router harness whose worker pool
 * throws: the criteria are derived from the store, the verdicts are the host's
 * and the only thing the caller supplies is what a command did.
 *
 * What is pinned:
 *
 * - the four authorities, read at the exact revisions the links name;
 * - a passing run reaching `needs_review` and never `done`;
 * - a failing command leaving the Task where it was, with the report naming
 *   what failed;
 * - a blocking comment and an invalidated approval each refusing convergence
 *   on their own;
 * - Native visual evidence waiting on an accepted checkpoint preview;
 * - a declared browser matrix listed as the person's, with its steps;
 * - the report stored as `verification` evidence at the exact revision, with
 *   its canonical blob readable;
 * - a deviation accepted through the ordinary revise path staling only the
 *   Tasks the change can reach.
 */
import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  VERIFICATION_REPORT_MEDIA_TYPE,
  type ProjectWorkBlobReadResult,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkBody,
  type ProjectWorkGetResult,
  type ProjectWorkWriteResult,
  type VerificationCommandRun,
  type VerificationPlan,
  type VerificationReport,
} from "@lasercode/protocol";
import { projectWorkHarness, ok, type ProjectWorkHarness } from "./harness.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const AGENT = { label: "Verifier", sessionId: "ses_v", runId: "run_v" };

async function bridge(request: ProjectWorkBridgeParams["request"], extras: Partial<ProjectWorkBridgeParams> = {}): Promise<ProjectWorkBridgeResult> {
  return h.methods.handleBridge({ agent: AGENT, request, ...extras }, { actor: ACTOR, cwd: h.projectRoot });
}

function commandRun(command: string, passed: boolean): VerificationCommandRun {
  const text = passed ? "ok\n" : "1 failing\n";
  return {
    command,
    status: passed ? "passed" : "failed",
    exitCode: passed ? 0 : 1,
    startedAt: "2026-03-01T09:00:00.000Z",
    endedAt: "2026-03-01T09:01:00.000Z",
    outputBytes: text.length,
    outputDigest: "b".repeat(64),
    tail: text,
  };
}

/** Ask the host what a Task has to satisfy. */
async function plan(entityId: string): Promise<VerificationPlan> {
  const answer = await bridge(
    { method: "project/work/get", params: { projectId: h.projectId, entityId, body: { mode: "none" } } },
    { verify: { action: "plan" } },
  );
  expect(answer.verifyResult?.plan, "the host answers with a plan").toBeDefined();
  return answer.verifyResult!.plan!;
}

/** Report one run's command results and take back what the host decided. */
async function report(
  entityId: string,
  revisionId: string,
  commands: VerificationCommandRun[],
  extras: { runId?: string; deviations?: ProjectWorkBridgeParams["verify"] extends never ? never : never } = {},
): Promise<ProjectWorkBridgeResult> {
  return bridge(
    {
      method: "project/work/link",
      params: {
        projectId: h.projectId,
        expectedRevisionId: revisionId,
        link: {
          type: "evidence",
          entityId,
          revisionId,
          kind: "verification",
          role: "supporting",
          summary: "Verification",
          outcome: "inconclusive",
        },
        idempotencyKey: `verify-${extras.runId ?? "r1"}`,
      },
    },
    {
      verify: {
        action: "report",
        runId: extras.runId ?? "ver_0001",
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:05:00.000Z",
        commands,
      },
    },
  );
}

// --------------------------------------------------------------------- world

function specBody(): ProjectWorkBody {
  return {
    kind: "spec",
    spec: {
      form: "full",
      brief: "An export that fails says why.",
      outcomes: ["Nobody opens a log to find out why."],
      nonGoals: [],
      requirements: [{ id: "r1", text: "The reason never names an internal path.", level: "must" }],
      acceptance: [
        { id: "a1", text: "A failed export row shows the reason.", machineVerifiable: true },
        { id: "a2", text: "The reason reads as a sentence.", machineVerifiable: false },
      ],
      constraints: [],
    },
  };
}

function designBody(): ProjectWorkBody {
  return {
    kind: "design",
    design: {
      brief: "The export row.",
      screens: [
        {
          id: "s1",
          name: "Export list",
          theme: "dark",
          viewport: "narrow",
          content: {
            tree: {
              rootNodeId: "n1",
              nodes: [
                {
                  id: "n1",
                  component: { primitive: "stack" },
                  fidelity: "mapped",
                  props: { background: { type: "token", tokenId: "surface-2" } },
                  children: [],
                },
              ],
            },
          },
          states: [
            { name: "failed", included: true },
            { name: "empty", included: false, skipReason: "the list is never empty here" },
          ],
          fidelity: "mapped",
        },
      ],
      flows: [],
      sketches: [],
      fidelity: "mapped",
      fixtures: [],
    },
  };
}

function planBody(taskKeys: string[]): ProjectWorkBody {
  return {
    kind: "plan",
    plan: {
      brief: "Ship the export reasons.",
      phases: [{ id: "p1", name: "Build", taskKeys }],
      dependencies: [],
      boundaries: [
        { scope: "security", rule: "A reason never carries a credential." },
        { scope: "accessibility", rule: "The reason is announced when the row updates." },
      ],
      migrations: [{ summary: "Backfill the reason column.", reversible: true }],
      risks: [],
      verification: ["pnpm -F exports test", "browser matrix: themes=light,dark; widths=narrow,wide"],
    },
  };
}

function taskBody(over: { commands?: string[]; visual?: boolean; planKey?: string } = {}): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: "The export list shows why a failed export failed.",
      nonGoals: [],
      dependencies: [],
      scope: { packages: ["exports"], repositories: [], paths: ["src/exports/list.ts"], capabilities: [] },
      acceptance: [{ id: "a1", text: "A failed export row shows the reason.", machineVerifiable: true, command: "pnpm -F exports test" }],
      verificationCommands: over.commands ?? ["pnpm -F exports test"],
      visualEvidenceRequired: over.visual ?? false,
      assignment: { policy: "agent", agentName: "worker" },
      ...(over.planKey !== undefined ? { planKey: over.planKey } : {}),
    },
  };
}

interface World {
  spec: ProjectWorkWriteResult;
  design: ProjectWorkWriteResult;
  plan: ProjectWorkWriteResult;
  task: ProjectWorkWriteResult;
}

/** A Task with all four authorities linked, started, ready to be verified. */
async function world(over: { commands?: string[]; visual?: boolean } = {}): Promise<World> {
  h = projectWorkHarness();
  mkdirSync(h.projectRoot, { recursive: true });
  const spec = ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", { projectId: h.projectId, kind: "spec", title: "Exports say why", body: specBody(), idempotencyKey: "c-spec" }),
  );
  const design = ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", { projectId: h.projectId, kind: "design", title: "Export row", body: designBody(), idempotencyKey: "c-design" }),
  );
  const task = ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", { projectId: h.projectId, kind: "task", title: "Failed rows say why", body: taskBody(over), idempotencyKey: "c-task" }),
  );
  const plan = ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", {
      projectId: h.projectId,
      kind: "plan",
      title: "Export reasons",
      body: planBody([task.entity.key]),
      idempotencyKey: "c-plan",
    }),
  );
  // The Task names its Plan; edges name the Spec and the Design, each at the
  // exact revision this work was drawn against.
  const retold = ok<ProjectWorkWriteResult>(
    await h.call("project/work/revise", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      body: taskBody({ ...over, planKey: plan.entity.key }),
      idempotencyKey: "r-task",
    }),
  );
  for (const [object, key] of [
    [spec, "e-spec"],
    [design, "e-design"],
  ] as const) {
    ok(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: retold.revision.revisionId,
        link: {
          type: "edge",
          relation: "implements",
          subject: { entityId: retold.entity.entityId, revisionId: retold.revision.revisionId },
          object: { entityId: object.entity.entityId, revisionId: object.revision.revisionId },
        },
        idempotencyKey: key,
      }),
    );
  }
  for (const action of ["mark_ready", "start"] as const) {
    ok(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: retold.entity.entityId,
        expectedRevisionId: retold.revision.revisionId,
        action,
        idempotencyKey: `${action}-task`,
      }),
    );
  }
  return { spec, design, plan, task: retold };
}

/** The Task's current revision, which every fence has to quote. */
async function current(entityId: string): Promise<ProjectWorkGetResult> {
  return ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId, body: { mode: "none" } }));
}

// --------------------------------------------------------------------- tests

describe("gathering the four authorities", () => {
  it("reads spec, design, plan and task at the exact revisions their links name", async () => {
    const w = await world();
    const derived = await plan(w.task.entity.entityId);
    const byAuthority = new Map(derived.authorities.map((source) => [source.authority, source]));
    expect([...byAuthority.keys()].sort()).toEqual(["design", "plan", "spec", "task"]);
    expect(byAuthority.get("spec")!.revisionId, "the revision the edge pinned").toBe(w.spec.revision.revisionId);
    expect(byAuthority.get("design")!.revisionId).toBe(w.design.revision.revisionId);
    expect(byAuthority.get("spec")!.digest).toBe(w.spec.revision.digest);
    expect(derived.commands).toEqual(["pnpm -F exports test"]);
  });

  it("turns each authority into criteria a person can read, and says which authority each came from", async () => {
    const w = await world();
    const derived = await plan(w.task.entity.entityId);
    const kinds = new Set(derived.criteria.map((criterion) => criterion.kind));
    expect(kinds.has("acceptance")).toBe(true);
    expect(kinds.has("design_state"), "an included screen state is a criterion").toBe(true);
    expect(kinds.has("design_token")).toBe(true);
    expect(kinds.has("security"), "a boundary whose own scope says security is filed as security").toBe(true);
    expect(kinds.has("accessibility")).toBe(true);
    expect(kinds.has("migration")).toBe(true);
    expect(kinds.has("browser_matrix")).toBe(true);
    // A state the Design skipped is not something the implementation owes.
    expect(derived.criteria.some((criterion) => criterion.text.includes("empty state"))).toBe(false);
  });

  it("lists a declared browser matrix as the person's, with the exact steps, and never runs it", async () => {
    const w = await world();
    const derived = await plan(w.task.entity.entityId);
    const matrix = derived.criteria.filter((criterion) => criterion.kind === "browser_matrix");
    expect(matrix.length, "themes × widths, from the Plan's own declaration").toBeGreaterThanOrEqual(4);
    expect(matrix.every((criterion) => criterion.machineVerifiable === false)).toBe(true);
    expect(matrix.every((criterion) => (criterion.steps ?? []).length > 0)).toBe(true);
    expect(derived.commands, "a matrix is never a command this run executes").toEqual(["pnpm -F exports test"]);
  });
});

describe("a run that passes everything it can decide", () => {
  it("moves the task to needs_review, never to done, and stores the report as verification evidence", async () => {
    const w = await world();
    const answer = await report(w.task.entity.entityId, w.task.revision.revisionId, [commandRun("pnpm -F exports test", true)]);
    const verify = answer.verifyResult!;
    expect(verify.report!.converged).toBe(true);
    expect(verify.report!.outcome).toBe("converged");
    expect(verify.taskState).toBe("needs_review");
    expect(verify.transition).toEqual({ from: "in_progress", to: "needs_review" });

    const detail = await current(w.task.entity.entityId);
    const record = detail.evidence.find((row) => row.evidenceId === verify.evidenceId)!;
    expect(record.kind).toBe("verification");
    expect(record.role, "a converged run is acceptance evidence a person may complete on").toBe("acceptance");
    expect(record.outcome).toBe("passed");
    expect(record.revisionId, "the exact revision this run checked").toBe(w.task.revision.revisionId);
    expect(detail.entity.state, "nothing a run does reaches done").not.toBe("done");
  });

  it("keeps the whole report as a canonical blob the evidence names", async () => {
    const w = await world();
    const answer = await report(w.task.entity.entityId, w.task.revision.revisionId, [commandRun("pnpm -F exports test", true)]);
    const blobId = answer.verifyResult!.blobId!;
    const page = ok<ProjectWorkBlobReadResult>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId }));
    expect(page.mediaType).toBe(VERIFICATION_REPORT_MEDIA_TYPE);
    const stored = JSON.parse(Buffer.from(page.data!, "base64").toString("utf8")) as VerificationReport;
    expect(stored.task.revisionId).toBe(w.task.revision.revisionId);
    expect(stored.authorities).toHaveLength(4);
    expect(stored.personDecisions.length, "what is left to a person is in the report").toBeGreaterThan(0);
  });
});

describe("a run that does not converge", () => {
  it("leaves a failing command's task in progress, with the report naming what failed", async () => {
    const w = await world();
    const answer = await report(w.task.entity.entityId, w.task.revision.revisionId, [commandRun("pnpm -F exports test", false)]);
    const verify = answer.verifyResult!;
    expect(verify.report!.converged).toBe(false);
    expect(verify.report!.outcome).toBe("failed");
    expect(verify.taskState).toBe("in_progress");
    expect(verify.transition).toBeUndefined();
    const blocker = verify.report!.blockers.find((row) => row.kind === "failed_check");
    expect(blocker?.detail).toContain("pnpm -F exports test");
    const record = (await current(w.task.entity.entityId)).evidence.find((row) => row.evidenceId === verify.evidenceId)!;
    expect(record.role, "a failed run is evidence, not acceptance").toBe("supporting");
    expect(record.outcome).toBe("failed");
  });

  it("refuses to converge while a blocking comment is open, and names it", async () => {
    const w = await world();
    const task = await current(w.task.entity.entityId);
    ok(
      await h.call("project/work/comment", {
        projectId: h.projectId,
        entityId: w.task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        revisionId: task.revision.revisionId,
        anchor: { target: "entity" },
        text: "The reason still names a file path.",
        blocking: true,
        idempotencyKey: "cmt-1",
      }),
    );
    const answer = await report(w.task.entity.entityId, task.revision.revisionId, [commandRun("pnpm -F exports test", true)]);
    const verify = answer.verifyResult!;
    expect(verify.taskState, "a blocking comment keeps it where it is").toBe("in_progress");
    expect(verify.report!.converged).toBe(false);
    expect(verify.report!.blockers.some((row) => row.kind === "blocking_comment")).toBe(true);
    expect(verify.report!.blockers[0]!.detail).toContain("blocking comment");
  });

  it("refuses to converge while an approval a later change invalidated is still on the record", async () => {
    const w = await world();
    // The Spec is approved, then revised: the approval the Task was planned
    // under is no longer about what the Spec says.
    ok(
      await h.call("project/work/review", {
        projectId: h.projectId,
        entityId: w.spec.entity.entityId,
        expectedRevisionId: w.spec.revision.revisionId,
        action: "request_review",
        idempotencyKey: "rr-spec",
      }),
    );
    ok(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: w.spec.entity.entityId,
        expectedRevisionId: w.spec.revision.revisionId,
        gate: "brief",
        decision: "approved",
        covers: [
          {
            entityId: w.spec.entity.entityId,
            kind: "spec",
            key: w.spec.entity.key,
            revisionId: w.spec.revision.revisionId,
            digest: w.spec.revision.digest,
          },
        ],
        idempotencyKey: "ap-spec",
      }),
    );
    const changed = specBody();
    (changed as { spec: { brief: string } }).spec.brief = "An export that fails says why, and what to do next.";
    ok(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: w.spec.entity.entityId,
        expectedRevisionId: w.spec.revision.revisionId,
        body: changed,
        idempotencyKey: "rev-spec",
      }),
    );
    const task = await current(w.task.entity.entityId);
    const answer = await report(w.task.entity.entityId, task.revision.revisionId, [commandRun("pnpm -F exports test", true)]);
    const verify = answer.verifyResult!;
    expect(verify.report!.blockers.some((row) => row.kind === "stale_approval")).toBe(true);
    expect(verify.taskState).toBe("in_progress");
  });
});

describe("native visual evidence", () => {
  it("waits on the person's accepted checkpoint preview, and is satisfied by the verified_at link it records", async () => {
    const w = await world({ visual: true });
    const first = await report(w.task.entity.entityId, w.task.revision.revisionId, [commandRun("pnpm -F exports test", true)], {
      runId: "ver_0001",
    });
    const visual = first.verifyResult!.report!.findings.find((finding) => finding.criterionId === "task:visual")!;
    expect(visual.outcome, "no preview accepted yet").toBe("needs_person");
    expect(visual.steps!.join(" ")).toContain("checkpoint preview");

    // The person accepts the preview: a verified_at link from the exact
    // checkpoint commit, made by a person and by nobody else.
    const task = await current(w.task.entity.entityId);
    ok(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "repository",
          relation: "verified_at",
          subjectEntityId: w.task.entity.entityId,
          subjectRevisionId: task.revision.revisionId,
          repositoryId: h.store.ensureRepository({
            projectId: h.projectId,
            name: "alpha",
            gitCommonDir: h.projectRoot,
            rootCommitId: "a".repeat(40),
          }),
          target: {
            state: { vcs: "git", objectFormat: "sha1", commitObjectId: "c".repeat(40), checkpointId: "cp-7" },
          },
        },
        idempotencyKey: "verified-at",
      }),
    );
    const second = await report(w.task.entity.entityId, task.revision.revisionId, [commandRun("pnpm -F exports test", true)], {
      runId: "ver_0002",
    });
    const after = second.verifyResult!.report!.findings.find((finding) => finding.criterionId === "task:visual")!;
    expect(after.outcome).toBe("satisfied");
    expect(after.repositoryLinkId, "the link is the evidence, named").toBeDefined();
  });
});

describe("deviations", () => {
  it("records a proposal a run sends, never as accepted, and stales only the graph the accepted change reaches", async () => {
    const w = await world();
    // A second Task that has nothing to do with the Spec.
    const other = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "task",
        title: "Unrelated",
        body: taskBody(),
        idempotencyKey: "c-other",
      }),
    );
    const answer = await bridge(
      {
        method: "project/work/link",
        params: {
          projectId: h.projectId,
          expectedRevisionId: w.task.revision.revisionId,
          link: {
            type: "evidence",
            entityId: w.task.entity.entityId,
            revisionId: w.task.revision.revisionId,
            kind: "verification",
            role: "supporting",
            summary: "Verification",
            outcome: "inconclusive",
          },
          idempotencyKey: "verify-dev",
        },
      },
      {
        verify: {
          action: "report",
          runId: "ver_dev",
          startedAt: "2026-03-01T09:00:00.000Z",
          endedAt: "2026-03-01T09:05:00.000Z",
          commands: [commandRun("pnpm -F exports test", true)],
          deviations: [
            {
              id: "dev-1",
              reason: "The spec's must requirement cannot be met without naming the path.",
              proposal: "Allow the reason to name the export's own name instead.",
              upstream: {
                entityId: w.spec.entity.entityId,
                kind: "spec",
                key: w.spec.entity.key,
                revisionId: w.spec.revision.revisionId,
                digest: w.spec.revision.digest,
              },
            },
          ],
        },
      },
    );
    const deviation = answer.verifyResult!.report!.deviations[0]!;
    expect(deviation.state, "only a person accepts a deviation").toBe("proposed");

    // The graph the acceptance travels through: the Design is derived from the
    // Spec, and the Task implements the Design. Both are approved, which is
    // what makes a change to the Spec mean anything downstream.
    ok(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: w.design.revision.revisionId,
        link: {
          type: "edge",
          relation: "derived_from",
          subject: { entityId: w.design.entity.entityId, revisionId: w.design.revision.revisionId },
          object: { entityId: w.spec.entity.entityId, revisionId: w.spec.revision.revisionId },
        },
        idempotencyKey: "e-derived",
      }),
    );
    for (const [entity, gate, key] of [
      [w.spec, "brief", "spec"],
      [w.design, "design", "design"],
    ] as const) {
      ok(
        await h.call("project/work/review", {
          projectId: h.projectId,
          entityId: entity.entity.entityId,
          expectedRevisionId: entity.revision.revisionId,
          action: "request_review",
          idempotencyKey: `rr-${key}`,
        }),
      );
      ok(
        await h.call("project/work/approve", {
          projectId: h.projectId,
          entityId: entity.entity.entityId,
          expectedRevisionId: entity.revision.revisionId,
          gate,
          decision: "approved",
          covers: [
            {
              entityId: entity.entity.entityId,
              kind: entity.entity.kind,
              key: entity.entity.key,
              revisionId: entity.revision.revisionId,
              digest: entity.revision.digest,
            },
          ],
          idempotencyKey: `ap-${key}`,
        }),
      );
    }
    const revised = specBody();
    (revised as { spec: { requirements: Array<{ id: string; text: string; level: "must" }> } }).spec.requirements = [
      { id: "r1", text: "The reason names the export, never an internal path.", level: "must" },
    ];
    ok(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: w.spec.entity.entityId,
        expectedRevisionId: w.spec.revision.revisionId,
        body: revised,
        idempotencyKey: "accept-deviation",
      }),
    );
    // A Task is paused by a stale upstream rather than marked stale itself,
    // and only the Tasks the change can reach are paused at all.
    const design = await current(w.design.entity.entityId);
    const reachable = await current(w.task.entity.entityId);
    const unrelated = await current(other.entity.entityId);
    expect(design.entity.state, "the approved design the change reaches is stale").toBe("stale");
    expect(reachable.readiness?.stalePausedBy?.key, "the task that implements it is paused").toBe(w.design.entity.key);
    expect(unrelated.readiness?.stalePausedBy, "a task the change cannot reach is untouched").toBeUndefined();
  });
});
