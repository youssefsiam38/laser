/**
 * LogStore (M4-T5) — the host's record of everything that crosses the wire.
 *
 * The host already sees every worker notification, so it is the only place that
 * can log provider round-trips, tool executions, session events and worker
 * stderr for *every* project in one ordered stream. Rows go into SQLite
 * (`node:sqlite`, in Node 24) so a search across a week of sessions is a query
 * rather than a re-scan of JSONL.
 *
 * ## The honest ceiling
 *
 * Pi 0.85's `before_provider_request` hook carries the **complete** serialized
 * provider request. `after_provider_response` carries only the HTTP status and
 * response headers — Pi exposes no hook for the raw response body, and there is
 * no `PI_DEBUG`. So a round-trip here is: full request, status, headers,
 * latency; and the assistant's actual output reconstructed from the session
 * event stream, which is a different (already-parsed) view of the same bytes.
 * `LogStats.providerResponseBodies` says `"unavailable"` and the logs page
 * states it, rather than showing an empty "response body" pane.
 *
 * ## Paging
 *
 * Reads are bounded twice: by row count and by a serialized byte budget (the
 * design pi-workflows uses). A payload above `INLINE_LIMIT` is not returned in
 * the page at all; the row carries a content reference — a SHA-256 of the body,
 * a size, and a short plain-text preview — and the client fetches the body with
 * `pi/logs/content` only when a person opens that row. Bodies are stored once
 * per hash, so a retried provider request costs one copy.
 *
 * ## What it keeps (D-245)
 *
 * A provider request body is the *whole* conversation for that turn, so one
 * long session writes one full copy of itself per turn: this store reached
 * 27.7 GB in eight days on a real machine while both retention limits (rows,
 * age) were still far from firing. Three bounds now apply to bodies, on top of
 * the row and age limits, which are unchanged:
 *
 * - the **50 most recent provider requests per session** keep their body;
 * - retained bodies are held to a **global byte budget** (1 GiB by default),
 *   enforced as rows arrive rather than only on a timer;
 * - an older row keeps its summary — model, message count, size, timing, the
 *   preview it already stored — and its body is *released*. `pi/logs/content`
 *   answers with that summary and says so; it does not pretend the row is gone.
 *
 * A body is shared by hash, so it is released only when no retained entry
 * still points at it. The space is really returned to the filesystem:
 * `auto_vacuum = INCREMENTAL` for a new store, a one-time `VACUUM` to convert
 * an older one (after the budget pass, so it copies the small live set rather
 * than the whole file), then bounded `incremental_vacuum` steps off the
 * request path.
 *
 * ## Redaction
 *
 * Everything written here goes through `redact()` first: any field whose name
 * looks like a credential (authorization, api key, token, cookie, ...) is
 * replaced with `[redacted]` and the row records how many were. Pi 0.85 routes
 * credentials through a separate `before_provider_headers` hook, so the request
 * payload does not normally carry one — but that is Pi's implementation detail,
 * response headers arrive raw, and a user-configured gateway can put a key in
 * the body. The store is still the most sensitive artefact laser produces —
 * a provider request contains the whole conversation and every tool result —
 * so the file is created 0600, and `providerPayloads: "summary"` drops the
 * bodies entirely for anyone who wants that trade.
 */
import {
  PRODUCT_NAME,
  redact,
  redactForStorage,
  type AgentRun,
  type ProviderCaptureMeta,
  type ProviderCaptureOmission,
  type ProviderCaptureSummary,
} from "@lasercode/protocol";
import { createHash } from "node:crypto";
import { CHUNKED_BODY_ABOVE, CONTENT_SCHEMA_VERSION, ContentStore } from "./content-store.js";
import type { CaptureBodySink } from "./provider-capture.js";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  LogBodySummary,
  LogContentRef,
  LogEntry,
  LogLevel,
  LogPage,
  LogQuery,
  LogSection,
  LogStats,
  PiExtensionMessage,
  SessionUpdateParams,
  WorkerInfo,
} from "@lasercode/protocol";

/** Payloads at or below this go inline in the page; larger ones become a ref. */
const INLINE_LIMIT = 2048;
/** Characters of a large payload shown in the collapsed row. */
const PREVIEW_CHARS = 240;
const DEFAULT_BYTE_BUDGET = 256 * 1024;
/** Prunes between full orphaned-body sweeps (an unindexed anti-join). */
const ORPHAN_SWEEP_EVERY = 10;
const DEFAULT_LIMIT = 200;

/** Every reason a body cannot be opened, as the row records it. */
const BODY_ABSENCE: readonly string[] = [
  "budget",
  "session-limit",
  "retention",
  "over-ceiling",
  "link-busy",
  "summary-mode",
  "interrupted",
  "corrupt",
];

function isBodyAbsence(value: string | null): value is LogBodySummary["reason"] {
  return value !== null && BODY_ABSENCE.includes(value);
}

/** Split on UTF-8 boundaries: a chunk is never half a character. */
function splitUtf8(text: string, chunkBytes: number): string[] {
  const buffer = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end = Math.min(offset + chunkBytes, buffer.length);
    while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
    chunks.push(buffer.toString("utf8", offset, end));
    offset = end;
  }
  return chunks;
}

/** Provider requests per session whose body is kept in full (D-245). */
export const BODIES_PER_SESSION = 50;
/** Every retained body, in bytes, across every session and project (D-245). */
export const DEFAULT_BODY_BUDGET_BYTES = 1024 * 1024 * 1024;
/**
 * Provider requests and tool calls one session may have open at once before the
 * oldest is forgotten. Far above any real turn; it exists so a session whose
 * turn never ends cannot grow this process without limit.
 */
const MAX_OPEN_PER_SESSION = 64;
/**
 * Bodies released in one bounded maintenance step. Releasing a megabyte-sized
 * body costs about 0.4 ms, so this is the step's share of the event loop: the
 * host answers requests between steps, not during one.
 */
const RELEASE_BATCH = 16;
/** Bodies released on the ingestion path itself, when a burst overshoots. */
const INGEST_RELEASE_BATCH = 16;
/**
 * How far over budget a burst may get before ingestion stops waiting for the
 * next tick. Releases are normally a timer's job; a loop that records a
 * hundred large bodies without yielding would otherwise never reach it.
 */
const BUDGET_OVERSHOOT = 1.05;
/** Sessions tracked as possibly over the per-session limit before a full sweep. */
const DIRTY_SESSIONS_MAX = 256;
/** Pages returned to the filesystem per vacuum step (4 KiB pages → 4 MiB, ~5 ms). */
const VACUUM_PAGES = 1024;
/** A freelist this small is not worth a step; SQLite reuses those pages. */
const VACUUM_FLOOR_PAGES = 64;
/**
 * A vacuum pass that has caught up writes the WAL back into the file, which is
 * the moment the file actually shortens. Measured: letting the WAL grow
 * instead is the more expensive choice by far — ingesting 1 MiB bodies went
 * from 3.2 ms to 6–9 ms mean, with 40–77 ms spikes, because SQLite's own
 * automatic checkpoint then has a backlog to copy on the ingestion path.
 */
/** Free pages that make converting an older store worth its one-time VACUUM. */
const CONVERT_FREELIST_PAGES = 4096;
/** Time an explicit administrative reclaim may block before yielding the rest. */
const RECLAIM_BUDGET_MS = 250;
/** SQLite's `auto_vacuum` value for incremental mode. */
const AUTO_VACUUM_INCREMENTAL = 2;

export interface LogStoreOptions {
  /** SQLite file. `:memory:` for tests. Parent directories are created. */
  file: string;
  /** Hard row cap; the oldest rows go first. */
  maxRows?: number;
  maxAgeDays?: number;
  /** Called with newly recorded rows so the host can notify clients. */
  onAppend?: (entries: LogEntry[]) => void;
  /** Rows appended between retention passes. */
  pruneEvery?: number;
  /**
   * Every retained body across the store, in bytes (D-245). Bodies beyond it
   * are released oldest first, as rows arrive.
   */
  bodyBudgetBytes?: number;
  /** Provider requests per session whose body is kept in full (D-245). */
  bodiesPerSession?: number;
  /** Where a long maintenance pass says what it is doing and how long it took. */
  log?: (message: string) => void;
  /**
   * What to keep of a provider round-trip. `"full"` (the default) stores the
   * serialized request body — the whole conversation, system prompt and every
   * tool result — which is what makes the logs page useful and also what makes
   * `logs.db` worth protecting. `"summary"` keeps only the one-line description
   * and the status, and stores no bodies at all.
   */
  providerPayloads?: "full" | "summary";
}

/**
 * The credential projection lives in `@lasercode/protocol` (RP-7), because the
 * worker now redacts a provider capture before it crosses the link and both
 * sides must run identical code. Re-exported here so every existing caller,
 * and every test, keeps the same import.
 */
export { redact };

/** What a row keeps instead of a body that could not be cleaned (RP-7). */
const UNREDACTABLE_BODY = "not recorded: a credential-shaped field could not be removed";
/** What a row says when this file's bodies belong to a newer release (RP-7). */
const BODIES_UNAVAILABLE = "request text not kept: this file was written by a newer version";

/** What a caller hands `record()`. `id` and `at` are the store's business. */
export interface LogInput {
  section: LogSection;
  kind: string;
  level?: LogLevel;
  cwd?: string;
  sessionPath?: string;
  summary: string;
  durationMs?: number;
  status?: number;
  correlationId?: string;
  requestContext?: LogEntry["requestContext"];
  detail?: unknown;
  at?: string;
  /**
   * Store the row without announcing it on the live append stream.
   *
   * The access audit (RP-13) writes a row per boundary decision. Those rows
   * belong in the store, where a person can query them, but not in every
   * connected client's notification stream: a speculative prepare would become
   * network traffic, and one connection would hear about another's activity as
   * it happened. The row is identical either way.
   */
  quiet?: boolean;
}

interface Row {
  id: number;
  at: string;
  section: string;
  kind: string;
  level: string;
  cwd: string | null;
  session_path: string | null;
  summary: string;
  duration_ms: number | null;
  status: number | null;
  correlation_id: string | null;
  request_context: string | null;
  detail: string | null;
  detail_ref: string | null;
  detail_bytes: number | null;
  detail_type: string | null;
  detail_preview: string | null;
  /** NULL while the body is stored; otherwise why it was released (D-245). */
  body_released: string | null;
}

/** One row of a body the store no longer keeps, and the reason. */
interface ReleasedRow {
  at: string;
  summary: string;
  duration_ms: number | null;
  detail_bytes: number | null;
  detail_preview: string | null;
  body_released: string | null;
  request_context: string | null;
}

type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    /**
     * Step rows one at a time. The only way to read part of a chunked body
     * without materialising all of it: `all()` would hand back every TEXT
     * column before the loop that is supposed to stop early (RP-7).
     */
    iterate(...params: unknown[]): IterableIterator<unknown>;
  };
  close(): void;
};

export class LogStoreUnavailableError extends Error {
  override readonly name = "LogStoreUnavailableError";
}

function openDatabase(file: string): Database {
  let DatabaseSync: new (path: string) => Database;
  try {
    // Node 22.5+ ships this; Node 24 is laser's floor (AGENTS.md §5).
    // `createRequire` rather than a static import so a Node without it fails
    // here, with an explanation, instead of failing the whole host at load.
    ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => Database;
    });
  } catch (error) {
    throw new LogStoreUnavailableError(
      `This Node (${process.version}) has no node:sqlite, so ${PRODUCT_NAME} cannot keep a log store. ` +
        `Run the host on Node 22.5 or newer — Node 24 is what ${PRODUCT_NAME} targets. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // Owner-only: a provider request row holds the whole conversation and every
  // tool result. SQLite otherwise creates the file with the process umask.
  if (file !== ":memory:") {
    for (const path of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* not created yet, or a filesystem without modes: not worth failing over */
      }
    }
  }
  // Before `journal_mode` and before the first table: SQLite only accepts a
  // change out of `auto_vacuum = NONE` on an empty database, or through a
  // VACUUM. An existing store keeps NONE here and is converted once, later,
  // off the request path (`convertToIncrementalVacuum`).
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    -- A bounded page cache (RP-7). The default grows with what has been
    -- touched, and a burst of multi-megabyte bodies touches a great many pages;
    -- this is a memory bound on SQLite's own convenience, not on what the
    -- store keeps. Retention, integrity and partial reads are unchanged.
    PRAGMA cache_size = -2000;
    -- Cap the WAL between checkpoints for the same reason.
    PRAGMA journal_size_limit = 8388608;
    CREATE TABLE IF NOT EXISTS entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      at             TEXT    NOT NULL,
      section        TEXT    NOT NULL,
      kind           TEXT    NOT NULL,
      level          TEXT    NOT NULL,
      cwd            TEXT,
      session_path   TEXT,
      summary        TEXT    NOT NULL,
      duration_ms    INTEGER,
      status         INTEGER,
      correlation_id TEXT,
      detail         TEXT,
      detail_ref     TEXT,
      detail_bytes   INTEGER,
      detail_type    TEXT,
      detail_preview TEXT,
      search         TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_section_id ON entries(section, id DESC);
    CREATE INDEX IF NOT EXISTS entries_session_id ON entries(session_path, id DESC);
    CREATE INDEX IF NOT EXISTS entries_cwd_id     ON entries(cwd, id DESC);
    CREATE INDEX IF NOT EXISTS entries_at         ON entries(at);
    CREATE INDEX IF NOT EXISTS entries_detail_ref ON entries(detail_ref);
    CREATE TABLE IF NOT EXISTS content (
      ref          TEXT PRIMARY KEY,
      bytes        INTEGER NOT NULL,
      content_type TEXT    NOT NULL,
      body         TEXT    NOT NULL
    );
  `);
  // Additive migration: existing requests remain readable, without invented
  // prompt attribution. New captures carry branch-local entry identity.
  const columns = db.prepare("PRAGMA table_info(entries)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "request_context")) db.exec("ALTER TABLE entries ADD COLUMN request_context TEXT");
  // Additive migration for D-245: every existing row is retained (NULL) until
  // the budget pass decides otherwise, so an upgrade loses nothing at open.
  if (!columns.some((column) => column.name === "body_released")) db.exec("ALTER TABLE entries ADD COLUMN body_released TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS entries_prompt ON entries(session_path, json_extract(request_context, '$.promptEntryId'), id);
    -- Partial indexes over exactly the rows retention walks: the oldest
    -- retained body in the store, and the retained request bodies of one
    -- session. Both stay small because their predicate is the policy.
    CREATE INDEX IF NOT EXISTS entries_retained_body ON entries(id) WHERE detail_ref IS NOT NULL AND body_released IS NULL;
    CREATE INDEX IF NOT EXISTS entries_session_body ON entries(session_path, id)
      WHERE kind = 'provider_request' AND detail_ref IS NOT NULL AND body_released IS NULL;
    -- Summing retained bytes never touches a body: the index carries them.
    CREATE INDEX IF NOT EXISTS content_bytes ON content(bytes);
  `);
  return db;
}

export class LogStore {
  private readonly db: Database;
  /** Where bodies live: their tables, their schema, their integrity (RP-7). */
  private readonly content_: ContentStore;
  private readonly statements = new Map<string, ReturnType<Database["prepare"]>>();
  private readonly maxRows: number;
  private readonly maxAgeMs: number;
  private readonly pruneEvery: number;
  private readonly onAppend: ((entries: LogEntry[]) => void) | undefined;
  private readonly file: string;
  readonly providerPayloads: "full" | "summary";
  private sincePrune = 0;
  /** Prunes since the last orphan sweep; that sweep is disk hygiene, not correctness. */
  private sinceSweep = 0;
  private pruneTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly bodyBudget: number;
  private readonly bodiesPerSession: number;
  private readonly log: (message: string) => void;
  /** Bytes of body actually stored, kept in step with the `content` table. */
  private retainedBodyBytes = 0;
  /** Sessions that may hold more retained request bodies than the policy allows. */
  private readonly dirtySessions = new Set<string>();
  /** Every session is suspect until the first sweep: the file outlives this process. */
  private sweepAllSessions = true;
  /** Age/row retention is owed a pass; body retention has its own triggers. */
  private pruneDue = false;
  /** The next prune step also looks for bodies no row points at any more. */
  private sweepOrphans = false;
  /** SQLite's mode for this file; 2 once the store returns space by itself. */
  private autoVacuum = 0;
  /** One conversion attempt per process: it is a whole-file rewrite. */
  private conversionAttempted = false;

  /**
   * Open provider requests and tool calls, for latency and correlation.
   *
   * The provider hooks carry no request id of their own, so a session's
   * requests are paired with its responses in order rather than by "the last
   * one wins": two in flight used to make the first response report the
   * second request's latency and leave the first row uncorrelated forever.
   * Both maps are bounded and swept: a turn that ends with a tool call or a
   * request still open is a leak otherwise, and nothing ever closed them.
   */
  private readonly openProviderRequests = new Map<string, Array<{ id: number; startedAt: number }>>();
  private readonly openToolCalls = new Map<string, { id: number; startedAt: number; toolName: string }>();

  constructor(options: LogStoreOptions) {
    this.file = options.file;
    this.log = options.log ?? (() => {});
    this.db = openDatabase(options.file);
    // Bodies own their tables and their schema. The migration is versioned and
    // atomic, and refuses a database a newer Laser wrote rather than reshaping
    // it (RP-7).
    this.content_ = new ContentStore(this.db);
    const migration = this.content_.migrate();
    if (migration.ahead) {
      this.log(
        `log store: this file's body tables are version ${migration.from}, newer than this app understands (${CONTENT_SCHEMA_VERSION}); ` +
          "leaving them as they are.",
      );
    }
    // 0 would make the OFFSET negative, which SQLite clamps to 0 — keeping one
    // row rather than none. A store has to hold at least one row to be a store.
    this.maxRows = Math.max(1, Math.trunc(options.maxRows ?? 200_000));
    this.providerPayloads = options.providerPayloads ?? "full";
    this.maxAgeMs = (options.maxAgeDays ?? 14) * 24 * 60 * 60 * 1000;
    this.pruneEvery = options.pruneEvery ?? 500;
    this.onAppend = options.onAppend;
    this.bodyBudget = Math.max(0, Math.trunc(options.bodyBudgetBytes ?? DEFAULT_BODY_BUDGET_BYTES));
    this.bodiesPerSession = Math.max(1, Math.trunc(options.bodiesPerSession ?? BODIES_PER_SESSION));
    this.autoVacuum = this.pragma("auto_vacuum");
    this.retainedBodyBytes = this.content_.totalBytes();
    this.prune();
    // What this store already holds is decided off the request path: an
    // upgrade from a version with no budget can have gigabytes to release.
    this.scheduleMaintenance();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
    this.statements.clear();
    this.content_.dispose();
    this.db.close();
  }

  // ------------------------------------------------------------------ write

  /**
   * Returns undefined once the store is closed. Notifications keep arriving
   * while the host tears its workers down, and a shutting-down host has
   * nowhere to put them — that is not an error worth crashing on.
   */
  record(input: LogInput): LogEntry | undefined {
    if (this.closed) return undefined;
    return this.recordEncoded(input, this.encodeDetail(input.detail));
  }

  /** Reuse the redacted capture for its summary and storage, without a raw copy. */
  private recordEncoded(input: LogInput, detail: ReturnType<LogStore["encodeDetail"]>): LogEntry | undefined {
    if (this.closed) return undefined;
    const at = input.at ?? new Date().toISOString();
    const level: LogLevel = input.level ?? "info";

    const info = this
      .statement(
        `INSERT INTO entries
           (at, section, kind, level, cwd, session_path, summary, duration_ms, status, correlation_id,
            detail, detail_ref, detail_bytes, detail_type, detail_preview, search, request_context)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        at,
        input.section,
        input.kind,
        level,
        input.cwd ?? null,
        input.sessionPath ?? null,
        input.summary,
        input.durationMs ?? null,
        input.status ?? null,
        input.correlationId ?? null,
        detail.inline,
        detail.ref,
        detail.bytes,
        detail.contentType,
        detail.preview,
        `${input.summary}\n${input.kind}\n${detail.preview ?? ""}`.toLowerCase(),
        input.requestContext ? JSON.stringify(input.requestContext) : null,
      );

    const id = Number(info.lastInsertRowid);
    const entry: LogEntry = {
      id,
      at,
      section: input.section,
      kind: input.kind,
      level,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.sessionPath !== undefined ? { sessionPath: input.sessionPath } : {}),
      summary: input.summary,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      ...(input.requestContext ? { requestContext: input.requestContext } : {}),
      ...(detail.inline !== null ? { detail: JSON.parse(detail.inline) as unknown } : {}),
      ...(detail.ref !== null
        ? {
            detailRef: {
              ref: detail.ref,
              bytes: detail.bytes ?? 0,
              contentType: (detail.contentType ?? "application/json") as LogContentRef["contentType"],
              preview: detail.preview ?? "",
            },
          }
        : {}),
    };

    if (++this.sincePrune >= this.pruneEvery) this.schedulePrune();
    if (detail.ref !== null) this.afterBodyIngested(input);
    if (!input.quiet) this.onAppend?.([entry]);
    return entry;
  }

  private encodeDetail(detail: unknown): {
    inline: string | null;
    ref: string | null;
    bytes: number | null;
    contentType: string | null;
    preview: string | null;
  } {
    if (detail === undefined) return { inline: null, ref: null, bytes: null, contentType: null, preview: null };
    const projected = redactForStorage(detail);
    // A body carrying a credential-shaped field the projection could not
    // remove is not stored at all, and neither is a preview of it: the row
    // keeps the placeholder below and says what happened. Only key names ever
    // reach the log line.
    const body = projected.ok
      ? projected.body
      : (() => {
          this.log(
            `log store: refused to keep a payload with ${projected.survivors.length} credential-shaped field(s) ` +
              `(${projected.survivors.join(", ")})`,
          );
          return JSON.stringify({ laser: UNREDACTABLE_BODY });
        })();
    const bytes = Buffer.byteLength(body, "utf8");
    const preview = body.slice(0, PREVIEW_CHARS);
    if (bytes <= INLINE_LIMIT) {
      return { inline: body, ref: null, bytes, contentType: "application/json", preview };
    }
    const stored = this.content_.put(body, bytes);
    // Bodies are not being kept in this file (a newer release wrote its body
    // tables): the row keeps its line, its size and nothing else. Rows,
    // sessions and search are unaffected.
    if (!stored) return { inline: null, ref: null, bytes, contentType: "application/json", preview };
    if (stored.inserted) {
      this.retainedBodyBytes += stored.bytes;
      // The same body back on disk: rows that had it released have it again,
      // and must not go on saying "summary only" over a body that opens.
      this.statement("UPDATE entries SET body_released = NULL WHERE detail_ref = ? AND body_released IS NOT NULL").run(stored.ref);
    }
    return { inline: null, ref: stored.ref, bytes: stored.bytes, contentType: stored.contentType, preview };
  }

  /** One statement group, or none of it. */
  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the transaction was already gone; the original failure is the one that matters */
      }
      throw error;
    }
  }

  /** A bounded cache also admits recurring query shapes without retaining every
   * possible filter combination. Statements hold no capture bodies. */
  private statement(sql: string): ReturnType<Database["prepare"]> {
    let statement = this.statements.get(sql);
    if (statement) return statement;
    statement = this.db.prepare(sql);
    if (this.statements.size >= 32) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }

  // ------------------------------------------------------------------- read

  query(query: LogQuery = {}): LogPage {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.kind) { where.push("kind = ?"); params.push(query.kind); }
    if (query.promptEntryId) { where.push("json_extract(request_context, '$.promptEntryId') = ?"); params.push(query.promptEntryId); }
    if (query.afterAt) { where.push("at >= ?"); params.push(new Date(query.afterAt).toISOString()); }
    if (query.beforeAt) { where.push("at < ?"); params.push(new Date(query.beforeAt).toISOString()); }
    if (query.sections?.length) {
      where.push(`section IN (${query.sections.map(() => "?").join(",")})`);
      params.push(...query.sections);
    }
    if (query.levels?.length) {
      where.push(`level IN (${query.levels.map(() => "?").join(",")})`);
      params.push(...query.levels);
    }
    if (query.cwd) {
      where.push("cwd = ?");
      params.push(query.cwd);
    }
    if (query.sessionPath) {
      where.push("session_path = ?");
      params.push(query.sessionPath);
    }
    if (query.search?.trim()) {
      // SQLite has no default LIKE escape character; without ESCAPE a `%` or
      // `_` a person typed would silently become a wildcard.
      where.push("search LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query.search.trim().toLowerCase())}%`);
    }
    if (query.afterId !== undefined) {
      where.push("id > ?");
      params.push(query.afterId);
    }
    if (query.beforeId !== undefined) {
      where.push("id < ?");
      params.push(query.beforeId);
    }

    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, 1000);
    const budget = Math.min(query.byteBudget ?? DEFAULT_BYTE_BUDGET, 8 * 1024 * 1024);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // `afterId` is a tail read (take the oldest unseen rows and keep going);
    // everything else pages backwards from the newest, then is reversed so a
    // page always reads oldest-first.
    const tail = query.afterId !== undefined;
    const rows = this.db
      .prepare(`SELECT * FROM entries ${clause} ORDER BY id ${tail ? "ASC" : "DESC"} LIMIT ?`)
      .all(...params, limit + 1) as Row[];

    const more = rows.length > limit;
    // `page` is in the order the reader cares about most: oldest-first for a
    // tail, newest-first when paging back. The budget therefore always cuts
    // the rows the reader is least likely to look at.
    const page = rows.slice(0, limit);

    const entries: LogEntry[] = [];
    let approxBytes = 0;
    let budgetHit = false;
    for (const row of page) {
      const entry = toEntry(row);
      const size = JSON.stringify(entry).length;
      // Always return at least one row, even if it alone blows the budget:
      // an empty page with `hasMore` would be an infinite paging loop.
      if (entries.length > 0 && approxBytes + size > budget) {
        budgetHit = true;
        break;
      }
      approxBytes += size;
      entries.push(entry);
    }
    // The page contract is oldest-first.
    if (!tail) entries.reverse();

    return {
      entries,
      hasMore: more || budgetHit,
      ...(entries.length > 0 ? { oldestId: entries[0]!.id, newestId: entries[entries.length - 1]!.id } : {}),
      approxBytes,
    };
  }

  /**
   * The body behind a `detailRef`. A body the byte budget or the per-session
   * limit released is not an error and not a 404: the row it belongs to is
   * still there, and this answers with what the row still knows (D-245).
   */
  content(ref: string, maxBytes = 4 * 1024 * 1024): {
    ref: string;
    contentType: string;
    bytes: number;
    truncated: boolean;
    text: string;
    released?: LogBodySummary;
  } {
    const read = this.content_.read(ref, maxBytes);
    if (!read) {
      const released = this.releasedSummary(ref);
      if (released) return { ref, contentType: "application/json", bytes: released.bytes, truncated: false, text: "", released };
      throw new Error(
        `Log payload ${ref.slice(0, 12)}… is no longer stored. Retention removed the rows that referenced it.`,
      );
    }
    if (read.corrupt) {
      // The row exists and what is stored for it cannot be trusted: a chunk
      // was altered, reordered, shortened or lost. Say that, with the size and
      // digest the row still knows, rather than handing back something that
      // reads like the request.
      return {
        ref,
        contentType: "application/json",
        bytes: read.bytes,
        truncated: false,
        text: "",
        released: this.absentSummary(ref, "corrupt", read.bytes),
      };
    }
    return read;
  }

  stats(): LogStats {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n);
    const bySection: Record<LogSection, number> = { provider: 0, tools: 0, session: 0, subagents: 0, host: 0 };
    for (const row of this.db.prepare("SELECT section, COUNT(*) AS n FROM entries GROUP BY section").all() as Array<{
      section: LogSection;
      n: number;
    }>) {
      if (row.section in bySection) bySection[row.section] = Number(row.n);
    }
    const span = this.db.prepare("SELECT MIN(at) AS oldest, MAX(at) AS newest FROM entries").get() as {
      oldest: string | null;
      newest: string | null;
    };
    return {
      total,
      bySection,
      ...(span.oldest ? { oldestAt: span.oldest } : {}),
      ...(span.newest ? { newestAt: span.newest } : {}),
      bytes: this.fileBytes(),
      retention: {
        maxRows: this.maxRows,
        maxAgeDays: Math.round(this.maxAgeMs / (24 * 60 * 60 * 1000)),
        bodyBudgetBytes: this.bodyBudget,
        bodiesPerSession: this.bodiesPerSession,
        retainedBodyBytes: this.retainedBodyBytes,
      },
      providerResponseBodies: "unavailable",
    };
  }

  clear(sections?: LogSection[]): number {
    const info = sections?.length
      ? this.db
          .prepare(`DELETE FROM entries WHERE section IN (${sections.map(() => "?").join(",")})`)
          .run(...sections)
      : this.db.prepare("DELETE FROM entries").run();
    this.collectOrphanedContent();
    // A person who clears the store is asking for the disk back, so give back
    // what a bounded pass can and leave the rest to maintenance.
    this.reclaimSpace(RECLAIM_BUDGET_MS);
    this.scheduleMaintenance();
    return Number(info.changes);
  }

  // -------------------------------------------------------------- retention

  /**
   * Timers yield between bounded delete batches; SQL still runs on the host
   * loop. Explicit prune/clear remain synchronous administrative operations.
   */
  private schedulePrune(): void {
    this.sincePrune = 0;
    this.pruneDue = true;
    if (++this.sinceSweep >= ORPHAN_SWEEP_EVERY) {
      this.sinceSweep = 0;
      this.sweepOrphans = true;
    }
    this.scheduleMaintenance();
  }

  /** One pending timer for every kind of maintenance; the step decides what is owed. */
  private scheduleMaintenance(): void {
    if (this.pruneTimer || this.closed) return;
    this.pruneTimer = setTimeout(() => this.maintenanceStep(), 0);
    this.pruneTimer.unref?.();
  }

  /**
   * One bounded slice of everything retention owes, in the order that keeps
   * the file smallest: drop rows, release bodies over the limits, and only
   * then hand pages back — a vacuum before the releases would copy bytes that
   * are about to go.
   */
  private maintenanceStep(): void {
    this.pruneTimer = undefined;
    if (this.closed) return;
    let more = false;
    try {
      if (this.pruneDue) more = this.pruneStep();
      const released = this.releaseStep(RELEASE_BATCH);
      more = more || released.more;
      // Reclaiming waits for a quiet step: no step both deletes and vacuums,
      // so the longest one the host can see is a single vacuum's pages.
      if (!more && released.released === 0) more = this.reclaimStep();
      else if (released.released > 0) more = true;
    } catch {
      /* failed maintenance retries after the next ingestion batch */
    }
    if (more) this.scheduleMaintenance();
  }

  /** Age, then row count, then bodies nothing points at. 256 rows at a time. */
  private pruneStep(): boolean {
    const cutoff = new Date(Date.now() - this.maxAgeMs).toISOString();
    const aged = Number(this.statement("DELETE FROM entries WHERE id IN (SELECT id FROM entries WHERE at < ? LIMIT 256)").run(cutoff).changes);
    const excess = Number(this.statement(`DELETE FROM entries WHERE id IN (
      SELECT id FROM entries WHERE id < (SELECT id FROM entries ORDER BY id DESC LIMIT 1 OFFSET ?) LIMIT 256
    )`).run(this.maxRows - 1).changes);
    const orphans = this.sweepOrphans && aged < 256 && excess < 256 ? this.content_.collectOrphans(256) : 0;
    if (orphans > 0) this.retainedBodyBytes = this.content_.totalBytes();
    const more = aged === 256 || excess === 256 || orphans === 256;
    if (!more) {
      this.pruneDue = false;
      this.sweepOrphans = false;
    }
    return more;
  }

  /** Trim by age, then by row count, then collect bodies nothing points at. */
  prune(collectOrphans = true): void {
    this.sincePrune = 0;
    const cutoff = new Date(Date.now() - this.maxAgeMs).toISOString();
    this.db.prepare("DELETE FROM entries WHERE at < ?").run(cutoff);
    this.db
      .prepare(
        // The subselect is the id of the maxRows-th newest row; everything
        // older than it goes. `<` (not `<=`) keeps exactly maxRows, and the
        // subselect is NULL — deleting nothing — while the table is smaller.
        `DELETE FROM entries WHERE id < (
           SELECT id FROM entries ORDER BY id DESC LIMIT 1 OFFSET ?
         )`,
      )
      .run(this.maxRows - 1);
    if (collectOrphans) this.collectOrphanedContent();
  }

  /**
   * Everything retention owes, now, to completion: rows, bodies over the
   * per-session limit and the byte budget, and the space itself. The host
   * never calls this on a request — it is the administrative door, and what
   * a test asserts against instead of a timer.
   */
  maintain(): { released: number; bytes: number } {
    this.prune();
    let released = 0;
    // Bounded batches in a loop rather than one unbounded statement: the same
    // code path the timer drives, so a test proves the code that runs.
    for (let pass = 0; pass < 10_000; pass++) {
      const step = this.releaseStep(RELEASE_BATCH);
      released += step.released;
      if (!step.more) break;
    }
    this.collectOrphanedContent();
    this.reclaimSpace(Number.POSITIVE_INFINITY);
    return { released, bytes: this.fileBytes() };
  }

  // ----------------------------------------------------------------- bodies

  /**
   * A body landed. The per-session limit and the budget are enforced from
   * here, but normally *after* this turn of the loop: a provider request is
   * already paying for a redact, a hash and a multi-megabyte insert, and the
   * timer is a few microseconds away. The exception is a burst that never
   * yields — an import, a replay, a loop over a hundred captures — which is
   * why ingestion releases synchronously once the store is over budget by
   * more than the overshoot margin.
   */
  private afterBodyIngested(input: LogInput): void {
    if (input.kind === "provider_request" && input.sessionPath) {
      if (this.dirtySessions.size >= DIRTY_SESSIONS_MAX) this.sweepAllSessions = true;
      else this.dirtySessions.add(input.sessionPath);
    }
    if (this.retainedBodyBytes > this.bodyBudget * BUDGET_OVERSHOOT) this.releaseForBudget(INGEST_RELEASE_BATCH);
    this.scheduleMaintenance();
  }

  /** One bounded release pass: the per-session limit first, then the budget. */
  private releaseStep(batch: number): { released: number; more: boolean } {
    let released = this.releaseOverSessionLimit(batch);
    if (released < batch) released += this.releaseForBudget(batch - released);
    const more =
      this.retainedBodyBytes > this.bodyBudget || this.sweepAllSessions || this.dirtySessions.size > 0;
    // `more` only matters while something is actually moving: a budget that
    // cannot be met (every body already released) must not spin the timer.
    return { released, more: more && released > 0 };
  }

  /**
   * Beyond the newest `bodiesPerSession` provider requests of a session, the
   * row keeps its summary and the body goes (D-245). The sessions to look at
   * are the ones that just ingested one; after an upgrade, every session with
   * a retained body is a candidate exactly once.
   */
  private releaseOverSessionLimit(batch: number): number {
    if (this.sweepAllSessions) {
      const sessions = this.db
        .prepare(
          `SELECT DISTINCT session_path AS path FROM entries
             WHERE kind = 'provider_request' AND detail_ref IS NOT NULL AND body_released IS NULL
               AND session_path IS NOT NULL`,
        )
        .all() as Array<{ path: string }>;
      for (const row of sessions) this.dirtySessions.add(row.path);
      this.sweepAllSessions = false;
    }
    let released = 0;
    for (const session of [...this.dirtySessions]) {
      const room = batch - released;
      if (room <= 0) return released;
      const rows = this.statement(
        `SELECT id, detail_ref AS ref FROM entries
           WHERE session_path = ? AND kind = 'provider_request' AND detail_ref IS NOT NULL AND body_released IS NULL
           ORDER BY id DESC LIMIT ? OFFSET ?`,
      ).all(session, room, this.bodiesPerSession) as Array<{ id: number; ref: string }>;
      for (const row of rows) this.releaseBody(row.id, row.ref, "session-limit");
      released += rows.length;
      // A short page means this session is inside the limit; a full one means
      // there is more of it, and the next step continues from here.
      if (rows.length < room) this.dirtySessions.delete(session);
    }
    return released;
  }

  /** Oldest body first, until the store is inside its byte budget. */
  private releaseForBudget(batch: number): number {
    let released = 0;
    while (this.retainedBodyBytes > this.bodyBudget && released < batch) {
      const rows = this.statement(
        `SELECT id, detail_ref AS ref FROM entries
           WHERE detail_ref IS NOT NULL AND body_released IS NULL ORDER BY id ASC LIMIT ?`,
      ).all(Math.min(64, batch - released)) as Array<{ id: number; ref: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        this.releaseBody(row.id, row.ref, "budget");
        released += 1;
        if (this.retainedBodyBytes <= this.bodyBudget) break;
      }
    }
    return released;
  }

  /**
   * The row remembers what it held — size, preview, summary, timing — and
   * stops pointing at a stored body. The body itself only goes when no
   * retained entry still references it: `content` is shared by hash, and a
   * retried request must not lose its payload because an older twin aged out.
   */
  private releaseBody(id: number, ref: string, reason: LogBodySummary["reason"]): void {
    this.statement("UPDATE entries SET body_released = ? WHERE id = ?").run(reason, id);
    const bytes = this.content_.sizeOf(ref);
    if (bytes === 0) return;
    if (this.content_.release(ref)) this.retainedBodyBytes = Math.max(0, this.retainedBodyBytes - bytes);
  }

  /**
   * The same summary, for a body the store never had or can no longer read
   * (RP-7): the reason is the caller's, the size and digest are the row's.
   */
  private absentSummary(ref: string, reason: LogBodySummary["reason"], bytes: number): LogBodySummary {
    const summary = this.releasedSummary(ref);
    return summary
      ? { ...summary, reason, bytes }
      : { reason, bytes, sha256: ref, summary: "", preview: "" };
  }

  /** What the row still knows about a body that is no longer stored. */
  private releasedSummary(ref: string): LogBodySummary | undefined {
    const row = this.db
      .prepare(
        `SELECT at, summary, duration_ms, detail_bytes, detail_preview, body_released, request_context
           FROM entries WHERE detail_ref = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(ref) as ReleasedRow | undefined;
    if (!row) return undefined;
    const context = row.request_context
      ? (safeParse(row.request_context) as { model?: unknown } | undefined)
      : undefined;
    const model = typeof context?.model === "string" ? context.model : summaryModel(row.summary);
    const messages = summaryMessageCount(row.summary);
    const reason = row.body_released;
    return {
      // A body missing without a marker is a body retention took with its
      // rows; saying "budget" there would be a guess. A capture recorded
      // without its body wrote its own reason here when the row was made.
      reason: isBodyAbsence(reason) ? reason : "retention",
      bytes: row.detail_bytes ?? 0,
      // The digest of the redacted bytes that would have been stored: it
      // identifies the body even when nothing can open it.
      sha256: ref,
      summary: row.summary,
      preview: row.detail_preview ?? "",
      at: row.at,
      ...(model !== undefined ? { model } : {}),
      ...(messages !== undefined ? { messages } : {}),
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    };
  }

  private collectOrphanedContent(): void {
    this.content_.collectAllOrphans();
    this.retainedBodyBytes = this.content_.totalBytes();
  }

  // ------------------------------------------------------------- reclaiming

  /**
   * SQLite does not shrink a file by itself. A store created by this version
   * is in incremental mode and only needs bounded steps; a store from before
   * it needs one whole-file VACUUM to change mode, which is why that happens
   * after the budget pass (it then copies the live set, not the 27 GB) and
   * says so in the log.
   */
  private reclaimStep(): boolean {
    if (this.file === ":memory:") return false;
    if (this.autoVacuum !== AUTO_VACUUM_INCREMENTAL) return this.convertToIncrementalVacuum();
    const before = this.pragma("freelist_count");
    if (before <= VACUUM_FLOOR_PAGES) return false;
    this.db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
    const after = this.pragma("freelist_count");
    if (after <= VACUUM_FLOOR_PAGES) this.checkpoint();
    return after < before && after > VACUUM_FLOOR_PAGES;
  }

  /** Bounded synchronous reclaim, for an explicit administrative request. */
  private reclaimSpace(budgetMs: number): void {
    if (this.file === ":memory:") return;
    const until = Date.now() + budgetMs;
    if (this.autoVacuum !== AUTO_VACUUM_INCREMENTAL) this.convertToIncrementalVacuum();
    if (this.autoVacuum !== AUTO_VACUUM_INCREMENTAL) {
      // Still the old mode (nothing to gain, or the VACUUM failed): the WAL is
      // the only space this can give back.
      this.checkpoint();
      return;
    }
    while (Date.now() < until) {
      const before = this.pragma("freelist_count");
      if (before <= VACUUM_FLOOR_PAGES) break;
      this.db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
      if (this.pragma("freelist_count") >= before) break;
    }
    this.checkpoint();
  }

  /**
   * Returns whether it is worth trying again. The conversion is attempted at
   * most once per process and only when this store is really carrying dead
   * weight — a file over its own body budget, or a large freelist a store in
   * this mode can never hand back.
   */
  private convertToIncrementalVacuum(): boolean {
    if (this.conversionAttempted) return false;
    const free = this.pragma("freelist_count");
    const bytes = this.fileBytes();
    if (bytes <= this.bodyBudget && free < CONVERT_FREELIST_PAGES) return false;
    this.conversionAttempted = true;
    this.log(
      `log store: compacting ${formatBytes(bytes)} of ${this.file} so deleted captures give their space back. ` +
        `This runs once and holds the host's other work while it does.`,
    );
    const started = Date.now();
    try {
      this.db.exec("VACUUM");
    } catch (error) {
      this.log(`log store: could not compact the file (${error instanceof Error ? error.message : String(error)}).`);
      return false;
    }
    this.autoVacuum = this.pragma("auto_vacuum");
    const durationMs = Date.now() - started;
    const now = this.fileBytes();
    this.log(`log store: compacted ${formatBytes(bytes)} → ${formatBytes(now)} in ${durationMs} ms.`);
    this.record({
      section: "host",
      kind: "logstore_compacted",
      summary: `log store compacted: ${formatBytes(bytes)} → ${formatBytes(now)} · ${durationMs} ms`,
      durationMs,
      detail: { before: bytes, after: now, durationMs, autoVacuum: this.autoVacuum },
    });
    return this.autoVacuum === AUTO_VACUUM_INCREMENTAL;
  }

  private checkpoint(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* a reader holding the WAL open just defers the truncation */
    }
  }

  private pragma(name: string): number {
    try {
      const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
      const value = row ? Object.values(row)[0] : undefined;
      return typeof value === "number" ? value : 0;
    } catch {
      return 0;
    }
  }

  /**
   * The store on disk, which is the database and its write-ahead log: a
   * person asking how much space this takes is not asking about one of them.
   */
  private fileBytes(): number {
    if (this.file === ":memory:") return 0;
    let total = 0;
    for (const path of [this.file, `${this.file}-wal`]) {
      try {
        total += statSync(path).size;
      } catch {
        /* no WAL right now, or the file is gone: neither is worth failing over */
      }
    }
    return total;
  }

  // --------------------------------------------------------------- ingestion

  /**
   * Messages from the laser companion extension running inside a session.
   * `provider-log` forwards Pi's request and response hooks; the request row
   * carries the whole payload, the response row closes it with status,
   * headers and latency.
   */
  /**
   * A capture that arrived whole through the chunked path (RP-7): already
   * redacted, already measured, stored once. Nothing is re-serialized here.
   */
  /**
   * Take a large capture's pieces as they arrive (RP-7). The store writes each
   * one and lets it go, so the host never holds a whole request.
   */
  openProviderBody(meta: ProviderCaptureMeta): CaptureBodySink | undefined {
    if (this.closed || this.providerPayloads !== "full") return undefined;
    if (meta.sha256 === undefined || meta.bytes === undefined || meta.bytes <= CHUNKED_BODY_ABOVE) return undefined;
    const stream = this.content_.openStream(meta.sha256);
    return {
      write: (piece) => stream.write(piece),
      finish: () => {
        const stored = stream.finish();
        if (!stored) return undefined;
        if (stored.inserted) this.retainedBodyBytes += stored.bytes;
        return { ref: stored.ref, bytes: stored.bytes };
      },
      abort: () => stream.abort(),
    };
  }

  /** The row for a capture the store already wrote, piece by piece. */
  recordProviderStored(
    cwd: string,
    sessionPath: string,
    meta: ProviderCaptureMeta,
    stored: { ref: string; bytes: number; preview: string },
  ): void {
    if (this.closed) return;
    const entry = this.recordEncoded(
      {
        section: "provider",
        kind: "provider_request",
        cwd,
        sessionPath,
        at: meta.at,
        summary: describeProviderCapture(meta.summary, stored.bytes),
        ...(meta.context ? { requestContext: meta.context } : {}),
      },
      { inline: null, ref: stored.ref, bytes: stored.bytes, contentType: "application/json", preview: stored.preview.slice(0, PREVIEW_CHARS) },
    );
    if (entry) this.noteOpenProviderRequest(sessionPath, entry.id, meta.at);
  }

  recordProviderCapture(cwd: string, sessionPath: string, meta: ProviderCaptureMeta, body: string, pieces?: readonly string[]): void {
    if (this.closed) return;
    // The pieces a capture arrived in are the shape this store keeps, so they
    // are written as they are when the caller still has them: joining and
    // re-cutting a multi-megabyte body held two more copies of it.
    const stored = pieces && pieces.length > 0 && body.length === 0
      ? this.content_.putPieces(pieces, meta.bytes ?? 0, meta.sha256 ?? "")
      : this.content_.put(body);
    if (!stored) {
      // Same as above: the request is recorded, its text is not kept, and the
      // row says so rather than pointing at a body nobody can read.
      this.recordEncoded(
        {
          section: "provider",
          kind: "provider_request",
          cwd,
          sessionPath,
          at: meta.at,
          summary: `${describeProviderCapture(meta.summary, meta.bytes ?? Buffer.byteLength(body, "utf8"))} · ${BODIES_UNAVAILABLE}`,
          ...(meta.context ? { requestContext: meta.context } : {}),
        },
        { inline: null, ref: null, bytes: null, contentType: null, preview: null },
      );
      return;
    }
    if (stored.inserted) this.retainedBodyBytes += stored.bytes;
    const entry = this.recordEncoded(
      {
        section: "provider",
        kind: "provider_request",
        cwd,
        sessionPath,
        at: meta.at,
        summary: describeProviderCapture(meta.summary, stored.bytes),
        ...(meta.context ? { requestContext: meta.context } : {}),
      },
      // The preview is taken from the bytes this host is storing, never from
      // what the producer said they were: a preview is body text, and body
      // text is only safe once this host has defended it.
      {
        inline: null,
        ref: stored.ref,
        bytes: stored.bytes,
        contentType: stored.contentType,
        preview: (body.length > 0 ? body : (pieces?.[0] ?? "")).slice(0, PREVIEW_CHARS),
      },
    );
    if (entry) this.noteOpenProviderRequest(sessionPath, entry.id, meta.at);
  }

  /**
   * The request happened; its body is not kept, and the row says why (RP-7).
   * Size and digest are the redacted representation that would have been
   * stored, so the row stays identifiable and honest about what it is.
   */
  recordProviderAbsent(cwd: string, sessionPath: string, meta: ProviderCaptureMeta, reason: ProviderCaptureOmission): void {
    if (this.closed) return;
    // A capture with no safe stored representation has nothing to measure: no
    // size, no digest, no preview, and so no body reference either. The row
    // says the request happened and why its text is not here, instead of
    // publishing a zero somebody could read as a measurement.
    const measured = meta.sha256 !== undefined && meta.bytes !== undefined;
    const entry = this.recordEncoded(
      {
        section: "provider",
        kind: "provider_request",
        cwd,
        sessionPath,
        at: meta.at,
        summary: `${describeProviderCapture(meta.summary, meta.bytes)}${measured ? "" : ` · ${UNREDACTABLE_BODY}`}`,
        ...(meta.context ? { requestContext: meta.context } : {}),
      },
      // No preview for a capture whose body is not here: the only preview this
      // host may keep is one it took from text it defended itself, and for an
      // absent capture there is no such text.
      measured
        ? { inline: null, ref: meta.sha256!, bytes: meta.bytes!, contentType: "application/json", preview: null }
        : { inline: null, ref: null, bytes: null, contentType: null, preview: null },
    );
    if (!entry) return;
    if (!measured) return;
    // The very same bytes may already be on disk from an earlier turn: content
    // is shared by digest, so that row opens and this one must not claim
    // otherwise. Only a body nobody has is marked absent.
    const present = this.statement("SELECT 1 AS present FROM content WHERE ref = ?").get(meta.sha256) as { present: number } | undefined;
    if (!present) this.statement("UPDATE entries SET body_released = ? WHERE id = ?").run(reason, entry.id);
    this.noteOpenProviderRequest(sessionPath, entry.id, meta.at);
  }

  /** Correlate the response that will follow, with a bound on a queue nothing answers. */
  private noteOpenProviderRequest(sessionPath: string, id: number, at: string): void {
    const queue = this.openProviderRequests.get(sessionPath) ?? [];
    queue.push({ id, startedAt: Date.parse(at) || Date.now() });
    // A request nothing ever answered (a killed engine, a dropped hook) must
    // not keep its session's queue growing.
    if (queue.length > MAX_OPEN_PER_SESSION) queue.splice(0, queue.length - MAX_OPEN_PER_SESSION);
    this.openProviderRequests.set(sessionPath, queue);
  }

  observeExtensionMessage(cwd: string, sessionPath: string, message: PiExtensionMessage): void {
    switch (message.type) {
      case "lasercode/provider/request": {
        if (this.closed) return;
        const detail = this.encodeDetail(this.providerPayloads === "full" ? message.payload : undefined);
        const entry = this.recordEncoded({
          section: "provider",
          kind: "provider_request",
          cwd,
          sessionPath,
          at: message.at,
          summary: describeProviderRequest(message.payload, detail.bytes ?? undefined),
          ...(message.context ? { requestContext: message.context } : {}),
        }, detail);
        if (entry) this.noteOpenProviderRequest(sessionPath, entry.id, message.at);
        return;
      }
      case "lasercode/provider/response": {
        const queue = this.openProviderRequests.get(sessionPath);
        const open = queue?.shift();
        if (queue && queue.length === 0) this.openProviderRequests.delete(sessionPath);
        const finishedAt = Date.parse(message.at) || Date.now();
        this.record({
          section: "provider",
          kind: "provider_response",
          cwd,
          sessionPath,
          at: message.at,
          level: message.status >= 400 ? "error" : "info",
          status: message.status,
          ...(open ? { durationMs: Math.max(0, finishedAt - open.startedAt), correlationId: `req-${open.id}` } : {}),
          summary: `HTTP ${message.status}${open ? ` · ${Math.max(0, finishedAt - open.startedAt)} ms` : ""}`,
          // Pi gives no response body here; headers are the whole story.
          detail: { headers: message.headers, bodyAvailable: false },
        });
        return;
      }
      case "lasercode/capabilities": {
        this.record({
          section: "session",
          kind: "capabilities",
          cwd,
          sessionPath,
          level: message.failed.length > 0 ? "warn" : "info",
          summary:
            `companion modules active: ${message.active.join(", ") || "none"}` +
            (message.failed.length > 0 ? ` · failed: ${message.failed.map((f) => f.module).join(", ")}` : ""),
          detail: message,
        });
        return;
      }
      case "lasercode/module/log": {
        this.record({
          section: "session",
          kind: `module:${message.module}`,
          cwd,
          sessionPath,
          level: message.level,
          summary: message.message,
        });
        return;
      }
    }
  }

  /** Tool executions and the session lifecycle, from the `session/update` stream. */
  observeSessionUpdate(cwd: string, params: SessionUpdateParams): void {
    const { update, sessionPath, at } = params;
    switch (update.kind) {
      case "tool_execution_start": {
        const entry = this.record({
          section: "tools",
          kind: "tool_start",
          cwd,
          sessionPath,
          at,
          summary: `${update.toolName} started`,
          correlationId: `tool-${update.toolCallId}`,
          detail: { toolCallId: update.toolCallId, toolName: update.toolName, args: update.args },
        });
        if (entry) {
          this.openToolCalls.set(`${sessionPath}::${update.toolCallId}`, {
            id: entry.id,
            startedAt: Date.parse(at) || Date.now(),
            toolName: update.toolName,
          });
          this.boundOpenToolCalls(sessionPath);
        }
        return;
      }
      case "tool_execution_end": {
        const key = `${sessionPath}::${update.toolCallId}`;
        const open = this.openToolCalls.get(key);
        this.openToolCalls.delete(key);
        const durationMs = open ? Math.max(0, (Date.parse(at) || Date.now()) - open.startedAt) : undefined;
        this.record({
          section: "tools",
          kind: "tool_end",
          cwd,
          sessionPath,
          at,
          level: update.isError ? "error" : "info",
          summary:
            `${open?.toolName ?? "tool"} ${update.isError ? "failed" : "finished"}` +
            (durationMs !== undefined ? ` · ${durationMs} ms` : ""),
          ...(durationMs !== undefined ? { durationMs } : {}),
          correlationId: `tool-${update.toolCallId}`,
          detail: { toolCallId: update.toolCallId, result: update.result, isError: update.isError },
        });
        return;
      }
      case "agent_end":
      case "agent_settled":
        // The turn is over, so a tool call still open in it will never end: its
        // row is already written and nothing will correlate to it again. Left
        // behind, one entry per abandoned call accumulated for the life of the
        // host. The same holds for a provider request nobody answered. An
        // `agent_end` that announces a retry is not the end of the turn.
        if (!(update.kind === "agent_end" && update.willRetry === true)) this.forgetOpenWork(sessionPath);
        this.record({ section: "session", kind: update.kind, cwd, sessionPath, at, summary: update.kind });
        return;
      case "agent_start":
      case "compaction_start":
      case "compaction_end":
        this.record({ section: "session", kind: update.kind, cwd, sessionPath, at, summary: update.kind });
        return;
      case "auto_retry_start":
        this.record({
          section: "session",
          kind: "auto_retry_start",
          cwd,
          sessionPath,
          at,
          level: "warn",
          summary: `retrying (attempt ${update.attempt} of ${update.maxAttempts})`,
        });
        return;
      case "auto_retry_end":
        this.record({
          section: "session",
          kind: "auto_retry_end",
          cwd,
          sessionPath,
          at,
          level: update.ok ? "info" : "error",
          summary: update.ok ? "retry succeeded" : "retry gave up",
        });
        return;
      case "extension_error":
        this.record({
          section: "session",
          kind: "extension_error",
          cwd,
          sessionPath,
          at,
          level: "error",
          summary: `${update.extension}: ${update.message}`,
        });
        return;
      default:
        // Deltas and state snapshots are the transcript's job, not the log's.
        return;
    }
  }

  /**
   * A run's status moved (M13-T59). The row is filed under the parent's
   * session when there is one, so the log of the session that delegated shows
   * what became of its children; a root run is filed under its own session.
   */
  observeAgentRun(run: AgentRun): void {
    const who = run.subagentName && run.subagentName !== run.agentName ? `${run.subagentName} (${run.agentName})` : run.agentName;
    const why = run.error ?? run.endedBy?.reason ?? run.result?.message;
    const level = run.status === "failed" ? "error" : run.status === "needs_input" || run.status === "blocked" ? "warn" : "info";
    this.record({
      section: "subagents",
      kind: `run:${run.status}`,
      cwd: run.projectCwd,
      sessionPath: run.parent?.sessionPath ?? run.sessionPath,
      level,
      summary: `${who} ${run.status.replace("_", " ")}${why ? ` · ${why}` : ""}`,
      detail: run,
    });
  }

  observeWorkerStatus(info: WorkerInfo): void {
    this.record({
      section: "host",
      kind: `worker_${info.status}`,
      cwd: info.cwd,
      level: info.status === "crashed" ? "error" : "info",
      summary: `worker ${info.status}${info.message ? `: ${info.message}` : ""}`,
      detail: info,
    });
  }

  /**
   * A session is gone (closed, moved, or its worker died): nothing open in it
   * can ever be closed, so the correlation bookkeeping goes with it. The rows
   * already written stay; this is memory, not history.
   */
  forgetSession(sessionPath: string): void {
    this.openProviderRequests.delete(sessionPath);
    this.forgetOpenToolCalls(sessionPath);
  }

  /** Everything still open in one session's turn, dropped in one pass. */
  private forgetOpenWork(sessionPath: string): void {
    this.openProviderRequests.delete(sessionPath);
    this.forgetOpenToolCalls(sessionPath);
  }

  private forgetOpenToolCalls(sessionPath: string): void {
    const prefix = `${sessionPath}::`;
    for (const key of this.openToolCalls.keys()) if (key.startsWith(prefix)) this.openToolCalls.delete(key);
  }

  /**
   * A session whose turn never ends (a worker killed mid-stream, an engine that
   * stops reporting) may not grow this map without limit either: the oldest
   * open calls of that session go first, and only its own.
   */
  private boundOpenToolCalls(sessionPath: string): void {
    const prefix = `${sessionPath}::`;
    const keys = [...this.openToolCalls.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_OPEN_PER_SESSION))) this.openToolCalls.delete(key);
  }

  /** Worker stderr, split into lines so a stack trace is one row per line. */
  observeWorkerStderr(cwd: string, text: string): void {
    for (const line of text.split("\n")) {
      const trimmed = line.trimEnd();
      if (trimmed === "") continue;
      this.record({
        section: "host",
        kind: "worker_stderr",
        cwd,
        level: /error|exception|fatal/i.test(trimmed) ? "error" : "debug",
        summary: trimmed.slice(0, 500),
      });
    }
  }
}

// ------------------------------------------------------------------ helpers


function toEntry(row: Row): LogEntry {
  return {
    id: row.id,
    at: row.at,
    section: row.section as LogSection,
    kind: row.kind,
    level: row.level as LogLevel,
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    ...(row.session_path !== null ? { sessionPath: row.session_path } : {}),
    summary: row.summary,
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    ...(row.request_context !== null ? { requestContext: JSON.parse(row.request_context) as NonNullable<LogEntry["requestContext"]> } : {}),
    ...(row.detail !== null ? { detail: safeParse(row.detail) } : {}),
    ...(row.detail_ref !== null
      ? {
          detailRef: {
            ref: row.detail_ref,
            bytes: row.detail_bytes ?? 0,
            contentType: (row.detail_type ?? "application/json") as LogContentRef["contentType"],
            preview: row.detail_preview ?? "",
            // The row is whole; the body behind it is not. Saying so here
            // saves every reader a request that answers "summary only".
            ...(row.body_released !== null ? { released: true as const } : {}),
          },
        }
      : {}),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/**
 * The message count out of a summary this store wrote itself
 * (`describeProviderRequest`), so a released row can still say how big the
 * conversation was without keeping a second copy of anything.
 */
export function summaryMessageCount(summary: string): number | undefined {
  const match = /(?:^|· )(\d+) messages?(?: ·|$)/.exec(summary);
  return match ? Number(match[1]) : undefined;
}

/**
 * The model out of the same line, for a capture recorded before request
 * context existed. `describeProviderRequest` writes it first and writes
 * nothing there when the payload named no model, so an unrecognised shape
 * yields nothing rather than a guess.
 */
export function summaryModel(summary: string): string | undefined {
  const first = summary.split(" · ")[0]?.trim();
  // A model id has no spaces; "3 messages", "2 tools" and "stream" are the
  // other things that lead a summary line, and none of them is a model.
  if (!first || first === "stream" || /\s/.test(first)) return undefined;
  return first;
}

/**
 * One line describing a provider request. Pi hands us whatever the provider's
 * serializer produced, so this probes the fields the common shapes share
 * (Anthropic messages, OpenAI completions, OpenAI responses) and degrades to a
 * size when it recognises nothing.
 */
/** The same line, from a summary the producer computed (RP-7). */
export function describeProviderCapture(summary: ProviderCaptureSummary, bytes?: number): string {
  const parts: string[] = [];
  if (summary.model) parts.push(summary.model);
  if (summary.messages !== undefined) parts.push(`${summary.messages} message${summary.messages === 1 ? "" : "s"}`);
  if (summary.tools !== undefined && summary.tools > 0) parts.push(`${summary.tools} tools`);
  if (summary.stream) parts.push("stream");
  if (summary.thinking) parts.push("thinking");
  // No size when nothing was measured: a row says what it knows.
  if (bytes !== undefined) parts.push(formatBytes(bytes));
  return parts.join(" · ");
}

export function describeProviderRequest(payload: unknown, retainedBytes?: number): string {
  const body = payload as Record<string, unknown> | null;
  const size = retainedBytes ?? (() => {
    try {
      return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
    } catch {
      return 0;
    }
  })();
  if (!body || typeof body !== "object") return `provider request · ${formatBytes(size)}`;

  const parts: string[] = [];
  if (typeof body["model"] === "string") parts.push(body["model"]);
  const messages = body["messages"] ?? body["input"] ?? body["contents"];
  if (Array.isArray(messages)) parts.push(`${messages.length} message${messages.length === 1 ? "" : "s"}`);
  const tools = body["tools"];
  if (Array.isArray(tools) && tools.length > 0) parts.push(`${tools.length} tools`);
  if (body["stream"] === true) parts.push("stream");
  const thinking = body["thinking"] ?? body["reasoning"] ?? body["reasoning_effort"];
  if (thinking !== undefined && thinking !== null) parts.push("thinking");
  parts.push(formatBytes(size));
  return parts.join(" · ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
