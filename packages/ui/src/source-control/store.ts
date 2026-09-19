import { useSyncExternalStore } from "react";

import type { ChangesScope, OpenChangesArgs } from "./contract.js";
import { fileKey } from "./classify.js";
import type { GitActionKind } from "./git-model.js";
import { readDiffStylePref, writeDiffStylePref, type DiffStylePref } from "./prefs.js";

export type OpenFile = { repo: string; path: string };

export type GitActionRequest = { kind: GitActionKind; repo: string };

export type OverlayPullRequest = { repo: string; number: number };

export type ChangesUiSnapshot = {
  open: boolean;
  sessionKey: string;
  request: OpenChangesArgs | null;
  scope: ChangesScope;
  repoFilter: string | null;
  treeOpen: boolean;
  findOpen: boolean;
  tabs: OpenFile[];
  active: OpenFile | undefined;
  viewed: ReadonlySet<string>;
  /** Set after a successful `pi/project/pr/read`; ticks then call `pi/project/pr/viewed`. */
  pullRequest: OverlayPullRequest | null;
  /** Engine sentence when a viewed mark stayed local. */
  viewedNote: string | null;
  diffStyle: DiffStylePref;
  unifiedFallback: boolean;
  fallbackSaid: boolean;
  revealedLarge: ReadonlySet<string>;
  gitAction: GitActionRequest | null;
};

const listeners = new Set<() => void>();

let open = false;
let sessionKey = "default";
let request: OpenChangesArgs | null = null;
let scope: ChangesScope = { kind: "session" };
let repoFilter: string | null = null;
let treeOpen = false;
let findOpen = false;
let diffStyle: DiffStylePref = readDiffStylePref();
let unifiedFallback = false;
let fallbackSaid = false;
let gitAction: GitActionRequest | null = null;
let pullRequest: OverlayPullRequest | null = null;
let viewedNote: string | null = null;

const tabsBySession = new Map<string, OpenFile[]>();
const activeBySession = new Map<string, OpenFile>();
const viewedBySession = new Map<string, Set<string>>();
const revealedLargeBySession = new Map<string, Set<string>>();

const publish = (): void => {
  for (const listener of [...listeners]) listener();
};

const tabsOf = (key: string): OpenFile[] => tabsBySession.get(key) ?? [];
const viewedOf = (key: string): Set<string> => {
  let set = viewedBySession.get(key);
  if (!set) {
    set = new Set();
    viewedBySession.set(key, set);
  }
  return set;
};
const revealedOf = (key: string): Set<string> => {
  let set = revealedLargeBySession.get(key);
  if (!set) {
    set = new Set();
    revealedLargeBySession.set(key, set);
  }
  return set;
};

const sameFile = (a: OpenFile | undefined, b: OpenFile | undefined): boolean =>
  Boolean(a && b && a.repo === b.repo && a.path === b.path);

function snapshot(): ChangesUiSnapshot {
  return {
    open,
    sessionKey,
    request,
    scope,
    repoFilter,
    treeOpen,
    findOpen,
    tabs: tabsOf(sessionKey),
    active: activeBySession.get(sessionKey),
    viewed: viewedOf(sessionKey),
    diffStyle,
    unifiedFallback,
    fallbackSaid,
    revealedLarge: revealedOf(sessionKey),
    gitAction,
    pullRequest,
    viewedNote,
  };
}

let current = snapshot();

const refresh = (): void => {
  current = snapshot();
  publish();
};

export function openChanges(args: OpenChangesArgs): void {
  sessionKey = args.sessionKey ?? sessionKey;
  request = args;
  scope = args.scope;
  open = true;
  findOpen = false;
  treeOpen = false;
  fallbackSaid = false;
  if (args.repo && args.path) addTab(args.repo, args.path);
  else refresh();
}

export function closeChanges(): void {
  if (!open) return;
  open = false;
  findOpen = false;
  treeOpen = false;
  fallbackSaid = false;
  unifiedFallback = false;
  gitAction = null;
  pullRequest = null;
  viewedNote = null;
  refresh();
}

export function requestGitAction(next: GitActionRequest): void {
  gitAction = next;
  refresh();
}

export function clearGitAction(): void {
  if (!gitAction) return;
  gitAction = null;
  refresh();
}

export function setChangesScope(next: ChangesScope): void {
  scope = next;
  if (request) request = { ...request, scope: next };
  refresh();
}

export function setRepoFilter(next: string | null): void {
  repoFilter = next;
  refresh();
}

export function setTreeOpen(next: boolean): void {
  treeOpen = next;
  refresh();
}

export function setFindOpen(next: boolean): void {
  findOpen = next;
  refresh();
}

export function addTab(repo: string, path: string): void {
  const tabs = [...tabsOf(sessionKey)];
  if (!tabs.some((tab) => tab.repo === repo && tab.path === path)) tabs.push({ repo, path });
  tabsBySession.set(sessionKey, tabs);
  activeBySession.set(sessionKey, { repo, path });
  refresh();
}

export function closeTab(repo: string, path: string): void {
  const tabs = tabsOf(sessionKey).filter((tab) => !(tab.repo === repo && tab.path === path));
  tabsBySession.set(sessionKey, tabs);
  const active = activeBySession.get(sessionKey);
  if (sameFile(active, { repo, path })) {
    const next = tabs.at(-1);
    if (next) activeBySession.set(sessionKey, next);
    else activeBySession.delete(sessionKey);
  }
  refresh();
}

export function selectTab(repo: string, path: string): void {
  addTab(repo, path);
}

export function cycleTab(delta: number): void {
  const tabs = tabsOf(sessionKey);
  if (!tabs.length) return;
  const active = activeBySession.get(sessionKey);
  const index = Math.max(0, tabs.findIndex((tab) => sameFile(tab, active)));
  const next = tabs[(index + delta + tabs.length) % tabs.length]!;
  activeBySession.set(sessionKey, next);
  refresh();
}

export function cycleFile(files: OpenFile[], delta: number): void {
  if (!files.length) return;
  const active = activeBySession.get(sessionKey);
  const index = files.findIndex((file) => sameFile(file, active));
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
  const next = files[(from + delta + files.length) % files.length]!;
  addTab(next.repo, next.path);
}

export function toggleViewed(repo: string, path: string): void {
  const set = viewedOf(sessionKey);
  const key = fileKey(repo, path);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  refresh();
}

/** Remember the pull request whose files the overlay is showing, and seed ticks from its viewed marks. */
export function attachOverlayPullRequest(next: OverlayPullRequest & { viewedPaths?: readonly string[] }): void {
  pullRequest = { repo: next.repo, number: next.number };
  viewedNote = null;
  if (next.viewedPaths) {
    const set = viewedOf(sessionKey);
    for (const path of next.viewedPaths) set.add(fileKey(next.repo, path));
  }
  refresh();
}

export function setViewedNote(next: string | null): void {
  if (viewedNote === next) return;
  viewedNote = next;
  refresh();
}

export function setDiffStyle(next: DiffStylePref): void {
  diffStyle = next;
  writeDiffStylePref(next);
  refresh();
}

export function setUnifiedFallback(active: boolean): void {
  if (unifiedFallback === active) return;
  unifiedFallback = active;
  refresh();
}

export function dismissFallbackNotice(): void {
  if (fallbackSaid) return;
  fallbackSaid = true;
  refresh();
}

export function revealLargeFile(repo: string, path: string): void {
  revealedOf(sessionKey).add(fileKey(repo, path));
  refresh();
}

export function isLargeRevealed(repo: string, path: string, revealed: ReadonlySet<string>): boolean {
  return revealed.has(fileKey(repo, path));
}

/** Test helper: drop in-memory overlay state without touching the person's preference. */
export function resetChangesUi(): void {
  open = false;
  sessionKey = "default";
  request = null;
  scope = { kind: "session" };
  repoFilter = null;
  treeOpen = false;
  findOpen = false;
  unifiedFallback = false;
  fallbackSaid = false;
  tabsBySession.clear();
  activeBySession.clear();
  viewedBySession.clear();
  revealedLargeBySession.clear();
  gitAction = null;
  pullRequest = null;
  viewedNote = null;
  diffStyle = readDiffStylePref();
  refresh();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useChangesUi(): ChangesUiSnapshot {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Snapshot for tests. Production reads through {@link useChangesUi}. */
export function peekChangesUi(): ChangesUiSnapshot {
  return current;
}
