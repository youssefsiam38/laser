"use client";
/**
 * Settings (M4-T2, M4-T3, M4-T4).
 *
 * Three screens behind one header: every Pi setting as a form, the package
 * manager, and providers/models. All three are per project, because Pi's
 * settings are per project: the scope switch is not decoration, it decides
 * which of the two files a change lands in.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { usePiorbitStable } from "@/runtime";
import type { SettingsCatalog, SettingsScope, SettingsSnapshot } from "@piorbit/protocol";

import { ModelsTab } from "./ModelsTab.js";
import { PackagesTab } from "./PackagesTab.js";
import { SettingsForm } from "./SettingsForm.js";

type Tab = "settings" | "packages" | "models";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "settings", label: "All settings" },
  { id: "packages", label: "Packages" },
  { id: "models", label: "Providers and models" },
];

export function SettingsScreen({ cwd }: { cwd: string | undefined }) {
  const { client, actions } = usePiorbitStable();
  const [tab, setTab] = useState<Tab>("settings");
  const [catalog, setCatalog] = useState<SettingsCatalog>();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(undefined);
    try {
      // The catalogue is fixed per pinned Pi, so it is fetched once per project
      // open; the snapshot is what changes.
      const [cat, snap] = await Promise.all([
        catalog ? Promise.resolve({ catalog }) : client.request("pi/settings/list", { cwd }),
        client.request("pi/settings/get", { cwd }),
      ]);
      setCatalog(cat.catalog);
      setSnapshot(snap.snapshot);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, cwd, catalog]);

  useEffect(() => {
    void load();
    // Re-running on `load` would loop: it changes identity when the catalogue
    // arrives. The project is the only input that should refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  /** One place where a write happens, so every screen reports failure the same way. */
  const apply = useCallback(
    async (scope: SettingsScope, changes: Parameters<typeof client.request<"pi/settings/set">>[1]["changes"]) => {
      if (!cwd) return false;
      try {
        const { snapshot: next } = await client.request("pi/settings/set", { cwd, scope, changes });
        setSnapshot(next);
        return true;
      } catch (writeError) {
        actions.toast("error", writeError instanceof Error ? writeError.message : String(writeError));
        return false;
      }
    },
    [client, cwd, actions],
  );

  if (!cwd) {
    return (
      <Empty
        title="No project selected"
        body="Pi keeps settings per project as well as globally, so piorbit needs to know which project you mean. Pick one in the rail, or add a directory."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 hairline-b">
        {TABS.map((entry) => (
          <Button
            key={entry.id}
            variant="ghost"
            size="sm"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? "page" : undefined}
            className={cn(tab === entry.id && "bg-surface-2 text-ink")}
          >
            {entry.label}
          </Button>
        ))}
        <div className="ms-auto flex items-center gap-2">
          {loading && <Loader2 className="size-3.5 animate-spin text-ink-3" aria-label="Loading" />}
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label="Reload settings">
            <RefreshCw />
          </Button>
        </div>
      </div>

      {error && (
        <div className="m-3 flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Could not read settings for this project.</p>
            <p className="mt-0.5 font-mono text-2xs leading-4 break-words opacity-90">{error}</p>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tab === "settings" && catalog && snapshot && (
          <SettingsForm catalog={catalog} snapshot={snapshot} onApply={apply} />
        )}
        {tab === "packages" && <PackagesTab cwd={cwd} snapshot={snapshot} onSettingsChanged={load} />}
        {tab === "models" && <ModelsTab cwd={cwd} snapshot={snapshot} onApply={apply} />}
      </div>
    </div>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-120 flex-col gap-2 px-6 py-16 text-center">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="text-sm leading-6 text-ink-2">{body}</p>
      </div>
    </ScrollArea>
  );
}

/** Shared little bits the three tabs use. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
      <input
        type="search"
        aria-label={placeholder}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-8 w-full rounded-lg border border-line bg-surface ps-7 pe-2 text-sm text-ink",
          "placeholder:text-ink-3 outline-none transition-[border-color] duration-75",
          "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
        )}
      />
    </div>
  );
}

export function OriginBadge({ origin }: { origin: "project" | "global" | "default" | "unset" }) {
  if (origin === "project") return <Badge variant="live">project</Badge>;
  if (origin === "global") return <Badge variant="outline">global</Badge>;
  if (origin === "default") return <Badge variant="default">Pi default</Badge>;
  return <Badge variant="outline">not set</Badge>;
}
