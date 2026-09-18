import { GOAL_TOOL_NAMES, goalStateFromEntries, type GoalSnapshot } from "@lasercode/pi-goal";
import type { SessionGoal } from "@lasercode/protocol";
import type { LaserModule, ModuleContext } from "./index.js";

/** Product bridge for the reusable Pi-native goal engine. */
export const goalModule: LaserModule = {
  name: "goal",
  detect: () => true,
  activate(ctx) {
    // Every hook below is the engine's, and a module that throws inside one
    // takes the turn with it (AGENTS.md §6a: a module fails on its own). The
    // session's entries come from the engine — `getBranch` on a session being
    // rewritten, a shape the goal engine cannot read — and the worker's `send`
    // can be gone, so both are reported to the person instead of escaping.
    const report = (error: unknown) => {
      try {
        ctx.send({
          type: "lasercode/module/log",
          module: "goal",
          level: "warn",
          message: `could not read this session's goal: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch {
        // Nothing left to tell: the goal bar simply keeps its last state.
      }
    };
    let lastToolFailure: string | undefined;
    const syncTools = (goalActive: boolean) => {
      const result = syncGoalTools(ctx, goalActive);
      if (result.ok) {
        lastToolFailure = undefined;
        return;
      }
      if (result.message === lastToolFailure) return;
      lastToolFailure = result.message;
      try {
        ctx.send({
          type: "lasercode/module/log",
          module: "goal",
          level: "error",
          message: result.message,
        });
      } catch {
        // The worker is already gone; canonical goal state remains untouched.
      }
    };
    const sync = () => {
      try {
        const goal = readGoal(ctx);
        syncTools(goal !== null && goal.status === "active");
        ctx.send({ type: "lasercode/goal/state", goal });
      } catch (error) {
        report(error);
      }
    };
    sync();
    // Before the turn's request is built, so a session with no goal has lost
    // them by the time the model sees the request.
    ctx.pi.on("before_agent_start", () => {
      try {
        const goal = readGoal(ctx);
        syncTools(goal !== null && goal.status === "active");
      } catch (error) {
        report(error);
      }
      return undefined;
    });
    ctx.pi.on("agent_start", sync);
    ctx.pi.on("agent_end", sync);
    ctx.pi.on("agent_settled", sync);
    ctx.pi.on("session_compact", sync);
    // The current session_start is already being handled; this catches later
    // reload/new/resume/fork events on the same extension runner.
    ctx.pi.on("session_start", (_event, session) => {
      ctx.session = session;
      sync();
    });
  },
};

/**
 * Whether a prompt is the goal command.
 *
 * The engine refuses to start or resume a goal whose tools are not already
 * active, and its command dispatches before any hook here can see it — `input`
 * does not fire for a command — so the worker switches them on when it sees
 * this, before handing the text to the engine. Deliberately generous:
 * `/goal`, `/goal ship it`, `/goal clear`. Turning them on for a command that
 * turns out to clear a goal costs one turn's tools; the sync below takes them
 * away on the next.
 */
export function isGoalCommand(text: string): boolean {
  return /^\s*\/goal(\s|$)/.test(text);
}

/**
 * Attach the goal engine's tools only while a goal is active (D-146).
 *
 * The engine registers `goal_complete`, `goal_blocked` and `goal_wait` at
 * load, so without this they sit in every request of every session, and their
 * descriptions have to spend a paragraph each arguing that their own presence
 * does not mean a goal exists. Absence is the stronger guard, and it costs
 * nothing to read.
 *
 * Never throws: a session where the goal engine did not load has no such tools
 * to move, and a refused `setActiveTools` must not take the turn down with it.
 */
export type GoalToolSyncResult =
  | { ok: true }
  | { ok: false; reason: "missing_registration" | "activation_refused"; message: string };

export function syncGoalTools(ctx: ModuleContext, goalActive: boolean): GoalToolSyncResult {
  const pi = ctx.pi;
  let known: Set<string>;
  let active: Set<string>;
  try {
    known = new Set(pi.getAllTools().map((tool) => tool.name));
    active = new Set(pi.getActiveTools());
  } catch {
    return activationRefused();
  }
  const registered = GOAL_TOOL_NAMES.filter((name) => known.has(name));
  if (!goalActive) {
    const next = [...active].filter((name) => !registered.includes(name));
    if (next.length === active.size) return { ok: true };
    try {
      pi.setActiveTools(next);
    } catch {
      // A session with no active goal stays quiet; there is no goal recovery
      // to diagnose, and the engine owns the eventual allowlist reset.
    }
    return { ok: true };
  }
  if (registered.length !== GOAL_TOOL_NAMES.length) {
    return {
      ok: false,
      reason: "missing_registration",
      message: "Goal tools did not load. Reload this conversation; if the problem continues, turn Goals off and on in Features.",
    };
  }
  const missing = GOAL_TOOL_NAMES.filter((name) => !active.has(name));
  if (missing.length === 0) return { ok: true };
  try {
    pi.setActiveTools([...active, ...missing]);
    const repaired = new Set(pi.getActiveTools());
    if (GOAL_TOOL_NAMES.every((name) => repaired.has(name))) return { ok: true };
  } catch {
    // Classified below without leaking the engine's private error.
  }
  return activationRefused();
}

function activationRefused(): GoalToolSyncResult {
  return {
    ok: false,
    reason: "activation_refused",
    message: "Goal tools could not be activated. Reload this conversation; if the problem continues, turn Goals off and on in Features.",
  };
}

function readGoal(ctx: ModuleContext): SessionGoal | null {
  const entries = ctx.session?.sessionManager?.getBranch?.() ?? ctx.session?.sessionManager?.getEntries?.() ?? [];
  return toSessionGoal(goalStateFromEntries(entries));
}

export function toSessionGoal(goal: GoalSnapshot | null): SessionGoal | null {
  if (!goal) return null;
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    startedAt: goal.startedAt,
    updatedAt: goal.updatedAt,
    iteration: goal.iteration,
    automaticTurns: goal.automaticTurns,
    ...(goal.latestReason !== undefined ? { latestReason: goal.latestReason } : {}),
    ...(goal.waitingUntil !== undefined ? { waitingUntil: goal.waitingUntil } : {}),
  };
}
