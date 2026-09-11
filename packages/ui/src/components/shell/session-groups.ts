/**
 * The sessions panel's view model (D-20 §6): every project as a group in one
 * scrolling list, attention-sorted inside each group, plus the small list
 * state the rail drives — which group is filtered, where to jump, what is
 * collapsed. Pure helpers first; the store at the bottom is the only stateful
 * piece and is module-level so `Rail` and `SessionsPanel` share it without a
 * context the shell would have to own.
 */
import { WORKTREES_DIR_NAME, storageKey } from "@lasercode/protocol";
import { useSyncExternalStore } from "react";
import type { AgentRun, SessionSummary } from "@lasercode/protocol";

import { shortCwd } from "../../format.js";
import { rootCwdForSession, type MainTab } from "../../runtime/main-destination.js";
import { SESSIONS_TAB_STORAGE_KEY } from "../../runtime/session-tab-memory.js";
import { mergeSessions, parentPathOf, sessionTitle, sortSessions } from "../../runtime/threadList.js";
import type { AppState } from "../../store.js";
import { aggregateStatus, type Status } from "../status/status.js";
import { isUntitled, sessionStatus, sessionSubtitle, type SessionSubtitle, type Views, type Workers } from "./model.js";

// ---------------------------------------------------------------------------
// Tabs and workspaces (agents leap, Lane U2)
//
// The panel has two tabs. **Code** is every project as a group, plus the
// built-in Beam workspace as a group of its own after them. **Chat** is the
// projectless conversations: sessions in the built-in Chat workspace, one flat
// list. A child session an agent started belongs to its parent's group, never
// to the worktree directory it happens to run in.
// ---------------------------------------------------------------------------

export type SessionsTab = MainTab;
export const SESSIONS_TABS: readonly SessionsTab[] = ["chat", "code"];
export { SESSIONS_TAB_STORAGE_KEY };

/** The built-in workspace directories, from the agents snapshot; absent until it lands. */
export interface Workspaces {
  readonly beam?: string | undefined;
  readonly chat?: string | undefined;
}

export type SessionGroupKind = "project" | "beam" | "chat";

export const workspacesOf = (state: Pick<AppState, "agents">): Workspaces => state.agents.snapshot?.workspaces ?? {};

/** Which built-in workspace contains a directory, or `undefined` for a project. */
export function workspaceKindOf(cwd: string | undefined, workspaces: Workspaces): "beam" | "chat" | undefined {
  if (!cwd) return undefined;
  const path = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const within = (root: string | undefined): boolean => {
    if (root === undefined) return false;
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
  };
  if (within(workspaces.beam)) return "beam";
  if (within(workspaces.chat)) return "chat";
  return undefined;
}

export const isChildSession = (summary: Pick<SessionSummary, "agent" | "parentPath">): boolean =>
  summary.agent?.kind === "child" || parentPathOf(summary) !== undefined;

/**
 * A child's checkout lives under `<project>/.worktrees/<slug>` and is the
 * child's session directory; it is never a project of its own, so it never
 * gets a group header even when the rail lists it while the child is open.
 */
export const isWorktreeCwd = (cwd: string): boolean => cwd.split(/[\\/]/).includes(WORKTREES_DIR_NAME);

/**
 * The directory whose group a session lists under. A child climbs to its
 * top-most listed ancestor; one whose parent is gone falls back to the run's
 * project, then to its own directory, so nothing on disk is unreachable.
 */
export function groupCwdOf(
  summary: SessionSummary,
  byPath: ReadonlyMap<string, SessionSummary>,
  runs: Readonly<Record<string, AgentRun>> | readonly AgentRun[] = {},
): string {
  const registry = Array.isArray(runs) ? Object.fromEntries(runs.map((run) => [run.runId, run])) : runs;
  return rootCwdForSession(summary, [...byPath.values()], registry);
}

/** The name a group header shows. */
export function groupNameOf(cwd: string, kind: SessionGroupKind): string {
  if (kind === "beam") return "Beam";
  if (kind === "chat") return "Chat";
  return shortCwd(cwd);
}

/**
 * Everything a row renders, flattened out of the catalog and the live view, so
 * the panel can subscribe to a value that only changes when a row does — not
 * on every streamed token.
 */
export interface SessionRowModel {
  path: string;
  summary: SessionSummary;
  status: Status;
  title: string;
  untitled: boolean;
  sub: SessionSubtitle;
}

export interface SessionGroupModel {
  cwd: string;
  /** Last path segment, or the built-in workspace's product name. */
  name: string;
  kind: SessionGroupKind;
  /** Most attention-worthy session (a crashed worker counts as an error). */
  status: Status;
  needYou: number;
  rows: SessionRowModel[];
}

const rowOf = (summary: SessionSummary, views: Views): SessionRowModel => {
  const view = views[summary.path];
  return {
    path: summary.path,
    summary,
    status: sessionStatus(view, summary),
    title: sessionTitle(summary, view),
    untitled: isUntitled(summary, view),
    sub: sessionSubtitle(summary, view),
  };
};

/**
 * One group per known project, in rail order, each attention-sorted (waiting >
 * error > finished-unread > working > idle, then modified). A session whose cwd
 * is not a known project still gets a group, appended after the known ones, so
 * nothing on disk is ever unreachable from the list.
 */
export interface SessionGroupOptions {
  /** `code` (default) lists projects and Beam; `chat` lists the Chat workspace alone. */
  tab?: SessionsTab | undefined;
  workspaces?: Workspaces | undefined;
  /** The run registry, for placing a child whose parent is no longer listed. */
  runs?: Readonly<Record<string, AgentRun>> | undefined;
}

export function sessionGroups(
  projects: readonly string[],
  sessions: readonly SessionSummary[],
  views: Views,
  workers: Workers = {},
  options: SessionGroupOptions = {},
): SessionGroupModel[] {
  const tab = options.tab ?? "code";
  const workspaces = options.workspaces ?? {};
  const merged = mergeSessions(sessions, views);
  const byPath = new Map(merged.map((s) => [s.path, s]));
  const byCwd = new Map<string, SessionSummary[]>();
  for (const s of merged) {
    // A Beam or Chat session belongs to its workspace by its own record even
    // when its header names an older workspace directory (the workspaces
    // moved under the state directory); the directory never becomes a group.
    const recorded = s.agent?.kind === "beam" || s.agent?.kind === "chat" ? s.agent.kind : undefined;
    const rawCwd = groupCwdOf(s, byPath, options.runs ?? {});
    const kind = recorded ?? workspaceKindOf(rawCwd, workspaces);
    const cwd = kind && workspaces[kind] !== undefined ? workspaces[kind]! : rawCwd;
    // Each tab shows its own kind of conversation and nothing of the other's.
    if ((tab === "chat") !== (kind === "chat")) continue;
    const list = byCwd.get(cwd);
    if (list) list.push(s);
    else byCwd.set(cwd, [s]);
  }
  if (tab === "chat") {
    const cwd = workspaces.chat;
    const rows = cwd === undefined ? [] : [...(byCwd.get(cwd) ?? [])].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)).map((s) => rowOf(s, views));
    if (cwd === undefined || rows.length === 0) return [];
    return [{ cwd, name: groupNameOf(cwd, "chat"), kind: "chat", status: aggregateStatus(rows.map((r) => r.status)), needYou: rows.filter((r) => r.status === "waiting_for_input").length, rows }];
  }
  // Projects in rail order, then any directory the rail does not know, then
  // Beam last: it is a built-in feature, not a project.
  const order = projects.filter((cwd) => workspaceKindOf(cwd, workspaces) === undefined && !isWorktreeCwd(cwd));
  for (const cwd of byCwd.keys()) if (!order.includes(cwd) && workspaceKindOf(cwd, workspaces) === undefined) order.push(cwd);
  if (workspaces.beam !== undefined && byCwd.has(workspaces.beam)) order.push(workspaces.beam);
  return order.map((cwd) => {
    const kind: SessionGroupKind = workspaceKindOf(cwd, workspaces) ?? "project";
    const rows = sortSessions(byCwd.get(cwd) ?? [], views).map((s) => rowOf(s, views));
    const statuses = rows.map((r) => r.status);
    if (workers[cwd]?.status === "crashed") statuses.push("error");
    return {
      cwd,
      name: groupNameOf(cwd, kind),
      kind,
      status: aggregateStatus(statuses),
      needYou: rows.filter((r) => r.status === "waiting_for_input").length,
      rows,
    };
  });
}

/** Selector-friendly: derive groups from app state for a fixed project list and tab. */
export function groupsFor(projects: readonly string[], state: AppState, tab: SessionsTab = "code"): SessionGroupModel[] {
  return sessionGroups(projects, state.sessions, state.open, state.workers, { tab, workspaces: workspacesOf(state), runs: state.agents.runs });
}

export const sameRow = (a: SessionRowModel, b: SessionRowModel): boolean =>
  a.path === b.path &&
  a.status === b.status &&
  a.title === b.title &&
  a.untitled === b.untitled &&
  a.sub.text === b.sub.text &&
  a.sub.mono === b.sub.mono &&
  a.sub.tone === b.sub.tone &&
  a.summary.modifiedAt === b.summary.modifiedAt &&
  a.summary.name === b.summary.name &&
  a.summary.messageCount === b.summary.messageCount;

export const sameGroups = (a: readonly SessionGroupModel[], b: readonly SessionGroupModel[]): boolean =>
  a.length === b.length &&
  a.every((g, i) => {
    const h = b[i]!;
    return (
      g.cwd === h.cwd &&
      g.kind === h.kind &&
      g.status === h.status &&
      g.needYou === h.needYou &&
      g.rows.length === h.rows.length &&
      g.rows.every((row, j) => sameRow(row, h.rows[j]!))
    );
  });

/** A stable DOM id for a group header, so the rail can scroll to it. */
export function groupDomId(cwd: string): string {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) >>> 0;
  return `session-group-${h.toString(36)}`;
}

// ---------------------------------------------------------------------------
// List state shared by the rail and the panel
// ---------------------------------------------------------------------------

export const SESSION_GROUPS_STORAGE_KEY = storageKey("session-groups");
export const SESSION_PINS_STORAGE_KEY = storageKey("session-pins");

export interface SessionsListState {
  /** Only this project's group is shown; `undefined` = every project. */
  readonly filter: string | undefined;
  /** Scroll request: the panel consumes it by nonce. */
  readonly jump: { readonly cwd: string; readonly nonce: number } | undefined;
  /** Collapsed groups; persisted. */
  readonly collapsed: ReadonlySet<string>;
  /** Session paths, in pin order. Archived/missing sessions are not rendered. */
  readonly pinned: ReadonlySet<string>;
}

const readPaths = (key: string): Set<string> => {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
};

const writeCollapsed = (collapsed: ReadonlySet<string>): void => {
  try {
    globalThis.localStorage?.setItem(SESSION_GROUPS_STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* private mode / quota: the choice lives for this tab */
  }
};

let listState: SessionsListState = { filter: undefined, jump: undefined, collapsed: readPaths(SESSION_GROUPS_STORAGE_KEY), pinned: readPaths(SESSION_PINS_STORAGE_KEY) };
const listeners = new Set<() => void>();
let jumpNonce = 0;

const publish = (next: SessionsListState): void => {
  listState = next;
  for (const l of [...listeners]) l();
};

export const sessionsList = {
  get: (): SessionsListState => listState,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Show only `cwd`'s group, expanded, and scroll to it. */
  filter(cwd: string): void {
    const collapsed = new Set(listState.collapsed);
    collapsed.delete(cwd);
    if (collapsed.size !== listState.collapsed.size) writeCollapsed(collapsed);
    publish({ ...listState, filter: cwd, jump: { cwd, nonce: ++jumpNonce }, collapsed });
  },
  /** Back to every project, scrolled to `cwd` when given. */
  clearFilter(cwd?: string): void {
    publish({ ...listState, filter: undefined, jump: cwd ? { cwd, nonce: ++jumpNonce } : listState.jump });
  },
  jumpTo(cwd: string): void {
    const collapsed = new Set(listState.collapsed);
    collapsed.delete(cwd);
    if (collapsed.size !== listState.collapsed.size) writeCollapsed(collapsed);
    publish({ ...listState, collapsed, jump: { cwd, nonce: ++jumpNonce } });
  },
  toggleCollapsed(cwd: string): void {
    const collapsed = new Set(listState.collapsed);
    if (collapsed.has(cwd)) collapsed.delete(cwd);
    else collapsed.add(cwd);
    writeCollapsed(collapsed);
    publish({ ...listState, collapsed });
  },
  togglePinned(path: string): void {
    const pinned = new Set(listState.pinned);
    if (pinned.has(path)) pinned.delete(path);
    else pinned.add(path);
    try {
      globalThis.localStorage?.setItem(SESSION_PINS_STORAGE_KEY, JSON.stringify([...pinned]));
    } catch {
      // As with collapsed groups, private mode retains this tab's choice.
    }
    publish({ ...listState, pinned });
  },
  /** Test seam. */
  reset(): void {
    publish({ filter: undefined, jump: undefined, collapsed: new Set(), pinned: new Set() });
  },
};

export function useSessionsList(): SessionsListState {
  return useSyncExternalStore(sessionsList.subscribe, sessionsList.get, sessionsList.get);
}
