/**
 * Checkpoints, changes and delivery evidence (M21-T18).
 *
 * Every test here runs against **real git repositories in temp directories**,
 * as the M20 source-control tests do, and reaches the authority the way the
 * product does: through the router (a person's app) and through the worker
 * bridge (a model's tools). Nothing is mocked in between, because the rules
 * being checked are precisely the ones a mock would assume away — that a
 * checkpoint ref resolves to a commit object id, that a change is what git
 * says it is, and that a commit which is gone stays gone.
 */
import {
  PRODUCT_NAME,
  PROJECT_WORK_QUOTA_CODE,
  checkpointRef,
  type ExecutionLink,
  type ProjectTaskLinkExecutionResult,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkGetResult,
  type ProjectWorkLinkResult,
  type ProjectWorkWriteResult,
  type RepositoryCapture,
  type RepositoryChangeRef,
} from "@lasercode/protocol";
import { checkpointSessionKey } from "@lasercode/protocol/checkpoint-key";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody, taskBody } from "./fixtures.js";
import { checkpoint, git, haveGit, head, initRepo, prune, write } from "./git-fixtures.js";

/** A Task body that declares the paths it means to write in. */
function taskBodyWith(paths: string[]): ReturnType<typeof taskBody> {
  const body = taskBody();
  if (body.kind !== "task") throw new Error("unreachable");
  return { kind: "task", task: { ...body.task, scope: { packages: [], repositories: [], paths, capabilities: [] } } };
}

let h: ProjectWorkHarness;
const dirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const AGENT = { label: "Builder", sessionId: "ses_1", runId: "run_1" };
const SESSION = "/sessions/ses_1.jsonl";

// -------------------------------------------------------------- harness

/**
 * A project whose folder holds two repositories — the monorepo case — so the
 * rule that two repositories stay two records is under test everywhere rather
 * than in one place.
 */
function workspace(): { app: string; lib: string } {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-delivery-`));
  dirs.push(dir);
  h = projectWorkHarness({ dir });
  const app = join(h.projectRoot, "app");
  const lib = join(h.projectRoot, "lib");
  initRepo(app, { "src/a.ts": "one\n" });
  initRepo(lib, { "src/b.ts": "one\n" });
  return { app, lib };
}

async function bridge(
  request: ProjectWorkBridgeParams["request"],
  extras: Partial<ProjectWorkBridgeParams> = {},
): Promise<ProjectWorkBridgeResult> {
  return h.methods.handleBridge({ agent: AGENT, request, ...extras }, { actor: ACTOR, cwd: h.projectRoot });
}

let keys = 0;
function idem(prefix: string): string {
  keys += 1;
  return `${prefix}-${String(keys)}`;
}

async function seedTask(title = "Sticky footer"): Promise<ProjectWorkWriteResult> {
  return ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", { projectId: h.projectId, kind: "task", title, body: taskBody(), idempotencyKey: idem("task") }),
  );
}

async function startAttempt(task: ProjectWorkWriteResult, targetId = "run_1"): Promise<ProjectTaskLinkExecutionResult> {
  return ok<ProjectTaskLinkExecutionResult>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId, sessionPath: SESSION },
      idempotencyKey: `start-${targetId}`,
    }),
  );
}

async function endAttempt(task: ProjectWorkWriteResult, targetId = "run_1"): Promise<ProjectTaskLinkExecutionResult> {
  return ok<ProjectTaskLinkExecutionResult>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId, outcome: "completed", sessionPath: SESSION },
      idempotencyKey: `end-${targetId}`,
    }),
  );
}

/**
 * One whole attempt, as the product records one: it starts, it writes a
 * checkpoint while it runs, and it closes — which is when the host re-reads
 * git and the attempt's record carries that checkpoint.
 *
 * What comes back is the identity a person's review reports: the attempt row,
 * the repository the host identified, the base it recorded, and the checkpoint
 * ref and commit.
 */
async function attemptWith(
  task: ProjectWorkWriteResult,
  repo: string,
  turn: number,
  options: { name?: string; targetId?: string } = {},
): Promise<{
  attempt: { taskEntityId: string; executionLinkId: string };
  executionLinkId: string;
  repositoryId: string;
  base: string;
  commit: string;
  ref: string;
}> {
  const targetId = options.targetId ?? "run_1";
  await startAttempt(task, targetId);
  const commit = checkpoint(repo, SESSION, turn);
  const ended = await endAttempt(task, targetId);
  const record = ended.link.repositories?.find((row) => row.name === (options.name ?? "app"));
  if (!record) throw new Error("the attempt recorded no repository");
  return {
    attempt: { taskEntityId: task.entity.entityId, executionLinkId: ended.link.linkId },
    executionLinkId: ended.link.linkId,
    repositoryId: record.repositoryId,
    base: record.base.commitObjectId,
    commit,
    ref: checkpointRef(checkpointSessionKey(SESSION), turn),
  };
}

async function detail(entityId: string, repositoryStatus = false): Promise<ProjectWorkGetResult> {
  return ok<ProjectWorkGetResult>(
    await h.call("project/work/get", {
      projectId: h.projectId,
      entityId,
      body: { mode: "none" },
      include: { links: true, evidence: true, ...(repositoryStatus ? { repositoryStatus: true } : {}) },
    }),
  );
}

function repositoryOf(link: ExecutionLink, name: string) {
  return (link.repositories ?? []).find((row) => row.name === name);
}

// ---------------------------------------------------------------------------

describe.runIf(haveGit)("an attempt records what git says it did", () => {
  it("records the base commit, the checkpoints it made and how it ended, per repository", async () => {
    const { app, lib } = workspace();
    const task = await seedTask();
    const baseApp = head(app);
    const baseLib = head(lib);

    const started = await startAttempt(task);
    expect(started.link.attempt).toBe(1);
    expect(started.link.endedAt).toBeUndefined();
    expect(repositoryOf(started.link, "app")?.base.commitObjectId).toBe(baseApp);
    expect(repositoryOf(started.link, "lib")?.base.commitObjectId).toBe(baseLib);

    // The attempt works: a checkpoint at the prompt, then one after the turn.
    const firstApp = checkpoint(app, SESSION, 1);
    checkpoint(lib, SESSION, 1);
    write(app, { "src/a.ts": "two\n", "src/new.ts": "added\n" });
    const lastApp = checkpoint(app, SESSION, 2);
    checkpoint(lib, SESSION, 2);

    const ended = await endAttempt(task);
    expect(ended.link.linkId, "ending an attempt closes the one that started").toBe(started.link.linkId);
    expect(ended.link.attempt).toBe(1);
    expect(ended.link.outcome).toBe("completed");
    expect(ended.link.endedAt).toBeDefined();

    const appRecord = repositoryOf(ended.link, "app")!;
    expect(appRecord.base.commitObjectId).toBe(baseApp);
    expect(appRecord.checkpoints.map((row) => row.turn)).toEqual([1, 2]);
    expect(appRecord.checkpoints[0]!.commitObjectId).toBe(firstApp);
    expect(appRecord.change?.base.commitObjectId).toBe(firstApp);
    expect(appRecord.change?.head.commitObjectId).toBe(lastApp);
    expect(appRecord.changedPaths.sort()).toEqual(["src/a.ts", "src/new.ts"]);

    // The second repository is its own record, with its own id and its own
    // checkpoints, and nothing changed in it — which is an answer, not a
    // number merged into the first repository's.
    const libRecord = repositoryOf(ended.link, "lib")!;
    expect(libRecord.repositoryId).not.toBe(appRecord.repositoryId);
    expect(libRecord.base.commitObjectId).toBe(baseLib);
    expect(libRecord.changedPaths).toEqual([]);
    expect(libRecord.change?.diffDigest).not.toBe(appRecord.change?.diffDigest);

    // Only one attempt exists, and the evidence it wrote names what git saw.
    const read = await detail(task.entity.entityId);
    expect(read.executionLinks).toHaveLength(1);
    expect(read.entity.state, "a run ending never moves the task").toBe(task.entity.state);
    const evidence = read.evidence.find((row) => row.summary.startsWith("Attempt 1 ended"))!;
    expect(evidence.detail).toContain("2 files changed in app across 2 checkpoints");
    expect(evidence.role).toBe("supporting");
  });

  it("takes the changed files from git, and lets them be the conflict another task sees", async () => {
    const { app } = workspace();
    // The first Task declares nothing and writes in `src/` anyway; the second
    // one declares exactly that path. Only git can see the overlap.
    const first = await seedTask("Footer");
    const second = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "task",
        title: "Safe area",
        body: taskBodyWith(["src/a.ts"]),
        idempotencyKey: "second",
      }),
    );
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId: first.entity.entityId,
      expectedRevisionId: first.revision.revisionId,
      action: "mark_ready",
      idempotencyKey: "ready-1",
    });
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId: second.entity.entityId,
      expectedRevisionId: second.revision.revisionId,
      action: "mark_ready",
      idempotencyKey: "ready-2",
    });

    await startAttempt(first);
    checkpoint(app, SESSION, 1);
    write(app, { "src/a.ts": "changed by the attempt\n" });
    checkpoint(app, SESSION, 2);
    // The model reports nothing about files; the record comes from the refs.
    await endAttempt(first);

    const conflicts = (await detail(second.entity.entityId)).conflicts ?? [];
    expect(conflicts.map((row) => row.key)).toContain(first.entity.key);
    expect(conflicts.find((row) => row.key === first.entity.key)).toMatchObject({ observed: true, accepted: false });
  });

  it("records the same facts for an attempt a model's own tools opened and closed", async () => {
    const { app } = workspace();
    const task = await seedTask();
    const attempt = { workspace: "shared" as const, checkout: h.projectRoot, sessionPath: SESSION };
    const opened = (
      await bridge(
        {
          method: "project/task/link-execution",
          params: {
            projectId: h.projectId,
            entityId: task.entity.entityId,
            expectedRevisionId: task.revision.revisionId,
            execution: { kind: "agent_run", targetId: "run_bridge" },
            idempotencyKey: idem("bridge-start"),
          },
        },
        { attempt },
      )
    ).result as ProjectTaskLinkExecutionResult;
    expect(opened.attemptRepositories?.map((row) => row.name).sort()).toEqual(["app", "lib"]);

    checkpoint(app, SESSION, 1);
    write(app, { "src/a.ts": "by the model\n" });
    checkpoint(app, SESSION, 2);

    const closed = (
      await bridge(
        {
          method: "project/task/link-execution",
          params: {
            projectId: h.projectId,
            entityId: task.entity.entityId,
            expectedRevisionId: task.revision.revisionId,
            execution: { kind: "agent_run", targetId: "run_bridge", outcome: "completed" },
            idempotencyKey: idem("bridge-end"),
          },
        },
        { attempt },
      )
    ).result as ProjectTaskLinkExecutionResult;
    expect(closed.link.linkId).toBe(opened.link.linkId);
    const record = repositoryOf(closed.link, "app")!;
    expect(record.changedPaths, "the files come from the session's checkpoints").toEqual(["src/a.ts"]);

    const read = await detail(task.entity.entityId);
    expect(read.executionLinks).toHaveLength(1);
    // The shape the bridge recorded is a note beside the attempt, and the
    // checkout it names never comes back on an answer.
    expect(read.evidence.some((row) => row.summary.includes("ran in the project's own checkout"))).toBe(true);
    expect(JSON.stringify(read.executionLinks)).not.toContain(h.projectRoot);
  });

  it("records the commits an attempt made, so a git action's object id is on it", async () => {
    const { app } = workspace();
    const task = await seedTask();
    const started = await startAttempt(task);
    const base = repositoryOf(started.link, "app")!.base.commitObjectId;

    checkpoint(app, SESSION, 1);
    write(app, { "src/a.ts": "committed\n" });
    git(app, ["add", "-A"]);
    git(app, ["commit", "-q", "-m", "the delivery"]);
    const committed = head(app);
    checkpoint(app, SESSION, 2);

    const ended = await endAttempt(task);
    const record = repositoryOf(ended.link, "app")!;
    expect(record.base.commitObjectId).toBe(base);
    expect(record.commits, "the commit the action wrote is identity on the attempt").toContain(committed);
  });
});

describe.runIf(haveGit)("delivery is accepted, never claimed", () => {
  /** A Task, an attempt that changed something, and the change it produced. */
  async function delivered(): Promise<{ task: ProjectWorkWriteResult; change: RepositoryChangeRef; repositoryId: string }> {
    const { app } = workspace();
    const task = await seedTask();
    await startAttempt(task);
    checkpoint(app, SESSION, 1);
    write(app, { "src/a.ts": "two\n" });
    checkpoint(app, SESSION, 2);
    const ended = await endAttempt(task);
    const record = repositoryOf(ended.link, "app")!;
    return { task, change: record.change!, repositoryId: record.repositoryId };
  }

  it("refuses an implemented_by link that was not accepted as a delivery", async () => {
    const { task, change, repositoryId } = await delivered();
    const error = failed(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "repository",
          relation: "implemented_by",
          subjectEntityId: task.entity.entityId,
          subjectRevisionId: task.revision.revisionId,
          repositoryId,
          target: { change },
        },
        idempotencyKey: "raw-implemented-by",
      }),
    );
    expect(error.message).toMatch(/accepted as one/);
  });

  it("refuses a change whose digest is not the digest of the change that is there", async () => {
    const { task, change, repositoryId } = await delivered();
    const error = failed(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "delivery",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          repositoryId,
          change: { ...change, diffDigest: "b".repeat(64) },
          confirm: true,
        },
        idempotencyKey: "wrong-digest",
      }),
    );
    expect(error.message).toMatch(/not what it was when you looked at it/);
  });

  it("refuses an agent that tries to accept its own work as the delivery", async () => {
    const { task, change, repositoryId } = await delivered();
    await expect(
      bridge({
        method: "project/work/link",
        params: {
          projectId: h.projectId,
          expectedRevisionId: task.revision.revisionId,
          link: {
            type: "delivery",
            entityId: task.entity.entityId,
            revisionId: task.revision.revisionId,
            repositoryId,
            change,
            confirm: true,
          },
          idempotencyKey: "agent-delivery",
        },
      }),
    ).rejects.toThrow(/Only a person accepts a change as the delivery/);
  });

  it("stores the canonical capture before it accepts, and links every revision the change implements", async () => {
    const { task, change, repositoryId } = await delivered();
    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "Phone review",
        body: specBody(),
        idempotencyKey: "spec-1",
      }),
    );
    const accepted = ok<ProjectWorkLinkResult>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "delivery",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          repositoryId,
          change,
          covers: [{ entityId: spec.entity.entityId, revisionId: spec.revision.revisionId }],
          display: { branch: "main", pullRequest: { number: 7, host: "github", url: "https://example.invalid/pull/7" } },
          confirm: true,
        },
        idempotencyKey: "accept-1",
      }),
    );
    expect(accepted.link.type).toBe("delivery");
    if (accepted.link.type !== "delivery") throw new Error("unreachable");
    expect(accepted.link.links).toHaveLength(2);
    expect(accepted.link.capture?.files).toBe(1);
    expect(accepted.link.capture?.sources).toBe(1);

    // Both subjects carry their own link to the same change, and the pull
    // request rides as display context beside the commit ids.
    for (const link of accepted.link.links) {
      expect(link.relation).toBe("implemented_by");
      expect(link.target).toEqual({ change });
      expect(link.display?.pullRequest?.number).toBe(7);
      expect(link.captureBlobId).toBe(accepted.link.links[0]!.captureBlobId);
    }
    const specLinks = (await detail(spec.entity.entityId)).repositoryLinks;
    expect(specLinks.map((link) => link.relation)).toContain("implemented_by");

    // The capture is a bounded manifest plus the source of what changed.
    const blob = ok<{ data?: string }>(
      await h.call("project/work/blob/read", { projectId: h.projectId, blobId: accepted.link.capture!.blobId }),
    );
    const capture = JSON.parse(Buffer.from(blob.data!, "base64").toString("utf8")) as RepositoryCapture;
    expect(capture.files).toEqual([expect.objectContaining({ path: "src/a.ts", status: "modified" })]);
    expect(capture.sources[0]).toMatchObject({ path: "src/a.ts", text: "two\n" });
  });

  it("refuses the gate when there is no durable room to keep the evidence, and accepts nothing", async () => {
    const { app } = workspace();
    h.cleanup();
    // The same folder, reopened with a budget that has room for the work and
    // none for a capture.
    h = projectWorkHarness({ dir: h.dir, quota: { projectBytes: 24 * 1024, globalBytes: 24 * 1024, projectEntities: 100 } });
    const task = await seedTask();
    await startAttempt(task);
    checkpoint(app, SESSION, 1);
    write(app, { "src/a.ts": "x".repeat(40 * 1024) });
    checkpoint(app, SESSION, 2);
    const ended = await endAttempt(task);
    const record = repositoryOf(ended.link, "app")!;

    const error = failed(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "delivery",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          repositoryId: record.repositoryId,
          change: record.change!,
          confirm: true,
        },
        idempotencyKey: "accept-full",
      }),
    );
    expect(error.code).toBe(PROJECT_WORK_QUOTA_CODE);
    expect(error.message).toMatch(/Accepting this delivery needs its repository evidence kept/);
    expect((error.data as { recovery: string }).recovery).toMatch(/Accepting this delivery/);
    expect((await detail(task.entity.entityId)).repositoryLinks, "nothing is accepted when nothing can be kept").toEqual([]);
  });
});

describe.runIf(haveGit)("a link never retargets, and never resolves to HEAD", () => {
  async function acceptedDelivery(): Promise<{
    app: string;
    task: ProjectWorkWriteResult;
    change: RepositoryChangeRef;
    capture: string;
  }> {
    const { app } = workspace();
    const task = await seedTask();
    await startAttempt(task);
    checkpoint(app, SESSION, 1);
    write(app, { "src/a.ts": "two\n" });
    checkpoint(app, SESSION, 2);
    const ended = await endAttempt(task);
    const record = repositoryOf(ended.link, "app")!;
    const accepted = ok<ProjectWorkLinkResult>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "delivery",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          repositoryId: record.repositoryId,
          change: record.change!,
          display: { branch: "main" },
          confirm: true,
        },
        idempotencyKey: "accept-retarget",
      }),
    );
    if (accepted.link.type !== "delivery") throw new Error("unreachable");
    return { app, task, change: record.change!, capture: accepted.link.links[0]!.captureBlobId! };
  }

  it("keeps the same object ids after the branch moves and the history is rewritten", async () => {
    const { app, task, change } = await acceptedDelivery();

    // The branch moves on, and then its history is rewritten underneath it.
    write(app, { "src/a.ts": "three\n" });
    git(app, ["add", "-A"]);
    git(app, ["commit", "-q", "-m", "later"]);
    git(app, ["commit", "-q", "--amend", "-m", "rewritten"]);
    git(app, ["checkout", "-q", "-b", "elsewhere"]);
    expect(head(app)).not.toBe(change.head.commitObjectId);

    const link = (await detail(task.entity.entityId)).repositoryLinks[0]!;
    expect(link.target).toEqual({ change });
    expect(link.display?.branch, "a branch is what it was called, not what it points at now").toBe("main");
  });

  it("reports a pruned checkpoint as unavailable with the ids it recorded, and still reads the capture", async () => {
    const { app, task, change, capture } = await acceptedDelivery();

    prune(app, [
      checkpointRef(checkpointSessionKey(SESSION), 1),
      checkpointRef(checkpointSessionKey(SESSION), 2),
    ]);

    const read = await detail(task.entity.entityId, true);
    const link = read.repositoryLinks[0]!;
    expect(link.target, "identity survives the objects").toEqual({ change });
    const status = read.repositoryStatus![0]!;
    expect(status.sourceAvailable).toBe(false);
    expect(status.missing.sort()).toEqual([change.base.commitObjectId, change.head.commitObjectId].sort());
    expect(status.captureAvailable).toBe(true);
    expect(status.detail).toMatch(/no longer in the repository/);

    // …and the evidence is still reviewable, from the capture.
    const blob = ok<{ data?: string }>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId: capture }));
    const stored = JSON.parse(Buffer.from(blob.data!, "base64").toString("utf8")) as RepositoryCapture;
    expect(stored.change).toEqual(change);
    expect(stored.sources[0]?.text).toBe("two\n");
  });

it("refuses an agent's removal of an accepted delivery, and a person's once a decision names it", async () => {
  const { task } = await acceptedDelivery();
  const link = (await detail(task.entity.entityId)).repositoryLinks.find((row) => row.relation === "implemented_by")!;

  const byAgent = await (async () => {
    try {
      await bridge({
        method: "project/work/unlink",
        params: {
          projectId: h.projectId,
          entityId: task.entity.entityId,
          expectedRevisionId: task.revision.revisionId,
          linkId: link.linkId,
          idempotencyKey: "agent-unlink",
        },
      });
    } catch (error) {
      return error as Error;
    }
    throw new Error("an agent should not be able to remove accepted provenance");
  })();
  expect(byAgent.message).toMatch(/Only a person removes what a decision was made on/);

  // And once evidence names it, even a person supersedes rather than erases.
  ok(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "evidence",
        entityId: task.entity.entityId,
        revisionId: task.revision.revisionId,
        kind: "review",
        role: "supporting",
        summary: "Read against that delivery.",
        outcome: "passed",
        repositoryLinkId: link.linkId,
      },
      idempotencyKey: "names-the-link",
    }),
  );
  const byPerson = failed(
    await h.call("project/work/unlink", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      linkId: link.linkId,
      idempotencyKey: "person-unlink",
    }),
  );
  expect(byPerson.message).toMatch(/superseded, never erased/);
  expect((await detail(task.entity.entityId)).repositoryLinks.some((row) => row.linkId === link.linkId)).toBe(true);
});

  it("appends a superseding link and keeps the one it corrects", async () => {
    const { app, task } = await acceptedDelivery();
    const first = (await detail(task.entity.entityId)).repositoryLinks[0]!;

    // A second attempt, and the corrected delivery it produced.
    await startAttempt(task, "run_2");
    const third = checkpoint(app, SESSION, 3);
    write(app, { "src/a.ts": "four\n" });
    const fourth = checkpoint(app, SESSION, 4);
    const ended = await endAttempt(task, "run_2");
    const record = (ended.link.repositories ?? []).find((row) => row.name === "app")!;
    expect(record.checkpoints.map((row) => row.commitObjectId)).toEqual([third, fourth]);
    expect(record.change?.head.commitObjectId).toBe(fourth);

    const corrected = ok<ProjectWorkLinkResult>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "delivery",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          repositoryId: first.repositoryId,
          change: record.change!,
          supersedesLinkId: first.linkId,
          confirm: true,
        },
        idempotencyKey: "accept-correction",
      }),
    );
    if (corrected.link.type !== "delivery") throw new Error("unreachable");
    expect(corrected.link.links[0]!.supersedesLinkId).toBe(first.linkId);
    expect(corrected.link.links[0]!.target).toEqual({ change: record.change });

    const links = (await detail(task.entity.entityId)).repositoryLinks;
    expect(links.map((link) => link.linkId), "the old provenance is kept").toContain(first.linkId);
    expect(links).toHaveLength(2);
  });
});

describe.runIf(haveGit)("a decision keeps what it rests on readable", () => {
  it("keeps a verification's state readable after its checkpoint is pruned, and still completes the task", async () => {
    const { app } = workspace();
    const task = await seedTask();
    // A verification recorded against an exact state, the ordinary way.
    const verified = checkpoint(app, SESSION, 1);
    const repositoryId = (await startAttempt(task)).link.repositories?.find((row) => row.name === "app")!.repositoryId;
    // The verification names the state it ran against, and the `verified_at`
    // link is written from that record rather than claimed beside it. Under
    // D-361 the host captures that state **before** the link exists, so the
    // evidence outlives the checkpoint it was taken from.
    const recorded = ok<ProjectWorkLinkResult>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "evidence",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          kind: "test",
          role: "acceptance",
          summary: "The suite passed.",
          outcome: "passed",
          verifiedAt: { repositoryId: repositoryId!, state: { vcs: "git", objectFormat: "sha1", commitObjectId: verified } },
        },
        idempotencyKey: "acceptance",
      }),
    );
    if (recorded.link.type !== "evidence") throw new Error("unreachable");
    const verifiedLinkId = recorded.link.evidence.repositoryLinkId;
    const verifiedLink = (await detail(task.entity.entityId)).repositoryLinks.find((link) => link.linkId === verifiedLinkId);
    expect(verifiedLink?.relation).toBe("verified_at");
    expect(verifiedLink?.target).toEqual({ state: { vcs: "git", objectFormat: "sha1", commitObjectId: verified } });
    expect(verifiedLink?.captureBlobId, "the state was captured before the link was written").toBeDefined();
    for (const action of ["mark_ready", "start"] as const) {
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        action,
        idempotencyKey: action,
      });
    }

    // Routine retention takes the ref, and gc takes the parentless commit.
    prune(app, [checkpointRef(checkpointSessionKey(SESSION), 1)]);

    ok(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        action: "complete",
        idempotencyKey: "complete",
      }),
    );
    expect((await detail(task.entity.entityId)).entity.state).toBe("done");

    // And what the completion rests on is still readable: git cannot answer,
    // the capture can, and the record says both.
    const after = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        body: { mode: "none" },
        include: { repositoryStatus: true },
      }),
    );
    const status = after.repositoryStatus?.find((row) => row.linkId === verifiedLinkId);
    expect(status?.sourceAvailable, "the checkpoint really is gone").toBe(false);
    expect(status?.captureAvailable, "and the evidence is still there").toBe(true);
    const blobId = after.repositoryLinks.find((link) => link.linkId === verifiedLinkId)?.captureBlobId;
    const page = ok<{ data?: string }>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId }));
    const capture = JSON.parse(Buffer.from(page.data!, "base64").toString("utf8")) as {
      state?: { commitObjectId: string };
      files: Array<{ path: string; blobObjectId?: string; mode?: string }>;
    };
    expect(capture.state?.commitObjectId, "the capture is of the state that was accepted").toBe(verified);
    expect(capture.files.length, "a parentless checkpoint is captured as its tree").toBeGreaterThan(0);
    expect(capture.files[0]!.blobObjectId, "with the identity that survives gc").toBeDefined();
    expect(capture.files[0]!.mode).toBeDefined();
  });

  it("refuses to record a state git no longer has, rather than storing a link that looks like proof", async () => {
    const { app } = workspace();
    const task = await seedTask();
    const gone = checkpoint(app, SESSION, 1);
    const repositoryId = (await startAttempt(task)).link.repositories?.find((row) => row.name === "app")!.repositoryId;
    prune(app, [checkpointRef(checkpointSessionKey(SESSION), 1)]);
    const error = failed(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "evidence",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          kind: "test",
          role: "acceptance",
          summary: "The suite passed.",
          outcome: "passed",
          verifiedAt: { repositoryId: repositoryId!, state: { vcs: "git", objectFormat: "sha1", commitObjectId: gone } },
        },
        idempotencyKey: "acceptance-gone",
      }),
    );
    expect(error.message).toMatch(/could not be read out of the repository/);
    expect((await detail(task.entity.entityId)).repositoryLinks.some((link) => link.relation === "verified_at")).toBe(false);
  });
});

describe.runIf(haveGit)("two attempts on one task stay two attempts", () => {
  const OTHER = "/sessions/ses_2.jsonl";

  async function open(task: ProjectWorkWriteResult, targetId: string, sessionPath: string): Promise<ProjectTaskLinkExecutionResult> {
    return ok<ProjectTaskLinkExecutionResult>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "agent_run", targetId, sessionPath },
        idempotencyKey: `open-${targetId}`,
      }),
    );
  }

  async function close(task: ProjectWorkWriteResult, targetId: string, sessionPath: string) {
    return h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId, outcome: "completed", sessionPath },
      idempotencyKey: `close-${targetId}`,
    });
  }

  it("closes each run's own row, and never the other's, when two runs are open at once", async () => {
    workspace();
    const task = await seedTask();
    const first = await open(task, "run_a", SESSION);
    const second = await open(task, "run_b", OTHER);
    expect(first.link.linkId, "two runs are two rows").not.toBe(second.link.linkId);

    ok(await close(task, "run_a", SESSION));
    const links = (await detail(task.entity.entityId)).executionLinks;
    const a = links.find((link) => link.targetId === "run_a")!;
    const b = links.find((link) => link.targetId === "run_b")!;
    expect(a.endedAt, "the one that said it was ending").toBeDefined();
    expect(b.endedAt, "and only that one").toBeUndefined();
  });

  it("refuses a closing call from a conversation that has no attempt open here", async () => {
    workspace();
    const task = await seedTask();
    await open(task, "run_a", SESSION);
    // Same target, a different conversation: recency would have closed the
    // row anyway, and recency is not identity (review F2).
    const error = failed(await close(task, "run_a", OTHER));
    expect(error.message).toMatch(/No attempt this conversation started is open/);
    const link = (await detail(task.entity.entityId)).executionLinks.find((row) => row.targetId === "run_a")!;
    expect(link.endedAt, "nothing was closed").toBeUndefined();
  });
});

describe.runIf(haveGit)("accepting a checkpoint preview as native visual evidence", () => {
  /** The acceptance a person sends: the one evidence-link door, asking for it. */
  async function accept(
    task: ProjectWorkWriteResult,
    repositoryId: string,
    state: { commitObjectId: string; checkpointId?: string },
    over: { revisionId?: string; key?: string; attempt?: { taskEntityId: string; executionLinkId: string } } = {},
    attempt?: { taskEntityId: string; executionLinkId: string },
  ) {
    const named = over.attempt ?? attempt;
    return h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "evidence",
        entityId: task.entity.entityId,
        revisionId: over.revisionId ?? task.revision.revisionId,
        kind: "person_acceptance",
        role: "acceptance",
        summary: "I looked at the preview and it matches.",
        outcome: "passed",
        verifiedAt: {
          repositoryId,
          state: { vcs: "git", objectFormat: "sha1", ...state },
          acceptance: { kind: "checkpoint_preview" },
          ...(named ? { attempt: named } : {}),
        },
      },
      idempotencyKey: over.key ?? "accept-preview",
    });
  }

  it("records what the host proved, and keeps the state readable after the checkpoint is pruned", async () => {
    const { app } = workspace();
    const task = await seedTask();
    write(app, { "src/a.ts": "two\n" });
    const run = await attemptWith(task, app, 1);
    const { repositoryId, commit, ref } = run;

    const written = ok<ProjectWorkLinkResult>(
      await accept(task, repositoryId, { commitObjectId: commit, checkpointId: ref }, {}, run.attempt),
    );
    if (written.link.type !== "evidence") throw new Error("unreachable");
    const linkId = written.link.evidence.repositoryLinkId!;
    const link = (await detail(task.entity.entityId)).repositoryLinks.find((row) => row.linkId === linkId)!;
    expect(link.acceptance?.kind).toBe("checkpoint_preview");
    expect(link.acceptance?.checkpointRef, "the ref the host really found").toBe(ref);
    expect(link.acceptance?.commitObjectId, "and the commit that ref really pointed at").toBe(commit);
    expect(link.acceptance?.subjectDigest).toBe(task.revision.digest);
    expect(link.acceptance?.acceptedBy.kind).toBe("person");
    expect(link.captureBlobId, "captured before the acceptance was written").toBeDefined();
    expect(link.executionLinkId, "the attempt the host tied it to").toBe(run.attempt.executionLinkId);

    prune(app, [ref]);
    const after = await detail(task.entity.entityId, true);
    const status = after.repositoryStatus?.find((row) => row.linkId === linkId);
    expect(status?.sourceAvailable).toBe(false);
    expect(status?.captureAvailable, "the acceptance outlives the checkpoint it was taken from").toBe(true);
  });

  it("refuses a checkpoint id that is not a ref this repository has", async () => {
    const { app } = workspace();
    const task = await seedTask();
    write(app, { "src/a.ts": "two\n" });
    const run = await attemptWith(task, app, 1);
    const error = failed(
      await accept(
        task,
        run.repositoryId,
        { commitObjectId: run.commit, checkpointId: `${checkpointRef(checkpointSessionKey(SESSION), 99)}` },
        {},
        run.attempt,
      ),
    );
    expect(error.message).toMatch(/not one this repository has/);
    expect((await detail(task.entity.entityId)).repositoryLinks.some((row) => row.relation === "verified_at")).toBe(false);
  });

  it("refuses a checkpoint that points somewhere else than the state being recorded", async () => {
    const { app } = workspace();
    const task = await seedTask();
    write(app, { "src/a.ts": "two\n" });
    const run = await attemptWith(task, app, 1);
    // A commit that exists in this repository, but is not the one that ref
    // names: existence alone is never the test.
    const error = failed(await accept(task, run.repositoryId, { commitObjectId: head(app), checkpointId: run.ref }, {}, run.attempt));
    expect(error.message).toMatch(/no longer points at the state/);
  });

  it("refuses an agent, and refuses a revision the work has moved past", async () => {
    const { app } = workspace();
    const task = await seedTask();
    write(app, { "src/a.ts": "two\n" });
    const run = await attemptWith(task, app, 1);
    const { repositoryId, commit, ref } = run;

    const byAgent = await (async () => {
      try {
        await bridge({
        method: "project/work/link",
        params: {
          projectId: h.projectId,
          expectedRevisionId: task.revision.revisionId,
          link: {
            type: "evidence",
            entityId: task.entity.entityId,
            revisionId: task.revision.revisionId,
            kind: "person_acceptance",
            role: "acceptance",
            summary: "I looked at it.",
            outcome: "passed",
            verifiedAt: {
              repositoryId,
              state: { vcs: "git", objectFormat: "sha1", commitObjectId: commit, checkpointId: ref },
              acceptance: { kind: "checkpoint_preview" },
              attempt: run.attempt,
            },
          },
          idempotencyKey: "agent-accepts",
        },
      });
      } catch (error) {
        return error as Error;
      }
      throw new Error("an agent's acceptance should have been refused");
    })();
    expect(byAgent.message).toMatch(/Only a person accepts a checkpoint preview/);

    // The Task moves on; a preview accepted against the revision nobody looked
    // at any more is refused rather than inherited.
    const revised = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        body: taskBody("A different outcome."),
        idempotencyKey: "move-on",
      }),
    );
    const stale = failed(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: revised.revision.revisionId,
        link: {
          type: "evidence",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          kind: "person_acceptance",
          role: "acceptance",
          summary: "I looked at the old one.",
          outcome: "passed",
          verifiedAt: {
            repositoryId,
            state: { vcs: "git", objectFormat: "sha1", commitObjectId: commit, checkpointId: ref },
            acceptance: { kind: "checkpoint_preview" },
            attempt: run.attempt,
          },
        },
        idempotencyKey: "accept-stale",
      }),
    );
    expect(stale.message).toMatch(/has moved on since that preview was made/);
  });
});

describe.runIf(haveGit)("a revision written from a session with a checkout says where it came from", () => {
  it("records based_on for every repository of that checkout, at the exact commit", async () => {
    const { app, lib } = workspace();
    const created = (await bridge({
      method: "project/work/create",
      params: { projectId: h.projectId, kind: "spec", title: "From a session", body: specBody(), idempotencyKey: "from-session" },
    })) as ProjectWorkBridgeResult;
    const result = created.result as ProjectWorkWriteResult;
    const basedOn = result.basedOn ?? [];
    expect(basedOn).toHaveLength(2);
    expect(basedOn.every((link) => link.relation === "based_on")).toBe(true);
    const commits = basedOn.map((link) => ("state" in link.target ? link.target.state.commitObjectId : "")).sort();
    expect(commits).toEqual([head(app), head(lib)].sort());
    expect(basedOn.every((link) => link.display?.branch === "main")).toBe(true);

    // A person's own write, with no session checkout, records nothing.
    const byPerson = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "Typed in the workspace",
        body: specBody("A person wrote this."),
        idempotencyKey: "by-person",
      }),
    );
    expect(byPerson.basedOn).toBeUndefined();
  });

  it("names bytes that are not text as what they are, with their true size", async () => {
    const { app } = workspace();
    const task = await seedTask();
    const repositoryId = (await startAttempt(task)).link.repositories?.find((row) => row.name === "app")!.repositoryId;
    // A file whose bytes are not valid UTF-8 and carry no NUL: decoding it
    // would produce mojibake that weighs a different number of bytes than the
    // file does (review F9).
    writeFileSync(join(app, "logo.bin"), Buffer.from([0xff, 0xfe, 0x41, 0x42, 0xc3, 0x28]));
    const commit = checkpoint(app, SESSION, 1);
    const ref = checkpointRef(checkpointSessionKey(SESSION), 1);
    const written = ok<ProjectWorkLinkResult>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "evidence",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          kind: "test",
          role: "supporting",
          summary: "Ran against this state.",
          outcome: "passed",
          verifiedAt: { repositoryId: repositoryId!, state: { vcs: "git", objectFormat: "sha1", commitObjectId: commit, checkpointId: ref } },
        },
        idempotencyKey: "binary-capture",
      }),
    );
    if (written.link.type !== "evidence") throw new Error("unreachable");
    const linkId = written.link.evidence.repositoryLinkId!;
    const blobId = (await detail(task.entity.entityId)).repositoryLinks.find((row) => row.linkId === linkId)!.captureBlobId!;
    const page = ok<{ data?: string }>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId }));
    const capture = JSON.parse(Buffer.from(page.data!, "base64").toString("utf8")) as RepositoryCapture;
    const binary = capture.files.find((file) => file.path === "logo.bin")!;
    expect(binary.omitted, "not captured as text").toBe("binary");
    expect(binary.bytes, "the file's own size, not the decoded one").toBe(6);
    expect(binary.blobObjectId, "its identity is kept").toBeDefined();
    expect(capture.sources.some((source) => source.path === "logo.bin"), "and its bytes are not").toBe(false);
  });

  it("records the run's own worktree, not the directory the worker was spawned for", async () => {
    const { app } = workspace();
    // A run working somewhere else, with a HEAD of its own.
    const run = join(h.projectRoot, "run");
    initRepo(run, { "src/c.ts": "run\n" });

    const created = (await bridge(
      {
        method: "project/work/create",
        params: { projectId: h.projectId, kind: "spec", title: "From a worktree", body: specBody("In a worktree."), idempotencyKey: "from-worktree" },
      },
      { attempt: { workspace: "worktree", checkout: run } },
    )) as ProjectWorkBridgeResult;
    const basedOn = (created.result as ProjectWorkWriteResult).basedOn ?? [];
    const commits = basedOn.map((link) => ("state" in link.target ? link.target.state.commitObjectId : ""));
    expect(commits, "the commit the run was really on").toEqual([head(run)]);
    expect(commits).not.toContain(head(app));
  });
});
