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
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

export class TaskRegister {
  /** path → id → record, insertion-ordered so pruning drops the oldest. */
  private readonly bySession = new Map<string, Map<string, Held>>();

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
    tasks.set(task.id, { task, logPath: logPath ?? previous?.logPath, serialized });
    this.prune(tasks);
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
    if (file === undefined || !isAbsolute(file)) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        "That task kept no log file, so there is nothing to read. Its last line is on the row.",
      );
    }
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        "That output is gone — the file it was written to has been cleaned up.",
      );
    }
    const start = Math.min(Math.max(0, fromByte), size);
    const length = Math.max(0, Math.min(start + TASK_OUTPUT_MAX_BYTES, size) - start);
    let chunk = "";
    // The offset the chunk really begins at: a text read moves it forward past
    // a character the previous window already carried, so a follower that
    // appends `from + byteLength(chunk)` stays exact and no seam grows a U+FFFD.
    let chunkStart = start;
    if (length > 0) {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const bytes = buffer.subarray(0, bytesRead);
        const aligned = alignUtf8(bytes, start === 0);
        chunkStart = start + aligned.start;
        chunk = bytes.toString("utf8", aligned.start, aligned.end);
      } finally {
        await handle.close();
      }
    }
    return { id, from: chunkStart, bytes: size, chunk, eof: start + length >= size };
  }

  /** Oldest finished tasks first; a running task is never forgotten. */
  private prune(tasks: Map<string, Held>): void {
    if (tasks.size <= MAX_TASKS_PER_SESSION) return;
    for (const [id, held] of tasks) {
      if (tasks.size <= MAX_TASKS_PER_SESSION) return;
      if (held.task.status === "running") continue;
      tasks.delete(id);
    }
  }
}
