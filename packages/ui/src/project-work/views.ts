"use client";
/**
 * The backlog's filters, its sort, and the saved views a person names.
 *
 * A saved view *is* a named filter (D-355, "Structure"): there is no separate
 * per-kind screen, because "Specs" is just a filter somebody saved. They live
 * in the host's preferences beside the theme (`pi/prefs/*`), so they belong to
 * the person's laser rather than to one browser — a phone that pairs with a
 * desktop finds the same views.
 *
 * The loop is closed the way `runtime/prefs.ts` closes the theme's: the host
 * is the source of truth, this window writes debounced, and both ends compare
 * the serialised value so an echo settles instead of ping-ponging.
 */
import { useEffect } from "react";
import { useSyncExternalStore } from "react";

import type { ProjectWorkKind, ProjectWorkListItem } from "@lasercode/protocol";

import type { HostClient } from "../client.js";
import { compareKeys } from "./model.js";

/** The namespace the workspace's own preferences live in. Host-owned. */
export const PROJECT_WORK_PREFS_NAMESPACE = "project-work";
const PUSH_DEBOUNCE_MS = 400;

export type WorkSort = "updated" | "key" | "status";

export interface WorkFilter {
  kinds: readonly ProjectWorkKind[];
  text: string;
  needsYou: boolean;
  hasLink: boolean;
  includeArchived: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  filter: WorkFilter;
  sort: WorkSort;
}

export const EMPTY_FILTER: WorkFilter = { kinds: [], text: "", needsYou: false, hasLink: false, includeArchived: false };

export function isEmptyFilter(filter: WorkFilter): boolean {
  return (
    filter.kinds.length === 0 &&
    filter.text.trim() === "" &&
    !filter.needsYou &&
    !filter.hasLink &&
    !filter.includeArchived
  );
}

export function sameFilter(a: WorkFilter, b: WorkFilter): boolean {
  return (
    a.text.trim() === b.text.trim() &&
    a.needsYou === b.needsYou &&
    a.hasLink === b.hasLink &&
    a.includeArchived === b.includeArchived &&
    a.kinds.length === b.kinds.length &&
    a.kinds.every((kind) => b.kinds.includes(kind))
  );
}

// ---------------------------------------------------------------------------
// Applying a filter
// ---------------------------------------------------------------------------

/** Text matches a key exactly first, then anywhere in the key or the title. */
export function matchesText(item: ProjectWorkListItem, text: string): boolean {
  const needle = text.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return item.key.toLocaleLowerCase().includes(needle) || item.title.toLocaleLowerCase().includes(needle);
}

export function applyFilter(items: readonly ProjectWorkListItem[], filter: WorkFilter): ProjectWorkListItem[] {
  return items.filter((item) => {
    if (!filter.includeArchived && item.archived) return false;
    if (filter.kinds.length > 0 && !filter.kinds.includes(item.kind)) return false;
    if (filter.needsYou && !item.needsAttention) return false;
    if (filter.hasLink && item.linkCounts.edges + item.linkCounts.repository + item.linkCounts.execution === 0) return false;
    return matchesText(item, filter.text);
  });
}

/** Keys rank first on an exact match: `TASK-44` finds TASK-44 (D-355). */
export function sortWork(items: readonly ProjectWorkListItem[], sort: WorkSort, text = ""): ProjectWorkListItem[] {
  const needle = text.trim().toLocaleLowerCase();
  const exact = (item: ProjectWorkListItem): number => (needle !== "" && item.key.toLocaleLowerCase() === needle ? 0 : 1);
  const rows = [...items];
  rows.sort((a, b) => {
    const byExact = exact(a) - exact(b);
    if (byExact !== 0) return byExact;
    if (sort === "key") return compareKeys(a.key, b.key);
    if (sort === "status") {
      const byAttention = Number(b.needsAttention) - Number(a.needsAttention);
      if (byAttention !== 0) return byAttention;
      if (a.state !== b.state) return a.state.localeCompare(b.state);
    }
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return compareKeys(a.key, b.key);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// The saved views, as a store
// ---------------------------------------------------------------------------

type ViewsByProject = Record<string, SavedView[]>;

let views: ViewsByProject = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = (): ViewsByProject => views;
const EMPTY_VIEWS: SavedView[] = [];

const publish = (next: ViewsByProject): void => {
  views = next;
  for (const listener of [...listeners]) listener();
};

export function useSavedViews(projectId: string | undefined): readonly SavedView[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return projectId ? (all[projectId] ?? EMPTY_VIEWS) : EMPTY_VIEWS;
}

export function saveView(projectId: string, view: Omit<SavedView, "id"> & { id?: string }): SavedView {
  const id = view.id ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const saved: SavedView = { id, name: view.name.trim().slice(0, 60), filter: view.filter, sort: view.sort };
  const existing = views[projectId] ?? [];
  const next = existing.some((candidate) => candidate.id === id)
    ? existing.map((candidate) => (candidate.id === id ? saved : candidate))
    : [...existing, saved];
  publish({ ...views, [projectId]: next });
  return saved;
}

export function deleteView(projectId: string, id: string): void {
  const existing = views[projectId];
  if (!existing) return;
  publish({ ...views, [projectId]: existing.filter((view) => view.id !== id) });
}

/** Test seam, and what an environment change calls. */
export function resetSavedViews(next: ViewsByProject = {}): void {
  publish(next);
}

// ---------------------------------------------------------------------------
// Host preferences
// ---------------------------------------------------------------------------

const parse = (value: unknown): ViewsByProject => {
  if (!value || typeof value !== "object") return {};
  const source = (value as { views?: unknown }).views;
  if (!source || typeof source !== "object") return {};
  const out: ViewsByProject = {};
  for (const [projectId, list] of Object.entries(source as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const parsed = list.filter(isSavedView);
    if (parsed.length > 0) out[projectId] = parsed;
  }
  return out;
};

function isSavedView(value: unknown): value is SavedView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<SavedView>;
  if (typeof view.id !== "string" || typeof view.name !== "string") return false;
  if (view.sort !== "updated" && view.sort !== "key" && view.sort !== "status") return false;
  const filter = view.filter as Partial<WorkFilter> | undefined;
  return (
    !!filter &&
    Array.isArray(filter.kinds) &&
    typeof filter.text === "string" &&
    typeof filter.needsYou === "boolean" &&
    typeof filter.hasLink === "boolean" &&
    typeof filter.includeArchived === "boolean"
  );
}

const serialise = (value: ViewsByProject): string => JSON.stringify({ views: value });

/**
 * Keep the saved views and the host's `project-work` namespace in step for as
 * long as the workspace can be opened. Safe before the socket is open.
 */
export function useSavedViewsSync(client: HostClient, connected: boolean): void {
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let agreed: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const push = (value: ViewsByProject): void => {
      const text = serialise(value);
      if (disposed || text === agreed) return;
      agreed = text;
      client.request("pi/prefs/set", { namespace: PROJECT_WORK_PREFS_NAMESPACE, value: JSON.parse(text) as unknown }).catch(() => {
        if (agreed === text) agreed = undefined;
      });
    };

    const adopt = (value: unknown): void => {
      const parsed = parse(value);
      const text = serialise(parsed);
      if (text === agreed || text === serialise(views)) {
        agreed = text;
        return;
      }
      agreed = text;
      publish(parsed);
    };

    void (async () => {
      try {
        const { entries } = await client.request("pi/prefs/get", { namespace: PROJECT_WORK_PREFS_NAMESPACE });
        if (disposed) return;
        const entry = entries[0];
        if (entry && entry.value !== null && entry.value !== undefined) adopt(entry.value);
      } catch {
        // An older host, or not connected: the views this window holds still work.
      }
    })();

    const stopHost = client.subscribe((method, params) => {
      if (method !== "pi/prefs/updated") return;
      const entry = params as { namespace?: string; value?: unknown };
      if (entry.namespace !== PROJECT_WORK_PREFS_NAMESPACE) return;
      if (entry.value === null || entry.value === undefined) return;
      adopt(entry.value);
    });
    const stopStore = subscribe(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        push(views);
      }, PUSH_DEBOUNCE_MS);
    });

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      stopHost();
      stopStore();
    };
  }, [client, connected]);
}
