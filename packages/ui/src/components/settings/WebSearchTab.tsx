"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Globe, KeyRound, Link2, RefreshCw } from "lucide-react";
import { WEB_SEARCH_PROVIDERS, type FeatureState, type ProviderAuthInfo, type WebSearchChange, type WebSearchConnection, type WebSearchProvider, type WebSearchProviderStatus, type WebSearchStatus } from "@lasercode/protocol";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useLaserStable } from "@/runtime";
import { cn } from "@/lib/utils";

/** ProviderStep's connection/disclosure pattern, using the adopted settings
 * primitives. Keys are write-only: never restored from responses or drafts. */
export function WebSearchTab({ cwd }: { cwd: string }) {
  const { client } = useLaserStable();
  const [status, setStatus] = useState<WebSearchStatus>();
  const [models, setModels] = useState<ProviderAuthInfo[]>([]);
  const [feature, setFeature] = useState<FeatureState>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setError(undefined);
    try {
      const [search, providers, features] = await Promise.all([
        client.request("web-search/status", { cwd }), client.request("pi/providers/list", { cwd }).catch(() => ({ providers: [] })), client.request("feature/list", { cwd }),
      ]);
      if (request !== generation.current) return;
      setStatus(search); setModels(providers.providers); setFeature(features.features.find((entry) => entry.manifest.id === "web-search"));
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Could not load search connections. Try again.");
    }
  }, [client, cwd]);
  useEffect(() => { setStatus(undefined); void load(); return () => { generation.current++; }; }, [load]);
  const change = async (change: WebSearchChange) => {
    if (busy) return false;
    setBusy(true); setError(undefined); setNotice(undefined);
    const request = generation.current;
    try {
      const result = await client.request("web-search/configure", { cwd, change });
      if (request !== generation.current) return false;
      setStatus(result); setNotice(change.action === "select" ? "Search provider selected. Feature enablement is unchanged." : "Search connection saved. Feature enablement is unchanged.");
      return true;
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Could not save. Try again.");
      return false;
    } finally { if (request === generation.current) setBusy(false); }
  };
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError(undefined);
    try {
      const result = await client.request("feature/set", { id: "web-search", scope: "global", enabled });
      // Reload with cwd so project overrides remain visible.
      await load();
      setNotice(result.restartPending ? "Saved. Search availability will change when the affected project can restart." : `Web search ${enabled ? "enabled" : "disabled"}. Your connections are unchanged.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not change web search. Try again."); }
    finally { setBusy(false); }
  };
  if (!status) return <div className="p-4">{error ? <ErrorState title="Could not load web search" detail={error} onRetry={() => void load()} /> : <GenerationLoader label="Loading search connections" />}</div>;
  const selected = WEB_SEARCH_PROVIDERS.find((entry) => entry.id === status.selectedProvider)!;
  const selectedStatus = status.providers.find((entry) => entry.id === selected.id)!;
  const shown = WEB_SEARCH_PROVIDERS.filter((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-4 py-5 md:px-6">
        <header className="flex items-start justify-between gap-3">
          <div><h2 className="text-lg font-semibold text-ink">Web search</h2><p className="mt-1 text-sm leading-6 text-ink-2">Fresh answers with source links, through a provider you choose.</p></div>
          <Button variant="ghost" size="sm" aria-label="Refresh search connections" disabled={busy} onClick={() => void load()}><RefreshCw /></Button>
        </header>
        <section className="rounded-xl border border-line bg-surface p-4" aria-label="Search availability">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex items-center gap-2"><Globe className="size-4 text-ink-2" /><h3 className="text-sm font-semibold">Enable web search</h3></div><p className="mt-1 text-sm leading-6 text-ink-2">Every-project default. Switching off keeps your connections saved.</p></div>
            <Toggle variant="outline" pressed={feature?.globalEnabled ?? false} disabled={busy || !feature} aria-label="Enable web search" onPressedChange={(enabled) => void toggle(enabled)}>{feature?.globalEnabled ? "On" : "Off"}</Toggle>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm"><span className="text-ink-2">Searches go to</span><span className="font-medium">{selected.name}</span><Badge variant="outline">{selectedStatus.configured ? selectedStatus.source === "none" ? "No key needed" : "Connection saved" : "Setup needed"}</Badge></div>
          {!selectedStatus.configured && <p className="mt-2 text-sm text-attention">Configure {selected.name} below before searching.</p>}
          {feature?.projectEnabled !== undefined && <p className="mt-2 text-sm text-attention">This project has its own choice: {feature.enabled ? "on" : "off"}. Change or clear it in Features → This project.</p>}
        </section>
        {error && <div role="alert" className="text-sm text-danger">{error}</div>}
        {status.sharedConnectionWarning && <p role="status" className="text-sm text-attention">{status.sharedConnectionWarning}</p>}
        {notice && <p role="status" className="text-sm text-ink-2">{notice}</p>}
        <div className="flex flex-col gap-2"><h3 className="text-sm font-semibold">Search providers</h3><p className="text-sm leading-6 text-ink-2">Only the selected provider receives queries. Paid searches use its billing or account allowance. Model connections need your explicit permission.</p><Input aria-label="Find a search provider" placeholder="Find a provider…" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          {shown.map((provider) => {
            const connection = status.providers.find((entry) => entry.id === provider.id)!;
            return <Collapsible key={provider.id} open={expanded === provider.id} onOpenChange={(open) => setExpanded(open ? provider.id : undefined)}>
              <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg p-3 text-start transition-colors duration-(--motion-fast) hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-live">
                <ChevronRight className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast)", expanded === provider.id && "rotate-90")} />
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{provider.name}</span><span className="block text-xs text-ink-2">{connection.source === "shared" ? `Shared · ${connection.sharedProvider}` : connection.hasKey ? "Search-only key saved" : provider.key === "none" ? provider.endpoint ? "Self-hosted instance" : "No key needed" : provider.key === "optional" ? "Key optional" : "API key or connection required"}</span></span>
                {status.selectedProvider === provider.id && <Badge variant="outline"><Check className="size-3" /> Selected</Badge>}
              </CollapsibleTrigger>
              <CollapsibleContent><SearchConnection key={`${provider.id}:${connection.source}:${connection.sharedProvider ?? ""}`} provider={provider} connection={connection} models={models} busy={busy} selected={status.selectedProvider === provider.id} onChange={change} /></CollapsibleContent>
            </Collapsible>;
          })}
          {!shown.length && <p className="p-4 text-sm text-ink-2">No providers match “{filter}”. Try another name.</p>}
        </div>
      </div>
    </ScrollArea>
  );
}

function SearchConnection({ provider, connection, models, busy, selected, onChange }: {
  provider: WebSearchProvider; connection: WebSearchProviderStatus; models: ProviderAuthInfo[]; busy: boolean; selected: boolean; onChange: (change: WebSearchChange) => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? "");
  const [zone, setZone] = useState(connection.zone ?? "");
  const save = async (source: WebSearchConnection["source"], sharedProvider?: string, forget = false) => {
    const ok = await onChange({ action: "configure", provider: provider.id, connection: { source, ...(sharedProvider ? { sharedProvider } : {}), ...(provider.endpoint && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(provider.zone && zone.trim() ? { zone: zone.trim() } : {}) }, ...(forget ? { apiKey: null } : source === "dedicated" && key.trim() ? { apiKey: key.trim() } : {}) });
    if (ok) setKey("");
  };
  const shared = models.filter((entry) => provider.sharedProviders.includes(entry.id));
  return <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
    {provider.note && <p className="text-sm leading-6 text-ink-2">{provider.note}</p>}
    {shared.length > 0 && <section className="flex flex-col gap-2" aria-label={`${provider.name} shared connections`}>
      {shared.map((entry) => <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-3">
        <div className="min-w-0"><p className="flex items-center gap-2 text-sm font-medium"><Link2 className="size-4" />{entry.name}</p><p className="mt-1 text-xs text-ink-2">{entry.configured ? "Reuse this model connection; no second key is stored." : "Connect this provider in Models and dictation first."}</p></div>
        <Button variant="secondary" size="sm" disabled={busy || (!entry.configured && !(connection.source === "shared" && connection.sharedProvider === entry.id))} onClick={() => void save(connection.source === "shared" && connection.sharedProvider === entry.id ? "none" : "shared", connection.source === "shared" && connection.sharedProvider === entry.id ? undefined : entry.id)}>{connection.source === "shared" && connection.sharedProvider === entry.id ? "Revoke search access" : "Allow for web search"}</Button>
      </div>)}
    </section>}
    {provider.endpoint && <label className="flex flex-col gap-1 text-sm">SearXNG address<Input type="url" value={baseUrl} placeholder="https://search.example.com" onChange={(event) => setBaseUrl(event.target.value)} /></label>}
    {provider.zone && <label className="flex flex-col gap-1 text-sm">SERP zone<Input value={zone} placeholder="Your SERP zone name" onChange={(event) => setZone(event.target.value)} /></label>}
    {provider.key !== "none" && <label className="flex flex-col gap-1 text-sm"><span className="flex items-center gap-2"><KeyRound className="size-4 text-ink-2" />{shared.length ? "Or use a separate search-only key" : "Search API key"}</span><Input type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={connection.hasKey ? "Saved key is never shown; paste to replace" : "Paste an API key"} /></label>}
    <div className="flex flex-wrap gap-2">
      {provider.key !== "none" && <Button size="sm" variant="secondary" disabled={busy || (!key.trim() && !connection.hasKey)} onClick={() => void save("dedicated")}>Save search connection</Button>}
      {provider.key !== "required" && <Button size="sm" variant="secondary" disabled={busy || (provider.endpoint && !baseUrl.trim())} onClick={() => void save("none")}>{provider.endpoint ? "Save instance" : "Use without a key"}</Button>}
      {connection.hasKey && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(connection.source === "shared" ? "shared" : "none", connection.sharedProvider, true)}>Remove search-only key</Button>}
      <Button size="sm" disabled={busy || selected || !connection.configured} onClick={() => void onChange({ action: "select", provider: provider.id })}>{selected ? "Selected provider" : "Use for searches"}</Button>
    </div>
    <p className="text-xs leading-5 text-ink-3">Saving is not a paid connection test. Any provider rejection appears in the search result. No fallback provider is used.</p>
  </div>;
}
