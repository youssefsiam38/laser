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
 *   - `task_list`, `task_output`, `task_wait`, `task_stop` to follow tasks;
 *   - a `lasercode/task/update` for every task the person can see, carrying the
 *     log file it streams into so the host can serve `tasks/output`.
 *
 * Execution itself — shell resolution, `PI_*` environment, the process tree
 * kill on abort, output truncation for the model — stays the engine's. The
 * raw bytes are teed through a per-task `operations.exec` so the task record
 * keeps an exact byte count and the last 256 KiB without depending on the
 * engine's snapshot cadence.
 *
 * Exit notifications: a promoted task ends with `triggerTurn: true`, because
 * the model was told "keep working, you will hear back" and an idle model
 * must wake up to use the result. An explicit background task ends with
 * `triggerTurn: false`: the model asked for fire-and-forget, so the exit is
 * recorded and delivered with the next turn rather than starting one.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashOperations,
  type BashToolDetails,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  TASK_COMMAND_MAX,
  TASK_EVENT_MESSAGE_TYPE,
  TASK_LINE_MAX,
  WIRE_NAMESPACE,
  type BackgroundTaskUpdate,
} from "@lasercode/protocol";
import { Type } from "typebox";
import type { BackgroundWorkOptions } from "../agents-bridge.js";
import type { LaserModule, ModuleContext } from "./index.js";

/** Bytes of output kept in memory per task; the log file keeps everything. */
const TAIL_BYTES = 256 * 1024;
const DEFAULT_TAIL_LINES = 100;
const PROMOTED_TAIL_LINES = 40;
const TITLE_MAX = 80;
const WAIT_DEFAULT_SECONDS = 300;
const WAIT_MAX_SECONDS = 3600;
/** Minimum spacing between two task re-emits for output growth alone. */
const PUBLISH_THROTTLE_MS = 500;
/** How long `task_stop` waits for the killed process to be reaped. */
const STOP_GRACE_MS = 5000;

export type TaskStatus = "running" | "completed" | "failed" | "stopped";
type TaskMode = "foreground" | "promoted" | "background";
type StoppedBy = "agent" | "person" | "turn" | "shutdown";

type BashResult = AgentToolResult<BashToolDetails | undefined>;
type BashUpdate = AgentToolUpdateCallback<BashToolDetails | undefined>;
/** The engine's own details, or the task handle the override adds. */
export type BashOverrideDetails = BashToolDetails | { taskId: string; promoted: true } | { taskId: string; background: true } | undefined;

interface TaskRecord {
  id: string;
  command: string;
  status: TaskStatus;
  mode: TaskMode;
  exitCode: number | null | undefined;
  startedAt: string;
  endedAt?: string;
  bytes: number;
  tail: TailBuffer;
  logPath: string;
  stream: WriteStream | undefined;
  controller: AbortController;
  stoppedBy?: StoppedBy;
  /** The engine's own result or failure, returned unchanged on the foreground path. */
  result?: BashResult;
  failure?: unknown;
  error?: string;
  done: Promise<void>;
  /** Stops forwarding the engine's streamed updates to a tool call that has returned. */
  detach: () => void;
  publishTimer: NodeJS.Timeout | undefined;
  lastPublishAt: number;
}

interface State {
  tasks: Map<string, TaskRecord>;
  sessionId?: string;
  /** Set by activate; a task that ends before then has nobody to tell. */
  notify?: (task: TaskRecord) => void;
}

const states = new WeakMap<ModuleContext, State>();

/** Keeps the last `limit` bytes of everything appended. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
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
// The task record on the wire
// ---------------------------------------------------------------------------

/**
 * What the fleet renders. A foreground command that finished inside the limit
 * is not here on purpose: it already carried its result in its own tool row,
 * and a fleet row for every quick `ls` would bury the real work.
 */
export function taskUpdate(task: TaskRecord): BackgroundTaskUpdate {
  const activity = lastLines(task.tail.text(), 1).slice(0, TASK_LINE_MAX);
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
    ...(task.logPath ? { logPath: task.logPath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Running a task
// ---------------------------------------------------------------------------

interface StartInput {
  command: string;
  timeout: number | undefined;
  mode: TaskMode;
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

function startTask(ctx: ModuleContext, state: State, options: BackgroundWorkOptions, input: StartInput, publish: (task: TaskRecord) => void): TaskRecord {
  const id = newTaskId();
  const dir = join(tmpdir(), `${WIRE_NAMESPACE}-tasks`, sessionIdFor(state, input.toolCtx));
  const logPath = join(dir, `${id}.log`);
  const controller = new AbortController();
  let forwardUpdates = true;
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const task: TaskRecord = {
    id,
    command: input.command,
    status: "running",
    mode: input.mode,
    exitCode: undefined,
    startedAt: new Date().toISOString(),
    bytes: 0,
    tail: new TailBuffer(TAIL_BYTES),
    logPath,
    stream: undefined,
    controller,
    done: finished,
    detach: () => {
      forwardUpdates = false;
    },
    publishTimer: undefined,
    lastPublishAt: 0,
  };
  state.tasks.set(id, task);

  try {
    mkdirSync(dir, { recursive: true });
    const stream = createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => {
      task.stream = undefined;
    });
    task.stream = stream;
  } catch (error) {
    ctx.send({ type: "lasercode/module/log", module: "background-work", level: "warn", message: `task ${id} has no log file: ${describe(error)}` });
  }

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
  const operations: BashOperations = {
    exec: async (command, cwd, execOptions) => {
      const result = await local.exec(command, cwd, {
        ...execOptions,
        onData: (data) => {
          task.bytes += data.length;
          task.tail.append(data);
          task.stream?.write(data);
          execOptions.onData(data);
          schedulePublish();
        },
      });
      task.exitCode = result.exitCode;
      return result;
    },
  };
  const tool = createBashToolDefinition(options.cwd, {
    operations,
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    ...(options.commandPrefix ? { commandPrefix: options.commandPrefix } : {}),
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
    if (task.publishTimer) {
      clearTimeout(task.publishTimer);
      task.publishTimer = undefined;
    }
    task.stream?.end();
    task.stream = undefined;
    publish(task);
    // The rule: promoted → wake the model; explicit background → record only;
    // foreground → the tool call itself carried the result.
    if (task.mode !== "foreground") state.notify?.(task);
    settle();
  })();

  publish(task);
  return task;
}

function stopTask(task: TaskRecord, by: StoppedBy): void {
  if (task.status !== "running") return;
  task.stoppedBy = by;
  task.controller.abort();
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
  const tail = lastLines(task.tail.text(), PROMOTED_TAIL_LINES);
  return [
    `Background task ${task.id} (${firstLine(task.command)}) ${outcome}.`,
    tail ? `Last lines:\n${tail}` : "(no output)",
    `Use task_output ${task.id} for more.`,
  ].join("\n");
}

function promotedText(task: TaskRecord, seconds: number): string {
  const tail = lastLines(task.tail.text(), PROMOTED_TAIL_LINES);
  return [
    `Still running after ${formatSeconds(seconds)} s; it continues as background task ${task.id}. Output so far (last lines):`,
    tail || "(no output yet)",
    `Use task_output ${task.id} for more, task_wait to block until it exits, or task_stop to end it.`,
  ].join("\n");
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
    const state: State = { tasks: new Map() };
    states.set(ctx, state);
    const seconds = options.foregroundCommandSeconds;

    const publish = (task: TaskRecord): void => {
      // Only background work is fleet work (see `taskUpdate`).
      if (task.mode === "foreground") return;
      task.lastPublishAt = Date.now();
      ctx.send({ type: "lasercode/task/update", task: taskUpdate(task) });
    };

    const requireTask = (taskId: string): TaskRecord => {
      const task = state.tasks.get(taskId);
      if (!task) throw new Error(`No task ${taskId} in this session. task_list shows the tasks there are.`);
      return task;
    };

    // The engine's own definition supplies the description and prompt text;
    // its renderers are inherited by omission (extensions.md, "Overriding
    // Built-in Tools").
    const base = createBashToolDefinition(options.cwd, {
      ...(options.shellPath ? { shellPath: options.shellPath } : {}),
      ...(options.commandPrefix ? { commandPrefix: options.commandPrefix } : {}),
    });

    pi.registerTool({
      name: "bash",
      label: base.label,
      description: `${base.description} A foreground command still running after ${formatSeconds(seconds)} seconds keeps running as a background task; the tool then returns the output so far and a task id to follow it with.`,
      promptSnippet: `${base.promptSnippet ?? "Execute bash commands"}; long commands continue as background tasks`,
      promptGuidelines: [
        ...(base.promptGuidelines ?? []),
        "Use bash with background true for servers, watchers and anything you do not need to wait for; follow it with task_output, task_wait or task_stop.",
        `A bash command still running after ${formatSeconds(seconds)} s becomes a background task by itself; when the result says so, keep working and call task_wait with its task id when you need the outcome.`,
      ],
      parameters: Type.Object({
        command: Type.String({ description: "The command to run." }),
        timeout: Type.Optional(Type.Number({ description: "Kill the command after this many seconds (optional, no default)." })),
        background: Type.Optional(
          Type.Boolean({ description: "Run in the background and return a task id immediately; use task_output, task_wait and task_stop to follow it." }),
        ),
      }),
      async execute(toolCallId, { command, timeout, background }, signal, onUpdate, toolCtx): Promise<AgentToolResult<BashOverrideDetails>> {
        if (background === true) {
          const task = startTask(ctx, state, options, { command, timeout, mode: "background", toolCallId, toolCtx, onUpdate: undefined }, publish);
          return {
            content: text(
              `Started background task ${task.id}: ${firstLine(command)}. Use task_output ${task.id} to read its output, task_wait to block until it exits, or task_stop to end it. Its exit is reported as a message.`,
            ),
            details: { taskId: task.id, background: true },
          };
        }

        const task = startTask(ctx, state, options, { command, timeout, mode: "foreground", toolCallId, toolCtx, onUpdate }, publish);
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
          if (task.failure !== undefined) throw task.failure;
          return task.result!;
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
      name: "task_list",
      label: "List background tasks",
      description: "List this session's background tasks: id, command, status, exit code, timing and output size.",
      promptSnippet: "List background tasks and their status",
      promptGuidelines: ["Use task_list to recall task ids; use task_wait rather than polling task_list."],
      parameters: Type.Object({}),
      async execute() {
        const tasks = [...state.tasks.values()].map(summary);
        return { content: text(JSON.stringify({ tasks }, null, 2)), details: { tasks } };
      },
    });

    pi.registerTool({
      name: "task_output",
      label: "Read task output",
      description: `Return the last lines of a background task's output (default ${DEFAULT_TAIL_LINES}), with its status.`,
      promptSnippet: "Read the latest output of a background task",
      promptGuidelines: ["Use task_output with a task id to read what a background task printed; pass tail for more lines."],
      parameters: Type.Object({
        taskId: Type.String({ minLength: 1, description: "The task id." }),
        tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: `Lines from the end to return (default ${DEFAULT_TAIL_LINES}).` })),
      }),
      async execute(_toolCallId, { taskId, tail }) {
        const task = requireTask(taskId);
        const lines = lastLines(task.tail.text(), tail ?? DEFAULT_TAIL_LINES);
        const header = `task ${task.id} ${task.status}${typeof task.exitCode === "number" ? ` (exit code ${task.exitCode})` : ""} · ${task.bytes} bytes of output`;
        return {
          content: text(`${header}\n${lines || "(no output)"}`),
          details: { ...summary(task), lines: lines ? lines.split("\n").length : 0 },
        };
      },
    });

    pi.registerTool({
      name: "task_wait",
      label: "Wait for tasks",
      description: `Block until the given background tasks (or all running ones) exit, or the timeout passes (default ${WAIT_DEFAULT_SECONDS} s, at most ${WAIT_MAX_SECONDS}). Returns each task's status and whether the wait timed out.`,
      promptSnippet: "Wait for background tasks to exit",
      promptGuidelines: ["Use task_wait when you need a background task's outcome before continuing; it returns each task's status and exit code."],
      parameters: Type.Object({
        taskIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100, description: "Task ids to wait for; omit for every running task." })),
        timeoutSeconds: Type.Optional(
          Type.Number({ minimum: 1, maximum: WAIT_MAX_SECONDS, description: `Seconds before returning with timedOut true (default ${WAIT_DEFAULT_SECONDS}).` }),
        ),
      }),
      async execute(_toolCallId, { taskIds, timeoutSeconds }, signal) {
        const tasks = taskIds ? taskIds.map(requireTask) : [...state.tasks.values()].filter((t) => t.status === "running");
        const limit = Math.min(WAIT_MAX_SECONDS, Math.max(0, timeoutSeconds ?? WAIT_DEFAULT_SECONDS)) * 1000;
        let timer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;
        const outcome = await Promise.race([
          Promise.all(tasks.map((t) => t.done)).then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), limit);
          }),
          new Promise<"aborted">((resolve) => {
            onAbort = () => resolve("aborted");
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        if (outcome === "aborted") throw new Error("task_wait was cancelled; the tasks keep running.");
        const result = { tasks: tasks.map((t) => ({ taskId: t.id, status: t.status, exitCode: t.exitCode ?? null })), timedOut: outcome === "timeout" };
        return { content: text(JSON.stringify(result, null, 2)), details: result };
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
          // Promoted: the model was told to carry on and will hear back, so an
          // idle model is woken. Explicit background: fire-and-forget by the
          // model's own choice; the exit waits for the next turn.
          { deliverAs: "steer", triggerTurn: task.mode === "promoted" },
        );
      } catch (error) {
        ctx.send({ type: "lasercode/module/log", module: "background-work", level: "warn", message: `could not report task ${task.id}: ${describe(error)}` });
      }
    };

    // A person presses Stop in the fleet: `tasks/stop` reaches the worker,
    // which sends the command here. A task this session does not own is not
    // ours to answer, so the worker learns it was not delivered.
    const offCommand = ctx.commands?.on((command) => {
      if (command.type !== "lasercode/task/stop") return false;
      const task = state.tasks.get(command.id);
      if (!task) return false;
      stopTask(task, "person");
      return true;
    });

    return () => {
      disposed = true;
      offCommand?.();
      for (const task of state.tasks.values()) stopTask(task, "shutdown");
    };
  },
};
