import type { ProjectFileContent } from "@lasercode/protocol";

import { byteLength } from "./view-measure.js";

const MAX_ENTRIES = 8;
const MAX_RETAINED_CHARS = 16 * 1024 * 1024;
const MAX_AGE_MS = 30_000;
/** Thread-owned LRU: deduplicates reads, bounds retained bytes, never retains failures. */
export class ProjectFileCache {
  private entries = new Map<string, { promise: Promise<ProjectFileContent>; chars: number; bytes: number; settled: boolean; at: number }>();
  constructor(private request: (cwd: string, path: string) => Promise<ProjectFileContent>) {}
  read = (cwd: string, path: string): Promise<ProjectFileContent> => {
    const key = JSON.stringify([cwd, path]);
    const found = this.entries.get(key);
    if (found && Date.now() - found.at < MAX_AGE_MS) { this.entries.delete(key); this.entries.set(key, found); return found.promise; }
    const promise = this.request(cwd, path).then(file => {
      const entry = this.entries.get(key);
      // Exact UTF-8 beside the character count the bound uses, so a release can
      // say what it released in the same unit every other renderer counter does.
      if (entry?.promise === promise) { entry.chars = file.content.length; entry.bytes = byteLength(file.content); entry.settled = true; entry.at = Date.now(); }
      this.trim();
      return file;
    }, error => { if (this.entries.get(key)?.promise === promise) this.entries.delete(key); throw error; });
    this.entries.set(key, { promise, chars: 0, bytes: 0, settled: false, at: Infinity });
    this.trim();
    return promise;
  };
  /**
   * Give back everything this cache is holding (RP-8 step 1).
   *
   * Only entries that actually hold content: a read still in flight holds no
   * bytes, and dropping it would cost a duplicate request without releasing
   * anything. Nothing on screen reads from here — a file this window is showing
   * was already handed to its viewer — so this is memory, not state.
   */
  clear(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const [key, entry] of [...this.entries]) {
      if (!entry.settled) continue;
      count += 1;
      bytes += entry.bytes;
      this.entries.delete(key);
    }
    return { count, bytes };
  }
  private trim() {
    let chars = [...this.entries.values()].reduce((sum, entry) => sum + entry.chars, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && chars <= MAX_RETAINED_CHARS) break;
      chars -= entry.chars; this.entries.delete(key);
    }
  }
}
