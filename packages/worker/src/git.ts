/**
 * Git state for the project line under the composer (M2-T6, D-20 §7).
 *
 * One `GitService` per worker (one per project directory). It shells out to
 * `git` in `cwd`, never touches the index or the refs, and answers from a short
 * cache so a UI that asks after every turn does not fork a process per keypress.
 *
 * "Since the session started" is a **baseline** captured when a session opens:
 * `git stash create` writes a commit object for the tracked working tree
 * without moving anything (falling back to HEAD when the tree is clean), and
 * the untracked file list is remembered alongside it. Later, `added`/`removed`
 * are `git diff --numstat <baseline>` against the live working tree plus the
 * line count of files that were not there at baseline time. A file that was
 * already untracked when the session opened does not count; only what the
 * session did does.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps `git status` from refreshing the index on disk,
 * so nothing here writes into a repository the agent may be editing.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectGitStatus } from "@lasercode/protocol";

/** `git diff --numstat` line: `added<TAB>removed<TAB>path`; binaries are `-<TAB>-<TAB>path`. */
export function parseNumstat(text: string): { added: number; removed: number; files: number } {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [a, r] = line.split("\t");
    if (a === undefined || r === undefined) continue;
    files++;
    if (a === "-" || r === "-") continue; // binary: no line counts
    const na = Number.parseInt(a, 10);
    const nr = Number.parseInt(r, 10);
    if (Number.isFinite(na)) added += na;
    if (Number.isFinite(nr)) removed += nr;
  }
  return { added, removed, files };
}

/** `git rev-list --left-right --count <base>...HEAD` prints `behind<TAB>ahead`. */
export function parseAheadBehind(text: string): { ahead: number; behind: number } {
  const [left, right] = text.trim().split(/\s+/);
  const behind = Number.parseInt(left ?? "", 10);
  const ahead = Number.parseInt(right ?? "", 10);
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

/**
 * `git status --porcelain=v1 -z`: NUL-separated `XY path` entries; renames and
 * copies carry a second NUL-separated path (the original) that must be skipped.
 */
export function parsePorcelain(text: string): { dirty: boolean; untracked: string[] } {
  const chunks = text.split("\0");
  const untracked: string[] = [];
  let dirty = false;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    dirty = true;
    const code = chunk.slice(0, 2);
    const path = chunk.slice(3);
    if (code === "??") untracked.push(path);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i++; // the "from" path
  }
  return { dirty, untracked };
}

/** Lines in a text file, the way `wc -l` counts them plus an unterminated last line. */
export function countLines(buffer: Uint8Array): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) lines++;
  if (buffer[buffer.length - 1] !== 0x0a) lines++;
  return lines;
}

/** A NUL byte in the first 8 KiB is git's own heuristic for "binary". */
function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, 8192);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}

export interface GitRunner {
  /** Resolve with stdout; reject on a non-zero exit or a missing `git`. */
  (args: readonly string[]): Promise<string>;
}

export interface GitServiceOptions {
  cwd: string;
  /** Test seam; defaults to `execFile("git", …)` in `cwd`. */
  run?: GitRunner;
  /** How long a computed status stays fresh. */
  ttlMs?: number;
  /** Stop counting new files past this many; a generated `node_modules` is not the session's work. */
  maxNewFiles?: number;
  /** Skip a new file bigger than this when counting its lines. */
  maxNewFileBytes?: number;
  /** Aggregate read budget per cache miss, including binary headers/sentinels. */
  maxNewFilesTotalBytes?: number;
}

interface Baseline {
  /** Tree-ish to diff against; the empty tree when the repository has no commits. */
  snapshot: string;
  untracked: ReadonlySet<string>;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NO_BASELINE = "\u0000";

function defaultRunner(cwd: string): GitRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          timeout: 8000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(typeof stdout === "string" ? stdout : String(stdout));
        },
      );
    });
}

const NOT_A_REPO: ProjectGitStatus = {
  isRepo: false,
  branch: "",
  ahead: 0,
  behind: 0,
  added: 0,
  removed: 0,
  dirty: false,
};

export class GitService {
  private readonly run: GitRunner;
  private readonly ttlMs: number;
  private readonly maxNewFiles: number;
  private readonly maxNewFileBytes: number;
  private readonly baselines = new Map<string, Baseline>();
  private readonly baselining = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, { at: number; value: ProjectGitStatus }>();
  private readonly inFlight = new Map<string, Promise<ProjectGitStatus>>();
  /** The first session's baseline stands in when a caller names none. */
  private firstKey: string | undefined;

  constructor(private readonly options: GitServiceOptions) {
    this.run = options.run ?? defaultRunner(options.cwd);
    this.ttlMs = options.ttlMs ?? 1500;
    this.maxNewFiles = options.maxNewFiles ?? 500;
    this.maxNewFileBytes = options.maxNewFileBytes ?? 1024 * 1024;
  }

  /** Remember the working tree as it is now, under `key` (a session path). Idempotent. */
  baseline(key: string): Promise<void> {
    if (this.baselines.has(key)) return Promise.resolve();
    const running = this.baselining.get(key);
    if (running) return running;
    const work = (async () => {
      try {
        const inside = (await this.run(["rev-parse", "--is-inside-work-tree"])).trim();
        if (inside !== "true") return;
        const snapshot =
          (await this.run(["stash", "create"]).catch(() => "")).trim() ||
          (await this.run(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")).trim() ||
          EMPTY_TREE;
        const { untracked } = parsePorcelain(await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
        this.baselines.set(key, { snapshot, untracked: new Set(untracked) });
        this.firstKey ??= key;
      } catch {
        // Not a repository, or git is missing: `status()` reports `isRepo: false`.
      } finally {
        this.baselining.delete(key);
      }
    })();
    this.baselining.set(key, work);
    return work;
  }

  /** Drop a session's baseline (the session closed). */
  forget(key: string): void {
    this.baselines.delete(key);
    this.cache.delete(key);
    if (this.firstKey === key) this.firstKey = this.baselines.keys().next().value;
  }

  /** Current state, counted from `key`'s baseline (or the first one captured). Cached for `ttlMs`. */
  status(key?: string): Promise<ProjectGitStatus> {
    const resolved = key !== undefined && this.baselines.has(key) ? key : (this.firstKey ?? NO_BASELINE);
    const cached = this.cache.get(resolved);
    if (cached && Date.now() - cached.at < this.ttlMs) return Promise.resolve(cached.value);
    const running = this.inFlight.get(resolved);
    if (running) return running;
    const work = this.compute(this.baselines.get(resolved))
      .then((value) => {
        this.cache.set(resolved, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.inFlight.delete(resolved));
    this.inFlight.set(resolved, work);
    return work;
  }

  private async compute(baseline: Baseline | undefined): Promise<ProjectGitStatus> {
    const inside = await this.run(["rev-parse", "--is-inside-work-tree"]).catch(() => "");
    if (inside.trim() !== "true") return NOT_A_REPO;

    const [branchName, porcelain] = await Promise.all([
      this.run(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
      this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => ""),
    ]);
    const branchResult = branchName.trim()
      ? Promise.resolve(branchName.trim())
      : this.run(["rev-parse", "--short", "HEAD"]).catch(() => "").then((name) => name.trim() || "(no commits)");
    const { dirty, untracked } = parsePorcelain(porcelain);
    // These reads share no mutable state. Baseline capture remains ordered.
    const changes = baseline ? Promise.all([
      this.run(["diff", "--numstat", baseline.snapshot]).catch(() => ""),
      this.linesOfNewFiles(untracked.filter((p) => !baseline.untracked.has(p))),
    ]) : Promise.resolve(["", 0] as const);

    // Upstream first; a branch that was never pushed compares against the
    // remote's default branch, which is what a pull request would target.
    let upstream = (await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
    if (!upstream) {
      upstream = (await this.run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
    }
    let ahead = 0;
    let behind = 0;
    let remoteUrl = "";
    if (upstream) {
      const remote = upstream.split("/")[0] ?? "";
      const [counts, url] = await Promise.all([
        this.run(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).catch(() => ""),
        remote ? this.run(["remote", "get-url", remote]).catch(() => "") : Promise.resolve(""),
      ]);
      ({ ahead, behind } = parseAheadBehind(counts));
      remoteUrl = url.trim();
    }

    const [[numstat, newLines], branch] = await Promise.all([changes, branchResult]);
    const { added: trackedAdded, removed } = parseNumstat(numstat);
    const added = trackedAdded + newLines;

    return {
      isRepo: true,
      branch,
      ahead,
      behind,
      added,
      removed,
      dirty,
      ...(upstream ? { upstream } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
    };
  }

  /** Lines in files the session created. Bounded: many or huge new files are not "work", they are output. */
  private async linesOfNewFiles(paths: readonly string[]): Promise<number> {
    let total = 0;
    let remaining = this.options.maxNewFilesTotalBytes ?? 16 * 1024 * 1024;
    const root = await realpath(this.options.cwd).catch(() => undefined);
    if (!root) return 0;
    // One handle/read at a time bounds memory and preserves deterministic
    // admission when the aggregate budget is exhausted.
    const buffer = Buffer.alloc(8192);
    for (const path of paths.slice(0, this.maxNewFiles)) {
      if (remaining <= 0) break;
      try {
        const target = resolve(root, path);
        const rel = relative(root, await realpath(target));
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
        const before = await lstat(target);
        if (!before.isFile() || before.size > this.maxNewFileBytes) continue;
        const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > this.maxNewFileBytes) continue;
          let bytes = 0;
          let lines = 0;
          let last = 0x0a;
          let complete = false;
          while (remaining > 0 && bytes <= this.maxNewFileBytes) {
            const length = Math.min(buffer.length, remaining, this.maxNewFileBytes + 1 - bytes);
            const { bytesRead } = await file.read(buffer, 0, length, bytes);
            remaining -= bytesRead;
            if (!bytesRead) { complete = true; break; }
            const chunk = buffer.subarray(0, bytesRead);
            // Check the entire first 8 KiB, even when the OS returns short reads.
            if (bytes < 8192 && looksBinary(chunk.subarray(0, 8192 - bytes))) break;
            bytes += bytesRead;
            for (const byte of chunk) if (byte === 0x0a) lines++;
            last = chunk[bytesRead - 1]!;
          }
          // No partial count when growth or the aggregate budget cut us off.
          if (complete && bytes <= this.maxNewFileBytes) total += lines + (bytes > 0 && last !== 0x0a ? 1 : 0);
        } finally { await file.close(); }
      } catch {
        // Deleted between `status` and here, or unreadable: not a line of work.
      }
    }
    return total;
  }
}
