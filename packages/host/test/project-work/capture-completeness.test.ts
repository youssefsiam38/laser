/**
 * Every source a decision rests on, kept whole — or the decision refused
 * (M21-T19, review F1, D-361).
 *
 * The rule under test is one sentence: a decision is only as durable as what
 * can still be read after git has forgotten. So the host works out, **while
 * git can still answer**, exactly which files the thing being decided about
 * touched, keeps every one of them whole, and refuses the decision when it
 * cannot — before any blob is stored and before any link is written.
 *
 * Everything here runs against real repositories in temp directories and
 * reaches the authority through the router, the way a person's app does. The
 * three things a mock would assume away are precisely the three under test:
 * that the required set is the difference between an attempt's own base and
 * the **exact** state being decided about, that each body is read at the side
 * a review of it needs, and that what is stored still reads back after
 * `git gc` has reclaimed everything it came from.
 */
import {
  PRODUCT_NAME,
  REQUIRED_PATHS_MAX,
  checkpointRef,
  type ProjectTaskLinkExecutionResult,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkBody,
  type ProjectWorkGetResult,
  type ProjectWorkLinkResult,
  type ProjectWorkWriteResult,
  type RepositoryCapture,
  type VerificationCommandRun,
  type VerificationReport,
} from "@lasercode/protocol";
import { checkpointSessionKey } from "@lasercode/protocol/checkpoint-key";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { checkpoint, commit, git, haveGit, head, initRepo, prune, write } from "./git-fixtures.js";
import { buildCapture, buildStateCapture, requiredComplete, storeCapture } from "../../src/project-work/captures.js";
import { expectedRequiredFacts } from "../../src/project-work/required-facts.js";
import { diffBetween } from "../../src/source-control/read.js";

// No suite-wide timeout. Measured under the whole `test/project-work` load,
// the slowest test here is the 520-file padding fixture at just under a
// second, and everything else is a few hundred milliseconds: nothing in this
// file is within reach of vitest's default, and a blanket sixty seconds would
// only hide the day one of them becomes genuinely slow (review F4).

let h: ProjectWorkHarness;
const dirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const AGENT = { label: "Builder", sessionId: "ses_1", runId: "run_1" };
const SESSION = "/sessions/ses_1.jsonl";

// --------------------------------------------------------------- the world

function taskBody(over: { visual?: boolean; commands?: string[] } = {}): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: "The list shows why an export failed.",
      nonGoals: [],
      dependencies: [],
      scope: { packages: [], repositories: [], paths: [], capabilities: [] },
      acceptance: [{ id: "a1", text: "A failed row shows the reason.", machineVerifiable: false }],
      verificationCommands: over.commands ?? [],
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

/** A project folder holding one or two real repositories. */
function workspace(repos: Record<string, Record<string, string | Buffer>> = { app: { "src/a.ts": "one\n" } }): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-required-`));
  dirs.push(dir);
  h = projectWorkHarness({ dir });
  const made: Record<string, string> = {};
  for (const [name, contents] of Object.entries(repos)) {
    const path = join(h.projectRoot, name);
    initRepo(path, contents);
    made[name] = path;
  }
  return made;
}

let keys = 0;
function idem(prefix: string): string {
  keys += 1;
  return `${prefix}-${String(keys)}`;
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
      include: { links: true, evidence: true },
    }),
  );
}

interface Attempt {
  attempt: { taskEntityId: string; executionLinkId: string };
  repositoryId: (name: string) => string;
  base: (name: string) => string;
  link: ProjectTaskLinkExecutionResult["link"];
}

async function startAttempt(task: ProjectWorkWriteResult, targetId = "run_1"): Promise<void> {
  ok<ProjectTaskLinkExecutionResult>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId, sessionPath: SESSION },
      idempotencyKey: idem(`start-${targetId}`),
    }),
  );
}

/** Close the attempt, which is when the host re-reads git and writes its record. */
async function endAttempt(task: ProjectWorkWriteResult, targetId = "run_1"): Promise<Attempt> {
  const ended = ok<ProjectTaskLinkExecutionResult>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId, outcome: "completed", sessionPath: SESSION },
      idempotencyKey: idem(`end-${targetId}`),
    }),
  );
  const rowOf = (name: string) => {
    const row = ended.link.repositories?.find((candidate) => candidate.name === name);
    if (!row) throw new Error(`the attempt recorded no repository called ${name}`);
    return row;
  };
  return {
    attempt: { taskEntityId: task.entity.entityId, executionLinkId: ended.link.linkId },
    repositoryId: (name) => rowOf(name).repositoryId,
    base: (name) => rowOf(name).base.commitObjectId,
    link: ended.link,
  };
}

/** The one door: an evidence link that asks the host to record an acceptance. */
async function accept(input: {
  subject: ProjectWorkWriteResult | { entity: { entityId: string }; revision: { revisionId: string } };
  expectedRevisionId?: string;
  repositoryId: string;
  commitObjectId: string;
  checkpointId?: string;
  /** The bounded scope the state names, when the request names one. */
  path?: string;
  attempt?: { taskEntityId: string; executionLinkId: string };
  acceptance?: boolean;
}) {
  const subjectRevision = input.subject.revision.revisionId;
  return h.call("project/work/link", {
    projectId: h.projectId,
    expectedRevisionId: input.expectedRevisionId ?? subjectRevision,
    link: {
      type: "evidence",
      entityId: input.subject.entity.entityId,
      revisionId: subjectRevision,
      kind: "person_acceptance",
      role: "acceptance",
      summary: "I opened the build at this checkpoint and it matches.",
      outcome: "passed",
      verifiedAt: {
        repositoryId: input.repositoryId,
        state: {
          vcs: "git" as const,
          objectFormat: "sha1" as const,
          commitObjectId: input.commitObjectId,
          ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
          ...(input.path ? { path: input.path } : {}),
        },
        ...(input.acceptance === false ? {} : { acceptance: { kind: "checkpoint_preview" as const } }),
        ...(input.attempt ? { attempt: input.attempt } : {}),
      },
    },
    idempotencyKey: idem("accept"),
  });
}

/** The capture one link points at, read back out of the store. */
async function captureOf(entityId: string, linkId: string): Promise<RepositoryCapture> {
  const link = (await detail(entityId)).repositoryLinks.find((row) => row.linkId === linkId);
  if (!link?.captureBlobId) throw new Error("that link has no capture");
  const page = ok<{ data?: string }>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId: link.captureBlobId }));
  return JSON.parse(Buffer.from(page.data!, "base64").toString("utf8")) as RepositoryCapture;
}

function linkIdOf(result: ProjectWorkLinkResult): string {
  if (result.link.type !== "evidence" || !result.link.evidence.repositoryLinkId) throw new Error("no verified_at link was written");
  return result.link.evidence.repositoryLinkId;
}

/** How many blobs this project holds, read straight out of the database. */
function blobCount(): number {
  const db = new DatabaseSync(join(h.dir, "project-work.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM blobs WHERE project_id = ?").get(h.projectId) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function sourceOf(capture: RepositoryCapture, path: string, side: "before" | "after" = "after"): string | undefined {
  return capture.sources.find((row) => row.path === path && (row.side ?? "after") === side)?.text;
}

function requiredPaths(capture: RepositoryCapture): string[] {
  return (capture.required?.entries ?? []).map((entry) => entry.path).sort();
}

// ------------------------------------------------- the set, and where it is from

describe.runIf(haveGit)("the sources a review rests on", () => {
  it("is the attempt's base against the exact checkpoint, including what the first checkpoint changed", async () => {
    const { app } = workspace({ app: { "src/a.ts": "one\n", "src/untouched.ts": "still\n" } });
    const task = await create("task", "Say why", taskBody());
    await startAttempt(task);
    write(app, { "src/a.ts": "two\n" });
    checkpoint(app, SESSION, 1);
    write(app, { "src/b.ts": "new\n" });
    const second = checkpoint(app, SESSION, 2);
    const run = await endAttempt(task);

    const record = run.link.repositories!.find((row) => row.name === "app")!;
    expect(
      record.changedPaths,
      "the attempt's own aggregate starts at its first checkpoint, so what that checkpoint already changed is not in it",
    ).not.toContain("src/a.ts");

    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: second, checkpointId: checkpointRef(checkpointSessionKey(SESSION), 2), attempt: run.attempt }),
    );
    const capture = await captureOf(task.entity.entityId, linkIdOf(written));
    expect(capture.required?.basis).toBe("attempt_base_to_state");
    expect(capture.required?.from.baseCommitObjectId).toBe(run.base("app"));
    expect(capture.required?.from.executionLinkId).toBe(run.attempt.executionLinkId);
    expect(capture.required?.complete).toBe(true);
    expect(requiredPaths(capture), "everything between the base and this state, aggregate or not").toEqual(["src/a.ts", "src/b.ts"]);
    expect(sourceOf(capture, "src/a.ts")).toBe("two\n");
    expect(requiredPaths(capture), "and nothing the work never touched").not.toContain("src/untouched.ts");
  });

  it("keeps an older checkpoint's file as it was at that checkpoint, whatever a later one did to it", async () => {
    const { app } = workspace();
    const task = await create("task", "Say why", taskBody());
    await startAttempt(task);
    write(app, { "src/a.ts": "two\n" });
    const first = checkpoint(app, SESSION, 1);
    // A later checkpoint puts it back and adds something else. Accepting the
    // earlier one must describe the earlier one.
    write(app, { "src/a.ts": "one\n", "src/late.ts": "later\n" });
    checkpoint(app, SESSION, 2);
    const run = await endAttempt(task);

    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: first, checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1), attempt: run.attempt }),
    );
    const capture = await captureOf(task.entity.entityId, linkIdOf(written));
    expect(requiredPaths(capture)).toEqual(["src/a.ts"]);
    expect(sourceOf(capture, "src/a.ts"), "the state that was accepted, not the newest one").toBe("two\n");
    expect(requiredPaths(capture)).not.toContain("src/late.ts");
  });

  it("captures a delete by what was removed, and a rename as both sides", async () => {
    const { app } = workspace({ app: { "src/old.ts": "the old body\n", "src/gone.ts": "removed\n" } });
    const task = await create("task", "Rename it", taskBody());
    await startAttempt(task);
    git(app, ["mv", "src/old.ts", "src/new.ts"]);
    rmSync(join(app, "src/gone.ts"));
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);

    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: made, checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1), attempt: run.attempt }),
    );
    const capture = await captureOf(task.entity.entityId, linkIdOf(written));
    expect(requiredPaths(capture), "a rename is the delete and the add, which is the two bodies a review needs").toEqual([
      "src/gone.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
    expect(sourceOf(capture, "src/old.ts", "before"), "a delete is reviewed by reading what was removed").toBe("the old body\n");
    expect(sourceOf(capture, "src/old.ts", "after"), "and never read back as the accepted state's content").toBeUndefined();
    expect(sourceOf(capture, "src/new.ts")).toBe("the old body\n");
    expect(sourceOf(capture, "src/gone.ts", "before")).toBe("removed\n");
    expect(capture.required?.entries.find((entry) => entry.path === "src/gone.ts")?.status).toBe("deleted");
  });

  it("keeps a required file that sorts past the end of the bounded listing", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 520; i++) files[`pad/${String(i).padStart(4, "0")}.ts`] = `pad ${String(i)}\n`;
    const { app } = workspace({ app: files });
    const task = await create("task", "Past the cap", taskBody());
    await startAttempt(task);
    write(app, { "zz-last.ts": "the one that matters\n" });
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);

    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: made, checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1), attempt: run.attempt }),
    );
    const capture = await captureOf(task.entity.entityId, linkIdOf(written));
    expect(capture.files.length, "the listing is bounded").toBe(500);
    expect(capture.files.some((file) => file.path === "zz-last.ts"), "and does not reach the file in question").toBe(false);
    expect(requiredPaths(capture), "which changes nothing about keeping it").toEqual(["zz-last.ts"]);
    expect(sourceOf(capture, "zz-last.ts")).toBe("the one that matters\n");
    expect(capture.truncated, "and the capture says what its listing is").toMatch(/first 500 files of the tree/);
  });

  it("keeps one repository's change and nothing of the other's", async () => {
    const { app, lib } = workspace({ app: { "src/a.ts": "one\n" }, lib: { "src/b.ts": "one\n" } }) as { app: string; lib: string };
    const task = await create("task", "Both repositories", taskBody());
    await startAttempt(task);
    write(app, { "src/a.ts": "app changed\n" });
    write(lib, { "src/b.ts": "lib changed\n" });
    const appCommit = checkpoint(app, SESSION, 1);
    const libCommit = checkpoint(lib, SESSION, 1);
    const run = await endAttempt(task);
    expect(appCommit, "two repositories, two commits").not.toBe(libCommit);

    const ref = checkpointRef(checkpointSessionKey(SESSION), 1);
    const forApp = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: appCommit, checkpointId: ref, attempt: run.attempt }),
    );
    const appCapture = await captureOf(task.entity.entityId, linkIdOf(forApp));
    expect(requiredPaths(appCapture)).toEqual(["src/a.ts"]);
    expect(sourceOf(appCapture, "src/a.ts")).toBe("app changed\n");
    expect(sourceOf(appCapture, "src/b.ts"), "the other repository is a second acceptance, never an inferred merge").toBeUndefined();

    const forLib = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("lib"), commitObjectId: libCommit, checkpointId: ref, attempt: run.attempt }),
    );
    const libCapture = await captureOf(task.entity.entityId, linkIdOf(forLib));
    expect(requiredPaths(libCapture)).toEqual(["src/b.ts"]);
    expect(libCapture.state?.commitObjectId).toBe(libCommit);
  });

  it("takes a parented commit's own difference as its set", async () => {
    const { app } = workspace();
    const task = await create("task", "An ordinary commit", taskBody());
    await startAttempt(task);
    write(app, { "src/a.ts": "committed\n" });
    const made = commit(app, "the attempt's own commit");
    const run = await endAttempt(task);

    // A plain `verified_at` naming the attempt: validated and captured the
    // same way, and not native evidence.
    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: made, attempt: run.attempt, acceptance: false }),
    );
    const capture = await captureOf(task.entity.entityId, linkIdOf(written));
    expect(capture.required?.basis).toBe("commit_parent_to_commit");
    expect(requiredPaths(capture)).toEqual(["src/a.ts"]);
    expect(sourceOf(capture, "src/a.ts")).toBe("committed\n");
    const link = (await detail(task.entity.entityId)).repositoryLinks.find((row) => row.linkId === linkIdOf(written))!;
    expect(link.acceptance, "a plain state link is not an acceptance").toBeUndefined();
    expect(link.executionLinkId).toBe(run.attempt.executionLinkId);
  });
});

// --------------------------------------------------------------- the identity

describe.runIf(haveGit)("the attempt a review is joined to", () => {
  /** A Design the Task is built from, pinned by an edge at an exact revision. */
  async function designed(task: ProjectWorkWriteResult, design: ProjectWorkWriteResult): Promise<void> {
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
  }

  it("accepts a design-backed review on the design, joined to the task's own attempt", async () => {
    const { app } = workspace();
    const design = await create("design", "Export row", designBody());
    const task = await create("task", "Build it", taskBody({ visual: true }));
    await designed(task, design);
    await startAttempt(task);
    write(app, { "src/a.ts": "built\n" });
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);

    const written = ok<ProjectWorkLinkResult>(
      await accept({
        subject: design,
        repositoryId: run.repositoryId("app"),
        commitObjectId: made,
        checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1),
        attempt: run.attempt,
      }),
    );
    const linkId = linkIdOf(written);
    const link = (await detail(design.entity.entityId)).repositoryLinks.find((row) => row.linkId === linkId)!;
    expect(link.subject.entityId, "recorded on the design, which is what the criterion answers to").toBe(design.entity.entityId);
    expect(link.acceptance?.subjectDigest).toBe(design.revision.digest);
    const capture = await captureOf(design.entity.entityId, linkId);
    expect(capture.required?.from.taskEntityId, "and joined to the task whose attempt did the work").toBe(task.entity.entityId);
    expect(requiredPaths(capture)).toEqual(["src/a.ts"]);
  });

  it("refuses a subject the task does not answer to, and a revision it no longer pins", async () => {
    const { app } = workspace();
    const design = await create("design", "Export row", designBody());
    const other = await create("design", "Something else", designBody("Another surface."));
    const task = await create("task", "Build it", taskBody({ visual: true }));
    await designed(task, design);
    await startAttempt(task);
    write(app, { "src/a.ts": "built\n" });
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);
    const ref = checkpointRef(checkpointSessionKey(SESSION), 1);
    const before = blobCount();

    const foreign = failed(
      await accept({ subject: other, repositoryId: run.repositoryId("app"), commitObjectId: made, checkpointId: ref, attempt: run.attempt }),
    );
    expect(foreign.message).toMatch(/does not answer to that item/);

    // The design moves on: the edge still pins the revision the work was done
    // against, so a review of the new one proves nothing about it.
    const revised = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: design.entity.entityId,
        expectedRevisionId: design.revision.revisionId,
        body: designBody("The row, rethought."),
        idempotencyKey: idem("revise-design"),
      }),
    );
    const stale = failed(
      await accept({
        subject: { entity: { entityId: design.entity.entityId }, revision: { revisionId: revised.revision.revisionId } },
        repositoryId: run.repositoryId("app"),
        commitObjectId: made,
        checkpointId: ref,
        attempt: run.attempt,
      }),
    );
    expect(stale.message).toMatch(/built from .* at a different revision/);
    expect(blobCount(), "a refused review costs no quota and leaves no blob").toBe(before);
    expect((await detail(design.entity.entityId)).repositoryLinks.some((row) => row.relation === "verified_at")).toBe(false);
  });

  it("refuses an attempt that belongs to another task, and a checkpoint that attempt never recorded", async () => {
    const { app } = workspace();
    const task = await create("task", "Mine", taskBody());
    const neighbour = await create("task", "Not mine", taskBody());
    await startAttempt(neighbour, "run_other");
    await endAttempt(neighbour, "run_other");
    await startAttempt(task);
    write(app, { "src/a.ts": "built\n" });
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);
    const ref = checkpointRef(checkpointSessionKey(SESSION), 1);
    const before = blobCount();

    const borrowed = failed(
      await accept({
        subject: task,
        repositoryId: run.repositoryId("app"),
        commitObjectId: made,
        checkpointId: ref,
        // A real attempt of a real task, reported under this task's id.
        attempt: { taskEntityId: task.entity.entityId, executionLinkId: (await detail(neighbour.entity.entityId)).executionLinks[0]!.linkId },
      }),
    );
    expect(borrowed.message).toMatch(/not one this task has/);

    // A checkpoint made after the attempt closed: real, in git, and not this
    // attempt's work.
    write(app, { "src/a.ts": "afterwards\n" });
    const later = checkpoint(app, SESSION, 9);
    const notRecorded = failed(
      await accept({
        subject: task,
        repositoryId: run.repositoryId("app"),
        commitObjectId: later,
        checkpointId: checkpointRef(checkpointSessionKey(SESSION), 9),
        attempt: run.attempt,
      }),
    );
    expect(notRecorded.message).toMatch(/not one this attempt recorded/);
    expect(blobCount()).toBe(before);
    expect((await detail(task.entity.entityId)).repositoryLinks.some((row) => row.relation === "verified_at")).toBe(false);
  });

  it("refuses an acceptance that names no attempt at all", async () => {
    const { app } = workspace();
    const task = await create("task", "No identity", taskBody());
    await startAttempt(task);
    write(app, { "src/a.ts": "built\n" });
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);
    const before = blobCount();
    const error = failed(
      await accept({
        subject: task,
        repositoryId: run.repositoryId("app"),
        commitObjectId: made,
        checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1),
      }),
    );
    expect(error.message, "said as what a person can act on, not as a schema complaint").toMatch(/says which attempt's work you looked at/);
    expect(blobCount()).toBe(before);
    expect((await detail(task.entity.entityId)).repositoryLinks.some((row) => row.relation === "verified_at")).toBe(false);
  });
});

// ---------------------------------------------------------------- refusals

describe.runIf(haveGit)("a source that cannot be kept whole refuses the decision", () => {
  async function attemptWithChange(contents: Record<string, string | Buffer>, base: Record<string, string | Buffer> = { "src/a.ts": "one\n" }) {
    const { app } = workspace({ app: base });
    const task = await create("task", "Keep it whole", taskBody());
    await startAttempt(task);
    write(app, contents);
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);
    return { app, task, run, commitObjectId: made, checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1) };
  }

  it("refuses a required file that is not text", async () => {
    const world = await attemptWithChange({ "src/logo.bin": Buffer.from([0x00, 0x01, 0x02, 0x41]) });
    const before = blobCount();
    const error = failed(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        attempt: world.run.attempt,
      }),
    );
    expect(error.message).toMatch(/src\/logo\.bin is not text/);
    expect(blobCount(), "nothing was stored").toBe(before);
    const after = await detail(world.task.entity.entityId);
    expect(after.repositoryLinks.some((row) => row.relation === "verified_at"), "and no link was written").toBe(false);
    expect(after.evidence.some((row) => row.kind === "person_acceptance"), "nor any acceptance evidence").toBe(false);
  });

  it("refuses a required file too big to keep whole", async () => {
    const world = await attemptWithChange({ "src/huge.ts": `${"x".repeat(200 * 1024)}\n` });
    const before = blobCount();
    const error = failed(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        attempt: world.run.attempt,
      }),
    );
    expect(error.message).toMatch(/src\/huge\.ts is \d+ KB/);
    expect(blobCount()).toBe(before);
  });

  it("refuses a required set that does not fit the budget a decision's evidence may use", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 40; i++) big[`src/big-${String(i)}.ts`] = `${"y".repeat(120 * 1024)}\n`;
    const world = await attemptWithChange(big);
    const before = blobCount();
    const error = failed(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        attempt: world.run.attempt,
      }),
    );
    expect(error.message).toMatch(/more than the 4 MB/);
    expect(blobCount()).toBe(before);
  });

  it("refuses more required files than a decision may rest on", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= REQUIRED_PATHS_MAX; i++) many[`src/f-${String(i)}.ts`] = `file ${String(i)}\n`;
    const world = await attemptWithChange(many);
    const before = blobCount();
    const error = failed(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        attempt: world.run.attempt,
      }),
    );
    expect(error.message).toMatch(/at most 100/);
    expect(blobCount()).toBe(before);
  });

  it("refuses when the commit the work started from is gone", async () => {
    const { app } = workspace();
    // Two commits, so the one the attempt starts from can leave the
    // repository without taking the repository's identity with it.
    const root = head(app);
    write(app, { "src/a.ts": "second\n" });
    commit(app, "second");
    const task = await create("task", "Base gone", taskBody());
    await startAttempt(task);
    write(app, { "src/a.ts": "two\n" });
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);
    // History is rewritten back to the root and the base is collected.
    git(app, ["reset", "-q", "--hard", root]);
    prune(app, []);
    const before = blobCount();
    const error = failed(
      await accept({
        subject: task,
        repositoryId: run.repositoryId("app"),
        commitObjectId: made,
        checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1),
        attempt: run.attempt,
      }),
    );
    expect(error.message).toMatch(/started from is not in the repository/);
    expect(blobCount()).toBe(before);
  });
});

// -------------------------------------------------------------- zero change

describe.runIf(haveGit)("a review of code that did not need changing", () => {
  it("keeps the whole named scope, and says that is what it kept", async () => {
    const { app } = workspace({ app: { "src/a.ts": "unchanged\n", "docs/readme.md": "about it\n" } });
    const task = await create("task", "Check what is there", taskBody());
    await startAttempt(task);
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);

    const written = ok<ProjectWorkLinkResult>(
      await accept({
        subject: task,
        repositoryId: run.repositoryId("app"),
        commitObjectId: made,
        checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1),
        attempt: run.attempt,
      }),
    );
    const linkId = linkIdOf(written);
    const capture = await captureOf(task.entity.entityId, linkId);
    expect(capture.required?.basis, "there was no difference, so what is kept is the scope itself").toBe("complete_bounded_state");
    expect(capture.required?.complete).toBe(true);
    expect(requiredPaths(capture)).toEqual(["docs/readme.md", "src/a.ts"]);
    expect(sourceOf(capture, "src/a.ts")).toBe("unchanged\n");

    // And it is still readable once git has forgotten where it came from.
    prune(app, [checkpointRef(checkpointSessionKey(SESSION), 1)]);
    const after = await captureOf(task.entity.entityId, linkId);
    expect(sourceOf(after, "docs/readme.md")).toBe("about it\n");
  });

  /**
   * A repository with more unrelated files than a decision may rest on, plus
   * a small scope somewhere in it. `pad/` sorts before `src/`, so anything
   * that lists the whole tree first and filters to the scope afterwards has
   * already run out of rows before it reaches the part that matters.
   */
  function paddedWorkspace(pads: number, scoped: string[]): string {
    const files: Record<string, string> = {};
    for (let i = 0; i < pads; i++) files[`pad/${String(i).padStart(4, "0")}.ts`] = `pad ${String(i)}\n`;
    for (const path of scoped) files[path] = `scoped ${path}\n`;
    return workspace({ app: files }).app!;
  }

  /** An attempt that changed nothing, and the checkpoint it ends at. */
  async function unchangedAttempt(app: string, title: string) {
    const task = await create("task", title, taskBody());
    await startAttempt(task);
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);
    return { task, run, commitObjectId: made, checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1) };
  }

  it("keeps every file of a scope that sorts past more unrelated files than the cap", async () => {
    // Ninety-nine unrelated files and five that matter: a listing bounded at
    // a hundred and one reaches only the first two of the five, and filtering
    // it to the scope afterwards would store a prefix of the scope while
    // calling it complete (review F1).
    const app = paddedWorkspace(99, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
    const world = await unchangedAttempt(app, "A scope straddling the cap");

    const written = ok<ProjectWorkLinkResult>(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        path: "src",
        attempt: world.run.attempt,
      }),
    );
    const capture = await captureOf(world.task.entity.entityId, linkIdOf(written));
    expect(capture.required?.basis).toBe("complete_bounded_state");
    expect(capture.required?.from.scopePath, "the path the request named reaches the selection").toBe("src");
    expect(requiredPaths(capture), "every file of the scope, not the part that fitted in a whole-tree listing").toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
    ]);
    expect(sourceOf(capture, "src/e.ts")).toBe("scoped src/e.ts\n");
    expect(requiredPaths(capture).some((path) => path.startsWith("pad/")), "and nothing outside it").toBe(false);
  });

  it("keeps a small scope that sorts entirely past the cap, instead of calling it absent", async () => {
    const app = paddedWorkspace(120, ["src/only.ts"]);
    const world = await unchangedAttempt(app, "A scope after the cap");

    const written = ok<ProjectWorkLinkResult>(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        path: "src/only.ts",
        attempt: world.run.attempt,
      }),
    );
    const capture = await captureOf(world.task.entity.entityId, linkIdOf(written));
    expect(requiredPaths(capture)).toEqual(["src/only.ts"]);
    expect(sourceOf(capture, "src/only.ts")).toBe("scoped src/only.ts\n");
  });

  it("refuses a scope with more files than a decision may rest on, without inventing how many", async () => {
    const app = paddedWorkspace(REQUIRED_PATHS_MAX + 20, []);
    const world = await unchangedAttempt(app, "A scope over the cap");
    const before = blobCount();

    const error = failed(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        path: "pad",
        attempt: world.run.attempt,
      }),
    );
    expect(error.message).toMatch(new RegExp(`more than the ${String(REQUIRED_PATHS_MAX)} files`));
    expect(error.message, "the listing stopped at the bound, so it never counted them").not.toMatch(/\b120 files\b/);
    expect(blobCount()).toBe(before);
  });

  it("refuses a scope holding another repository, rather than dropping it from a set that claims to be complete", async () => {
    const { app } = workspace({ app: { "src/a.ts": "unchanged\n" } });
    // An ordinary nested repository, committed before the attempt starts: git
    // records it as a gitlink, whose contents are not in this tree at all.
    initRepo(join(app, "vendor/widget"), { "index.ts": "someone else's code\n" });
    git(app, ["config", "advice.addEmbeddedRepo", "false"]);
    commit(app, "vendor the widget");
    const world = await unchangedAttempt(app, "A scope with a gitlink");
    const before = blobCount();

    const error = failed(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        path: "vendor",
        attempt: world.run.attempt,
      }),
    );
    expect(error.message).toMatch(/vendor\/widget is another repository recorded inside this one/);
    expect(blobCount(), "nothing was stored").toBe(before);
  });

  it("refuses a scope too large to keep whole, and one it cannot read", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= REQUIRED_PATHS_MAX; i++) many[`src/f-${String(i)}.ts`] = `file ${String(i)}\n`;
    const { app } = workspace({ app: many });
    const task = await create("task", "Too much", taskBody());
    await startAttempt(task);
    const made = checkpoint(app, SESSION, 1);
    const run = await endAttempt(task);
    const before = blobCount();
    const error = failed(
      await accept({
        subject: task,
        repositoryId: run.repositoryId("app"),
        commitObjectId: made,
        checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1),
        attempt: run.attempt,
      }),
    );
    expect(error.message).toMatch(/Nothing changed here/);
    expect(error.message).toMatch(/Name the part of the repository/);
    expect(blobCount()).toBe(before);

    // A scope that holds something unreadable is refused for that reason, and
    // not counted as native evidence either way.
    const second = workspace({ app: { "src/a.ts": "text\n", "src/logo.bin": Buffer.from([0x00, 0x41]) } });
    const task2 = await create("task", "Unreadable", taskBody());
    await startAttempt(task2);
    const made2 = checkpoint(second.app!, SESSION, 1);
    const run2 = await endAttempt(task2);
    const unreadable = failed(
      await accept({
        subject: task2,
        repositoryId: run2.repositoryId("app"),
        commitObjectId: made2,
        checkpointId: checkpointRef(checkpointSessionKey(SESSION), 1),
        attempt: run2.attempt,
      }),
    );
    expect(unreadable.message).toMatch(/is not text/);
  });
});

// ------------------------------------------------------------ the other gates

describe.runIf(haveGit)("a gate never rests on a capture that is not whole", () => {
  /**
   * A delivery accepted the ordinary way, plus the one thing a test cannot
   * get from the product: the same link carrying a capture taken **before**
   * every source had to be kept — exactly what a record written by an earlier
   * version of this app looks like.
   */
  async function deliveredWithOldCapture(): Promise<{ app: string; task: ProjectWorkWriteResult; linkId: string; partialBlobId: string }> {
    const { app } = workspace();
    const task = await create("task", "Delivered", taskBody());
    await startAttempt(task);
    const base = head(app);
    write(app, { "src/a.ts": "delivered\n", "src/extra.ts": "more\n" });
    const made = commit(app, "the delivery");
    const run = await endAttempt(task);
    const repositoryId = run.repositoryId("app");
    const repository = { path: app, gitDir: join(app, ".git"), name: "app" };
    const diff = await diffBetween(repository, base, made);
    const change = {
      base: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: base },
      head: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: made },
      diffDigest: diff!.digest,
    };

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
          confirm: true,
        },
        idempotencyKey: idem("accept-delivery"),
      }),
    );
    if (accepted.link.type !== "delivery") throw new Error("unreachable");
    const linkId = accepted.link.links[0]!.linkId;
    const whole = await captureOf(task.entity.entityId, linkId);
    expect(whole.required?.basis, "accepting a delivery is a decision, and rests on every source it touched").toBe("accepted_change");
    expect(requiredPaths(whole)).toEqual(["src/a.ts", "src/extra.ts"]);
    // Completing a Task rests on acceptance evidence as it always has; what is
    // under test here is the capture behind it.
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
          repositoryLinkId: linkId,
        },
        idempotencyKey: idem("acceptance-evidence"),
      }),
    );

    // Now put a pre-rule capture in its place: real, bounded, honest, and not
    // the whole of what the delivery rests on.
    const partial = await buildCapture({ repository, repositoryId, change, now: new Date().toISOString() });
    expect(partial?.required, "the old shape carries no required set at all").toBeUndefined();
    const stored = storeCapture(h.store, { projectId: h.projectId, entityId: task.entity.entityId, capture: partial!, gate: "A test" });
    h.store.attachCapture(h.projectId, linkId, stored.blobId, accepted.link.links[0]!.captureBlobId);
    expect((await captureOf(task.entity.entityId, linkId)).required).toBeUndefined();
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
    return { app, task, linkId, partialBlobId: stored.blobId };
  }

  it("corrects a delivery capture that kept less than the decision rests on, and never erases the one it replaces", async () => {
    const world = await deliveredWithOldCapture();
    ok(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: world.task.entity.entityId,
        expectedRevisionId: world.task.revision.revisionId,
        action: "complete",
        idempotencyKey: idem("complete"),
      }),
    );
    expect((await detail(world.task.entity.entityId)).entity.state).toBe("done");
    const corrected = await captureOf(world.task.entity.entityId, world.linkId);
    expect(corrected.required?.complete, "the completion rests on every source, kept whole").toBe(true);
    expect(requiredPaths(corrected)).toEqual(["src/a.ts", "src/extra.ts"]);
    // The capture it replaced is still in the store under its own address.
    const old = ok<{ data?: string }>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId: world.partialBlobId }));
    expect(old.data, "a correction supersedes; it never deletes").toBeDefined();
  });

  it("refuses to complete when the delivery's sources can no longer be kept", async () => {
    const world = await deliveredWithOldCapture();
    // Everything the change was is gone from git, so the partial capture can
    // no longer be corrected — and a completion does not rest on it.
    git(world.app, ["update-ref", "-d", "refs/heads/main"]);
    prune(world.app, []);
    const before = blobCount();
    const error = failed(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: world.task.entity.entityId,
        expectedRevisionId: world.task.revision.revisionId,
        action: "complete",
        idempotencyKey: idem("complete-refused"),
      }),
    );
    expect(error.message).toMatch(/no longer in the repository|could not be read/);
    expect((await detail(world.task.entity.entityId)).entity.state, "and the task is where it was").not.toBe("done");
    expect(blobCount()).toBe(before);
  });
});

// ------------------------------------------------------- durable, end to end

describe.runIf(haveGit)("evidence that outlives what it came from", () => {
  async function bridge(request: ProjectWorkBridgeParams["request"], extras: Partial<ProjectWorkBridgeParams> = {}): Promise<ProjectWorkBridgeResult> {
    return h.methods.handleBridge({ agent: AGENT, request, ...extras }, { actor: ACTOR, cwd: h.projectRoot });
  }

  function commandRun(command: string): VerificationCommandRun {
    return {
      command,
      status: "passed",
      exitCode: 0,
      startedAt: "2026-03-01T09:00:00.000Z",
      endedAt: "2026-03-01T09:01:00.000Z",
      outputBytes: 3,
      outputDigest: "b".repeat(64),
      tail: "ok\n",
    };
  }

  async function verify(entityId: string, revisionId: string, runId: string): Promise<VerificationReport> {
    const answer = await bridge(
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
          idempotencyKey: idem(`verify-${runId}`),
        },
      },
      {
        verify: {
          action: "report",
          runId,
          startedAt: "2026-03-01T09:00:00.000Z",
          endedAt: "2026-03-01T09:05:00.000Z",
          commands: [commandRun("pnpm test")],
        },
      },
    );
    return answer.verifyResult!.report!;
  }

  it("verifies, records a review, and still finds it after the checkpoint is pruned and collected", async () => {
    const { app } = workspace();
    const task = await create("task", "Visual work", taskBody({ visual: true, commands: ["pnpm test"] }));
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
    await startAttempt(task);
    write(app, { "src/a.ts": "what a person looked at\n" });
    const made = checkpoint(app, SESSION, 1);
    const ref = checkpointRef(checkpointSessionKey(SESSION), 1);
    const run = await endAttempt(task);

    const first = await verify(task.entity.entityId, task.revision.revisionId, "ver_0001");
    const visual = first.criteria.find((criterion) => criterion.kind === "visual")!;
    expect(first.findings.find((finding) => finding.criterionId === visual.id)!.outcome, "nobody has looked at it yet").toBe("needs_person");

    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: made, checkpointId: ref, attempt: run.attempt }),
    );
    const linkId = linkIdOf(written);

    // Retention does its job: the ref goes, and gc takes the parentless commit
    // with it. Everything the acceptance was taken from is gone.
    prune(app, [ref]);
    const status = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        body: { mode: "none" },
        include: { links: true, repositoryStatus: true },
      }),
    ).repositoryStatus?.find((row) => row.linkId === linkId);
    expect(status?.sourceAvailable, "the checkpoint really is gone").toBe(false);

    const current = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" } }),
    );
    const again = await verify(task.entity.entityId, current.revision.revisionId, "ver_0002");
    const finding = again.findings.find((row) => row.criterionId === again.criteria.find((c) => c.kind === "visual")!.id)!;
    expect(finding.outcome, "the review reads back from the store alone").toBe("satisfied");
    expect(finding.repositoryLinkId).toBe(linkId);
    const capture = await captureOf(task.entity.entityId, linkId);
    expect(sourceOf(capture, "src/a.ts"), "including what the person was looking at").toBe("what a person looked at\n");
  });

  /**
   * An acceptance as a database written before D-363 holds one: the proof it
   * rested on is only the link's pointer, because nothing bound the capture
   * into the acceptance itself. Written straight into the store's own file,
   * because that is the one thing the product can no longer produce.
   */
  function asWrittenBeforeCaptureBinding(linkId: string, blobId: string): void {
    const db = new DatabaseSync(join(h.dir, "project-work.db"));
    try {
      const row = db.prepare("SELECT acceptance_json FROM repository_links WHERE link_id = ?").get(linkId) as {
        acceptance_json: string | null;
      };
      const acceptance = row.acceptance_json ? (JSON.parse(row.acceptance_json) as Record<string, unknown>) : undefined;
      if (acceptance) delete acceptance["captureBlobId"];
      db.prepare("UPDATE repository_links SET capture_blob_id = ?, acceptance_json = ? WHERE link_id = ?").run(
        blobId,
        acceptance ? JSON.stringify(acceptance) : null,
        linkId,
      );
      // …and the one association such a database can attest: the baseline a
      // migration would have recorded for the capture it was holding.
      db.prepare("DELETE FROM repository_link_captures WHERE link_id = ?").run(linkId);
      db.prepare(
        "INSERT INTO repository_link_captures (revision_id, project_id, link_id, blob_id, attached_at, seq, reason, actor_json) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        `rlc_legacy_${linkId}`,
        h.projectId,
        linkId,
        blobId,
        new Date().toISOString(),
        1,
        "legacy_baseline",
        JSON.stringify({ kind: "person", label: "Someone" }),
      );
    } finally {
      db.close();
    }
  }

  it("does not call a review native when its capture kept less than it rests on", async () => {
    const { app } = workspace();
    const task = await create("task", "Visual work", taskBody({ visual: true, commands: ["pnpm test"] }));
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
    await startAttempt(task);
    write(app, { "src/a.ts": "looked at\n" });
    const made = checkpoint(app, SESSION, 1);
    const ref = checkpointRef(checkpointSessionKey(SESSION), 1);
    const run = await endAttempt(task);
    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: made, checkpointId: ref, attempt: run.attempt }),
    );
    const linkId = linkIdOf(written);

    // The same acceptance, carrying the capture an earlier version of this app
    // would have kept. Nothing is erased: the link and its acceptance stay
    // exactly as they were, and what changes is what the evaluator can prove.
    const repository = { path: app, gitDir: join(app, ".git"), name: "app" };
    const partial = await buildStateCapture({
      repository,
      repositoryId: run.repositoryId("app"),
      state: { vcs: "git", objectFormat: "sha1", commitObjectId: made, checkpointId: ref },
      now: new Date().toISOString(),
    });
    const stored = storeCapture(h.store, { projectId: h.projectId, entityId: task.entity.entityId, capture: partial!, gate: "A test" });
    asWrittenBeforeCaptureBinding(linkId, stored.blobId);

    const current = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" } }),
    );
    const report = await verify(task.entity.entityId, current.revision.revisionId, "ver_0003");
    const finding = report.findings.find((row) => row.criterionId === report.criteria.find((c) => c.kind === "visual")!.id)!;
    expect(finding.outcome).toBe("needs_person");
    expect(finding.detail, "and the report says what to do about it").toMatch(/did not keep every file it rests on/);
    expect(
      (await detail(task.entity.entityId)).repositoryLinks.find((row) => row.linkId === linkId)?.acceptance,
      "the record of what the person did is untouched",
    ).toBeDefined();

    // And correcting what the link points at does not retroactively make that
    // acceptance native: a person looked at a preview backed by the capture
    // above, and a capture attached afterwards is not what they looked at
    // (D-363).
    const whole = await buildStateCapture({
      repository,
      repositoryId: run.repositoryId("app"),
      state: { vcs: "git", objectFormat: "sha1", commitObjectId: made, checkpointId: ref },
      now: new Date().toISOString(),
      required: { basis: "attempt_base_to_state", base: run.base("app"), executionLinkId: run.attempt.executionLinkId, taskEntityId: task.entity.entityId },
    });
    const corrected = storeCapture(h.store, { projectId: h.projectId, entityId: task.entity.entityId, capture: whole!, gate: "A test" });
    expect(h.store.attachCapture(h.projectId, linkId, corrected.blobId, stored.blobId, { gate: "A later correction" })).toBe(true);

    const afterwards = await verify(task.entity.entityId, current.revision.revisionId, "ver_0004");
    const later = afterwards.findings.find((row) => row.criterionId === afterwards.criteria.find((c) => c.kind === "visual")!.id)!;
    expect(later.outcome, "the pointer moved; what the person accepted did not").toBe("needs_person");
    const history = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        body: { mode: "none" },
        include: { links: true, captureHistory: true },
      }),
    ).captureHistory!.filter((row) => row.linkId === linkId);
    expect(history.map((row) => row.blobId), "and both associations are readable, newest first").toEqual([
      corrected.blobId,
      stored.blobId,
    ]);
    expect(history[0]?.supersedesBlobId).toBe(stored.blobId);
  });
});

// ------------------------------------------- the capture proves *this* link

/**
 * Review F2: a capture that is internally consistent is not therefore a
 * capture of the link it hangs off. Everything here builds **real** captures
 * out of **real** repositories and checks them against what the persisted
 * record says they must be — the same authority the evaluator, the gates and
 * the delivery door ask.
 */
describe.runIf(haveGit)("what a capture has to say about the link it proves", () => {
  async function attemptOn(app: string, title: string, targetId = "run_1", session = SESSION) {
    const task = await create("task", title, taskBody());
    await startAttempt(task, targetId);
    write(app, { "src/a.ts": `built by ${targetId}\n` });
    const made = checkpoint(app, session, 1);
    const run = await endAttempt(task, targetId);
    return { task, run, commitObjectId: made, checkpointId: checkpointRef(checkpointSessionKey(session), 1) };
  }

  function repositoryAt(path: string): { path: string; gitDir: string; name: string } {
    return { path, gitDir: join(path, ".git"), name: "app" };
  }

  /** The `verified_at` link one acceptance wrote, straight out of the record. */
  async function acceptedLink(entityId: string, written: ProjectWorkLinkResult) {
    const linkId = linkIdOf(written);
    const link = (await detail(entityId)).repositoryLinks.find((row) => row.linkId === linkId)!;
    return link;
  }

  it("refuses a capture of another repository, another state or another scope", async () => {
    const { app, lib } = workspace({ app: { "src/a.ts": "one\n" }, lib: { "src/a.ts": "one\n" } }) as { app: string; lib: string };
    const task = await create("task", "Two repositories", taskBody());
    await startAttempt(task);
    write(app, { "src/a.ts": "app changed\n" });
    write(lib, { "src/a.ts": "lib changed\n" });
    const appCommit = checkpoint(app, SESSION, 1);
    const libCommit = checkpoint(lib, SESSION, 1);
    const run = await endAttempt(task);
    const ref = checkpointRef(checkpointSessionKey(SESSION), 1);

    const written = ok<ProjectWorkLinkResult>(
      await accept({ subject: task, repositoryId: run.repositoryId("app"), commitObjectId: appCommit, checkpointId: ref, attempt: run.attempt }),
    );
    const link = await acceptedLink(task.entity.entityId, written);
    const expected = expectedRequiredFacts(h.store, h.projectId, link);
    const mine = await captureOf(task.entity.entityId, link.linkId);
    expect(requiredComplete(mine, expected), "its own capture proves it").toBe(true);

    // The other repository's capture: complete, honest, and about something
    // else entirely.
    const foreign = await buildStateCapture({
      repository: repositoryAt(lib),
      repositoryId: run.repositoryId("lib"),
      state: { vcs: "git", objectFormat: "sha1", commitObjectId: libCommit, checkpointId: ref },
      now: new Date().toISOString(),
      required: { basis: "attempt_base_to_state", base: run.base("lib"), executionLinkId: run.attempt.executionLinkId, taskEntityId: task.entity.entityId },
    });
    expect(requiredComplete(foreign!, expected), "another repository's proof is not this link's").toBe(false);

    // The same repository, a checkpoint ref this link does not name.
    write(app, { "src/a.ts": "later\n" });
    const laterCommit = checkpoint(app, SESSION, 2);
    const laterRef = checkpointRef(checkpointSessionKey(SESSION), 2);
    const elsewhere = await buildStateCapture({
      repository: repositoryAt(app),
      repositoryId: run.repositoryId("app"),
      state: { vcs: "git", objectFormat: "sha1", commitObjectId: laterCommit, checkpointId: laterRef },
      now: new Date().toISOString(),
      required: { basis: "attempt_base_to_state", base: run.base("app"), executionLinkId: run.attempt.executionLinkId, taskEntityId: task.entity.entityId },
    });
    expect(requiredComplete(elsewhere!, expected), "another state's proof is not this state's").toBe(false);

    // A capture of a path this link never named.
    const scoped = await buildStateCapture({
      repository: repositoryAt(app),
      repositoryId: run.repositoryId("app"),
      state: { vcs: "git", objectFormat: "sha1", commitObjectId: appCommit, checkpointId: ref, path: "src" },
      now: new Date().toISOString(),
      required: { basis: "attempt_base_to_state", base: run.base("app"), executionLinkId: run.attempt.executionLinkId, taskEntityId: task.entity.entityId },
    });
    expect(requiredComplete(scoped!, expected), "a capture of a scope this link does not name").toBe(false);
  });

  it("tells two attempts that share one commit apart by where the work started", async () => {
    const { app } = workspace();
    // Two attempts that started from different commits, and one state both of
    // their records can name: what separates them is `from`, and nothing else.
    const first = await attemptOn(app, "First attempt");
    commit(app, "the first attempt's work, committed");
    const second = await create("task", "Second attempt", taskBody());
    await startAttempt(second, "run_2");
    write(app, { "src/b.ts": "the second attempt's work\n" });
    checkpoint(app, SESSION, 2);
    const secondRun = await endAttempt(second, "run_2");

    const written = ok<ProjectWorkLinkResult>(
      await accept({
        subject: first.task,
        repositoryId: first.run.repositoryId("app"),
        commitObjectId: first.commitObjectId,
        checkpointId: first.checkpointId,
        attempt: first.run.attempt,
      }),
    );
    const link = await acceptedLink(first.task.entity.entityId, written);
    const expected = expectedRequiredFacts(h.store, h.projectId, link);
    expect(requiredComplete(await captureOf(first.task.entity.entityId, link.linkId), expected)).toBe(true);
    expect(secondRun.base("app"), "the second attempt started where the first one ended").not.toBe(first.run.base("app"));

    // The same state, captured as if it came out of the *other* attempt: same
    // commit, same ref, same bodies, different `from`.
    const otherAttempt = await buildStateCapture({
      repository: repositoryAt(app),
      repositoryId: first.run.repositoryId("app"),
      state: { vcs: "git", objectFormat: "sha1", commitObjectId: first.commitObjectId, checkpointId: first.checkpointId },
      now: new Date().toISOString(),
      required: {
        basis: "attempt_base_to_state",
        base: secondRun.base("app"),
        executionLinkId: secondRun.attempt.executionLinkId,
        taskEntityId: second.entity.entityId,
      },
    });
    expect(otherAttempt?.state?.commitObjectId, "the same commit, to the letter").toBe(first.commitObjectId);
    expect(requiredComplete(otherAttempt!, expected), "and still not this link's proof").toBe(false);
  });

  it("refuses a basis the link's shape does not allow", async () => {
    const { app } = workspace();
    const world = await attemptOn(app, "A state, not a change");
    const written = ok<ProjectWorkLinkResult>(
      await accept({
        subject: world.task,
        repositoryId: world.run.repositoryId("app"),
        commitObjectId: world.commitObjectId,
        checkpointId: world.checkpointId,
        attempt: world.run.attempt,
      }),
    );
    const link = await acceptedLink(world.task.entity.entityId, written);
    const stateCapture = await captureOf(world.task.entity.entityId, link.linkId);

    // The same project, a link of the other shape: a change is proved by
    // `accepted_change`, and a state capture is not a proof of it however
    // complete it is.
    const change = {
      base: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: world.run.base("app") },
      head: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: world.commitObjectId },
      diffDigest: "a".repeat(64),
    };
    const asChange = expectedRequiredFacts(h.store, h.projectId, {
      repositoryId: world.run.repositoryId("app"),
      target: { change },
    });
    expect(requiredComplete(stateCapture, asChange)).toBe(false);
  });

  it("refuses a delivery whose attempt this project cannot read it against", async () => {
    const { app } = workspace();
    const task = await create("task", "Delivered", taskBody());
    await startAttempt(task);
    const base = head(app);
    write(app, { "src/a.ts": "delivered\n" });
    const made = commit(app, "the delivery");
    const run = await endAttempt(task);
    const diff = await diffBetween(repositoryAt(app), base, made);
    const before = blobCount();

    const error = failed(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "delivery",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          repositoryId: run.repositoryId("app"),
          change: {
            base: { vcs: "git", objectFormat: "sha1", commitObjectId: base },
            head: { vcs: "git", objectFormat: "sha1", commitObjectId: made },
            diffDigest: diff!.digest,
          },
          executionLinkId: "lnk_not_in_this_project",
          confirm: true,
        },
        idempotencyKey: idem("foreign-attempt"),
      }),
    );
    expect(error.message).toMatch(/not one this project has/);
    expect(blobCount(), "and nothing was stored for it").toBe(before);

    // The same delivery, naming its own attempt, is accepted and proved.
    const accepted = ok<ProjectWorkLinkResult>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "delivery",
          entityId: task.entity.entityId,
          revisionId: task.revision.revisionId,
          repositoryId: run.repositoryId("app"),
          change: {
            base: { vcs: "git", objectFormat: "sha1", commitObjectId: base },
            head: { vcs: "git", objectFormat: "sha1", commitObjectId: made },
            diffDigest: diff!.digest,
          },
          executionLinkId: run.attempt.executionLinkId,
          confirm: true,
        },
        idempotencyKey: idem("own-attempt"),
      }),
    );
    if (accepted.link.type !== "delivery") throw new Error("unreachable");
    const linkId = accepted.link.links[0]!.linkId;
    const link = (await detail(task.entity.entityId)).repositoryLinks.find((row) => row.linkId === linkId)!;
    const capture = await captureOf(task.entity.entityId, linkId);
    expect(requiredComplete(capture, expectedRequiredFacts(h.store, h.projectId, link))).toBe(true);
    expect(capture.required?.from.taskEntityId, "joined to the task the attempt belongs to").toBe(task.entity.entityId);
  });
});
