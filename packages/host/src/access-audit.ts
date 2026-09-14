/**
 * The access audit (RP-13).
 *
 * One record per decision the host boundary made, and nothing else in it. An
 * audit row names **who** (an opaque, salted actor id), **what** (a method
 * name the authorization table already knows) and **how it ended**. It never
 * names a conversation, a path, a project, a provider payload, a command line,
 * an environment variable, a session id, an artifact or an inspector URL —
 * the record type below has no field capable of carrying one, which is a
 * stronger guarantee than redacting at the sink.
 *
 * Volume is bounded three ways, because an audit that can be made to grow
 * without limit is a denial-of-service surface and a privacy problem of its
 * own:
 *
 * 1. **Per actor**, a token count per window.
 * 2. **Host-global**, a second count per window. Reconnecting mints a new
 *    connection but not a new actor and never a new global allowance, so a
 *    reconnect loop cannot write more than a steady one.
 * 3. **Bounded actor table**, with least-recently-used eviction. An evicted
 *    actor's pending read summary is flushed on its way out, so eviction
 *    loses counters, never records.
 *
 * Reads are summarised by default: one counted row per actor per window rather
 * than a row per transcript read. `audit.reads: "each"` in the environment
 * policy records them individually.
 */
import { WIRE_NAMESPACE, type AuditReadMode, type ActorClass, type MethodScope } from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";
import type { LogInput } from "./logstore.js";

/** How a decision ended. `refused` is the boundary's own no. */
export type AuditOutcome = "ok" | "error" | "refused";

/** The complete vocabulary of an audit record. Deliberately closed. */
export interface AccessAuditRecord {
  actorId: string;
  actorClass: ActorClass;
  /** A method the table knows, or `undefined` for one it does not. */
  method: string | undefined;
  /** Correlation tag for a method the table does not know. Never the name. */
  methodDigest?: string;
  scope: MethodScope | undefined;
  outcome: AuditOutcome;
  /** JSON-RPC error code, when the call ended in one. */
  code?: number;
  durationMs?: number;
  /** Why the boundary refused: reach, scope or an unknown method. */
  reason?: "reach" | "scope" | "unknown_method";
}

/** Anything that can take a log row. `LogStore` satisfies it. */
export interface AuditSink {
  record(input: LogInput): unknown;
}

export interface AuditBounds {
  /** Rows one actor may write per window. */
  perActor: number;
  /** Rows every actor together may write per window. */
  global: number;
  /** Actors whose counters are retained; the least recently seen is evicted. */
  maxActors: number;
  windowMs: number;
}

export const DEFAULT_AUDIT_BOUNDS: AuditBounds = {
  perActor: 120,
  global: 1_200,
  maxActors: 256,
  windowMs: 60_000,
};

export interface AccessAuditOptions {
  /** Absent (or a host that could not open its store) still audits to the log. */
  sink?: AuditSink | undefined;
  /** The host's own redacting log line writer. */
  log?: ((line: string) => void) | undefined;
  reads?: AuditReadMode;
  bounds?: Partial<AuditBounds>;
  now?: () => number;
  /** Off in tests: the window rolls on the next record and on `close()`. */
  autoFlush?: boolean;
}

interface ActorState {
  actorClass: ActorClass;
  windowStartedAt: number;
  written: number;
  dropped: number;
  reads: number;
  lastSeenAt: number;
}

/** The placeholder a method the table does not know is recorded as. */
export const UNKNOWN_METHOD_LABEL = "(unknown method)";

/** A short, non-reversible tag for an unknown method name, for correlation only. */
export function unknownMethodDigest(method: string): string {
  return nodeRevisionHasher(`${WIRE_NAMESPACE}|audit-method|${method}`).slice(0, 8);
}

export class AccessAudit {
  private readonly bounds: AuditBounds;
  private readonly reads: AuditReadMode;
  private readonly now: () => number;
  /** Insertion order is the LRU order: a touched actor is re-inserted last. */
  private readonly actors = new Map<string, ActorState>();
  private globalWindowStartedAt: number;
  private globalWritten = 0;
  private globalDropped = 0;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly options: AccessAuditOptions = {}) {
    this.bounds = { ...DEFAULT_AUDIT_BOUNDS, ...options.bounds };
    this.reads = options.reads ?? "summary";
    this.now = options.now ?? Date.now;
    this.globalWindowStartedAt = this.now();
    if (options.autoFlush !== false) {
      this.flushTimer = setInterval(() => this.flush(), this.bounds.windowMs);
      this.flushTimer.unref?.();
    }
  }

  /**
   * Record one decision.
   *
   * A refusal is always a row of its own: it is the security-relevant record
   * and must not disappear into a counter. An allowed read is counted when
   * `reads` is `summary`; everything else is a row.
   */
  record(record: AccessAuditRecord): void {
    if (this.closed) return;
    const state = this.actorState(record.actorId, record.actorClass);
    const summarised = this.reads === "summary" && record.outcome !== "refused" && (record.scope === "read" || record.scope === "handshake");
    if (summarised) {
      state.reads += 1;
      return;
    }
    if (!this.take(state)) return;
    this.write({
      section: "host",
      kind: record.outcome === "refused" ? "access_refused" : "access_allowed",
      level: record.outcome === "refused" ? "warn" : record.outcome === "error" ? "info" : "info",
      summary: summaryLine(record),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      detail: detailOf(record),
    });
  }

  /** Write every pending counter now. Safe to call at any time. */
  flush(): void {
    if (this.closed) return;
    for (const [actorId, state] of [...this.actors]) this.flushActor(actorId, state);
    this.flushGlobalDrops();
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.actors.clear();
  }

  // ------------------------------------------------------------- internals

  private actorState(actorId: string, actorClass: ActorClass): ActorState {
    const at = this.now();
    const existing = this.actors.get(actorId);
    if (existing) {
      existing.lastSeenAt = at;
      if (at - existing.windowStartedAt >= this.bounds.windowMs) {
        this.flushActor(actorId, existing);
        existing.windowStartedAt = at;
        existing.written = 0;
        existing.dropped = 0;
      }
      // Re-insert so iteration order stays least-recently-seen first.
      this.actors.delete(actorId);
      this.actors.set(actorId, existing);
      return existing;
    }
    while (this.actors.size >= this.bounds.maxActors) {
      const oldest = this.actors.keys().next();
      if (oldest.done) break;
      const evicted = this.actors.get(oldest.value)!;
      this.flushActor(oldest.value, evicted);
      this.actors.delete(oldest.value);
    }
    const state: ActorState = {
      actorClass,
      windowStartedAt: at,
      written: 0,
      dropped: 0,
      reads: 0,
      lastSeenAt: at,
    };
    this.actors.set(actorId, state);
    return state;
  }

  /** One allowance from the actor's window and one from the host's. */
  private take(state: ActorState): boolean {
    const at = this.now();
    if (at - this.globalWindowStartedAt >= this.bounds.windowMs) {
      this.flushGlobalDrops();
      this.globalWindowStartedAt = at;
      this.globalWritten = 0;
    }
    if (state.written >= this.bounds.perActor) {
      state.dropped += 1;
      return false;
    }
    if (this.globalWritten >= this.bounds.global) {
      state.dropped += 1;
      this.globalDropped += 1;
      return false;
    }
    state.written += 1;
    this.globalWritten += 1;
    return true;
  }

  private flushActor(actorId: string, state: ActorState): void {
    if (state.reads > 0) {
      const reads = state.reads;
      state.reads = 0;
      this.write({
        section: "host",
        kind: "access_reads",
        level: "info",
        summary: `${actorId} read ${reads} time${reads === 1 ? "" : "s"}`,
        detail: { actor: actorId, actorClass: state.actorClass, outcome: "ok", reads },
      });
    }
    if (state.dropped > 0) {
      const dropped = state.dropped;
      state.dropped = 0;
      this.write({
        section: "host",
        kind: "access_dropped",
        level: "warn",
        summary: `${actorId} exceeded the audit rate: ${dropped} record${dropped === 1 ? "" : "s"} not written`,
        detail: { actor: actorId, actorClass: state.actorClass, outcome: "error", dropped },
      });
    }
  }

  private flushGlobalDrops(): void {
    if (this.globalDropped === 0) return;
    const dropped = this.globalDropped;
    this.globalDropped = 0;
    this.write({
      section: "host",
      kind: "access_dropped",
      level: "warn",
      summary: `the host exceeded its audit rate: ${dropped} record${dropped === 1 ? "" : "s"} not written`,
      detail: { actor: "(host)", outcome: "error", dropped },
    });
  }

  /**
   * A row goes to the store when there is one. With no store — a host started
   * without logging, or one whose SQLite would not open — the decision still
   * reaches the host's own log line, which is already redacted at its sink.
   */
  private write(input: LogInput): void {
    const sink = this.options.sink;
    if (sink) {
      try {
        // Stored and queryable, never streamed: see `LogInput.quiet`.
        sink.record({ ...input, quiet: true });
        return;
      } catch {
        // A store that refuses a row must not take the decision with it.
      }
    }
    this.options.log?.(`access: ${input.summary}`);
  }
}

function summaryLine(record: AccessAuditRecord): string {
  const method = record.method ?? `${UNKNOWN_METHOD_LABEL}`;
  const ending = record.outcome === "refused" ? `refused (${record.reason ?? "policy"})` : record.outcome;
  return `${record.actorId} ${method} ${ending}`;
}

function detailOf(record: AccessAuditRecord): Record<string, unknown> {
  return {
    actor: record.actorId,
    actorClass: record.actorClass,
    method: record.method ?? UNKNOWN_METHOD_LABEL,
    ...(record.method === undefined && record.methodDigest !== undefined ? { methodDigest: record.methodDigest } : {}),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    outcome: record.outcome,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.code !== undefined ? { code: record.code } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
  };
}
