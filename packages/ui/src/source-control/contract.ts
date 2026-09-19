/**
 * Shapes the overlay consumes. Local until M18-T2 lands the protocol types.
 *
 * TODO(M18-T2): replace with the protocol types. The field names and unions
 * below are the swap contract — keep them identical so the adapter rewrite is
 * mechanical.
 */

export type ChangesScopeKind = "session" | "turn" | "uncommitted" | "range" | "agent";

export type ChangesScope =
  | { kind: "session" }
  | { kind: "turn"; turnId: string }
  | { kind: "uncommitted" }
  | { kind: "range"; from: string; to: string }
  | { kind: "agent"; runId: string };

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed" | "binary" | "mode";

export type ChangedFile = {
  path: string;
  status: FileChangeStatus;
  added: number;
  removed: number;
  oldPath?: string;
  /** Bytes, when the authority knows them (binary, added). */
  size?: number;
  oldSize?: number;
  mode?: string;
  prevMode?: string;
};

export type ChangedRepo = {
  repo: string;
  branch: string;
  files: ChangedFile[];
  /** A repository the authority could not read. Files stay empty. */
  error?: string;
};

export type ChangesList = {
  scope: ChangesScope;
  repos: ChangedRepo[];
};

export type FileDiffPage = {
  repo: string;
  path: string;
  status: FileChangeStatus;
  added: number;
  removed: number;
  oldPath?: string;
  mode?: string;
  prevMode?: string;
  size?: number;
  oldSize?: number;
  /** Unified patch for this file. Empty when the change has no textual hunks. */
  patch: string;
  /** Byte offset of this page in the full patch. */
  offset?: number;
  /** Bytes in this page. */
  bytes?: number;
  /** Byte offset for the next page; absent when this is the last page. */
  nextOffset?: number;
  truncated?: boolean;
};

export type FileSource = {
  repo: string;
  path: string;
  ref: string;
  contents: string;
};

export type AgentCheckoutKind = "worktree" | "shared";

export type AgentChangesContext = {
  runId: string;
  checkout: AgentCheckoutKind;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  /** Worktree is gone; the branch still exists and is what we show. */
  worktreeRemoved?: boolean;
  /** The branch is gone, so there is nothing to show. */
  branchGone?: boolean;
};

export type OpenChangesArgs = {
  scope: ChangesScope;
  repo?: string;
  path?: string;
  /** Conversation this overlay belongs to; tabs and viewed ticks key off it. */
  sessionKey?: string;
};
