"use client";
/**
 * The Agents page's host reads that are not in the store: the model
 * catalog, the Web search feature's state, the skills Laser discovers and its
 * default instructions. Each answers `{ loading, error, reload }`
 * so a section can draw its wait and its failure the same way, and each
 * ignores an answer that lands after its inputs changed.
 */
import type { AgentSkillsListing, ModelCatalogEntry } from "@lasercode/protocol";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useAgentsActions } from "@/agents";
import { narrowToConnected } from "@/components/assistant-ui/elements/connected-models";
import { useLaserStable } from "@/runtime";
import { deviceStore } from "@/runtime/device-storage";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Loaded<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
}

/**
 * One request keyed by `key`, re-run when the key changes or `reload` is
 * called; `enabled: false` asks nothing and reports nothing loading.
 */
export function useRequest<T>(
  key: string | undefined,
  enabled: boolean,
  fetcher: (key: string, fresh: boolean, environmentKey: string) => Promise<T>,
): Loaded<T> {
  const environment = useSyncExternalStore(deviceStore.subscribe, deviceStore.status, deviceStore.status);
  const environmentKey = environment.active ? environment.environmentKey : undefined;
  const stateKey = key !== undefined && environmentKey !== undefined ? `${environmentKey}\0${key}` : undefined;
  const [state, setState] = useState<{ key: string | undefined; data: T | undefined; loading: boolean; error: string | undefined }>({
    key: undefined,
    data: undefined,
    loading: false,
    error: undefined,
  });
  const [attempt, setAttempt] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled || key === undefined || stateKey === undefined || environmentKey === undefined) return undefined;
    let live = true;
    setState((current) => ({
      key: stateKey,
      data: current.key === stateKey ? current.data : undefined,
      loading: true,
      error: undefined,
    }));
    fetcherRef
      .current(key, attempt > 0, environmentKey)
      .then((data) => {
        if (live) setState({ key: stateKey, data, loading: false, error: undefined });
      })
      .catch((error: unknown) => {
        if (live) setState({ key: stateKey, data: undefined, loading: false, error: messageOf(error) });
      });
    return () => {
      live = false;
    };
  }, [key, stateKey, environmentKey, enabled, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = enabled && state.key === stateKey;
  return {
    data: current ? state.data : undefined,
    loading: current ? state.loading : false,
    error: current ? state.error : undefined,
    reload,
  };
}

/** The catalog is over a thousand rows; one fetch per explicit Settings target for the life of the page. `reload` asks again. */
const catalogCache = new Map<string, Promise<ModelCatalogEntry[]>>();

/** Enabled models of the catalog routed through the explicit Settings target. */
export function useModelCatalog(
  cwd: string | undefined,
  settingsView: "global" | "effective",
  enabled = true,
): Loaded<ModelCatalogEntry[]> {
  const { client } = useLaserStable();
  const requestKey = cwd === undefined ? undefined : `${settingsView}\0${cwd}`;
  return useRequest(requestKey, enabled, (key, fresh, environmentKey) => {
    const cacheKey = `${environmentKey}\0${key}`;
    if (fresh) catalogCache.delete(cacheKey);
    let pending = catalogCache.get(cacheKey);
    if (!pending && cwd !== undefined) {
      // Only providers the person has connected (D-145): an agent set to a
      // model nobody can call is a refusal waiting to happen.
      pending = Promise.all([
        client.request("pi/models/catalog", { cwd, settingsView }),
        client.request("pi/providers/list", { cwd }).then(({ providers }) => providers, () => undefined),
      ]).then(([catalog, providers]) => narrowToConnected(catalog.models, providers).models);
      pending.catch(() => catalogCache.delete(cacheKey));
      catalogCache.set(cacheKey, pending);
    }
    return pending!;
  });
}

/** Every skill Laser discovers for `cwd`, asked only while the picker is open. */
export function useSkillsListing(cwd: string | undefined, enabled: boolean): Loaded<AgentSkillsListing> {
  const agents = useAgentsActions();
  return useRequest(cwd, enabled, (key) => agents.skills(key));
}

/** Laser's default instructions, for the editable default agent. */
export function useEngineInstructions(cwd: string | undefined, enabled: boolean): Loaded<string> {
  const agents = useAgentsActions();
  return useRequest(cwd, enabled, (key) => agents.engineInstructions(key));
}
