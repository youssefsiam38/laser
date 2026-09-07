"use client";
/**
 * Providers and models (M4-T4).
 *
 * Auth status comes from the bundled engine's `ModelRuntime`, so what is shown here is
 * exactly what a session will be able to use. No credential value ever crosses
 * the protocol — only whether one resolved and where it came from. Signing in
 * happens here too (M10-T6): the same `ProviderStep` the first run uses, which
 * drives the agent's own login flow through `pi/providers/login/*`.
 */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { Tabs } from "radix-ui";
import { WebSearchTab } from "./WebSearchTab.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Eye, Loader2, Mic2, RefreshCw, Sparkles } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { modelProvenance, ProviderFilterField, ProviderModelMultiPicker } from "@/components/assistant-ui/elements/model-selector";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { money, tokens } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type {
  ModelCatalogEntry,
  ProviderAuthInfo,
  SettingChange,
  SettingsScope,
  SettingsSnapshot,
  ThinkingLevel,
  TranscribeStatus,
} from "@lasercode/protocol";

import { ProviderStep } from "@/components/onboarding";

import { SearchInput } from "./SettingsScreen.js";

/** Rows rendered at once; the filter is how you reach the rest. */
const MODEL_ROW_LIMIT = 200;

export interface ModelsTabProps {
  cwd: string;
  snapshot: SettingsSnapshot | undefined;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}

export function ModelsTab(props: ModelsTabProps) {
  return (
    <Tabs.Root defaultValue="models" className="flex h-full min-h-0 flex-col">
      <Tabs.List aria-label="Provider settings" className="flex shrink-0 gap-1 border-b border-line px-4 py-2">
        <Tabs.Trigger value="models" asChild><Button variant="ghost" size="sm" className="data-[state=active]:bg-surface-2">Models and dictation</Button></Tabs.Trigger>
        <Tabs.Trigger value="search" asChild><Button variant="ghost" size="sm" className="data-[state=active]:bg-surface-2">Web search</Button></Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="models" className="min-h-0 flex-1"><ModelConnectionsTab {...props} /></Tabs.Content>
      <Tabs.Content value="search" className="min-h-0 flex-1"><WebSearchTab key={props.cwd} cwd={props.cwd} /></Tabs.Content>
    </Tabs.Root>
  );
}

function ModelConnectionsTab({ cwd, snapshot, onApply }: ModelsTabProps) {
  const { client, actions } = useLaserStable();
  const [providers, setProviders] = useState<ProviderAuthInfo[]>([]);
  const [dictation, setDictation] = useState<TranscribeStatus>();
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [patterns, setPatterns] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
  const [fatal, setFatal] = useState<string>();

  const load = useCallback(
    async (refresh: boolean) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const [providerResult, catalogResult, dictationResult] = await Promise.all([
          client.request("pi/providers/list", { cwd }),
          client.request("pi/models/catalog", { cwd, refresh }),
          client.request("pi/transcribe/status", { cwd }),
        ]);
        setProviders(providerResult.providers);
        setModels(catalogResult.models);
        setPatterns(catalogResult.enabledPatterns);
        setDictation(dictationResult);
        setErrors([...(providerResult.error ? [providerResult.error] : []), ...catalogResult.errors]);
        setFatal(undefined);
      } catch (loadError) {
        setFatal(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, cwd],
  );

  const handleProviderConfigured = useCallback(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return models.filter(
      (model) =>
        (!onlyEnabled || model.enabled) &&
        (providerFilter === "all" || model.provider === providerFilter) &&
        (needle === "" ||
          model.id.toLowerCase().includes(needle) ||
          (model.name ?? "").toLowerCase().includes(needle)),
    );
  }, [models, filter, onlyEnabled, providerFilter]);
  // Pi knows well over a thousand models with every provider catalogue loaded.
  // Rendering them all is pointless DOM; the filter is the way through them.
  const shown = matching.slice(0, MODEL_ROW_LIMIT);
  const hidden = matching.length - shown.length;
  const modelProviders = useMemo(() => [...new Set(models.map((model) => model.provider))].sort(), [models]);
  const grouped = useMemo(() => {
    const groups = new Map<string, ModelCatalogEntry[]>();
    for (const model of shown) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()];
  }, [shown]);

  const setThinking = (model: ModelCatalogEntry, level: ThinkingLevel | undefined) => {
    // A map key here holds a slash, which is not a settings path segment, so
    // the whole `modelThinkingLevels` object is rewritten rather than one leaf.
    const current = models.reduce<Record<string, ThinkingLevel>>((acc, entry) => {
      if (entry.thinkingLevel) acc[`${entry.provider}/${entry.id}`] = entry.thinkingLevel;
      return acc;
    }, {});
    if (level) current[`${model.provider}/${model.id}`] = level;
    else delete current[`${model.provider}/${model.id}`];
    void onApply("global", [
      Object.keys(current).length === 0
        ? { path: "modelThinkingLevels", op: "unset" }
        : { path: "modelThinkingLevels", op: "set", value: current },
    ]).then((ok) => {
      if (!ok) return;
      setModels((list) =>
        list.map((entry) =>
          entry.provider === model.provider && entry.id === model.id
            ? { ...entry, ...(level ? { thinkingLevel: level } : {}) }
            : entry,
        ),
      );
      if (!level) void load(false);
    });
  };

  if (fatal) {
    return (
      <ScrollArea className="h-full">
        <div className="mx-auto max-w-140 px-4 py-12 text-center">
          <p className="text-sm font-medium text-ink">Could not read the model catalogue.</p>
          <p className="mt-1 font-mono text-xs leading-4 break-words text-danger">{fatal}</p>
          <Button className="mt-4" variant="secondary" size="sm" onClick={() => void load(false)}>
            Try again
          </Button>
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-240 flex-col gap-5 px-4 py-4">
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Providers</h2>
            {loading && <GenerationLoader label="Loading providers" layout="inline" />}
            <Button
              variant="secondary"
              size="sm"
              className="ms-auto"
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? <Loader2 className="motion-safe:animate-busy" /> : <RefreshCw />} Refresh catalogue
            </Button>
          </div>
          <p className="text-xs leading-5 text-ink-2">
            Which providers are signed in, and how. Pick one to sign in with an account or an API key, or to sign out.
            {" "}{PRODUCT_DISPLAY_NAME} never reads the credential itself.
          </p>
          <ProviderStep cwd={cwd} onConfigured={handleProviderConfigured} />
          <div className="flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[color-mix(in_oklab,var(--live)_12%,var(--surface))] text-live">
              <Mic2 className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-ink">Dictation comes with {PRODUCT_DISPLAY_NAME}</p>
                {dictation && (
                  <Badge variant="outline" className={dictation.available ? "text-live" : "text-attention"}>
                    {dictation.available ? "Ready" : "Needs an API key"}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs leading-5 text-ink-2">
                Speech-to-text uses OpenAI’s transcription service. Add an OpenAI platform API key here; a ChatGPT account sign-in alone cannot authorize audio transcription.
              </p>
              {dictation && !dictation.available && dictation.reason && (
                <p className="mt-1 text-xs leading-5 text-attention">{dictation.reason}</p>
              )}
            </div>
          </div>
          {providers.length > 0 && (
            <p className="text-xs leading-4 text-ink-3">
              {providers.filter((p) => p.configured).length} of {providers.length} signed in.
            </p>
          )}
          {errors.length > 0 && (
            <div className="rounded-lg bg-[color-mix(in_oklab,var(--attention)_12%,transparent)] px-3 py-2 text-xs leading-5 text-attention">
              <p className="font-medium">Some catalogues could not be refreshed</p>
              <ul className="mt-0.5 list-disc ps-4">
                {errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">Which models are offered</h2>
          <p className="text-xs leading-5 text-ink-2">
            Patterns in <code className="font-mono">enabledModels</code> limit the models the agent cycles through and
            the model picker offers. Leave it empty to offer every model available. Written to your global settings.
          </p>
          <ProviderModelMultiPicker
            models={models}
            values={patterns ?? []}
            disabled={snapshot === undefined}
            onValuesChange={(value) =>
              void onApply("global", [
                value.length === 0
                  ? { path: "enabledModels", op: "unset" }
                  : { path: "enabledModels", op: "set", value },
              ]).then((ok) => {
                if (ok) void load(false);
              })
            }
          />
          {patterns && patterns.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {patterns.map((pattern) => <Badge key={pattern} variant="outline" className="font-mono">{pattern}</Badge>)}
              <Button variant="ghost" size="xs" onClick={() => void onApply("global", [{ path: "enabledModels", op: "unset" }]).then((ok) => ok && void load(false))}>
                Offer every model
              </Button>
            </div>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Models</h2>
            <Badge variant="outline">
              {matching.length}
              {matching.length !== models.length ? ` of ${models.length}` : ""}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={onlyEnabled}
              className={cn(onlyEnabled && "bg-surface-2 text-ink")}
              onClick={() => setOnlyEnabled((v) => !v)}
            >
              Enabled only
            </Button>
          </div>

          <div className="grid gap-2 rounded-xl border border-line bg-surface p-2 sm:grid-cols-2" aria-label="Model catalogue filters">
            <label className="grid gap-1">
              <span className="eyebrow text-ink-3">Provider</span>
              <ProviderFilterField
                providers={modelProviders}
                value={providerFilter}
                onValueChange={setProviderFilter}
              />
            </label>
            <label className="grid gap-1">
              <span className="eyebrow text-ink-3">Model</span>
              <SearchInput
                value={filter}
                onChange={setFilter}
                placeholder="Search model names or IDs"
                className="w-full"
              />
            </label>
          </div>

          {models.length === 0 && !loading && (
            <p className="rounded-lg border border-line px-3 py-6 text-center text-sm text-ink-2">
              No models are available. Add a provider credential above, or point{" "}
              <code className="font-mono">models.json</code> at a local server.
            </p>
          )}

          {grouped.map(([provider, providerModels]) => {
            const open = !collapsedProviders.has(provider);
            return (
              <Collapsible
                key={provider}
                open={open}
                onOpenChange={(nextOpen) => {
                  setCollapsedProviders((current) => {
                    const next = new Set(current);
                    if (nextOpen) next.delete(provider);
                    else next.add(provider);
                    return next;
                  });
                }}
                className="overflow-hidden rounded-xl border border-line bg-surface"
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 bg-surface-2 px-3 py-2 text-start outline-none transition-colors duration-(--motion-fast) hover:bg-surface-3 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live motion-reduce:transition-none"
                    aria-label={`${open ? "Collapse" : "Expand"} ${provider} models`}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn("size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", open && "rotate-90")}
                    />
                    <ProviderLogo provider={provider} className="size-4 shrink-0" />
                    <h3 className="min-w-0 truncate text-sm font-semibold text-ink">{provider}</h3>
                    <Badge variant="outline">{providerModels.length}</Badge>
                    {provider === "openrouter" && <span className="ms-auto hidden text-xs text-ink-3 sm:inline">Proxy catalogue; each row names its source.</span>}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="hairline-t">
                  <DataTable
                    caption={`${provider} models, with context window, thinking levels and startup level`}
                    columns={modelColumns(setThinking)}
                    rows={providerModels}
                    rowKey={(model) => `${model.provider}/${model.id}`}
                    rowClassName={(model) => (model.enabled ? undefined : "opacity-45")}
                    minWidth="44rem"
                    emptyMessage={loading ? "Reading the catalogue…" : "No model matches the filter."}
                    className="rounded-none border-0"
                  />
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {grouped.length === 0 && models.length > 0 && <p className="rounded-lg border border-line px-3 py-6 text-center text-sm text-ink-2">No model matches the filters.</p>}
          {hidden > 0 && (
            <p className="text-xs text-ink-3">
              Showing the first {MODEL_ROW_LIMIT} of {matching.length} matching models. Type in the filter to narrow
              them.
            </p>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function modelColumns(setThinking: (model: ModelCatalogEntry, level: ThinkingLevel | undefined) => void): DataTableColumn<ModelCatalogEntry>[] {
  return [
    {
      key: "model",
      label: "Model",
      render: (model) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="typed text-ink">{modelProvenance(model).modelId}</span>
            {model.vision && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="gap-1">
                    <Eye />
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top">accepts images</TooltipContent>
              </Tooltip>
            )}
            {model.reasoning && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="gap-1">
                    <Sparkles />
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top">supports thinking</TooltipContent>
              </Tooltip>
            )}
            {!model.enabled && <Badge variant="default">excluded by enabledModels</Badge>}
          </div>
          {model.name && model.name !== model.id && <p className="text-xs text-ink-3">{model.name}</p>}
          {modelProvenance(model).sourceProvider && (
            <p className="text-xs text-ink-3">Source: {modelProvenance(model).sourceProvider} · delivered by {model.provider}</p>
          )}
        </div>
      ),
    },
    {
      key: "context",
      label: "Context",
      mono: true,
      align: "end",
      width: "6rem",
      render: (model) => (model.contextWindow ? tokens(model.contextWindow) : "—"),
    },
    {
      // The catalogue is the only place cost crosses the protocol, and it is
      // what a person actually weighs a model by. Priced per million tokens,
      // as Pi reports it; a model the catalogue prices only partly shows the
      // half it knows, and one it does not price shows an em dash rather than
      // a zero, which would read as "free" (R8).
      key: "cost",
      label: "Cost / M",
      mono: true,
      align: "end",
      width: "9rem",
      optional: true,
      render: (model) => {
        const { input, output } = model.cost ?? {};
        if (input === undefined && output === undefined) return "—";
        return (
          <span className="whitespace-nowrap">
            {input === undefined ? "—" : money(input)}
            <span className="text-ink-3"> in / </span>
            {output === undefined ? "—" : money(output)}
            <span className="text-ink-3"> out</span>
          </span>
        );
      },
    },
    {
      key: "levels",
      label: "Thinking levels",
      optional: true,
      render: (model) => (
        <div className="flex flex-wrap gap-1">
          {model.thinkingLevels.map((level) => (
            <Badge key={level} variant="outline">
              {level}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "startup",
      label: "Startup level",
      width: "11rem",
      render: (model) => (
        <select
          aria-label={`Startup thinking level for ${model.provider}/${model.id}`}
          value={model.thinkingLevel ?? ""}
          onChange={(event) => setThinking(model, event.target.value === "" ? undefined : (event.target.value as ThinkingLevel))}
          className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs text-ink outline-none focus-visible:border-live"
        >
          <option value="">— session default —</option>
          {model.thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      ),
    },
  ];
}
