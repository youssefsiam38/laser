import type { ActivationBlockers } from "./runtime-activation.js";

export type RuntimeUpdateNoticeState = "downloaded" | "parking" | "ready" | "restarting" | "succeeded" | "failed";
export type RuntimeUpdateNoticeAction = "prepare" | "cancel" | "activate" | "retry" | "none";

export interface RuntimeUpdatePresentation {
  title: string;
  detail: string;
  action: RuntimeUpdateNoticeAction;
  actionLabel?: string;
}

function blockerDetail(blockers?: ActivationBlockers): string {
  if (!blockers) return "Finishing the work already in progress.";
  const labels: Array<[number, string, string]> = [
    [blockers.conversations, "conversation", "conversations"],
    [blockers.agents, "agent", "agents"],
    [blockers.questions + blockers.approvals, "question or approval", "questions or approvals"],
    [blockers.commands, "command", "commands"],
  ];
  const visible = labels
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return visible.length > 0 ? visible.join(" · ") : "Finishing the work already in progress.";
}

/** The only source for native update notice copy and actions. */
export function runtimeUpdatePresentation(
  state: RuntimeUpdateNoticeState,
  blockers?: ActivationBlockers,
): RuntimeUpdatePresentation {
  switch (state) {
    case "downloaded":
      return {
        title: "Update downloaded.",
        detail: "Prepare a restart when your current work is finished.",
        action: "prepare",
        actionLabel: "Prepare restart",
      };
    case "parking":
      return {
        title: "Waiting for current work to finish.",
        detail: blockerDetail(blockers),
        action: "cancel",
        actionLabel: "Keep working",
      };
    case "ready":
      return {
        title: "The update is ready to activate.",
        detail: "Saved sessions are kept. No active work will be stopped.",
        action: "activate",
        actionLabel: "Restart and update",
      };
    case "restarting":
      return {
        title: "Restarting into the update…",
        detail: "Saved sessions are kept. No active work will be stopped.",
        action: "none",
      };
    case "succeeded":
      return { title: "The update is active.", detail: "The verified update started successfully.", action: "none" };
    case "failed":
      return {
        title: "The update could not start.",
        detail: "Try again or reinstall the app. Your saved data remains available to restore.",
        action: "retry",
        actionLabel: "Try again",
      };
  }
}
