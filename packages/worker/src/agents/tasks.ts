/**
 * TaskIndex — the worker's memory of every background command its sessions
 * published, so the harness can put commands beside agents in one tree
 * (`inspect_fleet`, D-163) and read a command of another session in the
 * caller's tree (`task_output` on a child's command).
 *
 * Fed from the `lasercode/task/update` messages the worker already forwards
 * to the host: the same record the host's register keeps, held here too
 * because the whole tree under a session lives in one worker (AGENTS.md
 * invariant 5, D-140) and the companion's modules never import each other
 * (§6a) — the `background-work` module of one session cannot see another's
 * tasks, but the worker sees them all go past.
 *
 * `logPath` stays in this process. It is how a tail is read; it is never
 * handed to the model or a client.
 */
import { constants } from "node:fs";
import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  TASK_OUTPUT_MAX_BYTES,
  alignUtf8,
  type BackgroundTask,
  type BackgroundTaskRetention,
  type PiExtensionMessage,
  type ResourceStoreValue,
} from "@lasercode/protocol";

/** A task as the worker holds it: the wire record plus where its bytes are. */
export interface IndexedTask extends BackgroundTask {
  logPath?: string;
}

/** How many finished tasks one session keeps before the oldest is forgotten (the host keeps the same). */
export const MAX_INDEXED_TASKS_PER_SESSION = 200;

/**
 * How many closed sessions keep their commands. A worker lives as long as its
 * project is open and every session it ever served left a map here; the ones
 * still open are never counted, so what is bounded is only history nobody is
 * looking at.
 */
export const MAX_CLOSED_SESSIONS = 50;

/**
 * Bytes every command log in this worker may occupy together (RP-6).
 *
 * The worker is the only party that sees all of its sessions, so the budget
 * lives here — but it never deletes a byte itself: each session's own runtime
 * wrote its files and is the only thing allowed to remove them, so this is
 * divided into per-session shares and handed to the owners, who release their
 * own oldest bytes. A running command is never paused or stopped for it.
 */
export const MAX_WORKER_LOG_BYTES = 512 * 1024 * 1024;

/** The smallest share a session may be given: one segment for its newest command. */
export const MIN_SESSION_LOG_BYTES = 8 * 1024 * 1024;

export class TaskIndex {
  /** path → id → task, insertion-ordered so a session's commands read oldest first. */
  private readonly bySession = new Map<string, Map<string, IndexedTask>>();
  /** Closed sessions, oldest first: what may be forgotten, and in what order. */
  private readonly closed: string[] = [];
  /** What each live session's commands are holding, as that session last said. */
  private readonly retention = new Map<string, BackgroundTaskRetention>();

  /** Fold one extension message in; true when it was a task update. */
  observe(path: string, message: PiExtensionMessage): boolean {
    if (message.type === "lasercode/task/retention") {
      this.retention.set(path, message.retention);
      return true;
    }
    if (message.type !== "lasercode/task/update") return false;
    const { logPath, ...rest } = message.task;
    let tasks = this.bySession.get(path);
    if (!tasks) {
      tasks = new Map();
      this.bySession.set(path, tasks);
    }
    this.reopened(path);
    const previous = tasks.get(rest.id);
    const kept = logPath ?? previous?.logPath;
    tasks.set(rest.id, { ...rest, sessionPath: path, ...(kept !== undefined ? { logPath: kept } : {}) });
    this.prune(tasks);
    return true;
  }

  /**
   * A fork moved the session's file: its commands are still running, in this
   * process, and belong to the session that now lives at `newPath`.
   */
  rekeySession(oldPath: string, newPath: string): void {
    const tasks = this.bySession.get(oldPath);
    if (!tasks || oldPath === newPath) return;
    this.bySession.delete(oldPath);
    const movedRetention = this.retention.get(oldPath);
    if (movedRetention) {
      this.retention.delete(oldPath);
      this.retention.set(newPath, movedRetention);
    }
    const moved = new Map<string, IndexedTask>();
    for (const [id, task] of tasks) moved.set(id, { ...task, sessionPath: newPath });
    this.bySession.set(newPath, moved);
    const at = this.closed.indexOf(oldPath);
    if (at >= 0) this.closed[at] = newPath;
  }

  /** Every command one session started, oldest first. */
  tasksOf(path: string): IndexedTask[] {
    return [...(this.bySession.get(path)?.values() ?? [])];
  }

  /**
   * The session closed: whatever was still running stopped with the process
   * that ran it. The module says so itself on an orderly shutdown; this is
   * for the session that went without one, so no row spins for ever.
   */
  /**
   * What this worker's commands are retaining, for the host's diagnostics
   * (RP-3). Counts and bytes only: a task record is metadata, a tail is
   * memory, and a log is disk — they are reported as what they are.
   */
  retainedStores(): { taskRegistry: ResourceStoreValue } {
    let count = 0;
    for (const tasks of this.bySession.values()) count += tasks.size;
    let bytes = 0;
    for (const [path, retention] of this.retention) {
      if (!this.bySession.has(path)) continue;
      bytes += retention.liveTailBytes + retention.excerptBytes;
    }
    return { taskRegistry: { count, bytes } };
  }

  /** Bytes this worker's command logs occupy, as its sessions last reported. */
  logBytes(): number {
    let bytes = 0;
    for (const [path, retention] of this.retention) {
      if (this.bySession.has(path)) bytes += retention.logBytes;
    }
    return bytes;
  }

  /**
   * The per-session shares to hand out when this worker's logs are over their
   * budget, largest holder first. Empty while the total is inside the budget:
   * a session that is not costing anything is never told to release.
   */
  logBudgets(max = MAX_WORKER_LOG_BYTES): Array<{ path: string; bytes: number }> {
    const live = [...this.retention.entries()].filter(([path]) => this.bySession.has(path));
    const total = live.reduce((sum, [, retention]) => sum + retention.logBytes, 0);
    if (total <= max || live.length === 0) return [];
    const share = Math.max(MIN_SESSION_LOG_BYTES, Math.floor(max / live.length));
    return live
      .filter(([, retention]) => retention.logBytes > share)
      .sort((left, right) => right[1].logBytes - left[1].logBytes)
      .map(([path]) => ({ path, bytes: share }));
  }

  sessionClosed(path: string, reason = "the session ended"): void {
    this.retention.delete(path);
    const tasks = this.bySession.get(path);
    if (!tasks) return;
    for (const [id, task] of tasks) {
      if (task.status !== "running") continue;
      tasks.set(id, { ...task, status: "stopped", endedAt: new Date().toISOString(), exitCode: null, terminalReason: reason });
    }
    this.reopened(path);
    this.closed.push(path);
    while (this.closed.length > MAX_CLOSED_SESSIONS) {
      const oldest = this.closed.shift();
      if (oldest !== undefined) this.bySession.delete(oldest);
    }
  }

  /** This session is live again (or never closed): it is not history to forget. */
  private reopened(path: string): void {
    const at = this.closed.indexOf(path);
    if (at >= 0) this.closed.splice(at, 1);
  }

  private prune(tasks: Map<string, IndexedTask>): void {
    if (tasks.size <= MAX_INDEXED_TASKS_PER_SESSION) return;
    for (const [id, task] of tasks) {
      if (tasks.size <= MAX_INDEXED_TASKS_PER_SESSION) return;
      if (task.status === "running") continue;
      tasks.delete(id);
    }
  }
}

/**
 * Is this path one of ours, inside the private root we were given?
 *
 * No root means nothing may be read: a build that forgot to pass one reads
 * nothing rather than reading whatever a message names.
 */
export async function isInsideRoot(candidate: string | undefined, root: string | undefined): Promise<boolean> {
  if (candidate === undefined || root === undefined) return false;
  if (!isAbsolute(candidate) || !isAbsolute(root)) return false;
  // Lexical containment is not containment: a symlink at any directory inside
  // the root leads out of it, and `O_NOFOLLOW` only refuses the last
  // component. Both sides are resolved through the filesystem first, and a
  // path whose parent cannot be resolved is refused rather than guessed at.
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = await realpath(resolve(root));
    realParent = await realpath(dirname(resolve(candidate)));
  } catch {
    return false;
  }
  const within = relative(realRoot, realParent);
  if (within !== "" && (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))) return false;
  const name = relative(dirname(resolve(candidate)), resolve(candidate));
  return name !== "" && name !== "." && name !== "..";
}

/**
 * The last `lines` lines of a task's log, read from its tail — at most
 * `TASK_OUTPUT_MAX_BYTES`, the same bound the host's `tasks/output` keeps
 * (R9). `undefined` when there is no file to read: the caller says so rather
 * than showing an empty pane.
 */
export async function readLogTail(logPath: string | undefined, lines: number, root?: string): Promise<string | undefined> {
  // A log path arrives from an extension message. It is only ever read when it
  // is inside the private root this process owns, and it is opened without
  // following a symlink: a path is a claim, not a permission (RP-6).
  if (!(await isInsideRoot(logPath, root))) return undefined;
  const directory = dirname(logPath!);
  const name = basename(logPath!);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return undefined;
  }
  // The window is immutable segments named for the stream byte they start at,
  // newest last. Reading the newest backwards gives the tail whatever a
  // rotation did in the meantime.
  const segments = entries
    .map((entry) => ({ entry, from: segmentOffset(name, entry) }))
    .filter((candidate): candidate is { entry: string; from: number } => candidate.from !== undefined)
    .sort((left, right) => right.from - left.from);
  if (segments.length === 0) return undefined;
  const parts: Buffer[] = [];
  let want = TASK_OUTPUT_MAX_BYTES;
  let read = false;
  for (const segment of segments) {
    if (want <= 0) break;
    const bytes = await readEnd(join(directory, segment.entry), want);
    if (bytes === undefined) continue;
    read = true;
    if (bytes.length === 0) continue;
    parts.unshift(bytes);
    want -= bytes.length;
  }
  if (!read) return undefined;
  const whole = Buffer.concat(parts);
  const aligned = alignUtf8(whole, want > 0);
  const text = whole.toString("utf8", aligned.start, aligned.end);
  const all = text.split("\n");
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(Math.max(0, all.length - Math.max(1, lines))).join("\n");
}

/** The last `maxBytes` of one segment, or `undefined` when it cannot be read. */
async function readEnd(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    if (length === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The stream offset a segment file's name declares, or `undefined` (RP-6). */
export function segmentOffset(id: string, name: string): number | undefined {
  if (!name.startsWith(`${id}.`) || !name.endsWith(".log")) return undefined;
  const middle = name.slice(id.length + 1, -".log".length);
  if (!/^\d+$/.test(middle)) return undefined;
  const from = Number(middle);
  return Number.isSafeInteger(from) ? from : undefined;
}
