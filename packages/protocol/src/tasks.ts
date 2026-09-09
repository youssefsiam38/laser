/**
 * Background tasks — a long command the agent left running.
 *
 * A domain model, not a generic bus. The companion extension's
 * `background-work` module owns the process; the worker relays what it says;
 * the host keeps the register and serves the output. The fleet renders it
 * beside agent runs, because from the person's side they are the same
 * question: what is going on, and does it need me?
 *
 * The log file never crosses to a client. A task's bytes are read through
 * `tasks/output`, which the host answers from the path the task itself
 * carried — the arrival of the task is the grant, exactly as it must be when
 * the relay makes a client an arbitrary remote peer.
 */

/** `running` while the process lives; the other three are terminal. */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

/**
 * Why it is a task at all. `background` means the agent asked for one;
 * `promoted` means a foreground command outlived the foreground limit and
 * kept the output it had already produced (AGENTS.md, harness checks).
 */
export type BackgroundTaskOrigin = "background" | "promoted";

/** How a running task ended, in the words a person reads. */
export type BackgroundTaskStoppedBy = "agent" | "person" | "turn" | "shutdown";

export interface BackgroundTask {
  /** Unique inside its session; stable for the life of the task. */
  id: string;
  /** The session whose agent started it. */
  sessionPath: string;
  /** The command as it was written, whole. */
  command: string;
  /** Its first meaningful line, bounded — the row's name. */
  title: string;
  status: BackgroundTaskStatus;
  origin: BackgroundTaskOrigin;
  startedAt: string;
  endedAt?: string;
  /** `null` when the process ended without one (killed, or never started). */
  exitCode?: number | null;
  /** Bytes written so far. Also the liveness signal a follower reacts to. */
  outputBytes: number;
  /** The last line it printed, so a collapsed row still says something true. */
  activity?: string;
  /** "you stopped it", "exit code 2" — never lost. */
  terminalReason?: string;
  /** The failure in the runner's own words, when there was one. */
  error?: string;
}

/** Largest range one `tasks/output` answers. Ask again for more. */
export const TASK_OUTPUT_MAX_BYTES = 256 * 1024;
/** Bytes of `command` kept on the wire. */
export const TASK_COMMAND_MAX = 8 * 1024;
/** Bytes of `title` / `activity` kept on the wire. */
export const TASK_LINE_MAX = 1000;

export interface TaskOutputChunk {
  id: string;
  /** Offset the chunk starts at, aligned to a UTF-8 character boundary. */
  from: number;
  /** Total size so far, so a follower knows how far behind it is. */
  bytes: number;
  chunk: string;
  /** The chunk reached the current end. */
  eof: boolean;
}

/**
 * What the companion extension publishes for one of its tasks. `sessionPath`
 * is the worker's to add (it is the only party that knows it), and `logPath`
 * stops at the host: it is how the host reads the bytes, never something a
 * client is told.
 */
export interface BackgroundTaskUpdate extends Omit<BackgroundTask, "sessionPath"> {
  /** Absolute path of the file the task streams into, on the host's machine. */
  logPath?: string;
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * Every task the host knows about; `path` narrows to one session. For a
     * client that (re)attaches — notifications alone would leave a reloaded
     * fleet empty while the work is still going.
     */
    "tasks/list": { params: { path?: string }; result: { tasks: BackgroundTask[] } };
    /**
     * Ranged read of one task's output. `fromByte` is a byte offset; at most
     * {@link TASK_OUTPUT_MAX_BYTES} come back, and `from` is realigned to a
     * character boundary. Refused for a task of another session.
     */
    "tasks/output": { params: { path: string; id: string; fromByte: number }; result: TaskOutputChunk };
    /** A person ends a task. Recorded as person-initiated; already-ended tasks answer as they are. */
    "tasks/stop": { params: { path: string; id: string }; result: { task: BackgroundTask } };
    /**
     * Host → worker only: hand the stop to the session that owns the process.
     * `delivered` is false when nobody in that session holds the id any more.
     * A client never calls this; it calls `tasks/stop`, which the host answers
     * from its register.
     */
    "pi/task/stop": { params: { path: string; id: string }; result: { delivered: boolean } };
  }

  interface HostNotifications {
    /** A task appeared or changed. Same id replaces in place; arriving twice is normal. */
    "tasks/update": { task: BackgroundTask };
  }
}
