"use client";
/**
 * Settings (M4-T2, M4-T3, M4-T4).
 *
 * Laser-owned settings behind one header. Engine plumbing is intentionally
 * absent; specialist product controls live in Advanced and bundled
 * capabilities live in Features.
 *
 * The first three are per project, because Pi's settings are per project: the
 * scope switch is not decoration, it decides which of the two files a change
 * lands in. "This device" is the exception and says so — a notification
 * permission belongs to the browser on this phone or laptop, not to a project,
 * and pretending otherwise would put a per-device switch behind a project
 * scope that has nothing to do with it.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Search, Sparkles } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { useWorkbench } from "@/components/workbench";
import { rememberStep, requestSetupAgain } from "@/components/onboarding";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type { SettingsCatalog, SettingsScope, SettingsSnapshot } from "@lasercode/protocol";

import { NotificationsSetting } from "@/components/mobile";

import { AppearanceTab } from "./appearance/AppearanceTab.js";
import { KeyboardTab } from "./KeyboardTab.js";
import { McpServersTab } from "./mcp/McpServersTab.js";
import { ModelsTab } from "./ModelsTab.js";
import { FeaturesScreen } from "./FeaturesScreen.js";
import { SettingsForm } from "./SettingsForm.js";
import { TrustTab } from "./TrustTab.js";
import { UsageTab } from "./UsageTab.js";

type Tab = "general" | "advanced" | "appearance" | "features" | "mcp" | "models" | "usage" | "keyboard" | "trust" | "device";

/**
 * `PROJECTLESS` lists tabs that do not require a selected project, keeping
 * appearance, shortcuts, account usage and browser permissions reachable
 * before a project is chosen.
 */
const PROJECTLESS: readonly Tab[] = ["appearance", "keyboard", "trust", "device", "usage"];

/**
 * Extensions "for every project" and the provider/model settings are global —
 * they are only *routed* by directory, because every settings method is. So
 * before a project exists they go through the directory the host keeps for
 * exactly that purpose (`pi/setup/state`, the same one the first-run flow
 * uses). Without this, the person most likely to want them — someone who has
 * just installed laser and has no project yet — is the one person who
 * cannot reach them.
 */
const GLOBAL_THROUGH_SETUP: readonly Tab[] = ["general", "advanced", "features", "mcp", "models"];

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "general", label: "General" },
  { id: "advanced", label: "Advanced" },
  { id: "appearance", label: "Appearance" },
  { id: "features", label: "Features" },
  { id: "mcp", label: "MCP servers" },
  { id: "models", label: "Providers and models" },
  { id: "usage", label: "Usage" },
  { id: "keyboard", label: "Help and shortcuts" },
  { id: "trust", label: "Trust" },
  { id: "device", label: "This device" },
];

export function SettingsScreen({ cwd: project, initialTab }: { cwd: string | undefined; initialTab?: Tab | undefined }) {
  const { client, actions } = useLaserStable();
  // `initialTab` is only ever set by something that already knows the fix — a
  // rejected credential sending the person straight to Providers and models.
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  const [setupCwd, setSetupCwd] = useState<string>();
  const [catalog, setCatalog] = useState<SettingsCatalog>();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [snapshotCwd, setSnapshotCwd] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  // The host's project-less directory, fetched once and only when it is needed.
  useEffect(() => {
    if (project || setupCwd) return;
    let cancelled = false;
    void client
      .request("pi/setup/state", {})
      .then((state) => {
        if (!cancelled) setSetupCwd(state.cwd);
      })
      .catch(() => {
        // An older host has no setup state; the tabs then say a project is needed.
      });
    return () => {
      cancelled = true;
    };
  }, [client, project, setupCwd]);

  const cwd = tab === "usage" ? undefined : project ?? (GLOBAL_THROUGH_SETUP.includes(tab) ? setupCwd : undefined);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const load = useCallback(async () => {
    if (!cwd) return;
    if (snapshotCwd !== cwd) {
      setSnapshotCwd(undefined);
    }
    setLoading(true);
    setError(undefined);
    try {
      // The catalogue is fixed per pinned Pi, so it is fetched once per project
      // open; the snapshot is what changes.
      const [cat, snap] = await Promise.all([
        catalog ? Promise.resolve({ catalog }) : client.request("pi/settings/list", { cwd }),
        client.request("pi/settings/get", { cwd }),
      ]);
      if (cwdRef.current !== cwd) return;
      setCatalog(cat.catalog);
      setSnapshot(snap.snapshot);
      setSnapshotCwd(cwd);
    } catch (loadError) {
      if (cwdRef.current === cwd) {
        setSnapshot(undefined);
        setSnapshotCwd(undefined);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (cwdRef.current === cwd) setLoading(false);
    }
  }, [client, cwd, catalog, snapshotCwd]);

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
        setSnapshotCwd(cwd);
        return true;
      } catch (writeError) {
        actions.toast("error", writeError instanceof Error ? writeError.message : String(writeError));
        return false;
      }
    },
    [client, cwd, actions],
  );

  // "No project" is a state of one tab, not of the screen: the tab strip has
  // to stay on screen or Appearance, Help and shortcuts, Trust and This device become
  // unreachable on a machine with no project yet — which is every first run.
  const needsProject = !cwd && !PROJECTLESS.includes(tab);
  const switchingProject = Boolean(cwd && snapshot && snapshotCwd !== cwd);

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
        {tab !== "usage" && <div className="ms-auto flex items-center gap-2">
          {loading && <GenerationLoader label="Loading settings" layout="inline" />}
          <TooltipIconButton tooltip="Reload settings" onClick={() => void load()}>
            <RefreshCw />
          </TooltipIconButton>
        </div>}
      </div>

      {error && !needsProject && tab !== "usage" && (
        <div className="m-3 flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Could not read settings for this project.</p>
            <p className="mt-0.5 font-mono text-xs leading-4 break-words opacity-90">{error}</p>
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div className="h-full" inert={switchingProject ? true : undefined}>
        {needsProject ? (
          <Empty
            title="Open a project first"
            body={`These settings can be overridden per project, so ${PRODUCT_NAME} needs to know which project you mean. Pick one in the rail, or add one. Features, Providers and models, Appearance, Help and shortcuts, Trust and This device all work without one.`}
          />
        ) : (
          <>
            {(tab === "general" || tab === "advanced") && cwd && catalog && snapshot && (
              <SettingsForm audience={tab} cwd={cwd} catalog={catalog} snapshot={snapshot} onApply={apply} />
            )}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "features" && <FeaturesScreen {...(cwd ? { cwd } : {})} onManageServers={() => setTab("mcp")} />}
            {/* Without a project this is the every-project list; the project
                filter simply has nothing to show. */}
            {tab === "mcp" && cwd && <McpServersTab cwd={cwd} projectOpen={Boolean(project)} />}
            {tab === "models" && cwd && <ModelsTab cwd={cwd} snapshot={snapshot} onApply={apply} />}
            {tab === "usage" && <UsageTab />}
            {tab === "keyboard" && <KeyboardTab cwd={cwd} />}
            {tab === "trust" && <TrustTab />}
            {tab === "device" && <DeviceTab />}
          </>
        )}
        </div>
        {switchingProject && (
          <div className="absolute inset-0 z-20 flex items-start justify-center bg-bg pt-16" aria-live="polite">
            <GenerationLoader label="Loading the selected project’s settings" layout="block" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Settings that belong to this browser rather than to a project: notifications,
 * and the way back into first-run setup.
 */
export function DeviceTab() {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-160 flex-col gap-6 px-6 py-6">
        <NotificationsSetting />
        <RunSetupAgain />
      </div>
    </ScrollArea>
  );
}

/**
 * The way back in. "Skip setup" on the welcome screen used to be permanent —
 * the flow is gated on one flag on the host and nothing in the app ever
 * cleared it — so one mis-click meant a new person never saw the onboarding
 * again.
 *
 * Pressing this starts setup **now**. It used to clear the host's flag and say
 * setup would run "the next time" the app opened with no session, which was
 * two promises the app did not keep: the shell holds its own copy of the
 * host's answer and never re-read it, and a reload reopens the remembered
 * session, so "no session open" never came around. The button now clears the
 * flag, forgets the step the flow last stopped on (a fresh run, not a resume)
 * and hands the request to the shell, which owns the flow.
 */
function RunSetupAgain() {
  const { client, actions } = useLaserStable();
  const workbench = useWorkbench();
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      await client.request("pi/setup/complete", { completed: false });
      rememberStep(undefined);
      requestSetupAgain();
      workbench.close();
    } catch (error) {
      actions.toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section data-slot="run-setup-again" aria-labelledby="setup-again-title" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden="true" className="size-4 text-ink-3" />
        <h3 id="setup-again-title" className="text-base font-medium text-ink">
          Setup
        </h3>
      </div>
      <p className="text-sm leading-6 text-ink-2">
        The steps you saw the first time {PRODUCT_NAME} opened: connect a provider, choose a model, open a project. They start
        straight away and take over the window; the session you are reading stays in the sidebar. Nothing is undone by running
        them again — anything already set up is skipped.
      </p>
      <div>
        {/* A button, not a line of text: this is the only way back to first run,
            and a ghost control on a page of prose reads as a caption. */}
        <Button type="button" size="sm" variant="secondary" disabled={running} onClick={() => void run()}>
          Run setup again
        </Button>
      </div>
    </section>
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
  if (origin === "default") return <Badge variant="default">default</Badge>;
  return <Badge variant="outline">not set</Badge>;
}
