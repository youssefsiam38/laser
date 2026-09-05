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
import { PRODUCT_NAME } from "@lasercode/protocol";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
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
   * What to keep of a provider round-trip. `"full"` (the default) stores the
   * serialized request body — the whole conversation, system prompt and every
   * tool result — which is what makes the logs page useful and also what makes
   * `logs.db` worth protecting. `"summary"` keeps only the one-line description
   * and the status, and stores no bodies at all.
   */
  providerPayloads?: "full" | "summary";
}

/**
 * Field names whose values never belong in a log row.
 *
 * Anchored, with up to two vendor prefix segments (`x-api-key`,
 * `anthropic-api-key`, `x-goog-api-key`) — deliberately not a substring match,
 * because Pi's own payloads are full of `max_tokens`, `reserveTokens` and
 * `thinkingBudgets`, and redacting those would make every row a lie in the other
 * direction.
 */
const SECRET_KEY =
  /^([a-z0-9]+[-_]){0,2}(authorization|proxy-authorization|www-authenticate|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passwd|cookie|set-cookie|session[-_]?token|auth[-_]?token|bearer|credential|credentials)$/i;

/** Deepest structure walked when redacting; a payload is JSON, not a graph. */
const REDACT_MAX_DEPTH = 12;

/**
 * Replace credential-shaped values with `[redacted]`, everywhere, and say how
 * many were replaced. Structure is preserved so the row still reads normally.
 */
export function redact(value: unknown): { value: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > REDACT_MAX_DEPTH || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = "[redacted]";
        count += 1;
        continue;
      }
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return { value: walk(value, 0), count };
}

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
  detail?: unknown;
  at?: string;
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
  detail: string | null;
  detail_ref: string | null;
  detail_bytes: number | null;
  detail_type: string | null;
  detail_preview: string | null;
}

type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
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
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
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
  return db;
}

export class LogStore {
  private readonly db: Database;
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
  /** Open provider requests and tool calls, for latency and correlation. */
  private readonly openProviderRequests = new Map<string, { id: number; startedAt: number }>();
  private readonly openToolCalls = new Map<string, { id: number; startedAt: number; toolName: string }>();

  constructor(options: LogStoreOptions) {
    this.file = options.file;
    this.db = openDatabase(options.file);
    // 0 would make the OFFSET negative, which SQLite clamps to 0 — keeping one
    // row rather than none. A store has to hold at least one row to be a store.
    this.maxRows = Math.max(1, Math.trunc(options.maxRows ?? 200_000));
    this.providerPayloads = options.providerPayloads ?? "full";
    this.maxAgeMs = (options.maxAgeDays ?? 14) * 24 * 60 * 60 * 1000;
    this.pruneEvery = options.pruneEvery ?? 500;
    this.onAppend = options.onAppend;
    this.prune();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
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
    const at = input.at ?? new Date().toISOString();
    const level: LogLevel = input.level ?? "info";
    const detail = this.encodeDetail(input.detail);

    const info = this.db
      .prepare(
        `INSERT INTO entries
           (at, section, kind, level, cwd, session_path, summary, duration_ms, status, correlation_id,
            detail, detail_ref, detail_bytes, detail_type, detail_preview, search)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    this.onAppend?.([entry]);
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
    const { value, count } = redact(detail);
    // Say so rather than lying by omission: a row that dropped fields shows it.
    const safe =
      count > 0 && value !== null && typeof value === "object" && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), laserRedactedFields: count }
        : value;
    let body: string;
    try {
      body = JSON.stringify(safe) ?? "null";
    } catch {
      // A payload with a cycle or a BigInt is still worth a row.
      body = JSON.stringify({ laser: "payload was not JSON-serializable", type: typeof detail });
    }
    const bytes = Buffer.byteLength(body, "utf8");
    const preview = body.slice(0, PREVIEW_CHARS);
    if (bytes <= INLINE_LIMIT) {
      return { inline: body, ref: null, bytes, contentType: "application/json", preview };
    }
    const ref = createHash("sha256").update(body).digest("hex");
    this.db
      .prepare("INSERT OR IGNORE INTO content (ref, bytes, content_type, body) VALUES (?,?,?,?)")
      .run(ref, bytes, "application/json", body);
    return { inline: null, ref, bytes, contentType: "application/json", preview };
  }

  // ------------------------------------------------------------------- read

  query(query: LogQuery = {}): LogPage {
    const where: string[] = [];
    const params: unknown[] = [];
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

  content(ref: string, maxBytes = 4 * 1024 * 1024): {
    ref: string;
    contentType: string;
    bytes: number;
    truncated: boolean;
    text: string;
  } {
    const row = this.db.prepare("SELECT * FROM content WHERE ref = ?").get(ref) as
      | { ref: string; bytes: number; content_type: string; body: string }
      | undefined;
    if (!row) {
      throw new Error(
        `Log payload ${ref.slice(0, 12)}… is no longer stored. Retention removed the rows that referenced it.`,
      );
    }
    const truncated = row.body.length > maxBytes;
    return {
      ref: row.ref,
      contentType: row.content_type,
      bytes: row.bytes,
      truncated,
      text: truncated ? row.body.slice(0, maxBytes) : row.body,
    };
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
      retention: { maxRows: this.maxRows, maxAgeDays: Math.round(this.maxAgeMs / (24 * 60 * 60 * 1000)) },
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
    return Number(info.changes);
  }

  // -------------------------------------------------------------- retention

  /**
   * Retention runs off the hot path. `record()` is synchronous `node:sqlite`
   * and is called per tool event and per provider round-trip, so pruning
   * inline blocked the WebSocket fan-out — and the worker pipes behind it —
   * in the middle of a streaming turn.
   */
  private schedulePrune(): void {
    this.sincePrune = 0;
    if (this.pruneTimer || this.closed) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      if (this.closed) return;
      try {
        // The orphan sweep is an unindexed anti-join over every stored body, so
        // the automatic pass runs it on one prune in ten. An explicit `prune()`
        // (construction, tests, a manual clear) always sweeps.
        this.prune(++this.sinceSweep >= ORPHAN_SWEEP_EVERY);
        if (this.sinceSweep >= ORPHAN_SWEEP_EVERY) this.sinceSweep = 0;
      } catch {
        /* retention is housekeeping; a failed pass retries on the next batch */
      }
    }, 0);
    this.pruneTimer.unref?.();
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

  private collectOrphanedContent(): void {
    this.db.exec(
      "DELETE FROM content WHERE ref NOT IN (SELECT detail_ref FROM entries WHERE detail_ref IS NOT NULL)",
    );
  }

  private fileBytes(): number {
    if (this.file === ":memory:") return 0;
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  // --------------------------------------------------------------- ingestion

  /**
   * Messages from the laser companion extension running inside a session.
   * `provider-log` forwards Pi's request and response hooks; the request row
   * carries the whole payload, the response row closes it with status,
   * headers and latency.
   */
  observeExtensionMessage(cwd: string, sessionPath: string, message: PiExtensionMessage): void {
    switch (message.type) {
      case "lasercode/provider/request": {
        const entry = this.record({
          section: "provider",
          kind: "provider_request",
          cwd,
          sessionPath,
          at: message.at,
          summary: describeProviderRequest(message.payload),
          ...(this.providerPayloads === "full" ? { detail: message.payload } : {}),
        });
        if (entry) {
          this.openProviderRequests.set(sessionPath, { id: entry.id, startedAt: Date.parse(message.at) || Date.now() });
        }
        return;
      }
      case "lasercode/provider/response": {
        const open = this.openProviderRequests.get(sessionPath);
        this.openProviderRequests.delete(sessionPath);
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
      case "lasercode/subagents/event": {
        this.record({
          section: "subagents",
          kind: "subagent_event",
          cwd,
          sessionPath,
          summary: describeSubagentEvent(message.event),
          detail: message.event,
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
      case "agent_start":
      case "agent_end":
      case "agent_settled":
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
    ...(row.detail !== null ? { detail: safeParse(row.detail) } : {}),
    ...(row.detail_ref !== null
      ? {
          detailRef: {
            ref: row.detail_ref,
            bytes: row.detail_bytes ?? 0,
            contentType: (row.detail_type ?? "application/json") as LogContentRef["contentType"],
            preview: row.detail_preview ?? "",
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
 * One line describing a provider request. Pi hands us whatever the provider's
 * serializer produced, so this probes the fields the common shapes share
 * (Anthropic messages, OpenAI completions, OpenAI responses) and degrades to a
 * size when it recognises nothing.
 */
export function describeProviderRequest(payload: unknown): string {
  const body = payload as Record<string, unknown> | null;
  const size = (() => {
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

function describeSubagentEvent(event: unknown): string {
  const body = event as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return "subagent event";
  const type = typeof body["type"] === "string" ? body["type"] : "event";
  const run = typeof body["runId"] === "string" ? ` · ${body["runId"]}` : "";
  const agent = typeof body["agent"] === "string" ? ` · ${body["agent"]}` : "";
  return `${type}${agent}${run}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
