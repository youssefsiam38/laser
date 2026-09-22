/**
 * One store per project, and the only place a directory becomes a project.
 *
 * **The rule that matters:** a cache is keyed by the stable `projectId` and by
 * nothing else. A directory is resolved *once* through
 * `project/work/list { cwd }` — which is what that parameter exists for — and
 * the answer is remembered. A worktree and its owner, or a project that moved,
 * resolve to the same id and therefore to the same cache with the same
 * sequence; two projects can never alias, because a path is never a key.
 *
 * The registry is module-level for the same reason the fleet's is: the things
 * that ask are far apart in the tree (a top-bar count, a slash command, a
 * transcript card, the workspace itself) and the answer is one per project.
 */
import { ProjectWorkStore, type ProjectWorkRequest } from "./store.js";

interface Registry {
  request: ProjectWorkRequest | undefined;
  stores: Map<string, ProjectWorkStore>;
  /** A directory this device has already resolved, and what it resolved to. */
  paths: Map<string, string>;
  /** Resolutions in flight, so two callers never probe the same folder twice. */
  resolving: Map<string, Promise<ProjectWorkStore | undefined>>;
}

const registry: Registry = { request: undefined, stores: new Map(), paths: new Map(), resolving: new Map() };
const listeners = new Set<() => void>();
let generation = 0;

const publish = (): void => {
  generation += 1;
  for (const listener of [...listeners]) listener();
};

/**
 * A number that changes whenever the registry does. `useSyncExternalStore`
 * needs a value, and the registry's value is "something is different now".
 */
export function projectWorkGeneration(): number {
  return generation;
}

/** Told when a store appears or the whole registry is replaced. */
export function subscribeProjectWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Point the registry at a connection. Passing `undefined` stops every read. */
export function bindProjectWork(request: ProjectWorkRequest | undefined): void {
  if (registry.request === request) return;
  registry.request = request;
  publish();
}

/**
 * A different host, or a different environment: everything derived from the
 * old one goes. Ids are only stable *within* one host's state root.
 */
export function resetProjectWork(): void {
  for (const store of registry.stores.values()) store.dispose();
  registry.stores.clear();
  registry.paths.clear();
  registry.resolving.clear();
  publish();
}

/** The store for a project already known by id, created empty if need be. */
export function projectWorkFor(projectId: string): ProjectWorkStore | undefined {
  const existing = registry.stores.get(projectId);
  if (existing) return existing;
  const request = registry.request;
  if (!request) return undefined;
  const store = new ProjectWorkStore({ request, projectId });
  registry.stores.set(projectId, store);
  publish();
  return store;
}

/** The store for a directory, if this device has already resolved that path. */
export function knownProjectWork(cwd: string | undefined): ProjectWorkStore | undefined {
  if (!cwd) return undefined;
  const projectId = registry.paths.get(cwd);
  return projectId ? registry.stores.get(projectId) : undefined;
}

/**
 * Resolve a directory to its project and return that project's store.
 *
 * The probe is one bounded read (`limit: 1`): all it is for is learning the
 * stable id, because every other method takes the id and nothing else. The
 * full backlog read follows on the store itself.
 */
export async function resolveProjectWork(cwd: string): Promise<ProjectWorkStore | undefined> {
  const known = knownProjectWork(cwd);
  if (known) return known;
  const inflight = registry.resolving.get(cwd);
  if (inflight) return inflight;
  const request = registry.request;
  if (!request) return undefined;

  const run = (async (): Promise<ProjectWorkStore | undefined> => {
    try {
      const probe = await request("project/work/list", { cwd, limit: 1 });
      const store = registry.stores.get(probe.projectId) ?? new ProjectWorkStore({ request, projectId: probe.projectId });
      registry.stores.set(probe.projectId, store);
      registry.paths.set(cwd, probe.projectId);
      store.rememberPath(cwd);
      publish();
      void store.open({ cwd });
      return store;
    } catch {
      // A folder that cannot be resolved is not remembered, so the next
      // attempt is a real attempt rather than a cached failure.
      return undefined;
    } finally {
      registry.resolving.delete(cwd);
    }
  })();
  registry.resolving.set(cwd, run);
  return run;
}

/** Fan a host notification out to the project it belongs to. */
export function observeProjectWork(method: string, params: unknown): void {
  if (method !== "project/work/updated" && method !== "project/work/attention") return;
  const projectId = (params as { projectId?: unknown } | undefined)?.projectId;
  if (typeof projectId !== "string") return;
  registry.stores.get(projectId)?.observe(method, params);
}

/**
 * The socket came back. Every project this window holds catches up from the
 * sequence it has; nothing is thrown away and nothing is re-read from zero.
 */
export function reconnectProjectWork(): void {
  for (const store of registry.stores.values()) store.reconnected();
}

/** Every project this window has read. The palette and search walk it. */
export function projectWorkStores(): ReadonlyMap<string, ProjectWorkStore> {
  return registry.stores;
}

/** Test seam: the paths resolved so far, and what each resolved to. */
export function resolvedProjectPaths(): ReadonlyMap<string, string> {
  return registry.paths;
}
