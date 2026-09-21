/**
 * Which proof a decision was made on, for ever (D-363, M21-T19).
 *
 * A capture association says which proof of a link was current when. That is
 * not the same question as "what did this approval rest on": a link's pointer
 * moves when a later gate corrects the capture, and a decision that reads the
 * pointer of the day is a decision whose evidence changes after the fact. So
 * the act that really writes an approval or a completion binds the exact
 * association its preparation checked, inside the same transaction, and:
 *
 * - a proof that moved in between refuses the decision, rather than being
 *   quietly swapped for whatever is current by then;
 * - a refused decision leaves no binding, no approval and no completion;
 * - a correction afterwards leaves the bound capture readable and attributed;
 * - keys are explicit — an approval id, a completion's event sequence — so two
 *   decisions in one millisecond are two decisions;
 * - and a decision this store never bound stays honestly unknown, instead of
 *   being read as having rested on nothing.
 *
 * Everything runs against a real repository through the router, except the two
 * store-level tests that need a clock that does not move and a proof that
 * moves at an exact moment — both of which use the real store.
 */
import {
  PRODUCT_NAME,
  checkpointRef,
  type ProjectTaskLinkExecutionResult,
  type ProjectWorkBody,
  type ProjectWorkGetResult,
  type ProjectWorkLinkResult,
  type ProjectWorkWriteResult,
  type RepositoryCaptureHistoryPage,
} from "@lasercode/protocol";
import { checkpointSessionKey } from "@lasercode/protocol/checkpoint-key";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { checkpoint, commit, haveGit, head, initRepo, write } from "./git-fixtures.js";
import { ProjectWorkGate } from "../../src/project-work/gate.js";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { diffBetween } from "../../src/source-control/read.js";
import { person } from "./fixtures.js";

function taskBody(over: { visual?: boolean } = {}): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: "The list shows why an export failed.",
      nonGoals: [],
      dependencies: [],
      scope: { packages: [], repositories: [], paths: [], capabilities: [] },
      acceptance: [{ id: "a1", text: "A failed row shows the reason.", machineVerifiable: false }],
      verificationCommands: [],
      visualEvidenceRequired: over.visual ?? false,
      assignment: { policy: "agent", agentName: "worker" },
    },
  };
}

function designBody(brief = "The export row."): ProjectWorkBody {
  return {
    kind: "design",
    design: {
      brief,
      screens: [
        {
          id: "s1",
          name: "Export list",
          theme: "dark",
          viewport: "narrow",
          content: {
            tree: {
              rootNodeId: "n1",
              nodes: [{ id: "n1", component: { primitive: "stack" }, fidelity: "mapped", props: {}, children: [] }],
            },
          },
          states: [{ name: "failed", included: true }],
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

let h: ProjectWorkHarness;
const dirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "/sessions/ses_1.jsonl";
let keys = 0;
function idem(prefix: string): string {
  keys += 1;
  return `${prefix}-${String(keys)}`;
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-decision-proof-`));
  dirs.push(dir);
  h = projectWorkHarness({ dir });
  const app = join(h.projectRoot, "app");
  initRepo(app, { "src/a.ts": "one\n" });
  return app;
}

async function create(kind: "task" | "design", title: string, body: ProjectWorkBody): Promise<ProjectWorkWriteResult> {
  return ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", { projectId: h.projectId, kind, title, body, idempotencyKey: idem(kind) }),
  );
}

async function detail(entityId: string): Promise<ProjectWorkGetResult> {
  return ok<ProjectWorkGetResult>(
    await h.call("project/work/get", {
      projectId: h.projectId,
      entityId,
      body: { mode: "none" },
      include: { links: true, evidence: true, approvals: true },
    }),
  );
}

/** The bindings of one decision, through the ordinary detail read. */
async function bindings(entityId: string, decisionId?: string): Promise<RepositoryCaptureHistoryPage> {
  return (
    await ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId,
        body: { mode: "none" },
        include: { links: true, captureHistory: { of: "decisions", ...(decisionId !== undefined ? { decisionId } : {}) } },
      }),
    )
  ).captureHistory!;
}

async function startAttempt(task: ProjectWorkWriteResult): Promise<void> {
  ok(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId: "run_1", sessionPath: SESSION },
      idempotencyKey: idem("start-run"),
    }),
  );
}

async function endAttempt(task: ProjectWorkWriteResult): Promise<{
  attempt: { taskEntityId: string; executionLinkId: string };
  repositoryId: string;
  base: string;
}> {
  const ended = ok<ProjectTaskLinkExecutionResult>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId: "run_1", outcome: "completed", sessionPath: SESSION },
      idempotencyKey: idem("end-run"),
    }),
  );
  const row = ended.link.repositories?.find((candidate) => candidate.name === "app");
  if (!row) throw new Error("the attempt recorded no repository called app");
  return {
    attempt: { taskEntityId: task.entity.entityId, executionLinkId: ended.link.linkId },
    repositoryId: row.repositoryId,
    base: row.base.commitObjectId,
  };
}

/** A blob that is not a capture of anything: only the pointer matters here. */
function someBlob(text: string): string {
  return h.store.putBlob({ projectId: h.projectId, mediaType: "application/json", data: Buffer.from(text, "utf8") }).blobId;
}

// ------------------------------------------------------------------ worlds

/**
 * A Design a person accepted the real build against, on the Task's own
 * attempt: one `verified_at` link, with the capture the acceptance bound.
 */
async function acceptedDesign(): Promise<{
  app: string;
  design: ProjectWorkWriteResult;
  task: ProjectWorkWriteResult;
  linkId: string;
  captureBlobId: string;
}> {
  const app = workspace();
  const design = await create("design", "Export row", designBody());
  const task = await create("task", "Build it", taskBody({ visual: true }));
  ok(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "edge",
        relation: "implements",
        subject: { entityId: task.entity.entityId, revisionId: task.revision.revisionId },
        object: { entityId: design.entity.entityId, revisionId: design.revision.revisionId },
      },
      idempotencyKey: idem("edge"),
    }),
  );
  await startAttempt(task);
  write(app, { "src/a.ts": "built\n" });
  const made = checkpoint(app, SESSION, 1);
  const run = await endAttempt(task);

  const written = ok<ProjectWorkLinkResult>(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: design.revision.revisionId,
      link: {
        type: "evidence",
        entityId: design.entity.entityId,
        revisionId: design.revision.revisionId,
        kind: "person_acceptance",
        role: "acceptance",
        summary: "I opened the build at this checkpoint and it matches.",
        outcome: "passed",
        verifiedAt: {
          repositoryId: run.repositoryId,
          state: {
            vcs: "git",
            objectFormat: "sha1",
            commitObjectId: made,
            checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1),
          },
          acceptance: { kind: "checkpoint_preview" },
          attempt: run.attempt,
        },
      },
      idempotencyKey: idem("accept"),
    }),
  );
  if (written.link.type !== "evidence" || !written.link.evidence.repositoryLinkId) throw new Error("no verified_at link");
  const linkId = written.link.evidence.repositoryLinkId;
  const link = (await detail(design.entity.entityId)).repositoryLinks.find((row) => row.linkId === linkId)!;
  return { app, design, task, linkId, captureBlobId: link.captureBlobId! };
}

/** Ask for review of an artifact, which is what makes it approvable. */
async function requestReview(entity: ProjectWorkWriteResult): Promise<void> {
  ok(
    await h.call("project/work/review", {
      projectId: h.projectId,
      entityId: entity.entity.entityId,
      expectedRevisionId: entity.revision.revisionId,
      action: "request_review",
      idempotencyKey: idem("review"),
    }),
  );
}

/** A Task whose delivery a person accepted, ready to be marked done. */
async function deliveredTask(): Promise<{ app: string; task: ProjectWorkWriteResult; linkId: string; captureBlobId: string }> {
  const app = workspace();
  const task = await create("task", "Delivered", taskBody());
  await startAttempt(task);
  const base = head(app);
  write(app, { "src/a.ts": "delivered\n" });
  const made = commit(app, "the delivery");
  const run = await endAttempt(task);
  const diff = await diffBetween({ path: app, gitDir: join(app, ".git"), name: "app" }, base, made);
  const accepted = ok<ProjectWorkLinkResult>(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "delivery",
        entityId: task.entity.entityId,
        revisionId: task.revision.revisionId,
        repositoryId: run.repositoryId,
        change: {
          base: { vcs: "git", objectFormat: "sha1", commitObjectId: base },
          head: { vcs: "git", objectFormat: "sha1", commitObjectId: made },
          diffDigest: diff!.digest,
        },
        executionLinkId: run.attempt.executionLinkId,
        confirm: true,
      },
      idempotencyKey: idem("accept-delivery"),
    }),
  );
  if (accepted.link.type !== "delivery") throw new Error("unreachable");
  ok(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "evidence",
        entityId: task.entity.entityId,
        revisionId: task.revision.revisionId,
        kind: "review",
        role: "acceptance",
        summary: "I read the change and it does what the task asked.",
        outcome: "passed",
        repositoryLinkId: accepted.link.links[0]!.linkId,
      },
      idempotencyKey: idem("acceptance-evidence"),
    }),
  );
  for (const action of ["mark_ready", "start"] as const) {
    ok(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        action,
        idempotencyKey: idem(action),
      }),
    );
  }
  return { app, task, linkId: accepted.link.links[0]!.linkId, captureBlobId: accepted.link.links[0]!.captureBlobId! };
}

// ------------------------------------------------------------------- tests

describe.runIf(haveGit)("a decision binds the proof it consumed", () => {
  it("binds an approval to the exact association it was prepared on", async () => {
    const world = await acceptedDesign();
    await requestReview(world.design);
    const before = await bindings(world.design.entity.entityId);
    expect(before.bindings, "nothing is bound before anything is decided").toEqual([]);

    const approved = ok<{ approval: { approvalId: string } }>(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: world.design.entity.entityId,
        expectedRevisionId: world.design.revision.revisionId,
        gate: "design",
        decision: "approved",
        covers: [
          {
            entityId: world.design.entity.entityId,
            kind: "design",
            key: world.design.entity.key,
            revisionId: world.design.revision.revisionId,
            digest: world.design.revision.digest,
          },
        ],
        idempotencyKey: idem("approve"),
      }),
    );

    const association = h.store.currentCaptureAssociation(h.projectId, world.linkId)!;
    const page = await bindings(world.design.entity.entityId, approved.approval.approvalId);
    expect(page.known, "this approval's proof is recorded, not guessed at").toBe(true);
    expect(page.bindings).toEqual([
      {
        kind: "approval",
        decisionId: approved.approval.approvalId,
        entityId: world.design.entity.entityId,
        linkId: world.linkId,
        blobId: world.captureBlobId,
        associationRevisionId: association.revisionId,
        associationSeq: association.seq,
        boundAt: page.bindings[0]!.boundAt,
      },
    ]);
  });

  it("binds a completion to its own event sequence, and keeps that proof readable after a correction", async () => {
    const world = await deliveredTask();
    const done = ok<{ seq: number; entity: { state: string } }>(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: world.task.entity.entityId,
        expectedRevisionId: world.task.revision.revisionId,
        action: "complete",
        idempotencyKey: idem("complete"),
      }),
    );
    expect(done.entity.state).toBe("done");

    const page = await bindings(world.task.entity.entityId, String(done.seq));
    expect(page.known).toBe(true);
    expect(page.bindings.length, "one link, one binding").toBe(1);
    const bound = page.bindings[0]!;
    expect(bound.kind).toBe("task_completion");
    expect(bound.decisionId, "keyed by the sequence it was raised at, never by a timestamp").toBe(String(done.seq));
    expect(bound.linkId).toBe(world.linkId);
    // The completion's own preparation corrected this link's capture to one
    // that holds every source the delivery rests on, so what it bound is that
    // correction — and it is the association the link carried at that moment.
    const association = h.store.currentCaptureAssociation(h.projectId, world.linkId)!;
    expect(bound.blobId).toBe(association.blobId);
    expect(bound.associationRevisionId).toBe(association.revisionId);

    // Somebody corrects the proof afterwards. The pointer moves; what the
    // completion rested on does not, and it is still readable.
    const later = someBlob("a later capture");
    expect(h.store.attachCapture(h.projectId, world.linkId, later, bound.blobId, { gate: "A later correction" })).toBe(true);
    const after = await bindings(world.task.entity.entityId, String(done.seq));
    expect(after.bindings[0]!.blobId, "the binding is immutable").toBe(bound.blobId);
    expect(
      h.store.currentCaptureAssociation(h.projectId, world.linkId)!.blobId,
      "even though the link now points somewhere else",
    ).toBe(later);
    const blob = ok<{ data?: string }>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId: bound.blobId }));
    expect(blob.data, "and the capture it names is still there to read").toBeDefined();

    // The association the binding names is addressable from the decision.
    const named = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId: world.task.entity.entityId,
        body: { mode: "none" },
        include: { links: true, captureHistory: { of: "associations", revisionId: bound.associationRevisionId } },
      }),
    ).captureHistory!;
    expect(named.associations.map((row) => row.blobId)).toEqual([bound.blobId]);
  });

  it("records that a decision rested on no repository evidence, which is not the same as not knowing", async () => {
    const app = workspace();
    expect(app.length).toBeGreaterThan(0);
    const design = await create("design", "Nothing built yet", designBody());
    await requestReview(design);
    const approved = ok<{ approval: { approvalId: string } }>(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: design.entity.entityId,
        expectedRevisionId: design.revision.revisionId,
        gate: "design",
        decision: "approved",
        covers: [
          {
            entityId: design.entity.entityId,
            kind: "design",
            key: design.entity.key,
            revisionId: design.revision.revisionId,
            digest: design.revision.digest,
          },
        ],
        idempotencyKey: idem("approve"),
      }),
    );
    const page = await bindings(design.entity.entityId, approved.approval.approvalId);
    expect(page.bindings, "it rested on nothing").toEqual([]);
    expect(page.known, "and this store knows that, rather than being silent about it").toBe(true);
    expect((await bindings(design.entity.entityId, "apv_never_happened")).known, "an id nobody decided under is unknown").toBe(false);
  });

  it("refuses a decision whose proof moved while it was being prepared, and writes nothing at all", async () => {
    const world = await acceptedDesign();
    await requestReview(world.design);
    // The preparation a real approval runs, with its real result: which proof
    // of which link this decision is about to be made on.
    const gate = new ProjectWorkGate({ store: h.store, caller: { cwd: h.projectRoot, origin: person } });
    const proof = await gate.keepEvidenceReviewable(h.projectId, [world.design.entity.entityId], "This approval");
    expect(proof.refs.map((ref) => ref.linkId)).toEqual([world.linkId]);

    // …and then somebody else corrects this link's proof, in between.
    const moved = someBlob("somebody else's capture");
    expect(h.store.attachCapture(h.projectId, world.linkId, moved, world.captureBlobId, { gate: "Another gate" })).toBe(true);

    const covers = [
      {
        entityId: world.design.entity.entityId,
        kind: "design" as const,
        key: world.design.entity.key,
        revisionId: world.design.revision.revisionId,
        digest: world.design.revision.digest,
      },
    ];
    expect(() =>
      h.store.approve({
        projectId: h.projectId,
        entityId: world.design.entity.entityId,
        expectedRevisionId: world.design.revision.revisionId,
        gate: "design",
        decision: "approved",
        covers,
        proof,
        origin: person,
        idempotencyKey: idem("stale-approve"),
      }),
    ).toThrow(/changed somewhere else/);

    const after = await detail(world.design.entity.entityId);
    expect(after.entity.state, "no approval, so no approved design").toBe("needs_review");
    expect(after.approvals, "and no approval on the record").toEqual([]);
    expect((await bindings(world.design.entity.entityId)).bindings, "and no binding either").toEqual([]);

    // The same is true of a decision its own gate refuses: preparation is not
    // a decision, and a refused one binds nothing.
    const refused = failed(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: world.design.entity.entityId,
        expectedRevisionId: world.design.revision.revisionId,
        gate: "design",
        decision: "approved",
        covers: [{ ...covers[0]!, digest: "0".repeat(64) }],
        idempotencyKey: idem("mismatched-approve"),
      }),
    );
    expect(refused.message).toMatch(/changed since this was prepared|Open it again/);
    expect((await bindings(world.design.entity.entityId)).bindings).toEqual([]);
    expect((await detail(world.design.entity.entityId)).entity.state).toBe("needs_review");
  });

  it("refuses a completion whose proof moved, and leaves the task where it was", async () => {
    const world = await deliveredTask();
    const gate = new ProjectWorkGate({ store: h.store, caller: { cwd: h.projectRoot, origin: person } });
    const proof = await gate.keepEvidenceReviewable(h.projectId, [world.task.entity.entityId], "Marking this task done");
    expect(proof.refs.length).toBe(1);

    const moved = someBlob("somebody else's capture");
    expect(h.store.attachCapture(h.projectId, world.linkId, moved, proof.refs[0]!.blobId, { gate: "Another gate" })).toBe(true);

    expect(() =>
      h.store.taskAction({
        projectId: h.projectId,
        entityId: world.task.entity.entityId,
        expectedRevisionId: world.task.revision.revisionId,
        action: "complete",
        proof,
        origin: person,
        idempotencyKey: idem("stale-complete"),
      }),
    ).toThrow(/changed somewhere else/);

    const after = await detail(world.task.entity.entityId);
    expect(after.entity.state, "not done, because nothing was decided").toBe("in_progress");
    expect((await bindings(world.task.entity.entityId)).bindings, "and nothing was bound").toEqual([]);
  });
});

describe("two decisions in one instant", () => {
  /** A store whose clock does not move: a key can never come from the time. */
  function frozenStore(): { store: ProjectWorkStore; projectId: string; repositoryId: string } {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-decision-frozen-`));
    dirs.push(dir);
    const store = new ProjectWorkStore({ file: join(dir, "project-work.db"), now: () => new Date("2026-03-01T09:00:00.000Z") });
    const projectId = store.projectIdFor(join(dir, "alpha"))!;
    const repositoryId = store.ensureRepository({ projectId, name: "app", gitCommonDir: join(dir, "alpha/app/.git") });
    return { store, projectId, repositoryId };
  }

  it("keys them by the decision, not by the clock", () => {
    const { store, projectId, repositoryId } = frozenStore();
    try {
      const made: Array<{ entityId: string; linkId: string; blobId: string; approvalId: string }> = [];
      for (const title of ["First", "Second"]) {
        const design = store.create({
          projectId,
          kind: "design",
          title,
          body: designBody(),
          origin: person,
          idempotencyKey: `create-${title}`,
        });
        const blobId = store.putBlob({ projectId, mediaType: "application/json", data: Buffer.from(title, "utf8") }).blobId;
        const written = store.link({
          projectId,
          expectedRevisionId: design.revision.revisionId,
          link: {
            type: "repository",
            relation: "based_on",
            subjectEntityId: design.entity.entityId,
            subjectRevisionId: design.revision.revisionId,
            repositoryId,
            target: { state: { vcs: "git", objectFormat: "sha1", commitObjectId: "a".repeat(40) } },
            captureBlobId: blobId,
          },
          origin: person,
          idempotencyKey: `link-${title}`,
        });
        if (written.link.type !== "repository") throw new Error("unreachable");
        const linkId = written.link.repository.linkId;
        store.review({
          projectId,
          entityId: design.entity.entityId,
          expectedRevisionId: design.revision.revisionId,
          action: "request_review",
          origin: person,
          idempotencyKey: `review-${title}`,
        });
        // The references a preparation returns for this link, read the same way
        // it reads them.
        const association = store.currentCaptureAssociation(projectId, linkId)!;
        const approved = store.approve({
          projectId,
          entityId: design.entity.entityId,
          expectedRevisionId: design.revision.revisionId,
          gate: "design",
          decision: "approved",
          covers: [
            {
              entityId: design.entity.entityId,
              kind: "design",
              key: design.entity.key,
              revisionId: design.revision.revisionId,
              digest: design.revision.digest,
            },
          ],
          proof: {
            gate: "This approval",
            refs: [{ linkId, blobId, associationRevisionId: association.revisionId, associationSeq: association.seq }],
          },
          origin: person,
          idempotencyKey: `approve-${title}`,
        });
        made.push({ entityId: design.entity.entityId, linkId, blobId, approvalId: approved.approval.approvalId });
      }

      const [first, second] = made as [(typeof made)[number], (typeof made)[number]];
      const pages = made.map((row) =>
        store.captureHistoryPage(projectId, { of: "decisions", decisionId: row.approvalId, linkIds: [row.linkId] }),
      );
      expect(pages[0]!.bindings.map((row) => row.boundAt), "one instant").toEqual(["2026-03-01T09:00:00.000Z"]);
      expect(pages[1]!.bindings.map((row) => row.boundAt)).toEqual(["2026-03-01T09:00:00.000Z"]);
      expect(first.approvalId, "two decisions, two keys").not.toBe(second.approvalId);
      expect(pages[0]!.bindings[0]!.blobId, "each bound to its own proof").toBe(first.blobId);
      expect(pages[1]!.bindings[0]!.blobId).toBe(second.blobId);
      expect(pages.every((page) => page.known)).toBe(true);

      // And the page is scoped: one entity's decisions are not another's.
      const scoped = store.captureHistoryPage(projectId, {
        of: "decisions",
        entityId: first.entityId,
        linkIds: [first.linkId, second.linkId],
      });
      expect(scoped.bindings.map((row) => row.decisionId)).toEqual([first.approvalId]);
    } finally {
      store.close();
    }
  });
});
