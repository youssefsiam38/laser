import { goalStateFromEntries, type GoalSnapshot } from "@lasercode/pi-goal";
import type { SessionGoal } from "@lasercode/protocol";
import type { LaserModule, ModuleContext } from "./index.js";

/** Product bridge for the reusable Pi-native goal engine. */
export const goalModule: LaserModule = {
  name: "goal",
  detect: () => true,
  activate(ctx) {
    const emit = () => ctx.send({ type: "lasercode/goal/state", goal: readGoal(ctx) });
    emit();
    ctx.pi.on("agent_start", emit);
    ctx.pi.on("agent_end", emit);
    ctx.pi.on("agent_settled", emit);
    ctx.pi.on("session_compact", emit);
    // The current session_start is already being handled; this catches later
    // reload/new/resume/fork events on the same extension runner.
    ctx.pi.on("session_start", (_event, session) => {
      ctx.session = session;
      emit();
    });
  },
};

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
