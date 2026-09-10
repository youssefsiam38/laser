/**
 * AgentHarness — one per worker process; runs agents as persistent child
 * sessions (docs/agents-leap/references/agent-harness-architecture.md).
 *
 * The harness owns runs, child sessions, worktrees and parent
 * notification. The companion extension's `subagents` module owns only what
 * must live inside the engine: the model-facing tools and delivering events
 * to the parent model at a safe boundary. They meet on `AgentHarnessBridge`,
 * one per session, built here and handed to the driver when the session opens.
 *
 * Everything the harness needs from the rest of the worker is behind
 * `SessionHost`, so the lifecycle is testable with a fake host and fake
 * drivers. Nothing here imports the engine.
 *
 * Rules, in the reference's words:
 *   - `start_agent` never waits; it returns the four identities immediately,
 *     and nothing waits afterwards either: a child's ending is delivered to
 *     its parent, and `inspect_agent` reads one child in depth meanwhile.
 *   - a successful run ends only through `complete_agent_run`; crashes,
 *     cancellations and timeouts are recorded by the harness, never chosen by
 *     the model;
 *   - a child that raises a question and is paused on it is `needs_input`,
 *     never `running`: the parent can tell "working" from "stuck waiting on
 *     me" from the status alone, reads the question, and may answer it
 *     through `send_agent_message`.
 *   - a child gets its own worktree unless its parent said otherwise
 *     (`start_agent { worktree: false }`, for a child that only reads), in
 *     which case it works in the parent's checkout and is told so; nesting
 *     limits, model access and worktree ownership are enforced here, not by
 *     prompt.
 */
import { randomBytes } from "node:crypto";
import {
  AGENT_INSPECT_MESSAGES_DEFAULT,
  AGENT_INSPECT_MESSAGES_MAX,
  AGENT_MESSAGE_MAX,
  AGENT_TASK_EXCERPT,
  AGENT_TASK_MAX,
  SESSION_RUN_ENTRY_TYPE,
  SUBAGENT_NAME_MAX,
  isTerminalRunStatus,
  type AgentDefinition,
  type AgentEvent,
  type AgentModelChoice,
  type AgentRun,
  type AgentRunInitiator,
  type AgentRunQuestion,
  type AgentRunStatus,
  type AgentRunTerminalStatus,
  type ContentBlock,
  type HostNotifications,
  type SessionAgentInfo,
  type SessionAgentRecord,
  type SessionState,
  type UiDialogRequest,
  type UiDialogResponse,
} from "@lasercode/protocol";
import type {
  DriverAgentOptions,
  DriverEvent,
  ExtensionModelAdmission,
  ExtensionModelExecution,
  ExtensionModelWorkRequest,
  PromptOptions,
  SessionDriver,
} from "../driver.js";
import type {
  AgentCatalogEntry,
  AgentHarnessBridge,
  AgentModelEvent,
  AgentRunSummary,
  BackgroundWorkOptions,
  CompleteRunInput,
  CompleteRunResult,
  HarnessSessionRole,
  InspectAgentInput,
  InspectAgentResult,
  InspectFleetResult,
  InspectedMessage,
  ReadTaskOutputResult,
  SendAgentMessageInput,
  SendAgentMessageResult,
  RemoveAgentWorktreeInput,
  RemoveAgentWorktreeResult,
  StartAgentInput,
  StartAgentResult,
  StopAgentInput,
} from "./bridge.js";
import { DefinitionsCache, isStartable } from "./definitions.js";
import { HarnessError } from "./errors.js";
import { buildFleetTree } from "./fleet.js";
import { assistantMessagesOf, readSessionEntries } from "./inspect.js";
import { readLogTail, type IndexedTask } from "./tasks.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import type { CreateWorktreeInput, Worktree, WorktreeFacts } from "./worktrees.js";

/** What the harness needs from `WorktreeManager`; an interface so lifecycle tests run without git. */
export interface WorktreeProvider {
  create(input: CreateWorktreeInput): Promise<Worktree>;
  remove(root: string, path: string, branch?: string): Promise<void>;
  ownedBy(runId: string): Worktree | undefined;
  /** The git toplevel of a project, for a worktree this process did not create. */
  rootOf(projectCwd: string): Promise<string | undefined>;
  /** What the worktree still holds, measured against the parent's checkout. */
  facts(input: { path: string; branch: string; compareCwd: string }): Promise<WorktreeFacts>;
}

/** What a child is told when it stops without its final tool. */
export const NUDGE_TEXT = "You stopped without calling complete_agent_run. Call complete_agent_run now with status completed or blocked and your final message.";
const ENDED_WITHOUT_TOOL = "Ended without complete_agent_run";
const RESULT_EXCERPT = 2000;
const QUESTION_SUMMARY_EXCERPT = 80;
const ROLE_TASK_EXCERPT = 2000;
const PENDING_EVENTS_MAX = 50;

/** What the harness needs from the worker around it. */
export interface SessionHost {
  /** Open a new child session with these agent options; resolves with its state once attached. */
  openChild(options: { cwd: string; parentSessionPath: string; agent: DriverAgentOptions }): Promise<SessionState>;
  /** The live driver serving a session path, when it is open in this worker. */
  driver(sessionPath: string): SessionDriver | undefined;
  notify<M extends keyof HostNotifications>(method: M, params: HostNotifications[M]): void;
  /** True when the model exists and its provider has credentials. */
  modelAvailable(model: AgentModelChoice): Promise<boolean>;
  /**
   * The background commands one session published, oldest first, from the
   * worker's task index (D-163). Absent when the worker keeps none: the fleet
   * then shows agents alone, and a child's command cannot be read.
   */
  tasks?(sessionPath: string): IndexedTask[];
}

export interface AgentHarnessOptions {
  host: SessionHost;
  definitions: DefinitionsCache;
  worktrees: WorktreeProvider;
  /** Background-work options for a session running in `cwd`; passed to every child. */
  backgroundWork?: (cwd: string) => BackgroundWorkOptions;
  now?: () => number;
}

/** A session the harness knows, prepared before its path exists and attached once it does. */
export interface SessionHandle {
  readonly bridge: AgentHarnessBridge;
  readonly role: HarnessSessionRole;
  readonly definition: AgentDefinition;
  readonly record: SessionAgentRecord;
  /** Called by whoever opened the session, the moment its path and id are known. */
  attach(sessionPath: string, sessionId: string): void;
  /** Called when the open failed and the session never existed. */
  discard(): void;
  /**
   * The `background-work` options for this session running in `cwd`: the
   * worker's shell settings plus the read of a command elsewhere in this
   * session's tree (`task_output` on a child's command, D-163). `undefined`
   * when the harness was built without background work.
   */
  backgroundWork(cwd: string): BackgroundWorkOptions | undefined;
}

export interface PrepareSessionInput {
  role: HarnessSessionRole;
  definition: AgentDefinition;
  record: SessionAgentRecord;
  /** The project this session belongs to: the git toplevel is resolved from it for worktrees. */
  projectCwd: string;
}

interface Entry {
  path: string | undefined;
  sessionId: string | undefined;
  role: HarnessSessionRole;
  definition: AgentDefinition;
  record: SessionAgentRecord;
  projectCwd: string;
  bridge: AgentHarnessBridge;
  eventListeners: Set<(event: AgentModelEvent) => void>;
  roleListeners: Set<(role: HarnessSessionRole) => void>;
  /** Events for this session's model that arrived before its module registered a listener. */
  pendingEvents: AgentModelEvent[];
  /** One explicit owner/fence and one ordered successor inbox per child session. */
  lifecycle: SessionLifecycle<RunEnd, PendingMessage>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingExtensionWork {
  request: ExtensionModelWorkRequest;
  start: (
    ownerRunId?: string,
    onInvocation?: Parameters<ExtensionModelWorkRequest["start"]>[1],
  ) => ExtensionModelExecution | Promise<ExtensionModelExecution>;
  admission: Deferred<void>;
  completion: Deferred<void>;
  /** Exact parent ownership; successors bind when they become standalone. */
  bindToRun: boolean;
}

interface PendingMessage {
  content: ContentBlock[];
  options?: PromptOptions;
  origin: "agent" | "user";
  /** Interrupts are also queued in the engine; local messages wait only here. */
  engine: boolean;
  resolve?: (result: { accepted: boolean; queued: boolean }) => void;
  reject?: (error: unknown) => void;
  extension?: PendingExtensionWork;
}

interface RunEnd {
  status: AgentRunTerminalStatus;
  outcome: { result?: { status: "completed" | "blocked"; message: string }; error?: string; endedBy?: { initiator: AgentRunInitiator; reason?: string }; context?: string };
}

interface RunState {
  run: AgentRun;
  /** The whole task; the run record carries only its excerpt. */
  task: string;
  nudged: boolean;
  /** `complete_agent_run` was called for this run. */
  completedByTool: boolean;
  lastAssistant: { text?: string; error?: string } | undefined;
}

const MODEL_EVENT_TYPE: Record<AgentRunTerminalStatus, AgentModelEvent["type"]> = {
  completed: "agent.completed",
  blocked: "agent.blocked",
  failed: "agent.failed",
  cancelled: "agent.cancelled",
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function labelOf(role: Pick<HarnessSessionRole, "agentName" | "subagentName">): string {
  return role.subagentName ?? role.agentName;
}

export function modelUnavailableMessage(model: AgentModelChoice): string {
  return `The model ${model.provider}/${model.id} is not available: connect ${model.provider} in Settings → Providers and models, or choose another model for this agent.`;
}

export class AgentHarness {
  private readonly host: SessionHost;
  private readonly definitions: DefinitionsCache;
  private readonly worktrees: WorktreeProvider;
  private readonly backgroundWork: ((cwd: string) => BackgroundWorkOptions) | undefined;
  private readonly now: () => number;
  private readonly byPath = new Map<string, Entry>();
  private readonly runStates = new Map<string, RunState>();
  /** Run ids in creation order, so "newest first" is deterministic. */
  private readonly runOrder: string[] = [];

  constructor(options: AgentHarnessOptions) {
    this.host = options.host;
    this.definitions = options.definitions;
    this.worktrees = options.worktrees;
    this.backgroundWork = options.backgroundWork;
    this.now = options.now ?? Date.now;
    // A definitions change is announced to every live bridge as a role
    // change, so `start_agent` catalogs are re-read.
    this.definitions.onChange(() => {
      for (const entry of this.byPath.values()) {
        const fresh = this.definitions.definition(entry.definition.name);
        if (fresh) entry.definition = fresh;
        this.announceRole(entry);
      }
    });
  }

  // ------------------------------------------------------------- sessions

  /** Build the bridge for a session about to open; attach it once the path is known. */
  prepareSession(input: PrepareSessionInput): SessionHandle {
    const entry: Entry = {
      path: undefined,
      sessionId: undefined,
      role: input.role,
      definition: input.definition,
      record: input.record,
      projectCwd: input.projectCwd,
      bridge: undefined as unknown as AgentHarnessBridge,
      eventListeners: new Set(),
      roleListeners: new Set(),
      pendingEvents: [],
      lifecycle: new SessionLifecycle<RunEnd, PendingMessage>(),
    };
    entry.bridge = this.bridgeFor(entry);
    return {
      bridge: entry.bridge,
      role: entry.role,
      definition: entry.definition,
      record: entry.record,
      attach: (sessionPath, sessionId) => {
        entry.path = sessionPath;
        entry.sessionId = sessionId;
        this.byPath.set(sessionPath, entry);
      },
      discard: () => {
        if (entry.path) this.byPath.delete(entry.path);
        entry.eventListeners.clear();
        entry.roleListeners.clear();
      },
      backgroundWork: (cwd) => this.backgroundWorkFor(entry, cwd),
    };
  }

  /** The shell options plus, bound to this session, the read of a command in its tree. */
  private backgroundWorkFor(entry: Entry, cwd: string): BackgroundWorkOptions | undefined {
    if (!this.backgroundWork) return undefined;
    return { ...this.backgroundWork(cwd), readTask: (taskId, tailLines) => this.readTask(entry, taskId, tailLines) };
  }

  /** The bridge for an attached session, for tests and for the server's own use. */
  bridgeOf(sessionPath: string): AgentHarnessBridge | undefined {
    return this.byPath.get(sessionPath)?.bridge;
  }

  roleOf(sessionPath: string): HarnessSessionRole | undefined {
    return this.byPath.get(sessionPath)?.role;
  }

  /** `SessionState.agent` for a session this harness knows. */
  sessionInfo(sessionPath: string): SessionAgentInfo | undefined {
    const entry = this.byPath.get(sessionPath);
    if (!entry) return undefined;
    const latest = this.latestRun(sessionPath);
    return {
      agentName: entry.role.agentName,
      kind: entry.role.kind,
      ...(entry.role.subagentName !== undefined ? { subagentName: entry.role.subagentName } : {}),
      ...(entry.record.parentPath !== undefined ? { parentPath: entry.record.parentPath } : {}),
      ...(entry.record.rootPath !== undefined ? { rootPath: entry.record.rootPath } : {}),
      ...(latest ? { runId: latest.run.runId, runStatus: latest.run.status } : {}),
    };
  }

  /** A fork moved the session to a new file; follow it. Runs keep the path they were recorded under. */
  rekeySession(oldPath: string, newPath: string): void {
    const entry = this.byPath.get(oldPath);
    if (!entry || oldPath === newPath) return;
    this.byPath.delete(oldPath);
    entry.path = newPath;
    this.byPath.set(newPath, entry);
  }

  /** The session's driver closed: an active run is a failure, and the bridge is forgotten. */
  detachSession(sessionPath: string): void {
    const entry = this.byPath.get(sessionPath);
    if (!entry) return;
    for (const state of this.runStates.values()) {
      if (state.run.sessionPath === sessionPath && !isTerminalRunStatus(state.run.status)) {
        this.endRun(state, "failed", { error: "The agent's session closed before it finished." });
      }
    }
    this.byPath.delete(sessionPath);
    entry.eventListeners.clear();
    entry.roleListeners.clear();
  }

  // ----------------------------------------------------------------- runs

  runs(): AgentRun[] {
    return this.runOrder.map((id) => this.runStates.get(id)!.run);
  }

  run(runId: string): AgentRun | undefined {
    return this.runStates.get(runId)?.run;
  }

  /** The run currently executing in a session, if any. */
  activeRun(sessionPath: string): AgentRun | undefined {
    return this.activeRunState(sessionPath)?.run;
  }

  /**
   * A person prompted a child session that has no active run: give the
   * prompt a run of its own so lifecycle, the map and the parent's summary
   * keep working. Returns undefined for sessions that are not children.
   */
  startUserRun(sessionPath: string, text: string): AgentRun | undefined {
    const entry = this.byPath.get(sessionPath);
    if (!entry || entry.role.kind !== "child" || !entry.path || !entry.sessionId) return undefined;
    if (this.activeRunState(sessionPath)) return undefined;
    const state = this.createRun(entry, { origin: "user", task: text });
    const parentLabel = entry.role.parent ? labelOf(entry.role.parent) : "the person";
    void parentLabel;
    this.event({ kind: "started", sessionPath: entry.path, runId: state.run.runId, summary: "The person started a run from this chat" });
    return state.run;
  }

  /**
   * Route a person's child prompt through the same owner/fence as harness
   * prompts. Root sessions deliberately keep the driver's direct behavior.
   * Server integration replaces its startUserRun + driver.prompt pair with
   * this method so ownership exists before driver preflight or emitted events.
   */
  async promptUser(
    sessionPath: string,
    content: ContentBlock[],
    options?: PromptOptions,
  ): Promise<{ accepted: boolean; queued: boolean }> {
    const entry = this.byPath.get(sessionPath);
    const driver = this.host.driver(sessionPath);
    if (!driver) return { accepted: false, queued: false };
    if (!entry || entry.role.kind !== "child" || !entry.path || !entry.sessionId) return driver.prompt(content, options);

    let resolveDeferred!: (result: { accepted: boolean; queued: boolean }) => void;
    let rejectDeferred!: (error: unknown) => void;
    const deferred = new Promise<{ accepted: boolean; queued: boolean }>((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });
    const message: PendingMessage = {
      content,
      ...(options ? { options } : {}),
      origin: "user",
      engine: true,
      resolve: resolveDeferred,
      reject: rejectDeferred,
    };
    const plan = await this.withEntry(entry, () => {
      const owner = entry.lifecycle.owner();
      const executing = owner ? this.runStates.get(owner) : undefined;
      if ((executing && entry.lifecycle.end(executing.run.runId)) || entry.lifecycle.successor()) {
        this.queueRunMessage(entry, { ...message, engine: false }, executing ?? this.activeRunState(sessionPath));
        return { kind: "deferred" as const };
      }
      const active = executing ?? this.activeRunState(sessionPath);
      const state = active ?? this.createRun(entry, { origin: "user", task: contentTask(content) });
      const admission = entry.lifecycle.admitPrompt(
        state.run.runId,
        { local: { ...message, engine: false }, engine: message },
        { streaming: driver.state().isStreaming, explicitQueue: options?.streamingBehavior !== undefined },
      );
      if (!active) this.event({ kind: "started", sessionPath, runId: state.run.runId, summary: "The person started a run from this chat" });
      if (admission === "local-queue") return { kind: "deferred" as const };
      return { kind: admission, state };
    });
    if (plan.kind === "deferred") return deferred;
    if (plan.kind === "invoke") return this.invoke(entry, plan.state, driver, content, options);
    if (plan.kind === "bare-concurrent") return driver.prompt(content, options);

    try {
      const result = await driver.prompt(content, options);
      if (!result.accepted) {
        await this.withEntry(entry, () => entry.lifecycle.remove(plan.state.run.runId, message));
      } else {
        // A cleared engine queue may replay this content under a successor,
        // but acceptance of this exact submission is monotonic and fires once.
        delete message.resolve;
        delete message.reject;
        if (message.options?.onAccepted) {
          const { onAccepted: _accepted, ...remaining } = message.options;
          void _accepted;
          message.options = remaining;
        }
      }
      return result;
    } catch (error) {
      await this.withEntry(entry, () => entry.lifecycle.remove(plan.state.run.runId, message));
      throw error;
    }
  }

  /**
   * Own an extension-generated model entry before its native preflight. The
   * returned admission promise is for the extension; completion stays with
   * the current invocation/run.
   */
  admitExtensionModelWork(
    sessionPath: string,
    request: ExtensionModelWorkRequest,
    start: (
      ownerRunId?: string,
      onInvocation?: Parameters<ExtensionModelWorkRequest["start"]>[1],
    ) => ExtensionModelExecution | Promise<ExtensionModelExecution>,
  ): ExtensionModelAdmission {
    const admission = deferred<void>();
    const completion = deferred<void>();
    void admission.promise.catch(() => undefined);
    void completion.promise.catch(() => undefined);
    const entry = this.byPath.get(sessionPath);
    if (!entry || entry.role.kind !== "child" || !entry.path || !entry.sessionId) {
      this.executeRootExtension(start, request, admission, completion);
      return { admission: admission.promise, completion: completion.promise, joinsParent: request.parent !== undefined };
    }

    const owner = entry.lifecycle.owner();
    const executing = owner ? this.runStates.get(owner) : undefined;
    const causal = request.parent !== undefined && entry.lifecycle.ownsInvocation(request.parent);
    const origin = request.parent?.runId !== undefined && !causal ? "agent" as const : request.origin;
    const effectiveRequest: ExtensionModelWorkRequest = {
      ...request,
      origin,
      parentStarted: causal && request.parentStarted === true,
    };
    const phase = entry.lifecycle.phase();
    const mustSucceed = Boolean(
      entry.lifecycle.successor()
      || (executing && (entry.lifecycle.end(executing.run.runId) || phase.kind === "terminal-pending" || (phase.kind === "invoking" && phase.settled))),
    );
    const pending: PendingExtensionWork = { request: effectiveRequest, start, admission, completion, bindToRun: causal };
    const joinsParent = causal && !mustSucceed;
    if (mustSucceed) {
      this.queueRunMessage(entry, {
        content: request.content,
        origin,
        engine: false,
        extension: pending,
      }, executing ?? this.activeRunState(sessionPath));
      return { admission: admission.promise, completion: completion.promise, joinsParent: false };
    }

    const active = executing ?? this.activeRunState(sessionPath);
    const state = active ?? this.createRun(entry, { origin, task: request.task });
    if (!active) {
      this.event({
        kind: "started",
        sessionPath,
        runId: state.run.runId,
        summary: origin === "user" ? "The person started a run from this chat" : "Extension work started this run",
      });
    }
    const standalone = entry.lifecycle.owner() === undefined;
    if (standalone && !entry.lifecycle.begin(state.run.runId)) {
      this.queueRunMessage(entry, {
        content: request.content,
        origin,
        engine: false,
        extension: pending,
      }, state);
      return { admission: admission.promise, completion: completion.promise, joinsParent: false };
    }
    this.executeExtension(entry, state, pending, standalone);
    return { admission: admission.promise, completion: completion.promise, joinsParent };
  }

  /** A person ends a run (`agents/runs/stop`, from the fleet or a row menu). */
  async stopRun(runId: string, endedBy: { initiator: AgentRunInitiator; reason?: string }): Promise<AgentRun> {
    const state = this.runStates.get(runId);
    if (!state) throw new HarnessError(`No run is called ${runId}.`);
    if (isTerminalRunStatus(state.run.status)) return state.run;
    const entry = this.byPath.get(state.run.sessionPath);
    if (!entry) {
      this.endRun(state, "cancelled", { endedBy });
      return state.run;
    }
    let abort = false;
    let wait: Promise<void> | undefined;
    await this.withEntry(entry, () => {
      if (isTerminalRunStatus(state.run.status)) return;
      this.event({ kind: "stop_requested", sessionPath: state.run.sessionPath, runId, summary: endedBy.initiator === "user" ? "The person asked this run to stop" : "The parent asked this run to stop" });
      if (entry.lifecycle.cancelSuccessor(runId)) {
        this.endRun(state, "cancelled", { endedBy });
        return;
      }
      const owner = entry.lifecycle.owner();
      if (owner === runId) {
        // First terminal declaration wins: a stop cannot replace an accepted
        // complete_agent_run result while that tool's turn unwinds.
        if (!entry.lifecycle.end(runId)) {
          entry.lifecycle.declareEnd(runId, { status: "cancelled", outcome: { endedBy } });
          abort = true;
        }
        wait = entry.lifecycle.waitForTerminal(runId);
      } else {
        this.endRun(state, "cancelled", { endedBy });
        abort = true;
      }
    });
    if (abort) this.scheduleAbort(this.host.driver(state.run.sessionPath));
    await wait;
    return state.run;
  }

  /**
   * Best effort: remove a deleted child session's worktree. A child that ran
   * in its parent's checkout has none, and nothing there is ever removed or
   * cleaned — the early return is the whole guard.
   */
  async removeWorktreeFor(sessionPath: string): Promise<void> {
    const entry = this.byPath.get(sessionPath);
    const record = entry?.record ?? this.runs().find((run) => run.sessionPath === sessionPath);
    const worktree = record?.worktree;
    if (!worktree) return;
    const owned = this.runs().find((run) => run.worktree?.path === worktree.path);
    const root = owned ? this.worktrees.ownedBy(owned.runId)?.root : undefined;
    if (!root) return;
    await this.worktrees.remove(root, worktree.path, worktree.branch).catch(() => undefined);
  }

  /** Every driver event of every session flows through here; unknown paths are ignored. */
  onDriverEvent(sessionPath: string, event: DriverEvent): void {
    const entry = this.byPath.get(sessionPath);
    if (!entry) return;
    if (event.type === "closed") {
      this.detachSession(sessionPath);
      return;
    }
    // Stable events carry their exact native epoch. A late callback from an
    // older invocation may share this session with a live successor, but it
    // must never mutate that successor. Drivers without epochs retain the
    // established run-scoped behavior.
    if (event.type === "update" && event.invocation && !entry.lifecycle.ownsInvocation(event.invocation)) return;
    if (
      event.type === "update"
      && event.update.kind === "extension_error"
      && !event.invocation
      && this.host.driver(sessionPath)?.setExtensionModelWorkHandler
    ) return;
    const owner = entry.lifecycle.owner();
    const active = owner ? this.runStates.get(owner) : this.activeRunState(sessionPath);
    // A question through the portable UI surface pauses the child's loop
    // until someone answers, so the run is `needs_input` for exactly as long
    // as the question is open — the answer may come from the parent (through
    // `send_agent_message`), from the person (in the child's own chat, which
    // this harness never sees), from a timeout or from an abort, so the open
    // questions are re-read from the driver rather than tracked by hand.
    if (event.type === "ui_request") {
      if (active) this.ask(active, event.request);
      return;
    }
    if (event.type === "ui_event") {
      if (active && event.event.method === "dialogResolved") this.reconcileQuestion(active, event.event.id);
      return;
    }
    if (event.type !== "update") return;
    if (active?.run.status === "needs_input") this.reconcileQuestion(active);
    const update = event.update;
    switch (update.kind) {
      case "turn_start": {
        if (active) this.touch(active, (run) => ({ ...run, activity: { ...(run.activity ?? { turns: 0, tools: 0 }), turns: (run.activity?.turns ?? 0) + 1, lastAt: this.iso() } }));
        return;
      }
      case "tool_execution_start": {
        if (!active) return;
        this.touch(active, (run) => ({ ...run, activity: { ...(run.activity ?? { turns: 0, tools: 0 }), tools: (run.activity?.tools ?? 0) + 1, currentTool: update.toolName, lastAt: this.iso() } }));
        return;
      }
      case "tool_execution_end": {
        if (!active || !active.run.activity) return;
        const { currentTool: _dropped, ...rest } = active.run.activity;
        void _dropped;
        this.touch(active, (run) => ({ ...run, activity: { ...rest, lastAt: this.iso() } }), false);
        return;
      }
      case "message_end": {
        if (!active || update.role !== "assistant") return;
        const text = textOfMessage(update.message);
        active.lastAssistant = {
          ...(text !== undefined ? { text } : {}),
          ...(update.stopReason === "error" ? { error: update.errorMessage ?? "The model returned an error." } : {}),
        };
        return;
      }
      case "extension_error": {
        if (active) this.requestEnd(entry, active, "failed", { error: update.message }, true);
        return;
      }
      case "agent_settled": {
        if (!active) return;
        entry.lifecycle.markSettled(active.run.runId);
        // Compatibility for the old server's startUserRun + driver.prompt
        // pair. promptUser() uses the stronger prompt-promise boundary.
        const phase = entry.lifecycle.phase();
        if (phase.kind === "idle") {
          void this.withEntry(entry, () => {
            const next = entry.lifecycle.shift(active.run.runId);
            if (next) this.kickMessage(active, next);
            else this.settled(entry, active);
          });
        }
        return;
      }
      default:
        return;
    }
  }

  // --------------------------------------------------------------- bridge

  private bridgeFor(entry: Entry): AgentHarnessBridge {
    return {
      role: () => entry.role,
      canDelegate: () => this.canDelegate(entry),
      catalog: () => this.catalogFor(entry),
      startAgent: (input, signal) => this.startAgent(entry, input, signal),
      sendAgentMessage: (input) => this.sendAgentMessage(entry, input),
      inspectFleet: async () => this.inspectFleet(entry),
      inspectAgent: (input) => this.inspectAgent(entry, input),
      stopAgent: (input) => this.stopAgent(entry, input),
      removeAgentWorktree: (input) => this.removeAgentWorktree(entry, input),
      completeRun: async (input) => this.completeRun(entry, input),
      onEvent: (deliver) => {
        entry.eventListeners.add(deliver);
        for (const pending of entry.pendingEvents.splice(0)) {
          try {
            deliver(pending);
          } catch {
            // The module's fault, not the run's.
          }
        }
        return () => {
          entry.eventListeners.delete(deliver);
        };
      },
      onRoleChange: (listener) => {
        entry.roleListeners.add(listener);
        return () => {
          entry.roleListeners.delete(listener);
        };
      },
      emitEvent: (event) => this.event(event),
    };
  }

  private catalogFor(entry: Entry): AgentCatalogEntry[] {
    if (!entry.definition.supportsSubagents) return [];
    const rows: AgentCatalogEntry[] = [];
    for (const name of entry.definition.allowedAgents) {
      const definition = this.definitions.definition(name);
      if (!definition || !isStartable(definition)) continue;
      rows.push({ agentName: definition.name, description: definition.description });
    }
    return rows;
  }

  private canDelegate(entry: Entry): boolean {
    return entry.definition.supportsSubagents && this.catalogFor(entry).length > 0 && entry.role.depth < this.definitions.policy().maxDepth;
  }

  private async startAgent(parent: Entry, input: StartAgentInput, signal?: AbortSignal): Promise<StartAgentResult> {
    if (!parent.path || !parent.sessionId) throw new HarnessError("This session is not ready to start agents yet.");
    const agentName = (input.agentName ?? "").trim();
    const subagentName = (input.subagentName ?? "").trim();
    const task = (input.task ?? "").trim();
    if (agentName === "") throw new HarnessError("agent_name is required: the name of the agent to start.");
    if (subagentName === "") throw new HarnessError("subagent_name is required: a short name for this running instance and its task.");
    if (subagentName.length > SUBAGENT_NAME_MAX) throw new HarnessError(`subagent_name must be at most ${SUBAGENT_NAME_MAX} characters.`);
    if (task === "") throw new HarnessError("task is required: the complete task and all context the new agent needs.");
    if (task.length > AGENT_TASK_MAX) throw new HarnessError(`task must be at most ${AGENT_TASK_MAX} characters.`);
    // Absent means true: an agent that says nothing gets an isolated worktree,
    // exactly as before. `false` is the parent's judgement that this child only
    // reads, so it runs in the parent's own checkout with every tool it would
    // have had (D-144) — nothing is stripped and no write is refused.
    const isolated = worktreeChoice(input.worktree);

    const catalog = this.catalogFor(parent);
    const definition = this.definitions.definition(agentName);
    if (!definition || !isStartable(definition)) {
      throw new HarnessError(`No agent is called "${agentName}". ${availableSentence(catalog)}`);
    }
    if (!parent.definition.supportsSubagents || !catalog.some((row) => row.agentName === agentName)) {
      throw new HarnessError(`${parent.definition.name} may not start "${agentName}". ${availableSentence(catalog)}`);
    }
    const policy = this.definitions.policy();
    if (parent.role.depth >= policy.maxDepth) {
      throw new HarnessError(`Agents may nest at most ${policy.maxDepth} deep and this session is already at depth ${parent.role.depth}; do the work here instead.`);
    }
    if (definition.model && !(await this.host.modelAvailable(definition.model))) {
      throw new HarnessError(modelUnavailableMessage(definition.model));
    }
    const parentDriver = this.host.driver(parent.path);
    if (!parentDriver) throw new HarnessError("This session is no longer open, so it cannot start agents.");
    signal?.throwIfAborted();

    const runId = newRunId();
    const baseCwd = parentDriver.state().cwd;
    const worktree = isolated ? await this.worktrees.create({ projectCwd: parent.projectCwd, baseCwd, subagentName, runId }) : undefined;
    const childCwd = worktree ? worktree.cwd : baseCwd;
    const goal = await readGoal(parentDriver);
    const rootPath = parent.record.rootPath ?? parent.path;
    const record: SessionAgentRecord = {
      agentName,
      kind: "child",
      subagentName,
      parentPath: parent.path,
      parentSessionId: parent.sessionId,
      rootPath,
      runId,
      ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit } } : {}),
    };
    const role: HarnessSessionRole = {
      agentName,
      kind: "child",
      subagentName,
      depth: parent.role.depth + 1,
      isolated,
      // Only when there is one: a child with no worktree must never read a
      // branch name in its own role block (D-156).
      ...(worktree ? { branch: worktree.branch } : {}),
      parent: {
        sessionPath: parent.path,
        sessionId: parent.sessionId,
        agentName: parent.role.agentName,
        ...(parent.role.subagentName !== undefined ? { subagentName: parent.role.subagentName } : {}),
      },
      runId,
      ...(goal ? { goal } : {}),
      task: excerpt(task, ROLE_TASK_EXCERPT),
    };
    const handle = this.prepareSession({ role, definition, record, projectCwd: parent.projectCwd });
    let state: SessionState;
    try {
      const backgroundWork = handle.backgroundWork(childCwd);
      state = await this.host.openChild({
        cwd: childCwd,
        parentSessionPath: parent.path,
        agent: {
          definition,
          role,
          record,
          bridge: handle.bridge,
          policy,
          ...(backgroundWork ? { backgroundWork } : {}),
        },
      });
    } catch (error) {
      handle.discard();
      // Only ever a worktree this start created: a child that shares its
      // parent's checkout leaves nothing behind, and nothing there is touched.
      if (worktree) await this.worktrees.remove(worktree.root, worktree.path, worktree.branch).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw error instanceof HarnessError ? error : new HarnessError(`Could not start ${agentName}: ${message}`);
    }
    // The server attaches on open; attaching again is idempotent for the same path.
    handle.attach(state.path, state.id);
    const entry = this.byPath.get(state.path)!;
    const childDriver = this.host.driver(state.path);
    if (childDriver) await childDriver.rename(subagentName).catch(() => undefined);

    const runState = this.createRun(entry, { origin: "agent", task, goal, parentRunId: this.activeRun(parent.path)?.runId });
    this.event({
      kind: "started",
      sessionPath: state.path,
      runId,
      counterpart: { sessionPath: parent.path, label: labelOf(parent.role) },
      summary: `Started by ${labelOf(parent.role)}`,
    });
    this.event({
      kind: "message_sent",
      sessionPath: parent.path,
      runId,
      counterpart: { sessionPath: state.path, label: subagentName },
      summary: `Sent the task to ${subagentName}`,
    });
    void this.kick(runState, task);
    return {
      agentName,
      subagentName,
      sessionId: state.id,
      runId,
      status: "running",
      cwd: childCwd,
      ...(worktree ? { branch: worktree.branch } : {}),
    };
  }

  private async sendAgentMessage(parent: Entry, input: SendAgentMessageInput): Promise<SendAgentMessageResult> {
    if (!parent.path) throw new HarnessError("This session is not ready yet.");
    const sessionId = (input.sessionId ?? "").trim();
    const message = (input.message ?? "").trim();
    if (message === "") throw new HarnessError("message is required.");
    if (message.length > AGENT_MESSAGE_MAX) throw new HarnessError(`message must be at most ${AGENT_MESSAGE_MAX} characters.`);
    const child = [...this.byPath.values()].find((entry) => entry.sessionId === sessionId && entry.record.parentPath === parent.path);
    if (!child || !child.path) {
      throw new HarnessError(`No agent session is called "${sessionId}" among the agents this session started. Use the sessionId that start_agent returned.`);
    }
    return this.withEntry(child, async () => {
      const driver = this.host.driver(child.path!);
      if (!driver) throw new HarnessError(`The agent session "${sessionId}" is no longer open.`);
      const owner = child.lifecycle.owner();
      const executing = owner ? this.runStates.get(owner) : undefined;
      const active = executing ?? this.activeRunState(child.path!);
      if (active?.run.status === "needs_input" && active.run.question) {
        // The child is paused on a question: a message to it is an answer to
        // that question, and nothing else could reach the child anyway — its
        // loop is inside the tool that asked. Anything that does not fit the
        // question is refused with the question restated, never misrouted.
        const question = active.run.question;
        driver.respondToUi(answerFor(question, message));
        this.reconcileQuestion(active, question.id);
        this.event({ kind: "message_sent", sessionPath: parent.path!, runId: active.run.runId, counterpart: { sessionPath: child.path!, label: labelOf(child.role) }, summary: `Answered ${labelOf(child.role)}'s question` });
        this.event({ kind: "message_received", sessionPath: child.path!, runId: active.run.runId, counterpart: { sessionPath: parent.path!, label: labelOf(parent.role) }, summary: `Answer from ${labelOf(parent.role)}` });
        return { sessionId, runId: active.run.runId, status: active.run.status, delivery: "answered", answered: question };
      }

      let state: RunState;
      let delivery: SendAgentMessageResult["delivery"];
      if ((executing && child.lifecycle.end(executing.run.runId)) || child.lifecycle.successor()) {
        // Completion/stop has been declared but Pi still owns the old prompt.
        // Reserve one visible queued run now so immediate and concurrent
        // resumes share a real identity instead of spawning busy failures.
        state = this.queueRun(child, message, executing ?? active, parent);
        delivery = "queued";
      } else if (active) {
        state = active;
        if (driver.state().isStreaming || child.lifecycle.owner() !== undefined) {
          const pending: PendingMessage = { content: [{ type: "text", text: message }], origin: "agent", engine: input.interrupt === true };
          child.lifecycle.enqueue(state.run.runId, pending);
          if (pending.engine) {
            try {
              await driver.steer([{ type: "text", text: message }]);
            } catch (error) {
              child.lifecycle.remove(state.run.runId, pending);
              throw error;
            }
          }
          delivery = "queued";
        } else {
          delivery = "delivered";
          this.kick(state, message);
        }
      } else {
        state = this.createRun(child, { origin: "agent", task: message, goal: await readGoal(this.host.driver(parent.path!)), parentRunId: this.activeRun(parent.path!)?.runId });
        delivery = "delivered";
        this.kick(state, message);
      }
      this.event({ kind: "message_sent", sessionPath: parent.path!, runId: state.run.runId, counterpart: { sessionPath: child.path!, label: labelOf(child.role) }, summary: `Sent a message to ${labelOf(child.role)}` });
      this.event({ kind: "message_received", sessionPath: child.path!, runId: state.run.runId, counterpart: { sessionPath: parent.path!, label: labelOf(parent.role) }, summary: `Message from ${labelOf(parent.role)}` });
      return { sessionId, runId: state.run.runId, status: state.run.status, delivery };
    });
  }

  /**
   * The tree of work under this session (D-163): the runs of the sessions
   * beneath it and the commands those sessions — this one included — ran, in
   * the fleet column's own rows and words. Read-only; scoped to the caller,
   * so a child sees its own subtree and never a sibling's.
   */
  private inspectFleet(caller: Entry): InspectFleetResult {
    if (!caller.path) throw new HarnessError("This session is not ready yet.");
    return buildFleetTree({
      callerPath: caller.path,
      runs: this.runs(),
      tasksOf: (sessionPath) => this.host.tasks?.(sessionPath) ?? [],
      now: this.now(),
    });
  }

  /**
   * `task_output` on a command of another session in the caller's tree
   * (D-163): read-only, from the worker's index and the command's log file.
   * A command outside the tree is refused, as a stranger's run is.
   */
  private async readTask(caller: Entry, taskId: string, tailLines: number): Promise<ReadTaskOutputResult> {
    if (!caller.path) throw new HarnessError("This session is not ready yet.");
    const id = (taskId ?? "").trim();
    const found = this.findTask(caller.path, id);
    if (!found) {
      throw new HarnessError(`The command "${id}" is not in the tree under this session. inspect_fleet lists every command you can read, with its taskId.`);
    }
    const { task, owner } = found;
    const { logPath, sessionPath: _path, ...rest } = task;
    void _path;
    const text = await readLogTail(logPath, tailLines);
    return {
      task: rest,
      owner,
      ...(text !== undefined ? { text } : {}),
    };
  }

  /** A command by id, anywhere strictly under `callerPath`, with the agent whose session ran it. */
  private findTask(callerPath: string, id: string): { task: IndexedTask; owner: ReadTaskOutputResult["owner"] } | undefined {
    if (id === "" || !this.host.tasks) return undefined;
    for (const run of this.runs()) {
      if (!this.descends(callerPath, run.sessionPath)) continue;
      const task = this.host.tasks(run.sessionPath).find((candidate) => candidate.id === id);
      if (task) return { task, owner: { agentName: run.agentName, subagentName: run.subagentName, sessionId: run.sessionId } };
    }
    return undefined;
  }

  /** True when `sessionPath` is strictly under `callerPath` in the run tree: a child, a child's child, and so on. */
  private descends(callerPath: string, sessionPath: string): boolean {
    const seen = new Set<string>();
    let cursor: string | undefined = sessionPath;
    while (cursor !== undefined && cursor !== callerPath && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = this.latestRun(cursor)?.run.parent?.sessionPath;
    }
    return cursor === callerPath && sessionPath !== callerPath;
  }

  /**
   * One agent in depth (M13-T45). Read-only: nothing here prompts, steers or
   * answers the agent, so inspecting is always safe while it works. A live
   * agent's words come from its driver; an ended one whose driver is gone is
   * read from its session file. Any row of the caller's tree may be read — a
   * child, or a child's child — as the person may open any chat in it
   * (D-163).
   */
  private async inspectAgent(parent: Entry, input: InspectAgentInput): Promise<InspectAgentResult> {
    if (!parent.path) throw new HarnessError("This session is not ready yet.");
    const target = this.childOf(parent, input, "tree");
    const state = this.runStates.get(target.runId)!;
    const run = state.run;
    const count = messageCount(input.messages);
    const driver = this.host.driver(run.sessionPath);
    const source = driver ? await driver.entries().catch(() => ({ entries: [] as unknown[], leafId: null })) : await readSessionEntries(run.sessionPath);
    const messages: InspectedMessage[] = assistantMessagesOf(source.entries, source.leafId, count);
    const agents = this.runs()
      .filter((candidate) => candidate.parent?.sessionPath === run.sessionPath)
      .reverse()
      .map(summarize);
    return {
      ...summarize(run),
      task: state.task,
      origin: run.origin,
      depth: run.depth,
      ...(run.model ? { model: `${run.model.provider}/${run.model.id}` } : {}),
      ...(run.cwd !== undefined ? { cwd: run.cwd } : {}),
      ...(run.worktree && !run.worktree.removedAt ? { branch: run.worktree.branch } : {}),
      worktree: await this.worktreeStatus(parent, run),
      ...(run.activity ? { activity: run.activity } : {}),
      updatedAt: run.updatedAt,
      messages,
      agents,
    };
  }

  /**
   * The worktree as it is now: gone, still there, and what git says it holds
   * — measured against the checkout of the session that started the run,
   * which is the caller's for a child and a child's for a grandchild.
   */
  private async worktreeStatus(caller: Entry, run: AgentRun): Promise<InspectAgentResult["worktree"]> {
    const worktree = run.worktree;
    if (!worktree) return null;
    if (worktree.removedAt) return { path: worktree.path, branch: worktree.branch, exists: false, unmergedCommits: null, uncommittedFiles: null, removedAt: worktree.removedAt };
    const comparePath = run.parent?.sessionPath ?? caller.path;
    const compareCwd = (comparePath ? this.host.driver(comparePath)?.state().cwd : undefined) ?? (caller.path ? this.host.driver(caller.path)?.state().cwd : undefined) ?? caller.projectCwd;
    const facts = await this.worktrees.facts({ path: worktree.path, branch: worktree.branch, compareCwd });
    return { path: worktree.path, branch: worktree.branch, exists: facts.exists, unmergedCommits: facts.unmergedCommits, uncommittedFiles: facts.uncommittedFiles };
  }

  private async stopAgent(parent: Entry, input: StopAgentInput): Promise<AgentRunSummary> {
    const runId = (input.runId ?? "").trim();
    const state = this.runStates.get(runId);
    if (!state || state.run.parent?.sessionPath !== parent.path) throw new HarnessError(`No run called "${runId}" was started by this session.`);
    const reason = input.reason?.trim();
    await this.stopRun(runId, { initiator: "parent", ...(reason ? { reason } : {}) });
    return summarize(state.run);
  }

  /**
   * The parent removes a child's worktree (M13-T42, D-157). Merging is the
   * parent's own `git merge` in its own checkout — a tool would have to invent
   * conflict semantics, and conflicts are where a person's judgement belongs —
   * so this verb is only the removal, and it refuses while there is anything
   * left to merge unless the parent says the work is to be thrown away.
   */
  private async removeAgentWorktree(parent: Entry, input: RemoveAgentWorktreeInput): Promise<RemoveAgentWorktreeResult> {
    if (!parent.path) throw new HarnessError("This session is not ready yet.");
    const target = this.childOf(parent, input);
    const active = this.activeRunState(target.sessionPath);
    if (active) {
      throw new HarnessError(
        `${target.subagentName} is still working (run ${active.run.runId}). Its ending will be delivered to you; remove the worktree then, or end the run now with stop_agent if its work is no longer needed.`,
      );
    }
    const worktree = target.worktree;
    if (!worktree) {
      throw new HarnessError(
        `${target.subagentName} ran in your own checkout, not a worktree of its own, so there is nothing to merge and nothing to remove. Anything it changed is already in your files.`,
      );
    }
    if (worktree.removedAt) throw new HarnessError(`${target.subagentName}'s worktree has already been removed.`);

    const root = this.worktrees.ownedBy(target.runId)?.root ?? (await this.worktrees.rootOf(parent.projectCwd));
    if (!root) throw new HarnessError(`Could not find the git repository ${worktree.path} belongs to, so it was left alone. Remove it yourself if you are sure.`);
    const compareCwd = this.host.driver(parent.path)?.state().cwd ?? parent.projectCwd;
    const facts = await this.worktrees.facts({ path: worktree.path, branch: worktree.branch, compareCwd });
    const force = input.force === true;
    if (!force && holdsWork(facts)) {
      throw new HarnessError(
        `${target.subagentName}'s worktree still holds ${describeWork(facts)}, and removing it would destroy that. ` +
          `Merge it into your checkout first — \`git merge ${worktree.branch}\` from ${compareCwd}, after reviewing it in ${worktree.path} — ` +
          "then call remove_agent_worktree again. If the work is genuinely to be thrown away, call it with force true.",
      );
    }
    await this.worktrees.remove(root, worktree.path, worktree.branch);

    // The registry must never hold a path that no longer exists: every run of
    // that session, and the session's own record, learn it is gone.
    const removedAt = this.iso();
    const entry = this.byPath.get(target.sessionPath);
    if (entry?.record.worktree) entry.record = { ...entry.record, worktree: { ...entry.record.worktree, removedAt } };
    for (const runId of this.runOrder) {
      const state = this.runStates.get(runId)!;
      if (state.run.sessionPath !== target.sessionPath || !state.run.worktree || state.run.worktree.removedAt) continue;
      this.touch(state, (run) => ({ ...run, worktree: { ...run.worktree!, removedAt } }));
    }
    return {
      agentName: target.agentName,
      subagentName: target.subagentName,
      sessionId: target.sessionId,
      removed: true,
      path: worktree.path,
      branch: worktree.branch,
      ...(force && holdsWork(facts) ? { discarded: { commits: facts.unmergedCommits, uncommittedFiles: facts.uncommittedFiles } } : {}),
    };
  }

  /**
   * The agent a caller means, by `sessionId` or `runId` — the identities that
   * already exist, never a fifth one. `scope` is who may be named: a `child`
   * this session started (the verbs that act on one — stop, message, remove
   * its worktree), or any row of the `tree` under it (the read-only
   * `inspect_agent`, D-163). Never another session's work.
   */
  private childOf(
    parent: Entry,
    input: Pick<RemoveAgentWorktreeInput, "sessionId" | "runId">,
    scope: "child" | "tree" = "child",
  ): { sessionPath: string; sessionId: string; runId: string; agentName: string; subagentName: string; worktree: AgentRun["worktree"] } {
    const runId = (input.runId ?? "").trim();
    const sessionId = (input.sessionId ?? "").trim();
    if (runId === "" && sessionId === "") throw new HarnessError("Name the agent by its sessionId or one of its runIds, as start_agent returned them.");
    const own = (run: AgentRun): boolean => run.parent?.sessionPath === parent.path;
    const within = (run: AgentRun): boolean => (scope === "tree" ? parent.path !== undefined && this.descends(parent.path, run.sessionPath) : own(run));
    const refusal = (named: string): HarnessError =>
      scope === "tree"
        ? new HarnessError(`${named} is not in the tree under this session. inspect_fleet lists every agent you can read, with its runId and sessionId.`)
        : new HarnessError(named.startsWith("No run") ? `${named} was started by this session.` : `${named} among the agents this session started. Use the sessionId that start_agent returned.`);

    let run: AgentRun | undefined;
    if (runId !== "") {
      const state = this.runStates.get(runId);
      if (!state || !within(state.run)) throw refusal(`No run called "${runId}"`);
      run = state.run;
    } else {
      const mine = this.runs().filter((candidate) => candidate.sessionId === sessionId && within(candidate));
      if (mine.length === 0) throw refusal(`No agent session is called "${sessionId}"`);
      run = mine[mine.length - 1];
    }
    const sibling = this.runs().find((candidate) => candidate.sessionPath === run!.sessionPath && candidate.worktree);
    return {
      sessionPath: run!.sessionPath,
      sessionId: run!.sessionId,
      runId: run!.runId,
      agentName: run!.agentName,
      subagentName: run!.subagentName,
      worktree: sibling?.worktree ?? run!.worktree,
    };
  }

  private async completeRun(child: Entry, input: CompleteRunInput): Promise<CompleteRunResult> {
    if (!child.path) return { ok: false, error: "This session is not ready yet." };
    return this.withEntry(child, async () => {
      const owner = child.lifecycle.owner();
      const active = owner ? this.runStates.get(owner) : this.activeRunState(child.path!);
      if (!active || active.completedByTool || child.lifecycle.end(active.run.runId) || isTerminalRunStatus(active.run.status)) {
        const latest = this.latestRun(child.path!);
        return { ok: false, error: latest ? "This run already ended." : "No run is active in this session." };
      }
      if (input.status !== "completed" && input.status !== "blocked") return { ok: false, error: 'status must be "completed" or "blocked".' };
      const message = (input.message ?? "").trim();
      if (message === "") return { ok: false, error: "message is required: the final result, evidence and any important next step." };
      if (message.length > AGENT_MESSAGE_MAX) return { ok: false, error: `message must be at most ${AGENT_MESSAGE_MAX} characters.` };

      active.completedByTool = true;
      const end: RunEnd = { status: input.status, outcome: { result: { status: input.status, message } } };
      const invoking = child.lifecycle.owner() === active.run.runId;
      if (invoking) child.lifecycle.declareEnd(active.run.runId, end);
      // A terminating tool stops further model calls, but Pi still polls its
      // steering/follow-up queues after the tool batch. Empty them now and
      // preserve every message as the next tracked run instead.
      const driver = this.host.driver(child.path!);
      let preserved: PendingMessage[];
      if (driver) {
        try {
          const cleared = await driver.clearQueue();
          preserved = this.preservedMessages(child, active, [...cleared.steering, ...cleared.followUp]);
        } catch {
          // If the queue cannot be proven empty, abort without awaiting the
          // prompt that is currently executing this tool. Its promise remains
          // the fence; replay every locally known message after it exits.
          preserved = child.lifecycle.clearInbox(active.run.runId);
          this.scheduleAbort(driver);
        }
      } else {
        preserved = this.preservedMessages(child, active, []);
      }
      for (const pending of preserved) this.queueRunMessage(child, pending, active);

      // Fake/idle drivers may invoke the bridge outside a prompt. Real Pi is
      // still streaming here; its prompt promise is the engine-ready fence.
      if (!invoking) this.endRun(active, end.status, end.outcome);
      return { ok: true, runId: active.run.runId };
    });
  }

  // ------------------------------------------------------------ lifecycle

  private createRun(
    entry: Entry,
    init: { origin: AgentRun["origin"]; task: string; goal?: { id: string; objective: string } | null; parentRunId?: string | undefined },
    queued = false,
  ): RunState {
    const path = entry.path!;
    const sessionId = entry.sessionId!;
    const runId = init.origin === "agent" && entry.role.runId && !this.runStates.has(entry.role.runId) ? entry.role.runId : newRunId();
    // Distinct start times make every existing projection choose the resumed
    // live run over terminal history, even when both are created in one tick.
    const previousStarted = this.latestRun(path)?.run.startedAt;
    const startedMs = Math.max(this.now(), previousStarted ? Date.parse(previousStarted) + 1 : 0);
    const startedAt = new Date(startedMs).toISOString();
    const driver = this.host.driver(path);
    const parentPath = entry.record.parentPath;
    const runCwd = driver?.state().cwd ?? entry.record.worktree?.path;
    const run: AgentRun = {
      agentName: entry.role.agentName,
      subagentName: entry.role.subagentName ?? entry.role.agentName,
      sessionId,
      runId,
      sessionPath: path,
      projectCwd: entry.projectCwd,
      rootSessionPath: entry.record.rootPath ?? path,
      depth: entry.role.depth,
      parent: parentPath
        ? { sessionPath: parentPath, sessionId: entry.record.parentSessionId ?? "", ...(init.parentRunId !== undefined ? { runId: init.parentRunId } : {}) }
        : null,
      worktree: entry.record.worktree ?? null,
      // Where this run actually works, said once so no reader has to infer it
      // from the presence of a worktree.
      ...(runCwd !== undefined ? { cwd: runCwd } : {}),
      origin: init.origin,
      status: queued ? "queued" : "running",
      task: excerpt(init.task, AGENT_TASK_EXCERPT),
      ...(init.goal ? { goal: init.goal } : {}),
      model: driver?.state().model ?? null,
      activity: { turns: 0, tools: 0, lastAt: startedAt },
      startedAt,
      updatedAt: startedAt,
    };
    const state: RunState = {
      run,
      task: init.task,
      nudged: false,
      completedByTool: false,
      lastAssistant: undefined,
    };
    this.runStates.set(runId, state);
    this.runOrder.push(runId);
    if (!queued) this.activateRun(entry, state);
    void this.persistMoment(run, "started");
    this.publish(state);
    return state;
  }

  private activateRun(entry: Entry, state: RunState): void {
    entry.role = { ...entry.role, runId: state.run.runId, ...(state.run.goal ? { goal: state.run.goal } : {}) };
    this.announceRole(entry);
  }

  private executeRootExtension(
    start: (
      ownerRunId?: string,
      onInvocation?: Parameters<ExtensionModelWorkRequest["start"]>[1],
    ) => ExtensionModelExecution | Promise<ExtensionModelExecution>,
    request: ExtensionModelWorkRequest,
    admission: Deferred<void>,
    completion: Deferred<void>,
  ): void {
    const operation = (async () => {
      const execution = await start(request.parent?.runId);
      void execution.admission.then(admission.resolve, admission.reject);
      await execution.completion;
    })();
    void operation.then(() => completion.resolve(), (error) => {
      admission.reject(error);
      completion.reject(error);
    });
  }

  private executeExtension(entry: Entry, state: RunState, pending: PendingExtensionWork, standalone: boolean): void {
    const releaseDescendant = entry.lifecycle.registerDescendant(state.run.runId);
    const operation = (async () => {
      let accepted = false;
      let failure: unknown;
      let disposition: Awaited<ExtensionModelExecution["completion"]>["disposition"] | undefined;
      try {
        const ownsNativeInvocation = pending.bindToRun || standalone;
        const execution = await pending.start(
          ownsNativeInvocation ? state.run.runId : undefined,
          ownsNativeInvocation
            ? (invocation) => {
                if (!entry.lifecycle.bindInvocation(state.run.runId, invocation)) {
                  throw new HarnessError("The extension invocation lost session ownership before it could start.");
                }
              }
            : undefined,
        );
        const admission = execution.admission.then(
          () => {
            accepted = true;
            pending.admission.resolve();
          },
          (error) => {
            pending.admission.reject(error);
            throw error;
          },
        );
        try {
          ({ disposition } = await execution.completion);
          await admission;
        } catch (error) {
          failure = error;
          await admission.catch(() => undefined);
        }

        await this.withEntry(entry, () => {
          if (disposition === "consumed" && !pending.request.parentStarted && !entry.lifecycle.end(state.run.runId)) {
            entry.lifecycle.declareEnd(state.run.runId, {
              status: "failed",
              outcome: { error: "The engine accepted the extension message without starting model work." },
            });
          } else if (accepted && failure !== undefined && !entry.lifecycle.end(state.run.runId)) {
            entry.lifecycle.declareEnd(state.run.runId, {
              status: "failed",
              outcome: { error: failure instanceof Error ? failure.message : String(failure) },
            });
          }
        });
      } catch (error) {
        failure = error;
        pending.admission.reject(error);
      } finally {
        releaseDescendant();
      }

      if (standalone) {
        await this.withEntry(entry, () => this.afterInvocation(
          entry,
          state,
          { accepted, queued: disposition === "queued" },
          failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure),
        ));
      }
      if (accepted && failure !== undefined) throw failure;
    })();
    void operation.then(() => pending.completion.resolve(), (error) => pending.completion.reject(error));
  }

  /** Start one prompt invocation. Its promise is the only engine-ready fence. */
  private kick(state: RunState, text: string): void {
    this.kickMessage(state, { content: [{ type: "text", text }], options: { expandPromptTemplates: false }, origin: state.run.origin === "user" ? "user" : "agent", engine: false });
  }

  private kickMessage(state: RunState, message: PendingMessage): void {
    const entry = this.byPath.get(state.run.sessionPath);
    const driver = this.host.driver(state.run.sessionPath);
    if (!entry || !driver) {
      this.endRun(state, "failed", { error: "The agent's session is not open." });
      return;
    }
    if (!entry.lifecycle.begin(state.run.runId)) {
      entry.lifecycle.enqueue(state.run.runId, message);
      return;
    }
    if (message.extension) {
      this.executeExtension(entry, state, message.extension, true);
      return;
    }
    void this.invoke(entry, state, driver, message.content, message.options).then(message.resolve, message.reject).catch(() => undefined);
  }

  private async invoke(
    entry: Entry,
    state: RunState,
    driver: SessionDriver,
    content: ContentBlock[],
    options?: PromptOptions,
  ): Promise<{ accepted: boolean; queued: boolean }> {
    let result: { accepted: boolean; queued: boolean };
    let failure: string | undefined;
    let thrown: unknown;
    let accepted = false;
    const acceptedObserver = () => {
      accepted = true;
      options?.onAccepted?.();
    };
    try {
      result = await driver.prompt(content, driver.setExtensionModelWorkHandler
        ? {
            ...options,
            ownerRunId: state.run.runId,
            onInvocation: (invocation) => {
              if (!entry.lifecycle.bindInvocation(state.run.runId, invocation)) {
                throw new HarnessError("The prompt invocation lost session ownership before it could start.");
              }
              options?.onInvocation?.(invocation);
            },
            onAccepted: acceptedObserver,
          }
        : options);
    } catch (error) {
      result = { accepted, queued: false };
      thrown = error;
      failure = error instanceof Error ? error.message : String(error);
    }
    await this.withEntry(entry, () => this.afterInvocation(entry, state, result, failure));
    if (thrown !== undefined) throw thrown;
    return result;
  }

  private afterInvocation(
    entry: Entry,
    state: RunState,
    result: { accepted: boolean; queued: boolean },
    failure?: string,
  ): void {
    const boundary = entry.lifecycle.finish(state.run.runId);
    if (!boundary || isTerminalRunStatus(state.run.status)) return;
    const end = boundary.end ?? (!result.accepted
      ? { status: "failed" as const, outcome: { error: failure ?? "The agent's session refused the task because it was busy." } }
      : undefined);
    if (end) {
      // A locally admitted message survives an asynchronous/refused preflight
      // as a canonical successor. Engine-owned queue entries do not replay.
      for (const pending of entry.lifecycle.clearInbox(state.run.runId)) {
        if (!pending.engine) this.queueRunMessage(entry, pending, state);
      }
      this.finalizePendingEnd(entry, state, end);
      return;
    }
    // Engine-queued messages have either been consumed or the prompt could
    // not have settled. Harness-owned messages are admitted one at a time.
    const next = entry.lifecycle.nextLocalAfterFence(state.run.runId, (pending) => pending.engine);
    if (next) {
      this.kickMessage(state, next);
      return;
    }
    if (boundary.settled) this.settled(entry, state);
  }

  /** The child stopped without `complete_agent_run`: nudge once, then record the failure. */
  private settled(entry: Entry, state: RunState): void {
    if (state.lastAssistant?.error) {
      this.endRun(state, "failed", { error: state.lastAssistant.error });
      return;
    }
    if (!state.nudged) {
      state.nudged = true;
      this.kick(state, NUDGE_TEXT);
      return;
    }
    const driver = this.host.driver(entry.path!);
    const context = driver?.lastAssistantText?.() ?? state.lastAssistant?.text;
    this.endRun(state, "failed", { error: ENDED_WITHOUT_TOOL, ...(context ? { context: excerpt(context, RESULT_EXCERPT) } : {}) });
  }

  /** Reserve or extend the one run waiting behind the current invocation. */
  private queueRun(entry: Entry, text: string, previous?: RunState, parent?: Entry): RunState {
    return this.queueRunMessage(entry, { content: [{ type: "text", text }], options: { expandPromptTemplates: false }, origin: "agent", engine: false }, previous, parent);
  }

  private queueRunMessage(entry: Entry, message: PendingMessage, previous?: RunState, parent?: Entry): RunState {
    let created: RunState | undefined;
    const reservation = entry.lifecycle.reserveSuccessor(message, () => {
      const task = contentTask(message.content);
      created = this.createRun(
        entry,
        {
          origin: message.origin,
          task,
          ...(previous?.run.goal ? { goal: previous.run.goal } : {}),
          ...((parent?.path ? this.activeRun(parent.path)?.runId : previous?.run.parent?.runId) !== undefined
            ? { parentRunId: parent?.path ? this.activeRun(parent.path)?.runId : previous?.run.parent?.runId }
            : {}),
        },
        true,
      );
      return created.run.runId;
    });
    return created ?? this.runStates.get(reservation.runId)!;
  }

  /** Keep local messages and only engine messages actually returned by clearQueue. */
  private preservedMessages(entry: Entry, state: RunState, cleared: string[]): PendingMessage[] {
    const remaining = [...cleared];
    const preserved: PendingMessage[] = [];
    for (const pending of entry.lifecycle.clearInbox(state.run.runId)) {
      if (!pending.engine) {
        preserved.push(pending);
        continue;
      }
      const index = remaining.indexOf(contentTask(pending.content));
      if (index >= 0) {
        preserved.push(pending);
        remaining.splice(index, 1);
      }
    }
    return [...preserved, ...remaining.map((text) => ({ content: [{ type: "text" as const, text }], options: { expandPromptTemplates: false }, origin: state.run.origin === "user" ? "user" as const : "agent" as const, engine: false }))];
  }

  private requestEnd(
    entry: Entry,
    state: RunState,
    status: AgentRunTerminalStatus,
    outcome: RunEnd["outcome"],
    abort: boolean,
  ): void {
    if (isTerminalRunStatus(state.run.status)) return;
    const end = { status, outcome };
    if (entry.lifecycle.owner() === state.run.runId) {
      if (!entry.lifecycle.declareEnd(state.run.runId, end)) return;
      if (abort) this.scheduleAbort(this.host.driver(state.run.sessionPath));
    } else {
      this.endRun(state, status, outcome);
    }
  }

  private finalizePendingEnd(entry: Entry, state: RunState, pending: RunEnd): void {
    if (isTerminalRunStatus(state.run.status)) return;
    const successor = entry.lifecycle.takeSuccessor();
    const queued = successor ? this.runStates.get(successor.runId) : undefined;
    // Publish the old terminal history first, but delay its parent wake until
    // the already-accepted resume has become the session's canonical live run.
    this.endRun(state, pending.status, pending.outcome, queued !== undefined);
    if (queued && !isTerminalRunStatus(queued.run.status)) {
      this.touch(queued, (run) => ({ ...run, status: "running" }));
      this.activateRun(entry, queued);
      if (successor?.first) this.kickMessage(queued, successor.first);
      else this.kick(queued, queued.task);
      if (state.run.parent) this.notifyParent(state.run, pending.outcome.context);
    }
  }

  private bestEffortAbort(driver: SessionDriver | undefined): Promise<void> {
    if (!driver) return Promise.resolve();
    try {
      return driver.abort().catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  private scheduleAbort(driver: SessionDriver | undefined): void {
    void this.bestEffortAbort(driver);
  }

  private withEntry<T>(entry: Entry, operation: () => T | Promise<T>): Promise<T> {
    return entry.lifecycle.withLock(operation);
  }

  private endRun(
    state: RunState,
    status: AgentRunTerminalStatus,
    outcome: { result?: { status: "completed" | "blocked"; message: string }; error?: string; endedBy?: { initiator: AgentRunInitiator; reason?: string }; context?: string },
    delayParent = false,
  ): void {
    if (isTerminalRunStatus(state.run.status)) return;
    const endedAt = this.iso();
    // A question dies with the run: nothing may keep offering an answer to a
    // child that is no longer listening.
    const { question: _open, ...ended } = state.run;
    void _open;
    state.run = {
      ...ended,
      status,
      updatedAt: endedAt,
      endedAt,
      ...(outcome.result ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.endedBy ? { endedBy: outcome.endedBy } : {}),
    };
    const run = state.run;
    const entry = this.byPath.get(run.sessionPath);
    if (entry && entry.role.runId === run.runId) {
      const { runId: _ended, ...rest } = entry.role;
      void _ended;
      entry.role = rest;
      this.announceRole(entry);
    }
    void this.persistMoment(run, status);
    this.publish(state);
    this.event({
      kind: status,
      sessionPath: run.sessionPath,
      runId: run.runId,
      ...(run.parent ? { counterpart: { sessionPath: run.parent.sessionPath, label: entry?.role.parent ? labelOf(entry.role.parent) : "parent" } } : {}),
      summary: eventSummary(status, run),
    });
    entry?.lifecycle.didTerminate(run.runId);
    if (!delayParent) this.notifyParent(run, outcome.context);
  }

  // ------------------------------------------------------------- questions

  /**
   * The child raised a question. The run is `needs_input` until it is
   * answered, and the parent is told once per question — the one event that
   * asks the parent to do something rather than telling it something ended.
   */
  private ask(state: RunState, request: UiDialogRequest): void {
    // One question at a time, the oldest first: a second dialog raised while
    // the first is still open waits its turn (`reconcileQuestion` moves on to
    // it once the first is settled).
    if (isTerminalRunStatus(state.run.status) || state.run.question) return;
    this.raise(state, request);
  }

  /** Set the run's question to this one and tell the parent. */
  private raise(state: RunState, request: UiDialogRequest): void {
    const question = questionOf(request, request.toolCallId !== undefined ? state.run.activity?.currentTool : undefined, this.iso());
    this.touch(state, (run) => ({ ...run, status: "needs_input", question }));
    const run = state.run;
    const entry = this.byPath.get(run.sessionPath);
    this.event({
      kind: "needs_input",
      sessionPath: run.sessionPath,
      runId: run.runId,
      ...(run.parent ? { counterpart: { sessionPath: run.parent.sessionPath, label: entry?.role.parent ? labelOf(entry.role.parent) : "parent" } } : {}),
      summary: `Asked: ${excerpt(question.title, QUESTION_SUMMARY_EXCERPT)}`,
    });
    if (!run.parent) return;
    this.event({
      kind: "message_received",
      sessionPath: run.parent.sessionPath,
      runId: run.runId,
      counterpart: { sessionPath: run.sessionPath, label: run.subagentName },
      summary: `${run.subagentName} asked a question`,
    });
    this.deliverToParent(run, {
      type: "agent.needs_input",
      agentName: run.agentName,
      subagentName: run.subagentName,
      sessionId: run.sessionId,
      runId: run.runId,
      message: questionMessage(run, question),
      run,
    });
  }

  /**
   * Re-read what the child's driver still holds open. `resolvedId` is the
   * question the driver just said is gone, for a driver that cannot list its
   * pending dialogs. The oldest open question is the one the run shows.
   */
  private reconcileQuestion(state: RunState, resolvedId?: string): void {
    if (isTerminalRunStatus(state.run.status)) return;
    const driver = this.host.driver(state.run.sessionPath);
    const current = state.run.question;
    let open: UiDialogRequest | undefined;
    const pending = pendingUiOf(driver);
    if (pending) {
      open = pending[0];
    } else if (current && current.id !== resolvedId) {
      // A driver that cannot list its dialogs: the question stands until the
      // driver says that exact one is gone.
      return;
    }
    if (open) {
      if (current?.id !== open.id) this.raise(state, open);
      return;
    }
    if (state.run.status !== "needs_input") return;
    const { question: _answered, ...rest } = state.run;
    void _answered;
    state.run = rest;
    this.touch(state, (run) => ({ ...run, status: "running" }));
  }

  private notifyParent(run: AgentRun, context: string | undefined): void {
    if (!run.parent || !isTerminalRunStatus(run.status)) return;
    const message = modelMessage(run, context);
    this.event({
      kind: "message_received",
      sessionPath: run.parent.sessionPath,
      runId: run.runId,
      counterpart: { sessionPath: run.sessionPath, label: run.subagentName },
      summary: `${run.subagentName} ${statusWord(run.status)}`,
    });
    this.deliverToParent(run, {
      type: MODEL_EVENT_TYPE[run.status],
      agentName: run.agentName,
      subagentName: run.subagentName,
      sessionId: run.sessionId,
      runId: run.runId,
      message,
      ...(run.endedBy ? { endedBy: run.endedBy } : {}),
      run,
    });
  }

  /** Hand one event to the parent's module, or hold it until the module listens. */
  private deliverToParent(run: AgentRun, event: AgentModelEvent): void {
    if (!run.parent) return;
    const parent = this.byPath.get(run.parent.sessionPath);
    if (!parent) return;
    if (parent.eventListeners.size === 0) {
      parent.pendingEvents.push(event);
      if (parent.pendingEvents.length > PENDING_EVENTS_MAX) parent.pendingEvents.splice(0, parent.pendingEvents.length - PENDING_EVENTS_MAX);
      return;
    }
    for (const deliver of [...parent.eventListeners]) {
      try {
        deliver(event);
      } catch {
        // The module's fault, not the run's.
      }
    }
  }

  /** Apply a change to the live run; publish unless told not to (chatty activity only). */
  private touch(state: RunState, change: (run: AgentRun) => AgentRun, publish = true): void {
    state.run = { ...change(state.run), updatedAt: this.iso() };
    if (publish) this.publish(state);
  }

  /**
   * `agents/run` is the single truth about a run (D-140). It used to be
   * published twice — once as itself and once as a parent-side `run` panel —
   * and the second copy is gone with the panels: the fleet reads the typed
   * record, so a run said one way cannot drift from the same run said the
   * other way.
   */
  private publish(state: RunState): void {
    this.host.notify("agents/run", { run: state.run });
  }

  private async persistMoment(run: AgentRun, moment: AgentRunStatus | "started"): Promise<void> {
    const driver = this.host.driver(run.sessionPath);
    if (!driver?.appendEntry) return;
    try {
      await driver.appendEntry(SESSION_RUN_ENTRY_TYPE, {
        runId: run.runId,
        moment,
        agentName: run.agentName,
        subagentName: run.subagentName,
        sessionId: run.sessionId,
        origin: run.origin,
        status: run.status,
        at: this.iso(),
        ...(run.parent ? { parentPath: run.parent.sessionPath, parentSessionId: run.parent.sessionId } : {}),
        ...(moment === "started" ? { task: run.task } : {}),
        ...(run.result ? { result: run.result } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
        ...(run.endedBy ? { endedBy: run.endedBy } : {}),
      });
    } catch {
      // The run is already published to the host; a missing file entry is not a failure.
    }
  }

  private announceRole(entry: Entry): void {
    for (const listener of [...entry.roleListeners]) {
      try {
        listener(entry.role);
      } catch {
        // One listener's fault must not stop the others.
      }
    }
  }

  private event(event: Omit<AgentEvent, "id" | "at">): void {
    this.host.notify("agents/event", { id: randomBytes(6).toString("hex"), at: this.iso(), ...event });
  }

  private activeRunState(sessionPath: string): RunState | undefined {
    for (let i = this.runOrder.length - 1; i >= 0; i--) {
      const state = this.runStates.get(this.runOrder[i]!)!;
      if (state.run.sessionPath === sessionPath && !isTerminalRunStatus(state.run.status)) return state;
    }
    return undefined;
  }

  private latestRun(sessionPath: string): RunState | undefined {
    for (let i = this.runOrder.length - 1; i >= 0; i--) {
      const state = this.runStates.get(this.runOrder[i]!)!;
      if (state.run.sessionPath === sessionPath) return state;
    }
    return undefined;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

// ------------------------------------------------------------------ helpers

export function newRunId(): string {
  return `run_${randomBytes(4).toString("hex")}`;
}

/**
 * `worktree` on `start_agent`: absent means true, so nothing that exists today
 * changes. Anything that is not a boolean is a mistake worth naming rather
 * than a silent default — the bridge crosses a package boundary.
 */
export function worktreeChoice(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new HarnessError("worktree must be true or false: true (the default) gives the agent its own worktree, false runs it in this session's checkout.");
  return value;
}

/** True when removing this worktree would destroy something, or we cannot tell. */
function holdsWork(facts: WorktreeFacts): boolean {
  if (!facts.exists) return false;
  return facts.unmergedCommits === null || facts.unmergedCommits > 0 || facts.uncommittedFiles === null || facts.uncommittedFiles > 0;
}

/** What it holds, in the parent model's own terms. Unknown is said as unknown. */
export function describeWork(facts: WorktreeFacts): string {
  const parts: string[] = [];
  if (facts.unmergedCommits === null) parts.push("commits this app could not count");
  else if (facts.unmergedCommits > 0) parts.push(`${facts.unmergedCommits} commit${facts.unmergedCommits === 1 ? "" : "s"} your checkout does not have`);
  if (facts.uncommittedFiles === null) parts.push("changes this app could not read");
  else if (facts.uncommittedFiles > 0) parts.push(`${facts.uncommittedFiles} uncommitted file${facts.uncommittedFiles === 1 ? "" : "s"}`);
  return parts.length === 2 ? `${parts[0]} and ${parts[1]}` : (parts[0] ?? "work");
}

async function readGoal(driver: SessionDriver | undefined): Promise<{ id: string; objective: string } | null> {
  if (!driver?.goalState) return null;
  try {
    const goal = await driver.goalState();
    return goal ? { id: goal.id, objective: goal.objective } : null;
  } catch {
    return null;
  }
}

function availableSentence(catalog: AgentCatalogEntry[]): string {
  return catalog.length === 0 ? "This session cannot start any agent." : `Available agents: ${catalog.map((row) => row.agentName).join(", ")}.`;
}

export function summarize(run: AgentRun): AgentRunSummary {
  return {
    agentName: run.agentName,
    subagentName: run.subagentName,
    sessionId: run.sessionId,
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.result ? { result: { status: run.result.status, message: excerpt(run.result.message, RESULT_EXCERPT) } } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.endedBy ? { endedBy: run.endedBy } : {}),
    ...(run.question ? { question: run.question } : {}),
  };
}

function statusWord(status: AgentRunTerminalStatus): string {
  switch (status) {
    case "completed":
      return "finished";
    case "blocked":
      return "is blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "was ended";
  }
}

function eventSummary(status: AgentRunTerminalStatus, run: AgentRun): string {
  switch (status) {
    case "completed":
      return "Finished and reported to the parent";
    case "blocked":
      return "Blocked; reported to the parent";
    case "failed":
      return run.error ?? "Failed";
    case "cancelled":
      return run.endedBy?.initiator === "user" ? "Ended by the person" : run.endedBy?.initiator === "parent" ? "Ended by the parent" : "Ended";
  }
}

/** How many of a child's last messages `inspect_agent` returns: the default, clamped to the cap. */
export function messageCount(value: unknown): number {
  if (value === undefined) return AGENT_INSPECT_MESSAGES_DEFAULT;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HarnessError(`messages must be a number from 0 to ${AGENT_INSPECT_MESSAGES_MAX}.`);
  return Math.min(AGENT_INSPECT_MESSAGES_MAX, Math.max(0, Math.floor(value)));
}

/** A dialog the child raised, in the run's vocabulary. */
export function questionOf(request: UiDialogRequest, toolName: string | undefined, askedAt: string): AgentRunQuestion {
  const base: AgentRunQuestion = {
    id: request.id,
    kind: request.method,
    title: request.title,
    askedAt,
    ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
  };
  switch (request.method) {
    case "select":
      return { ...base, options: [...request.options] };
    case "confirm":
      return { ...base, ...(request.message ? { detail: request.message } : {}) };
    case "input":
      return { ...base, ...(request.placeholder ? { detail: request.placeholder } : {}) };
    case "editor":
      return { ...base, ...(request.prefill ? { detail: request.prefill } : {}) };
  }
}

const YES = /^(y|yes|ok|okay|confirm|confirmed|approve|approved|allow|accept|true)[.!]?$/i;
const NO = /^(n|no|cancel|deny|denied|decline|reject|refuse|disallow|false)[.!]?$/i;

/**
 * The parent's message as an answer to the open question. A `select` takes
 * one of its options (or its 1-based number), a `confirm` takes a plain yes or
 * no, and `input` / `editor` take the text as it is. Anything else is refused
 * with the question restated, so a message meant as an instruction can never
 * silently pick an option.
 */
export function answerFor(question: AgentRunQuestion, message: string): UiDialogResponse {
  const text = message.trim();
  switch (question.kind) {
    case "select": {
      const options = question.options ?? [];
      const exact = options.find((option) => option === text) ?? options.find((option) => option.trim().toLowerCase() === text.toLowerCase());
      if (exact !== undefined) return { id: question.id, value: exact };
      const index = /^\d+$/.test(text) ? Number(text) : Number.NaN;
      if (Number.isInteger(index) && index >= 1 && index <= options.length) return { id: question.id, value: options[index - 1]! };
      throw new HarnessError(`That is not one of the choices. The question is "${question.title}"; answer with exactly one of: ${options.map((option) => JSON.stringify(option)).join(", ")}.`);
    }
    case "confirm":
      if (YES.test(text)) return { id: question.id, confirmed: true };
      if (NO.test(text)) return { id: question.id, confirmed: false };
      throw new HarnessError(`The question is "${question.title}"${question.detail ? ` — ${question.detail}` : ""}. Answer it with yes or no.`);
    case "input":
    case "editor":
      return { id: question.id, value: message };
  }
}

/** What the parent model reads when a child is paused on a question. */
export function questionMessage(run: AgentRun, question: AgentRunQuestion): string {
  const lines = [`${run.subagentName} is paused on a question and cannot continue until it is answered${question.toolName ? ` (raised by its ${question.toolName} tool)` : ""}.`, "", `Question (${question.kind}): ${question.title}`];
  if (question.detail) lines.push(question.detail);
  if (question.options) lines.push(`Choices: ${question.options.map((option) => JSON.stringify(option)).join(", ")}`);
  lines.push("", `${answerHint(question)} Or leave it: the person can answer it in ${run.subagentName}'s own chat. inspect_agent with runId ${run.runId} shows whether it is still open.`);
  return lines.join("\n");
}

/** How to answer this kind of question, in one sentence. */
export function answerHint(question: AgentRunQuestion): string {
  const call = "send_agent_message with its sessionId";
  switch (question.kind) {
    case "select":
      return `Answer it with ${call} and one of the choices, exactly, as the message.`;
    case "confirm":
      return `Answer it with ${call} and "yes" or "no" as the message.`;
    case "input":
      return `Answer it with ${call}; the message is the answer, verbatim.`;
    case "editor":
      return `Answer it with ${call}; the message replaces the text, verbatim.`;
  }
}

/** The sentence the parent model reads for a terminal run. */
export function modelMessage(run: AgentRun, context: string | undefined): string {
  let body: string;
  switch (run.status) {
    case "completed":
    case "blocked":
      body = run.result?.message ?? "";
      break;
    case "cancelled": {
      const who = run.endedBy?.initiator === "user" ? "The person ended this run." : run.endedBy?.initiator === "parent" ? "The parent ended this run." : "This run was ended.";
      body = run.endedBy?.reason ? `${who} Reason: ${run.endedBy.reason}` : who;
      break;
    }
    case "failed":
      body = run.error ?? "The run failed.";
      if (context) body += `\n\nThe agent's last message before it stopped:\n${context}`;
      break;
    default:
      body = "";
  }
  if (run.origin === "user") body = `${body}\n\n(This run was started by the person from the agent's own chat, not by you.)`;
  return body;
}

/**
 * The dialogs a driver still holds open, oldest first, or `undefined` for a
 * driver that cannot say. `StableSdkDriver.pendingUi()` is the one that can;
 * the seam interface does not carry it (the stub raises no dialogs), so this
 * reads it the same way the server does, by shape.
 */
function pendingUiOf(driver: SessionDriver | undefined): UiDialogRequest[] | undefined {
  const method = (driver as { pendingUi?: () => UiDialogRequest[] } | undefined)?.pendingUi;
  return typeof method === "function" ? method.call(driver) : undefined;
}

function contentTask(content: readonly ContentBlock[]): string {
  const text = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
  return text || "Continue this run with the attached content.";
}

function textOfMessage(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}
