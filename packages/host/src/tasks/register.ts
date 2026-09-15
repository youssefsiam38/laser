/**
 * TaskRegister — the host's memory of every background task, per session.
 *
 * Why the host keeps them: `tasks/update` notifications are not part of the
 * worker's `seq`-numbered replay buffer, so a client that reloads would
 * otherwise come back to an empty fleet while the commands it was watching are
 * still running. The register answers `tasks/list`, and it is the authority on
 * which bytes a client may read (`tasks/output`): the log file is named by the
 * task, and the task belongs to exactly one session.
 *
 * The log path never leaves this file. It arrives on the extension message,
 * is kept beside the record, and is used to serve ranged reads — a client is
 * told a task's size, never where it lives.
 *
 * Wiring is three calls: `observeExtensionMessage` where extension messages
 * are seen, `list` / `read` in the router, and `sessionClosed` when a worker
 * drops a session.
 */
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ErrorCodes,
  ProtocolError,
  TASK_OUTPUT_MAX_BYTES,
  alignUtf8,
  type BackgroundTask,
  type HostNotifications,
  type PiExtensionMessage,
  type TaskOutputChunk,
} from "@lasercode/protocol";

export interface TaskRegisterDeps {
  notify(method: "tasks/update", params: HostNotifications["tasks/update"]): void;
  /**
   * The private directory a command log must be inside for this host to read
   * it (RP-6). A `logPath` arrives on an extension message: it is a claim
   * about where bytes are, not a permission to read a file. Without a root
   * nothing is read at all.
   */
  logRoot?: string;
}

/**
 * Is this path really inside `root`?
 *
 * Resolved through the filesystem, not compared as strings: a symlink at any
 * directory inside the root leads out of it, and `O_NOFOLLOW` on the open only
 * refuses the *last* component. The parent directory is resolved and checked,
 * the final component is never followed, and a path whose parent cannot be
 * resolved is refused rather than assumed.
 */
export async function isInsideRoot(candidate: string | undefined, root: string | undefined): Promise<boolean> {
  if (candidate === undefined || root === undefined) return false;
  if (!isAbsolute(candidate) || !isAbsolute(root)) return false;
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

interface Held {
  task: BackgroundTask;
  /** Absolute path on this machine; never sent to a client. */
  logPath: string | undefined;
  /** Serialized last broadcast, so an identical re-emit is not re-sent. */
  serialized: string;
}

/** How many finished tasks one session keeps before the oldest is forgotten. */
export const MAX_TASKS_PER_SESSION = 200;

/**
 * How many sessions keep a task map, and how many bytes of records the whole
 * register may hold (RP-6).
 *
 * A record is metadata — a command line, a title, a status — so the bound it
 * needs is count and bytes, not age: a finished command a person can still see
 * in the fleet must not disappear because an hour passed (docs/ux-fleet.md
 * R7). What was unbounded was the number of *sessions*: one map per session
 * ever seen, for the life of the host.
 */
export const MAX_SESSIONS_WITH_TASKS = 200;
export const MAX_REGISTER_BYTES = 8 * 1024 * 1024;

export class TaskRegister {
  /** path → id → record, insertion-ordered so pruning drops the oldest. */
  private readonly bySession = new Map<string, Map<string, Held>>();
  /** Serialized bytes held right now, kept incrementally rather than walked. */
  private bytes = 0;

  constructor(private readonly deps: TaskRegisterDeps) {}

  /**
   * Fold one extension message in. Returns true when it was a task message,
   * so a caller that also logs extension messages can skip these.
   */
  observeExtensionMessage(path: string, message: PiExtensionMessage): boolean {
    if (message.type !== "lasercode/task/update") return false;
    const { logPath, ...rest } = message.task;
    this.upsert(path, { ...rest, sessionPath: path }, logPath);
    return true;
  }

  upsert(path: string, task: BackgroundTask, logPath?: string): void {
    let tasks = this.bySession.get(path);
    if (!tasks) {
      tasks = new Map();
      this.bySession.set(path, tasks);
    }
    const serialized = JSON.stringify(task);
    const previous = tasks.get(task.id);
    // At-least-once delivery is normal; the wire carries changes, not heartbeats.
    if (previous?.serialized === serialized && previous.logPath === (logPath ?? previous.logPath)) return;
    // Exact UTF-8 bytes, not JS string units: a command with a single emoji in
    // it costs more bytes than characters, and a budget that cannot see that
    // is not a byte budget.
    this.bytes += Buffer.byteLength(serialized, "utf8") - (previous ? Buffer.byteLength(previous.serialized, "utf8") : 0);
    tasks.set(task.id, { task, logPath: logPath ?? previous?.logPath, serialized });
    this.prune(tasks);
    this.pruneSessions(path);
    this.deps.notify("tasks/update", { task });
  }

  /** Every task of one session, oldest first; or of every session. */
  list(path?: string): BackgroundTask[] {
    if (path !== undefined) return [...(this.bySession.get(path)?.values() ?? [])].map((held) => held.task);
    const out: BackgroundTask[] = [];
    for (const tasks of this.bySession.values()) for (const held of tasks.values()) out.push(held.task);
    return out;
  }

  get(path: string, id: string): BackgroundTask | undefined {
    return this.bySession.get(path)?.get(id)?.task;
  }

  /**
   * A session left its worker, or a worker died: every task of it stopped with
   * the process that ran it, and the register says so rather than leaving a
   * row spinning forever.
   */
  sessionClosed(path: string, reason = "the session ended"): void {
    const tasks = this.bySession.get(path);
    if (!tasks) return;
    for (const held of tasks.values()) {
      if (held.task.status !== "running") continue;
      this.upsert(path, { ...held.task, status: "stopped", endedAt: new Date().toISOString(), exitCode: null, terminalReason: reason });
    }
  }

  workerLost(paths: readonly string[], reason = "the worker stopped"): void {
    for (const path of paths) this.sessionClosed(path, reason);
  }

  /**
   * A ranged read of one task's output. `path` is the session the read is made
   * from: the relay makes a client an arbitrary remote peer, and the task's own
   * session is the only thing between a task id and a file on disk.
   */
  async read(path: string, id: string, fromByte: number): Promise<TaskOutputChunk> {
    const held = this.bySession.get(path)?.get(id);
    if (!held) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        "That task does not belong to this session, so the host will not read its output.",
      );
    }
    const file = held.logPath;
    if (file === undefined || held.task.logState === "released" || !(await isInsideRoot(file, this.deps.logRoot))) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        "That task kept no log file, so there is nothing to read. Its last line is on the row.",
      );
    }
    // A long command's log is a bounded window, not the whole stream (RP-6):
    // the task says where the window starts, and the segment before the
    // current one — the file the writer rotated away from — is the older half
    // of it. Offsets stay stream offsets, so a follower's byte arithmetic is
    // unchanged; it only ever learns that the head is gone.
    const retainedFrom = held.task.retainedFromByte ?? 0;
    // Both halves of the window are opened once, without following a symlink,
    // and measured through the handle that will be read: a rotation between a
    // `stat` and an `open` would otherwise describe one file and read another.
    const segments: Array<{ file: string; handle: FileHandle; size: number }> = [];
    const openSegment = async (path: string): Promise<{ handle: FileHandle; size: number } | undefined> => {
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = await handle.stat();
        if (!stats.isFile()) {
          await handle.close();
          return undefined;
        }
        return { handle, size: stats.size };
      } catch {
        if (handle) await handle.close().catch(() => {});
        return undefined;
      }
    };
    const older = await openSegment(`${file}.prev`);
    if (older && older.size > 0) segments.push({ file: `${file}.prev`, ...older });
    else if (older) await older.handle.close();
    const current = await openSegment(file);
    if (!current) {
      for (const segment of segments) await segment.handle.close();
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        "That output is gone — the file it was written to has been cleaned up.",
      );
    }
    segments.push({ file, ...current });
    const previous = older && older.size > 0 ? older.size : 0;
    const retainedBytes = segments.reduce((sum, segment) => sum + segment.size, 0);
    const total = Math.max(held.task.outputBytes, retainedFrom + retainedBytes);
    // Below the window: answer from its first byte and say where that is, so a
    // follower appending from `from` stays exact instead of reading a seam.
    const wanted = Math.min(Math.max(fromByte, retainedFrom), retainedFrom + retainedBytes);
    let offset = wanted - retainedFrom;
    let segment = segments[0]!;
    for (const candidate of segments) {
      if (offset < candidate.size || candidate === segments[segments.length - 1]) {
        segment = candidate;
        break;
      }
      offset -= candidate.size;
    }
    const start = Math.min(Math.max(0, offset), segment.size);
    const length = Math.max(0, Math.min(start + TASK_OUTPUT_MAX_BYTES, segment.size) - start);
    let chunk = "";
    // The offset the chunk really begins at: a text read moves it forward past
    // a character the previous window already carried, so a follower that
    // appends `from + byteLength(chunk)` stays exact and no seam grows a U+FFFD.
    let chunkStart = start;
    try {
      if (length > 0) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await segment.handle.read(buffer, 0, length, start);
        const bytes = buffer.subarray(0, bytesRead);
        const aligned = alignUtf8(bytes, start === 0 && segment === segments[0]);
        chunkStart = start + aligned.start;
        chunk = bytes.toString("utf8", aligned.start, aligned.end);
      }
    } finally {
      for (const open of segments) await open.handle.close().catch(() => {});
    }
    const base = segment.file === file ? retainedFrom + (segments.length > 1 ? previous : 0) : retainedFrom;
    const from = base + chunkStart;
    return {
      id,
      from,
      bytes: total,
      chunk,
      eof: from + Buffer.byteLength(chunk, "utf8") >= total,
      ...(retainedFrom > 0 ? { retainedFrom } : {}),
      ...(held.task.outputDigest ? { digest: held.task.outputDigest } : {}),
    };
  }

  /** Oldest finished tasks first; a running task is never forgotten. */
  private prune(tasks: Map<string, Held>): void {
    if (tasks.size <= MAX_TASKS_PER_SESSION) return;
    for (const [id, held] of tasks) {
      if (tasks.size <= MAX_TASKS_PER_SESSION) return;
      if (held.task.status === "running") continue;
      this.bytes -= Buffer.byteLength(held.serialized, "utf8");
      tasks.delete(id);
    }
  }

  /**
   * Bound the register itself: sessions whose commands have all finished go
   * first, oldest touched first, and a session with a command still running is
   * never forgotten. The byte bound is the same rule from the other side — a
   * few very talkative sessions cannot hold the host's memory open.
   */
  private pruneSessions(touched: string): void {
    if (this.bySession.size <= MAX_SESSIONS_WITH_TASKS && this.bytes <= MAX_REGISTER_BYTES) return;
    for (const [path, tasks] of [...this.bySession]) {
      if (this.bySession.size <= MAX_SESSIONS_WITH_TASKS && this.bytes <= MAX_REGISTER_BYTES) return;
      if (path === touched) continue;
      if ([...tasks.values()].some((held) => held.task.status === "running")) continue;
      for (const held of tasks.values()) this.bytes -= Buffer.byteLength(held.serialized, "utf8");
      this.bySession.delete(path);
    }
  }

  /** Records held and the bytes they occupy, for the resource diagnostics (RP-3). */
  retained(): { count: number; bytes: number } {
    let count = 0;
    for (const tasks of this.bySession.values()) count += tasks.size;
    return { count, bytes: this.bytes };
  }
}
