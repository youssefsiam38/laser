/**
 * The sessions panel's view model (D-20 §6): every project as a group in one
 * scrolling list, attention-sorted inside each group, plus the small list
 * state the rail drives — which group is filtered, where to jump, what is
 * collapsed. Pure helpers first; the store at the bottom is the only stateful
 * piece and is module-level so `Rail` and `SessionsPanel` share it without a
 * context the shell would have to own.
 */
import { storageKey } from "@lasercode/protocol";
import { useSyncExternalStore } from "react";
import type { SessionSummary } from "@lasercode/protocol";

import { shortCwd } from "../../format.js";
import { mergeSessions, sessionTitle, sortSessions } from "../../runtime/threadList.js";
import type { AppState } from "../../store.js";
import { aggregateStatus, type Status } from "../status/status.js";
import { isUntitled, sessionStatus, sessionSubtitle, type SessionSubtitle, type Views, type Workers } from "./model.js";

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
  /** Last path segment. */
  name: string;
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
export function sessionGroups(
  projects: readonly string[],
  sessions: readonly SessionSummary[],
  views: Views,
  workers: Workers = {},
): SessionGroupModel[] {
  const merged = mergeSessions(sessions, views);
  const byCwd = new Map<string, SessionSummary[]>();
  for (const s of merged) {
    const list = byCwd.get(s.cwd);
    if (list) list.push(s);
    else byCwd.set(s.cwd, [s]);
  }
  const order = [...projects];
  for (const cwd of byCwd.keys()) if (!order.includes(cwd)) order.push(cwd);
  return order.map((cwd) => {
    const rows = sortSessions(byCwd.get(cwd) ?? [], views).map((s) => rowOf(s, views));
    const statuses = rows.map((r) => r.status);
    if (workers[cwd]?.status === "crashed") statuses.push("error");
    return {
      cwd,
      name: shortCwd(cwd),
      status: aggregateStatus(statuses),
      needYou: rows.filter((r) => r.status === "waiting_for_input").length,
      rows,
    };
  });
}

/** Selector-friendly: derive groups from app state for a fixed project list. */
export function groupsFor(projects: readonly string[], state: AppState): SessionGroupModel[] {
  return sessionGroups(projects, state.sessions, state.open, state.workers);
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

export interface SessionsListState {
  /** Only this project's group is shown; `undefined` = every project. */
  readonly filter: string | undefined;
  /** Scroll request: the panel consumes it by nonce. */
  readonly jump: { readonly cwd: string; readonly nonce: number } | undefined;
  /** Collapsed groups; persisted. */
  readonly collapsed: ReadonlySet<string>;
}

const readCollapsed = (): Set<string> => {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(SESSION_GROUPS_STORAGE_KEY) ?? "[]");
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

let listState: SessionsListState = { filter: undefined, jump: undefined, collapsed: readCollapsed() };
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
    publish({ filter: cwd, jump: { cwd, nonce: ++jumpNonce }, collapsed });
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
  /** Test seam. */
  reset(): void {
    publish({ filter: undefined, jump: undefined, collapsed: new Set() });
  },
};

export function useSessionsList(): SessionsListState {
  return useSyncExternalStore(sessionsList.subscribe, sessionsList.get, sessionsList.get);
}
