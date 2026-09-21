/**
 * Pure helpers behind the Agents page. No React, no DOM; tested in
 * test/agents/page/model.test.ts. Everything the screen decides about
 * ordering, wording, deletability and field routing lives here so the
 * components only draw.
 */
import {
  AGENT_MAX_DEPTH_LIMIT,
  AGENT_NAME_MAX,
  DEFAULT_AGENT_NAME,
  FOREGROUND_COMMAND_SECONDS_MAX,
  FOREGROUND_COMMAND_SECONDS_MIN,
  canReferenceAgent,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentLocation,
  type AgentSkillRef,
  type AgentSkillScope,
  type AgentSkillsListing,
  type AgentWarning,
  type AgentsSnapshot,
  type ModelCatalogEntry,
  type ModelProfile,
  type ThinkingLevel,
} from "@lasercode/protocol";

import { agentIssueRoot, customAgentsForProject } from "@/agents";

// ---------------------------------------------------------------------------
// Selection and routing
// ---------------------------------------------------------------------------

/** What the editor column shows. Definition identity is name + exact source. */
export type AgentsSelection =
  | { kind: "agent"; name: string; location: AgentLocation }
  | { kind: "new"; location: AgentLocation; token: number }
  | { kind: "harness" }
  | null;

export function locationOfAgent(agent: Pick<AgentDefinition, "scope" | "projectCwd">): AgentLocation {
  return agent.scope === "project"
    ? { scope: "project", projectCwd: agent.projectCwd ?? "" }
    : { scope: "global" };
}

export function sameAgentLocation(left: AgentLocation, right: AgentLocation): boolean {
  return left.scope === right.scope
    && (left.scope === "global" || (right.scope === "project" && left.projectCwd === right.projectCwd));
}

export function selectionOfAgent(agent: AgentDefinition): Extract<AgentsSelection, { kind: "agent" }> {
  return { kind: "agent", name: agent.name, location: locationOfAgent(agent) };
}

export function agentAtLocation(
  snapshot: AgentsSnapshot | null | undefined,
  name: string,
  location: AgentLocation,
): AgentDefinition | undefined {
  return snapshot?.agents.find((agent) => agent.name === name && sameAgentLocation(locationOfAgent(agent), location));
}

export const sameSelection = (a: AgentsSelection, b: AgentsSelection): boolean => {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "agent" && b.kind === "agent") return a.name === b.name && sameAgentLocation(a.location, b.location);
  if (a.kind === "new" && b.kind === "new") return a.token === b.token && sameAgentLocation(a.location, b.location);
  return a.kind === "harness" && b.kind === "harness";
};

/** The form sections, in the order the editor draws them. */
export const EDITOR_SECTIONS = [
  "file",
  "name",
  "description",
  "instructions",
  "profile",
  "thinkingLevel",
  "allowedAgents",
  "skills",
  "default",
] as const;
export type EditorSection = (typeof EDITOR_SECTIONS)[number];

/** DOM id of a section, for deep links and `aria-describedby`. */
export const sectionDomId = (section: string): string => `agent-field-${section}`;

/**
 * The section an issue, warning or deep link lands in. `skills[1]` and
 * `scopedSkills` both belong to the skills section; `supportsSubagents` to the
 * allowed-agents one; instruction flags to instructions; scope and file
 * problems to the immutable definition-file metadata.
 */
export function sectionOfField(field: string): EditorSection {
  const root = agentIssueRoot(field);
  switch (root) {
    case "file":
    case "scope":
    case "projectCwd":
      return "file";
    case "scopedSkills":
      return "skills";
    case "supportsSubagents":
      return "allowedAgents";
    case "engineInstructions":
    case "excludeCoreInstructions":
      return "instructions";
    case "thinking":
      return "thinkingLevel";
    // A definition written before profiles named a model; its warning belongs
    // where that choice lives now.
    case "model":
      return "profile";
    default:
      return (EDITOR_SECTIONS as readonly string[]).includes(root) ? (root as EditorSection) : "name";
  }
}

// ---------------------------------------------------------------------------
// Ordering and marks
// ---------------------------------------------------------------------------

export type AgentMark = "default" | "custom";
export type AgentsScopeView = "global" | "project" | "effective";

export function agentMark(agent: Pick<AgentDefinition, "name" | "kind">): AgentMark {
  return agent.name === DEFAULT_AGENT_NAME ? "default" : "custom";
}

export function compareAgents(
  snapshot: Pick<AgentsSnapshot, "defaultAgent"> | null | undefined,
  left: AgentDefinition,
  right: AgentDefinition,
): number {
  if (left.scope === "global" && left.name === snapshot?.defaultAgent) return -1;
  if (right.scope === "global" && right.name === snapshot?.defaultAgent) return 1;
  if (left.name === DEFAULT_AGENT_NAME) return -1;
  if (right.name === DEFAULT_AGENT_NAME) return 1;
  return left.name.localeCompare(right.name);
}

/**
 * The one scope projection used by the list, overview, counts and warnings.
 * Every agent is one a person wrote (D-347), so there is one list.
 */
export function agentsInScope(
  snapshot: AgentsSnapshot | null | undefined,
  view: AgentsScopeView,
  projectCwd?: string,
): { custom: AgentDefinition[] } {
  const all = snapshot?.agents ?? [];
  const sort = (agents: AgentDefinition[]) => agents.sort((left, right) => compareAgents(snapshot, left, right));
  const globals = sort(all.filter((agent) => agent.scope === "global"));
  const projects = sort(all.filter((agent) => agent.scope === "project" && agent.projectCwd === projectCwd));
  const custom = view === "global"
    ? globals
    : view === "project"
      ? [...projects, ...globals]
      : sort(customAgentsForProject(snapshot, projectCwd));
  return { custom };
}

/** True when the person has not made an agent of their own yet in this scope. */
export function isFirstRun(
  snapshot: AgentsSnapshot | null | undefined,
  view: AgentsScopeView,
  projectCwd?: string,
): boolean {
  return agentsInScope(snapshot, view, projectCwd).custom.every((agent) => agent.name === DEFAULT_AGENT_NAME);
}

/**
 * Definitions an agent may start: globals for a global agent; effective globals
 * plus this project's definitions for a project agent. Another instance of the
 * same definition remains a valid choice.
 */
export function startableAgents(
  snapshot: AgentsSnapshot | null | undefined,
  owner?: Pick<AgentDefinitionInput, "scope" | "projectCwd">,
): AgentDefinition[] {
  return agentsInScope(
    snapshot,
    owner?.scope === "project" ? "effective" : "global",
    owner?.scope === "project" ? owner.projectCwd : undefined,
  ).custom.filter((candidate) => owner === undefined || canReferenceAgent(owner, candidate));
}

const normalizedPath = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/, "");
const pathIsWithin = (path: string, directory: string): boolean => normalizedPath(path).startsWith(`${normalizedPath(directory)}/`);

/** Folder name shown beside “This project”, without exposing the whole path. */
export function projectFolderName(projectCwd: string): string {
  return normalizedPath(projectCwd).split("/").filter(Boolean).at(-1) ?? projectCwd;
}

/** Whether an unlinked file warning belongs in the current global/project view. */
export function fileWarningIsVisible(
  warning: AgentWarning,
  snapshot: AgentsSnapshot | null | undefined,
  view: AgentsScopeView,
  projectCwd?: string,
  knownProjectCwds: readonly string[] = [],
): boolean {
  if (warning.field !== "file") return false;
  if (!warning.path) return true;

  const visible = agentsInScope(snapshot, view, projectCwd);
  if (visible.custom.some((agent) => agent.path === warning.path)) return true;
  // A known definition outside this exact scope projection must not attach to
  // a same-name source that happens to be visible here.
  if (snapshot?.agents.some((agent) => agent.path === warning.path)) return false;

  const projectRoots = new Set([
    ...knownProjectCwds,
    ...(snapshot?.agents
      .filter((agent) => agent.scope === "project" && agent.projectCwd !== undefined)
      .map((agent) => agent.projectCwd!) ?? []),
  ]);
  const owningProject = [...projectRoots].find((root) => pathIsWithin(warning.path!, root));
  if (owningProject) return view !== "global" && owningProject === projectCwd;
  if (view !== "effective") return true;
  return !snapshot?.agents.some(
    (agent) => agent.scope === "project"
      && agent.projectCwd === projectCwd
      && agent.name === warning.agentName,
  );
}

/** Warnings that can be acted on from this exact scope projection. */
export function visibleAgentWarnings(
  snapshot: AgentsSnapshot | null | undefined,
  view: AgentsScopeView,
  projectCwd?: string,
  knownProjectCwds: readonly string[] = [],
): AgentWarning[] {
  if (!snapshot) return [];
  return snapshot.warnings.filter((warning) =>
    agentForWarning(snapshot, warning, view, projectCwd) !== undefined
      || fileWarningIsVisible(warning, snapshot, view, projectCwd, knownProjectCwds),
  );
}

/** The loaded definition a warning belongs to, if there is one in this scope. */
export function agentForWarning(
  snapshot: AgentsSnapshot | null | undefined,
  warning: AgentWarning,
  view: AgentsScopeView,
  projectCwd?: string,
): AgentDefinition | undefined {
  if (!snapshot) return undefined;
  const agents = agentsInScope(snapshot, view, projectCwd).custom;
  if (warning.path) return agents.find((agent) => agent.path === warning.path);
  const named = agents.filter((agent) => agent.name === warning.agentName);
  return named.length === 1 ? named[0] : undefined;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

export const TOOL_LABEL: Readonly<Record<string, string>> = {
  read: "Read files",
  bash: "Run commands",
  edit: "Edit files",
  write: "Write files",
  grep: "Search file contents",
  find: "Find files",
  ls: "List directories",
  web_search: "Search the web",
};

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const THINKING_LABEL: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * The levels the profile's preferred model accepts, or every level when that
 * model is not in the catalogue (or the agent follows the default profile).
 */
export function thinkingLevelsFor(
  profile: ModelProfile | undefined,
  catalog: readonly ModelCatalogEntry[],
): readonly ThinkingLevel[] {
  const model = profile?.models[0];
  if (!model) return THINKING_LEVELS;
  const entry = catalog.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  if (!entry || entry.thinkingLevels.length === 0) return THINKING_LEVELS;
  return THINKING_LEVELS.filter((level) => entry.thinkingLevels.includes(level));
}

/**
 * What a card says about an agent's profile. A `null` id inherits, and an id
 * nothing answers to is the unknown-profile warning's subject: the agent still
 * runs, on the profile new conversations use (`docs/model-profiles.md`).
 */
export function describeProfile(profileId: string | null, profiles: readonly ModelProfile[] = []): string {
  if (profileId === null) return "Follows the profile new conversations use";
  return profiles.find((profile) => profile.id === profileId)?.name ?? "A profile that is not there";
}

/** True when this agent names a profile the settings no longer hold. */
export function profileIsMissing(profileId: string | null, profiles: readonly ModelProfile[]): boolean {
  return profileId !== null && !profiles.some((profile) => profile.id === profileId);
}

export function describeThinking(level: ThinkingLevel | null): string {
  return level === null ? "Follows the default" : THINKING_LABEL[level];
}

export function describeSkills(agent: Pick<AgentDefinitionInput, "scopedSkills" | "skills">): string {
  if (!agent.scopedSkills) return "Every skill in the project and globally";
  const n = agent.skills.length;
  return n === 0 ? "Scoped, none chosen yet" : `${n} scoped skill${n === 1 ? "" : "s"}`;
}

export function describeStarts(agent: Pick<AgentDefinitionInput, "supportsSubagents" | "allowedAgents">): string {
  if (!agent.supportsSubagents) return "Works alone";
  const n = agent.allowedAgents.length;
  return n === 0 ? "May start agents, none chosen yet" : `May start ${agent.allowedAgents.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Deletability, dirtiness, names
// ---------------------------------------------------------------------------

export interface Deletability {
  ok: boolean;
  /** Why not, written for a person. */
  reason?: string;
}

export function deletability(agent: Pick<AgentDefinition, "name" | "kind" | "scope">, snapshot: Pick<AgentsSnapshot, "defaultAgent"> | null | undefined): Deletability {
  if (snapshot && agent.scope === "global" && agent.name === snapshot.defaultAgent) {
    return { ok: false, reason: "This is the default agent for new sessions. Make another agent the default first, then delete this one." };
  }
  return { ok: true };
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, i) => value === b[i]);
const sameSkills = (a: readonly AgentSkillRef[], b: readonly AgentSkillRef[]): boolean =>
  a.length === b.length && a.every((skill, i) => skill.name === b[i]?.name && skill.path === b[i]?.path && skill.scope === b[i]?.scope);

export function sameDefinitionInput(a: AgentDefinitionInput, b: AgentDefinitionInput): boolean {
  return (
    a.name === b.name &&
    a.scope === b.scope &&
    a.projectCwd === b.projectCwd &&
    a.description === b.description &&
    a.instructions === b.instructions &&
    a.engineInstructions === b.engineInstructions &&
    a.excludeCoreInstructions === b.excludeCoreInstructions &&
    a.profileId === b.profileId &&
    a.thinkingLevel === b.thinkingLevel &&
    a.supportsSubagents === b.supportsSubagents &&
    sameStrings(a.allowedAgents, b.allowedAgents) &&
    a.scopedSkills === b.scopedSkills &&
    sameSkills(a.skills, b.skills)
  );
}

/** What a person types, shaped into an `agent_name` as they go: lower case, spaces to hyphens, nothing else. */
export function shapeAgentName(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, AGENT_NAME_MAX);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const SKILL_SCOPE_LABEL: Readonly<Record<AgentSkillScope, string>> = {
  project: "This project",
  global: "Every project",
};

const SCOPE_ORDER: readonly AgentSkillScope[] = ["project", "global"];

export const skillKey = (skill: Pick<AgentSkillRef, "path">): string => skill.path;

/** The listing grouped by scope, project first, each group by name. */
export function groupSkills(listing: AgentSkillsListing | undefined): Array<{ scope: AgentSkillScope; skills: AgentSkillRef[] }> {
  if (!listing) return [];
  return SCOPE_ORDER.map((scope) => ({
    scope,
    skills: listing.skills.filter((skill) => skill.scope === scope).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.skills.length > 0);
}

/** Chosen skills the engine no longer discovers: the ones a warning points at. */
export function missingSkills(chosen: readonly AgentSkillRef[], listing: AgentSkillsListing | undefined): AgentSkillRef[] {
  if (!listing) return [];
  const known = new Set(listing.skills.map(skillKey));
  return chosen.filter((skill) => !known.has(skillKey(skill)));
}

/** The warnings of one agent that point at `section`. */
export function warningsInSection(warnings: readonly AgentWarning[], section: EditorSection): AgentWarning[] {
  return warnings.filter((warning) => sectionOfField(warning.field) === section);
}

// ---------------------------------------------------------------------------
// Harness policy
// ---------------------------------------------------------------------------

export const POLICY_LIMITS = {
  maxDepth: { min: 1, max: AGENT_MAX_DEPTH_LIMIT },
  foregroundCommandSeconds: { min: FOREGROUND_COMMAND_SECONDS_MIN, max: FOREGROUND_COMMAND_SECONDS_MAX },
} as const;


/** A whole number within `[min, max]`, or the reason it is not. */
export function checkRange(value: string, limits: { min: number; max: number }, unit: string): { value: number } | { error: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { error: "Enter a number." };
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return { error: "Whole numbers only." };
  if (n < limits.min || n > limits.max) return { error: `Between ${limits.min} and ${limits.max} ${unit}.` };
  return { value: n };
}
