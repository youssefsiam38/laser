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
    return this.entries.slice(start).slice(-limit).map((entry) => entry.snapshot);
  }

  retention(): ResourceRetention {
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
