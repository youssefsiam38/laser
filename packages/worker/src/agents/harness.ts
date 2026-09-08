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
 *   - `start_agent` never waits; it returns the four identities immediately.
 *   - a successful run ends only through `complete_agent_run`; crashes,
 *     cancellations and timeouts are recorded by the harness, never chosen by
 *     the model;
 *   - every child gets its own worktree; nesting limits, model access and
 *     worktree ownership are enforced here, not by prompt.
 */
import { randomBytes } from "node:crypto";
import {
  AGENT_MESSAGE_MAX,
  AGENT_TASK_EXCERPT,
  AGENT_TASK_MAX,
  SESSION_RUN_ENTRY_TYPE,
  SUBAGENT_NAME_MAX,
  isTerminalRunStatus,
  validatePanelEvent,
  type AgentDefinition,
  type AgentEvent,
  type AgentModelChoice,
  type AgentRun,
  type AgentRunInitiator,
  type AgentRunStatus,
  type HostNotifications,
  type Panel,
  type RunLifecycle,
  type SessionAgentInfo,
  type SessionAgentRecord,
  type SessionState,
} from "@lasercode/protocol";
import type { DriverAgentOptions, DriverEvent, SessionDriver } from "../driver.js";
import type {
  AgentCatalogEntry,
  AgentHarnessBridge,
  AgentModelEvent,
  AgentRunSummary,
  BackgroundWorkOptions,
  CompleteRunInput,
  CompleteRunResult,
  HarnessSessionRole,
  SendAgentMessageInput,
  SendAgentMessageResult,
  StartAgentInput,
  StartAgentResult,
  StopAgentInput,
  WaitForAgentsInput,
  WaitForAgentsResult,
} from "./bridge.js";
import { DefinitionsCache, isStartable } from "./definitions.js";
import { HarnessError } from "./errors.js";
import type { CreateWorktreeInput, Worktree } from "./worktrees.js";

/** What the harness needs from `WorktreeManager`; an interface so lifecycle tests run without git. */
export interface WorktreeProvider {
  create(input: CreateWorktreeInput): Promise<Worktree>;
  remove(root: string, path: string, branch?: string): Promise<void>;
  ownedBy(runId: string): Worktree | undefined;
}

/** Panel id prefix for runs: `agents:run:<runId>`. */
export const AGENT_PANEL_PREFIX = "agents:";
export const RUN_PANEL_SOURCE = "agents";
export const runPanelId = (runId: string): string => `${AGENT_PANEL_PREFIX}run:${runId}`;

/** What a child is told when it stops without its final tool. */
export const NUDGE_TEXT = "You stopped without calling complete_agent_run. Call complete_agent_run now with status completed or blocked and your final message.";
const ENDED_WITHOUT_TOOL = "Ended without complete_agent_run";
const WAIT_DEFAULT_SECONDS = 600;
const WAIT_MAX_SECONDS = 3600;
const RESULT_EXCERPT = 2000;
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
}

export interface AgentHarnessOptions {
  host: SessionHost;
  definitions: DefinitionsCache;
  worktrees: WorktreeProvider;
  /** Background-work options for a session running in `cwd`; passed to every child. */
  backgroundWork?: (cwd: string) => BackgroundWorkOptions;
  beamSkillName?: string;
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
  /** Set when a run ended through the tool: a further turn in the same loop is aborted. */
  abortOnTurn: boolean;
}

interface RunState {
  run: AgentRun;
  nudged: boolean;
  /** `complete_agent_run` was called for this run. */
  completedByTool: boolean;
  lastAssistant: { text?: string; error?: string } | undefined;
}

const MODEL_EVENT_TYPE: Record<Exclude<AgentRunStatus, "queued" | "running">, AgentModelEvent["type"]> = {
  completed: "agent.completed",
  blocked: "agent.blocked",
  failed: "agent.failed",
  cancelled: "agent.cancelled",
};

const LIFECYCLE: Record<AgentRunStatus, RunLifecycle> = {
  queued: "queued",
  running: "running",
  completed: "done",
  blocked: "done",
  failed: "failed",
  cancelled: "cancelled",
};

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
  private readonly beamSkillName: string | undefined;
  private readonly now: () => number;
  private readonly byPath = new Map<string, Entry>();
  private readonly runStates = new Map<string, RunState>();
  /** Run ids in creation order, so "newest first" is deterministic. */
  private readonly runOrder: string[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(options: AgentHarnessOptions) {
    this.host = options.host;
    this.definitions = options.definitions;
    this.worktrees = options.worktrees;
    this.backgroundWork = options.backgroundWork;
    this.beamSkillName = options.beamSkillName;
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
      abortOnTurn: false,
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
    };
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
    const active = this.activeRunState(sessionPath);
    if (active) this.endRun(active, "failed", { error: "The agent's session closed before it finished." });
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

  /** A person ends a run (`agents/runs/stop` or the panel's action). */
  async stopRun(runId: string, endedBy: { initiator: AgentRunInitiator; reason?: string }): Promise<AgentRun> {
    const state = this.runStates.get(runId);
    if (!state) throw new HarnessError(`No run is called ${runId}.`);
    if (isTerminalRunStatus(state.run.status)) return state.run;
    this.event({ kind: "stop_requested", sessionPath: state.run.sessionPath, runId, summary: endedBy.initiator === "user" ? "The person asked this run to stop" : "The parent asked this run to stop" });
    const driver = this.host.driver(state.run.sessionPath);
    if (driver) await driver.abort().catch(() => undefined);
    this.endRun(state, "cancelled", { endedBy });
    return state.run;
  }

  /** `pi/panel/action` for an `agents:` panel. False when the id is not a run of this worker. */
  async handlePanelAction(panelId: string, actionId: string): Promise<boolean> {
    if (!panelId.startsWith(`${AGENT_PANEL_PREFIX}run:`)) return false;
    const runId = panelId.slice(`${AGENT_PANEL_PREFIX}run:`.length);
    if (!this.runStates.has(runId)) return false;
    if (actionId === "open") return true; // a navigation; the UI performs it
    if (actionId === "stop") {
      await this.stopRun(runId, { initiator: "user" });
      return true;
    }
    return false;
  }

  /** Best effort: remove a deleted child session's worktree and retire its panels. */
  async removeWorktreeFor(sessionPath: string): Promise<void> {
    const entry = this.byPath.get(sessionPath);
    const record = entry?.record ?? this.runs().find((run) => run.sessionPath === sessionPath);
    const worktree = record?.worktree;
    for (const run of this.runs()) {
      if (run.sessionPath !== sessionPath || !run.parent) continue;
      this.host.notify("pi/extension/message", { path: run.parent.sessionPath, message: { type: "lasercode/panel/close", id: runPanelId(run.runId), reason: "session deleted" } });
    }
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
    if (event.type !== "update") return;
    const active = this.activeRunState(sessionPath);
    const update = event.update;
    switch (update.kind) {
      case "turn_start": {
        if (entry.abortOnTurn) {
          entry.abortOnTurn = false;
          const driver = this.host.driver(sessionPath);
          if (driver) void driver.abort().catch(() => undefined);
          return;
        }
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
        if (active) this.endRun(active, "failed", { error: update.message });
        return;
      }
      case "agent_settled": {
        entry.abortOnTurn = false;
        if (!active || active.completedByTool) return;
        this.settled(entry, active);
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
      listAgents: async () => this.listAgents(entry),
      waitForAgents: (input, signal) => this.waitForAgents(entry, input, signal),
      stopAgent: (input) => this.stopAgent(entry, input),
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
    const worktree = await this.worktrees.create({ projectCwd: parent.projectCwd, baseCwd: parentDriver.state().cwd, subagentName, runId });
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
      worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
    };
    const role: HarnessSessionRole = {
      agentName,
      kind: "child",
      subagentName,
      depth: parent.role.depth + 1,
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
      state = await this.host.openChild({
        cwd: worktree.cwd,
        parentSessionPath: parent.path,
        agent: {
          definition,
          role,
          record,
          bridge: handle.bridge,
          policy,
          ...(this.backgroundWork ? { backgroundWork: this.backgroundWork(worktree.cwd) } : {}),
          ...(this.beamSkillName !== undefined ? { beamSkillName: this.beamSkillName } : {}),
        },
      });
    } catch (error) {
      handle.discard();
      await this.worktrees.remove(worktree.root, worktree.path, worktree.branch).catch(() => undefined);
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
    return { agentName, subagentName, sessionId: state.id, runId, status: "running" };
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
    const driver = this.host.driver(child.path);
    if (!driver) throw new HarnessError(`The agent session "${sessionId}" is no longer open.`);
    const active = this.activeRunState(child.path);
    const content = [{ type: "text" as const, text: message }];
    let runId: string;
    let delivery: SendAgentMessageResult["delivery"];
    if (active) {
      const busy = driver.state().isStreaming;
      if (busy) {
        if (input.interrupt) await driver.steer(content);
        else await driver.followUp(content);
        delivery = "queued";
      } else {
        // Idle with an open run: a queued message would wait for a prompt that never comes.
        await driver.prompt(content, { expandPromptTemplates: false });
        delivery = "delivered";
      }
      runId = active.run.runId;
    } else {
      const state = this.createRun(child, { origin: "agent", task: message, goal: await readGoal(this.host.driver(parent.path)), parentRunId: this.activeRun(parent.path)?.runId });
      runId = state.run.runId;
      delivery = "delivered";
      void this.kick(state, message);
    }
    this.event({ kind: "message_sent", sessionPath: parent.path, runId, counterpart: { sessionPath: child.path, label: labelOf(child.role) }, summary: `Sent a message to ${labelOf(child.role)}` });
    this.event({ kind: "message_received", sessionPath: child.path, runId, counterpart: { sessionPath: parent.path, label: labelOf(parent.role) }, summary: `Message from ${labelOf(parent.role)}` });
    return { sessionId, runId, status: "running", delivery };
  }

  private listAgents(parent: Entry): AgentRunSummary[] {
    if (!parent.path) return [];
    const parentPath = parent.path;
    return this.runs()
      .filter((run) => run.parent?.sessionPath === parentPath)
      .reverse()
      .map(summarize);
  }

  private async waitForAgents(parent: Entry, input: WaitForAgentsInput, signal?: AbortSignal): Promise<WaitForAgentsResult> {
    const ids = [...new Set((input.runIds ?? []).map((id) => String(id).trim()).filter((id) => id !== ""))];
    const known = ids.filter((id) => this.runStates.get(id)?.run.parent?.sessionPath === parent.path);
    if (known.length === 0) throw new HarnessError(ids.length === 0 ? "runIds is required: the runs to wait for." : `None of ${ids.join(", ")} is a run this session started.`);
    const seconds = Math.min(WAIT_MAX_SECONDS, Math.max(1, Math.floor(input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS)));
    const allDone = () => known.every((id) => isTerminalRunStatus(this.runStates.get(id)!.run.status));
    if (!allDone() && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters.delete(check);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const check = () => {
          if (allDone()) finish();
        };
        const timer = setTimeout(finish, seconds * 1000);
        this.waiters.add(check);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return { runs: known.map((id) => summarize(this.runStates.get(id)!.run)), timedOut: !allDone() };
  }

  private async stopAgent(parent: Entry, input: StopAgentInput): Promise<AgentRunSummary> {
    const runId = (input.runId ?? "").trim();
    const state = this.runStates.get(runId);
    if (!state || state.run.parent?.sessionPath !== parent.path) throw new HarnessError(`No run called "${runId}" was started by this session.`);
    const reason = input.reason?.trim();
    await this.stopRun(runId, { initiator: "parent", ...(reason ? { reason } : {}) });
    return summarize(state.run);
  }

  private completeRun(child: Entry, input: CompleteRunInput): CompleteRunResult {
    if (!child.path) return { ok: false, error: "This session is not ready yet." };
    const active = this.activeRunState(child.path);
    if (!active) {
      const latest = this.latestRun(child.path);
      return { ok: false, error: latest ? "This run already ended." : "No run is active in this session." };
    }
    if (input.status !== "completed" && input.status !== "blocked") return { ok: false, error: 'status must be "completed" or "blocked".' };
    const message = (input.message ?? "").trim();
    if (message === "") return { ok: false, error: "message is required: the final result, evidence and any important next step." };
    if (message.length > AGENT_MESSAGE_MAX) return { ok: false, error: `message must be at most ${AGENT_MESSAGE_MAX} characters.` };
    active.completedByTool = true;
    child.abortOnTurn = true;
    this.endRun(active, input.status, { result: { status: input.status, message } });
    return { ok: true, runId: active.run.runId };
  }

  // ------------------------------------------------------------ lifecycle

  private createRun(entry: Entry, init: { origin: AgentRun["origin"]; task: string; goal?: { id: string; objective: string } | null; parentRunId?: string | undefined }): RunState {
    const path = entry.path!;
    const sessionId = entry.sessionId!;
    const runId = init.origin === "agent" && entry.role.runId && !this.runStates.has(entry.role.runId) ? entry.role.runId : newRunId();
    const startedAt = this.iso();
    const driver = this.host.driver(path);
    const parentPath = entry.record.parentPath;
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
      origin: init.origin,
      status: "running",
      task: excerpt(init.task, AGENT_TASK_EXCERPT),
      ...(init.goal ? { goal: init.goal } : {}),
      model: driver?.state().model ?? null,
      activity: { turns: 0, tools: 0, lastAt: startedAt },
      startedAt,
      updatedAt: startedAt,
    };
    const state: RunState = { run, nudged: false, completedByTool: false, lastAssistant: undefined };
    this.runStates.set(runId, state);
    this.runOrder.push(runId);
    entry.role = { ...entry.role, runId, ...(init.goal ? { goal: init.goal } : {}) };
    entry.abortOnTurn = false;
    this.announceRole(entry);
    void this.persistMoment(run, "started");
    this.publish(state);
    return state;
  }

  /** Start the child's model loop; a refusal or a throw is the run's failure, never the caller's. */
  private async kick(state: RunState, text: string): Promise<void> {
    const driver = this.host.driver(state.run.sessionPath);
    if (!driver) {
      this.endRun(state, "failed", { error: "The agent's session is not open." });
      return;
    }
    try {
      const result = await driver.prompt([{ type: "text", text }], { expandPromptTemplates: false });
      if (!result.accepted && !isTerminalRunStatus(state.run.status)) {
        this.endRun(state, "failed", { error: "The agent's session refused the task because it was busy." });
      }
    } catch (error) {
      if (!isTerminalRunStatus(state.run.status)) this.endRun(state, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The child stopped without `complete_agent_run`: nudge once, then record the failure. */
  private settled(entry: Entry, state: RunState): void {
    if (state.lastAssistant?.error) {
      this.endRun(state, "failed", { error: state.lastAssistant.error });
      return;
    }
    if (!state.nudged) {
      state.nudged = true;
      const driver = this.host.driver(entry.path!);
      if (!driver) {
        this.endRun(state, "failed", { error: "The agent's session is not open." });
        return;
      }
      void driver
        .prompt([{ type: "text", text: NUDGE_TEXT }], { expandPromptTemplates: false })
        .then((result) => {
          if (!result.accepted && !isTerminalRunStatus(state.run.status)) this.endRun(state, "failed", { error: ENDED_WITHOUT_TOOL });
        })
        .catch(() => {
          if (!isTerminalRunStatus(state.run.status)) this.endRun(state, "failed", { error: ENDED_WITHOUT_TOOL });
        });
      return;
    }
    const driver = this.host.driver(entry.path!);
    const context = driver?.lastAssistantText?.() ?? state.lastAssistant?.text;
    this.endRun(state, "failed", { error: ENDED_WITHOUT_TOOL, ...(context ? { context: excerpt(context, RESULT_EXCERPT) } : {}) });
  }

  private endRun(
    state: RunState,
    status: Exclude<AgentRunStatus, "queued" | "running">,
    outcome: { result?: { status: "completed" | "blocked"; message: string }; error?: string; endedBy?: { initiator: AgentRunInitiator; reason?: string }; context?: string },
  ): void {
    if (isTerminalRunStatus(state.run.status)) return;
    const endedAt = this.iso();
    state.run = {
      ...state.run,
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
    this.notifyParent(run, outcome.context);
    for (const waiter of [...this.waiters]) waiter();
  }

  private notifyParent(run: AgentRun, context: string | undefined): void {
    if (!run.parent || run.status === "queued" || run.status === "running") return;
    const parent = this.byPath.get(run.parent.sessionPath);
    const message = modelMessage(run, context);
    const event: AgentModelEvent = {
      type: MODEL_EVENT_TYPE[run.status],
      agentName: run.agentName,
      subagentName: run.subagentName,
      sessionId: run.sessionId,
      runId: run.runId,
      message,
      ...(run.endedBy ? { endedBy: run.endedBy } : {}),
      run,
    };
    this.event({
      kind: "message_received",
      sessionPath: run.parent.sessionPath,
      runId: run.runId,
      counterpart: { sessionPath: run.sessionPath, label: run.subagentName },
      summary: `${run.subagentName} ${statusWord(run.status)}`,
    });
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

  private publish(state: RunState): void {
    const run = state.run;
    this.host.notify("agents/run", { run });
    if (!run.parent) return;
    const panel = runPanel(run);
    if (panel) this.host.notify("pi/extension/message", { path: run.parent.sessionPath, message: { type: "lasercode/panel/upsert", panel } });
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
  };
}

function statusWord(status: AgentRunStatus): string {
  switch (status) {
    case "completed":
      return "finished";
    case "blocked":
      return "is blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "was ended";
      return "timed out";
    default:
      return status;
  }
}

function eventSummary(status: AgentRunStatus, run: AgentRun): string {
  switch (status) {
    case "completed":
      return "Finished and reported to the parent";
    case "blocked":
      return "Blocked; reported to the parent";
    case "failed":
      return run.error ?? "Failed";
    case "cancelled":
      return run.endedBy?.initiator === "user" ? "Ended by the person" : run.endedBy?.initiator === "parent" ? "Ended by the parent" : "Ended";
      return "Timed out";
    default:
      return status;
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
      body = run.error ?? "The run exceeded its time limit and was ended.";
      break;
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

/** The parent-side `run` panel for a run, validated against the panel contract. */
export function runPanel(run: AgentRun): Panel | undefined {
  const parentId = run.parent?.runId ? runPanelId(run.parent.runId) : run.parent?.sessionPath;
  const terminalReason =
    run.status === "cancelled" ? (run.endedBy?.initiator === "user" ? "you ended it" : "the parent ended it")
    : run.status === "blocked" ? "blocked"
    : run.status === "failed" ? "failed"
    : undefined;
  const activity = run.activity?.label ?? (run.activity?.currentTool ? `Running ${run.activity.currentTool}` : undefined);
  const data: Record<string, unknown> = {
    handle: run.subagentName,
    lifecycle: LIFECYCLE[run.status],
    origin: run.origin === "user" ? "you" : "agent",
    startedAt: run.startedAt,
    ...(parentId ? { parent: { id: parentId, relation: "spawned-by" } } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(activity ? { activity } : {}),
    ...(run.model ? { model: `${run.model.provider}/${run.model.id}` } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
  const result = validatePanelEvent({
    v: 1,
    id: runPanelId(run.runId),
    kind: "run",
    intent: "follow",
    title: run.subagentName,
    source: RUN_PANEL_SOURCE,
    data,
    actions: [
      { id: "open", label: "Open chat" },
      ...(isTerminalRunStatus(run.status) ? [] : [{ id: "stop", label: "End agent…", confirm: `End ${run.subagentName}? Its parent will be told.` }]),
    ],
  }, RUN_PANEL_SOURCE);
  return result.ok ? result.panel : undefined;
}
