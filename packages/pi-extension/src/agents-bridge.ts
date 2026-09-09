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
  AgentRunStatus,
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
  /** "queued" when the child was busy and the message waits; "delivered" otherwise. */
  delivery: "delivered" | "queued";
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
}

export interface WaitForAgentsInput {
  runIds: string[];
  timeoutSeconds?: number;
}

export interface WaitForAgentsResult {
  runs: AgentRunSummary[];
  /** True when the wait ended before every run reached a terminal state. */
  timedOut: boolean;
}

export interface StopAgentInput {
  runId: string;
  reason?: string;
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
  type: "agent.completed" | "agent.blocked" | "agent.failed" | "agent.cancelled" | "agent.message";
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
  /** Runs this session started, newest first. */
  listAgents(): Promise<AgentRunSummary[]>;
  waitForAgents(input: WaitForAgentsInput, signal?: AbortSignal): Promise<WaitForAgentsResult>;
  stopAgent(input: StopAgentInput): Promise<AgentRunSummary>;
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
}
