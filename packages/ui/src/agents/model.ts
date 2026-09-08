/**
 * Pure helpers over the agents vocabulary (`@lasercode/protocol` agents.ts).
 * No React, no DOM. Tested in test/agents/model.test.ts.
 *
 * Two vocabularies meet here. Runs speak `AgentRunStatus`; the rest of the app
 * speaks the five words of DESIGN.md "Status language". {@link runStatusLabel}
 * and {@link runStatusTone} are the one mapping between them, so a run's dot,
 * pill and sentence agree wherever they are drawn.
 */
import {
  DEFAULT_AGENT_NAME,
  isBuiltinAgentName,
  isTerminalRunStatus,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentIssue,
  type AgentRun,
  type AgentRunStatus,
  type AgentWarning,
  type AgentsSnapshot,
  type SessionAgentKind,
  type SessionSummary,
} from "@lasercode/protocol";

// ---------------------------------------------------------------------------
// Sessions and kinds
// ---------------------------------------------------------------------------

/** Which built-in workspace `cwd` is, or `null` for an ordinary project. */
export function isWorkspaceCwd(cwd: string | undefined, snapshot: AgentsSnapshot | null | undefined): "beam" | "chat" | null {
  if (!cwd || !snapshot) return null;
  if (cwd === snapshot.workspaces.beam) return "beam";
  if (cwd === snapshot.workspaces.chat) return "chat";
  return null;
}

/**
 * How a session relates to the agents feature. The catalog's own attribution
 * wins; a session without one is placed by its directory and parentage, so a
 * terminal-started session still lands in the right group.
 */
export function agentKindOf(
  summary: Pick<SessionSummary, "cwd" | "parentPath" | "agent"> | undefined,
  snapshot: AgentsSnapshot | null | undefined,
): SessionAgentKind {
  if (!summary) return "root";
  if (summary.agent) return summary.agent.kind;
  if (summary.parentPath) return "child";
  return isWorkspaceCwd(summary.cwd, snapshot) ?? "root";
}

/** The definition a session runs: its attribution, else the snapshot's default. */
export function sessionAgentName(
  summary: Pick<SessionSummary, "agent"> | undefined,
  snapshot: AgentsSnapshot | null | undefined,
): string {
  return summary?.agent?.agentName ?? snapshot?.defaultAgent ?? DEFAULT_AGENT_NAME;
}

/** Product-facing names for the shipped agents; a custom name is the name the person typed. */
export function agentDisplayName(name: string): string {
  switch (name) {
    case "beam":
      return "Beam";
    case "chat":
      return "Chat";
    case "namer":
      return "Namer";
    case DEFAULT_AGENT_NAME:
      return "Default agent";
    default:
      return name;
  }
}

/** Built-ins cannot be edited or deleted; the shipped `default` can be edited but never deleted while default. */
export function isBuiltinAgent(agent: Pick<AgentDefinition, "name" | "kind">): boolean {
  return agent.kind === "builtin" || isBuiltinAgentName(agent.name);
}

// ---------------------------------------------------------------------------
// Run status vocabulary
// ---------------------------------------------------------------------------

/** The status words for runs, mapped onto DESIGN.md's five-word vocabulary. */
export const RUN_STATUS_LABEL: Readonly<Record<AgentRunStatus, string>> = {
  queued: "Waiting",
  running: "Working",
  completed: "Done",
  blocked: "Needs you",
  failed: "Failed",
  cancelled: "Ended",
};

export type AgentStatusTone = "live" | "attention" | "danger" | "ok" | "muted";

export const RUN_STATUS_TONE: Readonly<Record<AgentRunStatus, AgentStatusTone>> = {
  queued: "muted",
  running: "live",
  completed: "ok",
  blocked: "attention",
  failed: "danger",
  cancelled: "muted",
};

export function runStatusLabel(status: AgentRunStatus): string {
  return RUN_STATUS_LABEL[status];
}

export function runStatusTone(status: AgentRunStatus): AgentStatusTone {
  return RUN_STATUS_TONE[status];
}

/** A run that is still going, or waiting to. */
export function isActiveRun(run: Pick<AgentRun, "status">): boolean {
  return !isTerminalRunStatus(run.status);
}

const time = (value: string | undefined): number => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Newest start first; ties by last update, then by id so the order is total. */
export function compareRunsNewestFirst(a: AgentRun, b: AgentRun): number {
  return time(b.startedAt) - time(a.startedAt) || time(b.updatedAt) - time(a.updatedAt) || b.runId.localeCompare(a.runId);
}

/** Creation order: the order children were started in, which a map must never reshuffle. */
export function compareRunsOldestFirst(a: AgentRun, b: AgentRun): number {
  return -compareRunsNewestFirst(a, b);
}

export type RunSource = readonly AgentRun[] | Readonly<Record<string, AgentRun>>;

export function runList(runs: RunSource): AgentRun[] {
  return Array.isArray(runs) ? [...(runs as readonly AgentRun[])] : Object.values(runs as Record<string, AgentRun>);
}

/** Every run that executed inside `sessionPath`, oldest first. */
export function runsForSession(runs: RunSource, sessionPath: string): AgentRun[] {
  return runList(runs).filter((run) => run.sessionPath === sessionPath).sort(compareRunsOldestFirst);
}

/** The run currently standing for a session: the newest one, active or not. */
export function latestRunForSession(runs: RunSource, sessionPath: string): AgentRun | undefined {
  let latest: AgentRun | undefined;
  for (const run of runList(runs)) {
    if (run.sessionPath !== sessionPath) continue;
    if (!latest || compareRunsNewestFirst(run, latest) < 0) latest = run;
  }
  return latest;
}

/** Runs in the tree under `rootPath`, oldest first. */
export function runsForRoot(runs: RunSource, rootPath: string): AgentRun[] {
  return runList(runs).filter((run) => run.rootSessionPath === rootPath).sort(compareRunsOldestFirst);
}

// ---------------------------------------------------------------------------
// Definitions, warnings, issues
// ---------------------------------------------------------------------------

export function agentByName(snapshot: AgentsSnapshot | null | undefined, name: string): AgentDefinition | undefined {
  return snapshot?.agents.find((agent) => agent.name === name);
}

const EMPTY_WARNINGS: readonly AgentWarning[] = Object.freeze([]);

/** Periodic-validation warnings for one definition, oldest first. */
export function warningsFor(snapshot: AgentsSnapshot | null | undefined, agentName: string): readonly AgentWarning[] {
  if (!snapshot) return EMPTY_WARNINGS;
  const mine = snapshot.warnings.filter((warning) => warning.agentName === agentName);
  return mine.length === 0 ? EMPTY_WARNINGS : mine.sort((a, b) => time(a.since) - time(b.since));
}

/**
 * A blank custom agent for the create form. Tools are the default set,
 * instructions are the agent's own (not the engine's), and every discovered
 * skill is offered. The snapshot seeds `allowedAgents` with the custom catalog,
 * so switching "can start other agents" on offers what exists rather than
 * nothing.
 */
export function defaultAgentDefinitionInput(_snapshot?: AgentsSnapshot | null): AgentDefinitionInput {
  return {
    name: "",
    description: "",
    instructions: "",
    engineInstructions: false,
    model: null,
    thinkingLevel: null,
    // An agent that starts nothing lists nothing: the pair has to agree or the
    // host refuses the definition, and a blank form must never open on a state
    // it cannot save. The editor's toggle fills the list when it is turned on.
    supportsSubagents: false,
    allowedAgents: [],
    scopedSkills: false,
    skills: [],
  };
}

/** The editable form of an existing definition. */
export function agentDefinitionInputOf(agent: AgentDefinition): AgentDefinitionInput {
  const { kind: _kind, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = agent;
  return { ...input, allowedAgents: [...input.allowedAgents], skills: input.skills.map((skill) => ({ ...skill })) };
}

/** `skills[2]` → `skills`; `name` → `name`. The field a list-item issue belongs under. */
export function agentIssueRoot(field: string): string {
  const bracket = field.indexOf("[");
  const dot = field.indexOf(".");
  const end = [bracket, dot].filter((i) => i !== -1);
  return end.length === 0 ? field : field.slice(0, Math.min(...end));
}

export interface AgentIssuesByField {
  /** Messages under the exact field the host named (`skills[2]`), in order. */
  exact: Readonly<Record<string, readonly string[]>>;
  /** Messages under the form field that owns it (`skills`), in order. */
  root: Readonly<Record<string, readonly string[]>>;
  /** True when at least one issue exists; forms disable Save on it. */
  any: boolean;
}

export function agentIssuesByField(issues: readonly AgentIssue[]): AgentIssuesByField {
  const exact: Record<string, string[]> = {};
  const root: Record<string, string[]> = {};
  for (const issue of issues) {
    (exact[issue.field] ??= []).push(issue.message);
    (root[agentIssueRoot(issue.field)] ??= []).push(issue.message);
  }
  return { exact, root, any: issues.length > 0 };
}
