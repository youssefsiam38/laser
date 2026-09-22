"use client";
/**
 * React bindings for one project's work.
 *
 * The store is the external state; these are the three ways a surface reads
 * it: by directory (what a session knows), by stable id (what a link and the
 * workspace carry), and as a snapshot.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { projectWorkFor, projectWorkGeneration, resolveProjectWork, subscribeProjectWork } from "./registry.js";
import type { ProjectWorkSnapshot, ProjectWorkStore } from "./store.js";

const EMPTY: ProjectWorkSnapshot = {
  projectId: undefined,
  phase: "idle",
  error: undefined,
  seq: 0,
  eventSeq: 0,
  items: [],
  counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } },
  attention: { needsYou: 0, seq: 0 },
  recent: [],
  behind: false,
  loading: false,
  resets: 0,
  more: false,
  identity: undefined,
};

/**
 * The store for a directory. Resolves the path to its stable project id once
 * and then answers from the cache; a path that moves resolves to the same id
 * and therefore to the same store.
 */
export function useProjectWorkStore(cwd: string | undefined): ProjectWorkStore | undefined {
  // Re-read whenever the registry gains a store or changes connection.
  const generation = useSyncExternalStore(subscribeProjectWork, projectWorkGeneration, projectWorkGeneration);
  const [store, setStore] = useState<ProjectWorkStore | undefined>(undefined);
  useEffect(() => {
    if (!cwd) {
      setStore(undefined);
      return;
    }
    let cancelled = false;
    void resolveProjectWork(cwd).then((resolved) => {
      if (!cancelled) setStore(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, generation]);
  return store;
}

/** The store for a project already named by its stable id. */
export function useProjectWorkById(projectId: string | undefined): ProjectWorkStore | undefined {
  const generation = useSyncExternalStore(subscribeProjectWork, projectWorkGeneration, projectWorkGeneration);
  const store = projectId ? projectWorkFor(projectId) : undefined;
  useEffect(() => {
    void store?.open();
  }, [store, generation]);
  return store;
}

/** One project's cache, as a snapshot React can render. */
export function useProjectWorkSnapshot(store: ProjectWorkStore | undefined): ProjectWorkSnapshot {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? emptySnapshot, store?.getSnapshot ?? emptySnapshot);
}

/** Both at once, for a surface that only has a directory. */
export function useProjectWork(cwd: string | undefined): { store: ProjectWorkStore | undefined; work: ProjectWorkSnapshot } {
  const store = useProjectWorkStore(cwd);
  return { store, work: useProjectWorkSnapshot(store) };
}

const noSubscribe = (): (() => void) => () => {};
const emptySnapshot = (): ProjectWorkSnapshot => EMPTY;
