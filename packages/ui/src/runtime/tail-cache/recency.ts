/**
 * One authority over what this device holds, how recently it was used, and
 * when it expires (RP-10).
 *
 * Before this existed, a read touched one map and eviction sorted another, so a
 * record somebody had just read could still be chosen as the oldest. There is
 * now one index, and it answers three questions:
 *
 * - **what is held**: one accounting row per record, bounded by the policy's
 *   record ceiling, carrying only opaque identity and exact bytes;
 * - **what is hot**: the frozen records a synchronous `peek` may return, at
 *   most {@link HotLimits.records} of them and {@link HotLimits.bytes} in total;
 * - **what is next**: eviction order (least recently *used*, and expiry first).
 *
 * Recency lives here rather than inside the frozen records, which is what keeps
 * `peek` allocation-free: a hit is a map lookup and one number written beside
 * the record, never a rewritten object.
 *
 * Pure: no storage, no vault, no publishing. It reports intents — "this needs a
 * durable touch", "this has expired" — and the mutation owner acts on them.
 */
import type { TailRecord } from "./record.js";
import type { TailBounds } from "./bounds.js";

export interface HotLimits {
  records: number;
  bytes: number;
}

/**
 * One record this environment holds, as the accounting sees it.
 *
 * It carries the ordering metadata as well as the bytes, because freshness has
 * to be decidable for a record that is **held but not hot**: an older tail must
 * not overwrite a newer cold row just because its object is no longer in
 * memory. Within one engine generation `seq` orders two captures; across
 * generations only `capturedAt` can, because `seq` restarts (D-g).
 */
export interface HeldRow {
  readonly sessionId: string;
  readonly bytes: number;
  /** When it was last used: a read or a write, never a background update. */
  readonly usedAt: number;
  readonly capturedAt: string;
  readonly epoch: string;
  readonly seq: number;
}

export interface RecencyIndex {
  /** Adopt the validated set a preparation pass produced. Replaces everything. */
  adopt(rows: readonly HeldRow[], hot: readonly TailRecord[]): void;
  /** One record was written or read: hold it, and make it the most recent. */
  remember(record: TailRecord, usedAt: number): void;
  /** The frozen record for a session, if it is hot. Allocation-free. */
  hot(sessionId: string): TailRecord | undefined;
  /** Keep the accounting without keeping the object (a validated cold row). */
  cool(sessionId: string): void;
  forget(sessionId: string): void;
  clear(): void;
  has(sessionId: string): boolean;
  held(sessionId: string): HeldRow | undefined;
  rows(): readonly HeldRow[];
  records(): number;
  bytes(): number;
  hotRecords(): number;
  hotBytes(): number;
  /** Mark a use. Returns true when a durable touch is worth persisting. */
  touch(sessionId: string, usedAt: number): boolean;
  /** What was last persisted for this session, for a failed touch to restore. */
  persistedAt(sessionId: string): number;
  /**
   * A durable touch did not commit: forget that it was ever persisted.
   *
   * Recency this device claims to have written has to be recency it wrote. The
   * in-memory use stands — somebody did read it — but the watermark goes back,
   * so the next read tries again instead of believing a write that failed.
   */
  untouch(sessionId: string, persistedAt: number): void;
  /** Everything past its age, oldest first. */
  expired(now: number, ageMs: number): readonly HeldRow[];
  /**
   * The fewest records to drop so that the projection fits, least recently used
   * first, never `keep`, and never more than `max`.
   */
  plan(options: {
    bounds: TailBounds;
    keep: string;
    incoming?: { sessionId: string; bytes: number } | undefined;
    minimum?: number | undefined;
    max: number;
  }): { doomed: string[]; fits: boolean };
}

/**
 * How much a record's recency must move before it is worth a durable write.
 *
 * A durable touch costs a transaction, and the in-memory index is the authority
 * for this page's own eviction, so the persisted value only has to be good
 * enough for the *next* start. An hour is well inside the age bound and keeps a
 * chatty session from writing on every read.
 */
export const DURABLE_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function createRecencyIndex(limits: HotLimits): RecencyIndex {
  const held = new Map<string, HeldRow>();
  const objects = new Map<string, TailRecord>();
  /** What was last persisted, so a touch is written at most once an interval. */
  const persisted = new Map<string, number>();

  /** What this index last persisted for a session, for a failed touch to restore. */
  const persistedAt = (sessionId: string): number => persisted.get(sessionId) ?? 0;

  const trimHot = (): void => {
    const overBytes = (): boolean => {
      let bytes = 0;
      for (const record of objects.values()) bytes += record.bytes;
      return bytes > limits.bytes;
    };
    while (objects.size > limits.records || (objects.size > 1 && overBytes())) {
      let oldest: string | undefined;
      let when = Infinity;
      for (const sessionId of objects.keys()) {
        const used = held.get(sessionId)?.usedAt ?? 0;
        if (used < when) {
          when = used;
          oldest = sessionId;
        }
      }
      if (oldest === undefined) break;
      objects.delete(oldest);
    }
  };

  return {
    persistedAt,

    adopt(rows, hot) {
      held.clear();
      objects.clear();
      persisted.clear();
      for (const row of rows) held.set(row.sessionId, row);
      for (const record of hot) {
        if (held.has(record.sessionId)) objects.set(record.sessionId, record);
      }
      for (const row of rows) persisted.set(row.sessionId, row.usedAt);
      trimHot();
    },

    remember(record, usedAt) {
      held.set(record.sessionId, {
        sessionId: record.sessionId,
        bytes: record.bytes,
        usedAt,
        capturedAt: record.capturedAt,
        epoch: record.epoch,
        seq: record.seq,
      });
      objects.set(record.sessionId, record);
      persisted.set(record.sessionId, usedAt);
      trimHot();
    },

    hot: (sessionId) => objects.get(sessionId),

    cool(sessionId) {
      objects.delete(sessionId);
    },

    forget(sessionId) {
      held.delete(sessionId);
      objects.delete(sessionId);
      persisted.delete(sessionId);
    },

    clear() {
      held.clear();
      objects.clear();
      persisted.clear();
    },

    has: (sessionId) => held.has(sessionId),
    held: (sessionId) => held.get(sessionId),
    rows: () => [...held.values()],
    records: () => held.size,
    bytes() {
      let bytes = 0;
      for (const row of held.values()) bytes += row.bytes;
      return bytes;
    },
    hotRecords: () => objects.size,
    hotBytes() {
      let bytes = 0;
      for (const record of objects.values()) bytes += record.bytes;
      return bytes;
    },

    touch(sessionId, usedAt) {
      const row = held.get(sessionId);
      if (!row) return false;
      held.set(sessionId, { ...row, usedAt });
      const last = persisted.get(sessionId) ?? 0;
      if (usedAt - last < DURABLE_TOUCH_INTERVAL_MS) return false;
      persisted.set(sessionId, usedAt);
      return true;
    },

    untouch(sessionId, persistedAt) {
      if (!held.has(sessionId)) {
        persisted.delete(sessionId);
        return;
      }
      persisted.set(sessionId, persistedAt);
    },

    expired(now, ageMs) {
      const gone: HeldRow[] = [];
      for (const row of held.values()) {
        const at = Date.parse(row.capturedAt);
        if (!Number.isFinite(at) || at > now + 60_000 || now - at > ageMs) gone.push(row);
      }
      return gone.sort((a, b) => a.usedAt - b.usedAt);
    },

    plan(options) {
      const existing = held.get(options.keep);
      let records = held.size + (options.incoming && !existing ? 1 : 0);
      let bytes = this.bytes() + (options.incoming ? options.incoming.bytes - (existing?.bytes ?? 0) : 0);
      const minimum = options.minimum ?? 0;
      const candidates = [...held.values()]
        .filter((row) => row.sessionId !== options.keep)
        .sort((a, b) => a.usedAt - b.usedAt);
      const doomed: string[] = [];
      for (const row of candidates) {
        const inside = records <= options.bounds.sessions && bytes <= options.bounds.bytes;
        if (inside && doomed.length >= minimum) break;
        if (doomed.length >= options.max) break;
        doomed.push(row.sessionId);
        records -= 1;
        bytes -= row.bytes;
      }
      const fits = records <= options.bounds.sessions && bytes <= options.bounds.bytes && doomed.length >= minimum;
      return { doomed, fits };
    },
  };
}
