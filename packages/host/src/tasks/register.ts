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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ErrorCodes,
  ProtocolError,
  TASK_LOG_SEGMENTS_MAX,
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
  /** The writer's own bounded segment offsets; never sent to a client. */
  logSegments: number[] | undefined;
  /** Serialized last broadcast, so an identical re-emit is not re-sent. */
  serialized: string;
}

/** How many finished tasks one session keeps before the oldest is forgotten. */
export const MAX_TASKS_PER_SESSION = 200;

/**
 * How many sessions keep a task map, and how many bytes of records the whole
 * register may hold (RP-6).
 *
 * Read them as bounds on **terminal records**. A record is metadata — a
 * command line, a title, a status — so the bound it needs is count and bytes,
 * not age: a finished command a person can still see in the fleet must not
 * disappear because an hour passed (docs/ux-fleet.md R7). What was unbounded
 * was the number of *sessions*: one map per session ever seen, for the life of
 * the host.
 *
 * A row for a command that is still **running** is exempt from all of them and
 * is never dropped: the fleet would be showing work that the register had
 * forgotten. So these are ceilings on what can be forgotten, not a promise
 * that the register is always under them — a host with more live commands than
 * the bound says so out loud instead (`retained().overflow`).
 */
export const MAX_SESSIONS_WITH_TASKS = 200;
export const MAX_REGISTER_BYTES = 8 * 1024 * 1024;

/** Two bounded lists of offsets, compared without allocating. */
function sameSegments(left: number[] | undefined, right: number[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

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
    // Both file-bearing fields stop here: a client is told a task's size, never
    // where its bytes are or which files hold them.
    const { logPath, logSegments, ...rest } = message.task;
    this.upsert(path, { ...rest, sessionPath: path }, logPath, logSegments);
    return true;
  }

  upsert(path: string, task: BackgroundTask, logPath?: string, logSegments?: number[]): void {
    let tasks = this.bySession.get(path);
    if (!tasks) {
      tasks = new Map();
      this.bySession.set(path, tasks);
    }
    const serialized = JSON.stringify(task);
    const previous = tasks.get(task.id);
    // At-least-once delivery is normal; the wire carries changes, not heartbeats.
    const segments = logSegments ?? previous?.logSegments;
    if (previous?.serialized === serialized && previous.logPath === (logPath ?? previous.logPath) && sameSegments(previous.logSegments, segments)) return;
    // Exact UTF-8 bytes, not JS string units: a command with a single emoji in
    // it costs more bytes than characters, and a budget that cannot see that
    // is not a byte budget.
    this.bytes += Buffer.byteLength(serialized, "utf8") - (previous ? Buffer.byteLength(previous.serialized, "utf8") : 0);
    tasks.set(task.id, { task, logPath: logPath ?? previous?.logPath, logSegments: segments, serialized });
    this.prune(tasks);
    this.pruneSessions(path);
    this.deps.notify("tasks/update", { task });
  }

  /**
   * A fork moved a session's file: its commands move with it (RP-4).
   *
   * The register is keyed by path, and a fork changes a session's path without
   * changing anything else about it — same worker, same runtime, same commands.
   * Called from the one place that already knows a move really happened and is
   * allowed to say so: the router's canonical state change, inside the same
   * route lease that wrote the request and moved the pool's row. Nothing infers
   * a move from a display name, from the current project, or from an arbitrary
   * task update.
   *
   * The old bucket is removed, not copied: a row left behind under a path no
   * runtime serves is a ghost the fleet can never lose, and a later
   * `list(oldPath)` would hand a reconnecting client a *running* row for a
   * command that has since ended somewhere else.
   *
   * The destination may already hold a row for the same command. The worker
   * re-keys its own structures before it answers the fork, so anything
   * published under the new path is newer than everything under the old one —
   * that row wins, and only the private output metadata it happens to lack is
   * carried over. A terminal row is never replaced by a running one, whichever
   * side it is on.
   */
  rekeySession(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const moving = this.bySession.get(oldPath);
    if (!moving) return;
    this.bySession.delete(oldPath);
    let destination = this.bySession.get(newPath);
    if (!destination) {
      destination = new Map();
      this.bySession.set(newPath, destination);
    }
    const moved: BackgroundTask[] = [];
    for (const [id, held] of moving) {
      const existing = destination.get(id);
      // Private file fields survive the move whichever record wins: they are
      // how a ranged read finds bytes, and the newer row may have arrived
      // without repeating them.
      const logPath = existing?.logPath ?? held.logPath;
      const logSegments = existing?.logSegments ?? held.logSegments;
      if (existing) {
        this.bytes -= Buffer.byteLength(held.serialized, "utf8");
        // The newer row is the destination's, except when it would undo an
        // ending: a command that has already finished never goes back to
        // running because its session's file moved.
        const keepMoved = existing.task.status === "running" && held.task.status !== "running";
        const winner = keepMoved ? { ...held } : existing;
        if (keepMoved) {
          const task = { ...held.task, sessionPath: newPath };
          const serialized = JSON.stringify(task);
          this.bytes += Buffer.byteLength(serialized, "utf8") - Buffer.byteLength(existing.serialized, "utf8");
          destination.set(id, { task, logPath, logSegments, serialized });
          moved.push(task);
          continue;
        }
        destination.set(id, { ...winner, logPath, logSegments });
        continue;
      }
      const task = { ...held.task, sessionPath: newPath };
      const serialized = JSON.stringify(task);
      this.bytes += Buffer.byteLength(serialized, "utf8") - Buffer.byteLength(held.serialized, "utf8");
      destination.set(id, { task, logPath, logSegments, serialized });
      moved.push(task);
    }
    if (destination.size === 0) this.bySession.delete(newPath);
    // The public row, and only ever the public row: a client is told where a
    // command hangs, never where its bytes are.
    for (const task of moved) this.deps.notify("tasks/update", { task });
    if (this.bySession.has(newPath)) {
      this.prune(destination);
      this.pruneSessions(newPath);
    }
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
    const base = held.logPath;
    if (base === undefined || held.task.logState === "released" || !(await isInsideRoot(base, this.deps.logRoot))) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        "That task kept no log file, so there is nothing to read. Its last line is on the row.",
      );
    }
    // A long command's log is a bounded window of **immutable** segments, and
    // the writer says which ones exist: at most two offsets, carried beside the
    // path (RP-6). Listing the directory instead would be unbounded in a busy
    // session and would trust names this host did not write. A descriptor a
    // rotation has made stale is safe, because a segment file never changes
    // meaning: it names the bytes it always named, or it is gone.
    const directory = dirname(base);
    const name = basename(base);
    const offsets = [...new Set(held.logSegments ?? [])]
      .filter((offset) => Number.isSafeInteger(offset) && offset >= 0)
      .sort((left, right) => left - right)
      .slice(-TASK_LOG_SEGMENTS_MAX);
    const segments = offsets.map((from) => ({ file: join(directory, `${name}.${from}.log`), from }));
    if (segments.length === 0) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        "That output is gone — the file it was written to has been cleaned up.",
      );
    }

    // Opened once, measured through the handle that will be read: a rotation
    // between a `stat` and an `open` cannot describe one file and read another.
    const open_ = async (file: string): Promise<{ handle: FileHandle; size: number } | undefined> => {
      let handle: FileHandle | undefined;
      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    const opened: Array<{ from: number; size: number; handle: FileHandle }> = [];
    try {
      for (const segment of segments) {
        const file = await open_(segment.file);
        // A segment a rotation removed between the listing and the open is
        // simply not part of the window any more.
        if (file) opened.push({ from: segment.from, size: file.size, handle: file.handle });
      }
      if (opened.length === 0) {
        throw new ProtocolError(
          ErrorCodes.InvalidParams,
          "That output is gone — the file it was written to has been cleaned up.",
        );
      }
      const retainedFrom = opened[0]!.from;
      const end = opened[opened.length - 1]!;
      const total = Math.max(held.task.outputBytes, end.from + end.size);
      const wanted = Math.min(Math.max(fromByte, retainedFrom), end.from + end.size);
      // The segment that contains the wanted offset, or the last one.
      let segment = opened[0]!;
      for (const candidate of opened) {
        if (wanted >= candidate.from && wanted < candidate.from + candidate.size) {
          segment = candidate;
          break;
        }
        if (wanted >= candidate.from) segment = candidate;
      }
      const start = Math.min(Math.max(0, wanted - segment.from), segment.size);
      const length = Math.max(0, Math.min(start + TASK_OUTPUT_MAX_BYTES, segment.size) - start);
      let chunk = "";
      // The offset the chunk really begins at: a text read moves it forward past
      // a character the previous window already carried, so a follower that
      // appends `from + byteLength(chunk)` stays exact and no seam grows a U+FFFD.
      let chunkStart = start;
      if (length > 0) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await segment.handle.read(buffer, 0, length, start);
        const bytes = buffer.subarray(0, bytesRead);
        const aligned = alignUtf8(bytes, segment.from === 0 && start === 0);
        chunkStart = start + aligned.start;
        chunk = bytes.toString("utf8", aligned.start, aligned.end);
      }
      const from = segment.from + chunkStart;
      return {
        id,
        from,
        bytes: total,
        chunk,
        eof: from + Buffer.byteLength(chunk, "utf8") >= total,
        ...(retainedFrom > 0 ? { retainedFrom } : {}),
        ...(held.task.outputDigest ? { digest: held.task.outputDigest } : {}),
      };
    } finally {
      for (const entry of opened) await entry.handle.close().catch(() => {});
    }
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

  /**
   * Records held and the bytes they occupy, for the resource diagnostics
   * (RP-3), with the honesty the rest of that surface keeps: when running
   * commands hold the register above a bound, the overflow is named rather
   * than implied away — exactly as the process inventory does for a machine
   * with more live workers than its record bound.
   */
  retained(): { count: number; bytes: number; overflow?: "running_commands" } {
    let count = 0;
    let running = 0;
    for (const tasks of this.bySession.values()) {
      count += tasks.size;
      for (const held of tasks.values()) if (held.task.status === "running") running += 1;
    }
    const over = this.bySession.size > MAX_SESSIONS_WITH_TASKS || this.bytes > MAX_REGISTER_BYTES;
    return { count, bytes: this.bytes, ...(over && running > 0 ? { overflow: "running_commands" as const } : {}) };
  }
}
