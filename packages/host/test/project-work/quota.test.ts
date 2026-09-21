/**
 * M21-T2 / D-365: what canonical project work costs, and what happens at the
 * cap.
 *
 * Before this, the durable budget counted revision bodies and blob payloads
 * and nothing else: a comment, an approval, a decision, a link, a capture
 * association, a proof binding and an idempotency receipt were all written
 * free. These tests hold the repair to the contract the leap states
 * (`docs/project-lifecycle-leap.md` 135–138, 729–733):
 *
 * - every canonical mutation is charged, in exact UTF-8, including updates;
 * - the counters agree with an **independent** recount from the raw rows, so a
 *   writer that forgot to recharge a row it changed fails here;
 * - a refusal leaves no row, no counter movement, no event, no sequence bump
 *   and no receipt;
 * - deletion credits exactly what was charged, and is refused when it would
 *   destroy proof a surviving other item's record rests on;
 * - nothing canonical is ever released to make room.
 *
 * Every fixture is an owned temporary store. Nothing here reads the person's
 * own data or the network.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_TABLES,
  BOOKKEEPING_TABLES,
  DERIVED_TABLES,
  UNPARTITIONED_TABLES,
  ROW_OVERHEAD_BYTES,
} from "../../src/project-work/accounting.js";
import { ProjectWorkQuotaError } from "../../src/project-work/errors.js";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { person, specBody, taskBody } from "./fixtures.js";

let base: string;
let store: ProjectWorkStore;
let projectId: string;
let file: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "project-work-quota-"));
  file = join(base, "project-work.db");
  store = new ProjectWorkStore({ file });
  projectId = store.projectIdFor(join(base, "alpha"))!;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

let keys = 0;
function idem(prefix: string): string {
  keys += 1;
  return `${prefix}-${String(keys)}`;
}

function spec(title = "Phone review"): ReturnType<ProjectWorkStore["create"]> {
  return store.create({ projectId, kind: "spec", title, body: specBody(), origin: person, idempotencyKey: idem("create") });
}

/** The counters agree with a recount that never reads a stored charge. */
function invariant(target: ProjectWorkStore = store, id = projectId): void {
  const counted = target.reconcileUsage(id);
  const reported = target.usage(id);
  expect(counted.bytes, "project bytes must equal the recount from the raw rows").toBe(reported.projectBytes);
  expect(counted.records, "record count must equal the recount from the raw rows").toBe(reported.records);
  expect(counted.entities, "entity count must equal the recount from the raw rows").toBe(reported.entities);
  expect(counted.changed).toBe(false);
}

/** A capture-shaped blob this project owns. */
function blob(text: string, entityId?: string): { blobId: string; bytes: number } {
  return store.putBlob({ projectId, ...(entityId ? { entityId } : {}), mediaType: "application/json", data: Buffer.from(text, "utf8") });
}

function repository(): string {
  return store.ensureRepository({ projectId, name: "app", gitCommonDir: join(base, "alpha", "app", ".git") });
}

/** One `verified_at` repository link, with a capture behind it. */
function repositoryLink(
  entity: { entityId: string; revisionId: string },
  repositoryId: string,
  captureBlobId?: string,
): string {
  const written = store.link({
    projectId,
    expectedRevisionId: entity.revisionId,
    link: {
      type: "repository",
      relation: "based_on",
      subjectEntityId: entity.entityId,
      subjectRevisionId: entity.revisionId,
      repositoryId,
      target: { state: { vcs: "git", objectFormat: "sha1", commitObjectId: "a".repeat(40) } },
      ...(captureBlobId ? { captureBlobId } : {}),
    },
    origin: person,
    idempotencyKey: idem("link"),
  });
  if (written.link.type !== "repository") throw new Error("fixture");
  return written.link.repository.linkId;
}

// ---------------------------------------------------------------------------

describe("what a canonical row costs", () => {
  it("charges a comment the exact UTF-8 of what was stored, not its character count", () => {
    const item = spec();
    const text = "🙂 λόγος — a combining mark: é and e\u0301";
    const before = store.usage(projectId);
    const written = store.comment({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: item.revision.revisionId,
      revisionId: item.revision.revisionId,
      anchor: { kind: "whole" },
      text,
      origin: person,
      idempotencyKey: idem("comment"),
    });

    const db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT * FROM comments WHERE comment_id = ?").get(written.comment.commentId) as Record<string, unknown>;
    db.close();

    // Counted here from the row's own stored strings, without asking the
    // implementation what it thinks a row costs.
    const columns = ["comment_id", "project_id", "entity_id", "revision_id", "anchor_json", "text", "state", "created_at", "origin_json"];
    const expected = columns.reduce((total, column) => total + Buffer.byteLength(String(row[column]), "utf8"), ROW_OVERHEAD_BYTES);
    expect(Number(row["charged_bytes"])).toBe(expected);
    // The multi-byte text is charged as bytes, which is more than its length.
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length);
    expect(Number(row["charged_bytes"])).toBeGreaterThan(Buffer.byteLength(text, "utf8"));

    // And the project's budget moved by at least that comment plus its receipt.
    const after = store.usage(projectId);
    expect(after.projectBytes - before.projectBytes).toBeGreaterThan(expected);
    expect(after.records - before.records).toBe(2); // the comment and its receipt
    invariant();
  });

  it("charges a revision's body once and its other columns on top of it", () => {
    const item = spec();
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT * FROM revisions WHERE revision_id = ?").get(item.revision.revisionId) as Record<string, unknown>;
    db.close();
    const body = String(row["body"]);
    const charged = Number(row["charged_bytes"]);
    expect(Number(row["body_bytes"])).toBe(Buffer.byteLength(body, "utf8"));
    // Exactly one copy of the body, plus the metadata around it.
    expect(charged).toBeGreaterThan(Buffer.byteLength(body, "utf8") + ROW_OVERHEAD_BYTES);
    expect(charged).toBeLessThan(2 * Buffer.byteLength(body, "utf8"));
  });

  it("charges a blob's row as well as its payload, and charges the payload once", () => {
    const payload = "x".repeat(5000);
    const first = blob(payload);
    const afterFirst = store.usage(projectId);
    expect(afterFirst.projectBytes).toBeGreaterThan(first.bytes + ROW_OVERHEAD_BYTES);

    // The same bytes again: deduplicated, so no second payload and no second row.
    const second = blob(payload);
    expect(second.blobId).toBe(first.blobId);
    expect(store.usage(projectId).projectBytes).toBe(afterFirst.projectBytes);
    invariant();

    // An empty blob is still a row, and a row is never free.
    const empty = store.putBlob({ projectId, mediaType: "text/plain", data: Buffer.alloc(0) });
    expect(empty.bytes).toBe(0);
    expect(store.usage(projectId).projectBytes).toBeGreaterThan(afterFirst.projectBytes + ROW_OVERHEAD_BYTES);
    invariant();
  });

  it("gives a released derived blob's payload back and keeps its row charged", () => {
    const stored = blob("a preview nobody can recreate cheaply".repeat(200));
    const before = store.usage(projectId);
    const freed = store.releaseDerived({ projectId, blobId: stored.blobId, reason: "quota", detail: "Rebuilt on demand." });
    expect(freed).toBe(stored.bytes);
    const after = store.usage(projectId);
    expect(after.projectBytes).toBeLessThan(before.projectBytes);
    // The row survives, so its metadata is still charged: nothing canonical
    // disappeared, only derived bytes were let go.
    expect(after.projectBytes).toBeGreaterThan(0);
    expect(after.records).toBe(before.records);
    invariant();
  });

  it("charges the identity mappings a project is found by", () => {
    const fresh = new ProjectWorkStore({ file: join(base, "identity.db") });
    try {
      const before = fresh.usage().globalBytes;
      const id = fresh.projectIdFor(join(base, "beta"))!;
      const after = fresh.usage(id);
      // The project row and the path row, both charged, both counted.
      expect(after.projectBytes).toBeGreaterThan(2 * ROW_OVERHEAD_BYTES);
      expect(after.records).toBe(2);
      expect(fresh.usage().globalBytes).toBeGreaterThan(before);
      fresh.ensureRepository({ projectId: id, name: "app", gitCommonDir: join(base, "beta", ".git") });
      expect(fresh.usage(id).records).toBe(3);
      invariant(fresh, id);
    } finally {
      fresh.close();
    }
  });
});

describe("every door moves the counters, and the counters stay true", () => {
  it("agrees with a raw-row recount after every write, update and delete route", () => {
    const repositoryId = repository();
    invariant();

    const item = spec("Brief");
    invariant();

    const revised = store.revise({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: item.revision.revisionId,
      title: "Brief, renamed at length so the entity row really changes size",
      body: specBody("A longer brief than the one before it."),
      origin: person,
      idempotencyKey: idem("revise"),
    });
    invariant();

    const comment = store.comment({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: revised.revision.revisionId,
      revisionId: revised.revision.revisionId,
      anchor: { kind: "whole" },
      text: "This needs a number.",
      blocking: true,
      origin: person,
      idempotencyKey: idem("comment"),
    });
    invariant();

    store.resolveComment({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: revised.revision.revisionId,
      commentId: comment.comment.commentId,
      resolution: "resolved",
      origin: person,
      idempotencyKey: idem("resolve"),
    });
    invariant();

    store.review({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: revised.revision.revisionId,
      action: "request_review",
      origin: person,
      idempotencyKey: idem("review"),
    });
    invariant();

    store.approve({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: revised.revision.revisionId,
      gate: "brief",
      decision: "approved",
      covers: [
        {
          entityId: item.entity.entityId,
          kind: "spec",
          key: item.entity.key,
          revisionId: revised.revision.revisionId,
          digest: revised.revision.digest,
        },
      ],
      proof: { gate: "Approving the brief", refs: [] },
      origin: person,
      idempotencyKey: idem("approve"),
    });
    invariant();

    const task = store.create({ projectId, kind: "task", title: "Build it", body: taskBody(), origin: person, idempotencyKey: idem("task") });
    invariant();

    store.link({
      projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "edge",
        relation: "implements",
        subject: { entityId: task.entity.entityId, revisionId: task.revision.revisionId },
        object: { entityId: item.entity.entityId, revisionId: revised.revision.revisionId },
      },
      origin: person,
      idempotencyKey: idem("edge"),
    });
    invariant();

    const decision = store.link({
      projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "decision",
        entityId: task.entity.entityId,
        revisionId: task.revision.revisionId,
        title: "One store, partitioned",
        rationale: "Cross-project search needs one file.",
        consequences: ["One migration story."],
      },
      origin: person,
      idempotencyKey: idem("decision"),
    });
    invariant();

    const capture = blob(JSON.stringify({ files: ["src/a.ts"] }), task.entity.entityId);
    const linkId = repositoryLink({ entityId: task.entity.entityId, revisionId: task.revision.revisionId }, repositoryId, capture.blobId);
    invariant();

    const corrected = blob(JSON.stringify({ files: ["src/a.ts", "src/b.ts"] }), task.entity.entityId);
    expect(store.attachCapture(projectId, linkId, corrected.blobId, capture.blobId, { gate: "A later gate" })).toBe(true);
    invariant();

    store.link({
      projectId,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "evidence",
        entityId: task.entity.entityId,
        revisionId: task.revision.revisionId,
        kind: "command_output",
        role: "supporting",
        summary: "The suite ran.",
        outcome: "passed",
      },
      origin: person,
      idempotencyKey: idem("evidence"),
    });
    invariant();

    store.linkExecution({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "session", targetId: "ses_1" },
      origin: person,
      idempotencyKey: idem("start"),
    });
    invariant();

    store.linkExecution({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      execution: { kind: "session", targetId: "ses_1", outcome: "completed", endedAt: new Date().toISOString() },
      origin: person,
      idempotencyKey: idem("end"),
    });
    invariant();

    store.taskAction({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      action: "block",
      origin: person,
      idempotencyKey: idem("action"),
    });
    invariant();

    store.archive({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: revised.revision.revisionId,
      archived: true,
      origin: person,
      idempotencyKey: idem("archive"),
    });
    invariant();

    if (decision.link.type !== "decision") throw new Error("fixture");
    store.unlink({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      linkId: decision.link.decision.decisionId,
      origin: person,
      idempotencyKey: idem("unlink"),
    });
    invariant();

    store.delete({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      origin: person,
      idempotencyKey: idem("delete"),
    });
    invariant();

    store.relinkProject(projectId, join(base, "alpha-moved"));
    invariant();
    store.removeProject(projectId);
    invariant();
  });

  it("returns the counters to where they were, apart from the receipts that outlive the item", () => {
    const repositoryId = repository();
    const before = store.usage(projectId);

    const task = store.create({ projectId, kind: "task", title: "Temporary", body: taskBody(), origin: person, idempotencyKey: idem("t") });
    const capture = blob("a capture of a change", task.entity.entityId);
    repositoryLink({ entityId: task.entity.entityId, revisionId: task.revision.revisionId }, repositoryId, capture.blobId);
    store.comment({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      revisionId: task.revision.revisionId,
      anchor: { kind: "whole" },
      text: "Something to say.",
      origin: person,
      idempotencyKey: idem("c"),
    });
    const peak = store.usage(projectId);
    expect(peak.projectBytes).toBeGreaterThan(before.projectBytes);

    store.delete({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      origin: person,
      idempotencyKey: idem("d"),
    });
    const after = store.usage(projectId);
    invariant();

    // What is left is exactly the idempotency receipts: they answer the same
    // key with the same result for ever, they are scoped to the project and
    // not to the item, and they are deliberately not deleted with it.
    const db = new DatabaseSync(file, { readOnly: true });
    const receipts = db.prepare("SELECT COALESCE(SUM(charged_bytes), 0) AS b, COUNT(*) AS n FROM idempotency WHERE project_id = ?").get(projectId) as {
      b: number;
      n: number;
    };
    const rows = db.prepare("SELECT COUNT(*) AS n FROM repository_link_captures WHERE project_id = ?").get(projectId) as { n: number };
    db.close();
    expect(after.projectBytes - before.projectBytes).toBe(Number(receipts.b));
    expect(after.records - before.records).toBe(Number(receipts.n));
    expect(after.entities).toBe(before.entities);
    // The capture history of the link that went is gone with it, not left
    // unreachable and charged for ever.
    expect(Number(rows.n)).toBe(0);
  });
});

describe("admission", () => {
  it("refuses at the project byte cap and writes nothing at all", () => {
    const small = new ProjectWorkStore({ file: join(base, "small.db"), quota: { projectBytes: 12 * 1024 } });
    try {
      const id = small.projectIdFor(join(base, "small"))!;
      const kept = small.create({ projectId: id, kind: "spec", title: "Small", body: specBody(), origin: person, idempotencyKey: "one" });
      const before = { ...small.usage(id), seq: small.seq(id) };

      const big = specBody();
      if (big.kind === "spec") big.spec.document = "x".repeat(30_000);
      let refusal: ProjectWorkQuotaError | undefined;
      try {
        small.create({ projectId: id, kind: "spec", title: "Too much", body: big, origin: person, idempotencyKey: "two" });
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal).toBeInstanceOf(ProjectWorkQuotaError);
      expect(refusal?.scope).toBe("project");
      expect(refusal?.measure).toBe("bytes");

      const after = small.usage(id);
      expect(after.projectBytes).toBe(before.projectBytes);
      expect(after.records).toBe(before.records);
      expect(after.entities).toBe(before.entities);
      expect(small.seq(id), "a refused write does not move the project's sequence").toBe(before.seq);
      expect(small.list({ projectId: id }).items.map((row) => row.key)).toEqual([kept.entity.key]);

      const raw = new DatabaseSync(join(base, "small.db"), { readOnly: true });
      const events = raw.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?").get(id) as { n: number };
      const receipt = raw.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE project_id = ? AND key = 'two'").get(id) as { n: number };
      const revisions = raw.prepare("SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?").get(id) as { n: number };
      raw.close();
      expect(Number(events.n), "no event for a write that did not happen").toBe(1);
      expect(Number(receipt.n), "and no receipt, so the key is free to retry").toBe(0);
      expect(Number(revisions.n)).toBe(1);

      // The same key succeeds once there is room for it.
      const room = small.create({ projectId: id, kind: "spec", title: "Fits", body: specBody(), origin: person, idempotencyKey: "two" });
      expect(room.entity.key).toBe("SPEC-2");
      invariant(small, id);
    } finally {
      small.close();
    }
  });

  it("refuses at the global byte cap and names another project, leaving this one's counters alone", () => {
    const shared = new ProjectWorkStore({ file: join(base, "shared.db"), quota: { globalBytes: 24 * 1024 } });
    try {
      const first = shared.projectIdFor(join(base, "one"))!;
      const second = shared.projectIdFor(join(base, "two"))!;
      shared.create({ projectId: first, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "a" });
      const before = shared.usage(second);

      const big = specBody();
      if (big.kind === "spec") big.spec.document = "y".repeat(40_000);
      let refusal: ProjectWorkQuotaError | undefined;
      try {
        shared.create({ projectId: second, kind: "spec", title: "Too much", body: big, origin: person, idempotencyKey: "b" });
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal?.scope).toBe("global");
      expect(refusal?.recovery).toContain("another project");
      expect(shared.usage(second).projectBytes).toBe(before.projectBytes);
      invariant(shared, first);
      invariant(shared, second);
    } finally {
      shared.close();
    }
  });

  it("refuses at a record count without ever calling a count a number of bytes", () => {
    const counted = new ProjectWorkStore({ file: join(base, "counted.db"), quota: { projectRecords: 6 } });
    try {
      const id = counted.projectIdFor(join(base, "counted"))!;
      // Two rows for the project's identity, then a create costs four more.
      expect(counted.usage(id).records).toBe(2);
      let refusal: ProjectWorkQuotaError | undefined;
      try {
        for (let i = 0; i < 5; i++) {
          counted.create({ projectId: id, kind: "spec", title: `Item ${String(i)}`, body: specBody(), origin: person, idempotencyKey: `k${String(i)}` });
        }
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal).toBeInstanceOf(ProjectWorkQuotaError);
      expect(refusal?.measure).toBe("records");
      expect(refusal?.limitCount).toBe(6);
      expect(refusal?.usedCount).toBeGreaterThan(6);
      // The byte numbers stay byte numbers: a count is never reported as one.
      expect(refusal?.limitBytes).toBe(counted.usage(id).limits.projectBytes);
      expect(refusal?.usedBytes).toBe(counted.usage(id).projectBytes);
      expect(refusal?.message).toContain("saved records");
      expect(refusal?.message).not.toContain("MB");
      expect(counted.usage(id).records).toBeLessThanOrEqual(6);
      invariant(counted, id);
    } finally {
      counted.close();
    }
  });

  it("refuses at the global record count across projects", () => {
    const counted = new ProjectWorkStore({ file: join(base, "global-records.db"), quota: { globalRecords: 5 } });
    try {
      const first = counted.projectIdFor(join(base, "g1"))!;
      let refusal: ProjectWorkQuotaError | undefined;
      try {
        counted.projectIdFor(join(base, "g2"));
        counted.projectIdFor(join(base, "g3"));
        counted.projectIdFor(join(base, "g4"));
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal?.scope).toBe("global");
      expect(refusal?.measure).toBe("records");
      expect(refusal?.limitCount).toBe(5);
      invariant(counted, first);
    } finally {
      counted.close();
    }
  });

  it("refuses at the item cap in words that do not offer archiving as a way to free space", () => {
    const few = new ProjectWorkStore({ file: join(base, "few.db"), quota: { projectEntities: 1 } });
    try {
      const id = few.projectIdFor(join(base, "few"))!;
      few.create({ projectId: id, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "a" });
      let refusal: ProjectWorkQuotaError | undefined;
      try {
        few.create({ projectId: id, kind: "spec", title: "Two", body: specBody(), origin: person, idempotencyKey: "b" });
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal?.measure).toBe("entities");
      expect(refusal?.limitCount).toBe(1);
      expect(refusal?.recovery).toContain("Archiving an item hides it and keeps its history");
      expect(refusal?.recovery).not.toMatch(/^Archive/);
      invariant(few, id);
    } finally {
      few.close();
    }
  });

  it("replays a repeated key without charging twice", () => {
    const item = spec();
    const before = store.usage(projectId);
    const again = store.create({
      projectId,
      kind: "spec",
      title: "Phone review",
      body: specBody(),
      origin: person,
      idempotencyKey: (store.usage(projectId), lastKey()),
    });
    expect(again.replayed).toBe(true);
    expect(again.entity.entityId).toBe(item.entity.entityId);
    const after = store.usage(projectId);
    expect(after.projectBytes).toBe(before.projectBytes);
    expect(after.records).toBe(before.records);
    invariant();
  });

  it("lets an over-cap store shrink, even though the deletion writes a receipt of its own", () => {
    const roomy = join(base, "over.db");
    const first = new ProjectWorkStore({ file: roomy });
    const id = first.projectIdFor(join(base, "over"))!;
    const kept = first.create({ projectId: id, kind: "spec", title: "Kept", body: specBody(), origin: person, idempotencyKey: "keep" });
    const doomed = first.create({ projectId: id, kind: "spec", title: "Doomed", body: specBody("A body that is going away."), origin: person, idempotencyKey: "doom" });
    const used = first.usage(id).projectBytes;
    first.close();

    // Reopened under a cap it is already past — the shape of a store whose
    // metadata has just started being counted.
    const tight = new ProjectWorkStore({ file: roomy, quota: { projectBytes: Math.floor(used / 2) } });
    try {
      expect(tight.usage(id).projectBytes).toBeGreaterThan(tight.usage(id).limits.projectBytes);
      // Reads still work: nothing was evicted to get under the cap.
      expect(tight.get({ projectId: id, entityId: kept.entity.entityId }).body?.body).toEqual(specBody());
      // Growth is refused…
      expect(() =>
        tight.create({ projectId: id, kind: "spec", title: "More", body: specBody(), origin: person, idempotencyKey: "more" }),
      ).toThrow(ProjectWorkQuotaError);
      // …and a net-shrinking deletion is admitted, even though it writes its
      // own receipt after the credits and even though the store is still over
      // the cap when it finishes.
      const removed = tight.delete({
        projectId: id,
        entityId: doomed.entity.entityId,
        expectedRevisionId: doomed.revision.revisionId,
        origin: person,
        idempotencyKey: "cleanup",
      });
      expect(removed.deleted).toBe(true);
      expect(tight.usage(id).projectBytes).toBeLessThan(used);
      invariant(tight, id);
    } finally {
      tight.close();
    }
  });

  it("releases nothing canonical when it refuses", () => {
    const small = new ProjectWorkStore({ file: join(base, "noevict.db"), quota: { projectBytes: 16 * 1024 } });
    try {
      const id = small.projectIdFor(join(base, "noevict"))!;
      const item = small.create({ projectId: id, kind: "spec", title: "Kept", body: specBody(), origin: person, idempotencyKey: "a" });
      small.comment({
        projectId: id,
        entityId: item.entity.entityId,
        expectedRevisionId: item.revision.revisionId,
        revisionId: item.revision.revisionId,
        anchor: { kind: "whole" },
        text: "Review history that must survive a full budget.",
        origin: person,
        idempotencyKey: "b",
      });
      small.putBlob({ projectId: id, entityId: item.entity.entityId, mediaType: "text/plain", data: Buffer.from("evidence") });

      const snapshot = (): string => {
        const db = new DatabaseSync(join(base, "noevict.db"), { readOnly: true });
        const rows = CANONICAL_TABLES.map((table) => {
          const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(charged_bytes), 0) AS b FROM ${table} WHERE project_id = ?`).get(id) as {
            n: number;
            b: number;
          };
          return `${table}:${String(row.n)}:${String(row.b)}`;
        }).join("|");
        const released = db.prepare("SELECT COUNT(*) AS n FROM blobs WHERE project_id = ? AND released IS NOT NULL").get(id) as { n: number };
        db.close();
        return `${rows}|released:${String(released.n)}`;
      };
      const before = snapshot();

      const big = specBody();
      if (big.kind === "spec") big.spec.document = "z".repeat(40_000);
      expect(() => small.create({ projectId: id, kind: "spec", title: "Too much", body: big, origin: person, idempotencyKey: "c" })).toThrow(
        ProjectWorkQuotaError,
      );
      expect(snapshot(), "a refusal frees nothing: canonical work is never evicted").toBe(before);
    } finally {
      small.close();
    }
  });

  it("tells the truth about evidence a gate already kept when the decision itself is refused", () => {
    const small = new ProjectWorkStore({ file: join(base, "gate.db"), quota: { projectBytes: 20 * 1024 } });
    try {
      const id = small.projectIdFor(join(base, "gate"))!;
      const item = small.create({ projectId: id, kind: "spec", title: "Brief", body: specBody(), origin: person, idempotencyKey: "a" });
      small.review({
        projectId: id,
        entityId: item.entity.entityId,
        expectedRevisionId: item.revision.revisionId,
        action: "request_review",
        origin: person,
        idempotencyKey: "r",
      });
      // The gate's own earlier transaction: the capture is durable before the
      // decision is attempted, and it stays durable when the decision fails.
      const capture = small.putBlob({
        projectId: id,
        entityId: item.entity.entityId,
        mediaType: "application/json",
        data: Buffer.from("x".repeat(8 * 1024)),
      });
      let refusal: ProjectWorkQuotaError | undefined;
      try {
        small.approve({
          projectId: id,
          entityId: item.entity.entityId,
          expectedRevisionId: item.revision.revisionId,
          gate: "brief",
          decision: "approved",
          covers: [
            {
              entityId: item.entity.entityId,
              kind: "spec",
              key: item.entity.key,
              revisionId: item.revision.revisionId,
              digest: item.revision.digest,
            },
          ],
          note: "n".repeat(12 * 1024),
          proof: { gate: "Approving the brief", refs: [] },
          origin: person,
          idempotencyKey: "approve",
        });
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal).toBeInstanceOf(ProjectWorkQuotaError);
      expect(refusal?.recovery).toContain("Approving the brief");
      expect(refusal?.recovery).toContain("is kept and can still be read");
      expect(refusal?.recovery, "a preparation in an earlier transaction was not rolled back").not.toContain("Nothing from this action was saved");
      expect(refusal?.recovery).toContain("Archiving an item hides it and keeps its history");
      // And the capture really is still there.
      expect(small.readBlob({ projectId: id, blobId: capture.blobId, offset: 0, limit: 1 })?.released).toBeUndefined();
      expect(small.get({ projectId: id, entityId: item.entity.entityId }).entity.state).toBe("needs_review");
      invariant(small, id);
    } finally {
      small.close();
    }
  });
});

describe("explicit deletion", () => {
  it("refuses to delete an item whose capture another item's record is proved by", () => {
    const repositoryId = repository();
    const holder = store.create({ projectId, kind: "task", title: "Holds the proof", body: taskBody(), origin: person, idempotencyKey: idem("h") });
    const other = store.create({ projectId, kind: "task", title: "Rests on it", body: taskBody(), origin: person, idempotencyKey: idem("o") });
    const capture = blob("the capture the other record is proved by", holder.entity.entityId);
    repositoryLink({ entityId: other.entity.entityId, revisionId: other.revision.revisionId }, repositoryId, capture.blobId);

    expect(() =>
      store.delete({
        projectId,
        entityId: holder.entity.entityId,
        expectedRevisionId: holder.revision.revisionId,
        origin: person,
        idempotencyKey: idem("del"),
      }),
    ).toThrow(/proved by a capture this one holds/);
    // Nothing was taken away from either item.
    expect(store.get({ projectId, entityId: holder.entity.entityId }).entity.key).toBe(holder.entity.key);
    expect(store.get({ projectId, entityId: other.entity.entityId }).repositoryLinks).toHaveLength(1);
    invariant();
  });

  it("refuses to delete an item whose link another item's approval was decided on", () => {
    const repositoryId = repository();
    const holder = store.create({ projectId, kind: "task", title: "Holds the proof", body: taskBody(), origin: person, idempotencyKey: idem("h") });
    const capture = blob("the capture the approval was made on", holder.entity.entityId);
    const linkId = repositoryLink({ entityId: holder.entity.entityId, revisionId: holder.revision.revisionId }, repositoryId, capture.blobId);
    const association = store.captureHistoryPage(projectId, { of: "associations", linkId, linkIds: [linkId] }).associations[0]!;

    const other = store.create({ projectId, kind: "spec", title: "Approved on it", body: specBody(), origin: person, idempotencyKey: idem("o") });
    store.review({
      projectId,
      entityId: other.entity.entityId,
      expectedRevisionId: other.revision.revisionId,
      action: "request_review",
      origin: person,
      idempotencyKey: idem("rr"),
    });
    store.approve({
      projectId,
      entityId: other.entity.entityId,
      expectedRevisionId: other.revision.revisionId,
      gate: "brief",
      decision: "approved",
      covers: [
        {
          entityId: other.entity.entityId,
          kind: "spec",
          key: other.entity.key,
          revisionId: other.revision.revisionId,
          digest: other.revision.digest,
        },
      ],
      proof: {
        gate: "Approving the brief",
        refs: [{ linkId, blobId: capture.blobId, associationRevisionId: association.revisionId, associationSeq: association.seq }],
      },
      origin: person,
      idempotencyKey: idem("ap"),
    });

    expect(() =>
      store.delete({
        projectId,
        entityId: holder.entity.entityId,
        expectedRevisionId: holder.revision.revisionId,
        origin: person,
        idempotencyKey: idem("del"),
      }),
    ).toThrow(/approval was decided on evidence this one holds/);

    // The binding is still exactly what it was: nothing was dropped to let
    // the deletion through, and nothing points at missing proof.
    const db = new DatabaseSync(file, { readOnly: true });
    const bound = db.prepare("SELECT link_id, blob_id FROM decision_capture_bindings WHERE project_id = ?").all(projectId) as Array<{
      link_id: string;
      blob_id: string;
    }>;
    db.close();
    expect(bound.map((binding) => binding.link_id)).toEqual([linkId]);
    expect(bound[0]?.blob_id).toBe(capture.blobId);
    expect(store.readBlob({ projectId, blobId: capture.blobId, offset: 0, limit: 1 })?.released).toBeUndefined();
    invariant();
  });

  it("refuses to delete an item another item's evidence points at, and never drops that binding quietly", () => {
    const repositoryId = repository();
    const holder = store.create({ projectId, kind: "task", title: "Holds the link", body: taskBody(), origin: person, idempotencyKey: idem("h") });
    const other = store.create({ projectId, kind: "task", title: "Names it", body: taskBody(), origin: person, idempotencyKey: idem("o") });
    const linkId = repositoryLink({ entityId: holder.entity.entityId, revisionId: holder.revision.revisionId }, repositoryId);
    store.link({
      projectId,
      expectedRevisionId: other.revision.revisionId,
      link: {
        type: "evidence",
        entityId: other.entity.entityId,
        revisionId: other.revision.revisionId,
        kind: "command_output",
        role: "supporting",
        summary: "Checked against that state.",
        outcome: "passed",
        repositoryLinkId: linkId,
      },
      origin: person,
      idempotencyKey: idem("ev"),
    });

    expect(() =>
      store.delete({
        projectId,
        entityId: holder.entity.entityId,
        expectedRevisionId: holder.revision.revisionId,
        origin: person,
        idempotencyKey: idem("del"),
      }),
    ).toThrow(/Another item's evidence points at a record this one holds/);
    expect(store.get({ projectId, entityId: other.entity.entityId }).evidence).toHaveLength(1);
    invariant();
  });

  it("takes an item's own capture history and proof bindings with it, and credits them", () => {
    const repositoryId = repository();
    const task = store.create({ projectId, kind: "task", title: "Own history", body: taskBody(), origin: person, idempotencyKey: idem("t") });
    const capture = blob("its own capture", task.entity.entityId);
    const linkId = repositoryLink({ entityId: task.entity.entityId, revisionId: task.revision.revisionId }, repositoryId, capture.blobId);
    const second = blob("a corrected capture", task.entity.entityId);
    expect(store.attachCapture(projectId, linkId, second.blobId, capture.blobId, { gate: "A gate" })).toBe(true);

    const db = () => new DatabaseSync(file, { readOnly: true });
    const before = db();
    const associations = before.prepare("SELECT COUNT(*) AS n FROM repository_link_captures WHERE project_id = ?").get(projectId) as { n: number };
    before.close();
    expect(Number(associations.n)).toBe(2);

    store.delete({
      projectId,
      entityId: task.entity.entityId,
      expectedRevisionId: task.revision.revisionId,
      origin: person,
      idempotencyKey: idem("del"),
    });

    const after = db();
    const left = after.prepare("SELECT COUNT(*) AS n FROM repository_link_captures WHERE project_id = ?").get(projectId) as { n: number };
    const blobs = after.prepare("SELECT COUNT(*) AS n FROM blobs WHERE project_id = ?").get(projectId) as { n: number };
    after.close();
    expect(Number(left.n), "unreachable history is not left behind, charged for ever").toBe(0);
    expect(Number(blobs.n)).toBe(0);
    invariant();
  });
});

describe("the v5 → v6 upgrade", () => {
  /** A database in the shape v5 left behind: no charges, body-only counters. */
  function rewindToV5(path: string): { bytes: number; rows: Map<string, number> } {
    const db = new DatabaseSync(path);
    const rows = new Map<string, number>();
    for (const table of [...CANONICAL_TABLES, ...BOOKKEEPING_TABLES, ...DERIVED_TABLES]) {
      rows.set(table, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n));
    }
    for (const table of CANONICAL_TABLES) db.exec(`ALTER TABLE ${table} DROP COLUMN charged_bytes`);
    db.exec("ALTER TABLE projects DROP COLUMN record_count");
    const bodies = db.prepare("SELECT COALESCE(SUM(body_bytes), 0) AS n FROM revisions").get() as { n: number };
    const payloads = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM blobs WHERE released IS NULL").get() as { n: number };
    const bytes = Number(bodies.n) + Number(payloads.n);
    db.prepare("UPDATE projects SET bytes = ?").run(bytes);
    db.exec("PRAGMA user_version = 5");
    db.close();
    return { bytes, rows };
  }

  it("counts an existing store's metadata without deleting a row or charging a byte twice", () => {
    const path = join(base, "upgrade.db");
    const old = new ProjectWorkStore({ file: path });
    const id = old.projectIdFor(join(base, "upgrade"))!;
    const item = old.create({ projectId: id, kind: "spec", title: "Existing", body: specBody(), origin: person, idempotencyKey: "a" });
    old.comment({
      projectId: id,
      entityId: item.entity.entityId,
      expectedRevisionId: item.revision.revisionId,
      revisionId: item.revision.revisionId,
      anchor: { kind: "whole" },
      text: "History from before the repair.",
      origin: person,
      idempotencyKey: "b",
    });
    old.putBlob({ projectId: id, entityId: item.entity.entityId, mediaType: "text/plain", data: Buffer.from("frozen capture bytes") });
    old.close();

    const v5 = rewindToV5(path);

    const logs: string[] = [];
    const upgraded = new ProjectWorkStore({ file: path, log: (message) => logs.push(message) });
    try {
      expect(existsSync(`${path}.v5.backup`), "the file is copied before it is changed").toBe(true);
      // Every row survived.
      const db = new DatabaseSync(path, { readOnly: true });
      for (const [table, count] of v5.rows) {
        expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n), `${table} kept its rows`).toBe(count);
      }
      db.close();

      const usage = upgraded.usage(id);
      expect(usage.projectBytes, "metadata was never counted before, so the total grows").toBeGreaterThan(v5.bytes);
      expect(usage.records).toBeGreaterThan(0);
      invariant(upgraded, id);
      expect(logs.some((line) => line.includes("counted") && line.includes("records"))).toBe(true);
      upgraded.close();

      // Opening it again changes nothing: the recompute replaces, it never adds.
      const again = new ProjectWorkStore({ file: path });
      try {
        expect(again.usage(id).projectBytes).toBe(usage.projectBytes);
        expect(again.usage(id).records).toBe(usage.records);
        invariant(again, id);
      } finally {
        again.close();
      }
    } finally {
      try {
        upgraded.close();
      } catch {
        /* already closed above */
      }
    }
  });

  it("stays readable and refuses only growth when the upgrade leaves it over the cap", () => {
    const path = join(base, "overcap.db");
    const old = new ProjectWorkStore({ file: path });
    const id = old.projectIdFor(join(base, "overcap"))!;
    const item = old.create({ projectId: id, kind: "spec", title: "Existing", body: specBody(), origin: person, idempotencyKey: "a" });
    old.close();
    const v5 = rewindToV5(path);

    // A cap that the body-only total fitted inside and the real total does not.
    const upgraded = new ProjectWorkStore({ file: path, quota: { projectBytes: v5.bytes + 64 } });
    try {
      expect(upgraded.usage(id).projectBytes).toBeGreaterThan(upgraded.usage(id).limits.projectBytes);
      expect(upgraded.get({ projectId: id, entityId: item.entity.entityId }).body?.body, "every row stays readable").toEqual(specBody());
      expect(() =>
        upgraded.create({ projectId: id, kind: "spec", title: "More", body: specBody(), origin: person, idempotencyKey: "b" }),
      ).toThrow(ProjectWorkQuotaError);
      const removed = upgraded.delete({
        projectId: id,
        entityId: item.entity.entityId,
        expectedRevisionId: item.revision.revisionId,
        origin: person,
        idempotencyKey: "c",
      });
      expect(removed.deleted, "and an explicit deletion can bring it back under").toBe(true);
      invariant(upgraded, id);
    } finally {
      upgraded.close();
    }
  });
});

describe("classification", () => {
  it("puts every table this store keeps in exactly one class", () => {
    spec();
    const db = new DatabaseSync(file, { readOnly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    const classes = [CANONICAL_TABLES, BOOKKEEPING_TABLES, DERIVED_TABLES, UNPARTITIONED_TABLES] as ReadonlyArray<readonly string[]>;
    for (const table of tables) {
      const hits = classes.filter((list) => list.includes(table));
      expect(hits, `${table} must be classified exactly once — a new table is not free by default`).toHaveLength(1);
    }
    // And every table a class names really exists.
    for (const list of classes) for (const table of list) expect(tables, `${table} is named by a class but is not in the schema`).toContain(table);

    // The partitioned tables that are not charged are the two derived ones and
    // the one bounded bookkeeping table, and nothing else.
    const partitioned = tables.filter((table) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return columns.some((column) => column.name === "project_id");
    });
    db.close();
    const uncharged = partitioned.filter((table) => !(CANONICAL_TABLES as readonly string[]).includes(table));
    expect(uncharged.sort()).toEqual([...BOOKKEEPING_TABLES, ...DERIVED_TABLES].sort());
  });

  it("keeps the documented default ceilings exactly where they were", () => {
    const limits = store.usage(projectId).limits;
    expect(limits.projectBytes).toBe(512 * 1024 * 1024);
    expect(limits.globalBytes).toBe(4 * 1024 * 1024 * 1024);
    expect(limits.projectEntities).toBe(20_000);
    expect(limits.projectRecords).toBe(200_000);
    expect(limits.globalRecords).toBe(1_000_000);
  });
});

/** The key the last `spec()` used, for the replay test. */
function lastKey(): string {
  return `create-${String(keys)}`;
}
