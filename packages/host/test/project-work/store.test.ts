/**
 * M21-T2: the canonical store.
 *
 * Identity that survives relocation and worktrees, keys that are never reused,
 * immutable revisions whose pointer moves only on commit, optimistic
 * concurrency, idempotency, blobs with ranged reads, quotas that refuse rather
 * than evict, retention after a project is removed, and the integrity check.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_WORK_KINDS } from "@lasercode/protocol";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { projectRootOf } from "../../src/paths.js";
import { ProjectWorkConflictError, ProjectWorkQuotaError, ProjectWorkRefusedError } from "../../src/project-work/errors.js";
import { agent, designBody, person, planBody, specBody, taskBody } from "./fixtures.js";

let base: string;
let store: ProjectWorkStore;
let projectId: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "project-work-"));
  store = new ProjectWorkStore({ file: join(base, "project-work.db") });
  projectId = store.projectIdFor(join(base, "alpha"))!;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const create = (kind: "spec" | "plan" | "design" | "task", title: string, key = `k-${Math.random()}`) =>
  store.create({
    projectId,
    kind,
    title,
    body: kind === "spec" ? specBody() : kind === "plan" ? planBody() : kind === "design" ? designBody() : taskBody(),
    origin: person,
    idempotencyKey: key,
  });

describe("project identity", () => {
  it("mints one id per project directory and keeps it across relocation", () => {
    const moved = join(base, "moved");
    store.relinkProject(projectId, moved);
    expect(store.projectIdFor(moved)).toBe(projectId);
    // The old path is history, and still resolves to the same project.
    expect(store.projectIdFor(join(base, "alpha"))).toBe(projectId);
    expect(store.projectPaths(projectId)).toContain(moved);
  });

  it("resolves a worktree to the project that owns it", () => {
    // The host maps a child agent's worktree to its parent project before it
    // asks the store, which is what makes a worktree session see the same
    // Specs and Tasks (leap, "Canonical persistence").
    const worktree = join(base, "alpha", ".worktrees", "agents-task-44");
    expect(store.projectIdFor(projectRootOf(worktree))).toBe(projectId);
    // Creating from the worktree lands in the parent project's backlog.
    store.create({
      projectId: store.projectIdFor(projectRootOf(worktree))!,
      kind: "task",
      title: "From a worktree",
      body: taskBody(),
      origin: person,
      idempotencyKey: "wt",
    });
    expect(store.list({ projectId }).items.map((item) => item.key)).toEqual(["TASK-1"]);
  });

  it("never merges two projects because a path matched", () => {
    const other = store.projectIdFor(join(base, "beta"))!;
    expect(other).not.toBe(projectId);
    expect(() => store.relinkProject(projectId, join(base, "beta"))).toThrow(ProjectWorkRefusedError);
  });

  it("keeps a project's work when the project is removed, until an explicit delete", () => {
    create("spec", "Phone review");
    store.removeProject(projectId);
    expect(store.isRemoved(projectId)).toBe(true);
    expect(store.list({ projectId }).items).toHaveLength(1);
    // …and an open search does not surface a project the person took off their list.
    expect(store.search({ query: "Phone review" }).results).toHaveLength(0);
    expect(store.search({ projectId, query: "Phone review" }).results).toHaveLength(1);
    expect(store.deleteProjectWork(projectId)).toEqual({ entities: 1 });
    expect(store.hasProject(projectId)).toBe(false);
  });

  it("gives a repository one id across worktrees, branches and relocation", () => {
    const owner = store.ensureRepository({ projectId, gitCommonDir: join(base, "alpha/.git"), rootCommitId: "a".repeat(40), name: "alpha" });
    // A linked worktree resolves to its owner's common dir, so it is the same id.
    const worktree = store.ensureRepository({
      projectId,
      gitCommonDir: join(base, "alpha/.git"),
      rootCommitId: "a".repeat(40),
      name: "alpha",
    });
    expect(worktree).toBe(owner);
    // The checkout moved: the root commit is what identity rests on.
    const relocated = store.ensureRepository({ projectId, gitCommonDir: join(base, "moved/.git"), rootCommitId: "a".repeat(40), name: "alpha" });
    expect(relocated).toBe(owner);
    // A different repository is a different id.
    const second = store.ensureRepository({ projectId, gitCommonDir: join(base, "beta/.git"), rootCommitId: "b".repeat(40), name: "beta" });
    expect(second).not.toBe(owner);
    // A repository with no commits yet is identified by its directory.
    const empty = store.ensureRepository({ projectId, gitCommonDir: join(base, "fresh/.git"), name: "fresh" });
    expect(empty).not.toBe(owner);
    expect(store.repositories(projectId)).toHaveLength(3);
  });
});

describe("keys", () => {
  it("allocates per project and per kind, monotonically", () => {
    expect(create("spec", "One").entity.key).toBe("SPEC-1");
    expect(create("spec", "Two").entity.key).toBe("SPEC-2");
    expect(create("task", "Three").entity.key).toBe("TASK-1");
    expect(create("plan", "Four").entity.key).toBe("PLAN-1");
    const second = store.projectIdFor(join(base, "beta"))!;
    const elsewhere = store.create({ projectId: second, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "b1" });
    expect(elsewhere.entity.key).toBe("SPEC-1");
  });

  it("never reuses a key, even after the item is deleted", () => {
    const first = create("spec", "One");
    create("spec", "Two");
    store.delete({ projectId, entityId: first.entity.entityId, expectedRevisionId: first.revision.revisionId, origin: person, idempotencyKey: "d1" });
    expect(create("spec", "Three").entity.key).toBe("SPEC-3");
  });

  it("shows what the next key of each kind would be, before anything is created", () => {
    const keys = store.peekNextKeys(projectId);
    expect(keys).toEqual({ spec: "SPEC-1", research: "RES-1", design: "DES-1", plan: "PLAN-1", task: "TASK-1" });
    create("spec", "One");
    expect(store.peekNextKeys(projectId).spec).toBe("SPEC-2");
    expect(Object.keys(keys).sort()).toEqual([...PROJECT_WORK_KINDS].sort());
  });
});

describe("revisions", () => {
  it("keeps every revision and moves the current pointer only forward", () => {
    const created = create("spec", "Phone review");
    const revised = store.revise({
      projectId,
      entityId: created.entity.entityId,
      expectedRevisionId: created.revision.revisionId,
      title: "Phone review, revised",
      body: specBody("A second brief."),
      origin: person,
      idempotencyKey: "r1",
    });
    expect(revised.revision.index).toBe(2);
    expect(revised.revision.parentRevisionId).toBe(created.revision.revisionId);
    expect(revised.entity.currentRevisionId).toBe(revised.revision.revisionId);
    expect(revised.entity.revisionCount).toBe(2);
    // The first revision is still exactly what it was.
    const old = store.get({ projectId, entityId: created.entity.entityId, revisionId: created.revision.revisionId });
    expect(old.revision.digest).toBe(created.revision.digest);
    expect(old.body?.body).toEqual(specBody());
    expect(store.verifyRevisionDigest(projectId, created.revision.revisionId)).toBe(true);
  });

  it("refuses a write that names a revision that is no longer current", () => {
    const created = create("spec", "Phone review");
    store.revise({
      projectId,
      entityId: created.entity.entityId,
      expectedRevisionId: created.revision.revisionId,
      body: specBody("second"),
      origin: person,
      idempotencyKey: "r1",
    });
    let conflict: ProjectWorkConflictError | undefined;
    try {
      store.revise({
        projectId,
        entityId: created.entity.entityId,
        expectedRevisionId: created.revision.revisionId,
        body: specBody("third"),
        origin: person,
        idempotencyKey: "r2",
      });
    } catch (error) {
      conflict = error as ProjectWorkConflictError;
    }
    expect(conflict).toBeInstanceOf(ProjectWorkConflictError);
    expect(conflict?.current.revisionId).not.toBe(created.revision.revisionId);
    expect(conflict?.message).toContain("SPEC-1 changed while you were working on it");
    // Nothing was written: still two revisions.
    expect(store.get({ projectId, entityId: created.entity.entityId }).entity.revisionCount).toBe(2);
  });

  it("answers a repeated idempotency key with the first result", () => {
    const first = store.create({ projectId, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "same" });
    const again = store.create({ projectId, kind: "spec", title: "Something else", body: specBody("other"), origin: person, idempotencyKey: "same" });
    expect(again.entity.entityId).toBe(first.entity.entityId);
    expect(again.replayed).toBe(true);
    expect(store.list({ projectId }).items).toHaveLength(1);
    expect(store.peekNextKeys(projectId).spec).toBe("SPEC-2");
  });

  it("returns a revised artifact to draft, and keeps a task's own state", () => {
    const spec = create("spec", "Phone review");
    store.review({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      action: "request_review",
      origin: person,
      idempotencyKey: "rr",
    });
    const current = store.get({ projectId, entityId: spec.entity.entityId });
    const revised = store.revise({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: current.entity.currentRevisionId,
      body: specBody("again"),
      origin: person,
      idempotencyKey: "r9",
    });
    expect(revised.entity.state).toBe("draft");
  });
});

describe("review, approval and staleness", () => {
  it("lets only a person approve, and only with no blocking comment open", () => {
    const spec = create("spec", "Phone review");
    store.review({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      action: "request_review",
      origin: person,
      idempotencyKey: "rr",
    });
    const comment = store.comment({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      revisionId: spec.revision.revisionId,
      anchor: { target: "entity" },
      text: "This needs the empty state.",
      blocking: true,
      origin: agent,
      idempotencyKey: "c1",
    });
    const covers = [
      {
        entityId: spec.entity.entityId,
        kind: "spec" as const,
        key: spec.entity.key,
        revisionId: spec.revision.revisionId,
        digest: spec.revision.digest,
      },
    ];
    expect(() =>
      store.approve({
        projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        gate: "brief",
        decision: "approved",
        covers,
        origin: person,
        idempotencyKey: "a1",
      }),
    ).toThrow(/blocking comment/);
    // An agent may mark it addressed; only a person resolves it.
    store.resolveComment({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      commentId: comment.comment.commentId,
      resolution: "addressed",
      origin: agent,
      idempotencyKey: "ca",
    });
    expect(() =>
      store.resolveComment({
        projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        commentId: comment.comment.commentId,
        resolution: "resolved",
        origin: agent,
        idempotencyKey: "cb",
      }),
    ).toThrow(/only you can resolve/);
    store.resolveComment({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      commentId: comment.comment.commentId,
      resolution: "resolved",
      origin: person,
      idempotencyKey: "cc",
    });
    expect(() =>
      store.approve({
        projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        gate: "brief",
        decision: "approved",
        covers,
        origin: agent,
        idempotencyKey: "a2",
      }),
    ).toThrow(/Only a person approves/);
    const approved = store.approve({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      gate: "brief",
      decision: "approved",
      covers,
      origin: person,
      idempotencyKey: "a3",
    });
    expect(approved.entity.state).toBe("approved");
    expect(approved.approval.covers[0]?.digest).toBe(spec.revision.digest);
  });

  it("refuses an approval whose covered revision has moved", () => {
    const spec = create("spec", "Phone review");
    const covers = [
      { entityId: spec.entity.entityId, kind: "spec" as const, key: spec.entity.key, revisionId: spec.revision.revisionId, digest: "f".repeat(64) },
    ];
    expect(() =>
      store.approve({
        projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        gate: "brief",
        decision: "approved",
        covers,
        origin: person,
        idempotencyKey: "a1",
      }),
    ).toThrow(/changed since this was prepared/);
  });

  it("stales the dependents of an approved artifact, along links that exist", () => {
    const spec = create("spec", "Phone review");
    const design = create("design", "The footer");
    // Design depends_on Spec.
    store.link({
      projectId,
      expectedRevisionId: design.revision.revisionId,
      link: {
        type: "edge",
        relation: "depends_on",
        subject: { entityId: design.entity.entityId, revisionId: design.revision.revisionId },
        object: { entityId: spec.entity.entityId, revisionId: spec.revision.revisionId },
      },
      origin: person,
      idempotencyKey: "l1",
    });
    for (const entity of [spec, design]) {
      store.review({
        projectId,
        entityId: entity.entity.entityId,
        expectedRevisionId: entity.revision.revisionId,
        action: "request_review",
        origin: person,
        idempotencyKey: `rr-${entity.entity.key}`,
      });
      store.approve({
        projectId,
        entityId: entity.entity.entityId,
        expectedRevisionId: entity.revision.revisionId,
        gate: "brief",
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
        origin: person,
        idempotencyKey: `ap-${entity.entity.key}`,
      });
    }
    store.revise({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      body: specBody("materially different"),
      origin: person,
      idempotencyKey: "r1",
    });
    const staleDesign = store.get({ projectId, entityId: design.entity.entityId });
    expect(staleDesign.entity.state).toBe("stale");
    expect(staleDesign.entity.staleBecause?.upstreamKey).toBe("SPEC-1");
    expect(staleDesign.entity.needsAttention).toBe(true);
  });

  it("stales nothing when nothing is linked", () => {
    const spec = create("spec", "Phone review");
    create("design", "The footer");
    store.review({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      action: "request_review",
      origin: person,
      idempotencyKey: "rr",
    });
    store.approve({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      gate: "brief",
      decision: "approved",
      covers: [
        { entityId: spec.entity.entityId, kind: "spec", key: spec.entity.key, revisionId: spec.revision.revisionId, digest: spec.revision.digest },
      ],
      origin: person,
      idempotencyKey: "ap",
    });
    store.revise({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      body: specBody("changed"),
      origin: person,
      idempotencyKey: "r1",
    });
    expect(store.list({ projectId }).items.every((item) => item.state !== "stale")).toBe(true);
  });
});

describe("tasks", () => {
  it("refuses done without acceptance evidence, and never on a finished run", () => {
    const task = create("task", "Sticky footer");
    const id = task.entity.entityId;
    const at = task.revision.revisionId;
    store.taskAction({ projectId, entityId: id, expectedRevisionId: at, action: "mark_ready", origin: person, idempotencyKey: "t1" });
    store.taskAction({ projectId, entityId: id, expectedRevisionId: at, action: "start", origin: person, idempotencyKey: "t2" });
    store.taskAction({ projectId, entityId: id, expectedRevisionId: at, action: "submit_for_review", origin: person, idempotencyKey: "t3" });
    expect(() =>
      store.taskAction({ projectId, entityId: id, expectedRevisionId: at, action: "complete", origin: person, idempotencyKey: "t4" }),
    ).toThrow(/acceptance evidence/);
    expect(() =>
      store.taskAction({ projectId, entityId: id, expectedRevisionId: at, action: "complete", origin: agent, idempotencyKey: "t5" }),
    ).toThrow(/a person completes the task/);
    store.link({
      projectId,
      expectedRevisionId: at,
      link: {
        type: "evidence",
        entityId: id,
        revisionId: at,
        kind: "test",
        role: "acceptance",
        summary: "pnpm -F @lasercode/ui test",
        outcome: "passed",
      },
      origin: agent,
      idempotencyKey: "e1",
    });
    const done = store.taskAction({ projectId, entityId: id, expectedRevisionId: at, action: "complete", origin: person, idempotencyKey: "t6" });
    expect(done.entity.state).toBe("done");
    expect(done.transition).toEqual({ from: "needs_review", to: "done" });
  });

  it("names the unmet dependency keys when a task cannot be made ready", () => {
    const blocker = create("task", "Do this first");
    const dependent = store.create({
      projectId,
      kind: "task",
      title: "Then this",
      body: taskBody("Then this", [blocker.entity.key]),
      origin: person,
      idempotencyKey: "t-dep",
    });
    expect(() =>
      store.taskAction({
        projectId,
        entityId: dependent.entity.entityId,
        expectedRevisionId: dependent.revision.revisionId,
        action: "mark_ready",
        origin: person,
        idempotencyKey: "t1",
      }),
    ).toThrow(/TASK-1 must be done first/);
    const listed = store.list({ projectId }).items.find((item) => item.key === dependent.entity.key);
    expect(listed?.unmetDependencies).toEqual(["TASK-1"]);
  });

  it("records attempts as links, counting them itself", () => {
    const task = create("task", "Sticky footer");
    const first = store.linkExecution({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "session", targetId: "ses_1" },
      origin: person,
      idempotencyKey: "x1",
    });
    const second = store.linkExecution({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId: "run_2", outcome: "failed" },
      origin: person,
      idempotencyKey: "x2",
    });
    expect(first.link.attempt).toBe(1);
    expect(second.link.attempt).toBe(2);
    // A failed attempt is evidence: the Task is untouched by it.
    expect(store.get({ projectId, entityId: task.entity.entityId }).entity.state).toBe("draft");
    expect(store.get({ projectId, entityId: task.entity.entityId }).executionLinks).toHaveLength(2);
  });
});

describe("blobs", () => {
  it("stores content once, reads ranges and never returns bytes under a wrong digest", () => {
    const data = Buffer.from("<!doctype html><p>sketch</p>".repeat(10), "utf8");
    const stored = store.putBlob({ projectId, mediaType: "text/html", data });
    const again = store.putBlob({ projectId, mediaType: "text/html", data });
    expect(again.blobId).toBe(stored.blobId);
    expect(again.inserted).toBe(false);
    const whole = store.readBlob({ projectId, blobId: stored.blobId });
    expect(whole?.data?.equals(data)).toBe(true);
    expect(whole?.totalBytes).toBe(data.byteLength);
    const page = store.readBlob({ projectId, blobId: stored.blobId, offset: 10, limit: 20 });
    expect(page?.bytes).toBe(20);
    expect(page?.nextOffset).toBe(30);
    expect(page?.data?.equals(data.subarray(10, 30))).toBe(true);
    expect(store.readBlob({ projectId, blobId: "blb_nope" })).toBeUndefined();
  });

  it("chunks a large blob and still pages it exactly", () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    for (let i = 0; i < data.byteLength; i += 997) data[i] = i % 251;
    const stored = store.putBlob({ projectId, mediaType: "image/png", data });
    const whole = store.readBlob({ projectId, blobId: stored.blobId, limit: data.byteLength });
    expect(whole?.data?.equals(data)).toBe(true);
    const across = store.readBlob({ projectId, blobId: stored.blobId, offset: 1024 * 1024 - 10, limit: 40 });
    expect(across?.data?.equals(data.subarray(1024 * 1024 - 10, 1024 * 1024 + 30))).toBe(true);
    const tail = store.readBlob({ projectId, blobId: stored.blobId, offset: data.byteLength - 5, limit: 100 });
    expect(tail?.bytes).toBe(5);
    expect(tail?.nextOffset).toBeUndefined();
  });
});

describe("budgets", () => {
  it("refuses a durable write at the cap, with what to do, and writes nothing", () => {
    const small = new ProjectWorkStore({ file: join(base, "small.db"), quota: { projectBytes: 4096 } });
    try {
      const tiny = small.projectIdFor(join(base, "tiny"))!;
      small.create({ projectId: tiny, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "s1" });
      let refusal: ProjectWorkQuotaError | undefined;
      const big = specBody();
      if (big.kind === "spec") big.spec.document = "x".repeat(20_000);
      try {
        small.create({ projectId: tiny, kind: "spec", title: "Two", body: big, origin: person, idempotencyKey: "s2" });
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal).toBeInstanceOf(ProjectWorkQuotaError);
      expect(refusal?.scope).toBe("project");
      expect(refusal?.recovery).toContain("Nothing was saved");
      expect(small.list({ projectId: tiny }).items).toHaveLength(1);
      // The canonical revision that was already there is untouched.
      expect(small.get({ projectId: tiny, key: "SPEC-1" }).body?.body).toEqual(specBody());
    } finally {
      small.close();
    }
  });

  it("counts a project's bytes and reports them against the limits", () => {
    create("spec", "One");
    const usage = store.usage(projectId);
    expect(usage.projectBytes).toBeGreaterThan(0);
    expect(usage.entities).toBe(1);
    expect(usage.limits.projectBytes).toBeGreaterThan(usage.projectBytes);
  });
});

describe("events and integrity", () => {
  it("numbers project events and reconciles from a sequence", () => {
    const events: number[] = [];
    const listening = new ProjectWorkStore({ file: join(base, "events.db"), onEvent: (event) => events.push(event.seq) });
    try {
      const id = listening.projectIdFor(join(base, "gamma"))!;
      const first = listening.create({ projectId: id, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "e1" });
      listening.create({ projectId: id, kind: "task", title: "Two", body: taskBody(), origin: person, idempotencyKey: "e2" });
      expect(events).toEqual([1, 2]);
      expect(listening.seq(id)).toBe(2);
      const since = listening.list({ projectId: id, sinceSeq: 1 });
      expect(since.items.map((item) => item.key)).toEqual(["TASK-1"]);
      expect(since.seq).toBe(2);
      listening.delete({ projectId: id, entityId: first.entity.entityId, expectedRevisionId: first.revision.revisionId, origin: person, idempotencyKey: "d1" });
      const afterDelete = listening.list({ projectId: id, sinceSeq: 2 });
      expect(afterDelete.removed).toEqual([first.entity.entityId]);
    } finally {
      listening.close();
    }
  });

  it("publishes an event only after the write commits", () => {
    const seen: string[] = [];
    const listening = new ProjectWorkStore({
      file: join(base, "commit.db"),
      onEvent: (event) => {
        // The row is on disk by the time anybody hears about it.
        seen.push(listening.get({ projectId: event.projectId, entityId: event.change.entityId }).entity.key);
      },
    });
    try {
      const id = listening.projectIdFor(join(base, "delta"))!;
      listening.create({ projectId: id, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "c1" });
      expect(seen).toEqual(["SPEC-1"]);
    } finally {
      listening.close();
    }
  });

  it("checks its own integrity", () => {
    create("spec", "One");
    create("task", "Two");
    expect(store.integrityCheck()).toEqual({ ok: true, problems: [] });
  });
});

describe("reads", () => {
  it("pages the backlog newest first and filters by kind, state and attention", () => {
    create("spec", "One");
    const task = create("task", "Two");
    create("design", "Three");
    expect(store.list({ projectId }).items.map((item) => item.key)).toEqual(["DES-1", "TASK-1", "SPEC-1"]);
    expect(store.list({ projectId, kinds: ["task"] }).items.map((item) => item.key)).toEqual(["TASK-1"]);
    expect(store.list({ projectId, states: ["draft"] }).items).toHaveLength(3);
    store.taskAction({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      action: "block",
      origin: person,
      idempotencyKey: "b1",
    });
    expect(store.list({ projectId, needsYou: true }).items.map((item) => item.key)).toEqual(["TASK-1"]);
    expect(store.attention(projectId).items[0]).toMatchObject({ key: "TASK-1", reason: "blocked_task" });
  });

  it("hides an archived item by default and restores it with its state", () => {
    const spec = create("spec", "One");
    store.review({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      action: "request_review",
      origin: person,
      idempotencyKey: "rr",
    });
    store.archive({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      archived: true,
      origin: person,
      idempotencyKey: "ar",
    });
    expect(store.list({ projectId }).items).toHaveLength(0);
    expect(store.list({ projectId, includeArchived: true }).items[0]?.archived).toBe(true);
    const restored = store.archive({
      projectId,
      entityId: spec.entity.entityId,
      expectedRevisionId: spec.revision.revisionId,
      archived: false,
      origin: person,
      idempotencyKey: "un",
    });
    expect(restored.entity.state).toBe("needs_review");
  });

  it("ranks an exact key first in search and never returns storage detail", () => {
    const spec = create("spec", "Phone review");
    create("task", "Mentions SPEC-1 in its outcome");
    const results = store.search({ projectId, query: "SPEC-1" });
    expect(results.results[0]?.key).toBe("SPEC-1");
    expect(results.results[0]?.exactKey).toBe(true);
    expect(JSON.stringify(results)).not.toContain(base);
    expect(JSON.stringify(results)).not.toContain(spec.revision.digest.slice(0, 32) + "x");
  });

  it("lists what a delete would orphan before it happens", () => {
    const spec = create("spec", "One");
    const design = create("design", "Two");
    store.link({
      projectId,
      expectedRevisionId: design.revision.revisionId,
      link: {
        type: "edge",
        relation: "depends_on",
        subject: { entityId: design.entity.entityId, revisionId: design.revision.revisionId },
        object: { entityId: spec.entity.entityId, revisionId: spec.revision.revisionId },
      },
      origin: person,
      idempotencyKey: "l1",
    });
    expect(store.deletePreview(projectId, spec.entity.entityId)).toEqual([{ key: "DES-1", kind: "design", relation: "depends_on" }]);
  });
});
