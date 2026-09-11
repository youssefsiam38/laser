/**
 * The in-process contract between the worker's agent harness and the
 * companion extension's `subagents` and `background-work` modules.
 *
 * The harness (packages/worker/src/agents) owns runs, child sessions,
 * worktrees and parent notification. The modules own only what must
 * live inside the engine session: registering the model-facing tools,
 * injecting the child's role into its system prompt, and delivering events to
 * the parent model at a safe boundary. Both sides may import the engine; the
 * types they exchange are the product protocol's, never the engine's.
 *
 * One bridge per session. The worker builds it when it opens a session and
 * passes it through `createLaserExtension({ agents })`.
 */
import type {
  AgentEvent,
  AgentRun,
  AgentRunQuestion,
  AgentRunStatus,
  BackgroundTask,
  SessionAgentKind,
} from "@lasercode/protocol";

/** One row of the compact catalog: only what the parent needs to choose. */
export interface AgentCatalogEntry {
  agentName: string;
  description: string;
}

/** What this session is, for tool registration and the child's prompt. */
export interface HarnessSessionRole {
  agentName: string;
  kind: SessionAgentKind;
  subagentName?: string;
  /** 0 for a top-level session. */
  depth: number;
  /** Present on a child: who started it. */
  parent?: { sessionPath: string; sessionId: string; agentName: string; subagentName?: string };
  /** The run this child session is currently executing, when one is active. */
  runId?: string;
  /** The parent session's active goal at start, for the child's role context. */
  goal?: { id: string; objective: string };
  /** The child's task (first lines), for its role context. */
  task?: string;
  /**
   * Present on a child: `false` when its parent started it without a worktree,
   * so it works in the parent's own checkout and is not isolated from it. Its
   * role block says so; nothing else changes — it keeps every tool (D-144).
   */
  isolated?: boolean;
  /**
   * The branch a child's own worktree is on. Present only with
   * `isolated !== false`, so nothing ever names a branch that does not exist.
   */
  branch?: string;
}

export interface StartAgentInput {
  agentName: string;
  subagentName: string;
  task: string;
  /**
   * Give the child its own worktree. Absent means true: the default is an
   * isolated checkout. `false` runs it in this session's own checkout, for
   * work that only reads.
   */
  worktree?: boolean;
}

export interface StartAgentResult {
  agentName: string;
  subagentName: string;
  sessionId: string;
  runId: string;
  status: "running";
  /** The directory the child works in, whichever way it was started. */
  cwd: string;
  /** The branch its worktree is on; absent when it shares its parent's checkout. */
  branch?: string;
}

export interface SendAgentMessageInput {
  sessionId: string;
  message: string;
  interrupt: boolean;
}

export interface SendAgentMessageResult {
  sessionId: string;
  runId: string;
  status: AgentRunStatus;
  /**
   * "queued" when the child was busy and the message waits (in its engine's
   * queue while it streams, or behind the run it is finishing); "answered"
   * when the child was paused on a question and the message settled it (the
   * question comes back as `answered`); "delivered" only once the child's
   * engine has accepted the message as its next turn — never before admission
   * is known; "refused" when the engine would not take it, in which case the
   * run recorded for the attempt is `failed` and `error` says why.
   */
  delivery: "delivered" | "queued" | "answered" | "refused";
  answered?: AgentRunQuestion;
  /** Why a `refused` message did not start. */
  error?: string;
}

/** What the model sees for one run: the identities plus outcome, never transcripts. */
export interface AgentRunSummary {
  agentName: string;
  subagentName: string;
  sessionId: string;
  runId: string;
  status: AgentRunStatus;
  startedAt: string;
  endedAt?: string;
  result?: { status: "completed" | "blocked"; message: string };
  error?: string;
  endedBy?: { initiator: "parent" | "user" | "harness"; reason?: string };
  /** Present while `status` is `needs_input`: what the child is waiting on. */
  question?: AgentRunQuestion;
}

// ---------- the fleet, as the agent reads it (D-163) ----------

/**
 * A row's state: the same seven words the person's fleet column draws
 * (`packages/ui/src/fleet/model.ts`, `FleetState`). A run's status maps onto
 * it one to one; a command's `stopped` is `cancelled`, because "ended" is what
 * both mean. The two lists must agree, and a worker test pins that they do.
 */
export type FleetRowState = "queued" | "running" | "needs_input" | "blocked" | "completed" | "failed" | "cancelled";

/** What every row says, whichever kind of work it is. */
export interface FleetRowBase {
  /** `agent` for a run in a child session; `command` for a background command — the word the row wears in the fleet. */
  kind: "agent" | "command";
  /** What you would address it by: the agent's instance name, or the command's first line. */
  title: string;
  state: FleetRowState;
  /** The state's word as the person reads it: Working, Asking, Blocked, Done, Failed, Ended, Waiting. */
  status: string;
  /** Live while the work is going, frozen once it ends; `4m 12s`. Absent when the start is unknown. */
  elapsed?: string;
  /**
   * One line: what it is doing in its own words while it goes (the question it
   * is paused on, the tool it is running, the last line it printed), else how
   * it ended (its final message, the error, the exit code, who ended it), else
   * what it was asked to do. Never all three.
   */
  line?: string;
  startedAt?: string;
  endedAt?: string;
  /** 0 for a row directly under the caller. */
  depth: number;
  children: FleetRow[];
}

/** One agent the caller started, or one an agent under it started: its newest run stands for it. */
export interface FleetAgentRow extends FleetRowBase {
  kind: "agent";
  agentName: string;
  subagentName: string;
  sessionId: string;
  /** The newest run in that session; `inspect_agent { runId }` reads it. */
  runId: string;
}

/** One background command, under the row for the session whose agent ran it. */
export interface FleetCommandRow extends FleetRowBase {
  kind: "command";
  /** `task_output { taskId }` reads its output. */
  taskId: string;
  /** Present once it ended; `null` when the process left no code. */
  exitCode?: number | null;
}

export type FleetRow = FleetAgentRow | FleetCommandRow;

/**
 * `inspect_fleet`: the tree of work under the caller's session — the agents it
 * started, theirs, and the background commands any of them (the caller
 * included) left running or finished. Read-only. The counts are over the whole
 * tree; `rows` is cut to `AGENT_FLEET_ROWS_MAX`, deepest rows first, and
 * `omitted` says how many were left out.
 */
export interface InspectFleetResult {
  rows: FleetRow[];
  /** Rows still going, anywhere in the tree. */
  working: number;
  /** Rows waiting on someone — a question open, or a child that ended asking. */
  needsYou: number;
  /** Rows that reached an end state. */
  finished: number;
  /** Every row there was, before the cut. */
  total: number;
  omitted: number;
}

/**
 * `task_output` on a command of another session in the caller's tree: the
 * command as it stands, whose it is, and the tail of its log. `text` is
 * absent when the command kept no log file.
 */
export interface ReadTaskOutputResult {
  task: Omit<BackgroundTask, "sessionPath">;
  owner: { agentName: string; subagentName: string; sessionId: string };
  text?: string;
}

/**
 * `inspect_agent`: one agent under this session — a child, or a child's
 * child, any row `inspect_fleet` shows — addressed by `runId` or `sessionId`,
 * the identities that already exist, never a fifth. `messages` is how many of
 * the agent's last assistant messages to include (default
 * `AGENT_INSPECT_MESSAGES_DEFAULT`, at most `AGENT_INSPECT_MESSAGES_MAX`).
 */
export interface InspectAgentInput {
  runId?: string;
  sessionId?: string;
  messages?: number;
}

/** One of the child's own assistant messages, excerpted. */
export interface InspectedMessage {
  at?: string;
  text: string;
}

/**
 * Everything the run summary says, plus what a parent that is checking on one
 * child actually needs: the whole task, where it works and whether that
 * directory still exists, what it is doing right now, its last words, what it
 * is waiting on, and its own children. Read-only: inspecting never wakes the
 * child and never delivers anything to it.
 */
export interface InspectAgentResult extends AgentRunSummary {
  /** Whole, not the excerpt the run record carries. */
  task: string;
  origin: AgentRun["origin"];
  depth: number;
  model?: string;
  /** Where it works; the branch only when it has a worktree of its own. */
  cwd?: string;
  branch?: string;
  /**
   * `null` when it was started without one. `exists` is the directory on
   * disk right now; the two counts are what git could say about the branch,
   * `null` where it could not.
   */
  worktree: { path: string; branch: string; exists: boolean; unmergedCommits: number | null; uncommittedFiles: number | null; removedAt?: string } | null;
  activity?: { turns: number; tools: number; currentTool?: string; lastAt: string };
  updatedAt: string;
  /** Newest last. Empty when the child has said nothing yet or its transcript could not be read. */
  messages: InspectedMessage[];
  /** Agents this child started, newest first, as run summaries. */
  agents: AgentRunSummary[];
}

export interface StopAgentInput {
  runId: string;
  reason?: string;
}

/**
 * A parent removing a worktree it is finished with (M13-T42). Addressed by the
 * identities that already exist — the child's `sessionId` or one of its
 * `runId`s — never a fifth one.
 */
export interface RemoveAgentWorktreeInput {
  sessionId?: string;
  runId?: string;
  /** Remove it even though the branch still holds work the parent has not merged. */
  force?: boolean;
}

export interface RemoveAgentWorktreeResult {
  agentName: string;
  subagentName: string;
  sessionId: string;
  removed: true;
  /** The directory that is gone, and the branch that went with it. */
  path: string;
  branch: string;
  /** Set when the parent insisted over unmerged work; says what was thrown away. */
  discarded?: { commits: number | null; uncommittedFiles: number | null };
}

export interface CompleteRunInput {
  status: "completed" | "blocked";
  message: string;
}

export type CompleteRunResult = { ok: true; runId: string } | { ok: false; error: string };

/**
 * A structured event for the parent model, delivered by the `subagents`
 * module through `pi.sendMessage` at the next safe boundary. Mirrors the
 * architecture reference's `agent.completed` shape.
 */
export interface AgentModelEvent {
  type: "agent.completed" | "agent.blocked" | "agent.failed" | "agent.cancelled" | "agent.message" | "agent.needs_input";
  agentName: string;
  subagentName: string;
  sessionId: string;
  runId: string;
  message: string;
  /** Present when a person ended the run; the reason is verbatim when supplied. */
  endedBy?: { initiator: "parent" | "user" | "harness"; reason?: string };
  /** The full run, for the UI's rendering of the parent-side card. */
  run: AgentRun;
}

/** The harness as the extension modules see it, scoped to one session. */
export interface AgentHarnessBridge {
  role(): HarnessSessionRole;
  /** True when this session may start agents (definition, allowed list and depth all permit). */
  canDelegate(): boolean;
  /** The compact catalog for this session's `start_agent` description: allowed agents only. */
  catalog(): AgentCatalogEntry[];
  startAgent(input: StartAgentInput, signal?: AbortSignal): Promise<StartAgentResult>;
  sendAgentMessage(input: SendAgentMessageInput): Promise<SendAgentMessageResult>;
  /** The tree of work under this session, as the person's fleet shows it (D-163). Read-only. */
  inspectFleet(): Promise<InspectFleetResult>;
  /** One agent in the tree under this session, in depth. Read-only; never wakes it. */
  inspectAgent(input: InspectAgentInput): Promise<InspectAgentResult>;
  stopAgent(input: StopAgentInput): Promise<AgentRunSummary>;
  /** Parent side: remove a finished child's worktree. Refuses over unmerged work unless forced. */
  removeAgentWorktree(input: RemoveAgentWorktreeInput): Promise<RemoveAgentWorktreeResult>;
  /** Child side: publish the final message for the active run. */
  completeRun(input: CompleteRunInput): Promise<CompleteRunResult>;
  /** Parent side: the harness pushes events here; the module delivers them to the model. */
  onEvent(deliver: (event: AgentModelEvent) => void): () => void;
  /** Child side: the harness announces a new run on this session (a follow-up message). */
  onRoleChange(listener: (role: HarnessSessionRole) => void): () => void;
  /** Observability for the live map: a transient event owned by this session. */
  emitEvent?(event: Omit<AgentEvent, "id" | "at">): void;
}

/** What the `background-work` module needs from the worker. */
export interface BackgroundWorkOptions {
  cwd: string;
  /** Seconds a foreground command may run before it is promoted to a background task. */
  foregroundCommandSeconds: number;
  shellPath?: string;
  commandPrefix?: string;
  /**
   * `task_output` for a command this session did not start but can read: one
   * of an agent under it (D-163). The worker answers from its task index and
   * the command's log file; a command outside this session's tree is refused
   * with a sentence for the model. Absent when the worker keeps no index.
   */
  readTask?: (taskId: string, tailLines: number) => Promise<ReadTaskOutputResult>;
}
