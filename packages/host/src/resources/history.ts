/**
 * Retained snapshots, bounded four ways at once.
 *
 * Age, snapshot count, process rows and bytes are **independent** limits, not a
 * single budget with three decorations: a machine with six processes hits the
 * age limit long before the row limit, and a machine with two thousand hits the
 * row limit in a handful of snapshots. Whichever binds first evicts, and the
 * retention report says which one did, so the retention rule can be explained
 * to a person rather than felt as unexplained disappearance.
 *
 * Everything here is in memory. Nothing about the process inventory is written
 * to disk in this slice.
 */
import {
  RESOURCE_HISTORY_MAX_AGE_MS,
  RESOURCE_HISTORY_MAX_BYTES,
  RESOURCE_HISTORY_MAX_PROCESS_ROWS,
  RESOURCE_HISTORY_MAX_SNAPSHOTS,
  RESOURCE_HISTORY_PAGE_MAX,
  type ResourceRetention,
  type ResourceSnapshot,
} from "@lasercode/protocol";

export interface ResourceHistoryOptions {
  maxAgeMs?: number;
  maxSnapshots?: number;
  maxProcessRows?: number;
  maxBytes?: number;
  now?: () => number;
}

interface Entry {
  snapshot: ResourceSnapshot;
  atMs: number;
  rows: number;
  bytes: number;
}

export class ResourceHistory {
  private readonly entries: Entry[] = [];
  private readonly limits: Required<Omit<ResourceHistoryOptions, "now">>;
  private readonly now: () => number;
  private rows = 0;
  private bytes = 0;
  private lastEvictedBy: ResourceRetention["lastEvictedBy"];

  constructor(options: ResourceHistoryOptions = {}) {
    this.limits = {
      maxAgeMs: options.maxAgeMs ?? RESOURCE_HISTORY_MAX_AGE_MS,
      maxSnapshots: options.maxSnapshots ?? RESOURCE_HISTORY_MAX_SNAPSHOTS,
      maxProcessRows: options.maxProcessRows ?? RESOURCE_HISTORY_MAX_PROCESS_ROWS,
      maxBytes: options.maxBytes ?? RESOURCE_HISTORY_MAX_BYTES,
    };
    this.now = options.now ?? Date.now;
  }

  add(snapshot: ResourceSnapshot): void {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    this.entries.push({ snapshot, atMs: this.now(), rows: snapshot.processes.length, bytes });
    this.rows += snapshot.processes.length;
    this.bytes += bytes;
    this.enforce();
  }

  /** Newest last. `sinceId` continues after that snapshot; unknown ids page from the start. */
  page(options: { sinceId?: string; limit?: number } = {}): ResourceSnapshot[] {
    this.enforce();
    const limit = Math.min(Math.max(1, options.limit ?? RESOURCE_HISTORY_PAGE_MAX), RESOURCE_HISTORY_PAGE_MAX);
    let start = 0;
    if (options.sinceId) {
      const index = this.entries.findIndex((entry) => entry.snapshot.id === options.sinceId);
      if (index >= 0) start = index + 1;
    }
    // From `start` forward, not the newest `limit` of what follows it: paging
    // must be able to walk the middle of the history, and a page that jumps to
    // the end would silently drop every sample in between.
    return this.entries.slice(start, start + limit).map((entry) => entry.snapshot);
  }

  /**
   * The newest `limit` snapshots, still oldest-first.
   *
   * `page()` is a forward pager and has to stay one: a caller walking with a
   * cursor must be able to visit the middle of the history. "The last few
   * minutes", which is what a trend and a diagnostic document actually want,
   * is a different question — asking it by walking sixty pages would be
   * absurd, and answering it with the *oldest* window is simply wrong.
   */
  recent(limit: number = RESOURCE_HISTORY_PAGE_MAX): ResourceSnapshot[] {
    this.enforce();
    const bounded = Math.min(Math.max(1, limit), RESOURCE_HISTORY_PAGE_MAX);
    return this.entries.slice(-bounded).map((entry) => entry.snapshot);
  }

  /**
   * Snapshot retention only. Spawn records are bounded on their own, by the
   * ownership registry, and the service joins the two into the reply.
   */
  retention(): Omit<ResourceRetention, "ownershipRecords" | "maxOwnershipRecords"> {
    this.enforce();
    return {
      maxAgeMs: this.limits.maxAgeMs,
      maxSnapshots: this.limits.maxSnapshots,
      maxProcessRows: this.limits.maxProcessRows,
      maxBytes: this.limits.maxBytes,
      snapshots: this.entries.length,
      processRows: this.rows,
      bytes: this.bytes,
      ...(this.lastEvictedBy ? { lastEvictedBy: this.lastEvictedBy } : {}),
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.rows = 0;
    this.bytes = 0;
  }

  /** Each bound is checked on its own, oldest first, and names itself. */
  private enforce(): void {
    const cutoff = this.now() - this.limits.maxAgeMs;
    while (this.entries.length > 0 && this.entries[0]!.atMs <= cutoff) this.drop("age");
    while (this.entries.length > this.limits.maxSnapshots) this.drop("snapshots");
    while (this.entries.length > 1 && this.rows > this.limits.maxProcessRows) this.drop("rows");
    while (this.entries.length > 1 && this.bytes > this.limits.maxBytes) this.drop("bytes");
  }

  private drop(reason: NonNullable<ResourceRetention["lastEvictedBy"]>): void {
    const entry = this.entries.shift();
    if (!entry) return;
    this.rows -= entry.rows;
    this.bytes -= entry.bytes;
    this.lastEvictedBy = reason;
  }
}
