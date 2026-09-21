/**
 * Which proof a repository link rested on, and when (D-363, M21-T19).
 *
 * Correcting the capture behind a link does not retarget the link — its
 * subject, relation and target are untouched, and a correction to any of
 * *those* still appends a superseding link, as the root contract requires.
 * What may change is which bounded canonical proof of that same exact link is
 * current, and the rule this file holds to the fire is that every such
 * association is kept:
 *
 * - the first one is written with the link, in its own transaction;
 * - a correction appends, names what it superseded, says who made it and in
 *   which gate's preparation — which is not the same thing as a gate that
 *   succeeded;
 * - the compare-and-set is honest about losing: a lost race appends nothing
 *   and is reported as a conflict;
 * - a database from before this history gets one honest baseline row, never an
 *   invented past;
 * - and the capture a decision was made against stays readable afterwards.
 */
import { PRODUCT_NAME, type ProjectWorkGetResult, type ProjectWorkLinkResult, type ProjectWorkWriteResult } from "@lasercode/protocol";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { commit, haveGit, head, initRepo, write } from "./git-fixtures.js";
import { buildCapture, storeCapture } from "../../src/project-work/captures.js";
import { diffBetween } from "../../src/source-control/read.js";
import { ProjectWorkGate } from "../../src/project-work/gate.js";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { PROJECT_WORK_SCHEMA_VERSION } from "../../src/project-work/schema.js";
import { person, taskBody } from "./fixtures.js";

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
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-capture-history-`));
  dirs.push(dir);
  h = projectWorkHarness({ dir });
  const app = join(h.projectRoot, "app");
  initRepo(app, { "src/a.ts": "one\n" });
  return app;
}

async function detail(entityId: string, captureHistory = false): Promise<ProjectWorkGetResult> {
  return ok<ProjectWorkGetResult>(
    await h.call("project/work/get", {
      projectId: h.projectId,
      entityId,
      body: { mode: "none" },
      include: { links: true, evidence: true, ...(captureHistory ? { captureHistory: true } : {}) },
    }),
  );
}

/**
 * A Task whose delivery a person accepted, with the one thing the product can
 * no longer produce beside it: the capture an earlier version of this app
 * would have kept — real, bounded, honest, and not the whole of what the
 * delivery rests on.
 */
async function deliveredWithOldCapture(): Promise<{
  app: string;
  task: ProjectWorkWriteResult;
  linkId: string;
  acceptedBlobId: string;
  partialBlobId: string;
}> {
  const app = workspace();
  const task = ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", {
      projectId: h.projectId,
      kind: "task",
      title: "Delivered",
      body: taskBody(),
      idempotencyKey: idem("task"),
    }),
  );
  ok(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId: "run_1", sessionPath: SESSION },
      idempotencyKey: idem("start"),
    }),
  );
  const base = head(app);
  write(app, { "src/a.ts": "delivered\n", "src/extra.ts": "more\n" });
  const made = commit(app, "the delivery");
  const ended = ok<{ link: { repositories?: Array<{ name: string; repositoryId: string }> } }>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "agent_run", targetId: "run_1", outcome: "completed", sessionPath: SESSION },
      idempotencyKey: idem("end"),
    }),
  );
  const repositoryId = ended.link.repositories!.find((row) => row.name === "app")!.repositoryId;
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
  const acceptedBlobId = accepted.link.links[0]!.captureBlobId!;
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
  const partial = await buildCapture({ repository, repositoryId, change, now: new Date().toISOString() });
  const stored = storeCapture(h.store, { projectId: h.projectId, entityId: task.entity.entityId, capture: partial!, gate: "A test" });
  expect(h.store.attachCapture(h.projectId, linkId, stored.blobId, acceptedBlobId, { gate: "A test" })).toBe(true);
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
  return { app, task, linkId, acceptedBlobId, partialBlobId: stored.blobId };
}

describe.runIf(haveGit)("what proved a link, and when", () => {
  it("records the capture a link was written with, as the association it is", async () => {
    const world = await deliveredWithOldCapture();
    const history = h.store.captureHistory(h.projectId, world.linkId);
    const first = history[history.length - 1]!;
    expect(first.blobId, "the capture the acceptance stored").toBe(world.acceptedBlobId);
    expect(first.reason).toBe("first_capture");
    expect(first.gate, "and which door wrote it").toBe("accept_delivery");
    expect(first.supersedesBlobId, "nothing came before it").toBeUndefined();
    expect(first.seq).toBe(1);
    expect(first.actor.kind, "host-written, from the person who accepted").toBe("person");
  });

  it("appends a correction rather than rewriting one, and says whose gate it was being prepared for", async () => {
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

    const history = h.store.captureHistory(h.projectId, world.linkId);
    expect(history.map((row) => row.seq), "newest first, one row per association, nothing rewritten").toEqual([3, 2, 1]);
    const correction = history[0]!;
    expect(correction.supersedesBlobId, "it names the capture it replaced").toBe(world.partialBlobId);
    expect(correction.supersedesRevisionId).toBe(history[1]!.revisionId);
    expect(correction.reason, "a gate being prepared is not a gate that succeeded").toBe("gate_preparation");
    expect(correction.gate, "named as the gate it was prepared for, in the words that gate uses").toBe("Marking this task done");
    expect(new Set(history.map((row) => row.revisionId)).size, "every association has its own identity").toBe(3);

    // Every capture the link ever pointed at is still readable, including the
    // one an earlier decision was read against.
    for (const blobId of [world.acceptedBlobId, world.partialBlobId, correction.blobId]) {
      const page = ok<{ data?: string }>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId }));
      expect(page.data, `${blobId} is still there`).toBeDefined();
    }
  });

  it("reports a lost race as a conflict, and appends nothing for it", async () => {
    const world = await deliveredWithOldCapture();
    const repository = { path: world.app, gitDir: join(world.app, ".git"), name: "app" };
    const link = (await detail(world.task.entity.entityId)).repositoryLinks.find((row) => row.linkId === world.linkId)!;
    const target = "change" in link.target ? link.target.change : undefined;
    const another = await buildCapture({
      repository,
      repositoryId: link.repositoryId,
      change: target!,
      now: "2026-03-01T09:00:00.000Z",
    });
    const stored = storeCapture(h.store, {
      projectId: h.projectId,
      entityId: world.task.entity.entityId,
      capture: another!,
      gate: "A test",
    });
    const before = h.store.captureHistory(h.projectId, world.linkId).length;

    // The blob this caller read is no longer what the link points at: the
    // pointer moved to `partialBlobId` before it got here.
    expect(h.store.attachCapture(h.projectId, world.linkId, stored.blobId, world.acceptedBlobId)).toBe(false);
    expect(h.store.captureHistory(h.projectId, world.linkId).length, "a loser appends nothing").toBe(before);
    expect(
      (await detail(world.task.entity.entityId)).repositoryLinks.find((row) => row.linkId === world.linkId)?.captureBlobId,
      "and moves nothing",
    ).toBe(world.partialBlobId);
  });

  it("refuses a gate that lost the race for this link's proof, rather than deciding on what it never read", async () => {
    const world = await deliveredWithOldCapture();
    // The same store, with the one thing a test cannot time: the
    // compare-and-set reporting that somebody else moved this link's pointer
    // first. Everything else — the record, the repository, the capture that
    // gets taken — is real.
    const losing = new Proxy(h.store, {
      get(target, property) {
        if (property === "attachCapture") return () => false;
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const gate = new ProjectWorkGate({
      store: losing,
      caller: { cwd: h.projectRoot, origin: person },
    });
    await expect(
      gate.keepEvidenceReviewable(h.projectId, [world.task.entity.entityId], "Completing this task"),
    ).rejects.toThrow(/changed somewhere else/);
    expect(
      (await detail(world.task.entity.entityId)).repositoryLinks.find((row) => row.linkId === world.linkId)?.captureBlobId,
      "and the link is where it was",
    ).toBe(world.partialBlobId);
  });

  it("answers the history through the ordinary detail read, bounded and opt-in", async () => {
    const world = await deliveredWithOldCapture();
    const without = await detail(world.task.entity.entityId);
    expect(without.captureHistory, "off unless it is asked for").toBeUndefined();

    const withHistory = await detail(world.task.entity.entityId, true);
    const rows = withHistory.captureHistory!.filter((row) => row.linkId === world.linkId);
    expect(rows.map((row) => row.blobId)).toEqual([world.partialBlobId, world.acceptedBlobId]);
    expect(rows[0]?.supersedesBlobId).toBe(world.acceptedBlobId);
  });
});

describe("associations of one link, without a repository in sight", () => {
  /** A store with a clock that does not move: identity cannot come from time. */
  function frozenStore(): { store: ProjectWorkStore; dir: string; projectId: string; repositoryId: string } {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-capture-frozen-`));
    dirs.push(dir);
    const store = new ProjectWorkStore({ file: join(dir, "project-work.db"), now: () => new Date("2026-03-01T09:00:00.000Z") });
    const projectId = store.projectIdFor(join(dir, "alpha"))!;
    const repositoryId = store.ensureRepository({ projectId, name: "app", gitCommonDir: join(dir, "alpha/app/.git") });
    return { store, dir, projectId, repositoryId };
  }

  function blob(store: ProjectWorkStore, projectId: string, text: string): string {
    return store.putBlob({ projectId, mediaType: "application/json", data: Buffer.from(text, "utf8") }).blobId;
  }

  it("keeps two associations written in the same instant apart, and in order", () => {
    const { store, projectId, repositoryId } = frozenStore();
    try {
      const task = store.create({ projectId, kind: "task", title: "One", body: taskBody(), origin: person, idempotencyKey: "one" });
      const first = blob(store, projectId, "one");
      const second = blob(store, projectId, "two");
      const third = blob(store, projectId, "three");
      const written = store.link({
        projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "repository",
          relation: "based_on",
          subjectEntityId: task.entity.entityId,
          subjectRevisionId: task.revision.revisionId,
          repositoryId,
          target: { state: { vcs: "git", objectFormat: "sha1", commitObjectId: "a".repeat(40) } },
          captureBlobId: first,
        },
        origin: person,
        idempotencyKey: "link",
      });
      if (written.link.type !== "repository") throw new Error("unreachable");
      const linkId = written.link.repository.linkId;

      expect(store.attachCapture(projectId, linkId, second, first, { gate: "Approving this" })).toBe(true);
      expect(store.attachCapture(projectId, linkId, third, second, { gate: "Completing this" })).toBe(true);

      const history = store.captureHistory(projectId, linkId);
      expect(history.map((row) => row.attachedAt), "one instant, three associations").toEqual([
        "2026-03-01T09:00:00.000Z",
        "2026-03-01T09:00:00.000Z",
        "2026-03-01T09:00:00.000Z",
      ]);
      expect(history.map((row) => row.seq), "ordered by the link's own counter, never by the clock").toEqual([3, 2, 1]);
      expect(new Set(history.map((row) => row.revisionId)).size).toBe(3);
      expect(history.map((row) => row.blobId)).toEqual([third, second, first]);
      expect(history[0]?.supersedesRevisionId).toBe(history[1]?.revisionId);
      expect(store.firstCaptureAssociation(projectId, linkId)?.blobId, "the first one is what a decision without a binding rests on").toBe(
        first,
      );
    } finally {
      store.close();
    }
  });

  it("appends nothing when the same capture is attached twice", () => {
    const { store, projectId, repositoryId } = frozenStore();
    try {
      const task = store.create({ projectId, kind: "task", title: "One", body: taskBody(), origin: person, idempotencyKey: "one" });
      const only = blob(store, projectId, "one");
      const written = store.link({
        projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "repository",
          relation: "based_on",
          subjectEntityId: task.entity.entityId,
          subjectRevisionId: task.revision.revisionId,
          repositoryId,
          target: { state: { vcs: "git", objectFormat: "sha1", commitObjectId: "b".repeat(40) } },
        },
        origin: person,
        idempotencyKey: "link",
      });
      if (written.link.type !== "repository") throw new Error("unreachable");
      const linkId = written.link.repository.linkId;
      expect(store.captureHistory(projectId, linkId), "a link written without a capture has no association").toEqual([]);

      expect(store.attachCapture(projectId, linkId, only), "the first attach takes").toBe(true);
      expect(store.attachCapture(projectId, linkId, only), "the same attach again moves nothing").toBe(false);
      expect(store.captureHistory(projectId, linkId).length).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("a database from before this history", () => {
  it("records the association it can attest as a baseline, and invents no past", () => {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-capture-migrate-`));
    dirs.push(dir);
    const file = join(dir, "project-work.db");
    let linkId = "";
    let blobId = "";
    let projectId = "";

    const store = new ProjectWorkStore({ file });
    try {
      projectId = store.projectIdFor(join(dir, "alpha"))!;
      const repositoryId = store.ensureRepository({ projectId, name: "app", gitCommonDir: join(dir, "alpha/app/.git") });
      const task = store.create({ projectId, kind: "task", title: "One", body: taskBody(), origin: person, idempotencyKey: "one" });
      blobId = store.putBlob({ projectId, mediaType: "application/json", data: Buffer.from("a capture", "utf8") }).blobId;
      const written = store.link({
        projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "repository",
          relation: "based_on",
          subjectEntityId: task.entity.entityId,
          subjectRevisionId: task.revision.revisionId,
          repositoryId,
          target: { state: { vcs: "git", objectFormat: "sha1", commitObjectId: "c".repeat(40) } },
          captureBlobId: blobId,
        },
        origin: person,
        idempotencyKey: "link",
      });
      if (written.link.type !== "repository") throw new Error("unreachable");
      linkId = written.link.repository.linkId;
    } finally {
      store.close();
    }

    // Wind the file back to the format before this table existed: the link and
    // its capture pointer survive, the history does not exist at all.
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE repository_link_captures");
    raw.exec(`PRAGMA user_version = ${PROJECT_WORK_SCHEMA_VERSION - 1}`);
    raw.close();

    const upgraded = new ProjectWorkStore({ file });
    try {
      const history = upgraded.captureHistory(projectId, linkId);
      expect(history.length, "exactly one row: the association this database knows").toBe(1);
      expect(history[0]?.blobId).toBe(blobId);
      expect(history[0]?.reason, "and it says it is a baseline, not a history it does not have").toBe("legacy_baseline");
      expect(history[0]?.supersedesBlobId).toBeUndefined();
      expect(history[0]?.gate).toBeUndefined();
    } finally {
      upgraded.close();
    }
  });
});
