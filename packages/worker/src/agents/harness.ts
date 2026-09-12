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
 *     through `send_agent_message` mode `answer`.
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
  SESSION_AGENT_ENTRY_TYPE,
  type WorktreeSetup,
  SUBAGENT_NAME_MAX,
  agentQuestionAnswerHint,
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
  type SessionUpdate,
  type UiDialogRequest,
  type UiDialogResponse,
} from "@lasercode/protocol";
import type {
  ClearedQueue,
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
import { SessionLifecycle, type InvocationBoundary, type InvocationControlTicket } from "./session-lifecycle.js";
import { runWorktreeSetup, type CreateWorktreeInput, type Worktree, type WorktreeFacts } from "./worktrees.js";

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
/** Why a run ends when the engine took its one message without starting a model turn (a handled slash command). */
export const HANDLED_WITHOUT_TURN = "Handled without a model turn.";
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
  setupGate?: { controller: AbortController; promise: Promise<WorktreeSetup> };
  /** Events for this session's model that arrived before its module registered a listener. */
  pendingEvents: AgentModelEvent[];
  /** One explicit owner/fence and one ordered successor inbox per child session. */
  lifecycle: SessionLifecycle<RunEnd, PendingMessage, InvocationOutcome, ControlContext>;
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

/** Which of Pi's two queues an engine-owned message went into; the engine drains each in order. */
type EngineLane = "steer" | "followUp";

interface PendingMessage {
  content: ContentBlock[];
  options?: PromptOptions;
  origin: "agent" | "user";
  /**
   * True when the engine also holds this message (a steer or follow-up queued
   * while it demonstrably streamed): the engine delivers it, and the harness
   * only takes it back through `clearQueue()` at a terminal declaration. False
   * for a message that waits here alone until the current invocation's promise
   * — the only engine-ready fence — resolves.
   */
  engine: boolean;
  /** Present exactly when `engine` is true. */
  lane?: EngineLane;
  /** Stable FIFO prefix used only while an invocation is fenced. */
  priority?: "interrupt" | "steer";
  /** Interrupt admission stays provisional until this control token succeeds. */
  interruptToken?: number;
  resolve?: (result: { accepted: boolean; queued: boolean }) => void;
  reject?: (error: unknown) => void;
  extension?: PendingExtensionWork;
}

/** What a parent's idle-path `send_agent_message` learns once admission is known (contract 5). */
interface KickAcknowledgement {
  delivery: "delivered" | "refused";
  error?: string;
}

type DiagnosticLevel = "info" | "warn";
type DiagnosticField = string | number | boolean | undefined;

interface RunEnd {
  status: AgentRunTerminalStatus;
  outcome: { result?: { status: "completed" | "blocked"; message: string }; error?: string; endedBy?: { initiator: AgentRunInitiator; reason?: string }; context?: string };
}

interface InvocationOutcome {
  result: { accepted: boolean; queued: boolean };
  failure?: string;
  modelWork?: boolean;
}

interface ControlContext {
  stop?: { initiator: AgentRunInitiator; reason?: string };
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

function isInterruptMessage(message: PendingMessage): boolean {
  return message.priority === "interrupt";
}

function isPriorityMessage(message: PendingMessage): boolean {
  return message.priority !== undefined;
}

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
      role: { ...input.role, ...(input.record.worktree && !input.record.worktree.removedAt && input.role.isolated !== false ? {
        environment: input.record.worktree.environment, setup: input.record.worktree.setup,
      } : {}) },
      definition: input.definition,
      record: input.record,
      projectCwd: input.projectCwd,
      bridge: undefined as unknown as AgentHarnessBridge,
      eventListeners: new Set(),
      roleListeners: new Set(),
      pendingEvents: [],
      lifecycle: new SessionLifecycle<RunEnd, PendingMessage, InvocationOutcome, ControlContext>(),
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
    // The run that can still write comes first: while an invocation unwinds a
    // declared completion, its successor is only waiting (contract 7).
    const owner = entry.lifecycle.owner();
    const latest = (owner ? this.runStates.get(owner) : undefined) ?? this.latestRun(sessionPath);
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

  /**
   * The session's driver closed: an active run is a failure, and the bridge is
   * forgotten. A successor still waiting behind a declared end fails too, with
   * a sentence that says its message never started — nothing queued is lost
   * silently, and whoever waits on it (a person's prompt, an extension's send)
   * is told.
   */
  detachSession(sessionPath: string): void {
    const entry = this.byPath.get(sessionPath);
    if (!entry) return;
    entry.setupGate?.controller.abort();
    this.diagnose(entry, "warn", "session-closed", { owner: entry.lifecycle.owner(), successor: entry.lifecycle.successor(), phase: entry.lifecycle.phase().kind });
    for (const state of this.runStates.values()) {
      if (state.run.sessionPath !== sessionPath || isTerminalRunStatus(state.run.status)) continue;
      // First terminal declaration wins, here too: a run whose tool already
      // declared its result keeps it; the close only ends what was still open.
      const declared = entry.lifecycle.end(state.run.runId);
      if (declared) {
        this.endRun(state, declared.status, declared.outcome);
        continue;
      }
      const error = state.run.status === "queued"
        ? "The agent's session closed before this queued message could start."
        : "The agent's session closed before it finished.";
      this.endRun(state, "failed", { error });
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
      lane: options?.streamingBehavior === "steer" ? "steer" : "followUp",
      resolve: resolveDeferred,
      reject: rejectDeferred,
    };
    const local = (): PendingMessage => {
      const { lane: _lane, ...rest } = message;
      void _lane;
      return { ...rest, engine: false };
    };
    const plan = await this.withEntry(entry, () => {
      const owner = entry.lifecycle.owner();
      const executing = owner ? this.runStates.get(owner) : undefined;
      if ((executing && entry.lifecycle.end(executing.run.runId)) || entry.lifecycle.successor()) {
        const successor = this.queueRunMessage(entry, local(), executing ?? this.activeRunState(sessionPath));
        this.diagnose(entry, "info", "admission", { source: "person", decision: "queued-successor", runId: successor.run.runId, owner, phase: entry.lifecycle.phase().kind });
        return { kind: "deferred" as const };
      }
      const active = executing ?? this.activeRunState(sessionPath);
      const state = active ?? this.createRun(entry, { origin: "user", task: contentTask(content) });
      const admission = entry.lifecycle.admitPrompt(
        state.run.runId,
        { local: local(), engine: message },
        { streaming: driver.state().isStreaming, explicitQueue: options?.streamingBehavior !== undefined },
      );
      this.diagnose(entry, "info", "admission", { source: "person", decision: admission, runId: state.run.runId, phase: entry.lifecycle.phase().kind });
      if (!active) this.event({ kind: "started", sessionPath, runId: state.run.runId, summary: "The person started a run from this chat" });
      if (admission === "local-queue") return { kind: "deferred" as const };
      return { kind: admission, state };
    });
    if (plan.kind === "deferred") {
      // A parked message holds no engine preflight, so the admission lease
      // the server took for it has done its one job — keeping the runtime
      // generation still through preflight — and is released now, not at the
      // message's eventual acceptance. Held that long, it wedges the session:
      // an extension send ahead of this message on the successor starts
      // through the server's wrapper, which waits for this very lease, while
      // the lease waits for an acceptance that only follows that send's turn
      // (the tray's drain at `agent_settled` reaches here). The kick that
      // later delivers the message holds no lease either; release is
      // idempotent, so the server's own `finally` is harmless.
      options?.admissionLease?.release();
      return deferred;
    }
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
   * A person emptied a child's queue (`pi/session/clear_queue`). The engine
   * drops what it held and reports the texts; the harness then forgets its
   * own engine-owned twins of those texts for the run that owns the session,
   * first match per lane like the transfer at a terminal declaration — so a
   * later `clearQueue()` at completion cannot replay onto a successor what
   * the person just removed. Messages waiting here alone (behind a fence,
   * on a reserved successor) are not the queue the person sees and stay.
   * Neither is a custom message an extension queued straight into a lane (a
   * background command's exit, a grandchild's ending): the person never saw
   * it and the model was promised it, so it is parked here as a message of
   * its own for the fence to deliver, and it never goes back to a composer.
   * Root sessions, and sessions this harness does not know, are the
   * driver's alone.
   */
  async clearQueue(sessionPath: string): Promise<{ steering: string[]; followUp: string[] }> {
    const entry = this.byPath.get(sessionPath);
    const driver = this.host.driver(sessionPath);
    if (!driver) return { steering: [], followUp: [] };
    if (!entry || entry.role.kind !== "child") return driver.clearQueue();
    return this.withEntry(entry, async () => {
      const { custom, ...cleared } = await driver.clearQueue();
      const owner = entry.lifecycle.owner();
      const state = owner ? this.runStates.get(owner) : this.activeRunState(sessionPath);
      if (!state) return cleared;
      const remaining: Record<EngineLane, string[]> = { steer: [...cleared.steering], followUp: [...cleared.followUp] };
      const kept: PendingMessage[] = [];
      let dropped = 0;
      for (const pending of entry.lifecycle.inbox(state.run.runId)) {
        if (!pending.engine) {
          kept.push(pending);
          continue;
        }
        const texts = remaining[pending.lane ?? "steer"];
        const index = texts.indexOf(contentTask(pending.content));
        if (index < 0) {
          kept.push(pending);
          continue;
        }
        texts.splice(index, 1);
        dropped += 1;
        settlePending(pending, new HarnessError("The person cleared this message from the agent's queue before it could start."));
      }
      const origin = state.run.origin === "user" ? "user" as const : "agent" as const;
      for (const text of [...(custom?.steering ?? []), ...(custom?.followUp ?? [])]) {
        kept.push({ content: [{ type: "text", text }], options: { expandPromptTemplates: false }, origin, engine: false });
      }
      entry.lifecycle.replaceInbox(state.run.runId, kept);
      this.diagnose(entry, "info", "queue-cleared", { runId: state.run.runId, clearedSteering: cleared.steering.length, clearedFollowUp: cleared.followUp.length, twins: dropped, custom: customCount({ ...cleared, ...(custom ? { custom } : {}) }), phase: entry.lifecycle.phase().kind });
      return cleared;
    });
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
    // Who started the work comes from the run record, once: `invoke` hands
    // `state.run.origin` to the driver on `PromptOptions.origin`, the driver
    // stamps the invocation with it, and a send made from inside that
    // invocation inherits it — so `request.origin` already says what the
    // owning run says. A stale capability from an older epoch earns nothing
    // and reads as agent work.
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
      const successor = this.queueRunMessage(entry, {
        content: request.content,
        origin,
        engine: false,
        extension: pending,
      }, executing ?? this.activeRunState(sessionPath));
      this.diagnose(entry, "info", "admission", { source: "extension", kind: request.kind, decision: "queued-successor", runId: successor.run.runId, owner, phase: phase.kind, causal });
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
      const successor = this.queueRunMessage(entry, {
        content: request.content,
        origin,
        engine: false,
        extension: pending,
      }, state);
      this.diagnose(entry, "info", "admission", { source: "extension", kind: request.kind, decision: "queued-successor", runId: successor.run.runId, phase: entry.lifecycle.phase().kind });
      return { admission: admission.promise, completion: completion.promise, joinsParent: false };
    }
    this.diagnose(entry, "info", "admission", { source: "extension", kind: request.kind, decision: standalone ? "invoke" : causal ? "joins-owner" : "engine-decides", runId: state.run.runId, phase: entry.lifecycle.phase().kind, causal });
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
    type StopPlan =
      | { kind: "done" }
      | { kind: "idle"; driver: SessionDriver }
      | { kind: "control"; ticket: InvocationControlTicket; driver: SessionDriver; wait: Promise<void> };
    const plan = await this.withEntry(entry, async (): Promise<StopPlan> => {
      if (isTerminalRunStatus(state.run.status)) return { kind: "done" };
      if (entry.lifecycle.cancelSuccessor(runId)) {
        this.event({ kind: "stop_requested", sessionPath: state.run.sessionPath, runId, summary: endedBy.initiator === "user" ? "The person asked this run to stop" : "The parent asked this run to stop" });
        this.diagnose(entry, "info", "successor-cancelled", { runId, initiator: endedBy.initiator });
        this.endRun(state, "cancelled", { endedBy });
        return { kind: "done" };
      }
      const owner = entry.lifecycle.owner();
      if (owner !== runId) {
        // No invocation can auto-resume queues for this run, but a driver that
        // still owns queued text must nevertheless prove takeover first.
        try {
          const preserved = await this.takeEngineQueue(entry, state, "stop");
          this.retainTakenMessages(entry, state, preserved);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.diagnose(entry, "warn", "stop-control-failed", { runId, stage: "clear-queue", error: reason });
          throw new HarnessError(`Could not stop this agent safely: ${reason}`);
        }
        const driver = this.host.driver(state.run.sessionPath);
        if (!driver) throw new HarnessError("The agent session is no longer open.");
        return { kind: "idle", driver };
      }

      let preserved: PendingMessage[];
      try {
        preserved = await this.takeEngineQueue(entry, state, "stop");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnose(entry, "warn", "stop-control-failed", { runId, stage: "clear-queue", error: reason });
        throw new HarnessError(`Could not stop this agent safely: ${reason}`);
      }
      this.retainTakenMessages(entry, state, preserved);
      const ticket = entry.lifecycle.beginStop(runId, {
        waitForExecution: !this.host.driver(state.run.sessionPath)?.state().isStreaming,
        context: { stop: endedBy },
        interruptOutcome: { ok: false, cancelled: true, error: "The agent was explicitly stopped before the interrupt redirect could start." },
      });
      const driver = this.host.driver(state.run.sessionPath);
      if (!ticket || !driver) throw new HarnessError("The agent invocation ended before stop control could be established.");
      if (ticket.refusedInterruptToken !== undefined) this.removeProvisionalInterrupt(entry, runId, ticket.refusedInterruptToken);
      this.cancelControlledDialogs(entry, state);
      return { kind: "control", ticket, driver, wait: entry.lifecycle.waitForTerminal(runId) };
    });
    if (plan.kind === "done") return state.run;
    if (plan.kind === "idle") {
      try {
        await plan.driver.abort();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.withEntry(entry, () => {
          const next = entry.lifecycle.nextLocalAfterFence(runId, (pending) => pending.engine);
          if (next) this.kickMessage(state, next);
        });
        throw new HarnessError(`Could not stop this agent safely: ${reason}`);
      }
      await this.withEntry(entry, () => {
        if (isTerminalRunStatus(state.run.status)) return;
        this.event({ kind: "stop_requested", sessionPath: state.run.sessionPath, runId, summary: endedBy.initiator === "user" ? "The person asked this run to stop" : "The parent asked this run to stop" });
        this.commitQueuedCancellation(entry, state, endedBy);
        this.endRun(state, "cancelled", { endedBy });
      });
      return state.run;
    }
    if (plan.ticket.created && entry.lifecycle.startAbort(runId, plan.ticket.token, "initial")) {
      void this.controlInvocation(entry, state, plan.driver, plan.ticket.token, "initial");
    }
    const controlled = await plan.ticket.outcome;
    if (!controlled.ok) throw new HarnessError(controlled.error);
    await plan.wait;
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
    if (event.type === "update" && event.invocation && !entry.lifecycle.ownsInvocation(event.invocation)) {
      if (isLifecycleKind(event.update.kind)) {
        this.diagnose(entry, "info", "late-callback-dropped", { kind: event.update.kind, invocation: event.invocation.id, invocationRun: event.invocation.runId, owner: entry.lifecycle.owner(), phase: entry.lifecycle.phase().kind });
      }
      return;
    }
    // A dialog is raised from inside the tool that asks, so a driver with
    // epochs stamps it with the invocation it was raised under, and the same
    // fence applies: a question from an invocation the session no longer
    // owns (its run's end declared or published, a successor now standing)
    // is never the successor's question. It has nobody here to answer it
    // either, and the portable surface's rule is that what cannot be routed
    // cancels rather than hangs (AGENTS.md §4.6): the asker gets its
    // fallback. A stamp without a run (a person's own command invocation on
    // this session) is only left unattributed — the person raised it and
    // can answer it in the chat. Unstamped dialogs keep the run-scoped
    // fallback for drivers without epochs.
    if ((event.type === "ui_request" || event.type === "ui_event") && event.invocation && !entry.lifecycle.ownsInvocation(event.invocation)) {
      const kind = event.type === "ui_request" ? `ui_request:${event.request.method}` : `ui_event:${event.event.method}`;
      this.diagnose(entry, "info", "late-callback-dropped", { kind, invocation: event.invocation.id, invocationRun: event.invocation.runId, owner: entry.lifecycle.owner(), phase: entry.lifecycle.phase().kind, ...(event.type === "ui_request" ? { dialog: event.request.id } : {}) });
      if (event.type === "ui_request" && event.invocation.runId !== undefined) this.cancelDialog(sessionPath, event.request.id);
      return;
    }
    if (
      event.type === "update"
      && event.update.kind === "extension_error"
      && !event.invocation
      && this.host.driver(sessionPath)?.setExtensionModelWorkHandler
    ) return;
    const owner = entry.lifecycle.owner();
    const active = owner ? this.runStates.get(owner) : this.activeRunState(sessionPath);
    // An interrupt or stop requested during asynchronous preflight can reach
    // an idle driver before its native turn exists. The lifecycle retains that
    // exact owner and asks for another abort only on its stamped execution.
    if (
      event.type === "update"
      && active
      && owner === active.run.runId
      && (event.update.kind === "turn_start" || event.update.kind === "tool_execution_start")
    ) {
      const action = entry.lifecycle.executionStarted(active.run.runId);
      const driver = this.host.driver(sessionPath);
      if (action && driver && entry.lifecycle.startAbort(active.run.runId, action.token, "execution")) {
        void this.controlInvocation(entry, active, driver, action.token, "execution");
      }
    }
    // An invocation that keeps going after its run's end was declared (a tool
    // later in the same batch, or a model turn after a mixed batch) is the
    // exact window the incident lived in: say so, never hide it (contract 7).
    if (event.type === "update" && active && (event.update.kind === "turn_start" || event.update.kind === "tool_execution_start") && entry.lifecycle.end(active.run.runId)) {
      this.diagnose(entry, "warn", "executing-after-declared-end", { runId: active.run.runId, kind: event.update.kind, invocation: event.invocation?.id, ...(event.update.kind === "tool_execution_start" ? { tool: event.update.toolName } : {}) });
    }
    // A question through the portable UI surface pauses the child's loop
    // until someone answers, so the run is `needs_input` for exactly as long
    // as the question is open — the answer may come from the parent (through
    // `send_agent_message` mode `answer`), from the person (in the child's own chat, which
    // this harness never sees), from a timeout or from an abort, so the open
    // questions are re-read from the driver rather than tracked by hand.
    if (event.type === "ui_request") {
      if (active) {
        const owned = entry.lifecycle.recordDialog(active.run.runId, event.request.id, event.invocation?.id);
        if (owned.cancel) {
          this.cancelDialog(sessionPath, event.request.id);
          entry.lifecycle.resolveDialog(active.run.runId, event.request.id);
          this.reconcileQuestion(active, event.request.id);
        } else {
          this.ask(active, event.request);
        }
      }
      return;
    }
    if (event.type === "ui_event") {
      if (active && event.event.method === "dialogResolved") {
        entry.lifecycle.resolveDialog(active.run.runId, event.event.id);
        this.reconcileQuestion(active, event.event.id);
      }
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
            // The engine drained its own lanes before it settled: an
            // engine-owned twin is consumed, and only local messages remain.
            const next = entry.lifecycle.nextLocalAfterFence(active.run.runId, (pending) => pending.engine);
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
      ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit, ...(worktree.environment ? { environment: worktree.environment } : {}), ...(worktree.setup ? { setup: worktree.setup } : {}) } } : {}),
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
    if (worktree?.setup?.status === "pending") {
      const controller = new AbortController();
      const promise = runWorktreeSetup(parent.projectCwd, worktree, controller.signal)
        .catch((): WorktreeSetup => ({ status: "failed", exitCode: null, logPath: worktree.setup!.status === "not-present" ? "" : worktree.setup!.logPath }))
        .then(async (setup) => {
          worktree.setup = setup;
          if (entry.record.worktree) entry.record.worktree = { ...entry.record.worktree, setup };
          entry.role = { ...entry.role, setup };
          this.touch(runState, (run) => ({ ...run, worktree: run.worktree ? { ...run.worktree, setup } : null }));
          for (const listener of [...entry.roleListeners]) { try { listener(entry.role); } catch { /* Observers are isolated. */ } }
          await childDriver?.appendEntry?.(SESSION_AGENT_ENTRY_TYPE, entry.record).catch(() => undefined);
          return setup;
        });
      entry.setupGate = { controller, promise };
    }
    void this.kick(runState, task);
    return {
      agentName,
      subagentName,
      sessionId: state.id,
      runId,
      status: "running",
      cwd: childCwd,
      ...(worktree ? { branch: worktree.branch, environment: worktree.environment, setup: worktree.setup } : {}),
    };
  }

  private async sendAgentMessage(parent: Entry, input: SendAgentMessageInput): Promise<SendAgentMessageResult> {
    if (!parent.path) throw new HarnessError("This session is not ready yet.");
    const sessionId = (input.sessionId ?? "").trim();
    const message = (input.message ?? "").trim();
    const mode = input.mode;
    if (message === "") throw new HarnessError("message is required.");
    if (message.length > AGENT_MESSAGE_MAX) throw new HarnessError(`message must be at most ${AGENT_MESSAGE_MAX} characters.`);
    const child = [...this.byPath.values()].find((entry) => entry.sessionId === sessionId && entry.record.parentPath === parent.path);
    if (!child || !child.path) {
      throw new HarnessError(`No agent session is called "${sessionId}" among the agents this session started. Use the sessionId that start_agent returned.`);
    }
    type Plan =
      | { kind: "result"; result: SendAgentMessageResult }
      | { kind: "queued"; state: RunState }
      | { kind: "interrupt"; state: RunState; owner: RunState; ticket: InvocationControlTicket; driver: SessionDriver }
      | { kind: "kicked"; state: RunState; acknowledged: Promise<KickAcknowledgement> };
    // The routing decision and any queue takeover happen under the entry lock.
    // Prompt/control acknowledgements wait outside it because their fences
    // finish by taking the same lock.
    const plan = await this.withEntry(child, async (): Promise<Plan> => {
      const driver = this.host.driver(child.path!);
      if (!driver) throw new HarnessError(`The agent session "${sessionId}" is no longer open.`);
      const ownerId = child.lifecycle.owner();
      const executing = ownerId ? this.runStates.get(ownerId) : undefined;
      const active = executing ?? this.activeRunState(child.path!);
      const latest = active ?? this.latestRun(child.path!);

      if (mode === "answer") {
        if (active?.run.status === "needs_input") this.reconcileQuestion(active);
        const question = active?.run.status === "needs_input" ? active.run.question : undefined;
        if (!active || !question || child.lifecycle.end(active.run.runId)) {
          if (!latest) throw new HarnessError("No run exists in this agent session.");
          const error = "This agent has no open question to answer. Use interrupt, steer, or queue for an instruction.";
          return { kind: "result", result: { sessionId, runId: latest.run.runId, status: latest.run.status, delivery: "refused", error } };
        }
        try {
          driver.respondToUi(answerFor(question, message));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { kind: "result", result: { sessionId, runId: active.run.runId, status: active.run.status, delivery: "refused", error: reason, question } };
        }
        child.lifecycle.resolveDialog(active.run.runId, question.id);
        this.reconcileQuestion(active, question.id);
        this.diagnose(child, "info", "admission", { source: "parent", decision: "answered", runId: active.run.runId, question: question.id, mode });
        this.event({ kind: "message_sent", sessionPath: parent.path!, runId: active.run.runId, counterpart: { sessionPath: child.path!, label: labelOf(child.role) }, summary: `Answered ${labelOf(child.role)}'s question` });
        this.event({ kind: "message_received", sessionPath: child.path!, runId: active.run.runId, counterpart: { sessionPath: parent.path!, label: labelOf(parent.role) }, summary: `Answer from ${labelOf(parent.role)}` });
        return { kind: "result", result: { sessionId, runId: active.run.runId, status: active.run.status, delivery: "answered", answered: question } };
      }

      const declared = executing ? child.lifecycle.end(executing.run.runId) : undefined;
      if (mode === "interrupt" && executing) {
        const existing = child.lifecycle.control(executing.run.runId);
        if (existing?.kind === "stop") {
          return { kind: "result", result: { sessionId, runId: executing.run.runId, status: executing.run.status, delivery: "refused", error: "This agent is already stopping." } };
        }
        let preserved: PendingMessage[] = [];
        if (!existing) {
          try {
            preserved = await this.takeEngineQueue(child, executing, "interrupt");
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.diagnose(child, "warn", "interrupt-control-failed", { runId: executing.run.runId, stage: "clear-queue", error: reason });
            return { kind: "result", result: { sessionId, runId: executing.run.runId, status: executing.run.status, delivery: "control_failed", error: `Could not interrupt this agent safely: ${reason}` } };
          }
        }
        const ticket = child.lifecycle.beginInterrupt(executing.run.runId, { waitForExecution: !driver.state().isStreaming, context: {} });
        if (!ticket) throw new HarnessError("The agent invocation ended before interruption control could be established.");
        const pending: PendingMessage = {
          content: [{ type: "text", text: message }],
          options: { expandPromptTemplates: false },
          origin: "agent",
          engine: false,
          priority: "interrupt",
          interruptToken: ticket.token,
        };
        let target: RunState;
        if (declared || child.lifecycle.successor()) {
          for (const queued of preserved) this.queueRunMessage(child, queued, executing);
          target = this.queueRunMessage(child, pending, executing, parent);
          child.lifecycle.remove(target.run.runId, pending);
          child.lifecycle.enqueuePriority(target.run.runId, pending, isInterruptMessage);
        } else {
          this.retainTakenMessages(child, executing, preserved);
          child.lifecycle.enqueuePriority(executing.run.runId, pending, isInterruptMessage);
          target = executing;
        }
        this.cancelControlledDialogs(child, executing);
        this.diagnose(child, "info", "admission", { source: "parent", decision: "interrupt-fenced", runId: target.run.runId, owner: executing.run.runId, phase: child.lifecycle.phase().kind, token: ticket.token });
        return { kind: "interrupt", state: target, owner: executing, ticket, driver };
      }

      if (declared || child.lifecycle.successor()) {
        const pending: PendingMessage = {
          content: [{ type: "text", text: message }],
          options: { expandPromptTemplates: false },
          origin: "agent",
          engine: false,
          ...(mode === "steer" ? { priority: "steer" as const } : {}),
        };
        const state = this.queueRunMessage(child, pending, executing ?? active, parent);
        if (isPriorityMessage(pending)) {
          child.lifecycle.remove(state.run.runId, pending);
          child.lifecycle.enqueuePriority(state.run.runId, pending, isPriorityMessage);
        }
        this.diagnose(child, "info", "admission", { source: "parent", decision: "queued-successor", runId: state.run.runId, owner: ownerId, mode, phase: child.lifecycle.phase().kind });
        return { kind: "queued", state };
      }
      if (active) {
        if (driver.state().isStreaming || ownerId !== undefined) {
          const interrupted = ownerId !== undefined && child.lifecycle.control(ownerId) !== undefined;
          const engine = driver.state().isStreaming && !interrupted;
          const lane: EngineLane = mode === "steer" ? "steer" : "followUp";
          const pending: PendingMessage = {
            content: [{ type: "text", text: message }],
            origin: "agent",
            engine,
            ...(engine ? { lane } : {}),
            ...(!engine && mode === "steer" ? { priority: "steer" as const } : {}),
          };
          if (isPriorityMessage(pending)) child.lifecycle.enqueuePriority(active.run.runId, pending, isPriorityMessage);
          else child.lifecycle.enqueue(active.run.runId, pending);
          if (engine) {
            try {
              if (lane === "steer") await driver.steer(pending.content);
              else await driver.followUp(pending.content);
            } catch (error) {
              child.lifecycle.remove(active.run.runId, pending);
              throw error;
            }
          }
          this.diagnose(child, "info", "admission", { source: "parent", decision: engine ? `engine-${lane}` : "local-queue", runId: active.run.runId, mode, phase: child.lifecycle.phase().kind });
          return { kind: "queued", state: active };
        }
        this.diagnose(child, "info", "admission", { source: "parent", decision: "invoke", runId: active.run.runId, mode, phase: child.lifecycle.phase().kind });
        return { kind: "kicked", state: active, acknowledged: this.kickAcknowledged(active, message) };
      }
      const state = this.createRun(child, { origin: "agent", task: message, goal: await readGoal(this.host.driver(parent.path!)), parentRunId: this.activeRun(parent.path!)?.runId });
      this.diagnose(child, "info", "admission", { source: "parent", decision: "invoke", runId: state.run.runId, mode, phase: child.lifecycle.phase().kind, created: true });
      return { kind: "kicked", state, acknowledged: this.kickAcknowledged(state, message) };
    });
    if (plan.kind === "result") return plan.result;

    const { state } = plan;
    let delivery: SendAgentMessageResult["delivery"] = "queued";
    let error: string | undefined;
    if (plan.kind === "kicked") {
      ({ delivery, error } = await plan.acknowledged);
    } else if (plan.kind === "interrupt") {
      if (plan.ticket.created && child.lifecycle.startAbort(plan.owner.run.runId, plan.ticket.token, "initial")) {
        void this.controlInvocation(child, plan.owner, plan.driver, plan.ticket.token, "initial");
      }
      const controlled = await plan.ticket.outcome;
      if (!controlled.ok) {
        delivery = controlled.cancelled ? "refused" : "control_failed";
        error = controlled.error;
      }
    }
    if (delivery === "refused" || delivery === "control_failed") {
      this.event({ kind: "message_sent", sessionPath: parent.path!, runId: state.run.runId, counterpart: { sessionPath: child.path!, label: labelOf(child.role) }, summary: `${labelOf(child.role)} could not take the message` });
      return { sessionId, runId: state.run.runId, status: state.run.status, delivery, ...(error !== undefined ? { error } : {}) };
    }
    this.event({ kind: "message_sent", sessionPath: parent.path!, runId: state.run.runId, counterpart: { sessionPath: child.path!, label: labelOf(child.role) }, summary: `Sent a message to ${labelOf(child.role)}` });
    this.event({ kind: "message_received", sessionPath: child.path!, runId: state.run.runId, counterpart: { sessionPath: parent.path!, label: labelOf(parent.role) }, summary: `Message from ${labelOf(parent.role)}` });
    return { sessionId, runId: state.run.runId, status: state.run.status, delivery };
  }

  /**
   * Start one prompt for a parent's message and say what became of it at the
   * engine's preflight: accepted (the engine owns it as its next turn) or
   * refused (the run records the failure and its reason). Resolves exactly
   * once, on whichever comes first, and never before admission is known.
   */
  private kickAcknowledged(state: RunState, text: string): Promise<KickAcknowledgement> {
    const acknowledged = deferred<KickAcknowledgement>();
    const settle = (result: KickAcknowledgement) => acknowledged.resolve(result);
    const refused = () => settle({ delivery: "refused", error: state.run.error ?? "The agent's session refused the task because it was busy." });
    this.kickMessage(state, {
      content: [{ type: "text", text }],
      options: { expandPromptTemplates: false, onAccepted: () => settle({ delivery: "delivered" }) },
      origin: "agent",
      engine: false,
      resolve: (result) => (result.accepted ? settle({ delivery: "delivered" }) : refused()),
      reject: () => refused(),
    });
    return acknowledged.promise;
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
      ...(run.worktree?.environment ? { environment: run.worktree.environment } : {}),
      ...(run.worktree?.setup ? { setup: run.worktree.setup } : {}),
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
      if (!active || active.completedByTool || child.lifecycle.end(active.run.runId) || child.lifecycle.control(active.run.runId)?.kind === "stop" || isTerminalRunStatus(active.run.status)) {
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
      this.diagnose(child, "info", "terminal-declared", { runId: active.run.runId, status: input.status, invoking, phase: child.lifecycle.phase().kind });
      // A terminating tool stops further model calls only while Pi's queues
      // are empty at its next poll (agent-loop.js: `getSteeringMessages` after
      // the batch, `getFollowUpMessages` after the inner loop). Empty them now,
      // inside the tool, and preserve every message as the next tracked run.
      await this.transferEngineQueue(child, active, "complete");

      // Fake/idle drivers may invoke the bridge outside a prompt. Real Pi is
      // still streaming here; its prompt promise is the engine-ready fence,
      // and the branch below cannot fire under it: `complete_agent_run` only
      // executes inside a prompt this harness admitted (`invoke`,
      // `executeExtension`), and each of those owns the lifecycle first.
      if (!invoking) {
        const driver = this.host.driver(child.path!);
        if (driver?.state().isStreaming) {
          this.diagnose(child, "warn", "terminal-published-without-owner", { runId: active.run.runId, status: input.status, streaming: true });
        }
        this.endRun(active, end.status, end.outcome);
      }
      return { ok: true, runId: active.run.runId };
    });
  }

  /** Commit accepted-message cancellation only after stop abort control succeeds. */
  private commitQueuedCancellation(entry: Entry, state: RunState, endedBy: { initiator: AgentRunInitiator; reason?: string }): void {
    const reason = new Error(`The agent's run ${state.run.runId} was explicitly stopped before this message could start.`);
    for (const pending of entry.lifecycle.clearInbox(state.run.runId)) settlePending(pending, reason);
    const successor = entry.lifecycle.takeSuccessor();
    if (!successor) return;
    if (successor.first) settlePending(successor.first, reason);
    const queued = this.runStates.get(successor.runId);
    for (const pending of entry.lifecycle.clearInbox(successor.runId)) settlePending(pending, reason);
    if (queued && !isTerminalRunStatus(queued.run.status)) {
      this.diagnose(entry, "info", "successor-cancelled", { runId: queued.run.runId, predecessor: state.run.runId, initiator: endedBy.initiator });
      this.endRun(queued, "cancelled", { endedBy });
    }
  }

  /** Put a successful queue takeover back under canonical lifecycle ownership until control commits. */
  private retainTakenMessages(entry: Entry, state: RunState, preserved: readonly PendingMessage[]): void {
    if (entry.lifecycle.end(state.run.runId) || entry.lifecycle.successor()) {
      for (const pending of preserved) this.queueRunMessage(entry, pending, state);
      return;
    }
    for (const pending of preserved) {
      if (isPriorityMessage(pending)) entry.lifecycle.enqueuePriority(state.run.runId, pending, isPriorityMessage);
      else entry.lifecycle.enqueue(state.run.runId, pending);
    }
  }

  /** Cancel every still-open dialog recorded under this exact controlled owner. */
  private cancelControlledDialogs(entry: Entry, state: RunState): void {
    const driver = this.host.driver(state.run.sessionPath);
    const pending = pendingUiOf(driver);
    const ids = entry.lifecycle.ownedDialogs(
      state.run.runId,
      pending === undefined ? undefined : new Set(pending.map((request) => request.id)),
    );
    for (const id of ids) {
      this.cancelDialog(state.run.sessionPath, id);
      entry.lifecycle.resolveDialog(state.run.runId, id);
    }
    if (ids.length > 0) this.reconcileQuestion(state);
  }

  /** Strict queue takeover before either interrupt or stop control is claimed. */
  private async takeEngineQueue(entry: Entry, state: RunState, reason: "interrupt" | "stop"): Promise<PendingMessage[]> {
    const driver = this.host.driver(state.run.sessionPath);
    if (!driver) throw new Error("The agent session is no longer open.");
    const before = entry.lifecycle.inbox(state.run.runId).length;
    const cleared = await driver.clearQueue();
    const custom = customCount(cleared);
    if (custom > 0) {
      this.diagnose(entry, "warn", "engine-custom-queued", { runId: state.run.runId, reason, steering: cleared.custom?.steering.length ?? 0, followUp: cleared.custom?.followUp.length ?? 0 });
    }
    const preserved = this.preservedMessages(entry, state, cleared);
    this.diagnose(entry, "info", "queue-taken", { runId: state.run.runId, reason, clearedSteering: cleared.steering.length, clearedFollowUp: cleared.followUp.length, local: before, preserved: preserved.length, custom });
    return preserved;
  }

  /**
   * Take back every message the engine still queues for this run and every
   * message waiting here, and put them, in order, on the one successor run
   * (contract 2). Called under the entry's lock, before any abort: Pi's abort
   * leaves its queues alone and its post-run loop would continue with them.
   * A queue that cannot be read is treated as unknown — every locally known
   * message is replayed (never lost, possibly repeated) and the invocation is
   * aborted without awaiting the prompt that may be executing this very tool.
   */
  private async transferEngineQueue(entry: Entry, state: RunState, reason: "complete" | "stop" | "extension-error"): Promise<void> {
    const driver = this.host.driver(state.run.sessionPath);
    let preserved: PendingMessage[];
    let counts: Record<string, DiagnosticField>;
    if (!driver) {
      preserved = this.preservedMessages(entry, state, { steering: [], followUp: [] });
      counts = { cleared: 0, local: preserved.length };
    } else {
      try {
        const cleared = await driver.clearQueue();
        const before = entry.lifecycle.inbox(state.run.runId).length;
        const custom = customCount(cleared);
        if (custom > 0) {
          // An extension's send behind the running turn went straight into
          // the engine's lanes, where this harness had no record of it and
          // the engine's own queue never listed it. It is kept below as a
          // message of its own (its text; the custom type is gone) — said
          // out loud, because the engine would have dropped it here.
          this.diagnose(entry, "warn", "engine-custom-queued", { runId: state.run.runId, reason, steering: cleared.custom?.steering.length ?? 0, followUp: cleared.custom?.followUp.length ?? 0 });
        }
        preserved = this.preservedMessages(entry, state, cleared);
        counts = { clearedSteering: cleared.steering.length, clearedFollowUp: cleared.followUp.length, local: before, preserved: preserved.length, custom };
      } catch (error) {
        preserved = entry.lifecycle.clearInbox(state.run.runId);
        counts = { cleared: "unknown", local: preserved.length, preserved: preserved.length, error: error instanceof Error ? error.name : "error" };
        this.diagnose(entry, "warn", "engine-queue-unreadable", { runId: state.run.runId, reason, ...counts });
        this.diagnose(entry, "info", "abort-requested", { runId: state.run.runId, reason: "engine-queue-unreadable" });
        this.scheduleAbort(driver);
      }
    }
    for (const pending of preserved) this.queueRunMessage(entry, pending, state);
    this.diagnose(entry, "info", "queue-transferred", { runId: state.run.runId, reason, successor: entry.lifecycle.successor(), ...counts });
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
      // Every ending of a run that could have a successor reserved behind it
      // goes through `finalizePendingEnd`, the one place that takes the
      // successor; a session with no entry has nothing waiting on it.
      const end: RunEnd = { status: "failed", outcome: { error: "The agent's session is not open." } };
      if (entry) this.finalizePendingEnd(entry, state, end);
      else this.endRun(state, end.status, end.outcome);
      return;
    }
    if (!entry.lifecycle.begin(state.run.runId)) {
      entry.lifecycle.enqueue(state.run.runId, message);
      this.diagnose(entry, "info", "kick-deferred", { runId: state.run.runId, owner: entry.lifecycle.owner(), phase: entry.lifecycle.phase().kind });
      return;
    }
    this.diagnose(entry, "info", "invocation-begun", { runId: state.run.runId, origin: message.origin, extension: message.extension !== undefined });
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
    // With an exact epoch from the driver, the harness can tell whether the
    // engine ever started a turn under this invocation: `turn_start` counts
    // toward the run only when its stamp is owned. Without one (legacy and
    // fake drivers), that is unknowable here and stays undecided.
    let stamped = false;
    const turnsBefore = state.run.activity?.turns ?? 0;
    const acceptedObserver = () => {
      accepted = true;
      this.diagnose(entry, "info", "invocation-accepted", { runId: state.run.runId, phase: entry.lifecycle.phase().kind });
      options?.onAccepted?.();
    };
    try {
      const gate = entry.setupGate;
      if (gate) {
        const setup = await gate.promise;
        if (entry.setupGate === gate) delete entry.setupGate;
        if (setup.status === "cancelled" || entry.lifecycle.control(state.run.runId) || isTerminalRunStatus(state.run.status) || this.byPath.get(state.run.sessionPath) !== entry) {
          const result = { accepted: false, queued: false };
          await this.withEntry(entry, () => this.afterInvocation(entry, state, result, undefined, false));
          return result;
        }
      }
      result = await driver.prompt(content, driver.setExtensionModelWorkHandler
        ? {
            ...options,
            ownerRunId: state.run.runId,
            // The run record is the one source of who started this work; the
            // driver stamps its invocation with it so a send made from inside
            // the turn inherits it (`admitExtensionModelWork` reads it back).
            origin: state.run.origin,
            onInvocation: (invocation) => {
              if (!entry.lifecycle.bindInvocation(state.run.runId, invocation)) {
                throw new HarnessError("The prompt invocation lost session ownership before it could start.");
              }
              stamped = true;
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
    const modelWork = stamped ? (state.run.activity?.turns ?? 0) > turnsBefore : undefined;
    await this.withEntry(entry, () => this.afterInvocation(entry, state, result, failure, modelWork));
    if (thrown !== undefined) throw thrown;
    return result;
  }

  /**
   * The invocation's promise resolved: the one engine-ready fence. `modelWork`
   * says whether the engine started a turn under it — `false` only when the
   * driver stamped the invocation and no turn was counted, `undefined` when
   * that cannot be known.
   */
  private afterInvocation(
    entry: Entry,
    state: RunState,
    result: { accepted: boolean; queued: boolean },
    failure?: string,
    modelWork?: boolean,
  ): void {
    const invocation: InvocationOutcome = { result, ...(failure !== undefined ? { failure } : {}), ...(modelWork !== undefined ? { modelWork } : {}) };
    const boundary = entry.lifecycle.finish(state.run.runId, invocation);
    if (!boundary) {
      this.diagnose(entry, "info", "late-invocation-ignored", { runId: state.run.runId, owner: entry.lifecycle.owner(), status: state.run.status });
      return;
    }
    if ("fenced" in boundary) {
      this.diagnose(entry, "info", "invocation-fenced", { runId: state.run.runId, accepted: result.accepted, status: state.run.status, modelWork });
      const control = entry.lifecycle.control(state.run.runId);
      const driver = this.host.driver(state.run.sessionPath);
      if (control && driver && entry.lifecycle.startAbort(state.run.runId, control.token, "execution")) {
        void this.controlInvocation(entry, state, driver, control.token, "execution");
      }
      return;
    }
    this.finishInvocationBoundary(entry, state, boundary, result, failure, modelWork, false);
  }

  private finishInvocationBoundary(
    entry: Entry,
    state: RunState,
    boundary: InvocationBoundary<RunEnd>,
    result: { accepted: boolean; queued: boolean },
    failure?: string,
    modelWork?: boolean,
    interrupted = false,
  ): void {
    this.diagnose(entry, "info", "invocation-finished", { runId: state.run.runId, accepted: result.accepted, settled: boundary.settled, declared: boundary.end?.status, status: state.run.status, modelWork, interrupted });
    if (isTerminalRunStatus(state.run.status)) return;
    const end = boundary.end ?? (!result.accepted && !interrupted
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
    if (boundary.settled) {
      this.settled(entry, state);
      return;
    }
    if (modelWork !== false) return;
    // The engine took the message and ran no model work on it — a slash
    // command its `input` hook handled — and nothing else waits. A run that
    // never saw a turn is a record of nothing: it ends quietly, in the
    // neutral word (Ended, not Failed), and its parent, which was never told
    // it began, is not woken for it. A run that did work earlier and settled
    // without the tool is judged as such: the command changed nothing.
    if ((state.run.activity?.turns ?? 0) > 0) {
      this.settled(entry, state);
      return;
    }
    this.diagnose(entry, "info", "handled-without-turn", { runId: state.run.runId, origin: state.run.origin });
    this.finalizePendingEnd(entry, state, { status: "cancelled", outcome: { endedBy: { initiator: "harness", reason: HANDLED_WITHOUT_TURN } } }, { wakeParent: false });
  }

  /** Run one lifecycle-authorized abort outside its lock, then feed the result back. */
  private async controlInvocation(
    entry: Entry,
    state: RunState,
    driver: SessionDriver,
    token: number,
    attempt: "initial" | "execution",
  ): Promise<void> {
    let failure: string | undefined;
    try {
      const control = entry.lifecycle.control(state.run.runId);
      this.diagnose(entry, "info", "abort-requested", {
        runId: state.run.runId,
        reason: attempt === "execution" ? "controlled-invocation-started" : control?.kind === "stop" ? "stop" : "parent-interrupt",
        token,
      });
      entry.setupGate?.controller.abort();
      await driver.abort();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    let retry = false;
    await this.withEntry(entry, () => {
      const transition = entry.lifecycle.settleAbort(
        state.run.runId,
        token,
        failure === undefined ? { ok: true } : { ok: false, error: `Could not control this agent safely: ${failure}` },
      );
      if (transition.kind === "pending") return;
      if (transition.kind === "retry") {
        retry = entry.lifecycle.startAbort(state.run.runId, transition.token, "execution");
        return;
      }
      if (transition.kind === "failed") {
        if (transition.control === "interrupt") this.removeProvisionalInterrupt(entry, state.run.runId, transition.token);
        this.diagnose(entry, "warn", transition.control === "stop" ? "stop-control-failed" : "interrupt-control-failed", { runId: state.run.runId, stage: "abort", control: transition.control, token, error: failure ?? "unknown" });
        if (transition.finished) {
          const { boundary, invocation } = transition.finished;
          this.finishInvocationBoundary(entry, state, boundary, invocation.result, invocation.failure, invocation.modelWork, false);
        }
        return;
      }
      if (transition.control === "stop") {
        const endedBy = transition.context.stop;
        if (!endedBy) throw new Error("Stop control lost its initiator.");
        this.event({ kind: "stop_requested", sessionPath: state.run.sessionPath, runId: state.run.runId, summary: endedBy.initiator === "user" ? "The person asked this run to stop" : "The parent asked this run to stop" });
        if (!entry.lifecycle.end(state.run.runId)) {
          entry.lifecycle.declareEnd(state.run.runId, { status: "cancelled", outcome: { endedBy } });
          this.diagnose(entry, "info", "terminal-declared", { runId: state.run.runId, status: "cancelled", initiator: endedBy.initiator, phase: entry.lifecycle.phase().kind });
        } else {
          this.diagnose(entry, "info", "stop-after-declared-end", { runId: state.run.runId, initiator: endedBy.initiator, declared: entry.lifecycle.end(state.run.runId)?.status });
        }
        this.commitQueuedCancellation(entry, state, endedBy);
      }
      const finished = entry.lifecycle.commitControl(state.run.runId, transition.token);
      if (finished) {
        const { boundary, invocation } = finished;
        this.finishInvocationBoundary(entry, state, boundary, invocation.result, invocation.failure, invocation.modelWork, true);
      }
    });
    if (retry) await this.controlInvocation(entry, state, driver, token, "execution");
  }

  private removeProvisionalInterrupt(entry: Entry, runId: string, token: number): void {
    const withoutToken = (messages: readonly PendingMessage[]) => messages.filter((pending) => pending.interruptToken !== token);
    entry.lifecycle.replaceInbox(runId, withoutToken(entry.lifecycle.inbox(runId)));
    const successor = entry.lifecycle.successor();
    if (successor) entry.lifecycle.replaceInbox(successor, withoutToken(entry.lifecycle.inbox(successor)));
  }

  /**
   * The child stopped without `complete_agent_run`: nudge once, then record
   * the failure. Both endings go through `finalizePendingEnd`: a successor
   * reserved while this invocation was settled but not yet fenced (a
   * background exit, a grandchild's completion, a person's prompt) is taken
   * and started by the ending, never left `queued` with nobody to start it.
   */
  private settled(entry: Entry, state: RunState): void {
    if (state.lastAssistant?.error) {
      this.finalizePendingEnd(entry, state, { status: "failed", outcome: { error: state.lastAssistant.error } });
      return;
    }
    if (!state.nudged) {
      state.nudged = true;
      this.kick(state, NUDGE_TEXT);
      return;
    }
    const driver = this.host.driver(entry.path!);
    const context = driver?.lastAssistantText?.() ?? state.lastAssistant?.text;
    this.finalizePendingEnd(entry, state, { status: "failed", outcome: { error: ENDED_WITHOUT_TOOL, ...(context ? { context: excerpt(context, RESULT_EXCERPT) } : {}) } });
  }

  /** Reserve or extend the one run waiting behind the current invocation. */
  private queueRun(entry: Entry, text: string, previous?: RunState, parent?: Entry): RunState {
    return this.queueRunMessage(entry, { content: [{ type: "text", text }], options: { expandPromptTemplates: false }, origin: "agent", engine: false }, previous, parent);
  }

  private queueRunMessage(entry: Entry, message: PendingMessage, previous?: RunState, parent?: Entry): RunState {
    let created: RunState | undefined;
    const reservation = entry.lifecycle.reserveSuccessor(message, () => {
      this.diagnose(entry, "info", "successor-reserved", { predecessor: previous?.run.runId, origin: message.origin, extension: message.extension !== undefined });
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

  /**
   * What survives a terminal declaration, in order: every message waiting
   * here alone, plus every engine-owned message the engine still held.
   *
   * The engine reports what it held as text, per lane, in queue order, and it
   * drains each lane front to back (agent.js `continue()`, agent-session.js
   * `_handleAgentEvent` removes a consumed text by first match). So the
   * harness walks its own engine-owned messages of a lane in the order it
   * queued them against the lane's remaining texts, front to back: a match is
   * the same message (identity kept — two identical texts match once each); a
   * local message with no remaining text was consumed by the engine and is
   * gone for good; a remaining text with no local twin (queued by something
   * that bypassed this harness, or expanded by Pi's template/skill expansion
   * so that its text no longer equals what was sent) is kept as a message of
   * its own, and so is every custom message an extension queued straight
   * into a lane (`cleared.custom`), after that lane's texts — the engine
   * drains steering before follow-ups. Nothing the engine still held is
   * dropped.
   */
  private preservedMessages(entry: Entry, state: RunState, cleared: ClearedQueue): PendingMessage[] {
    const remaining: Record<EngineLane, string[]> = { steer: [...cleared.steering], followUp: [...cleared.followUp] };
    const local: PendingMessage[] = [];
    const matched: Record<EngineLane, PendingMessage[]> = { steer: [], followUp: [] };
    for (const pending of entry.lifecycle.clearInbox(state.run.runId)) {
      if (!pending.engine) {
        local.push(pending);
        continue;
      }
      const lane = pending.lane ?? "steer";
      const texts = remaining[lane];
      const index = texts.indexOf(contentTask(pending.content));
      if (index < 0) continue;
      texts.splice(index, 1);
      const { engine: _engine, lane: _lane, ...rest } = pending;
      void _engine;
      void _lane;
      matched[lane].push({ ...rest, engine: false });
    }
    const foreign = (text: string): PendingMessage => ({
      content: [{ type: "text", text }],
      options: { expandPromptTemplates: false },
      origin: state.run.origin === "user" ? "user" : "agent",
      engine: false,
    });
    const custom = cleared.custom ?? { steering: [], followUp: [] };
    // Pi drains steering before follow-ups. Harness-only work could not have
    // entered either lane and therefore follows what the engine still owned.
    return [
      ...matched.steer,
      ...remaining.steer.map(foreign),
      ...custom.steering.map(foreign),
      ...matched.followUp,
      ...remaining.followUp.map(foreign),
      ...custom.followUp.map(foreign),
      ...local,
    ];
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
      this.diagnose(entry, "info", "terminal-declared", { runId: state.run.runId, status, phase: entry.lifecycle.phase().kind });
      if (!abort) return;
      // The engine's queue must be empty before the abort lands, or its
      // post-run loop carries the queued messages on under this failed run.
      void this.withEntry(entry, () => this.transferEngineQueue(entry, state, "extension-error")).then(
        () => {
          this.diagnose(entry, "info", "abort-requested", { runId: state.run.runId, reason: status });
          this.scheduleAbort(this.host.driver(state.run.sessionPath));
        },
        () => this.scheduleAbort(this.host.driver(state.run.sessionPath)),
      );
    } else {
      this.endRun(state, status, outcome);
    }
  }

  /**
   * Publish a run's end at the fence — the only place a reserved successor is
   * taken, so every ending of an owner passes through here. `wakeParent:
   * false` ends a run its parent was never told about without a model event.
   */
  private finalizePendingEnd(entry: Entry, state: RunState, pending: RunEnd, options: { wakeParent?: boolean } = {}): void {
    if (isTerminalRunStatus(state.run.status)) return;
    const wakeParent = options.wakeParent ?? true;
    const successor = entry.lifecycle.takeSuccessor();
    const queued = successor ? this.runStates.get(successor.runId) : undefined;
    const live = queued !== undefined && !isTerminalRunStatus(queued.run.status);
    this.diagnose(entry, "info", "terminal-published", { runId: state.run.runId, status: pending.status, successor: queued?.run.runId, successorLive: live, delayedParent: live });
    // Publish the old terminal history first, but delay its parent wake until
    // the already-accepted resume has become the session's canonical live run.
    this.endRun(state, pending.status, pending.outcome, live, wakeParent);
    if (queued && live) {
      this.touch(queued, (run) => ({ ...run, status: "running" }));
      this.activateRun(entry, queued);
      this.diagnose(entry, "info", "successor-activated", { runId: queued.run.runId, predecessor: state.run.runId, inbox: entry.lifecycle.inbox(queued.run.runId).length + (successor?.first ? 1 : 0) });
      if (successor?.first) this.kickMessage(queued, successor.first);
      else this.kick(queued, queued.task);
      if (state.run.parent && wakeParent) this.notifyParent(state.run, pending.outcome.context);
    }
  }

  /** Settle a dialog nobody here can answer with its fallback; the driver's bridge never throws for an id it no longer holds. */
  private cancelDialog(sessionPath: string, id: string): void {
    try {
      this.host.driver(sessionPath)?.respondToUi({ id, cancelled: true });
    } catch {
      // The driver's fault, not the run's.
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
    wakeParent = true,
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
    // Whatever still waited on this run will never start under it. A caller
    // holding a promise for one of those messages (a person's prompt, an
    // extension's send) is answered with the reason, never left hanging.
    const leftovers = entry ? entry.lifecycle.clearInbox(run.runId) : [];
    if (leftovers.length > 0) {
      this.diagnose(entry, "warn", "inbox-dropped-at-end", { runId: run.runId, status, count: leftovers.length });
      const reason = new HarnessError(
        run.status === "failed"
          ? `The agent's run ${run.runId} failed before this message could start: ${run.error ?? "no reason recorded"}`
          : `The agent's run ${run.runId} ended (${run.status}) before this message could start.`,
      );
      for (const pending of leftovers) settlePending(pending, reason);
    }
    entry?.lifecycle.didTerminate(run.runId);
    if (!delayParent && wakeParent) this.notifyParent(run, outcome.context);
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
   * pending dialogs. The oldest still-owned question is the one the run shows.
   */
  private reconcileQuestion(state: RunState, resolvedId?: string): void {
    if (isTerminalRunStatus(state.run.status)) return;
    const driver = this.host.driver(state.run.sessionPath);
    const current = state.run.question;
    let open: UiDialogRequest | undefined;
    const pending = pendingUiOf(driver);
    if (pending) {
      const entry = this.byPath.get(state.run.sessionPath);
      const pendingIds = new Set(pending.map((request) => request.id));
      const owned = new Set(entry?.lifecycle.ownedDialogs(state.run.runId, pendingIds) ?? []);
      open = pending.find((request) => owned.has(request.id) || request.id === current?.id);
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

  /**
   * One structured, credential-free line about this session's lifecycle for
   * the host's log store (contract 7): which run owns the session, how a
   * message was admitted, what the engine's queue held (counts), when an end
   * was declared and when it was published. Identities, phases, counts and
   * timestamps only — never a prompt, a message body or a credential. It
   * travels the worker's module-log channel, so it lands beside the session's
   * provider and tool rows and never in front of a person: only `error`
   * module logs surface in the UI, and this never writes one.
   */
  private diagnose(entry: Entry | undefined, level: DiagnosticLevel, event: string, fields: Record<string, DiagnosticField>): void {
    const path = entry?.path;
    if (!path) return;
    const parts = [`lifecycle ${event}`];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${String(value)}`);
    }
    parts.push(`at=${this.iso()}`);
    this.host.notify("pi/extension/message", { path, message: { type: "lasercode/module/log", module: "subagents", level, message: parts.join(" ") } });
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

/** Backward-compatible export; protocol owns the one model-facing wording. */
export const answerHint = agentQuestionAnswerHint;

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

/** How many custom messages the engine had queued out of sight of its own queue. */
function customCount(cleared: ClearedQueue): number {
  return (cleared.custom?.steering.length ?? 0) + (cleared.custom?.followUp.length ?? 0);
}

/** The update kinds worth a line when they arrive late from an invocation the session no longer owns; deltas are not. */
function isLifecycleKind(kind: SessionUpdate["kind"]): boolean {
  switch (kind) {
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "turn_start":
    case "turn_end":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_end":
    case "extension_error":
      return true;
    default:
      return false;
  }
}

/** Answer whoever waits on a message that will never start: a person's prompt, an extension's send. */
function settlePending(pending: PendingMessage, reason: Error): void {
  try {
    pending.reject?.(reason);
  } catch {
    // The waiter's fault, not the run's.
  }
  if (pending.extension) {
    pending.extension.admission.reject(reason);
    pending.extension.completion.reject(reason);
  }
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
