/**
 * Undo this turn — the transcript control's pure decisions (leap §7.4).
 *
 * Restoring user prompt ordinal N puts back checkpoint N: the snapshot taken
 * before this turn's work (turn 0 is the open-time baseline). A failed or
 * pruned checkpoint is not offered. Hidden restore targets are omitted, not
 * disabled. Engine refusals are already sentences; keep them.
 */
import type {
  CheckpointInfo,
  RestorePreview,
  RestoreRepoPreview,
  RestoreRepoResult,
  RestoreTarget,
} from "@lasercode/protocol";

export const UNDO_TURN_RUNNING =
  "A turn is running, so this conversation cannot be restored until it finishes or is stopped.";
export const UNDO_TURN_PRUNED = "That turn's checkpoint is no longer kept.";
export const UNDO_TURN_FAILED = "This turn could not be restored. Try again.";

const TARGET_ORDER: readonly RestoreTarget[] = ["files", "conversation", "both"];

/** The checkpoint to restore for this prompt: ordinal 0 → turn 0 (baseline). */
export function restoreTurnForPrompt(userOrdinal: number): number {
  return userOrdinal;
}

export function turnCheckpoint(
  checkpoints: readonly CheckpointInfo[] | undefined,
  turn: number,
): CheckpointInfo | undefined {
  return checkpoints?.find((row) => row.turn === turn && !row.failed);
}

/** Options the engine marked as no-ops — hidden, not disabled. */
export function visibleRestoreTargets(hidden: readonly RestoreTarget[]): RestoreTarget[] {
  const hide = new Set(hidden);
  const files = !hide.has("files");
  const conversation = !hide.has("conversation");
  const targets: RestoreTarget[] = [];
  if (files) targets.push("files");
  if (conversation) targets.push("conversation");
  if (files && conversation && !hide.has("both")) targets.push("both");
  return TARGET_ORDER.filter((target) => targets.includes(target));
}

export function defaultRestoreTarget(visible: readonly RestoreTarget[]): RestoreTarget | undefined {
  if (visible.includes("both")) return "both";
  return visible[0];
}

export function restoreTargetLabel(target: RestoreTarget): string {
  switch (target) {
    case "files":
      return "Files";
    case "conversation":
      return "Conversation";
    case "both":
      return "Files and conversation";
  }
}

export function restoreWhatCopy(target: RestoreTarget): string {
  switch (target) {
    case "files":
      return "the files in this turn's checkpoint";
    case "conversation":
      return "the conversation, back to this turn";
    case "both":
      return "the files and the conversation";
  }
}

export function repoLeafName(repo: string): string {
  const trimmed = repo.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts.at(-1) || repo;
}

export function reposAffectedByFiles(repos: readonly RestoreRepoPreview[]): RestoreRepoPreview[] {
  return repos.filter((row) => row.files.length > 0);
}

export function restoreIncludesFiles(target: RestoreTarget): boolean {
  return target === "files" || target === "both";
}

export function restoreIncludesConversation(target: RestoreTarget): boolean {
  return target === "conversation" || target === "both";
}

/** A sentence the engine already wrote for a person — keep it. */
export function restoreErrorText(error: unknown, fallback = UNDO_TURN_FAILED): string {
  const raw = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (isPersonFacingSentence(raw)) return raw;
  return fallback;
}

export function isPersonFacingSentence(raw: string): boolean {
  if (raw.length < 8 || raw.length > 240) return false;
  if (/[\n\r]/.test(raw)) return false;
  if (/\b(?:TypeError|ReferenceError|SyntaxError)\b/.test(raw)) return false;
  if (/\bat\s+\S+\s*\(/.test(raw)) return false;
  return /^[A-ZÀ-ÖØ-Þ]/.test(raw) && /[.?!]$/.test(raw);
}

export function refusedRepos(repos: readonly RestoreRepoResult[] | undefined): RestoreRepoResult[] {
  return (repos ?? []).filter((row) => !row.restored);
}

export function repoRefusalSentence(row: RestoreRepoResult): string {
  const name = repoLeafName(row.repo);
  if (row.detail && isPersonFacingSentence(row.detail)) return row.detail;
  if (row.detail) return `${name}: ${row.detail}`;
  return `${name} was left unchanged.`;
}

export function restoreSuccessCopy(preview: RestorePreview, target: RestoreTarget, restored: { files: boolean; conversation: boolean }): string {
  if (restoreIncludesFiles(target) && restoreIncludesConversation(target) && restored.files && restored.conversation) {
    return "Restored this turn's files and moved the conversation back.";
  }
  if (restored.files) return "Restored this turn's files.";
  if (restored.conversation) return "Moved the conversation back to this turn.";
  return "Nothing was restored.";
}

export function previewHasWork(preview: RestorePreview, target: RestoreTarget): boolean {
  if (restoreIncludesFiles(target) && reposAffectedByFiles(preview.repos).length > 0) return true;
  if (restoreIncludesConversation(target) && preview.conversation) return true;
  return false;
}
