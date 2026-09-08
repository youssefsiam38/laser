/**
 * Laser-owned feature vocabulary.
 *
 * A feature is a stable product capability. Its implementation may be a
 * bundled Pi extension today and a different engine adapter later; that detail
 * never crosses this boundary.
 */

export type FeatureId = "subagents" | "goals" | "web-search";
export type FeatureScope = "global" | "project";
export type FeatureHealth = "ready" | "disabled" | "needs-restart" | "unavailable" | "error";

export interface FeatureManifest {
  id: FeatureId;
  name: string;
  description: string;
  defaultEnabled: boolean;
  scopes: FeatureScope[];
  dependencies: FeatureId[];
  capabilities: string[];
  restart: "none" | "worker" | "new-session";
}

export interface FeatureState {
  manifest: FeatureManifest;
  globalEnabled: boolean;
  globalSource: "default" | "global";
  projectEnabled?: boolean;
  enabled: boolean;
  source: "default" | FeatureScope;
  health: FeatureHealth;
  detail?: string;
}

export const FEATURE_MANIFESTS: readonly FeatureManifest[] = [
  {
    id: "web-search",
    name: "Web search",
    description: "Search with one selected provider. Turning on tests its connection with a real search; provider charges may apply. Configure it in Providers and models → Web search.",
    defaultEnabled: false,
    scopes: ["global", "project"],
    dependencies: [],
    capabilities: ["web-search", "sources", "provider-choice"],
    restart: "worker",
  },
  {
    id: "subagents",
    name: "Subagents",
    description: "Let agents start other agents as persistent sub-sessions, each in its own isolated worktree, and run long commands as background tasks.",
    defaultEnabled: true,
    scopes: ["global", "project"],
    dependencies: [],
    capabilities: ["delegation", "sub-sessions", "worktrees", "background-tasks", "live-map"],
    restart: "worker",
  },
  {
    id: "goals",
    name: "Goals",
    description: "Keep one durable objective active across turns until it is completed, paused or blocked.",
    defaultEnabled: true,
    scopes: ["global", "project"],
    dependencies: [],
    capabilities: ["slash-command", "persistence", "pause-resume", "completion-safety"],
    restart: "worker",
  },
] as const;

export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "complete";

export interface SessionGoal {
  id: string;
  objective: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  automaticTurns: number;
  latestReason?: string;
  waitingUntil?: number;
}

export type GoalAction =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" }
  | { action: "edit"; objective: string }
  | { action: "start"; objective: string };
