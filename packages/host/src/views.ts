/**
 * ViewCache (M2-T3) — the last N hydrated session transcripts, kept in the
 * host so switching back to a session you looked at a minute ago costs one
 * `stat`, not a worker round trip plus a full JSONL parse.
 *
 * Validity is the session file's own (size, mtime): Pi appends, so any change
 * moves both. That makes the cache correct without a watcher and without
 * trusting our own bookkeeping — a session driven from a terminal invalidates
 * it exactly the same way one driven from piorbit does.
 */
import { statSync } from "node:fs";

interface Cached {
  entries: unknown[];
  size: number;
  mtimeMs: number;
  /** Insertion/refresh time; the eviction order. */
  at: number;
}

export class ViewCache {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly limit = 8,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cached entries for a path, or undefined when absent or stale. */
  get(path: string): unknown[] | undefined {
    const hit = this.cache.get(path);
    if (!hit) return undefined;
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(path));
    } catch {
      this.cache.delete(path);
      return undefined;
    }
    if (hit.size !== size || hit.mtimeMs !== mtimeMs) {
      this.cache.delete(path);
      return undefined;
    }
    // Refresh recency: a Map keeps insertion order, so re-set to move to the end.
    this.cache.delete(path);
    this.cache.set(path, { ...hit, at: this.now() });
    return hit.entries;
  }

  set(path: string, entries: unknown[]): void {
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(path));
    } catch {
      // Pi writes the file on the first message; a brand-new session has none
      // yet, and caching an empty transcript against no file would be a lie.
      return;
    }
    this.cache.delete(path);
    this.cache.set(path, { entries, size, mtimeMs, at: this.now() });
    while (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  clear(): void {
    this.cache.clear();
  }

  /** Cached paths, oldest first. Diagnostics only. */
  paths(): string[] {
    return [...this.cache.keys()];
  }
}
