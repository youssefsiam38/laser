import type { ActivationBlockers } from "./runtime-activation.js";

export type RuntimeUpdateNoticeState =
  | "downloaded" | "parking" | "preparing-data" | "ready" | "restarting"
  | "succeeded" | "failed" | "migration-failed" | "restoring" | "restored" | "no-snapshot";
export type RuntimeUpdateNoticeAction = "prepare" | "cancel" | "activate" | "retry" | "restore" | "none";

export interface RuntimeUpdatePresentation {
  title: string;
  detail: string;
  action: RuntimeUpdateNoticeAction;
  actionLabel?: string;
  secondaryAction?: RuntimeUpdateNoticeAction;
  secondaryActionLabel?: string;
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
export type RuntimeMigrationCopyKey =
  | "newer-schema" | "unsafe" | "space" | "owner" | "snapshot-damaged" | "restore-space" | "restore-failed"
  | "prepare-failed";

export function runtimeMigrationEventCopy(phase: "preparing" | "migrating" | "ready"): string {
  if (phase === "ready") return "Data preparation finished.";
  return runtimeUpdatePresentation("preparing-data").title;
}

export function runtimeMigrationCopy(key: RuntimeMigrationCopyKey): string {
  switch (key) {
    case "newer-schema": return "This data was written by a newer app version. Update the app before opening it.";
    case "space": return "There is not enough free space to prepare this update safely.";
    case "owner": return "Another update already owns data preparation.";
    case "snapshot-damaged": return "The previous data snapshot is damaged.";
    case "restore-space": return "There is not enough free space to restore the previous data snapshot.";
    case "restore-failed": return "The previous data snapshot could not be restored safely.";
    case "prepare-failed": return "The app could not prepare your data for this update. Try again, or restore your previous data.";
    case "unsafe": return "The update could not prepare your data safely.";
  }
}

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
    case "preparing-data":
      return {
        title: "Preparing your data for this update…",
        detail: "Your current data snapshot is being verified before anything changes.",
        action: "none",
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
    case "migration-failed":
      return {
        title: "The update could not be finished.",
        detail: "Your previous data snapshot is intact.",
        action: "prepare",
        actionLabel: "Try again",
        secondaryAction: "restore",
        secondaryActionLabel: "Restore previous data",
      };
    case "restoring":
      return { title: "Restoring your previous data…", detail: "Keep the app open while restoration finishes.", action: "none" };
    case "restored":
      return {
        title: "Previous data restored. The update was not activated.",
        detail: "Your previous data is intact. You can try the update again when you are ready.",
        action: "prepare",
        actionLabel: "Try again",
      };
    case "no-snapshot":
      return {
        title: "The update could not be finished.",
        detail: "There is no earlier data snapshot to restore.",
        action: "retry",
        actionLabel: "Try again",
      };
  }
}
