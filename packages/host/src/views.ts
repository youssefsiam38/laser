/**
 * ViewCache (M2-T3) — the last N hydrated session transcripts, kept in the
 * host so switching back to a session you looked at a minute ago costs one
 * `stat`, not a worker round trip plus a full JSONL parse.
 *
 * Validity is the session file's own (size, mtime): Pi appends, so any change
 * moves both. That makes the cache correct without a watcher and without
 * trusting our own bookkeeping — a session driven from a terminal invalidates
 * it exactly the same way one driven from laser does.
 */
import { statSync } from "node:fs";

/** What `pi/session/entries` answered: every branch, and which one is live. */
export interface CachedView {
  entries: unknown[];
  /** The entry the session sits on; `undefined` when the answer carried none. */
  leafId?: string | null;
}

interface Cached extends CachedView {
  bytes: number;
  size: number;
  mtimeMs: number;
  /** Insertion/refresh time; the eviction order. */
  at: number;
}

export class ViewCache {
  private readonly cache = new Map<string, Cached>();
  private retainedBytes = 0;

  constructor(
    private readonly limit = 8,
    private readonly now: () => number = Date.now,
    private readonly byteLimit = 32 * 1024 * 1024,
  ) {}

  /** The cached answer for a path, or undefined when absent or stale. */
  get(path: string): CachedView | undefined {
    const hit = this.cache.get(path);
    if (!hit) return undefined;
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(path));
    } catch {
      this.invalidate(path);
      return undefined;
    }
    if (hit.size !== size || hit.mtimeMs !== mtimeMs) {
      this.invalidate(path);
      return undefined;
    }
    // Refresh recency: a Map keeps insertion order, so re-set to move to the end.
    this.cache.delete(path);
    this.cache.set(path, { ...hit, at: this.now() });
    return { entries: hit.entries, ...(hit.leafId !== undefined ? { leafId: hit.leafId } : {}) };
  }

  set(path: string, view: CachedView): void {
    this.invalidate(path);
    // Serialized bytes are an admission metric, not a JS heap estimate.
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(view)); } catch { return; }
    if (bytes > this.byteLimit) return;
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(path));
    } catch {
      // Pi writes the file on the first message; a brand-new session has none
      // yet, and caching an empty transcript against no file would be a lie.
      return;
    }
    this.cache.set(path, { ...view, bytes, size, mtimeMs, at: this.now() });
    this.retainedBytes += bytes;
    while (this.cache.size > this.limit || this.retainedBytes > this.byteLimit) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.invalidate(oldest.value);
    }
  }

  invalidate(path: string): void {
    this.retainedBytes -= this.cache.get(path)?.bytes ?? 0;
    this.cache.delete(path);
  }

  /** Accounted serialized bytes; diagnostics only. */
  get bytes(): number { return this.retainedBytes; }

  clear(): void {
    this.cache.clear();
    this.retainedBytes = 0;
  }

  /** Cached paths, oldest first. Diagnostics only. */
  paths(): string[] {
    return [...this.cache.keys()];
  }
}
