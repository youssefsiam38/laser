/**
 * background-work — long commands as background tasks.
 *
 * The original request (docs/agents-leap/references/original-request.md):
 * the agent may run a command in the background by a flag, and a hard
 * timeout promotes a foreground command into a background task even when it
 * was not flagged. This module overrides the engine's built-in `bash` with
 * one that delegates execution to the engine's own definition and adds:
 *
 *   - `background: true` — start the command, return a task id at once;
 *   - promotion — after `foregroundCommandSeconds` a still-running foreground
 *     command keeps running as a task and the tool returns the output so far;
 *   - `task_output` and `task_stop` to follow tasks — there is no list: the
 *     harness's `inspect_fleet` shows every command in the session's tree
 *     beside the agents that ran them (D-163), and `task_output` reads a
 *     command of an agent under this session through the worker
 *     (`BackgroundWorkOptions.readTask`), because modules never see each
 *     other's tasks;
 *   - a `lasercode/task/update` for every task the person can see, carrying the
 *     log file it streams into so the host can serve `tasks/output`.
 *
 * Execution itself — shell resolution, `PI_*` environment, the process tree
 * kill on abort, output truncation for the model — stays the engine's. The
 * raw bytes are teed through a per-task `operations.exec` so the task record
 * keeps an exact byte count and the last 256 KiB without depending on the
 * engine's snapshot cadence.
 *
 * Nothing waits (D-162, the rule D-158 set for child agents): there is no
 * waiting tool, and a background task's exit — explicit or promoted alike —
 * reaches the model as a `lasercode/task-event` message with `triggerTurn:
 * true`, carrying status, exit code and the tail of the output, so an idle
 * model wakes to use it and a running one sees it before its next call. The
 * start result says so. The one exception is the model's own choice, in
 * words: `bash` with `background: true, notify: false` (a dev server, a
 * watcher, anything it said it does not need to hear from) ends with
 * `triggerTurn: false` — recorded and shown with the next turn, never waking
 * one. `notify` without `background` is ignored.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashOperations,
  type BashSpawnContext,
  type BashToolDetails,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  TASK_COMMAND_MAX,
  TASK_EVENT_MESSAGE_TYPE,
  TASK_LINE_MAX,
  TASK_OUTPUT_MAX_BYTES,
  WIRE_NAMESPACE,
  type BackgroundTaskRetention,
  type BackgroundTaskUpdate,
} from "@lasercode/protocol";
import { Type } from "typebox";
import type { BackgroundWorkOptions } from "../agents-bridge.js";
import type { LaserModule, ModuleContext } from "./index.js";
import { TaskLog } from "./task-log.js";

/**
 * Give every process this module starts the project's environment.
 *
 * The engine owns shell resolution and its own `PI_*` variables; this only
 * decorates the environment it assembled, so a project value never has to be
 * written into the worker's own process environment to reach a command.
 */
function projectEnvSpawnHook(
  projectEnv: BackgroundWorkOptions["projectEnv"],
): { spawnHook?: (context: BashSpawnContext) => BashSpawnContext } {
  if (!projectEnv) return {};
  return { spawnHook: (context) => ({ ...context, env: projectEnv.apply(context.env) }) };
}

/** Bytes of output kept in memory while a command runs. Released when it ends. */
const TAIL_BYTES = 256 * 1024;
const DEFAULT_TAIL_LINES = 100;
const PROMOTED_TAIL_LINES = 40;
const TITLE_MAX = 80;
/** Minimum spacing between two task re-emits for output growth alone. */
const PUBLISH_THROTTLE_MS = 500;
/** How long `task_stop` waits for the killed process to be reaped. */
const STOP_GRACE_MS = 5000;

// --- what a finished command is allowed to keep (RP-6) ----------------------
//
// A command that has ended keeps a compact record and nothing else: the full
// tail buffer, the engine's result, its failure and the closure that held the
// tool call all go at terminal delivery. The three bounds below are
// independent, and a running command is exempt from every one of them — the
// rule is that memory is released, never that work is.
//
// The counts match `MAX_TASKS_PER_SESSION` in the host's register and
// `MAX_INDEXED_TASKS_PER_SESSION` in the worker's index on purpose: the three
// layers forget in the same order, so the fleet never draws a row whose
// metadata one layer has quietly dropped (docs/ux-fleet.md R8). Forgetting a
// record here removes neither the fleet row (the host and worker keep it) nor
// the bytes on disk (they have their own budget), so nothing a person is
// looking at vanishes (R7).

/** Bytes of the end of the output a finished command keeps in memory. */
const TASK_EXCERPT_BYTES = 8 * 1024;
/** Finished commands one session keeps in memory. */
const TERMINAL_TASKS_MAX = 200;
/** How long a finished command's compact record stays in memory. */
const TERMINAL_TASK_MAX_AGE_MS = 60 * 60_000;
/** Excerpt bytes across every finished command of one session. */
const TERMINAL_EXCERPT_BYTES_MAX = 2 * 1024 * 1024;
/** Bytes this session's command logs may occupy on disk, unless the worker lowers it. */
const SESSION_LOG_BYTES_MAX = 128 * 1024 * 1024;
/** Smallest budget the worker may impose: one segment for the newest command. */
const SESSION_LOG_BYTES_MIN = 8 * 1024 * 1024;
/** How much a command may write between two checks of the session's disk budget. */
const BUDGET_CHECK_BYTES = 1024 * 1024;
/** How old a file left by a crashed run must be before a sweep may remove it. */
const STALE_LOG_AGE_MS = 24 * 60 * 60_000;
/** Directory entries one sweep looks at. A sweep is housekeeping, not a scan. */
const SWEEP_ENTRIES_MAX = 500;
/** Session directories one sweep may clean, oldest first. */
const SWEEP_DIRS_MAX = 64;
/** Directory names one sweep will even look at. */
const SWEEP_NAMES_MAX = 512;

export type TaskStatus = "running" | "completed" | "failed" | "stopped";
type TaskMode = "foreground" | "promoted" | "background";
type StoppedBy = "agent" | "person" | "turn" | "shutdown";

type BashResult = AgentToolResult<BashToolDetails | undefined>;
type BashUpdate = AgentToolUpdateCallback<BashToolDetails | undefined>;
/** The engine's own details, or the task handle the override adds. */
export type BashOverrideDetails = BashToolDetails | { taskId: string; promoted: true } | { taskId: string; background: true } | undefined;

/** Released at compaction; a shared one costs a finished task nothing. */
const NOOP = (): void => {};

interface TaskRecord {
  id: string;
  command: string;
  status: TaskStatus;
  mode: TaskMode;
  /** Whether the exit wakes the model's turn; false only for an explicit `notify: false`. */
  notify: boolean;
  exitCode: number | null | undefined;
  startedAt: string;
  endedAt?: string;
  /** When it ended, for the age bound. `undefined` while it runs. */
  endedAtMs?: number;
  bytes: number;
  /** The live 256 KiB window. Released the moment the command's exit is delivered. */
  tail: TailBuffer | undefined;
  /** What the compact record keeps of the output: the last few KiB, as text. */
  excerpt?: string;
  /** The bounded window on disk, and the exact byte count and digest beside it. */
  log: TaskLog;
  stoppedBy?: StoppedBy;
  /** Dropped at compaction: the engine result/failure are already delivered. */
  controller: AbortController | undefined;
  /** The engine's own result or failure, returned unchanged on the foreground path. */
  result?: BashResult | undefined;
  failure?: unknown;
  error?: string;
  done: Promise<void>;
  /** Stops forwarding the engine's streamed updates to a tool call that has returned. */
  detach: () => void;
  publishTimer: NodeJS.Timeout | undefined;
  lastPublishAt: number;
  /** True once the terminal record has been compacted; it never runs twice. */
  compacted: boolean;
}

interface State {
  tasks: Map<string, TaskRecord>;
  sessionId?: string;
  /** Set by activate; a task that ends before then has nobody to tell. */
  notify?: (task: TaskRecord) => void;
  /** Set by register; publishes retention when it changes, never on a timer. */
  publishRetention?: () => void;
  /** Bytes this session's logs may occupy; the worker may lower it (RP-6). */
  logBudget: number;
  /** Logs of records a bound forgot: still ours to account for and release. */
  orphanLogs: TaskLog[];
  /** Bytes written since the last budget check; the check is not per chunk. */
  bytesSinceBudgetCheck: number;
  evicted: number;
  released: number;
}

const states = new WeakMap<ModuleContext, State>();

/** Keeps the last `limit` bytes of everything appended. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
  /** Bytes held right now, for the retention counters. */
  get bytes(): number {
    return this.size;
  }
  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export function lastLines(text: string, count: number): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1).replace(/\.0$/, "");
}

function firstLine(command: string): string {
  const line = command.split("\n").find((l) => l.trim().length > 0)?.trim() ?? command.trim();
  if (!line) return "(empty command)";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function newTaskId(): string {
  return `t-${randomBytes(4).toString("hex")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STOP_REASONS: Readonly<Record<StoppedBy, string>> = {
  agent: "the agent stopped it",
  person: "you stopped it",
  turn: "the turn was cancelled",
  shutdown: "the session ended",
};

// ---------------------------------------------------------------------------
// What a finished command keeps (RP-6)
// ---------------------------------------------------------------------------

/** The output a record can still show: the live window, or the excerpt left of it. */
function heldText(task: TaskRecord): string {
  return task.tail ? task.tail.text() : (task.excerpt ?? "");
}

/** The last `limit` bytes of `text`, cut on a character boundary. */
function tailBytesOf(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  return bytes.subarray(bytes.length - limit).toString("utf8").replace(/^[\uFFFD]/, "");
}

/**
 * Let go of everything a finished command no longer needs.
 *
 * This runs **after** its terminal `lasercode/task/update` has been published,
 * after its exit message has been built and sent to the model, and after the
 * foreground caller (if there was one) has taken the engine's own result: a
 * command's ending is delivered in full, and only then is the memory that
 * carried it released.
 *
 * What goes: the 256 KiB tail buffer, the engine's result and failure, the
 * abort controller, and — the largest of them — the `detach` closure, which
 * held the tool call's `ExtensionContext`, its update callback and the
 * per-task bash tool definition alive for as long as the record existed.
 * What stays is a compact record plus a few KiB of the end of the output, and
 * the bounded window on disk that `task_output` reads.
 */
function compact(state: State, task: TaskRecord): void {
  if (task.compacted || task.status === "running") return;
  task.compacted = true;
  task.excerpt = tailBytesOf(heldText(task), TASK_EXCERPT_BYTES);
  task.tail = undefined;
  task.result = undefined;
  task.failure = undefined;
  task.controller = undefined;
  task.detach = NOOP;
  if (task.publishTimer) {
    clearTimeout(task.publishTimer);
    task.publishTimer = undefined;
  }
  task.log.close();
  enforceBounds(state);
}

/** Finished commands, oldest ending first — the order every bound forgets in. */
function terminalByAge(state: State): TaskRecord[] {
  return [...state.tasks.values()]
    .filter((task) => task.status !== "running" && task.endedAtMs !== undefined)
    .sort((left, right) => (left.endedAtMs ?? 0) - (right.endedAtMs ?? 0));
}

/**
 * The three independent bounds on finished commands: how many, how old, how
 * many excerpt bytes. A running command is exempt from all three.
 *
 * Forgetting a record here releases memory and nothing else: the fleet row
 * lives in the worker's index and the host's register, and the bytes on disk
 * have their own budget, so nothing a person is looking at disappears because
 * this ran (docs/ux-fleet.md R7).
 */
function enforceBounds(state: State, now = Date.now()): void {
  let terminal = terminalByAge(state);
  const excerptBytes = (): number =>
    terminal.reduce((sum, task) => sum + Buffer.byteLength(task.excerpt ?? "", "utf8"), 0);
  const forget = (task: TaskRecord): void => {
    state.tasks.delete(task.id);
    state.evicted += 1;
    keepLogForBudget(state, task);
    terminal = terminal.filter((candidate) => candidate !== task);
  };
  for (const task of [...terminal]) {
    if (task.endedAtMs !== undefined && now - task.endedAtMs > TERMINAL_TASK_MAX_AGE_MS) forget(task);
  }
  while (terminal.length > TERMINAL_TASKS_MAX) forget(terminal[0]!);
  while (terminal.length > 0 && excerptBytes() > TERMINAL_EXCERPT_BYTES_MAX) forget(terminal[0]!);
}

/**
 * A forgotten record's bytes are still this session's to account for and to
 * release: the log stays owned here until a budget releases it, because
 * nothing else may delete bytes this runtime wrote.
 */
function keepLogForBudget(state: State, task: TaskRecord): void {
  if (!task.log.usable) return;
  state.orphanLogs.push(task.log);
  while (state.orphanLogs.length > SWEEP_ENTRIES_MAX) {
    const oldest = state.orphanLogs.shift();
    if (oldest && oldest.usable) {
      oldest.release();
      state.released += 1;
    }
  }
}

/** Every log this session owns, oldest first: what a budget may release. */
function logsOf(state: State): Array<{ log: TaskLog; live: boolean }> {
  const live: Array<{ log: TaskLog; live: boolean }> = [];
  const finished: Array<{ log: TaskLog; live: boolean }> = [];
  for (const task of state.tasks.values()) {
    (task.status === "running" ? live : finished).push({ log: task.log, live: task.status === "running" });
  }
  return [...state.orphanLogs.map((log) => ({ log, live: false })), ...finished, ...live];
}

function sessionLogBytes(state: State): number {
  return logsOf(state).reduce((sum, entry) => sum + entry.log.diskBytes, 0);
}

/**
 * Keep this session's commands inside their share of the disk.
 *
 * Order: logs nobody holds a record for, then finished commands oldest first,
 * then the older half of a running command's window. **A running command is
 * never paused, throttled or killed to stay inside the budget** — only bytes
 * it has already written are released, its exact byte count and digest survive
 * the release, and its row says `truncated` so nothing pretends the output was
 * complete. Live output is not exempt: a command that prints for ever must not
 * be able to fill the disk.
 */
function enforceLogBudget(state: State): void {
  if (sessionLogBytes(state) <= state.logBudget) return;
  for (const entry of logsOf(state)) {
    if (sessionLogBytes(state) <= state.logBudget) break;
    if (entry.live) {
      if (entry.log.releaseOldest() > 0) state.released += 1;
    } else {
      entry.log.release();
      state.released += 1;
    }
  }
  // Still over after every finished log went: the live windows themselves are
  // the floor, and they are already one segment each.
  state.orphanLogs = state.orphanLogs.filter((log) => log.usable);
}

/** What this session's commands are holding, for RP-3 and the worker's budget. */
export function retentionOf(state: State): BackgroundTaskRetention {
  let live = 0;
  let terminal = 0;
  let liveTailBytes = 0;
  let excerptBytes = 0;
  for (const task of state.tasks.values()) {
    if (task.status === "running") {
      live += 1;
      liveTailBytes += task.tail?.bytes ?? 0;
    } else {
      terminal += 1;
      excerptBytes += Buffer.byteLength(task.excerpt ?? "", "utf8");
      liveTailBytes += task.tail?.bytes ?? 0;
    }
  }
  return {
    live,
    terminal,
    liveTailBytes,
    excerptBytes,
    logBytes: sessionLogBytes(state),
    evicted: state.evicted,
    released: state.released,
  };
}

/**
 * Files left by a run that is gone.
 *
 * Only age decides, and only for crash recovery: this directory is shared with
 * the other workers on this machine, and a young file may belong to a command
 * somebody else's session is still writing. A file this runtime owns is
 * released by its owner through the budget above, never by a guess about who
 * wrote it.
 */
function sweepStaleLogs(root: string, now = Date.now()): number {
  let removed = 0;
  let examined = 0;
  let names: string[];
  try {
    names = readdirSync(root).slice(0, SWEEP_NAMES_MAX);
  } catch {
    return 0;
  }
  // One stat per directory decides: a session that wrote a command log in the
  // last day may still be writing one, and nothing here opens it. The oldest
  // go first, so a machine with many sessions still reclaims the stale ones.
  const candidates: Array<{ directory: string; mtimeMs: number }> = [];
  for (const name of names) {
    const directory = join(root, name);
    try {
      const { mtimeMs } = statSync(directory);
      if (now - mtimeMs > STALE_LOG_AGE_MS) candidates.push({ directory, mtimeMs });
    } catch {
      // Gone, or not ours to read.
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const { directory } of candidates.slice(0, SWEEP_DIRS_MAX)) {
    if (examined >= SWEEP_ENTRIES_MAX) break;
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch {
      continue;
    }
    let left = files.length;
    for (const file of files) {
      if (examined >= SWEEP_ENTRIES_MAX) break;
      examined += 1;
      const path = join(directory, file);
      try {
        if (now - statSync(path).mtimeMs <= STALE_LOG_AGE_MS) continue;
        rmSync(path, { force: true });
        removed += 1;
        left -= 1;
      } catch {
        // A file somebody else removed first, or one we may not touch.
      }
    }
    if (left <= 0) {
      try {
        rmSync(directory, { recursive: false, force: true });
      } catch {
        // A directory that is not empty after all: leave it alone.
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The task record on the wire
// ---------------------------------------------------------------------------

/**
 * What the fleet renders. A foreground command that finished inside the limit
 * is not here on purpose: it already carried its result in its own tool row,
 * and a fleet row for every quick `ls` would bury the real work.
 */
export function taskUpdate(task: TaskRecord): BackgroundTaskUpdate {
  const activity = lastLines(heldText(task), 1).slice(0, TASK_LINE_MAX);
  return {
    id: task.id,
    command: task.command.slice(0, TASK_COMMAND_MAX),
    title: firstLine(task.command),
    status: task.status,
    origin: task.mode === "background" ? "background" : "promoted",
    startedAt: task.startedAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    // A killed process has no code, and saying so is not the same as saying
    // zero: a terminal task always carries the field, `null` included.
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : task.status === "running" ? {} : { exitCode: null }),
    outputBytes: task.bytes,
    ...(activity ? { activity } : {}),
    ...(task.status === "stopped" ? { terminalReason: STOP_REASONS[task.stoppedBy ?? "agent"] } : {}),
    ...(task.status === "failed"
      ? {
          terminalReason: typeof task.exitCode === "number" ? `exit code ${task.exitCode}` : "it did not finish",
          ...(task.error ? { error: task.error.slice(0, 4000) } : {}),
        }
      : {}),
    // What is still readable, and the truth about what was produced whatever
    // was released: the exact byte count is `outputBytes` above, the digest
    // covers every byte the command printed, and `retainedFromByte` says where
    // the window that survives begins.
    ...(task.log.usable ? { logPath: task.log.path } : {}),
    logState: task.log.state,
    retainedFromByte: task.log.retainedFromByte,
    outputDigest: task.log.digest(),
  };
}

// ---------------------------------------------------------------------------
// Running a task
// ---------------------------------------------------------------------------

interface StartInput {
  command: string;
  timeout: number | undefined;
  mode: TaskMode;
  /** False only for an explicit background task the model does not want to hear from. */
  notify: boolean;
  toolCallId: string;
  toolCtx: ExtensionContext;
  /** Forwarded while the tool call is still foreground; dropped after promotion. */
  onUpdate: BashUpdate | undefined;
}

function sessionIdFor(state: State, toolCtx: ExtensionContext): string {
  if (state.sessionId) return state.sessionId;
  let id: string | undefined;
  try {
    id = toolCtx.sessionManager?.getSessionId?.();
  } catch {
    id = undefined;
  }
  state.sessionId = id && id.length > 0 ? id : `session-${randomBytes(4).toString("hex")}`;
  return state.sessionId;
}

/** Where this session's command logs live: one directory, one writer. */
function logRoot(): string {
  return join(tmpdir(), `${WIRE_NAMESPACE}-tasks`);
}

function startTask(ctx: ModuleContext, state: State, options: BackgroundWorkOptions, input: StartInput, publish: (task: TaskRecord) => void): TaskRecord {
  const id = newTaskId();
  const dir = join(logRoot(), sessionIdFor(state, input.toolCtx));
  const controller = new AbortController();
  let forwardUpdates = true;
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  let loggedLogFailure = false;
  const log = new TaskLog({
    dir,
    id,
    onError: (error) => {
      if (loggedLogFailure) return;
      loggedLogFailure = true;
      ctx.send({ type: "lasercode/module/log", module: "background-work", level: "warn", message: `task ${id} has no log file: ${describe(error)}` });
    },
  });

  const task: TaskRecord = {
    id,
    command: input.command,
    status: "running",
    mode: input.mode,
    notify: input.notify,
    exitCode: undefined,
    startedAt: new Date().toISOString(),
    bytes: 0,
    tail: new TailBuffer(TAIL_BYTES),
    log,
    controller,
    done: finished,
    detach: () => {
      forwardUpdates = false;
    },
    publishTimer: undefined,
    lastPublishAt: 0,
    compacted: false,
  };
  state.tasks.set(id, task);

  const schedulePublish = (): void => {
    if (task.publishTimer || task.status !== "running") return;
    const wait = Math.max(0, PUBLISH_THROTTLE_MS - (Date.now() - task.lastPublishAt));
    task.publishTimer = setTimeout(() => {
      task.publishTimer = undefined;
      if (task.status === "running") publish(task);
    }, wait);
    task.publishTimer.unref?.();
  };

  const local = createLocalBashOperations(options.shellPath ? { shellPath: options.shellPath } : {});
  let shellPid: number | undefined;
  const operations: BashOperations = {
    exec: async (command, cwd, execOptions) => {
      const result = await local.exec(command, cwd, {
        ...execOptions,
        // The engine spawns the shell; `onSpawn` is how it hands back the pid
        // it already has, so the host's process inventory can say which
        // command a process belongs to instead of calling it an unknown
        // descendant (RP-1). It is an observation and nothing else: an engine
        // without the callback never calls it and nothing is registered
        // rather than guessed, and a throw in here cannot reach the command
        // (the engine guards the call). Filed upstream; carried meanwhile as
        // an exact-version patch (docs/upstream.md).
        onSpawn: (pid: number) => {
          if (!Number.isInteger(pid) || pid <= 0) return;
          shellPid = pid;
          ctx.send({ type: "lasercode/process/registration", pid, taskId: task.id });
        },
        onData: (data) => {
          task.bytes += data.length;
          task.tail?.append(data);
          task.log.append(data);
          // The budget is checked per megabyte written, not per chunk: a
          // command printing in 8 KiB pieces must not pay for a walk of every
          // log this session owns on each one.
          state.bytesSinceBudgetCheck += data.length;
          if (state.bytesSinceBudgetCheck >= BUDGET_CHECK_BYTES) {
            state.bytesSinceBudgetCheck = 0;
            enforceLogBudget(state);
          }
          execOptions.onData(data);
          schedulePublish();
        },
      });
      task.exitCode = result.exitCode;
      return result;
    },
  };
  const commandPrefix = typeof options.commandPrefix === "function" ? options.commandPrefix() : options.commandPrefix;
  const tool = createBashToolDefinition(options.cwd, {
    operations,
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    ...(commandPrefix ? { commandPrefix } : {}),
    ...projectEnvSpawnHook(options.projectEnv),
  });
  const onUpdate: BashUpdate | undefined = input.onUpdate
    ? (update) => {
        if (forwardUpdates) input.onUpdate?.(update);
      }
    : undefined;

  void (async () => {
    try {
      task.result = await tool.execute(
        input.toolCallId,
        { command: input.command, ...(input.timeout !== undefined ? { timeout: input.timeout } : {}) },
        controller.signal,
        onUpdate,
        input.toolCtx,
      );
      task.status = "completed";
    } catch (failure: unknown) {
      task.failure = failure;
      task.error = describe(failure);
      task.status = controller.signal.aborted ? "stopped" : "failed";
    }
    task.endedAt = new Date().toISOString();
    task.endedAtMs = Date.now();
    if (task.publishTimer) {
      clearTimeout(task.publishTimer);
      task.publishTimer = undefined;
    }
    task.log.close();
    if (shellPid !== undefined) ctx.send({ type: "lasercode/process/registration", pid: shellPid, taskId: task.id, exited: true });
    publish(task);
    // The rule (D-162): a foreground call carried its own result; every other
    // exit is a message to the model, and `task.notify` says whether it
    // wakes a turn (always, unless the model asked `notify: false`).
    if (task.mode !== "foreground") {
      state.notify?.(task);
      // Its ending has been published and delivered: the memory that carried
      // it may go. A foreground call still has to return the engine's own
      // result, so that path compacts itself once it has taken it.
      compact(state, task);
    }
    state.publishRetention?.();
    settle();
  })();

  publish(task);
  enforceLogBudget(state);
  state.publishRetention?.();
  return task;
}

function stopTask(task: TaskRecord, by: StoppedBy): void {
  if (task.status !== "running") return;
  task.stoppedBy = by;
  task.controller?.abort();
}

function summary(task: TaskRecord) {
  return {
    taskId: task.id,
    command: task.command,
    status: task.status,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    outputBytes: task.bytes,
    background: task.mode === "background",
    promoted: task.mode === "promoted",
    // Which endings wake a turn; false is the model's own `notify: false`.
    notify: task.mode !== "foreground" && task.notify,
  };
}

function exitText(task: TaskRecord): string {
  const outcome =
    task.status === "completed"
      ? `exited with code ${task.exitCode ?? 0}`
      : task.status === "stopped"
        ? `was stopped (${STOP_REASONS[task.stoppedBy ?? "agent"]})`
        : typeof task.exitCode === "number"
          ? `exited with code ${task.exitCode}`
          : `failed: ${task.error ?? "it did not finish"}`;
  const tail = lastLines(heldText(task), PROMOTED_TAIL_LINES);
  return [
    `Background task ${task.id} (${firstLine(task.command)}) ${outcome}.`,
    tail ? `Last lines:\n${tail}` : "(no output)",
    `Use task_output ${task.id} for more.`,
  ].join("\n");
}

function promotedText(task: TaskRecord, seconds: number): string {
  const tail = lastLines(heldText(task), PROMOTED_TAIL_LINES);
  return [
    `Still running after ${formatSeconds(seconds)} s; it continues as background task ${task.id}. Output so far (last lines):`,
    tail || "(no output yet)",
    followGuidance(task.id),
  ].join("\n");
}

/** The sentence the model reads the moment a task goes to the background: carry on; the exit comes to you. */
function followGuidance(taskId: string): string {
  return (
    `Do not wait for task ${taskId}. Carry on with your own work; when it exits, its status, exit code and the last lines of its output will be sent to you as a message. ` +
    `Use task_output ${taskId} to read its output meanwhile, or task_stop ${taskId} to end it.`
  );
}

/** The same moment for a task the model asked not to hear from. */
function quietGuidance(taskId: string): string {
  return (
    `You asked not to be told when task ${taskId} exits: its ending is recorded and shown to you with your next turn, and never starts one. ` +
    `Use task_output ${taskId} to read its output, or task_stop ${taskId} to end it.`
  );
}

function text(value: string): AgentToolResult<Record<string, unknown>>["content"] {
  return [{ type: "text", text: value }];
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export const backgroundWorkModule: LaserModule = {
  name: "background-work",

  detect: (ctx) => Boolean(ctx.backgroundWork),

  register(ctx) {
    const options = ctx.backgroundWork;
    if (!options) return;
    const { pi } = ctx;
    const state: State = { tasks: new Map(), logBudget: SESSION_LOG_BYTES_MAX, orphanLogs: [], bytesSinceBudgetCheck: 0, evicted: 0, released: 0 };
    states.set(ctx, state);
    const seconds = options.foregroundCommandSeconds;

    // Housekeeping for runs that are gone: bounded, age-only, and never a
    // guess about who owns a young file (see `sweepStaleLogs`).
    try {
      sweepStaleLogs(logRoot());
    } catch {
      // A missing or unreadable temp directory is not a reason to fail a session.
    }

    let lastRetention = "";
    state.publishRetention = () => {
      const retention = retentionOf(state);
      const serialized = JSON.stringify(retention);
      // On change only: this is a fact about what is held, not a heartbeat.
      if (serialized === lastRetention) return;
      lastRetention = serialized;
      ctx.send({ type: "lasercode/task/retention", retention });
    };

    const publish = (task: TaskRecord): void => {
      // Only background work is fleet work (see `taskUpdate`).
      if (task.mode === "foreground") return;
      task.lastPublishAt = Date.now();
      ctx.send({ type: "lasercode/task/update", task: taskUpdate(task) });
    };

    const requireTask = (taskId: string): TaskRecord => {
      const task = state.tasks.get(taskId);
      if (!task) throw new Error(`No task ${taskId} was started by this session. inspect_fleet shows every command in your tree with its taskId; task_stop ends only your own.`);
      return task;
    };

    // The engine's own definition supplies the description and prompt text;
    // its renderers are inherited by omission (extensions.md, "Overriding
    // Built-in Tools").
    const commandPrefix = typeof options.commandPrefix === "function" ? options.commandPrefix() : options.commandPrefix;
    const base = createBashToolDefinition(options.cwd, {
      ...(options.shellPath ? { shellPath: options.shellPath } : {}),
      ...(commandPrefix ? { commandPrefix } : {}),
      ...projectEnvSpawnHook(options.projectEnv),
    });

    pi.registerTool({
      name: "bash",
      label: base.label,
      description: `${base.description} A foreground command still running after ${formatSeconds(seconds)} seconds keeps running as a background task; the tool then returns the output so far and a task id, and the task's exit is sent to you as a message.`,
      promptSnippet: `${base.promptSnippet ?? "Execute bash commands"}; long commands continue as background tasks`,
      promptGuidelines: [
        ...(base.promptGuidelines ?? []),
        "Use bash with background true for servers, watchers and anything whose outcome you do not need before your next step; it returns a task id at once, and the task's exit is sent to you as a message. Add notify false for a command you do not need to hear back from at all.",
        `A bash command still running after ${formatSeconds(seconds)} s becomes a background task by itself; when the result says so, carry on with your own work — its exit will be sent to you. Read output before then with task_output, or end it with task_stop.`,
      ],
      parameters: Type.Object({
        command: Type.String({ description: "The command to run." }),
        timeout: Type.Optional(Type.Number({ description: "Kill the command after this many seconds (optional, no default)." })),
        background: Type.Optional(
          Type.Boolean({
            description: "Run in the background and return a task id immediately. You will be told when it exits; carry on meanwhile. Use task_output to read its output before then, or task_stop to end it.",
          }),
        ),
        notify: Type.Optional(
          Type.Boolean({
            description:
              "Only with background true (default true). false means the exit is recorded and shown in your next turn and never wakes one: for a dev server, a watcher, anything you do not need to hear back from. Ignored without background.",
          }),
        ),
      }),
      async execute(toolCallId, { command, timeout, background, notify }, signal, onUpdate, toolCtx): Promise<AgentToolResult<BashOverrideDetails>> {
        // A project that requires its environment does not run commands with the
        // wrong one. The refusal is a sentence, not a stack trace, and it says
        // what to do next.
        if (options.projectEnv?.blocking()) throw new Error(options.projectEnv.reason());
        if (background === true) {
          const quiet = notify === false;
          const task = startTask(ctx, state, options, { command, timeout, mode: "background", notify: !quiet, toolCallId, toolCtx, onUpdate: undefined }, publish);
          return {
            content: text(`Started background task ${task.id}: ${firstLine(command)}.\n${quiet ? quietGuidance(task.id) : followGuidance(task.id)}`),
            details: { taskId: task.id, background: true },
          };
        }

        // `notify` is meaningful only with `background`; a foreground command
        // that outruns the limit is promoted and wakes the model regardless.
        const task = startTask(ctx, state, options, { command, timeout, mode: "foreground", notify: true, toolCallId, toolCtx, onUpdate }, publish);
        // The turn's cancel reaches the process only while the call is foreground.
        const onTurnAbort = (): void => stopTask(task, "turn");
        if (signal?.aborted) onTurnAbort();
        else signal?.addEventListener("abort", onTurnAbort, { once: true });

        let timer: NodeJS.Timeout | undefined;
        const promotion = new Promise<"promoted">((resolve) => {
          timer = setTimeout(() => resolve("promoted"), Math.max(0, seconds * 1000));
        });
        const outcome = await Promise.race([task.done.then(() => "done" as const), promotion]);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onTurnAbort);

        if (outcome === "done" || task.status !== "running") {
          // The engine's own answer, taken before anything is released: this is
          // the third and last consumption fence, so compaction after it can
          // never race the value this call has to return.
          const failure = task.failure;
          const result = task.result;
          compact(state, task);
          state.publishRetention?.();
          if (failure !== undefined) throw failure;
          return result!;
        }
        task.mode = "promoted";
        task.detach();
        publish(task);
        return {
          content: text(promotedText(task, seconds)),
          details: { taskId: task.id, promoted: true },
        };
      },
    });

    pi.registerTool({
      name: "task_output",
      label: "Read task output",
      description:
        `Return the last lines of a background task's output (default ${DEFAULT_TAIL_LINES}), with its status. ` +
        "Takes any command in your tree: one you started, or one an agent under you started — inspect_fleet lists them with their taskId. Read-only.",
      promptSnippet: "Read the latest output of a background task, yours or an agent's under you",
      promptGuidelines: ["Use task_output with a task id to read what a background task has printed so far, before its exit reaches you; pass tail for more lines. inspect_fleet shows every task id in your tree."],
      parameters: Type.Object({
        taskId: Type.String({ minLength: 1, description: "The task id, from bash's result or from inspect_fleet." }),
        tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: `Lines from the end to return (default ${DEFAULT_TAIL_LINES}).` })),
      }),
      async execute(_toolCallId, { taskId, tail }): Promise<AgentToolResult<Record<string, unknown>>> {
        const own = state.tasks.get(taskId);
        if (own) {
          // A running command answers from the window in memory; a finished one
          // answers from the bounded window on disk, which is why its tail
          // buffer could be released when it ended. What was released is said,
          // never implied: the exact total and the digest are always there.
          const durable = own.status === "running" ? undefined : own.log.readTail(TASK_OUTPUT_MAX_BYTES);
          const body = durable !== undefined ? durable.toString("utf8") : heldText(own);
          const lines = lastLines(body, tail ?? DEFAULT_TAIL_LINES);
          const released = own.status !== "running" && durable === undefined;
          const retainedFrom = own.log.retainedFromByte;
          const note = released
            ? `\n(the full output was released; ${own.bytes} bytes were produced, sha256 ${own.log.digest()}, and this is the last of it)`
            : retainedFrom > 0
              ? `\n(output before byte ${retainedFrom} was released; ${own.bytes} bytes were produced, sha256 ${own.log.digest()})`
              : "";
          const header = `task ${own.id} ${own.status}${typeof own.exitCode === "number" ? ` (exit code ${own.exitCode})` : ""} · ${own.bytes} bytes of output`;
          return {
            content: text(`${header}\n${lines || "(no output)"}${note}`),
            details: {
              ...summary(own),
              lines: lines ? lines.split("\n").length : 0,
              logState: own.log.state,
              retainedFromByte: retainedFrom,
              outputDigest: own.log.digest(),
            },
          };
        }
        // Not this session's: a command of an agent under it, read through
        // the worker (D-163), which refuses anything outside the tree.
        if (!options.readTask) throw new Error(`No task ${taskId} was started by this session.`);
        const read = await options.readTask(taskId, tail ?? DEFAULT_TAIL_LINES);
        const { task, owner } = read;
        const header = `task ${task.id} ${task.status}${typeof task.exitCode === "number" ? ` (exit code ${task.exitCode})` : ""} · ${task.outputBytes} bytes of output · started by ${owner.subagentName} (sessionId ${owner.sessionId})`;
        const body = read.text === undefined ? `(no log file kept; its last line was: ${task.activity ?? "nothing yet"})` : read.text || "(no output)";
        return {
          content: text(`${header}\n${body}`),
          details: { taskId: task.id, command: task.command, status: task.status, exitCode: task.exitCode ?? null, startedAt: task.startedAt, ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}), outputBytes: task.outputBytes, owner, lines: read.text ? read.text.split("\n").length : 0 },
        };
      },
    });

    pi.registerTool({
      name: "task_stop",
      label: "Stop a task",
      description: "End a running background task by killing its process tree. A task that already ended is reported as is.",
      promptSnippet: "Stop a background task",
      promptGuidelines: ["Use task_stop with a task id to end a background task that is no longer needed."],
      parameters: Type.Object({ taskId: Type.String({ minLength: 1, description: "The task id." }) }),
      async execute(_toolCallId, { taskId }) {
        const task = requireTask(taskId);
        const stoppedNow = task.status === "running";
        if (stoppedNow) {
          stopTask(task, "agent");
          let grace: NodeJS.Timeout | undefined;
          await Promise.race([
            task.done,
            new Promise<void>((resolve) => {
              grace = setTimeout(resolve, STOP_GRACE_MS);
            }),
          ]);
          if (grace) clearTimeout(grace);
        }
        const result = { taskId: task.id, status: task.status, exitCode: task.exitCode ?? null };
        const message = stoppedNow ? `Task ${task.id} ${task.status === "stopped" ? "stopped" : `ended with status ${task.status} before it could be stopped`}.` : `Task ${task.id} had already ended with status ${task.status}.`;
        return { content: text(message), details: result };
      },
    });
  },

  activate(ctx) {
    const state = states.get(ctx);
    if (!state || !ctx.backgroundWork) return;
    const { pi } = ctx;
    let disposed = false;

    state.notify = (task) => {
      if (disposed) return;
      try {
        pi.sendMessage(
          { customType: TASK_EVENT_MESSAGE_TYPE, content: exitText(task), display: true, details: summary(task) },
          // The model was told it would hear back, so an idle model is woken
          // (D-162) — unless it asked `notify: false`, in which case the exit
          // is recorded and shown with the next turn without starting one.
          { deliverAs: "steer", triggerTurn: task.notify },
        );
      } catch (error) {
        ctx.send({ type: "lasercode/module/log", module: "background-work", level: "warn", message: `could not report task ${task.id}: ${describe(error)}` });
      }
    };

    // A person presses Stop in the fleet: `tasks/stop` reaches the worker,
    // which sends the command here. A task this session does not own is not
    // ours to answer, so the worker learns it was not delivered.
    const offCommand = ctx.commands?.on((command) => {
      // The worker's share of the per-worker disk budget for this session. It
      // never deletes another runtime's files; it says how much this one may
      // keep, and this runtime releases its own bytes (RP-6).
      if (command.type === "lasercode/task/log-budget") {
        state.logBudget = Math.max(SESSION_LOG_BYTES_MIN, Math.min(SESSION_LOG_BYTES_MAX, Math.floor(command.bytes)));
        enforceLogBudget(state);
        state.publishRetention?.();
        return true;
      }
      if (command.type !== "lasercode/task/stop") return false;
      const task = state.tasks.get(command.id);
      if (!task) return false;
      stopTask(task, "person");
      return true;
    });

    return ({ reason }) => {
      // Whatever happens next, this runtime stops speaking: its `pi` is being
      // torn down, so no exit of ours can reach a model through it again.
      disposed = true;
      offCommand?.();
      // Only the person leaving ends a detached command. A fork, a new or
      // resumed session, or an extension reload replaces the runtime while the
      // work carries on: killing then would end a build or a dev server the
      // person never stopped, tell the fleet "the session ended" about a
      // command that is still running, and leave the successor session with
      // nothing to read. The task keeps publishing its own row and its log
      // file, so `task_output` still finds it through the worker (D-163).
      if (reason !== "quit") return;
      for (const task of state.tasks.values()) stopTask(task, "shutdown");
    };
  },
};
