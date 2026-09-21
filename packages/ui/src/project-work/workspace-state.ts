"use client";
/**
 * Where the embedded workspace is, in this window.
 *
 * A small external store rather than a context, because the things that open
 * it are far apart — the top bar's control, a slash command, the palette, a
 * transcript card, a deep link — and the workspace that answers is mounted
 * once, inside the shell's main column. The conversation underneath is never
 * unmounted, so this is a *view* state and not a route.
 *
 * What it is **not**: the shell's remembered column layout. Opening the
 * workspace borrows the room the fleet and monitor hold and gives it back on
 * close, without writing anyone's preferences (D-355, "Opening and closing").
 */
import { useSyncExternalStore } from "react";

import type { ProjectWorkKind } from "@lasercode/protocol";

import { consumeWorkLink, readWorkLink, type WorkLinkTarget } from "./deep-link.js";
import { projectWorkFor } from "./registry.js";

export const WORKSPACE_TABS = ["work", "board", "needs-you", "recent"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/** The entity the detail column is reading, at the revision it was asked for. */
export interface WorkspaceSelection {
  entityId: string;
  kind: ProjectWorkKind;
  /** Set only when a link named an exact revision; otherwise the current one. */
  revisionId?: string;
  /** True when the person arrived from a link, so the detail can say so. */
  fromLink?: boolean;
}

export interface WorkspaceUiState {
  open: boolean;
  /** The project the workspace is showing. Undefined before it is opened. */
  projectId: string | undefined;
  tab: WorkspaceTab;
  selection: WorkspaceSelection | undefined;
  /** The Create dialog, and the kind it opened on. */
  creating: ProjectWorkKind | undefined;
  /** A link this window could not honour, and why. Shown in the workspace. */
  linkError: string | undefined;
}

let state: WorkspaceUiState = { open: false, projectId: undefined, tab: "work", selection: undefined, creating: undefined, linkError: undefined };
const listeners = new Set<() => void>();

const publish = (next: WorkspaceUiState): void => {
  state = next;
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const snapshot = (): WorkspaceUiState => state;

export function useWorkspaceUi(): WorkspaceUiState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Read it outside React (a command, a link, a test). */
export function workspaceUi(): WorkspaceUiState {
  return state;
}

export function openWorkspace(target: { projectId: string; tab?: WorkspaceTab; selection?: WorkspaceSelection }): void {
  publish({
    ...state,
    open: true,
    projectId: target.projectId,
    tab: target.tab ?? (target.selection ? "work" : state.projectId === target.projectId ? state.tab : "work"),
    selection: target.selection ?? (state.projectId === target.projectId ? state.selection : undefined),
    linkError: undefined,
  });
}

export function closeWorkspace(): void {
  if (!state.open) return;
  publish({ ...state, open: false, creating: undefined });
}

export function setWorkspaceTab(tab: WorkspaceTab): void {
  if (state.tab === tab) return;
  publish({ ...state, tab });
}

export function selectWork(selection: WorkspaceSelection | undefined): void {
  publish({ ...state, selection, linkError: undefined });
}

export function openWorkCreate(kind: ProjectWorkKind | undefined): void {
  publish({ ...state, creating: kind, ...(kind ? { open: true } : {}) });
}

export function setWorkspaceLinkError(message: string | undefined): void {
  if (state.linkError === message) return;
  publish({ ...state, linkError: message });
}

/** Test seam. The module store outlives a test file otherwise. */
export function resetWorkspaceUi(): void {
  publish({ open: false, projectId: undefined, tab: "work", selection: undefined, creating: undefined, linkError: undefined });
}

/**
 * Land a link on the exact entity it names.
 *
 * The identity is complete in the link, so nothing is searched for and nothing
 * falls back to "whatever is current": the project is read by its stable id,
 * and the detail opens at the revision the link carries. A project this device
 * cannot read is an explained refusal, because quietly showing something else
 * is how a link stops meaning anything.
 */
export function landWorkLink(target: WorkLinkTarget): void {
  // Warm the project's cache by its stable id. Before a connection exists the
  // registry answers nothing, and the workspace's own hook reads it again.
  void projectWorkFor(target.projectId)?.open();
  openWorkspace({
    projectId: target.projectId,
    ...(target.entityId && target.kind
      ? {
          selection: {
            entityId: target.entityId,
            kind: target.kind,
            ...(target.revisionId ? { revisionId: target.revisionId } : {}),
            fromLink: true,
          },
        }
      : {}),
  });
}

/**
 * Honour the link this window was opened with, once. The shell's session route
 * leaves a `#/work/…` hash alone, so this is the only consumer of it.
 */
export function honourWorkLinkFromLocation(): boolean {
  const target = readWorkLink();
  if (!target) return false;
  consumeWorkLink();
  landWorkLink(target);
  return true;
}
