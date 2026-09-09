"use client";
/**
 * A child agent's worktree, as the person's surfaces see it (M13-T42, D-157).
 *
 * Merging and removing a child's worktree belong to its parent. This is the
 * escape hatch for the parent that crashed, was cancelled, or simply stopped:
 * a person can read what a worktree holds and clear it, and is told about it
 * before deleting the session it belongs to.
 *
 * Three small things live here because the surfaces that need them are far
 * apart in the tree — the sessions sidebar's delete confirmation, the fleet's
 * detail row and the dialog the shell mounts once:
 *
 *   1. `useWorktreeStatus` — what one child's worktree holds, read from the
 *      host on demand. Never cached across sessions: an old count is worse
 *      than no count when the decision is destructive.
 *   2. the delete disposition — the one-shot instruction a delete carries.
 *      `pi/session/delete` takes it, and **omitting it keeps the worktree**;
 *      `aui.threadListItem.delete()` has no room for a parameter, so the
 *      dialog leaves the choice here and the adapter takes it.
 *   3. the removal request — which session the shell's `RemoveWorktreeDialog`
 *      is being asked about, in the shape `end-agent.ts` already uses.
 */
import type { AgentWorktreeStatus, SessionWorktreeDisposition } from "@lasercode/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// What the worktree holds
// ---------------------------------------------------------------------------

export interface WorktreeStatusState {
  loading: boolean;
  /** `null` once known to be absent: the child ran in its parent's checkout. */
  status: AgentWorktreeStatus | null | undefined;
  error: string | undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Ask the host what `path`'s worktree holds, while `enabled`. A closed dialog
 * asks nothing; a reopened one asks again, because the answer is a fact about
 * a directory that anything could have changed in between.
 */
export function useWorktreeStatus(
  path: string | undefined,
  enabled: boolean,
  read: (path: string) => Promise<AgentWorktreeStatus | null>,
): WorktreeStatusState {
  const [state, setState] = useState<WorktreeStatusState>({ loading: false, status: undefined, error: undefined });
  useEffect(() => {
    if (!enabled || !path) {
      setState({ loading: false, status: undefined, error: undefined });
      return;
    }
    let live = true;
    setState({ loading: true, status: undefined, error: undefined });
    read(path)
      .then((status) => {
        if (live) setState({ loading: false, status, error: undefined });
      })
      .catch((error: unknown) => {
        if (live) setState({ loading: false, status: undefined, error: messageOf(error) });
      });
    return () => {
      live = false;
    };
    // `read` is a stable action from the provider; re-running on its identity
    // would re-ask on every unrelated store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled]);
  return state;
}

/** How many commits and files, in a sentence a person can act on. */
export function describeWorktreeContents(status: AgentWorktreeStatus): string {
  if (!status.exists) return "Its directory is already gone.";
  const parts: string[] = [];
  if (status.unmergedCommits === null) parts.push("commits this app could not count");
  else if (status.unmergedCommits > 0) parts.push(`${status.unmergedCommits} commit${status.unmergedCommits === 1 ? "" : "s"} your project does not have`);
  if (status.uncommittedFiles === null) parts.push("changes this app could not read");
  else if (status.uncommittedFiles > 0) parts.push(`${status.uncommittedFiles} uncommitted file${status.uncommittedFiles === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Nothing in it is unmerged, so deleting it loses no work.";
  const list = parts.length === 2 ? `${parts[0]} and ${parts[1]}` : parts[0];
  return `It holds ${list}. Deleting it destroys that.`;
}

// ---------------------------------------------------------------------------
// The delete disposition
// ---------------------------------------------------------------------------

const dispositions = new Map<string, SessionWorktreeDisposition>();

/** The dialog's answer, left for the delete about to run. */
export function setWorktreeDisposition(path: string, disposition: SessionWorktreeDisposition): void {
  dispositions.set(path, disposition);
}

/**
 * The instruction for this delete, consumed once. Absent is `keep`: a delete
 * that reached the host without passing through the dialog never destroys a
 * child's work.
 */
export function takeWorktreeDisposition(path: string): SessionWorktreeDisposition {
  const found = dispositions.get(path);
  dispositions.delete(path);
  return found ?? "keep";
}

/** The dialog closed without deleting; nothing may outlive that. */
export function forgetWorktreeDisposition(path: string): void {
  dispositions.delete(path);
}

// ---------------------------------------------------------------------------
// The removal request (the fleet asks, the shell answers)
// ---------------------------------------------------------------------------

export interface RemoveWorktreeRequest {
  /** The child session whose worktree is being cleared. */
  readonly path: string;
  /** What to call it while asking: the agent's instance name. */
  readonly label: string;
}

let request: RemoveWorktreeRequest | undefined;
const listeners = new Set<() => void>();
const publish = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Ask the shell's `RemoveWorktreeDialog` about this child's worktree. */
export function requestRemoveWorktree(path: string, label: string): void {
  if (request?.path === path) return;
  request = { path, label };
  publish();
}

export function clearRemoveWorktreeRequest(): void {
  if (!request) return;
  request = undefined;
  publish();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = (): RemoveWorktreeRequest | undefined => request;
const none = (): RemoveWorktreeRequest | undefined => undefined;

export function useRemoveWorktreeRequest(): RemoveWorktreeRequest | undefined {
  return useSyncExternalStore(subscribe, read, none);
}
