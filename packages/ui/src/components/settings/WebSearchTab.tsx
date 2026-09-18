"use client";
import type { CapabilityDecision } from "@/runtime/environment-capabilities";
import type { SettingsScopeView } from "@/runtime/settings-scope";
import type { ScopeDraft } from "./ScopeDraftGuard.js";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Globe, KeyRound, Link2, Loader2, RefreshCw } from "lucide-react";
import { WEB_SEARCH_PROVIDERS, type FeatureState, type ProviderAuthInfo, type WebSearchChange, type WebSearchConnection, type WebSearchProvider, type WebSearchProviderStatus, type WebSearchStatus } from "@lasercode/protocol";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { CapabilityNotice } from "@/components/capability-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useLaserStable } from "@/runtime";
import { cn } from "@/lib/utils";
import { featureSource, selectedFeatureValue } from "./feature-scope.js";
import { useCommittedTargetLifetime } from "./useCommittedTargetLifetime.js";

interface SearchDraftValues {
  key: string;
  baseUrl: string;
  zone: string;
}

type WebSearchScope =
  | { view: "global" }
  | { view: "project" | "effective"; projectCwd: string };

type WebSearchTabProps = WebSearchScope & {
  neutralRouteCwd: string;
  decision?: CapabilityDecision | undefined;
  onDraftChange?: ((providerId: string, draft: ScopeDraft | undefined) => void) | undefined;
};

const initialValues = (connection: WebSearchProviderStatus): SearchDraftValues => ({
  key: "",
  baseUrl: connection.baseUrl ?? "",
  zone: connection.zone ?? "",
});

const isDirty = (values: SearchDraftValues, connection: WebSearchProviderStatus): boolean =>
  values.key.trim() !== ""
  || values.baseUrl.trim() !== (connection.baseUrl ?? "")
  || values.zone.trim() !== (connection.zone ?? "");

/** ProviderStep's connection/disclosure pattern, using the adopted settings
 * primitives. Keys stay only in this component's ephemeral draft state. */
export function WebSearchTab(props: WebSearchTabProps) {
  const { neutralRouteCwd, view, decision, onDraftChange } = props;
  const projectCwd = "projectCwd" in props ? props.projectCwd : undefined;
  const writable = view !== "effective" && (decision?.state === "available" || decision === undefined);
  const readOnlyExplanation = view === "effective"
    ? "Effective settings are a read-only preview. Choose Global or Project to change web search availability. Connections remain Global."
    : decision?.state === "explained" ? decision.explanation : undefined;
  const { client } = useLaserStable();
  const [status, setStatus] = useState<WebSearchStatus>();
  const [models, setModels] = useState<ProviderAuthInfo[]>([]);
  const [feature, setFeature] = useState<FeatureState>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState<{ provider?: string; label: string; target: "provider" | "availability" }>();
  const busy = pending !== undefined;
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<string, SearchDraftValues>>({});
  const loadGeneration = useRef(0);
  const connectionOperation = useRef<symbol | undefined>(undefined);
  const featureOperation = useRef<symbol | undefined>(undefined);
  const targetKey = `${view}:${view === "global" ? "" : props.projectCwd}:${neutralRouteCwd}`;
  const target = useCommittedTargetLifetime(targetKey);

  const load = useCallback(async (): Promise<boolean> => {
    const lease = target.capture();
    if (!lease) return false;
    const request = ++loadGeneration.current;
    setError(undefined);
    let featureParams: { cwd?: string } = {};
    if (view !== "global") {
      if (projectCwd === undefined) {
        setError("Choose a project before loading its web search settings.");
        return false;
      }
      featureParams = { cwd: projectCwd };
    }
    try {
      const [search, providers, features] = await Promise.all([
        client.request("web-search/status", { cwd: neutralRouteCwd }),
        client.request("pi/providers/list", { cwd: neutralRouteCwd }).catch(() => ({ providers: [] })),
        client.request("feature/list", featureParams),
      ]);
      if (request !== loadGeneration.current || !target.isCurrent(lease)) return false;
      setStatus(search);
      setModels(providers.providers);
      setFeature(features.features.find((entry) => entry.manifest.id === "web-search"));
      return true;
    } catch (failure) {
      if (request === loadGeneration.current && target.isCurrent(lease)) {
        setError(failure instanceof Error ? failure.message : "Could not load search connections. Try again.");
      }
      return false;
    }
  }, [client, neutralRouteCwd, projectCwd, target, view]);

  useEffect(() => {
    setStatus(undefined);
    setPending(undefined);
    setNotice(undefined);
    setDrafts({});
    connectionOperation.current = undefined;
    featureOperation.current = undefined;
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const change = useCallback(async (changeRequest: WebSearchChange): Promise<boolean> => {
    if (busy) return false;
    const lease = target.capture();
    if (!lease) return false;
    const operation = Symbol("web-search-connection");
    connectionOperation.current = operation;
    const testing = changeRequest.action !== "configure" || changeRequest.activate;
    const providerId = changeRequest.action === "test" ? status?.selectedProvider : changeRequest.provider;
    if (!providerId) return false;
    const name = WEB_SEARCH_PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId;
    setPending({ provider: providerId, target: "provider", label: testing ? `Testing ${name} connection…` : `Saving ${name} connection…` });
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await client.request("web-search/configure", { cwd: neutralRouteCwd, change: changeRequest });
      if (connectionOperation.current !== operation || !target.isCurrent(lease)) return false;
      setStatus(result);
      setNotice(changeRequest.action === "select" || (changeRequest.action === "configure" && changeRequest.activate)
        ? `${WEB_SEARCH_PROVIDERS.find((provider) => provider.id === result.selectedProvider)?.name} passed the test and is the only selected search provider. Web search enablement is unchanged.`
        : "Search connection updated. Other providers will not be used automatically.");
      return true;
    } catch (failure) {
      if (connectionOperation.current === operation && target.isCurrent(lease)) {
        setError(failure instanceof Error ? failure.message : "Could not save. Try again.");
      }
      return false;
    } finally {
      if (connectionOperation.current === operation && target.isCurrent(lease)) setPending(undefined);
    }
  }, [busy, client, neutralRouteCwd, status?.selectedProvider, target]);

  const saveConnection = useCallback(async (
    provider: WebSearchProvider,
    connection: WebSearchProviderStatus,
    values: SearchDraftValues,
    source: WebSearchConnection["source"],
    sharedProvider?: string,
    forget = false,
  ): Promise<boolean> => {
    const activate = !forget && (source !== "none" || provider.key !== "required");
    const ok = await change({
      action: "configure",
      provider: provider.id,
      connection: {
        source,
        ...(sharedProvider ? { sharedProvider } : {}),
        ...(provider.endpoint && values.baseUrl.trim() ? { baseUrl: values.baseUrl.trim() } : {}),
        ...(provider.zone && values.zone.trim() ? { zone: values.zone.trim() } : {}),
      },
      ...(forget ? { apiKey: null } : source === "dedicated" && values.key.trim() ? { apiKey: values.key.trim() } : {}),
      ...(activate ? { activate: true } : {}),
    });
    if (ok) {
      setDrafts((current) => {
        if (!(provider.id in current)) return current;
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
    }
    return ok;
  }, [change]);

  // Registration lives with the keyed state, above collapse and filtering.
  // Removing one provider's draft never unregisters or clears another's key.
  useEffect(() => {
    if (!status || !onDraftChange) return undefined;
    const registered: string[] = [];
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const connection = status.providers.find((entry) => entry.id === provider.id);
      const values = drafts[provider.id];
      if (!connection || !values || !isDirty(values, connection)) continue;
      const source: WebSearchConnection["source"] = values.key.trim()
        ? "dedicated"
        : connection.source === "shared"
          ? "shared"
          : provider.key === "none" ? "none" : connection.source;
      registered.push(provider.id);
      onDraftChange(provider.id, {
        id: `web-search-${provider.id}`,
        label: `${provider.name} search connection`,
        save: () => saveConnection(provider, connection, values, source, connection.sharedProvider),
        discard: () => setDrafts((current) => {
          if (!(provider.id in current)) return current;
          const next = { ...current };
          delete next[provider.id];
          return next;
        }),
      });
    }
    return () => {
      for (const providerId of registered) onDraftChange(providerId, undefined);
    };
  }, [drafts, onDraftChange, saveConnection, status]);

  const toggle = async (enabled: boolean | null) => {
    if (busy || view === "effective" || !feature) return;
    const lease = target.capture();
    if (!lease) return;
    const operation = Symbol("web-search-feature");
    featureOperation.current = operation;
    const routeCwd = view === "project" ? props.projectCwd : neutralRouteCwd;
    const name = WEB_SEARCH_PROVIDERS.find((provider) => provider.id === status?.selectedProvider)?.name ?? "search provider";
    setPending({
      target: "availability",
      label: enabled === true ? `Testing ${name} before enabling search…` : enabled === null ? "Restoring the Global web search choice…" : "Turning off web search…",
    });
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await client.request("feature/set", {
        id: "web-search",
        scope: view === "project" ? "project" : "global",
        enabled,
        cwd: routeCwd,
      });
      if (featureOperation.current !== operation || !target.isCurrent(lease)) return;
      const accepted = await load();
      if (!accepted || featureOperation.current !== operation || !target.isCurrent(lease)) return;
      setNotice(result.restartPending
        ? "Saved. Search availability will change when the affected project can restart."
        : enabled === null
          ? "Web search now follows your Global choice. Your connections are unchanged."
          : `Web search ${enabled ? "enabled" : "disabled"}. Your connections are unchanged.`);
    } catch (failure) {
      if (featureOperation.current === operation && target.isCurrent(lease)) {
        setError(failure instanceof Error ? failure.message : "Could not change web search. Try again.");
      }
    } finally {
      if (featureOperation.current === operation && target.isCurrent(lease)) setPending(undefined);
    }
  };

  if (!status) return <div className="p-4">{error ? <ErrorState title="Could not load web search" detail={error} onRetry={() => void load()} /> : <GenerationLoader label="Loading search connections" />}</div>;
  const selected = WEB_SEARCH_PROVIDERS.find((entry) => entry.id === status.selectedProvider)!;
  const selectedStatus = status.providers.find((entry) => entry.id === selected.id)!;
  const featureEnabled = feature ? selectedFeatureValue(feature, view) : false;
  const shown = WEB_SEARCH_PROVIDERS.filter((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-4 py-5 md:px-6">
        <header className="flex items-start justify-between gap-3">
          <div><h2 className="text-lg font-semibold text-ink">Web search</h2><p className="mt-1 text-sm leading-6 text-ink-2">Fresh answers with source links, through a provider you choose.</p></div>
          <Button variant="ghost" size="sm" aria-label="Refresh search connections" disabled={busy} onClick={() => void load()}><RefreshCw /></Button>
        </header>
        {!writable && readOnlyExplanation ? <CapabilityNotice explanation={readOnlyExplanation} /> : null}
        <section className="rounded-xl border border-line bg-surface p-4" aria-label="Search availability">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex items-center gap-2"><Globe className="size-4 text-ink-2" /><h3 className="text-sm font-semibold">Enable web search</h3></div><p className="mt-1 text-sm leading-6 text-ink-2">Turning on tests the selected provider with a real search; charges may apply. Switching off keeps your connections saved.</p></div>
            <Toggle variant="outline" pressed={featureEnabled} disabled={!writable || busy || !feature} aria-label="Enable web search" onPressedChange={(enabled) => void toggle(enabled)}>{featureEnabled ? "On" : "Off"}</Toggle>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm"><span className="text-ink-2">Searches go to</span><span className="font-medium">{selected.name}</span><Badge variant="outline">{selectedStatus.configured ? selectedStatus.source === "none" ? "No key needed" : "Connection saved" : "Setup needed"}</Badge></div>
          {!selectedStatus.configured && <p className="mt-2 text-sm text-attention">Configure {selected.name} below before searching.</p>}
          {pending?.target === "availability" && <GenerationLoader className="mt-3" label={pending.label} layout="inline" />}
          {feature ? <p className="mt-2 text-sm text-ink-3">{featureSource(feature, view)}</p> : null}
          {writable && view === "project" && feature?.projectEnabled !== undefined ? (
            <Button type="button" variant="link" size="sm" className="mt-2 h-auto p-0 text-xs" disabled={busy} onClick={() => void toggle(null)}>Use Global choice</Button>
          ) : null}
        </section>
        {error && <div role="alert" className="text-sm text-danger">{error}</div>}
        {status.sharedConnectionWarning && <p role="status" className="text-sm text-attention">{status.sharedConnectionWarning}</p>}
        {notice && <p role="status" className="text-sm text-ink-2">{notice}</p>}
        <div className="flex flex-col gap-2"><h3 className="text-sm font-semibold">Search providers</h3><p className="text-sm leading-6 text-ink-2">Only the selected provider receives queries. Paid searches use its billing or account allowance. Model connections need your explicit permission.</p><Input aria-label="Find a search provider" placeholder="Find a provider…" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          {shown.map((provider) => {
            const connection = status.providers.find((entry) => entry.id === provider.id)!;
            const values = drafts[provider.id] ?? initialValues(connection);
            return <Collapsible key={provider.id} open={expanded.has(provider.id)} onOpenChange={(open) => setExpanded((current) => {
              const next = new Set(current);
              if (open) next.add(provider.id);
              else next.delete(provider.id);
              return next;
            })}>
              <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg p-3 text-start transition-colors duration-(--motion-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-live">
                <ChevronRight className={cn("rtl:-scale-x-100", "size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast)", expanded.has(provider.id) && "rotate-90 rtl:-rotate-90")} />
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{provider.name}</span><span className="block text-xs text-ink-2">{connection.source === "shared" ? `Shared · ${connection.sharedProvider}` : connection.hasKey ? "Search-only key saved" : provider.key === "none" ? provider.endpoint ? "Self-hosted instance" : "No key needed" : provider.key === "optional" ? "Key optional" : "API key or connection required"}</span></span>
                {status.selectedProvider === provider.id && <Badge variant="outline"><Check className="size-3" /> Selected</Badge>}
                {pending?.provider === provider.id && <Loader2 aria-label={pending.label} className="size-4 shrink-0 text-live motion-safe:animate-busy" />}
              </CollapsibleTrigger>
              <CollapsibleContent><SearchConnection
                provider={provider}
                connection={connection}
                values={values}
                onValuesChange={(next) => setDrafts((current) => ({ ...current, [provider.id]: next }))}
                models={models}
                busy={busy}
                progress={pending?.provider === provider.id ? pending.label : undefined}
                selected={status.selectedProvider === provider.id}
                writable={writable}
                onChange={change}
                onSave={(source, sharedProvider, forget) => saveConnection(provider, connection, values, source, sharedProvider, forget)}
              /></CollapsibleContent>
            </Collapsible>;
          })}
          {!shown.length && <p className="p-4 text-sm text-ink-2">No providers match “{filter}”. Try another name.</p>}
        </div>
      </div>
    </ScrollArea>
  );
}

function SearchConnection({ provider, connection, values, onValuesChange, models, busy, progress, selected, writable, onChange, onSave }: {
  provider: WebSearchProvider;
  connection: WebSearchProviderStatus;
  values: SearchDraftValues;
  onValuesChange: (values: SearchDraftValues) => void;
  models: ProviderAuthInfo[];
  busy: boolean;
  progress?: string | undefined;
  selected: boolean;
  writable: boolean;
  onChange: (change: WebSearchChange) => Promise<boolean>;
  onSave: (source: WebSearchConnection["source"], sharedProvider?: string, forget?: boolean) => Promise<boolean>;
}) {
  const set = (patch: Partial<SearchDraftValues>) => onValuesChange({ ...values, ...patch });
  const shared = models.filter((entry) => provider.sharedProviders.includes(entry.id));
  return <div className="flex flex-col gap-3 px-4 pb-4 pt-1" aria-busy={progress !== undefined}>
    {provider.note && <p className="text-sm leading-6 text-ink-2">{provider.note}</p>}
    {progress && <GenerationLoader className="sticky top-0 z-10 bg-surface py-2" label={progress} layout="inline" />}
    {shared.length > 0 && <section className="flex flex-col gap-2" aria-label={`${provider.name} shared connections`}>
      {shared.map((entry) => <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-3">
        <div className="min-w-0"><p className="flex items-center gap-2 text-sm font-medium"><Link2 className="size-4" />{entry.name}</p><p className="mt-1 text-xs text-ink-2">{entry.configured ? "Reuse this model connection; no second key is stored." : "Connect this provider in Models and dictation first."}</p></div>
        <Button variant="secondary" size="sm" disabled={!writable || busy || (!entry.configured && !(connection.source === "shared" && connection.sharedProvider === entry.id))} onClick={() => void onSave(connection.source === "shared" && connection.sharedProvider === entry.id ? "none" : "shared", connection.source === "shared" && connection.sharedProvider === entry.id ? undefined : entry.id)}>{connection.source === "shared" && connection.sharedProvider === entry.id ? "Revoke search access" : "Allow, test and use"}</Button>
      </div>)}
    </section>}
    {provider.endpoint && <label className="flex flex-col gap-1 text-sm">SearXNG address<Input disabled={!writable || busy} type="url" value={values.baseUrl} placeholder="https://search.example.com" onChange={(event) => set({ baseUrl: event.target.value })} /></label>}
    {provider.zone && <label className="flex flex-col gap-1 text-sm">SERP zone<Input disabled={!writable || busy} value={values.zone} placeholder="Your SERP zone name" onChange={(event) => set({ zone: event.target.value })} /></label>}
    {provider.key !== "none" && <label className="flex flex-col gap-1 text-sm"><span className="flex items-center gap-2"><KeyRound className="size-4 text-ink-2" />{shared.length ? "Or use a separate search-only key" : "Search API key"}</span><Input disabled={!writable || busy} type="password" autoComplete="new-password" value={values.key} onChange={(event) => set({ key: event.target.value })} placeholder={connection.hasKey ? "Saved key is never shown; paste to replace" : "Paste an API key"} /></label>}
    <div className="flex flex-wrap gap-2">
      {provider.key !== "none" && <Button size="sm" variant="secondary" disabled={!writable || busy || (!values.key.trim() && !connection.hasKey)} onClick={() => void onSave("dedicated")}>Test and use key</Button>}
      {provider.key !== "required" && <Button size="sm" variant="secondary" disabled={!writable || busy || (provider.endpoint && !values.baseUrl.trim())} onClick={() => void onSave("none")}>{provider.endpoint ? "Test and use instance" : "Test and use without a key"}</Button>}
      {connection.hasKey && <Button size="sm" variant="ghost" disabled={!writable || busy} onClick={() => void onSave(connection.source === "shared" ? "shared" : "none", connection.sharedProvider, true)}>Remove search-only key</Button>}
      <Button size="sm" disabled={!writable || busy || !connection.configured} onClick={() => void onChange({ action: "select", provider: provider.id })}>{selected ? "Test selected provider" : "Test and use saved connection"}</Button>
    </div>
    <p className="text-xs leading-5 text-ink-3">Testing makes a real search call and may incur provider charges. Only a successful test switches the selected provider. All other providers stay inactive, including free ones. No fallback is used.</p>
  </div>;
}
