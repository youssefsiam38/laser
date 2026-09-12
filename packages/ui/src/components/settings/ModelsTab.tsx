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
import { FallbackChainsTab } from "./fallback/FallbackChainsTab.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ChevronsUpDown, Eye, Loader2, Mic2, RefreshCw, Sparkles } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { modelProvenance, ProviderFilterField, ProviderModelMultiPicker } from "@/components/assistant-ui/elements/model-selector";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { SettingsSwitch } from "@/components/assistant-ui/elements/settings-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

import {
  connectedProviderIds,
  matchesModelView,
  modelOfferState,
  offerStateCounts,
  patternForModel,
  settingsListScope,
  withModelOffered,
  withModelsSwitchedOff,
  withModelsSwitchedOn,
  type ModelOfferState,
  type ModelView,
} from "./model.js";
import { SearchInput } from "./SettingsScreen.js";

/** Rows rendered at once; the filter is how you reach the rest. */
const MODEL_ROW_LIMIT = 200;

/** The three views of the catalogue, in menu order. */
const MODEL_VIEWS: ReadonlyArray<{ id: ModelView; label: string; hint: string }> = [
  { id: "all", label: "All", hint: "Every model in the catalogue" },
  { id: "enabled", label: "Enabled", hint: "What the pickers offer right now" },
  { id: "hidden", label: "Hidden", hint: "Switched off, hidden by your list, or provider not signed in" },
];

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
        <Tabs.Trigger value="fallback" asChild><Button variant="ghost" size="sm" className="data-[state=active]:bg-surface-2">Fallback chains</Button></Tabs.Trigger>
        <Tabs.Trigger value="search" asChild><Button variant="ghost" size="sm" className="data-[state=active]:bg-surface-2">Web search</Button></Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="models" className="min-h-0 flex-1"><ModelConnectionsTab {...props} /></Tabs.Content>
      <Tabs.Content value="fallback" className="min-h-0 flex-1"><FallbackChainsTab {...props} /></Tabs.Content>
      <Tabs.Content value="search" className="min-h-0 flex-1"><WebSearchTab key={props.cwd} cwd={props.cwd} /></Tabs.Content>
    </Tabs.Root>
  );
}

function ModelConnectionsTab({ cwd, snapshot, onApply }: ModelsTabProps) {
  const { client } = useLaserStable();
  const [providers, setProviders] = useState<ProviderAuthInfo[]>([]);
  const [dictation, setDictation] = useState<TranscribeStatus>();
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [patterns, setPatterns] = useState<string[] | null>(null);
  const [disabledList, setDisabledList] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [view, setView] = useState<ModelView>("all");
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
  const [patternsOpen, setPatternsOpen] = useState(false);
  const [fatal, setFatal] = useState<string>();
  // Rows whose switch is in flight, and the ones switched back on since the
  // tab opened, so the row itself says what happened.
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [offered, setOffered] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState<string>();

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
        setDisabledList(catalogResult.disabledModels ?? []);
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

  const connected = useMemo(() => connectedProviderIds(providers), [providers]);
  const offerState = useCallback((model: ModelCatalogEntry): ModelOfferState => modelOfferState(model, connected), [connected]);
  const counts = useMemo(() => offerStateCounts(models, connected), [models, connected]);
  const hiddenByList = counts["hidden-by-list"];
  const listScope = settingsListScope(snapshot, "enabledModels");
  const switchScope = settingsListScope(snapshot, "disabledModels");

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return models.filter(
      (model) =>
        matchesModelView(offerState(model), view) &&
        (providerFilter === "all" || model.provider === providerFilter) &&
        (needle === "" ||
          model.id.toLowerCase().includes(needle) ||
          (model.name ?? "").toLowerCase().includes(needle)),
    );
  }, [models, filter, view, providerFilter, offerState]);
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

  /** Mark rows busy for the life of `work`; the row's switch waits meanwhile. */
  const whileBusy = async (keys: string[], work: () => Promise<boolean>): Promise<boolean> => {
    if (keys.some((key) => busy.has(key))) return false;
    setBusy((current) => new Set([...current, ...keys]));
    try {
      return await work();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
    }
  };

  /**
   * The off side. `enabledModels` cannot say "everything except this one"
   * (no negation, proven in the worker against the engine's matcher), so a
   * switch writes an exact reference to the product's own disable list, where
   * that list lives. The allow-list is never touched by a switch, and a model
   * added to the catalogue later is not on this list, so it stays on.
   */
  const switchOff = (targets: ModelCatalogEntry[], what: string) => {
    const keys = targets.map(patternForModel);
    void whileBusy(keys, () =>
      onApply(switchScope, [{ path: "disabledModels", op: "set", value: withModelsSwitchedOff(disabledList, targets) }]).then((ok) => {
        if (!ok) return false;
        setOffered((current) => {
          const next = new Set(current);
          for (const key of keys) next.delete(key);
          return next;
        });
        setNote(`Switched off ${what}.`);
        return load(false).then(() => true);
      }),
    );
  };

  /**
   * The on side: take the references off the disable list, and for a model
   * the allow-list also leaves out, append its canonical reference to the
   * list where it lives. The list is never unset here: it may be narrow on
   * purpose.
   */
  const switchOn = (targets: ModelCatalogEntry[], what: string) => {
    const keys = targets.map(patternForModel);
    const switchedOff = targets.filter((model) => model.switchedOff);
    const hiddenByPattern = targets.filter((model) => offerState(model) === "hidden-by-list" || (model.switchedOff && model.hiddenByList));
    void whileBusy(keys, async () => {
      if (switchedOff.length > 0) {
        const next = withModelsSwitchedOn(disabledList, switchedOff);
        const ok = await onApply(switchScope, [
          next.length === 0 ? { path: "disabledModels", op: "unset" } : { path: "disabledModels", op: "set", value: next },
        ]);
        if (!ok) return false;
      }
      if (hiddenByPattern.length > 0) {
        let next = patterns;
        for (const model of hiddenByPattern) next = withModelOffered(next, model);
        const ok = await onApply(listScope, [{ path: "enabledModels", op: "set", value: next ?? [] }]);
        if (!ok) return false;
      }
      setOffered((current) => new Set([...current, ...keys]));
      setNote(
        hiddenByPattern.length > 0 && switchedOff.length === 0
          ? `Added ${hiddenByPattern.map(patternForModel).join(", ")} to Enabled models in your ${listScope} settings. ${hiddenByPattern.length === 1 ? "It is" : "They are"} in the pickers now.`
          : `Switched on ${what}.`,
      );
      await load(false);
      return true;
    });
  };

  const toggleModel = (model: ModelCatalogEntry, on: boolean) => {
    if (on) switchOn([model], patternForModel(model));
    else switchOff([model], patternForModel(model));
  };
  const toggleProvider = (provider: string, on: boolean) => {
    const targets = models.filter((model) => model.provider === provider);
    if (on) switchOn(targets.filter((model) => offerState(model) !== "offered"), `every ${provider} model`);
    else switchOff(targets.filter((model) => offerState(model) !== "switched-off"), `every ${provider} model`);
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

  const currentView = MODEL_VIEWS.find((entry) => entry.id === view) ?? MODEL_VIEWS[0]!;
  const viewCount = (id: ModelView): number =>
    id === "all" ? models.length : id === "enabled" ? counts.offered : models.length - counts.offered;

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
            Every model below has a switch. Off takes it out of every picker; on puts it back. A provider’s{" "}
            <span className="font-medium text-ink">Enable all</span> and <span className="font-medium text-ink">Disable all</span> do the
            same for its whole section. A model the provider adds later starts switched on. Written to your {switchScope} settings.
          </p>
          {note && (
            <p role="status" data-slot="offer-note" className="flex items-center gap-1.5 text-xs leading-5 text-ok">
              <Check className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{note}</span>
            </p>
          )}
          {patterns && patterns.length > 0 && !loading && (
            // A list written before a model existed hides it without a trace
            // anywhere a model is chosen. The count keeps a stale list visible
            // where it is edited; each hidden row carries its own way back in.
            <p
              role="status"
              data-slot="hidden-by-list"
              className={cn("text-xs leading-5", hiddenByList > 0 ? "text-attention" : "text-ink-3")}
            >
              {hiddenByList === 0
                ? "Your allow-list patterns hide no model from a connected provider."
                : `${hiddenByList} ${hiddenByList === 1 ? "model" : "models"} from connected providers ${hiddenByList === 1 ? "is" : "are"} hidden from the pickers by your allow-list patterns. Each row below says so; its switch lets it back in.`}
            </p>
          )}
          <Collapsible open={patternsOpen} onOpenChange={setPatternsOpen} className="rounded-xl border border-line bg-surface">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                data-slot="patterns-trigger"
                className="flex w-full items-center gap-2 px-3 py-2 text-start outline-none transition-colors duration-(--motion-fast) hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live motion-reduce:transition-none"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn("rtl:-scale-x-100", "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", patternsOpen && "rotate-90 rtl:-rotate-90")}
                />
                <span className="eyebrow text-ink-3">Advanced</span>
                <span className="min-w-0 truncate text-sm font-medium text-ink">Allow-list patterns</span>
                <Badge variant="outline" className="ms-auto shrink-0">
                  {patterns && patterns.length > 0 ? `${patterns.length} ${patterns.length === 1 ? "pattern" : "patterns"}` : "Not set"}
                </Badge>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="hairline-t flex flex-col gap-2 px-3 py-3">
              <p className="text-xs leading-5 text-ink-2">
                Patterns in <code className="font-mono">enabledModels</code> are an allow-list: when set, only what matches is offered, and a
                pattern written before a model existed hides every newer one. The switches never edit this list. Leave it empty to offer
                every model. Written to your {listScope} settings.
              </p>
              <ProviderModelMultiPicker
                models={models}
                values={patterns ?? []}
                disabled={snapshot === undefined}
                onValuesChange={(value) =>
                  void onApply(listScope, [
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
                  <Button variant="ghost" size="xs" onClick={() => void onApply(listScope, [{ path: "enabledModels", op: "unset" }]).then((ok) => ok && void load(false))}>
                    Offer every model
                  </Button>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Models</h2>
            <Badge variant="outline">
              {matching.length}
              {matching.length !== models.length ? ` of ${models.length}` : ""}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className="ms-auto" aria-label={`View: ${currentView.label}`} data-slot="model-view">
                  <span className="text-ink-3">View</span>
                  <span>{currentView.label}</span>
                  <ChevronsUpDown className="shrink-0 text-ink-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-var(--spacing-6))]">
                <DropdownMenuLabel>Which models to list</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={view} onValueChange={(next) => setView(next as ModelView)}>
                  {MODEL_VIEWS.map((entry) => (
                    <DropdownMenuRadioItem key={entry.id} value={entry.id} className="items-start">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-2 font-medium text-ink">
                          {entry.label}
                          <span className="tabular-nums text-xs text-ink-3">{viewCount(entry.id)}</span>
                        </span>
                        <span className="text-xs leading-4 text-ink-3">{entry.hint}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
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
            const all = models.filter((model) => model.provider === provider);
            const providerCounts = offerStateCounts(all, connected);
            // "On" is the switch, not the picker: a missing key leaves a
            // switch on, so a provider that is not signed in still reads as
            // all on, and Enable all has nothing to do there.
            const switchedOn = all.length - providerCounts["switched-off"] - providerCounts["hidden-by-list"];
            const canEnableAll = switchedOn < all.length;
            const canDisableAll = providerCounts["switched-off"] < all.length;
            const providerBusy = all.some((model) => busy.has(patternForModel(model)));
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
                <div className="flex items-center gap-1 bg-surface-2 pe-2" data-slot="provider-header" data-provider={provider}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-start outline-none transition-colors duration-(--motion-fast) hover:bg-surface-3 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live motion-reduce:transition-none"
                      aria-label={`${open ? "Collapse" : "Expand"} ${provider} models`}
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn("rtl:-scale-x-100", "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", open && "rotate-90 rtl:-rotate-90")}
                      />
                      <ProviderLogo provider={provider} className="size-4 shrink-0" />
                      <h3 className="min-w-0 truncate text-sm font-semibold text-ink">{provider}</h3>
                      <Badge variant="outline" className="tabular-nums">{switchedOn} of {all.length} on</Badge>
                      {provider === "openrouter" && <span className="hidden text-xs text-ink-3 lg:inline">Proxy catalogue; each row names its source.</span>}
                    </button>
                  </CollapsibleTrigger>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0"
                    disabled={!canEnableAll || providerBusy}
                    aria-label={`Enable every ${provider} model`}
                    onClick={() => toggleProvider(provider, true)}
                  >
                    Enable all
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0"
                    disabled={!canDisableAll || providerBusy}
                    aria-label={`Disable every ${provider} model`}
                    onClick={() => toggleProvider(provider, false)}
                  >
                    Disable all
                  </Button>
                </div>
                <CollapsibleContent className="hairline-t">
                  <DataTable
                    caption={`${provider} models, with their switch, context window, thinking levels and startup level`}
                    columns={modelColumns({ setThinking, offerState, toggleModel, busy, offered })}
                    rows={providerModels}
                    rowKey={(model) => `${model.provider}/${model.id}`}
                    minWidth="46rem"
                    emptyMessage={loading ? "Reading the catalogue…" : "No model matches the filter."}
                    className="rounded-none border-0"
                  />
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {grouped.length === 0 && models.length > 0 && (
            <p className="rounded-lg border border-line px-3 py-6 text-center text-sm text-ink-2">
              {view === "hidden" && filter.trim() === "" && providerFilter === "all"
                ? "Every model is offered. Nothing is hidden."
                : view === "enabled" && filter.trim() === "" && providerFilter === "all"
                  ? "No model is offered. Switch one on, or sign in to a provider above."
                  : "No model matches the filters."}
            </p>
          )}
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

interface ModelColumnActions {
  setThinking: (model: ModelCatalogEntry, level: ThinkingLevel | undefined) => void;
  offerState: (model: ModelCatalogEntry) => ModelOfferState;
  toggleModel: (model: ModelCatalogEntry, on: boolean) => void;
  /** `provider/id` keys with a write in flight, and ones switched on from this tab. */
  busy: ReadonlySet<string>;
  offered: ReadonlySet<string>;
}

/** Five-word status language for a row the pickers do not show (DESIGN.md, status language). */
const OFFER_STATE_LABEL: Record<Exclude<ModelOfferState, "offered">, string> = {
  "provider-not-connected": "Provider not signed in",
  "hidden-by-list": "Hidden by Enabled models",
  "switched-off": "Switched off",
};

function modelColumns({ setThinking, offerState, toggleModel, busy, offered }: ModelColumnActions): DataTableColumn<ModelCatalogEntry>[] {
  return [
    {
      key: "switch",
      label: "On",
      width: "3.5rem",
      render: (model) => {
        const state = offerState(model);
        const key = patternForModel(model);
        // The switch is the person's choice: on unless they switched it off or
        // their allow-list leaves it out. A missing key is not a choice, so a
        // model of a provider that is not signed in still reads as on.
        const on = state !== "switched-off" && state !== "hidden-by-list";
        return (
          <SettingsSwitch
            checked={on}
            disabled={busy.has(key)}
            aria-busy={busy.has(key) || undefined}
            aria-label={`${on ? "Switch off" : "Switch on"} ${key}`}
            data-slot="model-switch"
            onCheckedChange={(next) => toggleModel(model, next)}
          />
        );
      },
    },
    {
      key: "model",
      label: "Model",
      render: (model) => {
        const state = offerState(model);
        const key = patternForModel(model);
        const justOffered = state === "offered" && offered.has(key);
        return (
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("typed", state === "offered" ? "text-ink" : "text-ink-3")}>{modelProvenance(model).modelId}</span>
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
            {state === "switched-off" && (
              // The person's own choice: quiet, not a warning.
              <Badge variant="outline" data-slot="offer-state" data-state={state}>{OFFER_STATE_LABEL[state]}</Badge>
            )}
            {state === "provider-not-connected" && (
              // A different reason with a different fix: the sign-in above.
              // This is never the list's fault, even when the list is set.
              <Badge variant="outline" data-slot="offer-state" data-state={state}>{OFFER_STATE_LABEL[state]}</Badge>
            )}
            {state === "hidden-by-list" && (
              // A list written before the model existed. The switch lets it in.
              <Badge variant="attention" data-slot="offer-state" data-state={state}>{OFFER_STATE_LABEL[state]}</Badge>
            )}
            {justOffered && (
              <Badge variant="ok" data-slot="offer-state" data-state="just-offered"><Check aria-hidden="true" />Now in the pickers</Badge>
            )}
          </div>
          {model.name && model.name !== model.id && <p className="text-xs text-ink-3">{model.name}</p>}
          {modelProvenance(model).sourceProvider && (
            <p className="text-xs text-ink-3">Source: {modelProvenance(model).sourceProvider} · delivered by {model.provider}</p>
          )}
        </div>
        );
      },
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
