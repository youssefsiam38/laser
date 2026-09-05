"use client";
/**
 * Settings (M4-T2, M4-T3, M4-T4).
 *
 * Four screens behind one header: every Pi setting as a form, the package
 * manager, providers/models, and this device.
 *
 * The first three are per project, because Pi's settings are per project: the
 * scope switch is not decoration, it decides which of the two files a change
 * lands in. "This device" is the exception and says so — a notification
 * permission belongs to the browser on this phone or laptop, not to a project,
 * and pretending otherwise would put a per-device switch behind a project
 * scope that has nothing to do with it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { usePiorbitStable } from "@/runtime";
import type { SettingsCatalog, SettingsScope, SettingsSnapshot } from "@piorbit/protocol";

import { NotificationsSetting } from "@/components/mobile";

import { AppearanceTab } from "./appearance/AppearanceTab.js";
import { KeyboardTab } from "./KeyboardTab.js";
import { ModelsTab } from "./ModelsTab.js";
import { PackagesTab } from "./PackagesTab.js";
import { SettingsForm } from "./SettingsForm.js";
import { TrustTab } from "./TrustTab.js";

type Tab = "settings" | "appearance" | "packages" | "models" | "keyboard" | "trust" | "device";

/**
 * Four of these are per project and three are not. `PROJECTLESS` is the list
 * of the three, so a screen that has nothing to do with a project directory
 * stays reachable before one is chosen: how the app looks, which keys it
 * answers to, and what this browser is allowed to do.
 */
const PROJECTLESS: readonly Tab[] = ["appearance", "keyboard", "trust", "device"];

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "settings", label: "All settings" },
  { id: "appearance", label: "Appearance" },
  { id: "packages", label: "Packages" },
  { id: "models", label: "Providers and models" },
  { id: "keyboard", label: "Keyboard" },
  { id: "trust", label: "Trust" },
  { id: "device", label: "This device" },
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

  // "No project" is a state of one tab, not of the screen: the tab strip has
  // to stay on screen or Appearance, Keyboard, Trust and This device become
  // unreachable on a machine with no project yet — which is every first run.
  const needsProject = !cwd && !PROJECTLESS.includes(tab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 hairline-b">
        {/* Seven tabs do not fit a phone. The strip scrolls inside itself
            rather than the page scrolling sideways (DESIGN.md, the floor). */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {TABS.map((entry) => (
            <Button
              key={entry.id}
              variant="ghost"
              size="sm"
              onClick={() => setTab(entry.id)}
              aria-current={tab === entry.id ? "page" : undefined}
              className={cn("shrink-0", tab === entry.id && "bg-surface-2 text-ink")}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        <div className="ms-auto flex items-center gap-2">
          {loading && <GenerationLoader label="Loading settings" layout="inline" />}
          <TooltipIconButton tooltip="Reload settings" onClick={() => void load()}>
            <RefreshCw />
          </TooltipIconButton>
        </div>
      </div>

      {error && !needsProject && (
        <div className="m-3 flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Could not read settings for this project.</p>
            <p className="mt-0.5 font-mono text-xs leading-4 break-words opacity-90">{error}</p>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {needsProject ? (
          <Empty
            title="No project selected"
            body="Pi keeps settings per project as well as globally, so piorbit needs to know which project you mean. Pick one in the rail, or add a directory. Appearance, Keyboard, Trust and This device do not need one."
          />
        ) : (
          <>
            {tab === "settings" && catalog && snapshot && (
              <SettingsForm catalog={catalog} snapshot={snapshot} onApply={apply} />
            )}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "packages" && cwd && <PackagesTab cwd={cwd} snapshot={snapshot} onSettingsChanged={load} />}
            {tab === "models" && cwd && <ModelsTab cwd={cwd} snapshot={snapshot} onApply={apply} />}
            {tab === "keyboard" && <KeyboardTab />}
            {tab === "trust" && <TrustTab />}
            {tab === "device" && <DeviceTab />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Settings that belong to this browser rather than to a project. Today that is
 * notifications; anything else per-device lands here rather than growing a
 * fourth place to look.
 */
function DeviceTab() {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-160 flex-col gap-6 px-6 py-6">
        <NotificationsSetting />
      </div>
    </ScrollArea>
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
          "placeholder:text-ink-3 outline-none transition-[border-color] duration-(--motion-instant)",
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
