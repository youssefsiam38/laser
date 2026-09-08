import { GOAL_TOOL_NAMES, goalStateFromEntries, type GoalSnapshot } from "@lasercode/pi-goal";
import type { SessionGoal } from "@lasercode/protocol";
import type { LaserModule, ModuleContext } from "./index.js";

/** Product bridge for the reusable Pi-native goal engine. */
export const goalModule: LaserModule = {
  name: "goal",
  detect: () => true,
  activate(ctx) {
    const sync = () => {
      const goal = readGoal(ctx);
      syncGoalTools(ctx, goal !== null);
      ctx.send({ type: "lasercode/goal/state", goal });
    };
    sync();
    // Before the turn's request is built, so a session with no goal has lost
    // them by the time the model sees the request.
    ctx.pi.on("before_agent_start", () => {
      syncGoalTools(ctx, readGoal(ctx) !== null);
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
export function syncGoalTools(ctx: ModuleContext, goalActive: boolean): void {
  const pi = ctx.pi;
  try {
    const known = new Set(pi.getAllTools().map((tool) => tool.name));
    const gated = GOAL_TOOL_NAMES.filter((name) => known.has(name));
    if (gated.length === 0) return;
    const active = new Set(pi.getActiveTools());
    let changed = false;
    for (const name of gated) {
      if (goalActive && !active.has(name)) {
        active.add(name);
        changed = true;
      } else if (!goalActive && active.has(name)) {
        active.delete(name);
        changed = true;
      }
    }
    if (changed) pi.setActiveTools([...active]);
  } catch {
    // The tools stay as they are; a goal still runs, it is only wider.
  }
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
