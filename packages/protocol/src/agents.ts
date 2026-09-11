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
/** How a parent's message interacts with the child's current invocation (D-204). */
export const AGENT_MESSAGE_MODES = ["interrupt", "steer", "queue", "answer"] as const;
export type AgentMessageMode = (typeof AGENT_MESSAGE_MODES)[number];
/** A subagent's stored task excerpt on the run record. */
export const AGENT_TASK_EXCERPT = 500;
/**
 * `inspect_agent`'s window on a child's own words: how many of its last
 * assistant messages come back by default, at most, and how long each may be.
 * A parent that pulls a child's whole conversation into its context defeats
 * the point of delegating, so the cap is small and each message is excerpted.
 */
export const AGENT_INSPECT_MESSAGES_DEFAULT = 1;
export const AGENT_INSPECT_MESSAGES_MAX = 10;
export const AGENT_INSPECT_MESSAGE_EXCERPT = 1000;
/** Namer's session-name ceiling (original request: 25–30 characters). */
export const SESSION_NAME_MAX = 30;
export const SESSION_NAME_MIN = 25;
export const AGENT_MAX_DEPTH_DEFAULT = 3;
export const AGENT_MAX_DEPTH_LIMIT = 6;
/** A foreground command becomes a background task after this many seconds. */
export const FOREGROUND_COMMAND_SECONDS_DEFAULT = 120;
export const FOREGROUND_COMMAND_SECONDS_MIN = 10;
export const FOREGROUND_COMMAND_SECONDS_MAX = 3600;
/** The directory, under the project root, a child worktree lives in. */
export const WORKTREES_DIR_NAME = ".worktrees";

export const DEFAULT_AGENT_NAME = "default";
export const BUILTIN_AGENT_NAMES = ["beam", "chat", "namer"] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];
export function isBuiltinAgentName(name: string): name is BuiltinAgentName {
  return (BUILTIN_AGENT_NAMES as readonly string[]).includes(name);
}

/** A string replaces the shipped prompt; `null` follows the current shipped prompt. */
export type BuiltinInstructionOverrides = Readonly<Record<BuiltinAgentName, string | null>>;

/**
 * Tools are not part of an agent definition (D-144): every agent has every
 * tool. What an agent is for is said in its instructions, and what it may
 * reach beyond its own work is the allowed-agents list and its worktree — a
 * per-agent tool list was a second, weaker answer to the same question, and
 * one more thing to keep in step with the engine's own set.
 *
 * `web_search` is still gated by the Web search feature, for everyone at once.
 */

/**
 * The harness tools the engine sees; listed so the UI can name them and search
 * can project them. `inspect_fleet` (D-163) is the one way an agent reads the
 * work going on under it — the same tree the person's fleet column shows,
 * scoped to the caller's session — so there is no `list_agents` and no
 * `task_list`: one tree, both kinds of work, one vocabulary.
 */
export const HARNESS_TOOL_NAMES = [
  "start_agent",
  "send_agent_message",
  "inspect_fleet",
  "inspect_agent",
  "stop_agent",
  "remove_agent_worktree",
  "complete_agent_run",
] as const;
export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];
/**
 * The background-work tools; there is no waiting tool (D-162), a task's exit
 * comes to the model as a message, and there is no list: `inspect_fleet`
 * shows every command in the caller's tree beside the agents that ran them.
 */
export const BACKGROUND_TOOL_NAMES = ["task_output", "task_stop"] as const;
export type BackgroundToolName = (typeof BACKGROUND_TOOL_NAMES)[number];
/**
 * Rows `inspect_fleet` returns at most. A tree larger than this is cut
 * deepest-first and the result says how many rows were left out; every row
 * carries the id to follow it with, so nothing is unreachable.
 */
export const AGENT_FLEET_ROWS_MAX = 50;

// ---------- definitions ----------

export interface AgentModelChoice {
  provider: string;
  id: string;
}

export type AgentSkillScope = "global" | "project";

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
  /** The person's durable prompt choices; `null` restores that built-in's shipped instructions. */
  builtinInstructions: BuiltinInstructionOverrides;
  /** Historical custom names → the current definition name, so persisted sessions survive a rename. */
  renamedAgents: Readonly<Record<string, string>>;
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
 *
 * Three of these are live and two of them look alike from a distance, so the
 * distinction is written down here:
 *
 * - `running` — the child is working.
 * - `needs_input` — the child is **stuck**: something it did raised a question
 *   through the portable UI surface (`select`, `confirm`, `input`, `editor`,
 *   and any tool that asks before it acts) and its loop is paused until
 *   someone answers. The question is on `AgentRun.question`. It is live —
 *   nothing has ended — and it is the one state a parent most needs to tell
 *   apart from `running`, because only an answer moves it on. Its parent may
 *   answer through `send_agent_message` with `mode: "answer"`; the person may
 *   answer in the child's own chat; whichever comes first settles it.
 * - `blocked` — the child **ended** by saying it could not finish
 *   (`complete_agent_run { status: "blocked" }`); its question, if it asked
 *   one, is its final message. Terminal, though it reads as "needs you".
 */
export type AgentRunStatus = "queued" | "running" | "needs_input" | "completed" | "blocked" | "failed" | "cancelled";
export type AgentRunTerminalStatus = "completed" | "blocked" | "failed" | "cancelled";
export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = ["queued", "running", "needs_input", "completed", "blocked", "failed", "cancelled"];
export const AGENT_RUN_TERMINAL: readonly AgentRunTerminalStatus[] = ["completed", "blocked", "failed", "cancelled"];
export function isTerminalRunStatus(status: AgentRunStatus): status is AgentRunTerminalStatus {
  return (AGENT_RUN_TERMINAL as readonly AgentRunStatus[]).includes(status);
}

/**
 * What a run in `needs_input` is waiting on: one unanswered question raised
 * through the portable UI surface. The same four kinds as `UiDialogRequest`,
 * said in run vocabulary and stripped of what only a client needs. `id` is the
 * dialog's own id, so an answer settles exactly this question and never a
 * later one that happened to be asked in between.
 */
export interface AgentRunQuestion {
  id: string;
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  /** `confirm`'s message, `input`'s placeholder, `editor`'s prefill — whichever the kind carries. */
  detail?: string;
  /** `select`'s choices; an answer must be one of them. */
  options?: string[];
  /** The tool call that raised it, when exactly one was running. */
  toolCallId?: string;
  toolName?: string;
  askedAt: string;
}

/** One canonical model-facing instruction for answering a live typed question. */
export function agentQuestionAnswerHint(question: Pick<AgentRunQuestion, "kind">): string {
  const call = 'send_agent_message with its sessionId and mode "answer"';
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
  /**
   * The child's own checkout, or `null` when its parent chose not to isolate
   * it (`start_agent { worktree: false }`) and it works in the parent's.
   *
   * `removedAt` is set once the directory has been taken away — by its parent
   * through `remove_agent_worktree`, or by a person — so no reader offers a
   * branch or a path that is no longer there (M13-T42). The names stay: what
   * the run worked on is history, and history is not deleted.
   */
  worktree: { path: string; branch: string; baseCommit: string; removedAt?: string } | null;
  /**
   * The directory this run actually works in: its worktree when it has one,
   * otherwise the checkout its parent is working in. Absent only on a run
   * recorded before runs carried it — never guessed from the project.
   */
  cwd?: string;
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
  /** Present exactly while `status` is `needs_input`: the question nobody has answered yet. */
  question?: AgentRunQuestion;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export type AgentEventKind =
  | "started"
  | "message_sent"
  | "message_received"
  /** The child raised a question and is paused on it. */
  | "needs_input"
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

// ---------- worktree lifecycle (M13-T42) ----------

/**
 * What a child's worktree holds that removing it would destroy, and whether
 * it is still on disk. The same facts serve the parent's tool refusal and the
 * person's confirmation; neither should have to ask git itself.
 *
 * The two counts are `null` when git could not answer (a repository that has
 * moved, a branch already gone). `null` is not "nothing": a caller that cannot
 * tell says so rather than promising the work is safe.
 */
export interface AgentWorktreeStatus {
  path: string;
  branch: string;
  /** False when the directory is already gone; removing it is then bookkeeping. */
  exists: boolean;
  /** Commits on the branch the project's checkout does not have. */
  unmergedCommits: number | null;
  /** Files added, changed or deleted inside the worktree and not committed. */
  uncommittedFiles: number | null;
  /** Why the counts are unknown, or why a removal could not finish. */
  detail?: string;
}

/** True when this worktree holds work that removing it would destroy. */
export function worktreeHoldsWork(status: AgentWorktreeStatus): boolean {
  if (!status.exists) return false;
  return status.unmergedCommits === null || status.unmergedCommits > 0 || status.uncommittedFiles === null || status.uncommittedFiles > 0;
}

/**
 * What `pi/session/delete` does with the deleted child's worktree. Omitting it
 * means `keep`: a request that forgot the field never destroys work.
 */
export type SessionWorktreeDisposition = "keep" | "delete";

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
  /** Absent when the parent started this child without a worktree of its own. */
  worktree?: { path: string; branch: string; baseCommit: string; removedAt?: string };
}

/** The custom entry type the worker writes `SessionAgentRecord` under. */
export const SESSION_AGENT_ENTRY_TYPE = "lasercode/agent";
/** Durable person-selected values on a still-pristine first turn. */
export const SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE = "lasercode/first-turn-overrides";
export interface SessionFirstTurnOverrides {
  model?: ModelRef | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}
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
    "agents/validate": { params: { agent: AgentDefinitionInput; originalName: string | null }; result: { issues: AgentIssue[] } };
    "agents/save": { params: { agent: AgentDefinitionInput; originalName: string | null }; result: { agent: AgentDefinition; snapshot: AgentsSnapshot } };
    "agents/delete": { params: { name: string }; result: { snapshot: AgentsSnapshot } };
    "agents/set-default": { params: { name: string }; result: { snapshot: AgentsSnapshot } };
    "agents/set-policy": { params: { policy: Partial<AgentPolicy> }; result: { snapshot: AgentsSnapshot } };
    /** Skills the engine discovers for `cwd` (global and project sources). Routed by cwd. */
    "agents/skills": { params: { cwd: string }; result: AgentSkillsListing };
    /** Laser's default instructions, for the editable `default` agent. Routed by cwd. */
    "agents/engine-instructions": { params: { cwd: string }; result: { text: string } };
    /** Runs known to the host; `path` narrows to the tree containing that session. */
    "agents/runs/list": { params: { path?: string }; result: { runs: AgentRun[] } };
    /** A person ends a run. Recorded as user-initiated; the parent is told, with the reason when given. */
    "agents/runs/stop": { params: { runId: string; reason?: string }; result: { run: AgentRun } };
    /**
     * What a child session's worktree holds, by the child's session path.
     * `null` when that session never had one. Answered by the host from git
     * alone, so a leftover worktree can still be seen after its worker is gone.
     */
    "agents/worktree/status": { params: { path: string }; result: { worktree: AgentWorktreeStatus | null } };
    /**
     * A person removes a leftover worktree without deleting the session
     * (M13-T42). Refused, with what it holds, when it still has unmerged
     * commits or uncommitted files, unless `force` says the work is to be
     * thrown away.
     */
    "agents/worktree/remove": {
      params: { path: string; force?: boolean };
      result: { removed: boolean; worktree: AgentWorktreeStatus | null };
    };
    /**
     * A person chooses a built-in agent's model. One method for all three:
     * Beam, Chat and Namer are the same choice made in the same control, and
     * `null` returns that agent to the configured default (for Namer, to the
     * next qualification). Beam's pending choice is closed either way.
     */
    "agents/builtin/set-model": { params: { name: BuiltinAgentName; model: AgentModelChoice | null }; result: { snapshot: AgentsSnapshot } };
    /** Replace one built-in's system instructions; `null` restores the shipped prompt. */
    "agents/builtin/set-instructions": { params: { name: BuiltinAgentName; instructions: string | null }; result: { snapshot: AgentsSnapshot } };
    /** Benchmark connected naming candidates and pick Namer's. Routed to the built-in workspace worker. */
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
