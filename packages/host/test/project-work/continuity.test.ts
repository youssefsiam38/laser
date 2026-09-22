/**
 * Cross-session continuity and recovery (M21-T20).
 *
 * The acceptance is a story, not a unit: a Spec created in one conversation,
 * revised in a second, executed in a third, read back after the host restarts
 * and after the worker that ran it is gone, with the conversations archived,
 * deleted, the project removed and the folder moved — and every identity still
 * exactly what it was.
 *
 * So the tests here run the story: real git repositories in temp directories,
 * the real store on a real file that is closed and reopened, the router a
 * person's app talks to and the bridge a model's tools talk through. The rules
 * being checked — that a moved folder reconnects the same `projectId`, that a
 * copied one never merges two histories, that removing a worktree retargets
 * nothing, that deleting a conversation cascades into nothing — are precisely
 * the ones a mock would assume away.
 */
import {
  PRODUCT_NAME,
  PROJECT_DIR_NAME,
  WORKTREES_DIR_NAME,
  type ExecutionLink,
  type ProjectIdentityResult,
  type ProjectRelinkResult,
  type ProjectTaskLinkExecutionResult,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkGetResult,
  type ProjectWorkLinkResult,
  type ProjectWorkListResult,
  type ProjectWorkWriteResult,
} from "@lasercode/protocol";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody, taskBody } from "./fixtures.js";
import { checkpoint, git, haveGit, head, initRepo, write } from "./git-fixtures.js";

let h: ProjectWorkHarness;
const dirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const SESSION_A = { id: "ses_a", path: "/sessions/ses_a.jsonl" };
const SESSION_B = { id: "ses_b", path: "/sessions/ses_b.jsonl" };
const SESSION_C = { id: "ses_c", path: "/sessions/ses_c.jsonl" };

function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-${label}-`));
  dirs.push(dir);
  return dir;
}

/** A host whose one project folder really exists, with one real repository. */
function project(options: { dir?: string; sessions?: Array<{ path: string; id: string; cwd: string }> } = {}): {
  root: string;
  repo: string;
} {
  const dir = options.dir ?? temp("continuity");
  const root = join(dir, "alpha");
  mkdirSync(root, { recursive: true });
  h = projectWorkHarness({ dir, ...(options.sessions ? { sessions: options.sessions } : {}) });
  const repo = join(root, "app");
  if (!existsSync(join(repo, ".git"))) initRepo(repo, { "src/a.ts": "one\n" });
  return { root, repo };
}

/** Reopen the same host over the same files: a restart, not a new machine. */
function restart(): void {
  const dir = h.dir;
  const sessions = [SESSION_A, SESSION_B, SESSION_C].map((session) => ({ ...session, cwd: h.projectRoot }));
  h.cleanup();
  h = projectWorkHarness({ dir, sessions });
}

async function bridge(
  request: ProjectWorkBridgeParams["request"],
  extras: Partial<ProjectWorkBridgeParams> = {},
  cwd = h.projectRoot,
): Promise<ProjectWorkBridgeResult> {
  return h.methods.handleBridge({ request, ...extras }, { actor: ACTOR, cwd });
}

const markerFile = (root: string) => join(root, PROJECT_DIR_NAME, "project.json");
const markerId = (root: string) => JSON.parse(readFileSync(markerFile(root), "utf8")) as { version: number; projectId: string };

async function identity(cwd: string): Promise<ProjectIdentityResult> {
  return ok<ProjectIdentityResult>(await h.call("project/work/identity", { cwd }));
}

// ---------------------------------------------------------------------------
// One Spec, three conversations, one restart
// ---------------------------------------------------------------------------

describe.runIf(haveGit)("work outlives the conversations it was made in", () => {
  it("is created in one session, revised in a second, executed in a third and read back after a restart", async () => {
    const { root, repo } = project({
      sessions: [SESSION_A, SESSION_B, SESSION_C].map((session) => ({ ...session, cwd: join("x", "alpha") })),
    });
    expect(h.projectRoot).toBe(root);

    // Session A writes the Spec.
    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "Phone review",
        body: specBody(),
        origin: { actor: { kind: "person", label: "You" }, sessionId: SESSION_A.id },
        idempotencyKey: "spec-create",
      }),
    );

    // Session B revises it. Nothing about session A is needed for that.
    const revised = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("Reviewing on a phone, offline."),
        origin: { actor: { kind: "person", label: "You" }, sessionId: SESSION_B.id },
        idempotencyKey: "spec-revise",
      }),
    );
    expect(revised.revision.parentRevisionId).toBe(spec.revision.revisionId);

    // Session C executes a Task against it, through the worker bridge.
    const task = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "task",
        title: "Sticky footer",
        body: taskBody(),
        origin: { actor: { kind: "person", label: "You" }, sessionId: SESSION_B.id },
        idempotencyKey: "task-create",
      }),
    );
    const base = head(repo);
    const started = (
      await bridge(
        {
          method: "project/task/link-execution",
          params: {
            projectId: h.projectId,
            entityId: task.entity.entityId,
            expectedRevisionId: task.revision.revisionId,
            execution: { kind: "session", targetId: SESSION_C.id, sessionPath: SESSION_C.path },
            idempotencyKey: "attempt-start",
          },
        },
        { agent: { label: "Builder", sessionId: SESSION_C.id } },
      )
    ).result as ProjectTaskLinkExecutionResult;
    expect(started.link.attempt).toBe(1);

    write(repo, { "src/a.ts": "two\n" });
    const made = checkpoint(repo, SESSION_C.path, 1);
    const ended = (
      await bridge(
        {
          method: "project/task/link-execution",
          params: {
            projectId: h.projectId,
            entityId: task.entity.entityId,
            expectedRevisionId: task.revision.revisionId,
            execution: { kind: "session", targetId: SESSION_C.id, outcome: "completed", sessionPath: SESSION_C.path },
            idempotencyKey: "attempt-end",
          },
        },
        { agent: { label: "Builder", sessionId: SESSION_C.id } },
      )
    ).result as ProjectTaskLinkExecutionResult;
    const record = ended.link.repositories?.find((row) => row.name === "app");
    expect(record?.base.commitObjectId).toBe(base);
    expect(record?.checkpoints.map((row) => row.commitObjectId)).toEqual([made]);

    const before = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        body: { mode: "none" },
        include: { links: true, evidence: true, history: true },
      }),
    );
    const specBefore = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, body: { mode: "full" }, include: { history: true } }),
    );

    // --- the host restarts: a new store over the same file -----------------
    const projectIdBefore = h.projectId;
    restart();
    expect(h.store.projectIdFor(root, { create: false })).toBe(projectIdBefore);

    const after = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: projectIdBefore,
        entityId: task.entity.entityId,
        body: { mode: "none" },
        include: { links: true, evidence: true, history: true },
      }),
    );
    expect(after.executionLinks).toEqual(before.executionLinks);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.entity).toEqual(before.entity);

    const specAfter = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: projectIdBefore, entityId: spec.entity.entityId, body: { mode: "full" }, include: { history: true } }),
    );
    expect(specAfter.revision).toEqual(specBefore.revision);
    expect(specAfter.body).toEqual(specBefore.body);
    // The conversation each revision was written in is provenance that
    // survives the restart — and it is the only thing a session ever owns.
    expect([...(specAfter.history ?? [])].map((row) => row.origin.sessionId).sort()).toEqual([SESSION_A.id, SESSION_B.id]);
  });

  it("lets a second worker continue the same Task after the first one is retired", async () => {
    const { repo } = project();
    const task = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "task",
        title: "Sticky footer",
        body: taskBody(),
        idempotencyKey: "task-create",
      }),
    );
    for (const [turn, session] of [SESSION_B, SESSION_C].entries()) {
      await bridge(
        {
          method: "project/task/link-execution",
          params: {
            projectId: h.projectId,
            entityId: task.entity.entityId,
            expectedRevisionId: task.revision.revisionId,
            execution: { kind: "session", targetId: session.id, sessionPath: session.path },
            idempotencyKey: `start-${session.id}`,
          },
        },
        { agent: { label: "Builder", sessionId: session.id } },
      );
      write(repo, { "src/a.ts": `turn ${String(turn)}\n` });
      checkpoint(repo, session.path, turn + 1);
      await bridge(
        {
          method: "project/task/link-execution",
          params: {
            projectId: h.projectId,
            entityId: task.entity.entityId,
            expectedRevisionId: task.revision.revisionId,
            execution: { kind: "session", targetId: session.id, outcome: "completed", sessionPath: session.path },
            idempotencyKey: `end-${session.id}`,
          },
        },
        { agent: { label: "Builder", sessionId: session.id } },
      );
    }

    // Two attempts, each with its own identity: the second worker added to the
    // record rather than taking over the first one's row.
    const read = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" }, include: { links: true } }),
    );
    expect(read.executionLinks.map((link) => link.attempt)).toEqual([1, 2]);
    expect(new Set(read.executionLinks.map((link) => link.targetId))).toEqual(new Set([SESSION_B.id, SESSION_C.id]));
    expect(read.entity.state, "a run ending never completes a Task").toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// Deleting and archiving conversations
// ---------------------------------------------------------------------------

describe.runIf(haveGit)("deleting a conversation never deletes project work", () => {
  async function taskWithAttempt(): Promise<{ taskId: string; links: ExecutionLink[] }> {
    const task = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "task", title: "Sticky footer", body: taskBody(), idempotencyKey: "task" }),
    );
    for (const session of [SESSION_B, SESSION_C]) {
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "session", targetId: session.id, sessionPath: session.path },
        idempotencyKey: `start-${session.id}`,
      });
    }
    const read = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" }, include: { links: true } }),
    );
    return { taskId: task.entity.entityId, links: read.executionLinks };
  }

  it("marks the links of a deleted conversation unavailable and keeps every one of them", async () => {
    const dir = temp("continuity");
    const sessionFile = join(dir, "ses_c.jsonl");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SESSION_C.id, cwd: join(dir, "alpha"), timestamp: "2026-01-01T00:00:00Z" })}\n`);
    project({ dir, sessions: [{ path: sessionFile, id: SESSION_C.id, cwd: join(dir, "alpha") }] });
    const { taskId, links } = await taskWithAttempt();
    expect(links.every((link) => link.targetUnavailable === undefined)).toBe(true);

    ok(await h.call("pi/session/delete", { path: sessionFile }));
    expect(existsSync(sessionFile), "the conversation itself is gone").toBe(false);

    const after = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: taskId, body: { mode: "none" }, include: { links: true } }),
    );
    // Every link is still there, with its identity: only the one that named
    // the deleted conversation now says the conversation is gone.
    expect(after.executionLinks.map((link) => link.linkId).sort()).toEqual(links.map((link) => link.linkId).sort());
    const gone = after.executionLinks.find((link) => link.targetId === SESSION_C.id)!;
    const kept = after.executionLinks.find((link) => link.targetId === SESSION_B.id)!;
    expect(gone.targetUnavailable).toBe(true);
    expect(gone.attempt).toBe(links.find((link) => link.targetId === SESSION_C.id)!.attempt);
    expect(kept.targetUnavailable).toBeUndefined();

    // And the Task itself is untouched: no cascade, no state change.
    expect(after.entity.state).toBe("draft");
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items).toHaveLength(1);
  });

  it("leaves an archived conversation's links exactly as they were", async () => {
    // Archiving is a device-local hide (`pi/session/list { page.exclude }`):
    // the conversation is still on disk, so its attempts are still openable
    // and nothing may mark them gone.
    const dir = temp("continuity");
    const sessionFile = join(dir, "ses_c.jsonl");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SESSION_C.id, cwd: join(dir, "alpha"), timestamp: "2026-01-01T00:00:00Z" })}\n`);
    project({ dir, sessions: [{ path: sessionFile, id: SESSION_C.id, cwd: join(dir, "alpha") }] });
    const { taskId } = await taskWithAttempt();

    ok(await h.call("pi/session/list", { page: { size: 5, exclude: [sessionFile] } }));

    const after = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: taskId, body: { mode: "none" }, include: { links: true } }),
    );
    expect(after.executionLinks.every((link) => link.targetUnavailable === undefined)).toBe(true);
    expect(existsSync(sessionFile)).toBe(true);
  });

  it("marks nothing for a folder this app keeps no work for", () => {
    project();
    const unknown = temp("elsewhere");
    expect(h.methods.sessionDeleted({ cwd: unknown, sessionId: SESSION_C.id })).toEqual({ links: 0 });
    expect(h.store.projectIdFor(unknown, { create: false }), "a delete never mints an identity").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Removing the project
// ---------------------------------------------------------------------------

describe("removing a project hides its work and keeps it", () => {
  it("hides on remove, says so, and shows it again when the project is added back", async () => {
    const { root } = project();
    ok(
      await h.call("project/work/create", { projectId: h.projectId, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "spec" }),
    );

    ok(await h.call("pi/project/remove", { cwd: root }));
    expect(h.store.isRemoved(h.projectId)).toBe(true);
    const hidden = await identity(root);
    expect(hidden.hidden).toBe(true);
    expect(hidden.detail).toContain("kept and hidden until you delete it");
    // Hidden, never deleted: the work is all still readable.
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId })).items).toHaveLength(1);

    ok(await h.call("pi/project/add", { cwd: root }));
    expect(h.store.isRemoved(h.projectId)).toBe(false);
    expect((await identity(root)).hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moving the folder
// ---------------------------------------------------------------------------

describe.runIf(haveGit)("a project keeps its identity when its folder moves", () => {
  it("writes a marker when it mints an id, and reconnects the same project from the new folder", async () => {
    const { root, repo } = project();
    expect(markerId(root)).toEqual({ version: 1, projectId: h.projectId });

    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "spec" }),
    );
    const task = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "task", title: "Sticky footer", body: taskBody(), idempotencyKey: "task" }),
    );
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "session", targetId: SESSION_C.id, sessionPath: SESSION_C.path },
      idempotencyKey: "attempt",
    });
    checkpoint(repo, SESSION_C.path, 1);
    write(repo, { "src/a.ts": "two\n" });
    checkpoint(repo, SESSION_C.path, 2);
    const ended = ok<ProjectTaskLinkExecutionResult>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "session", targetId: SESSION_C.id, outcome: "completed", sessionPath: SESSION_C.path },
        idempotencyKey: "attempt-end",
      }),
    );
    const repositoryId = ended.link.repositories?.find((row) => row.name === "app")?.repositoryId;
    const change = ended.link.repositories?.find((row) => row.name === "app")?.change;
    expect(repositoryId).toBeDefined();
    const delivery = ok<ProjectWorkLinkResult>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: spec.revision.revisionId,
        link: {
          type: "delivery",
          entityId: spec.entity.entityId,
          revisionId: spec.revision.revisionId,
          repositoryId: repositoryId!,
          change: change!,
          confirm: true,
        },
        idempotencyKey: "delivery",
      }),
    );
    const linkBefore = delivery.link.type === "delivery" ? delivery.link.links[0] : undefined;
    expect(linkBefore?.relation).toBe("implemented_by");

    // --- the person moves the whole folder ---------------------------------
    const moved = join(h.dir, "moved-alpha");
    renameSync(root, moved);
    expect(existsSync(root)).toBe(false);

    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: moved }));
    expect(list.projectId, "the same project, not a new empty one").toBe(h.projectId);
    expect(list.items.map((item) => item.key).sort()).toEqual(["SPEC-1", "TASK-1"]);

    const after = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, body: { mode: "none" }, include: { links: true } }),
    );
    const linkAfter = after.repositoryLinks.find((link) => link.linkId === linkBefore!.linkId)!;
    // Commit ids and digests are identity: a move is not a retarget (D-345).
    expect(linkAfter).toEqual(linkBefore);
    expect(h.store.repositories(h.projectId).map((row) => row.repositoryId)).toEqual([repositoryId]);

    // A new attempt in the moved folder joins the same repository identity.
    write(join(moved, "app"), { "src/a.ts": "three\n" });
    const again = ok<ProjectTaskLinkExecutionResult>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "session", targetId: SESSION_B.id, sessionPath: SESSION_B.path },
        idempotencyKey: "attempt-moved",
      }),
    );
    expect(again.link.repositories?.find((row) => row.name === "app")?.repositoryId).toBe(repositoryId);
    void repo;
  });

  it("reconnects nothing by path alone: an unmarked folder at the old place is its own project", async () => {
    const { root } = project();
    const first = h.projectId;
    ok(await h.call("project/work/create", { projectId: first, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "spec" }));

    const moved = join(h.dir, "moved-alpha");
    renameSync(root, moved);
    ok(await h.call("project/work/list", { cwd: moved }));

    // Something else is put at the old path. It shares the path and nothing
    // else, so it is its own empty project — a path match never merges.
    mkdirSync(root, { recursive: true });
    const fresh = ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: root }));
    expect(fresh.projectId).not.toBe(first);
    expect(fresh.items).toHaveLength(0);
  });

  it("offers a choice rather than merging when a copy of the folder is opened", async () => {
    const { root } = project();
    const original = h.projectId;
    ok(await h.call("project/work/create", { projectId: original, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "spec" }));

    const copy = join(h.dir, "alpha-copy");
    cpSync(root, copy, { recursive: true });

    const state = await identity(copy);
    expect(state.state).toBe("conflict");
    expect(state.projectId).not.toBe(original);
    expect(state.marked?.projectId).toBe(original);
    expect(state.marked?.entities).toBe(1);
    expect(state.here.entities).toBe(0);
    expect(state.choices).toEqual(["reconnect", "fresh"]);
    expect(state.detail).toContain("still here too");
    // Nothing was merged while the question stands.
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: copy })).items).toHaveLength(0);
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: root })).items).toHaveLength(1);

    // Reconnecting moves the folder, drops the empty project it had been
    // given, and stops the folder it was copied from being this project.
    const relinked = ok<ProjectRelinkResult>(
      await h.call("project/work/relink", {
        cwd: copy,
        choice: "reconnect",
        projectId: original,
        previewDigest: state.previewDigest,
        confirm: true,
        idempotencyKey: "relink-1",
      }),
    );
    expect(relinked.projectId).toBe(original);
    expect(relinked.discardedEmpty).toBe(true);
    expect(markerId(copy).projectId).toBe(original);
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: copy })).items).toHaveLength(1);
    expect(h.store.projectIdFor(root, { create: false }), "the folder it was copied from is no longer this project").toBeUndefined();
  });

  it("refuses a stale choice and a choice this folder does not have", async () => {
    const { root } = project();
    const original = h.projectId;
    ok(await h.call("project/work/create", { projectId: original, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "spec" }));
    const copy = join(h.dir, "alpha-copy");
    cpSync(root, copy, { recursive: true });
    const state = await identity(copy);

    expect(
      failed(
        await h.call("project/work/relink", {
          cwd: copy,
          choice: "reconnect",
          projectId: original,
          previewDigest: "b".repeat(64),
          confirm: true,
          idempotencyKey: "stale",
        }),
      ).message,
    ).toMatch(/changed since you were shown/);

    // The folder this one was copied from has nothing to reconnect to.
    expect(
      failed(
        await h.call("project/work/relink", {
          cwd: root,
          choice: "reconnect",
          projectId: original,
          previewDigest: (await identity(root)).previewDigest,
          confirm: true,
          idempotencyKey: "nothing",
        }),
      ).message,
    ).toMatch(/already part of the project/);

    // Starting fresh keeps the two apart and stops the question.
    const fresh = ok<ProjectRelinkResult>(
      await h.call("project/work/relink", {
        cwd: copy,
        choice: "fresh",
        projectId: state.projectId,
        previewDigest: state.previewDigest,
        confirm: true,
        idempotencyKey: "fresh-1",
      }),
    );
    expect(fresh.projectId).toBe(state.projectId);
    expect(markerId(copy).projectId).toBe(state.projectId);
    expect((await identity(copy)).state).toBe("linked");
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: root })).items).toHaveLength(1);
  });

  it("never pulls a folder that already has work of its own into another history", async () => {
    const { root } = project();
    const original = h.projectId;
    ok(await h.call("project/work/create", { projectId: original, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "spec" }));
    const copy = join(h.dir, "alpha-copy");
    cpSync(root, copy, { recursive: true });
    // The copy is opened and worked in before anybody answers the question.
    const copyId = ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: copy })).projectId;
    ok(await h.call("project/work/create", { projectId: copyId, kind: "task", title: "Sticky footer", body: taskBody(), idempotencyKey: "task" }));

    const state = await identity(copy);
    expect(state.state).toBe("blocked");
    expect(state.choices).toEqual(["fresh"]);
    expect(state.detail).toContain("merge two histories");
    expect(
      failed(
        await h.call("project/work/relink", {
          cwd: copy,
          choice: "reconnect",
          projectId: original,
          previewDigest: state.previewDigest,
          confirm: true,
          idempotencyKey: "merge",
        }),
      ).message,
    ).toMatch(/merge two histories/);
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: copy })).items).toHaveLength(1);
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: root })).items).toHaveLength(1);
  });

  it("adopts the id a folder already carries when this app has never seen it", async () => {
    const dir = temp("continuity");
    const root = join(dir, "alpha");
    mkdirSync(join(root, PROJECT_DIR_NAME), { recursive: true });
    writeFileSync(markerFile(root), `${JSON.stringify({ version: 1, projectId: "prj_fromElsewhere1" }, null, 2)}\n`);
    h = projectWorkHarness({ dir });

    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: root }));
    expect(list.projectId, "the folder keeps the identity it carries").toBe("prj_fromElsewhere1");
    // And the file is left exactly as it was: nobody's marker is rewritten.
    expect(markerId(root).projectId).toBe("prj_fromElsewhere1");
  });

  it("works, and says so, when the folder cannot be written", async () => {
    const dir = temp("continuity");
    h = projectWorkHarness({ dir });
    // A folder that is not there at all is the simplest unwritable folder.
    const absent = join(dir, "not-here");
    const state = ok<ProjectIdentityResult>(await h.call("project/work/identity", { cwd: absent }));
    expect(state.state).toBe("unmarked");
    expect(state.marker).toBe(false);
    expect(state.detail).toContain("could not be written");
    expect(state.choices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

describe.runIf(haveGit)("a worktree is the project's, and removing it retargets nothing", () => {
  it("resolves to the owner project and keeps every recorded commit after the worktree is gone", async () => {
    const { root, repo } = project();
    const task = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "task", title: "Sticky footer", body: taskBody(), idempotencyKey: "task" }),
    );

    // An agent run's own checkout, exactly where the product puts one.
    const worktree = join(root, WORKTREES_DIR_NAME, "run-1");
    git(repo, ["worktree", "add", "-q", "-b", "agents/run-1", worktree]);

    // A session in the worktree sees the owner project's work, not a new one.
    const seen = ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: worktree }));
    expect(seen.projectId).toBe(h.projectId);
    expect(seen.items.map((item) => item.key)).toEqual(["TASK-1"]);
    expect(existsSync(join(worktree, PROJECT_DIR_NAME, "project.json")), "a worktree never gets a marker of its own").toBe(false);

    // The attempt runs there and records what git says it did.
    await bridge(
      {
        method: "project/task/link-execution",
        params: {
          projectId: h.projectId,
          entityId: task.entity.entityId,
          expectedRevisionId: task.revision.revisionId,
          execution: { kind: "agent_run", targetId: "run_1", sessionPath: SESSION_C.path },
          idempotencyKey: "start",
        },
      },
      { agent: { label: "Builder", runId: "run_1" }, attempt: { workspace: "worktree", checkout: worktree, sessionPath: SESSION_C.path } },
      worktree,
    );
    write(worktree, { "src/a.ts": "from the worktree\n" });
    checkpoint(worktree, SESSION_C.path, 1);
    const ended = (
      await bridge(
        {
          method: "project/task/link-execution",
          params: {
            projectId: h.projectId,
            entityId: task.entity.entityId,
            expectedRevisionId: task.revision.revisionId,
            execution: { kind: "agent_run", targetId: "run_1", outcome: "completed", sessionPath: SESSION_C.path },
            idempotencyKey: "end",
          },
        },
        { agent: { label: "Builder", runId: "run_1" }, attempt: { workspace: "worktree", checkout: worktree, sessionPath: SESSION_C.path } },
        worktree,
      )
    ).result as ProjectTaskLinkExecutionResult;
    const recorded = ended.link.repositories?.find((row) => row.checkpoints.length > 0);
    expect(recorded, "the attempt recorded the repository it worked in").toBeDefined();
    const before = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" }, include: { links: true } }),
    );

    // --- the worktree is removed ------------------------------------------
    git(repo, ["worktree", "remove", "--force", worktree]);
    expect(existsSync(worktree)).toBe(false);

    const after = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" }, include: { links: true } }),
    );
    expect(after.executionLinks).toEqual(before.executionLinks);
    // A worktree shares its owner's repository identity, so removing it takes
    // no identity with it (D-345).
    expect(h.store.repositories(h.projectId)).toEqual(h.store.repositories(h.projectId));
    expect(after.executionLinks[0]?.repositories?.map((row) => row.repositoryId)).toEqual(
      before.executionLinks[0]?.repositories?.map((row) => row.repositoryId),
    );
    // And the project itself is untouched by the checkout going away.
    expect(ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: root })).items).toHaveLength(1);
  });
});
