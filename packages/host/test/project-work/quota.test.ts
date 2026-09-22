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
  CHARGE_SCAN_BATCH_ROWS,
  DERIVED_TABLES,
  UNPARTITIONED_TABLES,
  ROW_OVERHEAD_BYTES,
  chargeExpression,
  recomputeProjectUsage,
  rechargeProject,
  rowCharge,
  scanChargedRows,
  type CanonicalTable,
} from "../../src/project-work/accounting.js";
import { ProjectWorkUnavailableError } from "../../src/project-work/errors.js";
import type { ProjectWorkDatabase } from "../../src/project-work/schema.js";
import { ProjectWorkQuotaError, ProjectWorkRefusedError } from "../../src/project-work/errors.js";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { storeReport } from "../../src/project-work/verification/report.js";
import { CHECKPOINT_REF_NAMESPACE } from "@lasercode/protocol";
import { agent, person, specBody, taskBody } from "./fixtures.js";

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

  it("keeps a receipt immutable: a second one for the same key cannot re-price the first", () => {
    const item = spec();
    const before = store.usage(projectId);
    const db = new DatabaseSync(file);
    const key = lastKey();
    const stored = db
      .prepare("SELECT result_json, at, charged_bytes FROM idempotency WHERE project_id = ? AND method = ? AND key = ?")
      .get(projectId, "project/work/create", key) as { result_json: string; at: string; charged_bytes: number };
    expect(Number(stored.charged_bytes), "the receipt of that create is charged").toBeGreaterThan(0);
    // `once()` replays an existing receipt before any work is done, so the
    // store cannot reach a second `remember` for one key — this is the
    // constraint that makes it a rolled-back failure if it ever could, rather
    // than a `REPLACE` that resets the charge already in the counters.
    // Written from a second connection because the store's own door is the
    // one that will not go there (storage review M-1).
    expect(() =>
      db
        .prepare("INSERT INTO idempotency (project_id, method, key, result_json, at) VALUES (?,?,?,?,?)")
        .run(projectId, "project/work/create", key, "{\"different\":true}", "2026-02-02T00:00:00.000Z"),
    ).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    const after = db
      .prepare("SELECT result_json, at, charged_bytes FROM idempotency WHERE project_id = ? AND method = ? AND key = ?")
      .get(projectId, "project/work/create", key) as { result_json: string; at: string; charged_bytes: number };
    db.close();
    expect(after.result_json, "the receipt answers the same key with the same result, for ever").toBe(stored.result_json);
    expect(after.at).toBe(stored.at);
    expect(Number(after.charged_bytes), "and its charge was not reset").toBe(Number(stored.charged_bytes));
    // The ordinary replay is untouched by any of this: no mutation, no charge.
    const again = store.create({ projectId, kind: "spec", title: "Phone review", body: specBody(), origin: person, idempotencyKey: key });
    expect(again.replayed).toBe(true);
    expect(again.entity.entityId).toBe(item.entity.entityId);
    expect(store.usage(projectId).projectBytes).toBe(before.projectBytes);
    expect(store.usage(projectId).records).toBe(before.records);
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

  /** A project with a gate that has already stored its capture, ready to decide. */
  function preparedDecision(name: string): { path: string; id: string; item: ReturnType<ProjectWorkStore["create"]>; capture: { blobId: string; bytes: number }; globalBytes: number; globalRecords: number } {
    const path = join(base, `${name}.db`);
    const first = new ProjectWorkStore({ file: path });
    const id = first.projectIdFor(join(base, name))!;
    const item = first.create({ projectId: id, kind: "spec", title: "Brief", body: specBody(), origin: person, idempotencyKey: "a" });
    first.review({
      projectId: id,
      entityId: item.entity.entityId,
      expectedRevisionId: item.revision.revisionId,
      action: "request_review",
      origin: person,
      idempotencyKey: "r",
    });
    // The gate's own earlier transaction. It is durable before the decision is
    // attempted, whichever budget the decision then runs into.
    const capture = first.putBlob({
      projectId: id,
      entityId: item.entity.entityId,
      mediaType: "application/json",
      data: Buffer.from("x".repeat(4 * 1024)),
    });
    const usage = first.usage(id);
    first.close();
    return { path, id, item, capture, globalBytes: usage.globalBytes, globalRecords: usage.globalRecords };
  }

  /** Approve the prepared decision, and hand back whatever it refused with. */
  function approvePrepared(target: ProjectWorkStore, id: string, item: ReturnType<ProjectWorkStore["create"]>): ProjectWorkQuotaError {
    try {
      target.approve({
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
        note: "n".repeat(8 * 1024),
        proof: { gate: "Approving the brief", refs: [] },
        origin: person,
        idempotencyKey: "approve",
      });
    } catch (error) {
      return error as ProjectWorkQuotaError;
    }
    throw new Error("that approval was expected to be refused");
  }

  /** The prepared-decision truth, whichever ceiling the refusal reached. */
  function preparedTruth(refusal: ProjectWorkQuotaError): void {
    expect(refusal).toBeInstanceOf(ProjectWorkQuotaError);
    expect(refusal.scope).toBe("global");
    expect(refusal.recovery).toContain("Approving the brief");
    expect(refusal.recovery).toContain("is kept and can still be read");
    expect(refusal.recovery, "a preparation in an earlier transaction was not rolled back").not.toContain("Nothing from this action was saved");
    expect(refusal.recovery, "and the room to make is in another project, not this one").toContain("from another project");
    expect(refusal.recovery).toContain("Archiving an item hides it and keeps its history");
  }

  it("keeps the preparation's truth when it is the whole app's byte budget that is full", () => {
    const prepared = preparedDecision("global-gate");
    // Only the global ceiling bites: this project's own byte cap is untouched.
    const tight = new ProjectWorkStore({ file: prepared.path, quota: { globalBytes: prepared.globalBytes + 1024 } });
    try {
      const seq = tight.seq(prepared.id);
      const refusal = approvePrepared(tight, prepared.id, prepared.item);
      preparedTruth(refusal);
      expect(refusal.measure).toBe("bytes");
      // The decision itself rolled back — receipt, event and sequence with it —
      // and the evidence the gate prepared is exactly where it was.
      expect(tight.get({ projectId: prepared.id, entityId: prepared.item.entity.entityId }).approvals).toHaveLength(0);
      expect(tight.get({ projectId: prepared.id, entityId: prepared.item.entity.entityId }).entity.state).toBe("needs_review");
      expect(tight.seq(prepared.id)).toBe(seq);
      expect(tight.readBlob({ projectId: prepared.id, blobId: prepared.capture.blobId, offset: 0, limit: 8 })?.totalBytes).toBe(prepared.capture.bytes);
      invariant(tight, prepared.id);
    } finally {
      tight.close();
    }
  });

  it("keeps the preparation's truth when it is the whole app's record count that is full", () => {
    const prepared = preparedDecision("global-records");
    const tight = new ProjectWorkStore({ file: prepared.path, quota: { globalRecords: prepared.globalRecords + 1 } });
    try {
      const refusal = approvePrepared(tight, prepared.id, prepared.item);
      preparedTruth(refusal);
      expect(refusal.measure).toBe("records");
      expect(refusal.limitCount).toBe(prepared.globalRecords + 1);
      expect(refusal.usedCount, "a count is never reported as a number of bytes").toBeGreaterThan(prepared.globalRecords);
      expect(tight.get({ projectId: prepared.id, entityId: prepared.item.entity.entityId }).approvals).toHaveLength(0);
      expect(tight.readBlob({ projectId: prepared.id, blobId: prepared.capture.blobId, offset: 0, limit: 8 })?.totalBytes).toBe(prepared.capture.bytes);
      invariant(tight, prepared.id);
    } finally {
      tight.close();
    }
  });
});

/**
 * Every other door that consumes bytes an **earlier** transaction stored
 * (storage review H-1).
 *
 * Approving and completing were covered above; these four are the rest of
 * them, and each one was refusing with "Nothing from this action was saved"
 * while the capture or the report it was about sat readable in the store:
 *
 * - accepting a delivery, whose capture the gate stores first;
 * - recording or accepting a verified state, whose capture the host takes
 *   before it validates anything else;
 * - correcting which capture a record points at;
 * - saving any record that names a blob already in the project — a
 *   verification report is the one this store writes today, and the door is
 *   tested through the real producer rather than through a lookalike.
 *
 * Each is proved at all four ceilings: this project's bytes and records, and
 * the whole app's.
 */
describe("a write whose evidence was stored before it", () => {
  type Usage = ReturnType<ProjectWorkStore["usage"]>;

  /** The four ceilings such a write can run into, each tightened to the bone. */
  const CEILINGS = [
    {
      at: "this project's bytes",
      scope: "project" as const,
      measure: "bytes" as const,
      room: "some of this project's saved work",
      quota: (usage: Usage) => ({ projectBytes: usage.projectBytes }),
    },
    {
      at: "this project's record count",
      scope: "project" as const,
      measure: "records" as const,
      room: "some of this project's saved work",
      quota: (usage: Usage) => ({ projectRecords: usage.records }),
    },
    {
      at: "the whole app's bytes",
      scope: "global" as const,
      measure: "bytes" as const,
      room: "from another project",
      quota: (usage: Usage) => ({ globalBytes: usage.globalBytes }),
    },
    {
      at: "the whole app's record count",
      scope: "global" as const,
      measure: "records" as const,
      room: "from another project",
      quota: (usage: Usage) => ({ globalRecords: usage.globalRecords }),
    },
  ];

  const STATE = { vcs: "git", objectFormat: "sha1", commitObjectId: "a".repeat(40) } as const;
  const CHANGE = {
    base: STATE,
    head: { vcs: "git", objectFormat: "sha1", commitObjectId: "b".repeat(40) },
    diffDigest: "c".repeat(64),
  } as const;

  interface Prepared {
    path: string;
    id: string;
    task: ReturnType<ProjectWorkStore["create"]>;
    repositoryId: string;
    /** A repository link with no capture yet, for the correction door. */
    linkId: string;
    /** The bytes a gate stored before the write under test. */
    capture: { blobId: string; bytes: number };
    /** The report blob the first run stored, which a second run re-uses. */
    reportBlobId: string;
    usage: Usage;
  }

  /** The report a run writes: a blob, and then the record that names it. */
  function reportInput(target: ProjectWorkStore, prepared: Prepared, idempotencyKey: string): Parameters<typeof storeReport>[0] {
    const task = {
      authority: "task" as const,
      entityId: prepared.task.entity.entityId,
      kind: "task" as const,
      key: prepared.task.entity.key,
      revisionId: prepared.task.revision.revisionId,
      digest: prepared.task.revision.digest,
      title: prepared.task.entity.title,
    };
    return {
      store: target,
      projectId: prepared.id,
      entityId: prepared.task.entity.entityId,
      expectedRevisionId: prepared.task.revision.revisionId,
      plan: { task, authorities: [task], criteria: [], commands: [], blockers: [], truncated: [] },
      evaluation: { findings: [], blockers: [], personDecisions: [], converged: false, outcome: "failed" },
      commands: [],
      deviations: [],
      runId: "run_fixed_for_dedup",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      origin: agent,
      idempotencyKey,
    };
  }

  /** A project seeded to the moment before each door's write. */
  function prepare(name: string): Prepared {
    const path = join(base, `${name}.db`);
    const seed = new ProjectWorkStore({ file: path });
    const id = seed.projectIdFor(join(base, name))!;
    const repositoryId = seed.ensureRepository({ projectId: id, name: "app", gitCommonDir: join(base, name, "app", ".git") });
    const task = seed.create({ projectId: id, kind: "task", title: "Ship the footer", body: taskBody(), origin: person, idempotencyKey: "seed-task" });
    const written = seed.link({
      projectId: id,
      expectedRevisionId: task.revision.revisionId,
      link: {
        type: "repository",
        relation: "based_on",
        subjectEntityId: task.entity.entityId,
        subjectRevisionId: task.revision.revisionId,
        repositoryId,
        target: { state: STATE },
      },
      origin: person,
      idempotencyKey: "seed-link",
    });
    if (written.link.type !== "repository") throw new Error("fixture");
    // The gate's own earlier transaction: durable before any of these writes
    // is attempted, and still durable when one of them is refused.
    const capture = seed.putBlob({
      projectId: id,
      entityId: task.entity.entityId,
      mediaType: "application/json",
      data: Buffer.from("x".repeat(4 * 1024)),
    });
    const prepared: Prepared = {
      path,
      id,
      task,
      repositoryId,
      linkId: written.link.repository.linkId,
      capture,
      reportBlobId: "",
      usage: seed.usage(id),
    };
    // One run's report, stored and recorded. Its blob is what a second run of
    // the same report finds already there, the way deduplication intends.
    prepared.reportBlobId = storeReport(reportInput(seed, prepared, "seed-report")).blobId;
    prepared.usage = seed.usage(id);
    seed.close();
    return prepared;
  }

  interface Door {
    name: string;
    kept: string;
    refused: string;
    retry: string;
    /** Make the write, with everything it needs already stored. */
    attempt: (target: ProjectWorkStore, prepared: Prepared) => void;
    /** What must not be there afterwards. */
    rolledBack: (target: ProjectWorkStore, prepared: Prepared) => void;
  }

  const DOORS: Door[] = [
    {
      name: "accepting a delivery",
      kept: "The evidence this delivery was checked against is kept and can still be read",
      refused: "the delivery itself was not accepted",
      retry: "accept it again",
      attempt: (target, prepared) => {
        target.link({
          projectId: prepared.id,
          expectedRevisionId: prepared.task.revision.revisionId,
          link: {
            type: "delivery",
            entityId: prepared.task.entity.entityId,
            revisionId: prepared.task.revision.revisionId,
            repositoryId: prepared.repositoryId,
            change: CHANGE,
            confirm: true,
          },
          capture: { blobId: prepared.capture.blobId, bytes: prepared.capture.bytes, files: 1, sources: 1 },
          origin: person,
          idempotencyKey: "accept-delivery",
        });
      },
      rolledBack: (target, prepared) => {
        const links = target.get({ projectId: prepared.id, entityId: prepared.task.entity.entityId }).repositoryLinks;
        expect(links.filter((link) => link.relation === "implemented_by"), "no delivery was accepted").toHaveLength(0);
      },
    },
    {
      name: "recording a verified state",
      kept: "The evidence Accepting this preview prepared is kept and can still be read",
      refused: "the record of it was not saved",
      retry: "record it again",
      attempt: (target, prepared) => {
        target.link({
          projectId: prepared.id,
          expectedRevisionId: prepared.task.revision.revisionId,
          link: {
            type: "evidence",
            entityId: prepared.task.entity.entityId,
            revisionId: prepared.task.revision.revisionId,
            kind: "screenshot",
            role: "supporting",
            summary: "What the checkpoint looked like",
            outcome: "passed",
            verifiedAt: { repositoryId: prepared.repositoryId, state: STATE },
          },
          verified: { captureBlobId: prepared.capture.blobId, gate: "Accepting this preview" },
          origin: person,
          idempotencyKey: "record-state",
        });
      },
      rolledBack: (target, prepared) => {
        const detail = target.get({ projectId: prepared.id, entityId: prepared.task.entity.entityId });
        expect(detail.repositoryLinks.filter((link) => link.relation === "verified_at"), "no state was recorded").toHaveLength(0);
        expect(detail.evidence.filter((row) => row.kind === "screenshot"), "and no evidence was written for it").toHaveLength(0);
      },
    },
    {
      name: "correcting which capture a record points at",
      kept: "The evidence Marking this task done prepared is kept and can still be read",
      refused: "this record still points at the evidence it pointed at before",
      retry: "try again",
      attempt: (target, prepared) => {
        target.attachCapture(prepared.id, prepared.linkId, prepared.capture.blobId, undefined, {
          gate: "Marking this task done",
          actor: person.actor,
        });
      },
      rolledBack: (target, prepared) => {
        const link = target
          .get({ projectId: prepared.id, entityId: prepared.task.entity.entityId })
          .repositoryLinks.find((row) => row.linkId === prepared.linkId);
        expect(link?.captureBlobId, "the pointer did not move").toBeUndefined();
        expect(
          target.captureHistoryPage(prepared.id, { of: "associations", linkId: prepared.linkId, linkIds: [prepared.linkId] }).associations,
          "and no association was appended",
        ).toHaveLength(0);
      },
    },
    {
      name: "writing a record against a capture already stored",
      kept: "What this record points at was already saved and can still be read",
      refused: "the record naming it was not saved",
      retry: "try again",
      attempt: (target, prepared) => {
        target.link({
          projectId: prepared.id,
          expectedRevisionId: prepared.task.revision.revisionId,
          link: {
            type: "repository",
            relation: "based_on",
            subjectEntityId: prepared.task.entity.entityId,
            subjectRevisionId: prepared.task.revision.revisionId,
            repositoryId: prepared.repositoryId,
            target: { state: { vcs: "git", objectFormat: "sha1", commitObjectId: "d".repeat(40) } },
            captureBlobId: prepared.capture.blobId,
          },
          origin: person,
          idempotencyKey: "second-based-on",
        });
      },
      rolledBack: (target, prepared) => {
        const links = target.get({ projectId: prepared.id, entityId: prepared.task.entity.entityId }).repositoryLinks;
        expect(links, "only the link the fixture seeded is there").toHaveLength(1);
        expect(links[0]?.captureBlobId, "and it still has no capture of its own").toBeUndefined();
      },
    },
    {
      name: "saving a record that names a report already stored",
      kept: "What this record points at was already saved and can still be read",
      refused: "the record naming it was not saved",
      retry: "try again",
      attempt: (target, prepared) => {
        // The real producer, run again for the same report: the blob is
        // already stored and costs nothing, and the record naming it is what
        // there is no room for.
        storeReport(reportInput(target, prepared, "second-report"));
      },
      rolledBack: (target, prepared) => {
        const evidence = target.get({ projectId: prepared.id, entityId: prepared.task.entity.entityId }).evidence;
        expect(evidence.filter((row) => row.kind === "verification"), "the first run's record is there, and only it").toHaveLength(1);
      },
    },
  ];

  for (const door of DOORS) {
    for (const ceiling of CEILINGS) {
      it(`${door.name}: says what is still readable when ${ceiling.at} is full`, () => {
        const prepared = prepare(`${door.name.replace(/[^a-z]+/gi, "-")}-${ceiling.measure}-${ceiling.scope}`);
        const tight = new ProjectWorkStore({ file: prepared.path, quota: ceiling.quota(prepared.usage) });
        try {
          const seq = tight.seq(prepared.id);
          let refusal: ProjectWorkQuotaError | undefined;
          try {
            door.attempt(tight, prepared);
          } catch (error) {
            refusal = error as ProjectWorkQuotaError;
          }
          expect(refusal, "this write was expected to be refused for space").toBeInstanceOf(ProjectWorkQuotaError);
          expect(refusal?.scope).toBe(ceiling.scope);
          expect(refusal?.measure ?? "bytes").toBe(ceiling.measure);
          expect(refusal?.recovery).toContain(door.kept);
          expect(refusal?.recovery).toContain(door.refused);
          expect(refusal?.recovery, "and it says what to do once there is room").toContain(door.retry);
          expect(refusal?.recovery, "the room to make is where the budget ran out").toContain(ceiling.room);
          expect(refusal?.recovery, "a preparation in an earlier transaction was not rolled back").not.toContain(
            "Nothing from this action was saved",
          );
          expect(refusal?.recovery).toContain("Archiving an item hides it and keeps its history");

          // What was prepared really is still there, byte for byte.
          const kept = tight.readBlob({ projectId: prepared.id, blobId: prepared.capture.blobId, offset: 0, limit: 16 });
          expect(kept?.totalBytes).toBe(prepared.capture.bytes);
          expect(kept?.released).toBeUndefined();
          expect(tight.readBlob({ projectId: prepared.id, blobId: prepared.reportBlobId, offset: 0, limit: 16 })?.released).toBeUndefined();
          // And the refused write left nothing at all behind.
          door.rolledBack(tight, prepared);
          expect(tight.seq(prepared.id), "no event, and no sequence bump").toBe(seq);
          invariant(tight, prepared.id);
        } finally {
          tight.close();
        }
      });
    }
  }

  it("still says nothing was saved when nothing was prepared", () => {
    const prepared = prepare("no-preparation");
    const tight = new ProjectWorkStore({ file: prepared.path, quota: { projectBytes: prepared.usage.projectBytes } });
    try {
      let refusal: ProjectWorkQuotaError | undefined;
      try {
        tight.comment({
          projectId: prepared.id,
          entityId: prepared.task.entity.entityId,
          expectedRevisionId: prepared.task.revision.revisionId,
          revisionId: prepared.task.revision.revisionId,
          anchor: { kind: "whole" },
          text: "An ordinary write, with nothing stored ahead of it.",
          blocking: false,
          origin: person,
          idempotencyKey: "ordinary",
        });
      } catch (error) {
        refusal = error as ProjectWorkQuotaError;
      }
      expect(refusal).toBeInstanceOf(ProjectWorkQuotaError);
      expect(refusal?.recovery, "an ordinary refusal is still the plain truth").toContain("Nothing from this action was saved");
      expect(refusal?.recovery).not.toContain("can still be read");
      invariant(tight, prepared.id);
    } finally {
      tight.close();
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
    ).toThrow(/repository record is proved by a capture this item holds/);
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
    ).toThrow(/approval was decided on evidence this item holds/);

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
    ).toThrow(/evidence points at a repository record this item holds/);
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

describe("proof another item's record rests on", () => {
  /** The refusal itself, so its whole sentence can be read. */
  function refusalOf(act: () => unknown): Error {
    try {
      act();
    } catch (error) {
      return error as Error;
    }
    throw new Error("that was expected to be refused");
  }

  /** Every refusal offers the two things that really work, and no others. */
  function honest(message: string, key: string): void {
    expect(message, "the dependent item is named, because 'another item' is not something a person can act on").toContain(key);
    expect(message, "an immutable reference does not go away when a decision is superseded").not.toContain("Supersede or remove that decision");
    expect(message, "nor when the current state is captured again").not.toContain("Capture that item's state again");
    expect(message).toContain(`permanently delete ${key}`);
  }

  it("refuses to delete an item whose capture is another item's evidence", () => {
    const holder = store.create({ projectId, kind: "task", title: "Holds the capture", body: taskBody(), origin: person, idempotencyKey: idem("h") });
    const other = store.create({ projectId, kind: "task", title: "Kept it as evidence", body: taskBody(), origin: person, idempotencyKey: idem("o") });
    // Evidence takes a blob id without asking whose entity the blob is on, so
    // one item's attachment really can be another item's record.
    const capture = blob("what the run printed, kept as another item's evidence", holder.entity.entityId);
    store.link({
      projectId,
      expectedRevisionId: other.revision.revisionId,
      link: {
        type: "evidence",
        entityId: other.entity.entityId,
        revisionId: other.revision.revisionId,
        kind: "command_output",
        role: "supporting",
        summary: "The output this was checked against.",
        outcome: "passed",
        blobId: capture.blobId,
      },
      origin: person,
      idempotencyKey: idem("ev"),
    });

    const refusal = refusalOf(() =>
      store.delete({
        projectId,
        entityId: holder.entity.entityId,
        expectedRevisionId: holder.revision.revisionId,
        origin: person,
        idempotencyKey: idem("del"),
      }),
    );
    expect(refusal).toBeInstanceOf(ProjectWorkRefusedError);
    expect(refusal.message).toContain(`${other.entity.key}'s evidence is kept as a capture this item holds`);
    honest(refusal.message, other.entity.key);
    // The refusal is atomic: both items and the proof itself are untouched.
    expect(store.get({ projectId, entityId: holder.entity.entityId }).entity.key).toBe(holder.entity.key);
    expect(store.get({ projectId, entityId: other.entity.entityId }).evidence).toHaveLength(1);
    expect(store.readBlob({ projectId, blobId: capture.blobId, offset: 0, limit: 8 })?.released).toBeUndefined();
    invariant();
  });

  it("refuses to delete an item whose capture another link's history still records, after that link moved on", () => {
    const repositoryId = repository();
    const holder = store.create({ projectId, kind: "task", title: "Holds the first capture", body: taskBody(), origin: person, idempotencyKey: idem("h") });
    const other = store.create({ projectId, kind: "task", title: "Corrected its capture", body: taskBody(), origin: person, idempotencyKey: idem("o") });
    const first = blob("the capture that link was created with", holder.entity.entityId);
    const linkId = repositoryLink({ entityId: other.entity.entityId, revisionId: other.revision.revisionId }, repositoryId, first.blobId);
    // The pointer is corrected to a capture the other item owns: only the
    // append-only history still names this item's capture (D-363).
    const corrected = blob("the capture that link points at now", other.entity.entityId);
    expect(store.attachCapture(projectId, linkId, corrected.blobId, first.blobId, { gate: "A later correction" })).toBe(true);
    const history = store.captureHistoryPage(projectId, { of: "associations", linkId, linkIds: [linkId] }).associations;
    expect(history.map((association) => association.blobId)).toContain(first.blobId);

    const refusal = refusalOf(() =>
      store.delete({
        projectId,
        entityId: holder.entity.entityId,
        expectedRevisionId: holder.revision.revisionId,
        origin: person,
        idempotencyKey: idem("del"),
      }),
    );
    expect(refusal.message).toContain(`${other.entity.key}'s capture history records a capture this item holds`);
    honest(refusal.message, other.entity.key);
    // The older proof is still readable, and the history still says what it said.
    expect(store.readBlob({ projectId, blobId: first.blobId, offset: 0, limit: 8 })?.totalBytes).toBe(first.bytes);
    expect(store.captureHistoryPage(projectId, { of: "associations", linkId, linkIds: [linkId] }).associations).toHaveLength(history.length);
    invariant();
  });

  it("refuses to delete an item whose capture another item's accepted state was confirmed against", () => {
    const repositoryId = repository();
    const holder = store.create({ projectId, kind: "task", title: "Holds the accepted capture", body: taskBody(), origin: person, idempotencyKey: idem("h") });
    const other = store.create({ projectId, kind: "task", title: "Accepted a state", body: taskBody(), origin: person, idempotencyKey: idem("o") });
    const accepted = blob("the capture the acceptance was taken against", holder.entity.entityId);
    const current = blob("the capture the link points at", other.entity.entityId);
    store.link({
      projectId,
      expectedRevisionId: other.revision.revisionId,
      link: {
        type: "evidence",
        entityId: other.entity.entityId,
        revisionId: other.revision.revisionId,
        kind: "person_acceptance",
        role: "acceptance",
        summary: "Accepted the preview of that state.",
        outcome: "passed",
        verifiedAt: { repositoryId, state: { vcs: "git", objectFormat: "sha1", commitObjectId: "b".repeat(40) } },
      },
      // The acceptance binds the exact capture it was confirmed against, and
      // keeps naming it after the link's pointer moves on (D-361, D-363).
      verified: {
        captureBlobId: current.blobId,
        acceptance: {
          kind: "checkpoint_preview",
          confirmedAt: "2026-01-01T00:00:00.000Z",
          checkpointRef: `${CHECKPOINT_REF_NAMESPACE}/one`,
          commitObjectId: "b".repeat(40),
          subjectDigest: other.revision.digest,
          acceptedBy: person.actor,
          captureBlobId: accepted.blobId,
        },
      },
      origin: person,
      idempotencyKey: idem("acc"),
    });

    const refusal = refusalOf(() =>
      store.delete({
        projectId,
        entityId: holder.entity.entityId,
        expectedRevisionId: holder.revision.revisionId,
        origin: person,
        idempotencyKey: idem("del"),
      }),
    );
    expect(refusal.message).toContain(`${other.entity.key}'s accepted state was confirmed against a capture this item holds`);
    honest(refusal.message, other.entity.key);
    expect(store.readBlob({ projectId, blobId: accepted.blobId, offset: 0, limit: 8 })?.totalBytes).toBe(accepted.bytes);
    expect(store.get({ projectId, entityId: other.entity.entityId }).repositoryLinks[0]?.acceptance?.captureBlobId).toBe(accepted.blobId);
    invariant();
  });

  it("still deletes an item whose captures nothing else names", () => {
    const alone = store.create({ projectId, kind: "task", title: "Nobody's proof", body: taskBody(), origin: person, idempotencyKey: idem("a") });
    blob("only this item's own capture", alone.entity.entityId);
    const removed = store.delete({
      projectId,
      entityId: alone.entity.entityId,
      expectedRevisionId: alone.revision.revisionId,
      origin: person,
      idempotencyKey: idem("del"),
    });
    expect(removed.deleted).toBe(true);
    invariant();
  });
});

describe("when the counters and the rows disagree", () => {
  /** Write a counter nobody's rows support, the way real drift would look. */
  function forceCounter(path: string, id: string, column: "bytes" | "record_count", value: number): void {
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE projects SET ${column} = ? WHERE project_id = ?`).run(value, id);
    db.close();
  }

  it("refuses the write instead of clamping a total to zero, and loses nothing doing it", () => {
    const path = join(base, "drift.db");
    const first = new ProjectWorkStore({ file: path });
    const id = first.projectIdFor(join(base, "drift"))!;
    const item = first.create({ projectId: id, kind: "spec", title: "Real work", body: specBody(), origin: person, idempotencyKey: "a" });
    first.comment({
      projectId: id,
      entityId: item.entity.entityId,
      expectedRevisionId: item.revision.revisionId,
      revisionId: item.revision.revisionId,
      anchor: { kind: "whole" },
      text: "History that must survive a broken tally.",
      origin: person,
      idempotencyKey: "b",
    });
    const truth = { bytes: first.usage(id).projectBytes, records: first.usage(id).records, seq: first.seq(id) };
    first.close();

    // A byte tally far below what is really stored: crediting this deletion
    // would end below zero.
    forceCounter(path, id, "bytes", 100);
    const drifted = new ProjectWorkStore({ file: path });
    try {
      let refusal: Error | undefined;
      try {
        drifted.delete({
          projectId: id,
          entityId: item.entity.entityId,
          expectedRevisionId: item.revision.revisionId,
          origin: person,
          idempotencyKey: "c",
        });
      } catch (error) {
        refusal = error as Error;
      }
      expect(refusal).toBeInstanceOf(ProjectWorkRefusedError);
      expect(refusal?.message).toContain("stored size counted as less than nothing");
      expect(refusal?.message, "a refused write is not a lost one").toContain("Nothing already saved was changed or removed");
      // Atomic: the item, its history and the drifted counter are all exactly
      // where they were, and no event was published.
      expect(drifted.get({ projectId: id, entityId: item.entity.entityId }).entity.key).toBe(item.entity.key);
      expect(drifted.usage(id).projectBytes).toBe(100);
      expect(drifted.usage(id).records).toBe(truth.records);
      expect(drifted.seq(id)).toBe(truth.seq);
      expect(drifted.reconcileUsage(id).bytes, "the rows still say what they always said").toBe(truth.bytes);
      drifted.close();

      // The same for a record tally: a count that cannot be credited is a
      // fault, not something to round up to zero.
      forceCounter(path, id, "bytes", truth.bytes);
      forceCounter(path, id, "record_count", 1);
      const counted = new ProjectWorkStore({ file: path });
      try {
        expect(() =>
          counted.delete({
            projectId: id,
            entityId: item.entity.entityId,
            expectedRevisionId: item.revision.revisionId,
            origin: person,
            idempotencyKey: "d",
          }),
        ).toThrow(/number of saved records counted as less than nothing/);
      } finally {
        counted.close();
      }

      // And with counters that match the rows, the very same deletion — an
      // over-cap store shrinking, receipt and all — goes through.
      forceCounter(path, id, "record_count", truth.records);
      const repaired = new ProjectWorkStore({ file: path, quota: { projectBytes: Math.floor(truth.bytes / 2) } });
      try {
        expect(repaired.usage(id).projectBytes).toBeGreaterThan(repaired.usage(id).limits.projectBytes);
        const removed = repaired.delete({
          projectId: id,
          entityId: item.entity.entityId,
          expectedRevisionId: item.revision.revisionId,
          origin: person,
          idempotencyKey: "e",
        });
        expect(removed.deleted).toBe(true);
        invariant(repaired, id);
      } finally {
        repaired.close();
      }
    } finally {
      try {
        drifted.close();
      } catch {
        /* closed above */
      }
    }
  });
});

describe("the v5 → v6 upgrade", () => {
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

describe("counting a project that does not fit in one read", () => {
  /** Big enough that a payload read at the wrong moment would show up. */
  const PAYLOAD = Buffer.from("p".repeat(32 * 1024));
  /** A revision body of the size the store's own transport cap allows. */
  const BIG_BODY_BYTES = 4 * 1024 * 1024;
  /** The largest document a body may carry through the ordinary door. */
  const DOCUMENT_BYTES = 200_000;
  /** A string that exists nowhere but in those bodies. */
  const BODY_MARKER = "only-in-a-stored-body";

  /** What one read really carried into this process. */
  function bytesOf(rows: readonly unknown[]): number {
    let total = 0;
    for (const row of rows) {
      for (const value of Object.values(row as Record<string, unknown>)) {
        if (typeof value === "string") total += Buffer.byteLength(value, "utf8");
        else if (value instanceof Uint8Array) total += value.byteLength;
        else total += 8;
      }
    }
    return total;
  }

  /**
   * A project with more rows in one table than a single page may read, and
   * inline blob payloads beside them.
   *
   * The bulk rows are written straight into the file: what is under test is a
   * migration reading somebody's existing store, not the doors that made it,
   * and a thousand real transactions would prove nothing extra.
   */
  function crowded(path: string, comments: number, blobs: number, bodies = 0): { id: string; entityId: string; blobIds: string[] } {
    const seed = new ProjectWorkStore({ file: path });
    const id = seed.projectIdFor(join(base, "crowded"))!;
    const item = seed.create({ projectId: id, kind: "spec", title: "Crowded", body: specBody(), origin: person, idempotencyKey: "seed" });
    // The largest body the ordinary door accepts, written through it.
    if (bodies > 0) {
      const document = specBody(`${BODY_MARKER} written through the door`);
      if (document.kind === "spec") document.spec.document = `${BODY_MARKER} ${"d".repeat(DOCUMENT_BYTES - BODY_MARKER.length - 1)}`;
      seed.revise({
        projectId: id,
        entityId: item.entity.entityId,
        expectedRevisionId: item.revision.revisionId,
        body: document,
        origin: person,
        idempotencyKey: "seed-document",
      });
    }
    seed.close();
    const db = new DatabaseSync(path);
    const comment = db.prepare(
      "INSERT INTO comments (comment_id, project_id, entity_id, revision_id, anchor_json, text, state, blocking, created_at, origin_json, orphaned) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,0)",
    );
    const blobRow = db.prepare(
      "INSERT INTO blobs (blob_id, project_id, entity_id, digest, media_type, bytes, chunked, data, created_at) VALUES (?,?,?,?,?,?,0,?,?)",
    );
    const blobIds: string[] = [];
    db.exec("BEGIN");
    for (let n = 0; n < comments; n += 1) {
      comment.run(
        `cmt_fixture_${String(n).padStart(6, "0")}`,
        id,
        item.entity.entityId,
        item.revision.revisionId,
        JSON.stringify({ kind: "whole" }),
        `Review note ${String(n)}`,
        "open",
        0,
        "2026-01-01T00:00:00.000Z",
        JSON.stringify(person),
      );
    }
    for (let n = 0; n < blobs; n += 1) {
      const blobId = `blb_fixture_${String(n).padStart(6, "0")}`;
      blobRow.run(blobId, id, item.entity.entityId, `digest-${String(n)}`, "application/json", PAYLOAD.byteLength, PAYLOAD, "2026-01-01T00:00:00.000Z");
      blobIds.push(blobId);
    }
    // And the bodies a store written by an older release can be holding: the
    // transport cap is four megabytes a body, and a migration reads what is
    // there rather than what today's door would have allowed.
    if (bodies > 0) {
      const revision = db.prepare(
        "INSERT INTO revisions (revision_id, project_id, entity_id, kind, idx, parent_revision_id, title, digest, body_bytes, body, created_at, origin_json, state) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (let n = 0; n < bodies; n += 1) {
        const body = `{"kind":"spec","note":"${BODY_MARKER}","filler":"${"z".repeat(BIG_BODY_BYTES)}"}`;
        revision.run(
          `rev_fixture_${String(n).padStart(6, "0")}`,
          id,
          item.entity.entityId,
          "spec",
          100 + n,
          null,
          "A legacy body",
          `digest-body-${String(n)}`,
          Buffer.byteLength(body, "utf8"),
          body,
          "2026-01-01T00:00:00.000Z",
          JSON.stringify(person),
          "draft",
        );
      }
    }
    db.exec("COMMIT");
    db.close();
    return { id, entityId: item.entity.entityId, blobIds };
  }

  it("reads it in bounded pages, and never pulls a stored payload through memory to count it", () => {
    const path = join(base, "pages.db");
    const fixture = crowded(path, CHARGE_SCAN_BATCH_ROWS * 2 + 7, 3);
    const raw = new DatabaseSync(path);
    type Params = Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>;
    const reads: Array<{ sql: string; rows: number }> = [];
    const traced: ProjectWorkDatabase = {
      exec: (sql: string) => raw.exec(sql),
      close: () => raw.close(),
      prepare: (sql: string) => {
        const statement = raw.prepare(sql);
        return {
          run: (...params: unknown[]) => statement.run(...(params as Params)),
          get: (...params: unknown[]) => statement.get(...(params as Params)),
          all: (...params: unknown[]) => {
            const rows = statement.all(...(params as Params));
            reads.push({ sql, rows: rows.length });
            return rows;
          },
          iterate: (...params: unknown[]) => statement.iterate(...(params as Params)) as IterableIterator<unknown>,
        };
      },
    };

    const totals = rechargeProject(traced, fixture.id);

    const pages = reads.filter((read) => read.sql.includes("FROM comments"));
    expect(pages.length, "a table past two pages is read a page at a time").toBeGreaterThanOrEqual(3);
    for (const read of reads) {
      expect(read.rows, `one read may not materialise more than a page: ${read.sql}`).toBeLessThanOrEqual(CHARGE_SCAN_BATCH_ROWS);
    }
    expect(
      reads.some((read) => read.sql.includes("SELECT *")),
      "a projection of the columns a charge is read from, never every column",
    ).toBe(false);
    for (const read of reads.filter((read) => read.sql.includes("FROM blobs"))) {
      expect(read.sql, "the payload is charged through `bytes` and is never selected to be counted").not.toMatch(/\bdata\b/);
    }

    // And the totals those bounded reads wrote are the ones an independent
    // recount from the raw rows finds.
    expect(recomputeProjectUsage(traced, fixture.id)).toEqual(totals);
    const stored = raw.prepare("SELECT bytes, record_count, entity_count FROM projects WHERE project_id = ?").get(fixture.id) as {
      bytes: number;
      record_count: number;
      entity_count: number;
    };
    expect(Number(stored.bytes)).toBe(totals.bytes);
    expect(Number(stored.record_count)).toBe(totals.records);
    expect(Number(stored.entity_count)).toBe(totals.entities);
    // Every row was charged: none was skipped by a page boundary.
    const uncharged = raw.prepare("SELECT COUNT(*) AS n FROM comments WHERE project_id = ? AND charged_bytes = 0").get(fixture.id) as { n: number };
    expect(Number(uncharged.n)).toBe(0);
    raw.close();

    const reopened = new ProjectWorkStore({ file: path });
    try {
      invariant(reopened, fixture.id);
    } finally {
      reopened.close();
    }
  });

  it("asks the database for the size of a stored body and never for the body", () => {
    const path = join(base, "bounded-bytes.db");
    const fixture = crowded(path, CHARGE_SCAN_BATCH_ROWS * 2 + 7, 3, 2);
    const raw = new DatabaseSync(path);
    type Params = Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>;
    const reads: Array<{ sql: string; rows: number; bytes: number; marker: boolean }> = [];
    const traced: ProjectWorkDatabase = {
      exec: (sql: string) => raw.exec(sql),
      close: () => raw.close(),
      prepare: (sql: string) => {
        const statement = raw.prepare(sql);
        return {
          run: (...params: unknown[]) => statement.run(...(params as Params)),
          get: (...params: unknown[]) => statement.get(...(params as Params)),
          all: (...params: unknown[]) => {
            const rows = statement.all(...(params as Params));
            reads.push({
              sql,
              rows: rows.length,
              bytes: bytesOf(rows),
              marker: rows.some((row) => Object.values(row as Record<string, unknown>).some((value) => typeof value === "string" && value.includes(BODY_MARKER))),
            });
            return rows;
          },
          iterate: (...params: unknown[]) => statement.iterate(...(params as Params)) as IterableIterator<unknown>,
        };
      },
    };

    const totals = rechargeProject(traced, fixture.id);

    // The project really does hold what a naive scan would have carried.
    const storedBodies = Number(
      (raw.prepare("SELECT COALESCE(SUM(body_bytes), 0) AS n FROM revisions WHERE project_id = ?").get(fixture.id) as { n: number }).n,
    );
    expect(storedBodies, "the fixture holds several megabytes of real bodies").toBeGreaterThan(2 * BIG_BODY_BYTES);
    // And not one of them crossed into this process.
    const worst = reads.reduce((most, read) => Math.max(most, read.bytes), 0);
    expect(worst, `one read carried ${String(worst)} bytes; a page is keys and numbers`).toBeLessThan(256 * 1024);
    const carried = reads.reduce((sum, read) => sum + read.bytes, 0);
    expect(carried, "the whole migration carries less than one stored body").toBeLessThan(BIG_BODY_BYTES);
    expect(
      reads.filter((read) => read.marker),
      "no read returned the text of a stored body",
    ).toHaveLength(0);
    for (const read of reads.filter((read) => read.sql.includes("FROM revisions"))) {
      expect(read.sql, "the body is measured where it is stored, by name, and never selected").toMatch(/octet_length\("body"\)/);
      expect(read.sql.replace(/octet_length\("[a-z_]+"\)|typeof\("[a-z_]+"\)/g, ""), "and no column of it is returned but its key").not.toMatch(
        /\bbody\b/,
      );
    }

    // The bounded reads still produce the same totals as an independent
    // recount, and the counters they wrote agree with the rows.
    expect(recomputeProjectUsage(traced, fixture.id)).toEqual(totals);
    expect(totals.bytes, "and the bodies are counted, not skipped").toBeGreaterThan(storedBodies);
    raw.close();
    const reopened = new ProjectWorkStore({ file: path });
    try {
      invariant(reopened, fixture.id);
    } finally {
      reopened.close();
    }
  });

  it("upgrades it from v5 without losing a row, a payload or a byte of the total", () => {
    const path = join(base, "crowded-upgrade.db");
    const fixture = crowded(path, CHARGE_SCAN_BATCH_ROWS * 2 + 7, 3);
    const v5 = rewindToV5(path);

    const upgraded = new ProjectWorkStore({ file: path });
    try {
      expect(existsSync(`${path}.v5.backup`), "the file is copied before it is changed").toBe(true);
      const db = new DatabaseSync(path, { readOnly: true });
      for (const [table, count] of v5.rows) {
        expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n), `${table} kept its rows`).toBe(count);
      }
      // The payloads themselves are byte-for-byte what they were.
      for (const blobId of fixture.blobIds) {
        const row = db.prepare("SELECT data FROM blobs WHERE blob_id = ?").get(blobId) as { data: Uint8Array };
        expect(Buffer.from(row.data).equals(PAYLOAD), `${blobId} kept its payload`).toBe(true);
      }
      db.close();

      const usage = upgraded.usage(fixture.id);
      expect(usage.records, "every page of rows is counted").toBeGreaterThan(CHARGE_SCAN_BATCH_ROWS * 2);
      invariant(upgraded, fixture.id);
      upgraded.close();

      // Reopening recomputes rather than accumulates, page boundaries and all.
      const again = new ProjectWorkStore({ file: path });
      try {
        expect(again.usage(fixture.id).projectBytes).toBe(usage.projectBytes);
        expect(again.usage(fixture.id).records).toBe(usage.records);
        invariant(again, fixture.id);
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
});

/**
 * The charge is defined twice — once in JavaScript for a single write, once in
 * SQL so a scan never carries what it is counting — so the two are held to the
 * same answer (storage review M-2).
 */
describe("the charge in SQL and the charge in JavaScript", () => {
  /** A scratch database shaped like a canonical table, for value kinds. */
  function scratch(sql: string): ProjectWorkDatabase {
    const db = new DatabaseSync(":memory:");
    db.exec(sql);
    return db as unknown as ProjectWorkDatabase;
  }

  it("agree on every kind of stored value, including NUL, emoji and raw bytes", () => {
    const db = scratch(
      "CREATE TABLE comments (comment_id TEXT PRIMARY KEY, project_id TEXT, text TEXT, note TEXT, payload BLOB, n INTEGER, r REAL, charged_bytes INTEGER NOT NULL DEFAULT 0)",
    );
    const insert = db.prepare("INSERT INTO comments (comment_id, project_id, text, note, payload, n, r) VALUES (?,?,?,?,?,?,?)");
    const rows: Array<[string, string, string | null, Uint8Array | null, number | null, number | null]> = [
      ["plain", "Review note", "short", null, 1, null],
      ["nul", "before\u0000after", null, null, null, null],
      ["unicode", "🙂 λόγος — e\u0301", "héllo", null, null, null],
      ["empty", "", "", null, 0, 0],
      ["bytes", "with a payload", null, new Uint8Array([0, 1, 2, 250, 255]), null, null],
      ["numbers", "counted under the floor", null, null, 9_007_199_254_740_991, -1.5],
    ];
    for (const [id, text, note, payload, n, r] of rows) insert.run(id, "prj_1", text, note, payload, n, r);

    const expression = chargeExpression(db, "comments");
    const sql = db.prepare(`SELECT comment_id, (${expression}) AS charge FROM comments`).all() as Array<{ comment_id: string; charge: number }>;
    const stored = db.prepare("SELECT * FROM comments").all() as Array<Record<string, unknown>>;
    expect(sql).toHaveLength(rows.length);
    for (const row of stored) {
      const inSql = sql.find((one) => one.comment_id === row["comment_id"]);
      expect(Number(inSql?.charge), `${String(row["comment_id"])} costs the same in both definitions`).toBe(rowCharge("comments", row));
    }
    // And the exactness the definition claims: UTF-8 bytes, not characters,
    // with the NUL counted rather than treated as the end of the string.
    const nul = sql.find((one) => one.comment_id === "nul");
    expect(Number(nul?.charge)).toBe(
      ROW_OVERHEAD_BYTES + "nul".length + Buffer.byteLength("prj_1", "utf8") + Buffer.byteLength("before\u0000after", "utf8"),
    );
    db.close();
  });

  it("agree that a released payload is given back and an inline one is charged once", () => {
    const db = scratch(
      "CREATE TABLE blobs (blob_id TEXT PRIMARY KEY, project_id TEXT, digest TEXT, media_type TEXT, bytes INTEGER, data BLOB, released TEXT, charged_bytes INTEGER NOT NULL DEFAULT 0)",
    );
    const payload = new Uint8Array(4096).fill(7);
    const insert = db.prepare("INSERT INTO blobs (blob_id, project_id, digest, media_type, bytes, data, released) VALUES (?,?,?,?,?,?,?)");
    // The two rows differ only in whether the payload was released, so the
    // difference between their charges is exactly what a release gives back.
    insert.run("kept", "prj_1", "d1", "application/json", payload.byteLength, payload, null);
    insert.run("gone", "prj_1", "d2", "application/json", payload.byteLength, null, "quota");

    const expression = chargeExpression(db, "blobs");
    expect(expression, "the payload is charged through `bytes`, never read to be counted").not.toMatch(/"data"/);
    const sql = db.prepare(`SELECT blob_id, (${expression}) AS charge FROM blobs`).all() as Array<{ blob_id: string; charge: number }>;
    const stored = db.prepare("SELECT * FROM blobs").all() as Array<Record<string, unknown>>;
    for (const row of stored) {
      const inSql = sql.find((one) => one.blob_id === row["blob_id"]);
      expect(Number(inSql?.charge), `${String(row["blob_id"])} costs the same in both definitions`).toBe(rowCharge("blobs", row));
    }
    const kept = Number(sql.find((one) => one.blob_id === "kept")?.charge);
    const gone = Number(sql.find((one) => one.blob_id === "gone")?.charge);
    expect(kept - gone, "a released payload gives back exactly its bytes, and keeps its metadata charge").toBe(payload.byteLength - "quota".length);
    db.close();
  });

  it("agree on every row of a real project, table by table", () => {
    // A project with something in every kind of row the doors write.
    const repositoryId = repository();
    const item = spec("Review 🙂 from a phone");
    const task = store.create({ projectId, kind: "task", title: "Build it", body: taskBody(), origin: person, idempotencyKey: idem("task") });
    store.comment({
      projectId,
      entityId: item.entity.entityId,
      expectedRevisionId: item.revision.revisionId,
      revisionId: item.revision.revisionId,
      anchor: { kind: "whole" },
      text: "A note with a NUL\u0000, an emoji 🙂 and a combining mark e\u0301.",
      origin: person,
      idempotencyKey: idem("comment"),
    });
    const capture = blob("a capture 🙂 with non-ASCII in it", item.entity.entityId);
    repositoryLink({ entityId: task.entity.entityId, revisionId: task.revision.revisionId }, repositoryId, capture.blobId);
    const released = blob("a derived blob that will be let go", item.entity.entityId);
    store.releaseDerived({ projectId, blobId: released.blobId, reason: "quota", detail: "made room" });

    const raw = new DatabaseSync(file, { readOnly: true }) as unknown as ProjectWorkDatabase;
    let rowsSeen = 0;
    for (const table of CANONICAL_TABLES) {
      let inSql = 0;
      scanChargedRows(raw, table as CanonicalTable, projectId, (page) => {
        for (const row of page) inSql += row.charge;
        rowsSeen += page.length;
      });
      const stored = (raw.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId) as Array<Record<string, unknown>>).reduce(
        (total, row) => total + rowCharge(table as CanonicalTable, row),
        0,
      );
      expect(inSql, `${table} costs the same counted in SQL as counted from its rows`).toBe(stored);
    }
    raw.close();
    expect(rowsSeen, "and the project really had rows in it").toBeGreaterThan(10);
  });

  it("refuses to count a database that does not store its text as UTF-8", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA encoding = 'UTF-16'");
    db.exec("CREATE TABLE comments (comment_id TEXT PRIMARY KEY, project_id TEXT, text TEXT, charged_bytes INTEGER NOT NULL DEFAULT 0)");
    db.prepare("INSERT INTO comments (comment_id, project_id, text) VALUES (?,?,?)").run("a", "prj_1", "héllo");
    // What the guard is for: counted here, that text would cost its UTF-16
    // bytes and every charge in the store would be wrong by a different
    // amount per row.
    expect(Number((db.prepare("SELECT octet_length(text) AS n FROM comments").get() as { n: number }).n)).toBeGreaterThan(
      Buffer.byteLength("héllo", "utf8"),
    );
    const wrapped = db as unknown as ProjectWorkDatabase;
    expect(() => chargeExpression(wrapped, "comments")).toThrow(ProjectWorkUnavailableError);
    expect(() => scanChargedRows(wrapped, "comments", "prj_1", () => {})).toThrow(/UTF-8/);
    db.close();
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
