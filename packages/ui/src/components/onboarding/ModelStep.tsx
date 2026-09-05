"use client";
/**
 * Step: choose the default model. The catalogue is the agent's own
 * (`pi/models/catalog`), narrowed to providers that are signed in — a model
 * nobody can call is not offered (R2). One pick writes `defaultProvider` and
 * `defaultModel` to the global settings, which is what a new session starts
 * on. The list is a `Command` (the same searchable list the composer's model
 * picker is built on) so a thousand rows are one keystroke away.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Eye, Sparkles } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { Badge } from "@/components/ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { tokens } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable } from "@/runtime";
import type { ModelCatalogEntry, ProviderAuthInfo } from "@lasercode/protocol";

export interface ModelStepProps {
  cwd: string;
  /** Called with the chosen `provider/id`, or undefined while none is set. */
  onChosen: (ref: string | undefined) => void;
}

/** Rows drawn at once; the search is the way to the rest. */
const ROW_LIMIT = 120;

export function ModelStep({ cwd, onChosen }: ModelStepProps) {
  const { client, actions } = usePiorbitStable();
  const [models, setModels] = useState<ModelCatalogEntry[]>();
  const [providers, setProviders] = useState<ProviderAuthInfo[]>([]);
  const [current, setCurrent] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [catalog, providerResult] = await Promise.all([
        client.request("pi/models/catalog", { cwd }),
        client.request("pi/providers/list", { cwd }),
      ]);
      setModels(catalog.models);
      setProviders(providerResult.providers);
      const ref = catalog.defaultProvider && catalog.defaultModel ? `${catalog.defaultProvider}/${catalog.defaultModel}` : undefined;
      setCurrent(ref);
      onChosen(ref);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [client, cwd, onChosen]);

  useEffect(() => {
    void load();
  }, [load]);

  const configured = useMemo(() => new Set(providers.filter((p) => p.configured).map((p) => p.id)), [providers]);
  const providerName = useMemo(() => new Map(providers.map((p) => [p.id, p.name])), [providers]);
  const available = useMemo(() => (models ?? []).filter((m) => configured.has(m.provider) && m.enabled), [models, configured]);
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelCatalogEntry[]>();
    for (const model of available) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [available]);

  const choose = async (model: ModelCatalogEntry) => {
    const ref = `${model.provider}/${model.id}`;
    setSaving(ref);
    try {
      await client.request("pi/settings/set", {
        cwd,
        scope: "global",
        changes: [
          { path: "defaultProvider", op: "set", value: model.provider },
          { path: "defaultModel", op: "set", value: model.id },
        ],
      });
      setCurrent(ref);
      onChosen(ref);
    } catch (saveError) {
      actions.toast("error", saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(undefined);
    }
  };

  if (error && !models) {
    return <ErrorState title="Could not load the list of models" detail={error} onRetry={() => void load()} retryLabel="Try again" />;
  }
  if (!models) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-line px-3 py-8">
        <GenerationLoader label="Loading models" layout="inline" />
      </div>
    );
  }
  if (available.length === 0) {
    return (
      <div className="rounded-xl border border-line px-3 py-6 text-center">
        <p className="text-sm font-medium text-ink">No models to choose from yet</p>
        <p className="mt-1 text-sm leading-6 text-ink-2">
          {configured.size === 0
            ? "Sign in to a provider first; its models appear here."
            : "The provider you signed in to lists no models right now. Try again in a moment, or sign in to another."}
        </p>
      </div>
    );
  }

  let drawn = 0;
  return (
    <div className="flex flex-col gap-2">
      {current && (
        <p className="flex items-center gap-1.5 text-xs text-ink-2">
          <Check aria-hidden="true" className="size-3.5 text-ok" /> Default: <span className="typed text-ink">{current}</span>
        </p>
      )}
      <Command className="rounded-xl border border-line bg-surface" label="Models">
        <CommandInput placeholder="Search models" autoFocus />
        <CommandList className="max-h-64">
          <CommandEmpty>No model matches.</CommandEmpty>
          {groups.map(([provider, list]) => {
            if (drawn >= ROW_LIMIT) return null;
            const slice = list.slice(0, ROW_LIMIT - drawn);
            drawn += slice.length;
            return (
              <CommandGroup key={provider} heading={providerName.get(provider) ?? provider}>
                {slice.map((model) => {
                  const ref = `${model.provider}/${model.id}`;
                  const chosen = ref === current;
                  return (
                    <CommandItem
                      key={ref}
                      value={`${ref} ${model.name ?? ""}`}
                      onSelect={() => void choose(model)}
                      disabled={saving !== undefined}
                      aria-selected={chosen}
                      className={cn("gap-2", chosen && "bg-surface-2")}
                    >
                      <ProviderLogo provider={model.provider} className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{model.name && model.name !== model.id ? model.name : model.id}</span>
                        {model.name && model.name !== model.id && <span className="block truncate typed text-ink-3">{model.id}</span>}
                      </span>
                      {model.reasoning && (
                        <Badge variant="outline" className="gap-1" title="supports thinking">
                          <Sparkles />
                        </Badge>
                      )}
                      {model.vision && (
                        <Badge variant="outline" className="gap-1" title="accepts images">
                          <Eye />
                        </Badge>
                      )}
                      {model.contextWindow ? <span className="tnum text-xs text-ink-3">{tokens(model.contextWindow)}</span> : null}
                      {chosen && <Check aria-hidden="true" className="size-4 text-ok" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
      {available.length > ROW_LIMIT && (
        <p className="text-xs text-ink-3">Showing the first {ROW_LIMIT} of {available.length}. Type to find the rest.</p>
      )}
    </div>
  );
}
