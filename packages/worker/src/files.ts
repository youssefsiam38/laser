/**
 * ProjectFilesService — the list behind the composer's `@` popover.
 *
 * Two ways to answer, in order of how much they know:
 *
 *   `git ls-files --cached --others --exclude-standard`  — the real answer in a
 *       repository: exactly the files git tracks plus the ones it would track,
 *       with `.gitignore` honoured by the tool that owns it.
 *   a bounded directory walk — for a project that is not a repository. It skips
 *       the directories nobody means when they type `@` (`.git`, `node_modules`,
 *       build output) and stops at a ceiling rather than reading a whole disk.
 *
 * Deliberately not Pi's `find` tool: that one downloads `fd` on first use, and
 * a self-contained app does not fetch a binary to fill in a popover.
 *
 * The scan is cached briefly, because a person typing `@src/co` asks once per
 * keystroke and the answer cannot change that fast.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ProjectFile, ProjectFiles } from "@lasercode/protocol";

/** How long one scan is reused. Long enough for a burst of keystrokes. */
const CACHE_MS = 5_000;
/** Never hold more than this many paths in memory for one project. */
const SCAN_CEILING = 50_000;
const DEFAULT_LIMIT = 50;
const GIT_TIMEOUT_MS = 5_000;

/** Directories `@` never means. Skipped whole, so their contents cost nothing. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  ".idea",
  "vendor",
]);

interface Scan {
  files: ProjectFile[];
  source: "git" | "walk";
  at: number;
}

export class ProjectFilesService {
  private scan: Scan | undefined;
  private inFlight: Promise<Scan> | undefined;

  constructor(private readonly options: { cwd: string; now?: () => number }) {}

  async list(params: { query?: string; limit?: number } = {}): Promise<ProjectFiles> {
    const scan = await this.scanned();
    const limit = params.limit ?? DEFAULT_LIMIT;
    const matched = params.query ? rank(scan.files, params.query) : scan.files;
    return {
      cwd: this.options.cwd,
      files: matched.slice(0, limit),
      truncated: matched.length > limit,
      source: scan.source,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async scanned(): Promise<Scan> {
    const cached = this.scan;
    if (cached && this.now() - cached.at < CACHE_MS) return cached;
    // One scan at a time: a fresh popover fires several list() calls at once.
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<Scan> {
    const fromGit = await this.git();
    const scan: Scan = fromGit ?? { files: await this.walk(), source: "walk", at: 0 };
    scan.at = this.now();
    this.scan = scan;
    return scan;
  }

  /** `git ls-files`, or undefined when this is not a repository (or git is absent). */
  private async git(): Promise<Scan | undefined> {
    let cached: string;
    try {
      cached = await run("git", ["ls-files", "-z", "--cached"], this.options.cwd);
    } catch {
      // Not a repository, or no git on this machine. The walk answers instead.
      return undefined;
    }
    // Files git would track but has not been told to yet. A failure here is not
    // fatal: a tracked-only list is still a useful list.
    let others = "";
    try {
      others = await run("git", ["ls-files", "-z", "--others", "--exclude-standard"], this.options.cwd);
    } catch {
      others = "";
    }
    const files: ProjectFile[] = [];
    const seen = new Set<string>();
    const take = (text: string, tracked: boolean): void => {
      for (const path of text.split("\0")) {
        if (!path || seen.has(path) || files.length >= SCAN_CEILING) continue;
        seen.add(path);
        files.push({ path, name: path.slice(path.lastIndexOf("/") + 1), tracked });
      }
    };
    take(cached, true);
    take(others, false);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, source: "git", at: 0 };
  }

  private async walk(): Promise<ProjectFile[]> {
    const files: ProjectFile[] = [];
    const queue: string[] = [this.options.cwd];
    while (queue.length > 0 && files.length < SCAN_CEILING) {
      const dir = queue.shift()!;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // an unreadable directory is not a reason to have no list
      }
      for (const entry of entries) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = relative(this.options.cwd, full).split(sep).join("/");
        files.push({ path: rel, name: entry.name, tracked: false });
        if (files.length >= SCAN_CEILING) break;
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return files;
  }
}

/**
 * Subsequence match with a score, the way every file picker behaves: `srcidx`
 * finds `src/runtime/index.ts`. A run of adjacent characters and a match that
 * starts in the file's own name both score better than one scattered through
 * the directories above it, so the obvious answer is at the top.
 *
 * Exported for the test: this is the one piece here with real logic in it.
 */
export function scoreMatch(path: string, query: string): number | undefined {
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  if (needle === "") return 0;
  const nameStart = haystack.lastIndexOf("/") + 1;
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found === -1) return undefined;
    if (found === previous + 1) score += 8; // adjacent characters: a real prefix
    if (found >= nameStart) score += 4; // in the file's own name, not a parent
    if (found === nameStart || found === 0) score += 6; // at the start of a segment
    previous = found;
    at = found + 1;
  }
  // A short path that matched is a better answer than a long one that also did.
  return score - Math.floor(haystack.length / 16);
}

function rank(files: readonly ProjectFile[], query: string): ProjectFile[] {
  const scored: Array<{ file: ProjectFile; score: number }> = [];
  for (const file of files) {
    const score = scoreMatch(file.path, query);
    if (score !== undefined) scored.push({ file, score });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.file.path < b.file.path ? -1 : 1));
  return scored.map((entry) => entry.file);
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        // Never let a repository's own hooks or an index refresh happen because
        // a popover opened: this is a read, and it stays one.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
