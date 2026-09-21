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
import { ProjectWorkUnavailableError } from "./errors.js";
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

/**
 * How many rows one read of a project's stored work may materialise.
 *
 * A recount and a migration are the only full scans in this store, and a
 * project can hold hundreds of thousands of canonical rows: they walk the
 * rows in stable key order, a page at a time. The page is read in full before
 * anything is written back, so nothing ever writes through a live cursor.
 *
 * This is a bound on **rows**, and a row bound alone would say nothing about
 * memory: five hundred revisions of four megabytes each is half a gigabyte of
 * bodies. What makes a page small is {@link chargeExpression} — a scan asks
 * the database for each row's key and its charge as a **number**, and never
 * for the body, the source text or the payload behind that number. One page
 * is therefore a few hundred keys and a few hundred integers, whatever the
 * project holds.
 */
export const CHARGE_SCAN_BATCH_ROWS = 500;

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
 *
 * This is what a **single write** is charged by: the writer has the row it
 * just wrote in hand, so measuring it costs nothing extra. A scan of a whole
 * project uses {@link chargeExpression}, which is the same definition in SQL
 * so that a page never carries the bytes it is counting; a parity test holds
 * the two to the same answer on every stored row.
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

/** How a list of SQL identifiers is joined. */
const SEPARATOR = ", ";

/**
 * The columns a charge is counted over: everything the row stores, minus what
 * is charged some other way and minus the charge itself.
 *
 * Asked of the database rather than hard-coded, so a column added by a later
 * migration is charged without this file being edited, and read once per
 * table per scan. `blobs.data` is excluded here rather than skipped after the
 * read: the payload is already charged through `bytes`, and counting it again
 * would charge one payload twice.
 */
function chargedColumns(db: ProjectWorkDatabase, table: CanonicalTable): string[] {
  const skip = NOT_CHARGED[table] ?? [];
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => String(column.name))
    .filter((name) => name !== "charged_bytes" && !skip.includes(name));
}

/**
 * The text encoding this database stores its TEXT values in.
 *
 * It matters here and nowhere else: `octet_length` counts the bytes of the
 * value **as the database holds it**, so on a UTF-16 database it would answer
 * with UTF-16 bytes while {@link rowCharge} and every stored charge speak
 * exact UTF-8. Rather than let the two quietly disagree, a database in any
 * other encoding is refused — this store creates its files in SQLite's UTF-8
 * default and has never written another, so this is an assertion about a
 * thing that cannot happen, said out loud instead of assumed.
 */
function requireUtf8(db: ProjectWorkDatabase): void {
  const row = db.prepare("PRAGMA encoding").get() as Record<string, unknown> | undefined;
  const encoding = row ? String(Object.values(row)[0] ?? "") : "";
  if (encoding.toUpperCase() !== "UTF-8") {
    throw new ProjectWorkUnavailableError(
      `This project work database stores its text as ${encoding || "an unknown encoding"} rather than UTF-8, ` +
        "so what it holds cannot be measured against the budget without counting the wrong bytes. " +
        "Nothing has been changed. Open the copy this app made beside it, or start again from an export.",
    );
  }
}

/**
 * What one stored row costs, as an SQL expression over that row.
 *
 * The same three rules as {@link rowCharge}, evaluated by the database so a
 * scan can learn what a row costs **without carrying the row's bytes into
 * this process**: `octet_length` measures the stored TEXT in exact UTF-8
 * (NULs and all — it is a byte count, not a C string) and the stored BLOB in
 * its own bytes, `typeof` keeps integers, reals and nulls under the floor the
 * way the JavaScript definition does, and `blobs.bytes` is added exactly when
 * the payload has not been released. The two definitions are held to each
 * other by a parity test over every stored row, and the JavaScript one
 * remains the definition a single write is charged by.
 */
export function chargeExpression(db: ProjectWorkDatabase, table: CanonicalTable): string {
  requireUtf8(db);
  const parts = [String(ROW_OVERHEAD_BYTES)];
  for (const column of chargedColumns(db, table)) {
    parts.push(`CASE typeof("${column}") WHEN 'text' THEN octet_length("${column}") WHEN 'blob' THEN octet_length("${column}") ELSE 0 END`);
  }
  // A released derived blob keeps its row, its size and its reason, and has
  // given its payload back: the metadata is still charged, the bytes are not.
  if (table === "blobs") parts.push('CASE WHEN "released" IS NULL THEN COALESCE("bytes", 0) ELSE 0 END');
  return parts.join(" + ");
}

/** One row of a scan: how to address it, and what it costs. */
export interface ChargedRow {
  /** This row's key values, in {@link ROW_KEYS} order. */
  key: unknown[];
  /** What the database says this row's stored values cost. */
  charge: number;
}

/**
 * Walk one project's rows of one table in bounded pages, oldest key first.
 *
 * Keyset pagination on the row's own primary key: each page asks for the rows
 * after the last key the previous page returned, which is stable under the
 * only write a recharge makes — `charged_bytes`, which is in no key and in no
 * index this order uses. `OFFSET` would not be stable, and iterating a live
 * cursor while writing through it has no defined meaning here at all.
 *
 * What a page carries is keys and numbers: the charge is computed inside the
 * database ({@link chargeExpression}), so a project of four-megabyte design
 * bodies costs a scan exactly as much memory as a project of one-line
 * comments. Each page is fully materialised before it is handed over, so a
 * caller may update every row in it before the next page is read.
 */
export function scanChargedRows(
  db: ProjectWorkDatabase,
  table: CanonicalTable,
  projectId: string,
  onPage: (rows: ReadonlyArray<ChargedRow>) => void,
): void {
  const keys = ROW_KEYS[table];
  const columns = [...keys.map((key) => `"${key}"`), `(${chargeExpression(db, table)}) AS charge`].join(SEPARATOR);
  const order = keys.map((key) => `"${key}"`).join(SEPARATOR);
  const page = `ORDER BY ${order} LIMIT ${String(CHARGE_SCAN_BATCH_ROWS)}`;
  const where = `${PROJECT_COLUMN[table]} = ?`;
  const first = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${where} ${page}`);
  const next = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${where} AND (${order}) > (${keys.map(() => "?").join(SEPARATOR)}) ${page}`);
  let after: unknown[] | undefined;
  for (;;) {
    const raw = (after ? next.all(projectId, ...after) : first.all(projectId)) as Array<Record<string, unknown>>;
    if (raw.length === 0) return;
    const rows = raw.map((row) => ({ key: keys.map((key) => row[key]), charge: Number(row["charge"] ?? 0) }));
    onPage(rows);
    if (rows.length < CHARGE_SCAN_BATCH_ROWS) return;
    after = rows[rows.length - 1]!.key;
  }
}

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
 * between two copies of the same mistake. The charge is derived from the raw
 * stored values every time — by the database, from the values themselves,
 * never from the number a writer wrote down. It is a full scan of the
 * project's rows and is therefore only ever a migration, an integrity surface
 * or a test — never part of a write.
 */
export function recomputeProjectUsage(db: ProjectWorkDatabase, projectId: string): RecomputedUsage {
  let bytes = 0;
  let records = 0;
  for (const table of CANONICAL_TABLES) {
    scanChargedRows(db, table, projectId, (rows) => {
      for (const row of rows) {
        bytes += row.charge;
        records += 1;
      }
    });
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
 *
 * Bounded in memory: one page at a time ({@link scanChargedRows}), and a page
 * is keys and charges rather than rows — a design body, a research source and
 * a capture payload are measured where they are stored and only their size
 * crosses into this process. A migration must never need as much memory as
 * the work it is counting.
 */
export function rechargeProject(db: ProjectWorkDatabase, projectId: string): RecomputedUsage {
  let bytes = 0;
  let records = 0;
  for (const table of CANONICAL_TABLES) {
    const keys = ROW_KEYS[table];
    const update = db.prepare(`UPDATE ${table} SET charged_bytes = ? WHERE ${keys.map((key) => `"${key}" = ?`).join(" AND ")}`);
    scanChargedRows(db, table, projectId, (rows) => {
      // The page is already in hand: updating it writes through nothing that
      // is still being read, and `charged_bytes` is in no key this scan orders
      // by, so the next page starts exactly where this one ended.
      for (const row of rows) {
        update.run(row.charge, ...row.key);
        bytes += row.charge;
        records += 1;
      }
    });
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
