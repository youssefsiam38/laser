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
 * ## What is bounded, and what that costs
 *
 * An audit that can be made to grow without limit is a denial-of-service
 * surface and a privacy problem of its own, so **every** row is bounded. The
 * honest consequence is that under a flood some decisions are counted rather
 * than described, and this module says so out loud rather than promising a row
 * per refusal it cannot keep:
 *
 * - **Refusals have reserved capacity.** Per actor and host-globally, a slice
 *   of each window's allowance can only be spent by refusals
 *   ({@link AuditBounds.perActorRefusals}, {@link AuditBounds.globalRefusals}).
 *   Ordinary allowed traffic — however much of it there is — cannot consume
 *   it, so the security-relevant records survive a busy host.
 * - **Refusals past that reserve roll into a summary**, one counted row per
 *   actor per window, never silence.
 * - **Summaries are bounded too**, host-wide per window
 *   ({@link AuditBounds.summaries}); past that they roll into a single
 *   host-level row. Actor churn — a new opaque id per connection attempt —
 *   therefore cannot mint rows by being evicted.
 * - **Per window, the whole module writes at most**
 *   `global + summaries + 1` rows. That ceiling holds under reconnect loops
 *   and actor churn, and `access.test.ts` proves it.
 *
 * High-frequency streams are counted rather than written per call
 * (`MethodPolicy.audit: "summary"`, today `pi/transcribe/chunk`): two minutes
 * of dictation is one row, and it spends neither the per-call allowance nor
 * the refusal reserve.
 *
 * Successful reads are summarised by default: one counted row per actor per
 * window rather than a row per transcript read. `audit.reads: "each"` in the
 * environment policy records them individually. An **errored** read is never
 * counted as a success — it is an individual row, subject to the ordinary
 * bounds, because an error is a decision that ended badly and a counter cannot
 * say why.
 */
import { WIRE_NAMESPACE, methodPolicy, type AuditReadMode, type ActorClass, type MethodScope } from "@lasercode/protocol";
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
  /** Rows one actor may write per window, refusals included. */
  perActor: number;
  /** How many of `perActor` only a refusal may spend. */
  perActorRefusals: number;
  /** Rows every actor together may write per window, refusals included. */
  global: number;
  /** How many of `global` only a refusal may spend. */
  globalRefusals: number;
  /** Actors whose counters are retained; the least recently seen is evicted. */
  maxActors: number;
  /** Summary rows (reads, streams, drops) the host may write per window. */
  summaries: number;
  windowMs: number;
}

export const DEFAULT_AUDIT_BOUNDS: AuditBounds = {
  perActor: 120,
  perActorRefusals: 40,
  global: 1_200,
  globalRefusals: 400,
  maxActors: 256,
  summaries: 512,
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
  /** Rows written this window, refusals included. */
  written: number;
  /** Ordinary rows dropped for want of allowance. */
  dropped: number;
  /** Refusals dropped past the reserve. Counted separately: they matter more. */
  refusalsDropped: number;
  /** Successful reads and handshakes, when they are summarised. */
  reads: number;
  /** Successful calls of a stream method, by method name. Bounded by the table. */
  streams: Map<string, number>;
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
  private globalRefusalsDropped = 0;
  /** Summary rows written this window, and the ones that did not fit. */
  private summariesWritten = 0;
  private summariesRolled = 0;
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
   * A refusal takes from the reserve that only refusals may spend, so ordinary
   * traffic cannot crowd it out; past the reserve it is counted and reported
   * as a summary rather than dropped silently. A successful read, handshake or
   * stream call is counted. Everything else is a row.
   */
  record(record: AccessAuditRecord): void {
    if (this.closed) return;
    // Every record rolls the host's window when it is due, not only the ones
    // that ask for an allowance: a host whose traffic is *all* summarised
    // (reads, dictation) must get a fresh summary budget too.
    this.rollGlobalWindow();
    const state = this.actorState(record.actorId, record.actorClass);
    if (record.outcome === "ok") {
      const stream = record.method !== undefined ? methodPolicy(record.method)?.audit : undefined;
      if (stream === "summary" && record.method !== undefined) {
        state.streams.set(record.method, (state.streams.get(record.method) ?? 0) + 1);
        return;
      }
      if (this.reads === "summary" && (record.scope === "read" || record.scope === "handshake")) {
        state.reads += 1;
        return;
      }
    }
    if (!this.take(state, record.outcome === "refused")) return;
    this.write({
      section: "host",
      kind: record.outcome === "refused" ? "access_refused" : record.outcome === "error" ? "access_error" : "access_allowed",
      level: record.outcome === "refused" ? "warn" : "info",
      summary: summaryLine(record),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      detail: detailOf(record),
    });
  }

  /** Write every pending counter now. Safe to call at any time. */
  flush(): void {
    if (this.closed) return;
    for (const [actorId, state] of [...this.actors]) this.flushActor(actorId, state);
    this.flushGlobalCounters();
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
      refusalsDropped: 0,
      reads: 0,
      streams: new Map(),
      lastSeenAt: at,
    };
    this.actors.set(actorId, state);
    return state;
  }

  /**
   * One allowance from the actor's window and one from the host's.
   *
   * A refusal may spend the whole window; ordinary traffic may spend all but
   * the reserve. That is the entire difference, and it is what keeps a busy
   * host from hiding the one record a person would want to read.
   */
  private take(state: ActorState, refusal: boolean): boolean {
    this.rollGlobalWindow();
    const actorCeiling = refusal ? this.bounds.perActor : Math.max(0, this.bounds.perActor - this.bounds.perActorRefusals);
    const globalCeiling = refusal ? this.bounds.global : Math.max(0, this.bounds.global - this.bounds.globalRefusals);
    if (state.written >= actorCeiling) {
      if (refusal) state.refusalsDropped += 1; else state.dropped += 1;
      return false;
    }
    if (this.globalWritten >= globalCeiling) {
      if (refusal) {
        state.refusalsDropped += 1;
        this.globalRefusalsDropped += 1;
      } else {
        state.dropped += 1;
        this.globalDropped += 1;
      }
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
      this.writeSummary({
        section: "host",
        kind: "access_reads",
        level: "info",
        summary: `${actorId} read ${reads} time${reads === 1 ? "" : "s"}`,
        detail: { actor: actorId, actorClass: state.actorClass, outcome: "ok", reads },
      });
    }
    for (const [method, calls] of [...state.streams]) {
      state.streams.delete(method);
      this.writeSummary({
        section: "host",
        kind: "access_stream",
        level: "info",
        summary: `${actorId} ${method} ${calls} time${calls === 1 ? "" : "s"}`,
        detail: { actor: actorId, actorClass: state.actorClass, method, outcome: "ok", calls },
      });
    }
    if (state.dropped > 0 || state.refusalsDropped > 0) {
      const dropped = state.dropped;
      const refusalsDropped = state.refusalsDropped;
      state.dropped = 0;
      state.refusalsDropped = 0;
      const total = dropped + refusalsDropped;
      this.writeSummary({
        section: "host",
        kind: "access_dropped",
        level: "warn",
        summary:
          `${actorId} exceeded the audit rate: ${total} record${total === 1 ? "" : "s"} not written` +
          (refusalsDropped > 0 ? `, ${refusalsDropped} of them refusals` : ""),
        detail: {
          actor: actorId,
          actorClass: state.actorClass,
          outcome: "error",
          dropped,
          refusalsDropped,
        },
      });
    }
  }

  /** Start the host's next window when the current one is over, and only then. */
  private rollGlobalWindow(): void {
    const at = this.now();
    if (at - this.globalWindowStartedAt < this.bounds.windowMs) return;
    this.flushGlobalCounters();
    this.globalWindowStartedAt = at;
    this.globalWritten = 0;
    this.summariesWritten = 0;
  }

  /** The host's own counters: what its ceiling cost, and what did not fit. */
  private flushGlobalCounters(): void {
    if (this.globalDropped > 0 || this.globalRefusalsDropped > 0) {
      const dropped = this.globalDropped;
      const refusalsDropped = this.globalRefusalsDropped;
      this.globalDropped = 0;
      this.globalRefusalsDropped = 0;
      const total = dropped + refusalsDropped;
      this.writeSummary({
        section: "host",
        kind: "access_dropped",
        level: "warn",
        summary:
          `the host exceeded its audit rate: ${total} record${total === 1 ? "" : "s"} not written` +
          (refusalsDropped > 0 ? `, ${refusalsDropped} of them refusals` : ""),
        detail: { actor: "(host)", outcome: "error", dropped, refusalsDropped },
      });
    }
    if (this.summariesRolled > 0) {
      const rolled = this.summariesRolled;
      this.summariesRolled = 0;
      // Not a summary itself: exactly one of these can exist per window, which
      // is what keeps the ceiling `global + summaries + 1`.
      this.write({
        section: "host",
        kind: "access_rollup",
        level: "warn",
        summary: `the host reached its audit summary ceiling: ${rolled} summar${rolled === 1 ? "y" : "ies"} not written`,
        detail: { actor: "(host)", outcome: "error", summaries: rolled },
      });
    }
  }

  /**
   * A counted row. Bounded host-wide per window, so no amount of actor churn
   * (each connection attempt can invent an id) turns eviction into rows.
   */
  private writeSummary(input: LogInput): void {
    if (this.summariesWritten >= this.bounds.summaries) {
      this.summariesRolled += 1;
      return;
    }
    this.summariesWritten += 1;
    this.write(input);
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
