import type {
  ClientRequests,
  ProjectWorkChange,
  ProjectWorkCounts,
  ProjectWorkKind,
  ProjectWorkListItem,
  ProjectWorkListParams,
  ProjectWorkListResult,
  ProjectWorkState,
} from "@lasercode/protocol";

import type { ProjectWorkMethod, ProjectWorkRequest } from "../../src/project-work/store.js";

/**
 * A host with two projects, one of which has been seen at two directories.
 *
 * The important property for M21-T5 is the one the real host has: a path is
 * only ever a lookup, and two paths of the same project answer with the same
 * `projectId` and the same sequence.
 */
export interface FakeProject {
  projectId: string;
  paths: string[];
  seq: number;
  items: ProjectWorkListItem[];
  /** Events, oldest first, as the host would replay them for `sinceSeq`. */
  events: Array<{ seq: number; change: ProjectWorkChange }>;
  /** When set, a `sinceSeq` at or below it answers `reset: true`. */
  windowStart?: number;
}

export const KEY_PREFIX: Record<ProjectWorkKind, string> = {
  spec: "SPEC",
  research: "RES",
  design: "DES",
  plan: "PLAN",
  task: "TASK",
};

export function item(
  over: Partial<ProjectWorkListItem> & { entityId: string; kind: ProjectWorkKind; number: number },
): ProjectWorkListItem {
  const key = `${KEY_PREFIX[over.kind]}-${over.number}`;
  const state: ProjectWorkState = over.state ?? (over.kind === "task" ? "draft" : "draft");
  return {
    ref: {
      projectId: over.ref?.projectId ?? "p1",
      kind: over.kind,
      entityId: over.entityId,
      revisionId: over.ref?.revisionId ?? `${over.entityId}r1`,
      digest: over.ref?.digest ?? "a".repeat(64),
      label: over.title ?? key,
      key,
    },
    kind: over.kind,
    key,
    title: over.title ?? key,
    state,
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    revisionCount: over.revisionCount ?? 1,
    needsAttention: over.needsAttention ?? false,
    blockingComments: over.blockingComments ?? 0,
    archived: over.archived ?? false,
    linkCounts: over.linkCounts ?? { edges: 0, repository: 0, execution: 0 },
    ...(over.staleBecauseKey ? { staleBecauseKey: over.staleBecauseKey } : {}),
    ...(over.unmetDependencies ? { unmetDependencies: over.unmetDependencies } : {}),
  };
}

export function countsOf(items: readonly ProjectWorkListItem[]): ProjectWorkCounts {
  const byKind = { spec: 0, research: 0, design: 0, plan: 0, task: 0 };
  let total = 0;
  let needsAttention = 0;
  for (const row of items) {
    if (row.archived) continue;
    byKind[row.kind] += 1;
    total += 1;
    if (row.needsAttention) needsAttention += 1;
  }
  return { total, needsAttention, byKind };
}

export function change(over: Partial<ProjectWorkChange> & { entityId: string; kind: ProjectWorkKind; number: number }): ProjectWorkChange {
  const key = `${KEY_PREFIX[over.kind]}-${over.number}`;
  return {
    change: over.change ?? "revised",
    entityId: over.entityId,
    entityKind: over.kind,
    key,
    title: over.title ?? key,
    state: over.state ?? "draft",
    at: over.at ?? "2026-01-02T00:00:00.000Z",
    ...(over.revisionId ? { revisionId: over.revisionId } : {}),
    ...(over.digest ? { digest: over.digest } : {}),
    ...(over.actorLabel ? { actorLabel: over.actorLabel } : {}),
    ...(over.sessionId ? { sessionId: over.sessionId } : {}),
  };
}

export interface FakeHost {
  request: ProjectWorkRequest;
  calls: Array<{ method: ProjectWorkMethod; params: unknown }>;
  projects: FakeProject[];
  /** Refuse every call with this error until it is cleared (a closed socket). */
  offline: Error | undefined;
  /** Refuse just the next call, to prove a failed read keeps the rows. */
  failNext: Error | undefined;
  find(cwd: string): FakeProject | undefined;
}

export function fakeHost(projects: FakeProject[]): FakeHost {
  const host: FakeHost = {
    calls: [],
    projects,
    offline: undefined,
    failNext: undefined,
    find: (cwd) => projects.find((project) => project.paths.includes(cwd)),
    request: (async (method: ProjectWorkMethod, params: unknown) => {
      host.calls.push({ method, params });
      if (host.offline) throw host.offline;
      if (host.failNext) {
        const error = host.failNext;
        host.failNext = undefined;
        throw error;
      }
      if (method !== "project/work/list") throw new Error(`the fixture does not answer ${method}`);
      return list(host, params as ProjectWorkListParams);
    }) as ProjectWorkRequest,
  };
  return host;
}

function list(host: FakeHost, params: ProjectWorkListParams): ProjectWorkListResult {
  const project = params.projectId
    ? host.projects.find((candidate) => candidate.projectId === params.projectId)
    : params.cwd
      ? host.find(params.cwd)
      : undefined;
  if (!project) throw new Error("That project is not one this device can read.");

  const visible = project.items.filter((row) => (params.includeArchived === true ? true : !row.archived));
  const counts = countsOf(project.items);
  if (params.sinceSeq === undefined) {
    return { projectId: project.projectId, seq: project.seq, items: page(visible, params), counts };
  }
  if (project.windowStart !== undefined && params.sinceSeq < project.windowStart) {
    return { projectId: project.projectId, seq: project.seq, items: page(visible, params), counts, reset: true };
  }
  const events = project.events.filter((event) => event.seq > (params.sinceSeq ?? 0));
  const removed = events.filter((event) => event.change.change === "deleted").map((event) => event.change.entityId);
  const touched = new Set(events.filter((event) => event.change.change !== "deleted").map((event) => event.change.entityId));
  const items = visible.filter((row) => touched.has(row.ref.entityId));
  return {
    projectId: project.projectId,
    seq: project.seq,
    items: page(items, params),
    counts,
    ...(removed.length > 0 ? { removed } : {}),
  };
}

function page(items: readonly ProjectWorkListItem[], params: ProjectWorkListParams): ProjectWorkListItem[] {
  const limit = params.limit ?? 50;
  return items.slice(0, limit);
}

/** The one shape the store's write path expects back, for a `create` test. */
export type CreateResult = ClientRequests["project/work/create"]["result"];
