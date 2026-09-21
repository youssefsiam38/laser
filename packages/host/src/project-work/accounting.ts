/**
 * What a row of canonical project work costs, and which rows cost anything
 * (M21-T2, D-365).
 *
 * The durable budget the leap requires (`docs/project-lifecycle-leap.md` lines
 * 135–138 and 729–733) counts **canonical** work: the entities, revisions,
 * comments, approvals, decisions, evidence, links, capture history, decision
 * bindings, identity mappings and idempotency receipts that a person's work
 * is made of, and the deduplicated blob payloads behind them. Before this
 * module only revision bodies and blob payloads were counted, so every other
 * canonical row was written free of charge.
 *
 * Three rules, stated once and used by every writer, by the migration and by
 * the independent recompute:
 *
 * - **A charge is logical, never physical.** It is the bytes this store chose
 *   to keep — the exact UTF-8 of each stored TEXT value, the length of each
 *   stored BLOB — plus a fixed {@link ROW_OVERHEAD_BYTES} floor per row that
 *   covers the numbers, the nulls and the fact of the row itself. SQLite
 *   pages, indexes, free lists, the WAL and per-chunk digests are **not**
 *   counted and no multiplier pretends to predict them: this is a budget over
 *   what a person saved, not a guarantee about a file's size on disk.
 * - **A payload is charged once.** A blob row carries its own metadata charge
 *   *plus* its deduplicated payload (`blobs.bytes`), and `blob_chunks` is
 *   never charged, because the chunks are that same payload. A released
 *   derived blob keeps its row and its metadata charge and gives the payload
 *   back. A revision body is charged once, as the `body` column.
 * - **A charge is stored, not recomputed at credit time.** Each charged table
 *   carries `charged_bytes`, so a deletion returns exactly what was taken even
 *   if a later release changes the cost function. {@link recomputeProjectUsage}
 *   derives the same numbers again from the **raw stored values** — not by
 *   summing `charged_bytes` — which is what makes a forgotten recharge after
 *   an UPDATE a test failure rather than silent drift.
 */
import type { ProjectWorkDatabase } from "./schema.js";

/**
 * The fixed cost of a row existing at all: its integers, its nulls, its
 * primary key's place in an index, its row header.
 *
 * A judgement call, fixed at 64 and deliberately not tuned per table. It is a
 * logical floor, not a measured SQLite page cost, and nothing in this file
 * claims a relationship between the budget and the size of the file.
 */
export const ROW_OVERHEAD_BYTES = 64;

/**
 * Every table whose rows the canonical budget counts.
 *
 * `projectColumn` is how a row is attributed to a project; `projects` is
 * attributed by its own primary key. Each entry names the key columns a single
 * row is addressed by, which is what keeps the prepared-statement cache
 * O(tables) rather than O(writes).
 */
export const CANONICAL_TABLES = [
  "projects",
  "project_paths",
  "repositories",
  "entities",
  "revisions",
  "edges",
  "comments",
  "approvals",
  "decisions",
  "evidence",
  "repository_links",
  "repository_link_captures",
  "execution_links",
  "decision_capture_bindings",
  "decision_capture_binding_sets",
  "blobs",
  "idempotency",
] as const;

export type CanonicalTable = (typeof CANONICAL_TABLES)[number];

/**
 * Bookkeeping the budget does not count, because each entry is bounded by
 * something other than how much work a person does.
 *
 * `key_sequences` holds at most one row per project per kind — five kinds, and
 * a row that never grows — so it can never be a way to store history for free.
 * That bound is the reason it is uncharged, and the classification guard test
 * fails if a new table is added here without one.
 */
export const BOOKKEEPING_TABLES = ["key_sequences"] as const;

/**
 * Derived rows: reproducible from canonical work, bounded, and prunable.
 *
 * `events` is capped at the store's `eventsRetained` and pruned on every
 * raise; `search_projection` holds at most one row per entity and is rebuilt
 * from that entity's current revision. Neither may ever be a reason to refuse
 * a write, and neither is canonical history.
 */
export const DERIVED_TABLES = ["events", "search_projection"] as const;

/**
 * Tables with no `project_id` of their own.
 *
 * `blob_chunks` is the payload of a `blobs` row, already counted once through
 * `blobs.bytes`, and its per-chunk digests are overhead.
 */
export const UNPARTITIONED_TABLES = ["blob_chunks"] as const;

/** Rows of this table a project may keep before a write is refused. */
export const PROJECT_WORK_PROJECT_RECORDS_DEFAULT = 200_000;
/** Canonical rows across every project together. */
export const PROJECT_WORK_GLOBAL_RECORDS_DEFAULT = 1_000_000;

/** Columns that are never part of a charge, per table. */
const NOT_CHARGED: Partial<Record<CanonicalTable, readonly string[]>> = {
  // The payload is charged once through `bytes`, under the dedup rule; the
  // inline copy in `data` (and the chunk rows behind it) is the same payload.
  blobs: ["data"],
};

/**
 * What one stored row costs.
 *
 * `row` is the row exactly as SQLite returns it. TEXT is charged as its UTF-8
 * length, BLOB as its byte length, and INTEGER, REAL and NULL are covered by
 * the floor — a column that holds a number cannot be a place to hide bytes.
 */
export function rowCharge(table: CanonicalTable, row: Record<string, unknown>): number {
  const skip = NOT_CHARGED[table];
  let total = ROW_OVERHEAD_BYTES;
  for (const [column, value] of Object.entries(row)) {
    if (column === "charged_bytes") continue;
    if (skip?.includes(column)) continue;
    if (typeof value === "string") total += Buffer.byteLength(value, "utf8");
    else if (value instanceof Uint8Array) total += value.byteLength;
  }
  if (table === "blobs") {
    // A released derived blob keeps its row, its size and its reason, and has
    // given its payload back: the metadata is still charged, the bytes are not.
    const released = row["released"];
    if (released === null || released === undefined) total += Number(row["bytes"] ?? 0);
  }
  return total;
}

/** How a row of each canonical table is attributed to a project. */
const PROJECT_COLUMN: Record<CanonicalTable, string> = {
  projects: "project_id",
  project_paths: "project_id",
  repositories: "project_id",
  entities: "project_id",
  revisions: "project_id",
  edges: "project_id",
  comments: "project_id",
  approvals: "project_id",
  decisions: "project_id",
  evidence: "project_id",
  repository_links: "project_id",
  repository_link_captures: "project_id",
  execution_links: "project_id",
  decision_capture_bindings: "project_id",
  decision_capture_binding_sets: "project_id",
  blobs: "project_id",
  idempotency: "project_id",
};

/** What this project's rows really cost, counted again from the rows. */
export interface RecomputedUsage {
  bytes: number;
  records: number;
  entities: number;
}

/**
 * Recount one project's charge from its raw stored values.
 *
 * The independent check: it never reads `charged_bytes`, so a writer that
 * inserted a row without charging it, or updated one without recharging it,
 * shows up as a difference from the counters rather than as an agreement
 * between two copies of the same mistake. It is a full scan of the project's
 * rows and is therefore only ever a migration, an integrity surface or a test
 * — never part of a write.
 */
export function recomputeProjectUsage(db: ProjectWorkDatabase, projectId: string): RecomputedUsage {
  let bytes = 0;
  let records = 0;
  for (const table of CANONICAL_TABLES) {
    const where = table === "projects" ? "project_id = ?" : `${PROJECT_COLUMN[table]} = ?`;
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).iterate(projectId) as IterableIterator<Record<string, unknown>>;
    for (const row of rows) {
      bytes += rowCharge(table, row);
      records += 1;
    }
  }
  const entities = Number((db.prepare("SELECT COUNT(*) AS n FROM entities WHERE project_id = ?").get(projectId) as { n: number }).n);
  return { bytes, records, entities };
}

/**
 * Write every canonical row's `charged_bytes` from its own stored values, and
 * replace the project's counters with the totals.
 *
 * Used by the v5 → v6 migration and by an explicit reconcile. It **replaces**,
 * never accumulates: bodies and blob payloads that were already counted are
 * recounted by the same function that counts them now, so running it twice
 * charges nothing twice and a crashed migration that re-runs starts from the
 * rows rather than from a half-finished total. No row is deleted, and no
 * column other than `charged_bytes` is touched.
 */
export function rechargeProject(db: ProjectWorkDatabase, projectId: string): RecomputedUsage {
  let bytes = 0;
  let records = 0;
  for (const table of CANONICAL_TABLES) {
    const where = `${PROJECT_COLUMN[table]} = ?`;
    const keys = ROW_KEYS[table];
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(projectId) as Array<Record<string, unknown>>;
    const update = db.prepare(`UPDATE ${table} SET charged_bytes = ? WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")}`);
    for (const row of rows) {
      const charge = rowCharge(table, row);
      update.run(charge, ...keys.map((key) => row[key]));
      bytes += charge;
      records += 1;
    }
  }
  const entities = Number((db.prepare("SELECT COUNT(*) AS n FROM entities WHERE project_id = ?").get(projectId) as { n: number }).n);
  db.prepare("UPDATE projects SET bytes = ?, record_count = ?, entity_count = ? WHERE project_id = ?").run(bytes, records, entities, projectId);
  return { bytes, records, entities };
}

/**
 * The columns one row of each table is addressed by.
 *
 * Fixed per table, so every statement this module and the store build comes
 * from a closed set of shapes.
 */
export const ROW_KEYS: Record<CanonicalTable, readonly string[]> = {
  projects: ["project_id"],
  project_paths: ["path"],
  repositories: ["repository_id"],
  entities: ["entity_id"],
  revisions: ["revision_id"],
  edges: ["link_id"],
  comments: ["comment_id"],
  approvals: ["approval_id"],
  decisions: ["decision_id"],
  evidence: ["evidence_id"],
  repository_links: ["link_id"],
  repository_link_captures: ["revision_id"],
  execution_links: ["link_id"],
  decision_capture_bindings: ["binding_id"],
  decision_capture_binding_sets: ["project_id", "decision_kind", "decision_id"],
  blobs: ["blob_id"],
  idempotency: ["project_id", "method", "key"],
};
