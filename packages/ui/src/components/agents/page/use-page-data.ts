"use client";
/**
 * The Agents page's host reads that are not in the store: the model
 * catalog, the Web search feature's state, the skills the engine discovers
 * and the engine's own instructions. Each answers `{ loading, error, reload }`
 * so a section can draw its wait and its failure the same way, and each
 * ignores an answer that lands after its inputs changed.
 */
import type { AgentSkillsListing, ModelCatalogEntry } from "@lasercode/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAgentsActions } from "@/agents";
import { narrowToConnected } from "@/components/assistant-ui/elements/connected-models";
import { useLaserStable } from "@/runtime";

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
function useRequest<T>(key: string | undefined, enabled: boolean, fetcher: (key: string, fresh: boolean) => Promise<T>): Loaded<T> {
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
    if (!enabled || key === undefined) return undefined;
    let live = true;
    setState((current) => ({ key, data: current.key === key ? current.data : undefined, loading: true, error: undefined }));
    fetcherRef
      .current(key, attempt > 0)
      .then((data) => {
        if (live) setState({ key, data, loading: false, error: undefined });
      })
      .catch((error: unknown) => {
        if (live) setState({ key, data: undefined, loading: false, error: messageOf(error) });
      });
    return () => {
      live = false;
    };
  }, [key, enabled, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = enabled && state.key === key;
  return {
    data: current ? state.data : undefined,
    loading: current ? state.loading : false,
    error: current ? state.error : undefined,
    reload,
  };
}

/** The catalog is over a thousand rows; one fetch per directory for the life of the page. `reload` asks again. */
const catalogCache = new Map<string, Promise<ModelCatalogEntry[]>>();

/** Enabled models of the catalog routed through `cwd`. */
export function useModelCatalog(cwd: string | undefined, enabled = true): Loaded<ModelCatalogEntry[]> {
  const { client } = useLaserStable();
  return useRequest(cwd, enabled, (key, fresh) => {
    if (fresh) catalogCache.delete(key);
    let pending = catalogCache.get(key);
    if (!pending) {
      // Only providers the person has connected (D-145): an agent set to a
      // model nobody can call is a refusal waiting to happen.
      pending = Promise.all([
        client.request("pi/models/catalog", { cwd: key }),
        client.request("pi/providers/list", { cwd: key }).then(({ providers }) => providers, () => undefined),
      ]).then(([catalog, providers]) => narrowToConnected(catalog.models, providers).models);
      pending.catch(() => catalogCache.delete(key));
      catalogCache.set(key, pending);
    }
    return pending;
  });
}

export interface WebSearchAvailability {
  /** False when the feature list could not be read; the tool is then offered without gating. */
  known: boolean;
  enabled: boolean;
}

/** Whether the Web search feature is on for `cwd`, so `web_search` can say when it is not. */
export function useWebSearchFeature(cwd: string | undefined): WebSearchAvailability {
  const { client } = useLaserStable();
  const result = useRequest(cwd ?? "", true, async (key) => {
    const { features } = await client.request("feature/list", key ? { cwd: key } : {});
    return features.find((feature) => feature.manifest.id === "web-search")?.enabled ?? false;
  });
  if (result.loading || result.error !== undefined || result.data === undefined) return { known: false, enabled: true };
  return { known: true, enabled: result.data };
}

/** Every skill the engine discovers for `cwd`, asked only while the picker is open. */
export function useSkillsListing(cwd: string | undefined, enabled: boolean): Loaded<AgentSkillsListing> {
  const agents = useAgentsActions();
  return useRequest(cwd, enabled, (key) => agents.skills(key));
}

/** The engine's built-in instructions, for the editable default agent. */
export function useEngineInstructions(cwd: string | undefined, enabled: boolean): Loaded<string> {
  const agents = useAgentsActions();
  return useRequest(cwd, enabled, (key) => agents.engineInstructions(key));
}
