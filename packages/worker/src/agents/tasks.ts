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
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TASK_OUTPUT_MAX_BYTES, alignUtf8, type BackgroundTask, type PiExtensionMessage } from "@lasercode/protocol";

/** A task as the worker holds it: the wire record plus where its bytes are. */
export interface IndexedTask extends BackgroundTask {
  logPath?: string;
}

/** How many finished tasks one session keeps before the oldest is forgotten (the host keeps the same). */
export const MAX_INDEXED_TASKS_PER_SESSION = 200;

export class TaskIndex {
  /** path → id → task, insertion-ordered so a session's commands read oldest first. */
  private readonly bySession = new Map<string, Map<string, IndexedTask>>();

  /** Fold one extension message in; true when it was a task update. */
  observe(path: string, message: PiExtensionMessage): boolean {
    if (message.type !== "lasercode/task/update") return false;
    const { logPath, ...rest } = message.task;
    let tasks = this.bySession.get(path);
    if (!tasks) {
      tasks = new Map();
      this.bySession.set(path, tasks);
    }
    const previous = tasks.get(rest.id);
    const kept = logPath ?? previous?.logPath;
    tasks.set(rest.id, { ...rest, sessionPath: path, ...(kept !== undefined ? { logPath: kept } : {}) });
    this.prune(tasks);
    return true;
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
  sessionClosed(path: string, reason = "the session ended"): void {
    const tasks = this.bySession.get(path);
    if (!tasks) return;
    for (const [id, task] of tasks) {
      if (task.status !== "running") continue;
      tasks.set(id, { ...task, status: "stopped", endedAt: new Date().toISOString(), exitCode: null, terminalReason: reason });
    }
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
 * The last `lines` lines of a task's log, read from its tail — at most
 * `TASK_OUTPUT_MAX_BYTES`, the same bound the host's `tasks/output` keeps
 * (R9). `undefined` when there is no file to read: the caller says so rather
 * than showing an empty pane.
 */
export async function readLogTail(logPath: string | undefined, lines: number): Promise<string | undefined> {
  if (logPath === undefined || !isAbsolute(logPath)) return undefined;
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return undefined;
  }
  const start = Math.max(0, size - TASK_OUTPUT_MAX_BYTES);
  const length = size - start;
  if (length === 0) return "";
  let text: string;
  try {
    const handle = await open(logPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const bytes = buffer.subarray(0, bytesRead);
      const aligned = alignUtf8(bytes, start === 0);
      text = bytes.toString("utf8", aligned.start, aligned.end);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  const all = text.split("\n");
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(Math.max(0, all.length - Math.max(1, lines))).join("\n");
}
