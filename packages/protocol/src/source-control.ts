/**
 * Shared types for checkpoints, change scopes and restore (source-control leap L2).
 *
 * Ref layout and helpers live here so the worker, host and UI agree on names
 * without spelling the product. Capture, diffs and restore stay in the worker.
 */
import { PRODUCT_NAME } from "./identity.js";
import { ENTRY_RANGE_MAX_BYTES } from "./body-range.js";

/** Hidden ref namespace: `refs/<product>/checkpoints/<sessionKey>/<turn>`. */
export const CHECKPOINT_REF_NAMESPACE = `refs/${PRODUCT_NAME}/checkpoints`;

export const CHANGE_SCOPES = ["session", "turn", "uncommitted", "range", "agent"] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];

export const FILE_CHANGE_STATUSES = ["added", "modified", "deleted"] as const;
export type FileChangeStatus = (typeof FILE_CHANGE_STATUSES)[number];

/**
 * Per-project checkpoint retention. Default is the last 200 turns (D-316).
 * `all` never prunes; `off` captures nothing and deletes that session's refs.
 */
export const CHECKPOINT_RETENTION_VALUES = ["50", "200", "1000", "all", "off"] as const;
export type CheckpointRetention = (typeof CHECKPOINT_RETENTION_VALUES)[number];
export const CHECKPOINT_RETENTION_DEFAULT: CheckpointRetention = "200";

export const RESTORE_TARGETS = ["files", "conversation", "both"] as const;
export type RestoreTarget = (typeof RESTORE_TARGETS)[number];

/** Same ceiling the transcript uses: a large patch is paged, never sent whole. */
export const FILE_DIFF_MAX_BYTES = ENTRY_RANGE_MAX_BYTES;

/** Git's empty-tree OID. A well-known constant, not a captured object. */
export const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Per-project settings file under `PROJECT_DIR_NAME`. */
export const SOURCE_CONTROL_SETTINGS_FILE = "source-control.json";

/** A NUL byte in the first 8 KiB is git's own heuristic for "binary". */
export function gitLooksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, 8192);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}

export function checkpointRetentionFromSettingsJson(text: string): CheckpointRetention | undefined {
  try {
    const parsed = JSON.parse(text) as { checkpointRetention?: unknown };
    if (isCheckpointRetention(parsed.checkpointRetention)) return parsed.checkpointRetention;
  } catch {
    // Absent or unreadable: the caller uses the default.
  }
  return undefined;
}

export function mergeSourceControlSettingsJson(existing: Record<string, unknown>, retention: CheckpointRetention): string {
  return `${JSON.stringify({ ...existing, checkpointRetention: retention }, null, 2)}\n`;
}

export function isChangeScope(value: unknown): value is ChangeScope {
  return typeof value === "string" && (CHANGE_SCOPES as readonly string[]).includes(value);
}

export function isCheckpointRetention(value: unknown): value is CheckpointRetention {
  return typeof value === "string" && (CHECKPOINT_RETENTION_VALUES as readonly string[]).includes(value);
}

export function isRestoreTarget(value: unknown): value is RestoreTarget {
  return typeof value === "string" && (RESTORE_TARGETS as readonly string[]).includes(value);
}

/** How many turn checkpoints to keep, or `null` for every turn, or `0` for off. */
export function checkpointRetentionKeep(retention: CheckpointRetention): number | null {
  switch (retention) {
    case "50":
      return 50;
    case "200":
      return 200;
    case "1000":
      return 1000;
    case "all":
      return null;
    case "off":
      return 0;
  }
}

export function checkpointRefPrefix(sessionKey: string): string {
  return `${CHECKPOINT_REF_NAMESPACE}/${sessionKey}`;
}

export function checkpointRef(sessionKey: string, turn: number): string {
  return `${checkpointRefPrefix(sessionKey)}/${turn}`;
}

/** Parse `refs/<product>/checkpoints/<key>/<turn>` into its parts. */
export function parseCheckpointRef(ref: string): { sessionKey: string; turn: number } | undefined {
  const prefix = `${CHECKPOINT_REF_NAMESPACE}/`;
  if (!ref.startsWith(prefix)) return undefined;
  const rest = ref.slice(prefix.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0) return undefined;
  const sessionKey = rest.slice(0, slash);
  const turn = Number.parseInt(rest.slice(slash + 1), 10);
  if (!sessionKey || !Number.isInteger(turn) || turn < 0) return undefined;
  return { sessionKey, turn };
}

export interface ChangedFile {
  path: string;
  status: FileChangeStatus;
  /** Line counts from numstat; `null` for a binary file. */
  added: number | null;
  removed: number | null;
}

export interface RepoChanges {
  repo: string;
  branch: string;
  files: ChangedFile[];
}

/**
 * A scope whose starting checkpoint was pruned names that rather than
 * inventing a range from a later surviving ref.
 */
export interface PrunedScope {
  /** Oldest surviving turn, when any remain. */
  oldestTurn?: number;
  detail: string;
}

export interface AgentScopeFacts {
  runId: string;
  /** The run's worktree directory is no longer on disk. */
  worktreeRemoved?: boolean;
  /**
   * `refs/heads/<branch>` does not resolve in the project's repository.
   * Computed from git at query time, never inferred from an error string.
   */
  branchGone?: boolean;
}

export interface ProjectChanges {
  scope: ChangeScope;
  repos: RepoChanges[];
  pruned?: PrunedScope;
  /** Present for `scope: "agent"`. Computed at query time so a host restart still answers honestly. */
  agent?: AgentScopeFacts;
}

/** One repository's object for a session turn. The ref name is the same in every repository; the commit is not. */
export interface CheckpointRepoRef {
  repo: string;
  ref: string;
  commit: string;
}

export interface CheckpointInfo {
  turn: number;
  ref: string;
  commit: string;
  createdAt: string;
  entryId?: string;
  /** Capture for this turn failed; restore must refuse and diffs must say so. */
  failed?: true;
  /** Per-repository commits. Restore must use these, never `commit` alone. */
  repos?: CheckpointRepoRef[];
}

export interface CheckpointList {
  path: string;
  retention: CheckpointRetention;
  checkpoints: CheckpointInfo[];
  lastError?: string;
}

/** One page of a patch or of a file's bytes. */
export interface FileSlice {
  repo: string;
  path: string;
  totalBytes: number;
  offset: number;
  bytes: number;
  next?: number;
  truncated: boolean;
  /** Absent when the file is binary or empty. */
  text?: string;
  binary?: true;
}

export interface RestoreRepoPreview {
  repo: string;
  branch: string;
  /** Paths that would be written back from the checkpoint. */
  files: string[];
  /** Currently uncommitted paths that would be lost. */
  uncommittedLost: string[];
}

export interface RestorePreview {
  turn: number;
  restore: RestoreTarget;
  /** Options that would do nothing — hidden, not disabled. Always the full set, not filtered to the requested target. */
  hidden: RestoreTarget[];
  repos: RestoreRepoPreview[];
  conversation?: { entryId: string; turn: number };
  /** A single add -A tree cannot record staged vs unstaged, so restore never writes the index. */
  staging?: "not_restored";
  /** Person-facing sentence for the confirmation. */
  detail?: string;
}

export interface RestoreRepoResult {
  repo: string;
  restored: boolean;
  detail?: string;
}

export interface RestoreResult {
  preview: RestorePreview;
  restored?: { files: boolean; conversation: boolean; repos?: RestoreRepoResult[] };
}

export interface ProjectChangesParams {
  cwd: string;
  path: string;
  scope: ChangeScope;
  /** Session working directory when it is not `cwd` (a child worktree). */
  workdir?: string;
  /** Required for `turn`. */
  turn?: number;
  /** Required for `range`. */
  fromRef?: string;
  toRef?: string;
  /** Required for `agent`. */
  runId?: string;
}

export interface ProjectFileDiffParams {
  cwd: string;
  path: string;
  scope: ChangeScope;
  repo: string;
  file: string;
  workdir?: string;
  turn?: number;
  fromRef?: string;
  toRef?: string;
  runId?: string;
  /** Unified-diff context lines; default 3. */
  context?: number;
  offset?: number;
  limit?: number;
}

export interface ProjectFileSourceParams {
  cwd: string;
  path: string;
  repo: string;
  file: string;
  /**
   * Git revision, a checkpoint ref, or `"worktree"` for the file on disk.
   * Default is the scope's right-hand side.
   */
  ref?: string;
  workdir?: string;
  /** Agent-scope source: the run whose worktree `repo` was listed from. */
  runId?: string;
  offset?: number;
  limit?: number;
}

export interface CheckpointListParams {
  cwd: string;
  path: string;
}

export interface ProjectRestoreParams {
  cwd: string;
  path: string;
  turn: number;
  restore: RestoreTarget;
  /** Without this, only the confirmation payload is returned. */
  confirm?: boolean;
  workdir?: string;
}

export interface CheckpointRetentionSetParams {
  cwd: string;
  retention: CheckpointRetention;
}
