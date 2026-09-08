/**
 * The models a person can actually choose, for every surface that picks one to
 * use (D-145).
 *
 * A model belongs to a provider, and a provider without a credential cannot
 * answer: `pi/model/set` refuses it and a run against it fails. Offering all
 * forty built-in providers to someone who has connected one is offering a
 * choice that cannot be made, so every "choose a model" control asks this hook
 * instead of the raw catalogue.
 *
 * Two surfaces deliberately do not: Settings → Providers and models lists the
 * whole catalogue, because that is where a person connects one, and the
 * enabled-models control curates the catalogue itself, which includes models
 * for providers they are about to connect.
 */
import { useEffect, useMemo, useState } from "react";

import type { ModelCatalogEntry, ProviderAuthInfo } from "@lasercode/protocol";
import { useLaserStable } from "@/runtime";

export interface ConnectedModels {
  /** Enabled models whose provider is connected, or every enabled model when the providers are unknown. */
  models: ModelCatalogEntry[];
  loading: boolean;
  error?: string;
  /** True once the providers answered and none of them is connected. */
  none: boolean;
}

const EMPTY: ConnectedModels = { models: [], loading: false, none: false };

export function useConnectedModels(cwd: string | undefined, enabled = true): ConnectedModels {
  const { client } = useLaserStable();
  const [state, setState] = useState<ConnectedModels>(EMPTY);

  useEffect(() => {
    if (!enabled || !cwd) {
      setState(EMPTY);
      return;
    }
    let live = true;
    setState({ models: [], loading: true, none: false });
    void Promise.all([
      client.request("pi/models/catalog", { cwd }),
      // A failed providers call must not empty the picker: it is the narrowing
      // that is unavailable, not the models.
      client.request("pi/providers/list", { cwd }).then(
        ({ providers }) => providers as ProviderAuthInfo[] | undefined,
        () => undefined,
      ),
    ])
      .then(([catalog, providers]) => {
        if (!live) return;
        setState({ ...narrowToConnected(catalog.models, providers), loading: false });
      })
      .catch((error: unknown) => {
        if (live) setState({ models: [], loading: false, error: error instanceof Error ? error.message : String(error), none: false });
      });
    return () => {
      live = false;
    };
  }, [client, cwd, enabled]);

  return state;
}

/**
 * Enabled models whose provider is connected. `providers` undefined means the
 * providers could not be read: the narrowing is what is unavailable, not the
 * models, so the enabled catalogue stands rather than an empty picker.
 */
export function narrowToConnected(
  models: readonly ModelCatalogEntry[],
  providers: readonly ProviderAuthInfo[] | undefined,
): { models: ModelCatalogEntry[]; none: boolean } {
  const usable = models.filter((model) => model.enabled);
  if (!providers) return { models: usable, none: false };
  const connected = new Set(providers.filter((provider) => provider.configured).map((provider) => provider.id));
  return { models: usable.filter((model) => connected.has(model.provider)), none: connected.size === 0 };
}

/** What a picker says when the person has connected nothing yet. */
export const NO_PROVIDER_CONNECTED = "Connect a provider in Settings → Providers and models to choose a model.";

/** Keep the model a surface already holds visible even when it is no longer offered. */
export function withCurrentModel<T extends { provider: string; id: string }>(models: readonly T[], current: T | null | undefined): T[] {
  if (!current) return [...models];
  return models.some((model) => model.provider === current.provider && model.id === current.id) ? [...models] : [current, ...models];
}
