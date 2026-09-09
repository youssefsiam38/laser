/**
 * Agents — the reusable agent definitions, the harness that runs them as
 * persistent child sessions, and the live run/event vocabulary the UI draws.
 *
 * Binding references: docs/agents-leap/references/original-request.md and
 * docs/agents-leap/references/agent-harness-architecture.md. The four identity
 * fields are the only identities: `agentName` (the definition, also its id),
 * `subagentName` (the running instance), `sessionId` (the persistent
 * conversation) and `runId` (one execution inside that session).
 *
 * Engine-neutral on purpose: nothing here names the engine, its tools by
 * implementation, or its files. The worker maps this onto the engine.
 */
import type { ModelRef, ThinkingLevel } from "./messages.js";

// ---------- names and limits ----------

/** `agent_name`: lower case, starts with a letter, letters/digits/hyphens, ≤ 40. */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const AGENT_NAME_MAX = 40;
export const SUBAGENT_NAME_MAX = 60;
export const AGENT_DESCRIPTION_MAX = 300;
export const AGENT_INSTRUCTIONS_MAX = 64 * 1024;
export const AGENT_TASK_MAX = 64 * 1024;
export const AGENT_MESSAGE_MAX = 64 * 1024;
/** A subagent's stored task excerpt on the run record. */
export const AGENT_TASK_EXCERPT = 500;
/** Namer's session-name ceiling (original request: 25–30 characters). */
export const SESSION_NAME_MAX = 30;
export const SESSION_NAME_MIN = 25;
export const AGENT_MAX_DEPTH_DEFAULT = 3;
export const AGENT_MAX_DEPTH_LIMIT = 6;
/** A foreground command becomes a background task after this many seconds. */
export const FOREGROUND_COMMAND_SECONDS_DEFAULT = 120;
export const FOREGROUND_COMMAND_SECONDS_MIN = 10;
export const FOREGROUND_COMMAND_SECONDS_MAX = 3600;
/** The directory, under the project root, every child worktree lives in. */
export const WORKTREES_DIR_NAME = ".worktrees";

export const DEFAULT_AGENT_NAME = "default";
export const BUILTIN_AGENT_NAMES = ["beam", "chat", "namer"] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];
export function isBuiltinAgentName(name: string): name is BuiltinAgentName {
  return (BUILTIN_AGENT_NAMES as readonly string[]).includes(name);
}

/**
 * Tools are not part of an agent definition (D-144): every agent has every
 * tool. What an agent is for is said in its instructions, and what it may
 * reach beyond its own work is the allowed-agents list and its worktree — a
 * per-agent tool list was a second, weaker answer to the same question, and
 * one more thing to keep in step with the engine's own set.
 *
 * `web_search` is still gated by the Web search feature, for everyone at once.
 */

/** The harness tools the engine sees; listed so the UI can name them and search can project them. */
export const HARNESS_TOOL_NAMES = [
  "start_agent",
  "send_agent_message",
  "list_agents",
  "wait_for_agents",
  "stop_agent",
  "complete_agent_run",
] as const;
export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];
export const BACKGROUND_TOOL_NAMES = ["task_list", "task_output", "task_wait", "task_stop"] as const;
export type BackgroundToolName = (typeof BACKGROUND_TOOL_NAMES)[number];

// ---------- definitions ----------

export interface AgentModelChoice {
  provider: string;
  id: string;
}

export type AgentSkillScope = "global" | "project" | "bundled";

/** A scoped skill: identity plus the file the definition was validated against. */
export interface AgentSkillRef {
  name: string;
  path: string;
  scope: AgentSkillScope;
}

export type AgentKind = "custom" | "builtin";

export interface AgentDefinition {
  /** `agent_name`: unique name and id of the reusable definition. */
  name: string;
  kind: AgentKind;
  /** Answers "when should another agent start this one?" Shown in the compact catalog. */
  description: string;
  /** Answers "how should this agent perform its work?" Loaded only for this agent. */
  instructions: string;
  /**
   * True when `instructions` is not applied and the engine's own built-in
   * instructions run instead (the shipped `default` agent starts this way).
   */
  engineInstructions: boolean;
  /** `null` follows the configured default model. */
  model: AgentModelChoice | null;
  thinkingLevel: ThinkingLevel | null;
  supportsSubagents: boolean;
  /** Definitions this agent may start; meaningful only with `supportsSubagents`. */
  allowedAgents: string[];
  /** When true only `skills` are offered; otherwise every discovered skill is. */
  scopedSkills: boolean;
  skills: AgentSkillRef[];
  createdAt: string;
  updatedAt: string;
}

export type AgentDefinitionInput = Omit<AgentDefinition, "kind" | "createdAt" | "updatedAt">;

/** A validation problem tied to a form field (`skills[2]`, `allowedAgents`, `name`…). */
export interface AgentIssue {
  field: string;
  message: string;
}

export type AgentWarningField = "skills" | "model" | "allowedAgents";

/** Periodic validation found something a person should look at. */
export interface AgentWarning {
  agentName: string;
  field: AgentWarningField;
  /** The specific skill name, model id or agent name concerned. */
  target?: string;
  message: string;
  since: string;
}

export interface AgentPolicy {
  maxDepth: number;
  foregroundCommandSeconds: number;
}

export type NamerStatus = "unqualified" | "qualifying" | "ready" | "unavailable";

export interface NamerCandidate {
  model: AgentModelChoice;
  latencyMs: number | null;
  valid: boolean;
  sample?: string;
  error?: string;
  /** Input + output list price per million tokens, when the catalog knows it. */
  costPerMillion?: number;
}

export interface NamerState {
  status: NamerStatus;
  model: AgentModelChoice | null;
  qualifiedAt?: string;
  candidates: NamerCandidate[];
  reason?: string;
}

export interface BeamState {
  model: AgentModelChoice | null;
  suggested: AgentModelChoice | null;
  /** True until a person picks or dismisses; the choice dialog opens on it. */
  needsChoice: boolean;
}

/**
 * Chat's model. Every built-in's model is the person's to choose; Chat has no
 * suggestion engine and no benchmark behind it, so its state is the choice
 * alone. `null` means it follows the configured default model.
 */
export interface ChatState {
  model: AgentModelChoice | null;
}

export interface AgentsSnapshot {
  revision: number;
  agents: AgentDefinition[];
  /** The agent new sessions start with. Cannot be deleted while it is the default. */
  defaultAgent: string;
  warnings: AgentWarning[];
  policy: AgentPolicy;
  namer: NamerState;
  beam: BeamState;
  chat: ChatState;
  /** Directories the built-in projectless agents run in. */
  workspaces: { beam: string; chat: string };
}

export interface AgentSkillsRoot {
  path: string;
  scope: AgentSkillScope;
  exists: boolean;
}

export interface AgentSkillsListing {
  skills: AgentSkillRef[];
  roots: AgentSkillsRoot[];
}

// ---------- runs ----------

/**
 * A run's state. Nothing ends a run for taking too long (D-144): an agent may
 * work for minutes or for months, and only the model, a person, a parent or a
 * failure ends it. There is no timed-out state, and nothing reads one back.
 */
export type AgentRunStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = ["queued", "running", "completed", "blocked", "failed", "cancelled"];
export const AGENT_RUN_TERMINAL: readonly AgentRunStatus[] = ["completed", "blocked", "failed", "cancelled"];
export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return AGENT_RUN_TERMINAL.includes(status);
}

/** The four identities, exactly as the architecture reference names them. */
export interface AgentRunIdentity {
  agentName: string;
  subagentName: string;
  sessionId: string;
  runId: string;
}

export type AgentRunOrigin = "agent" | "user";
export type AgentRunInitiator = "parent" | "user" | "harness";

export interface AgentRun extends AgentRunIdentity {
  /** The child session's wire identity (session files are the stable key). */
  sessionPath: string;
  projectCwd: string;
  rootSessionPath: string;
  /** 1 for a child of a top-level session. */
  depth: number;
  parent: { sessionPath: string; sessionId: string; runId?: string } | null;
  worktree: { path: string; branch: string; baseCommit: string } | null;
  origin: AgentRunOrigin;
  status: AgentRunStatus;
  /** First `AGENT_TASK_EXCERPT` characters of the task. */
  task: string;
  result?: { status: "completed" | "blocked"; message: string };
  error?: string;
  endedBy?: { initiator: AgentRunInitiator; reason?: string };
  goal?: { id: string; objective: string };
  model?: ModelRef | null;
  activity?: { turns: number; tools: number; currentTool?: string; label?: string; lastAt: string };
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export type AgentEventKind =
  | "started"
  | "message_sent"
  | "message_received"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "stop_requested";

/** A transient inter-agent moment, owned by the node it happened in. */
export interface AgentEvent {
  id: string;
  at: string;
  kind: AgentEventKind;
  /** The session whose node shows the bubble. */
  sessionPath: string;
  runId?: string;
  counterpart?: { sessionPath: string; label: string };
  summary: string;
}

export type SessionAgentKind = "root" | "child" | "beam" | "chat";

/** How a session relates to the agents feature, on `SessionSummary` and `SessionState`. */
export interface SessionAgentInfo {
  agentName: string;
  kind: SessionAgentKind;
  subagentName?: string;
  parentPath?: string;
  rootPath?: string;
  runId?: string;
  runStatus?: AgentRunStatus;
}

/**
 * The record every agent-started or agent-defined session carries as its
 * first custom entry, so a catalog that only reads files can attribute it.
 */
export interface SessionAgentRecord {
  agentName: string;
  kind: SessionAgentKind;
  subagentName?: string;
  parentPath?: string;
  parentSessionId?: string;
  rootPath?: string;
  runId?: string;
  worktree?: { path: string; branch: string; baseCommit: string };
}

/** The custom entry type the worker writes `SessionAgentRecord` under. */
export const SESSION_AGENT_ENTRY_TYPE = "lasercode/agent";
/** The custom entry type run lifecycle moments are written under in the child session. */
export const SESSION_RUN_ENTRY_TYPE = "lasercode/agent-run";
/** The custom message type a parent receives agent events as. */
export const AGENT_EVENT_MESSAGE_TYPE = "lasercode/agent-event";
/** The custom message type a session receives when one of its background tasks exits. */
export const TASK_EVENT_MESSAGE_TYPE = "lasercode/task-event";

// ---------- methods ----------

declare module "./messages.js" {
  interface ClientRequests {
    "agents/list": { params: {}; result: AgentsSnapshot };
    "agents/validate": { params: { agent: AgentDefinitionInput }; result: { issues: AgentIssue[] } };
    "agents/save": { params: { agent: AgentDefinitionInput }; result: { agent: AgentDefinition; snapshot: AgentsSnapshot } };
    "agents/delete": { params: { name: string }; result: { snapshot: AgentsSnapshot } };
    "agents/set-default": { params: { name: string }; result: { snapshot: AgentsSnapshot } };
    "agents/set-policy": { params: { policy: Partial<AgentPolicy> }; result: { snapshot: AgentsSnapshot } };
    /** Skills the engine discovers for `cwd` (global and project sources). Routed by cwd. */
    "agents/skills": { params: { cwd: string }; result: AgentSkillsListing };
    /** The engine's built-in instructions, for the editable `default` agent. Routed by cwd. */
    "agents/engine-instructions": { params: { cwd: string }; result: { text: string } };
    /** Runs known to the host; `path` narrows to the tree containing that session. */
    "agents/runs/list": { params: { path?: string }; result: { runs: AgentRun[] } };
    /** A person ends a run. Recorded as user-initiated; the parent is told, with the reason when given. */
    "agents/runs/stop": { params: { runId: string; reason?: string }; result: { run: AgentRun } };
    /**
     * A person chooses a built-in agent's model. One method for all three:
     * Beam, Chat and Namer are the same choice made in the same control, and
     * `null` returns that agent to the configured default (for Namer, to the
     * next qualification). Beam's pending choice is closed either way.
     */
    "agents/builtin/set-model": { params: { name: BuiltinAgentName; model: AgentModelChoice | null }; result: { snapshot: AgentsSnapshot } };
    /** Benchmark nominated cheap models and pick Namer's. Routed to the built-in workspace worker. */
    "agents/namer/qualify": { params: { cwd: string }; result: NamerState };
    /** Host → worker only: the current definitions. Refused from clients. */
    "agents/sync": { params: { snapshot: AgentsSnapshot }; result: {} };
  }

  interface HostNotifications {
    "agents/updated": AgentsSnapshot;
    "agents/run": { run: AgentRun };
    "agents/event": AgentEvent;
    /** The first provider is connected and Beam has no model yet. */
    "agents/beam/choose-model": { suggested: AgentModelChoice | null };
  }
}
