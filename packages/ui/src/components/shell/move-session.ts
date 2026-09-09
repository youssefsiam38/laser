"use client";
/**
 * Moving a Chat session into a project (M13-T58).
 *
 * Which session a person is being asked about, as an external store in the
 * shape `end-agent.ts` uses: the row menu that asks lives deep in the
 * sessions list, and the one dialog that answers is mounted once in the
 * shell. Beside it, the pure ordering rule the dialog's project list follows.
 */
import type { ProjectInfo } from "@lasercode/protocol";
import { useSyncExternalStore } from "react";

export interface MoveSessionRequest {
  readonly path: string;
  /** The row's title, so the dialog can name what is moving. */
  readonly title: string;
}

let request: MoveSessionRequest | undefined;
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Ask the shell's `MoveSessionDialog` about this session. A second request replaces the first. */
export function requestMoveSession(next: MoveSessionRequest): void {
  if (request?.path === next.path) return;
  request = next;
  publish();
}

/** The dialog closed, or the move is done. */
export function clearMoveSessionRequest(): void {
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

const read = (): MoveSessionRequest | undefined => request;
const none = (): MoveSessionRequest | undefined => undefined;

export function useMoveSessionRequest(): MoveSessionRequest | undefined {
  return useSyncExternalStore(subscribe, read, none);
}

/**
 * The projects a session can move to, in the order the dialog lists them:
 * the current project first, then the most recently used, then the rest in
 * the sidebar's own order. `projects` is the Code tab's list already — the
 * built-in workspaces are never in it.
 */
export function orderProjectsForMove(
  projects: readonly string[],
  currentProject: string | undefined,
  info: Readonly<Record<string, Pick<ProjectInfo, "lastUsedAt">>> = {},
): string[] {
  const used = (cwd: string): number => {
    const at = info[cwd]?.lastUsedAt;
    const time = at === undefined ? Number.NaN : Date.parse(at);
    return Number.isNaN(time) ? 0 : time;
  };
  return projects
    .map((cwd, index) => ({ cwd, index }))
    .sort((a, b) => {
      if (a.cwd === currentProject) return -1;
      if (b.cwd === currentProject) return 1;
      return used(b.cwd) - used(a.cwd) || a.index - b.index;
    })
    .map((entry) => entry.cwd);
}
