import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export type GoalTransitionInitiator = "person" | "agent" | "engine" | "worker" | "host" | "ui" | "failure";

export interface GoalTransition {
  goalId: string;
  at: number;
  cause: string;
  initiator: GoalTransitionInitiator;
  previousStatus: string;
  status: string;
  reason?: string;
  abortReason?: string;
  invocationId?: string;
  runId?: string;
}

export interface GoalSnapshot {
  id: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usage_limited" | "complete";
  startedAt: number;
  updatedAt: number;
  iteration: number;
  automaticTurns: number;
  latestReason?: string;
  waitingUntil?: number;
  transition?: GoalTransition;
}

/**
 * The tools the goal engine registers. They are attached to a session only
 * while a goal is active (D-146), so the names have to be known here rather
 * than discovered from the engine's private modules. `test/policy.test.ts`
 * asserts this list against the installed dependency, so a version that
 * renames or adds one fails there instead of silently un-gating the tools.
 */
export const GOAL_TOOL_NAMES: readonly string[] = ["goal_complete", "goal_blocked", "goal_wait"];

export type GoalToolActivationResult =
  | { ok: true }
  | { ok: false; reason: "missing_registration" | "activation_refused"; message: string };

export interface GoalToolActivationAccess {
  getRegisteredToolNames(): readonly string[];
  getActiveToolNames(): readonly string[];
  setActiveToolNames(names: string[]): void;
}

/**
 * Repair the active allowlist without dropping unrelated tools.
 *
 * This wrapper stays SDK-neutral so both the worker command preflight and the
 * companion extension use one policy. The patched upstream executable carries
 * a mechanical copy because it cannot import the wrapper that depends on it.
 */
export function ensureGoalToolsActive(access: GoalToolActivationAccess): GoalToolActivationResult {
  let registered: Set<string>;
  let active: Set<string>;
  try {
    registered = new Set(access.getRegisteredToolNames());
    active = new Set(access.getActiveToolNames());
  } catch {
    return activationRefused();
  }
  if (GOAL_TOOL_NAMES.some((name) => !registered.has(name))) {
    return {
      ok: false,
      reason: "missing_registration",
      message: "Goal tools did not load. Automatic goal work is waiting, but ordinary messages still work. Run /goal pause to stop the goal, or reload this conversation.",
    };
  }
  const missing = GOAL_TOOL_NAMES.filter((name) => !active.has(name));
  if (missing.length === 0) return { ok: true };
  try {
    access.setActiveToolNames([...active, ...missing]);
    const repaired = new Set(access.getActiveToolNames());
    if (GOAL_TOOL_NAMES.every((name) => repaired.has(name))) return { ok: true };
  } catch {
    // Return the stable public classification below; never leak SDK internals.
  }
  return activationRefused();
}

function activationRefused(): GoalToolActivationResult {
  return {
    ok: false,
    reason: "activation_refused",
    message: "Goal tools could not be activated. Automatic goal work is waiting, but ordinary messages still work. Run /goal pause to stop the goal, or reload this conversation.",
  };
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
    const goal = normalizeGoal(data.goal);
    if (!goal) return null;
    const transition = latestTransition(entries.slice(index + 1), goal.id, goal.status);
    return transition
      ? { ...goal, latestReason: transitionReason(transition), transition }
      : goal;
  }
  return null;
}

function normalizeGoal(value: unknown): GoalSnapshot | null {
  const goal = asRecord(value);
  if (!goal) return null;
  const id = string(goal.id);
  const objective = string(goal.text);
  const status = goal.status === "budget_limited" ? "paused" : goal.status;
  if (!id || !objective || !isStatus(status)) return null;
  const waiting = asRecord(goal.waiting);
  const latestReason = string(waiting?.reason) ?? reasonForSafety(goal.safetyPauseCause);
  const waitingUntil = finite(waiting?.resumeAt);
  return {
    id,
    objective,
    status,
    startedAt: finite(goal.startedAt) ?? Date.now(),
    updatedAt: finite(goal.updatedAt) ?? Date.now(),
    iteration: integer(goal.iteration),
    automaticTurns: integer(goal.automaticModelTurns),
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

function isStatus(value: unknown): value is GoalSnapshot["status"] {
  return value === "active" || value === "paused" || value === "blocked" || value === "usage_limited" || value === "complete";
}

function reasonForSafety(value: unknown): string | undefined {
  if (value === "continuation_limit") return "Paused after reaching the automatic continuation limit.";
  if (value === "no_progress") return "Paused because consecutive turns made no measurable progress.";
  return undefined;
}

function latestTransition(entries: readonly unknown[], goalId: string, status: string): GoalTransition | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (entry?.type !== "custom" || entry.customType !== "goal-transition") continue;
    const data = asRecord(entry.data);
    if (!data || data.goalId !== goalId || data.status !== status) continue;
    const initiator = transitionInitiator(data.initiator);
    const at = finite(data.at);
    const cause = string(data.cause);
    const previousStatus = string(data.previousStatus);
    if (!initiator || at === undefined || !cause || !previousStatus) return undefined;
    const reason = string(data.reason);
    const abortReason = string(data.abortReason);
    const invocationId = string(data.invocationId);
    const runId = string(data.runId);
    return {
      goalId,
      at,
      cause,
      initiator,
      previousStatus,
      status,
      ...(reason ? { reason } : {}),
      ...(abortReason ? { abortReason } : {}),
      ...(invocationId ? { invocationId } : {}),
      ...(runId ? { runId } : {}),
    };
  }
  return undefined;
}

function transitionInitiator(value: unknown): GoalTransitionInitiator | undefined {
  return value === "person" || value === "agent" || value === "engine" || value === "worker" || value === "host" || value === "ui" || value === "failure"
    ? value
    : undefined;
}

function transitionReason(transition: GoalTransition): string {
  if (transition.abortReason) return `Interrupted by ${transition.initiator}: ${transition.abortReason}`;
  if (transition.reason) return transition.reason;
  return `${transition.status === "paused" ? "Paused" : "Stopped"} by ${transition.initiator} (${transition.cause}).`;
}
