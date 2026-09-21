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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody, taskBody } from "./fixtures.js";

/** A Task body that declares the paths it means to write in. */
function taskBodyWith(paths: string[]): ReturnType<typeof taskBody> {
  const body = taskBody();
  if (body.kind !== "task") throw new Error("unreachable");
  return { kind: "task", task: { ...body.task, scope: { packages: [], repositories: [], paths, capabilities: [] } } };
}

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let h: ProjectWorkHarness;
const dirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const AGENT = { label: "Builder", sessionId: "ses_1", runId: "run_1" };
const SESSION = "/sessions/ses_1.jsonl";

// ------------------------------------------------------------------ git

function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x",
  };
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", args, { cwd, env }).toString();
}

function initRepo(dir: string, contents: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@x"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, contents);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

function write(dir: string, contents: Record<string, string>): void {
  for (const [name, body] of Object.entries(contents)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

/**
 * One checkpoint, exactly as the worker writes one: a commit object built
 * through an isolated index and published under
 * `refs/<product>/checkpoints/<session>/<turn>`, touching nothing a person
 * can see (`docs/source-control-leap.md` §E.1).
 */
function checkpoint(repo: string, sessionPath: string, turn: number): string {
  const indexFile = join(repo, `.git/${PRODUCT_NAME}-test-index-${String(turn)}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x",
  };
  execFileSync("git", ["add", "-A"], { cwd: repo, env });
  const tree = execFileSync("git", ["write-tree"], { cwd: repo, env }).toString().trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-m", `checkpoint turn=${String(turn)}`], { cwd: repo, env })
    .toString()
    .trim();
  rmSync(indexFile, { force: true });
  git(repo, ["update-ref", checkpointRef(checkpointSessionKey(sessionPath), turn), commit]);
  return commit;
}

function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

/** Make an object unreachable for real: drop every ref to it, then prune. */
function prune(repo: string, refs: string[]): void {
  for (const ref of refs) git(repo, ["update-ref", "-d", ref]);
  git(repo, ["reflog", "expire", "--expire=now", "--all"]);
  git(repo, ["gc", "--prune=now", "--quiet"]);
}

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
  it("refuses to complete a task whose evidence is gone and was never captured", async () => {
    const { app } = workspace();
    const task = await seedTask();
    // A verification recorded against an exact state, the ordinary way.
    const verified = checkpoint(app, SESSION, 1);
    const repositoryId = (await startAttempt(task)).link.repositories?.find((row) => row.name === "app")!.repositoryId;
    // The verification names the state it ran against, and the `verified_at`
    // link is written from that record rather than claimed beside it.
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
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      action: "mark_ready",
      idempotencyKey: "ready",
    });
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      action: "start",
      idempotencyKey: "start",
    });

    prune(app, [checkpointRef(checkpointSessionKey(SESSION), 1)]);

    const error = failed(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        action: "complete",
        idempotencyKey: "complete",
      }),
    );
    expect(error.message).toMatch(/Marking this task done rests on a state/);
    expect((await detail(task.entity.entityId)).entity.state, "nothing moved").toBe("in_progress");
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
});
