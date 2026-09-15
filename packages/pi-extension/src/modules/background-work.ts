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
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
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
import { LOG_DIR_MODE, TaskLog } from "./task-log.js";
import {
  PROMOTED_TAIL_LINES,
  STOP_REASONS,
  exitText,
  firstLine,
  followGuidance,
  formatSeconds,
  lastLines,
  promotedText,
  quietGuidance,
  text,
  type StoppedBy,
} from "./task-messages.js";
import { SessionRetention, TASK_EXCERPT_BYTES, logRootFor, logSalt, type RetainedTask } from "./task-retention.js";

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
/** Minimum spacing between two task re-emits for output growth alone. */
const PUBLISH_THROTTLE_MS = 500;
/** How long `task_stop` waits for the killed process to be reaped. */
const STOP_GRACE_MS = 5000;

/** How much a command may write between two checks of what its session holds. */
const BUDGET_CHECK_BYTES = 1024 * 1024;

export type TaskStatus = "running" | "completed" | "failed" | "stopped";
type TaskMode = "foreground" | "promoted" | "background";

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
  /** The bounds, the totals and the one way room is made (`task-retention.ts`). */
  retention: SessionRetention;
}

const states = new WeakMap<ModuleContext, State>();

export { lastLines } from "./task-messages.js";

/**
 * What one session's commands are holding right now, read from its module
 * context rather than from the publishing cadence: an assertion about a
 * ceiling needs the value at an instant, not the value at the last publish.
 */
export function backgroundWorkRetention(ctx: ModuleContext): BackgroundTaskRetention | undefined {
  return states.get(ctx)?.retention.snapshot();
}

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
  /** Keep only the last `limit` bytes. Used by the session's tail ceiling. */
  shrink(limit: number): void {
    if (this.size <= limit) return;
    const kept = Buffer.concat(this.chunks).subarray(this.size - limit);
    this.chunks = [kept];
    this.size = kept.length;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function newTaskId(): string {
  return `t-${randomBytes(4).toString("hex")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  state.retention.markTerminal(task.id);
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
    // The *base* path of the window: its segments are `<base>.<from>.log`, and
    // each one's name says where it starts, so a reader takes its offsets from
    // the files rather than from this record (RP-6).
    ...(task.log.usable ? { logPath: task.log.path, logSegments: task.log.segmentOffsets } : {}),
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

/**
 * Where this worker's command logs live.
 *
 * The worker hands down a private directory (the host made it, inside its own
 * state). Without one — a test, a standalone run — this makes its own, with
 * `mkdtemp` so the name is unpredictable and `0700` so nobody else can read
 * it. A shared, guessable directory under the system temp is not somewhere to
 * put a person's command output.
 */
function logRoot(options: BackgroundWorkOptions): string {
  return logRootFor(
    options.logRoot === undefined ? undefined : ensureDirectory(options.logRoot),
    () => {
      const made = mkdtempSync(join(tmpdir(), `${WIRE_NAMESPACE}-tasks-`), { encoding: "utf8" });
      chmodSync(made, LOG_DIR_MODE);
      return made;
    },
  );
}

/** The configured root, made private if it does not exist yet. */
function ensureDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: LOG_DIR_MODE });
  return path;
}

/**
 * The directory name for one session: an opaque, bounded id salted per
 * process. A session's own id is a durable identifier of a person's
 * conversation and has no business being a directory name on a shared
 * filesystem.
 */
function logDirOf(sessionId: string): string {
  return createHash("sha256").update(logSalt(() => randomBytes(16))).update(sessionId).digest("hex").slice(0, 32);
}

function startTask(ctx: ModuleContext, state: State, options: BackgroundWorkOptions, input: StartInput, publish: (task: TaskRecord) => void): TaskRecord {
  const id = newTaskId();
  const dir = join(logRoot(options), logDirOf(sessionIdFor(state, input.toolCtx)));
  const controller = new AbortController();
  let forwardUpdates = true;
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  let loggedLogFailure = false;
  // Declared before the log, because a log that cannot even be opened reports
  // it from its own constructor: a callback that read a `const` declared below
  // would throw out of it, and a command must never fail because its output
  // could not be written.
  let task: TaskRecord | undefined;
  const log: TaskLog = new TaskLog({
    dir,
    id,
    ...(options.logWrite ? { write: options.logWrite } : {}),
    // The session's ceiling, asked before anything is kept (RP-6).
    admit: (bytes) => state.retention.admit(log, bytes),
    // Accounting moves on every write; the window itself moves on a rotation
    // or a release, and that is published at once rather than on the next
    // throttle tick, so a reader never uses offsets a moment out of date.
    onChange: (reason) => {
      if (!task) return;
      state.retention.note(id);
      if (reason === "window" && state.tasks.get(id) === task) publish(task);
    },
    onError: (error) => {
      if (loggedLogFailure) return;
      loggedLogFailure = true;
      ctx.send({ type: "lasercode/module/log", module: "background-work", level: "warn", message: `task ${id} has no log file: ${describe(error)}` });
    },
  });

  task = {
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

  let sinceCheck = 0;
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
          ctx.send({ type: "lasercode/process/registration", pid, taskId: task.id });
        },
        onData: (data) => {
          task.bytes += data.length;
          task.tail?.append(data);
          task.log.append(data);
          // The budget is checked per megabyte written, not per chunk: a
          // command printing in 8 KiB pieces must not pay for a walk of every
          // log this session owns on each one.
          // The session's disk ceiling was decided before the bytes were kept
          // (`TaskLog.append` asks `retention.admit`), so nothing is enforced
          // here. What is left is the memory of live tails, and publishing
          // what is held, both on a bounded cadence rather than per chunk.
          state.retention.note(task.id);
          sinceCheck += data.length;
          if (sinceCheck >= BUDGET_CHECK_BYTES) {
            sinceCheck = 0;
            state.retention.enforceLiveTailBudget();
            state.publishRetention?.();
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
  state.retention.track(retained(task));
  state.publishRetention?.();
  return task;
}

/** What the retention policy needs of a command: bytes, and how to give them back. */
function retained(task: TaskRecord): RetainedTask {
  return {
    id: task.id,
    startedAtMs: Date.parse(task.startedAt),
    get endedAtMs() {
      return task.endedAtMs;
    },
    log: task.log,
    tailBytes: () => task.tail?.bytes ?? 0,
    shrinkTail: (limit) => {
      const before = task.tail?.bytes ?? 0;
      task.tail?.shrink(limit);
      return before - (task.tail?.bytes ?? 0);
    },
    releaseTail: () => {
      const before = task.tail?.bytes ?? 0;
      if (task.tail) task.excerpt = tailBytesOf(task.tail.text(), TASK_EXCERPT_BYTES);
      task.tail = undefined;
      return before;
    },
    excerptBytes: () => Buffer.byteLength(task.excerpt ?? "", "utf8"),
  };
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
    const state: State = {
      tasks: new Map(),
      retention: new SessionRetention({
        forget: (id) => state.tasks.delete(id),
        onChange: () => state.publishRetention?.(),
      }),
    };
    states.set(ctx, state);
    const seconds = options.foregroundCommandSeconds;

    // No sweep here, on purpose (`task-retention.ts`): every worker of a host
    // shares one root, and a quiet command's directory is indistinguishable
    // from a crashed run's. Crash cleanup is the host's, at start, before any
    // worker exists to be writing.

    let lastRetention = "";
    state.publishRetention = () => {
      const retention = state.retention.snapshot();
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
          content: text(promotedText(task, seconds, heldText(task))),
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
          { customType: TASK_EVENT_MESSAGE_TYPE, content: exitText(task, heldText(task)), display: true, details: summary(task) },
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
        // Zero is a legitimate share: a worker with many busy sessions can
        // ask one to keep nothing, and that session's commands carry on with
        // their size and digest exact and their bodies released.
        state.retention.setBudget(command.bytes);
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
