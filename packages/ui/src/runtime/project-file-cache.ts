import type { ProjectFileContent } from "@lasercode/protocol";

const MAX_ENTRIES = 8;
const MAX_RETAINED_CHARS = 16 * 1024 * 1024;
const MAX_AGE_MS = 30_000;
/** Thread-owned LRU: deduplicates reads, bounds retained bytes, never retains failures. */
export class ProjectFileCache {
  private entries = new Map<string, { promise: Promise<ProjectFileContent>; chars: number; at: number }>();
  constructor(private request: (cwd: string, path: string) => Promise<ProjectFileContent>) {}
  read = (cwd: string, path: string): Promise<ProjectFileContent> => {
    const key = JSON.stringify([cwd, path]);
    const found = this.entries.get(key);
    if (found && Date.now() - found.at < MAX_AGE_MS) { this.entries.delete(key); this.entries.set(key, found); return found.promise; }
    const promise = this.request(cwd, path).then(file => {
      const entry = this.entries.get(key);
      if (entry?.promise === promise) { entry.chars = file.content.length; entry.at = Date.now(); }
      this.trim();
      return file;
    }, error => { if (this.entries.get(key)?.promise === promise) this.entries.delete(key); throw error; });
    this.entries.set(key, { promise, chars: 0, at: Infinity });
    this.trim();
    return promise;
  };
  private trim() {
    let chars = [...this.entries.values()].reduce((sum, entry) => sum + entry.chars, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && chars <= MAX_RETAINED_CHARS) break;
      chars -= entry.chars; this.entries.delete(key);
    }
  }
}
