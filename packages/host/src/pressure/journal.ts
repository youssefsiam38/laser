/**
 * The one journal (RP-8).
 *
 * Every action any process of this app took because of memory pressure is
 * recorded here, once, by the host — and nowhere else. A worker's report
 * carries anonymous rows; this file is what turns one of them into an *event*,
 * by adding the identity only the host can give it: the journal's own ordinal,
 * the host's clock, the role the row is about, and — when the host already has
 * one — the process inventory's opaque salted project id. Nothing a peer sent
 * can choose any of those, and nothing here can carry a path, a pid, a start
 * token, a private generation, an argv, a URL, a payload or an error's text:
 * there is no field for one.
 *
 * It is bounded three independent ways, with the protocol's own numbers: age
 * first, then count, then bytes. The bytes are the row's exact UTF-8 serialized
 * size, measured once when it is recorded and subtracted when it leaves, so the
 * figure a page reports is the figure the journal is actually holding.
 *
 * Everything here is synchronous. An insert is a push plus a bounded eviction
 * loop over an array and two counters, with no `await` inside it, so no reader
 * can ever see a half-evicted journal.
 */
import {
  MEMORY_PRESSURE_EVENTS_MAX,
  MEMORY_PRESSURE_EVENTS_MAX_BYTES,
  MEMORY_PRESSURE_EVENTS_PAGE,
  MEMORY_PRESSURE_EVENT_ID,
  MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
  parseMemoryPressureJournalPage,
  type MemoryPressureActionResult,
  type MemoryPressureEvent,
  type MemoryPressureLevel,
  type MemoryPressureRole,
  type ValidatedMemoryPressureJournalPage,
} from "@lasercode/protocol";

/** What the host knows about a row that the row itself cannot say. */
export interface PressureEventIdentity {
  role: MemoryPressureRole;
  level: MemoryPressureLevel;
  /** The inventory's opaque salted project id (RP-1), when there is one. */
  project?: string | undefined;
}

export interface PressureJournalOptions {
  now?: () => number;
  maxEvents?: number;
  maxAgeMs?: number;
  maxBytes?: number;
}

export interface PressureJournalTotals {
  events: number;
  released: { count: number; bytes: number };
  refusals: number;
}

interface Entry {
  event: MemoryPressureEvent;
  bytes: number;
}

export class PressureJournal {
  /** Oldest first; a page reverses it. */
  private readonly entries: Entry[] = [];
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private ordinal = 0;
  private retainedBytes = 0;
  private evictedBy: "age" | "events" | "bytes" | undefined;
  /** Rows this journal refused to record because it could not name them. */
  private refusedRows = 0;

  constructor(options: PressureJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEvents = options.maxEvents ?? MEMORY_PRESSURE_EVENTS_MAX;
    this.maxAgeMs = options.maxAgeMs ?? MEMORY_PRESSURE_EVENT_MAX_AGE_MS;
    this.maxBytes = options.maxBytes ?? MEMORY_PRESSURE_EVENTS_MAX_BYTES;
  }

  /**
   * Record one row. Returns the event it became, or nothing when it could not
   * be recorded — which is a fault of this journal's own and is never reported
   * as something that happened.
   */
  add(row: MemoryPressureActionResult, identity: PressureEventIdentity): MemoryPressureEvent | undefined {
    const at = this.now();
    const read = Number.isSafeInteger(at) && at >= 0 ? at : 0;
    // The journal's own clock never goes backwards. A page is ordered newest
    // first by id *and* by time, so a system clock that steps back would
    // otherwise produce a page contradicting its own order. The step back is
    // absorbed here rather than written down as a time that never happened.
    const atMs = Math.max(read, this.entries.length > 0 ? this.entries[this.entries.length - 1]!.event.atMs : 0);
    const id = `mp_${this.ordinal + 1}`;
    // Past the id's own shape there is no value left that is still distinct, so
    // the journal stops naming events rather than naming two of them the same.
    if (!MEMORY_PRESSURE_EVENT_ID.test(id)) {
      this.refusedRows += 1;
      return undefined;
    }
    this.ordinal += 1;
    const event: MemoryPressureEvent = {
      id,
      atMs,
      role: identity.role,
      level: identity.level,
      ...(identity.project !== undefined ? { project: identity.project } : {}),
      ...row,
    };
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    } catch {
      this.refusedRows += 1;
      return undefined;
    }
    this.entries.push({ event, bytes });
    this.retainedBytes += bytes;
    this.evict(atMs);
    return event;
  }

  /** Drop what is too old, then too many, then too much. Oldest first, always. */
  private evict(now: number): void {
    while (this.entries.length > 0 && now - this.entries[0]!.event.atMs > this.maxAgeMs) {
      this.drop("age");
    }
    while (this.entries.length > this.maxEvents) this.drop("events");
    while (this.entries.length > 0 && this.retainedBytes > this.maxBytes) this.drop("bytes");
  }

  private drop(by: "age" | "events" | "bytes"): void {
    const entry = this.entries.shift();
    if (!entry) return;
    this.retainedBytes -= entry.bytes;
    if (this.retainedBytes < 0) this.retainedBytes = 0;
    this.evictedBy = by;
  }

  /** Age out whatever the clock has passed, without recording anything. */
  prune(): void {
    this.evict(this.now());
  }

  /**
   * One bounded read, newest first and validated.
   *
   * `limit` may be smaller than the page bound: a diagnostic export trims the
   * page it carries so the whole document stays inside its byte budget, and the
   * retention counters beside it keep describing the whole journal rather than
   * the slice.
   */
  page(limit: number = MEMORY_PRESSURE_EVENTS_PAGE): ValidatedMemoryPressureJournalPage {
    this.prune();
    const take = Math.max(0, Math.min(Math.floor(limit), MEMORY_PRESSURE_EVENTS_PAGE, this.entries.length));
    const events = this.entries.slice(this.entries.length - take).map((entry) => entry.event).reverse();
    return parseMemoryPressureJournalPage({
      events,
      retention: {
        maxEvents: MEMORY_PRESSURE_EVENTS_MAX,
        maxAgeMs: MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
        maxBytes: MEMORY_PRESSURE_EVENTS_MAX_BYTES,
        events: this.entries.length,
        bytes: this.retainedBytes,
        ...(this.evictedBy !== undefined ? { lastEvictedBy: this.evictedBy } : {}),
      },
    });
  }

  /** What the journal is holding right now, as a summary reports it. */
  totals(): PressureJournalTotals {
    this.prune();
    let count = 0;
    let bytes = 0;
    let refusals = 0;
    for (const { event } of this.entries) {
      if (event.outcome === "released" && event.released) {
        count += event.released.count ?? 0;
        bytes += event.released.bytes ?? 0;
      }
      if (event.action === "admission_refused") refusals += 1;
    }
    return { events: this.entries.length, released: { count, bytes }, refusals };
  }

  /** The newest retained event's id, for joining a summary to a page. */
  latestEventId(): string | undefined {
    this.prune();
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.event.id : undefined;
  }

  /** Deterministic evidence: what it holds, and what it could not record. */
  counts(): { events: number; bytes: number; lastEvictedBy?: "age" | "events" | "bytes"; refusedRows: number } {
    return {
      events: this.entries.length,
      bytes: this.retainedBytes,
      ...(this.evictedBy !== undefined ? { lastEvictedBy: this.evictedBy } : {}),
      refusedRows: this.refusedRows,
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.retainedBytes = 0;
  }
}
