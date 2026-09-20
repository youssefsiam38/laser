/**
 * Undo this turn — the transcript control's pure decisions (leap §7.4).
 *
 * Restoring user prompt ordinal N puts back checkpoint N: the snapshot taken
 * before this turn's work (turn 0 is the open-time baseline). A failed or
 * pruned checkpoint is not offered. Hidden restore targets are omitted, not
 * disabled. Engine refusals are already sentences; keep them.
 */
import type {
  ChangedFile,
  CheckpointInfo,
  FileChangeStatus,
  ProjectChanges,
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

/** Prefer the snapshot tagged with this prompt's id; numbered turns are legacy. */
export function checkpointForPrompt(
  checkpoints: readonly CheckpointInfo[] | undefined,
  entryId: string | undefined,
  ordinal: number,
): CheckpointInfo | undefined {
  if (entryId) {
    const byId = checkpoints?.find((row) => row.entryId === entryId && !row.failed);
    if (byId) return byId;
  }
  return turnCheckpoint(checkpoints, restoreTurnForPrompt(ordinal));
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

/* -------------------------------------------------------------------------
 * What the confirmation shows: paths with their numbers (leap §7.4).
 * ---------------------------------------------------------------------- */

/**
 * The change scope whose work this undo takes back.
 *
 * Checkpoint `turn` is the snapshot standing before prompt ordinal `turn`'s
 * work, and `pi/project/changes` numbers a turn as the range between the
 * checkpoint before it and the one after it — so the turn this prompt *is*
 * counts from one: prompt ordinal 0 is turn 1. The engine refuses scope
 * `turn` 0 ("the open-time baseline is not a conversation turn"), which is
 * the same off-by-one seen from the other side.
 */
export function changesTurnForUndo(turn: number): number {
  return turn + 1;
}

/** The human count of the turn a prompt is: ordinal 0 is "turn 1". */
export function turnOrdinalLabel(turn: number): number {
  return turn + 1;
}

/** One path in the confirmation. Numbers are absent when nothing knows them. */
export interface UndoFileRow {
  path: string;
  /** Engine status, when the change list carries this path. */
  status?: FileChangeStatus;
  /** Lines added; `null` for a binary file; absent when unknown. */
  added?: number | null;
  removed?: number | null;
}

export interface UndoRepoTotals {
  files: number;
  added: number;
  removed: number;
  /** How many of `files` carried numbers. Zero means "no totals to show". */
  counted: number;
}

export interface UndoRepoRows {
  repo: string;
  branch: string;
  /** Paths the checkpoint writes back. */
  restored: UndoFileRow[];
  /** Uncommitted paths the write destroys. */
  lost: UndoFileRow[];
  totals: UndoRepoTotals;
}

function changedFilesByPath(changes: ProjectChanges | undefined, repo: string): Map<string, ChangedFile> {
  const row = (changes?.repos ?? []).find((candidate) => candidate.repo === repo);
  return new Map((row?.files ?? []).map((file) => [file.path, file]));
}

function toRow(path: string, known: ChangedFile | undefined): UndoFileRow {
  if (!known) return { path };
  return { path, status: known.status, added: known.added, removed: known.removed };
}

export function rowTotals(rows: readonly UndoFileRow[]): UndoRepoTotals {
  let added = 0;
  let removed = 0;
  let counted = 0;
  for (const row of rows) {
    if (typeof row.added === "number" && typeof row.removed === "number") {
      added += row.added;
      removed += row.removed;
      counted += 1;
    }
  }
  return { files: rows.length, added, removed, counted };
}

/**
 * Join the restore preview with the change lists. The preview owns which paths
 * move; the change lists only lend numbers. A path with no numbers is shown
 * bare — never with an invented zero.
 */
export function undoRepoRows(
  preview: RestorePreview,
  turnChanges?: ProjectChanges,
  uncommittedChanges?: ProjectChanges,
): UndoRepoRows[] {
  return reposAffectedByFiles(preview.repos).map((repo) => {
    const fromTurn = changedFilesByPath(turnChanges, repo.repo);
    const fromWorktree = changedFilesByPath(uncommittedChanges, repo.repo);
    const restored = repo.files.map((path) => toRow(path, fromTurn.get(path)));
    const lost = repo.uncommittedLost.map((path) => toRow(path, fromWorktree.get(path) ?? fromTurn.get(path)));
    return { repo: repo.repo, branch: repo.branch, restored, lost, totals: rowTotals(restored) };
  });
}

export function isBinaryRow(row: UndoFileRow): boolean {
  return row.added === null || row.removed === null;
}

/** `added`/`modified`/`deleted`, or `binary` when git counted no lines. */
export function fileStatusLabel(row: UndoFileRow): string | undefined {
  if (isBinaryRow(row)) return "binary";
  return row.status;
}

/** The accessible name of a file row: the whole path, then what changed. */
export function fileRowDescription(row: UndoFileRow): string {
  const parts: string[] = [row.path];
  const status = fileStatusLabel(row);
  if (status) parts.push(status);
  if (typeof row.added === "number" && row.added > 0) parts.push(`${row.added} ${row.added === 1 ? "line" : "lines"} added`);
  if (typeof row.removed === "number" && row.removed > 0) parts.push(`${row.removed} ${row.removed === 1 ? "line" : "lines"} removed`);
  parts.push("opens the diff");
  return parts.join(", ");
}

export function countedFiles(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function churnLabel(totals: { added: number; removed: number; counted: number }): string | undefined {
  if (totals.counted === 0) return undefined;
  if (totals.added === 0 && totals.removed === 0) return undefined;
  const parts: string[] = [];
  if (totals.added > 0) parts.push(`+${totals.added}`);
  if (totals.removed > 0) parts.push(`\u2212${totals.removed}`);
  return parts.join(" ");
}

/** `3 files · +42 −7`, or `3 files` when nothing lent numbers. */
export function repoTotalLabel(totals: UndoRepoTotals): string {
  const churn = churnLabel(totals);
  return churn ? `${countedFiles(totals.files)} \u00b7 ${churn}` : countedFiles(totals.files);
}

export function allTotals(rows: readonly UndoRepoRows[]): UndoRepoTotals {
  return rows.reduce<UndoRepoTotals>(
    (sum, row) => ({
      files: sum.files + row.totals.files,
      added: sum.added + row.totals.added,
      removed: sum.removed + row.totals.removed,
      counted: sum.counted + row.totals.counted,
    }),
    { files: 0, added: 0, removed: 0, counted: 0 },
  );
}

export function lostFileCount(rows: readonly UndoRepoRows[]): number {
  return rows.reduce((sum, row) => sum + row.lost.length, 0);
}

/** The one sentence the destructive half is owed: a count, and what happens. */
export function lostWorkSentence(count: number): string {
  if (count === 1) return "1 file with uncommitted changes is overwritten by the checkpoint's version.";
  return `${count} files with uncommitted changes are overwritten by the checkpoint's version.`;
}

function clockTime(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return undefined;
  return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The line above the lists: how much moves, across how many repositories, and
 * which turn this is. Never invents a total the change lists did not give.
 */
export function undoSummaryLine(input: {
  rows: readonly UndoRepoRows[];
  files: boolean;
  turn: number;
  at?: string | undefined;
}): string {
  const parts: string[] = [];
  if (input.files && input.rows.length > 0) {
    const totals = allTotals(input.rows);
    const repos = input.rows.length;
    parts.push(repos > 1 ? `${countedFiles(totals.files)} in ${repos} repositories` : countedFiles(totals.files));
    const churn = churnLabel(totals);
    if (churn) parts.push(churn);
  }
  const time = clockTime(input.at);
  parts.push(time ? `turn ${turnOrdinalLabel(input.turn)}, ${time}` : `turn ${turnOrdinalLabel(input.turn)}`);
  return parts.join(" \u00b7 ");
}

/** First rows of a list, with the remainder counted for an in-place "more". */
export const UNDO_ROWS_SHOWN = 6;

export function boundedRows<T>(
  rows: readonly T[],
  expanded: boolean,
  limit: number = UNDO_ROWS_SHOWN,
): { shown: readonly T[]; hidden: number } {
  if (expanded || rows.length <= limit) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, limit), hidden: rows.length - limit };
}

export function moreRowsLabel(hidden: number): string {
  return `and ${hidden} more`;
}
