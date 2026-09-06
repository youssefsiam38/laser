import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export interface GoalSnapshot {
  id: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
  startedAt: number;
  updatedAt: number;
  iteration: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeStartedAt?: number;
  tokenBudget?: number;
  automaticTurns: number;
  latestReason?: string;
  waitingUntil?: number;
}

/** Absolute entrypoint for Pi's own extension loader (which transpiles `.ts`). */
export function goalExtensionPath(): string {
  const packageRoot = dirname(require.resolve("@narumitw/pi-goal/package.json"));
  return join(packageRoot, "dist", "index.ts");
}

/**
 * Read the canonical state emitted by pi-goal without importing its internal
 * runtime. Last entry wins, including an explicit null written by Clear.
 */
export function goalStateFromEntries(entries: readonly unknown[]): GoalSnapshot | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (entry?.type !== "custom" || entry.customType !== "goal-state") continue;
    const data = asRecord(entry.data);
    if (!data || data.goal === null) return null;
    return normalizeGoal(data.goal);
  }
  return null;
}

function normalizeGoal(value: unknown): GoalSnapshot | null {
  const goal = asRecord(value);
  if (!goal) return null;
  const id = string(goal.id);
  const objective = string(goal.text);
  const status = goal.status;
  if (!id || !objective || !isStatus(status)) return null;
  const waiting = asRecord(goal.waiting);
  const latestReason = string(waiting?.reason) ?? reasonForSafety(goal.safetyPauseCause);
  const waitingUntil = finite(waiting?.resumeAt);
  const tokenBudget = positiveInteger(goal.tokenBudget);
  const activeStartedAt = finite(goal.activeStartedAt);
  return {
    id,
    objective,
    status,
    startedAt: finite(goal.startedAt) ?? Date.now(),
    updatedAt: finite(goal.updatedAt) ?? Date.now(),
    iteration: integer(goal.iteration),
    tokensUsed: finite(goal.tokensUsed) ?? 0,
    timeUsedSeconds: finite(goal.timeUsedSeconds) ?? 0,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    automaticTurns: integer(goal.automaticModelTurns),
    ...(activeStartedAt !== undefined ? { activeStartedAt } : {}),
    ...(latestReason ? { latestReason } : {}),
    ...(waitingUntil !== undefined ? { waitingUntil } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integer(value: unknown): number {
  const number = finite(value) ?? 0;
  return Math.floor(number);
}

function positiveInteger(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number > 0 ? Math.floor(number) : undefined;
}

function isStatus(value: unknown): value is GoalSnapshot["status"] {
  return value === "active" || value === "paused" || value === "blocked" || value === "usage_limited" || value === "budget_limited" || value === "complete";
}

function reasonForSafety(value: unknown): string | undefined {
  if (value === "continuation_limit") return "Paused after reaching the automatic continuation limit.";
  if (value === "no_progress") return "Paused because consecutive turns made no measurable progress.";
  return undefined;
}
