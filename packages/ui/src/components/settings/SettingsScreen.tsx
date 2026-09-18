"use client";
/** Settings, with one explicit scope shared by migrated surfaces. */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Search, Sparkles } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { useWorkbench } from "@/components/workbench";
import { SettingsScopeControls } from "@/components/workbench/SettingsScopeControls";
import { rememberStep, requestSetupAgain } from "@/components/onboarding";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useCapability, useLaserStable } from "@/runtime";
import { CapabilityNotice } from "@/components/capability-gate";
import type { SettingsCatalog, SettingsScope, SettingsSnapshot } from "@lasercode/protocol";

import { NotificationsSetting } from "@/components/mobile";

import { AppearanceTab } from "./appearance/AppearanceTab.js";
import { KeyboardTab } from "./KeyboardTab.js";
import { McpServersTab } from "./mcp/McpServersTab.js";
import { ModelsTab } from "./ModelsTab.js";
import { FeaturesScreen } from "./FeaturesScreen.js";
import { SettingsForm } from "./SettingsForm.js";
import { TrustTab } from "./TrustTab.js";
import { ProjectsTab } from "./ProjectsTab.js";
import { DeviceCacheSetting } from "./DeviceCacheSetting.js";
import { LogStoreSetting } from "./LogStoreSetting.js";
import { UsageTab } from "./UsageTab.js";
import { AdvancedTab, type AdvancedView } from "./AdvancedTab.js";

type Tab = "general" | "advanced" | "appearance" | "features" | "mcp" | "models" | "usage" | "keyboard" | "projects" | "trust" | "device";

type TabRoute = "scope" | "legacy" | "none";
type NeutralRouteUse = "global-scope" | "legacy-fallback" | "feature-write" | "none";
interface TabPolicy {
  route: TabRoute;
  settingsData: boolean;
  scopeControls: boolean;
  neutralRoute: NeutralRouteUse;
  needsProject: boolean;
}

const NO_ROUTE: TabPolicy = {
  route: "none",
  settingsData: false,
  scopeControls: false,
  neutralRoute: "none",
  needsProject: false,
};

// Stage one migrates General, Advanced Configuration and Features. Legacy
// routes remain explicit here so each later migration is one policy change,
// not another ambient-project fallback hidden in render logic.
const TAB_POLICY: Record<Exclude<Tab, "advanced">, TabPolicy> = {
  general: { route: "scope", settingsData: true, scopeControls: true, neutralRoute: "global-scope", needsProject: false },
  appearance: NO_ROUTE,
  features: { route: "none", settingsData: false, scopeControls: true, neutralRoute: "feature-write", needsProject: false },
  mcp: { route: "legacy", settingsData: false, scopeControls: false, neutralRoute: "legacy-fallback", needsProject: true },
  models: { route: "legacy", settingsData: true, scopeControls: false, neutralRoute: "legacy-fallback", needsProject: true },
  usage: NO_ROUTE,
  keyboard: { route: "legacy", settingsData: false, scopeControls: false, neutralRoute: "none", needsProject: false },
  projects: NO_ROUTE,
  trust: NO_ROUTE,
  device: NO_ROUTE,
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "general", label: "General" },
  { id: "advanced", label: "Advanced" },
  { id: "appearance", label: "Appearance" },
  { id: "features", label: "Features" },
  { id: "mcp", label: "MCP servers" },
  { id: "models", label: "Providers and models" },
  { id: "usage", label: "Usage" },
  { id: "keyboard", label: "Help and shortcuts" },
  { id: "projects", label: "Projects" },
  { id: "trust", label: "Trust" },
  { id: "device", label: "This device" },
];

export interface SettingsScreenProps {
  /** Ambient app project retained only for not-yet-migrated Settings tabs. */
  ambientCwd?: string | undefined;
  initialTab?: Tab | undefined;
}

export function SettingsScreen({ ambientCwd, initialTab }: SettingsScreenProps) {
  const { client, actions, projects } = useLaserStable();
  const { settingsScope } = useWorkbench();
  const settingsRead = useCapability("pi/settings/get");
  const settingsWrite = useCapability("pi/settings/set", { presentation: "explained" });
  const featureWrite = useCapability("feature/set", { presentation: "explained" });
  const mcpWrite = useCapability("mcp/save", { presentation: "explained" });
  const keybindingsWrite = useCapability("pi/keybindings/set", { presentation: "explained" });
  const trustWrite = useCapability("pi/project/trust", { presentation: "explained" });
  const features = useCapability("feature/list");
  const mcp = useCapability("mcp/list");
  const providers = useCapability("pi/providers/list");
  const usage = useCapability("pi/account-usage/refresh");
  const projectsCapability = useCapability("pi/project/list");
  const diagnostics = useCapability("resource/snapshot");
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  const [neutralRouteCwd, setNeutralRouteCwd] = useState<string>();
  const [neutralRouteLoading, setNeutralRouteLoading] = useState(false);
  const [neutralRouteError, setNeutralRouteError] = useState<string>();
  const [neutralRouteRetry, setNeutralRouteRetry] = useState(0);
  const [catalog, setCatalog] = useState<SettingsCatalog>();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [snapshotKey, setSnapshotKey] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [advancedView, setAdvancedView] = useState<AdvancedView>("resources");
  const loadGeneration = useRef(0);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const visibleTabs = TABS.filter((entry) => {
    if (entry.id === "general") return settingsRead.state === "available";
    if (entry.id === "features") return features.state === "available";
    if (entry.id === "mcp") return mcp.state === "available";
    if (entry.id === "models") return providers.state === "available";
    if (entry.id === "usage") return usage.state === "available";
    if (entry.id === "advanced") return settingsRead.state === "available" || diagnostics.state === "available";
    if (entry.id === "projects" || entry.id === "trust") return projectsCapability.state === "available";
    return true;
  });
  const shownTab = visibleTabs.some((entry) => entry.id === tab) ? tab : (visibleTabs[0]?.id ?? "general");

  const tabStrip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabStrip.current;
    if (!strip) return;
    const reveal = () => strip.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
      block: "nearest", inline: "nearest", behavior: "auto",
    });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [shownTab]);

  const resolvedAdvancedView: AdvancedView = advancedView === "resources" && diagnostics.state !== "available"
    ? "configuration"
    : advancedView === "configuration" && settingsRead.state !== "available"
      ? "resources"
      : advancedView;
  const policy: TabPolicy = shownTab === "advanced"
    ? resolvedAdvancedView === "configuration"
      ? { route: "scope", settingsData: true, scopeControls: true, neutralRoute: "global-scope", needsProject: false }
      : NO_ROUTE
    : TAB_POLICY[shownTab];

  const selectedProjectKnown = settingsScope.projectCwd !== undefined && projects.includes(settingsScope.projectCwd);
  const explicitProjectCwd = selectedProjectKnown ? settingsScope.projectCwd : undefined;
  const scopedCwd = settingsScope.view === "global" ? neutralRouteCwd : explicitProjectCwd;
  const routeCwd = policy.route === "scope"
    ? scopedCwd
    : policy.route === "legacy"
      ? ambientCwd ?? neutralRouteCwd
      : undefined;
  const settingsCwd = policy.settingsData ? routeCwd : undefined;
  const currentLoadKey = policy.settingsData && settingsCwd
    ? `${policy.route === "scope" ? `scope:${settingsScope.view}` : "legacy"}:${settingsCwd}`
    : "";
  const needsNeutralRoute = policy.neutralRoute === "global-scope"
    ? settingsScope.view === "global"
    : policy.neutralRoute === "legacy-fallback"
      ? !ambientCwd
      : policy.neutralRoute === "feature-write"
        ? settingsScope.view === "global" && featureWrite.state === "available"
        : false;

  // This route is worker plumbing, never the Settings target. Fetch it only
  // while the active tab has a capability that can use it.
  useEffect(() => {
    if (!needsNeutralRoute || neutralRouteCwd) {
      setNeutralRouteLoading(false);
      return undefined;
    }
    let live = true;
    setNeutralRouteLoading(true);
    setNeutralRouteError(undefined);
    void client.request("pi/setup/state", {}).then((state) => {
      if (live) setNeutralRouteCwd(state.cwd);
    }).catch((routeError) => {
      if (live) setNeutralRouteError(routeError instanceof Error ? routeError.message : String(routeError));
    }).finally(() => {
      if (live) setNeutralRouteLoading(false);
    });
    return () => { live = false; };
  }, [client, needsNeutralRoute, neutralRouteCwd, neutralRouteRetry]);

  const load = useCallback(async () => {
    if (!policy.settingsData || !settingsCwd || settingsRead.state !== "available") return;
    const key = currentLoadKey;
    const generation = ++loadGeneration.current;
    if (snapshotKey !== key) setSnapshotKey(undefined);
    setLoading(true);
    setError(undefined);
    try {
      const [cat, snap] = await Promise.all([
        catalog ? Promise.resolve({ catalog }) : client.request("pi/settings/list", { cwd: settingsCwd }),
        client.request("pi/settings/get", { cwd: settingsCwd }),
      ]);
      if (generation !== loadGeneration.current) return;
      setCatalog(cat.catalog);
      setSnapshot(snap.snapshot);
      setSnapshotKey(key);
    } catch (loadError) {
      if (generation === loadGeneration.current) {
        setSnapshot(undefined);
        setSnapshotKey(undefined);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [catalog, client, currentLoadKey, policy.settingsData, settingsCwd, settingsRead.state, snapshotKey]);

  // Invalidate the old target during commit, before a stale promise can settle
  // in the render-to-effect gap. Abandoned renders never mutate the fence.
  useLayoutEffect(() => {
    loadGeneration.current += 1;
    if (!currentLoadKey) {
      setLoading(false);
      setError(undefined);
      setSnapshotKey(undefined);
      return;
    }
    void load();
    // `load` changes when catalogue/snapshot state arrives; the target key is
    // the only input that should start a fresh request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLoadKey]);

  const apply = useCallback(async (
    scope: SettingsScope,
    changes: Parameters<typeof client.request<"pi/settings/set">>[1]["changes"],
  ) => {
    if (!settingsCwd) return false;
    if (policy.route === "scope") {
      if (settingsScope.view === "effective") return false;
      const expected: SettingsScope = settingsScope.view === "project" ? "project" : "global";
      if (scope !== expected) return false;
    }
    const key = currentLoadKey;
    const generation = loadGeneration.current;
    try {
      const { snapshot: next } = await client.request("pi/settings/set", { cwd: settingsCwd, scope, changes });
      if (generation === loadGeneration.current) {
        setSnapshot(next);
        setSnapshotKey(key);
      }
      return true;
    } catch (writeError) {
      actions.toast("error", writeError instanceof Error ? writeError.message : String(writeError));
      return false;
    }
  }, [actions, client, currentLoadKey, policy.route, settingsCwd, settingsScope.view]);

  const retryNeutralRoute = useCallback(() => {
    setNeutralRouteCwd(undefined);
    setNeutralRouteError(undefined);
    setNeutralRouteRetry((value) => value + 1);
  }, []);
  const reload = useCallback(() => {
    if (needsNeutralRoute && !neutralRouteCwd) {
      retryNeutralRoute();
      return;
    }
    void load();
  }, [load, needsNeutralRoute, neutralRouteCwd, retryNeutralRoute]);

  const explicitScopeMissing = policy.scopeControls
    && settingsScope.view !== "global"
    && !selectedProjectKnown;
  const legacyNeedsProject = policy.needsProject && !routeCwd && !neutralRouteLoading && !neutralRouteError;
  const neutralRoutePending = needsNeutralRoute
    && policy.neutralRoute !== "feature-write"
    && !routeCwd
    && !neutralRouteError;
  const neutralRouteFailure = needsNeutralRoute
    && policy.neutralRoute !== "feature-write"
    && !routeCwd
    ? neutralRouteError
    : undefined;
  const switchingTarget = Boolean(
    currentLoadKey
    && snapshot
    && snapshotKey !== currentLoadKey
    && policy.route === "scope",
  );

  const scopeEmpty = explicitScopeMissing
    ? settingsScope.projectCwd
      ? {
          title: "This project is unavailable",
          body: "The selected project is no longer in this environment. Choose another project above. Nothing will be read or written until you do.",
        }
      : {
          title: `Choose a project for ${settingsScope.view === "effective" ? "Effective" : "Project"} settings`,
          body: "Use the project picker above. Settings never borrow the project open in Code or choose the first project for you.",
        }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 hairline-b">
        <div ref={tabStrip} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {visibleTabs.map((entry) => (
            <Button
              key={entry.id}
              variant="ghost"
              size="sm"
              onClick={() => setTab(entry.id)}
              aria-current={shownTab === entry.id ? "page" : undefined}
              className={cn("shrink-0", shownTab === entry.id && "bg-surface-2 text-ink")}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        {policy.settingsData && settingsRead.state === "available" ? (
          <div className="ms-auto flex items-center gap-2">
            {loading || neutralRouteLoading ? <GenerationLoader label="Loading settings" layout="inline" /> : null}
            <TooltipIconButton tooltip={neutralRouteFailure ? "Retry global settings" : "Reload settings"} onClick={reload}>
              <RefreshCw />
            </TooltipIconButton>
          </div>
        ) : null}
      </div>

      {policy.scopeControls ? (
        <div className="flex shrink-0 items-center px-3 py-2 hairline-b">
          <SettingsScopeControls />
        </div>
      ) : null}

      {error && !explicitScopeMissing && shownTab !== "advanced" && shownTab !== "usage" && shownTab !== "projects" ? (
        <div className="m-3 flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Could not read settings for this target.</p>
            <p className="mt-0.5 font-mono text-xs leading-4 break-words opacity-90">{error}</p>
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div className="h-full" inert={switchingTarget ? true : undefined}>
          {scopeEmpty ? (
            <Empty title={scopeEmpty.title} body={scopeEmpty.body} />
          ) : neutralRoutePending ? (
            <div className="flex h-full items-start justify-center pt-16">
              <GenerationLoader label="Preparing global settings" layout="block" />
            </div>
          ) : neutralRouteFailure ? (
            <div className="mx-auto max-w-160 px-6 py-6">
              <ErrorState
                title={policy.route === "scope" ? "Could not prepare Global settings" : "Could not prepare this Settings tab"}
                detail={neutralRouteFailure}
                onRetry={retryNeutralRoute}
              />
            </div>
          ) : legacyNeedsProject ? (
            <Empty
              title="Open a project first"
              body={`This tab has not moved to the explicit Settings target yet. Pick a project in the rail, or add one. General, Features, Appearance, Help and shortcuts, Trust and This device remain available without one.`}
            />
          ) : (
            <>
              {shownTab === "general" && settingsCwd && catalog && snapshot && snapshotKey === currentLoadKey ? (
                <>
                  {settingsWrite.state === "explained" ? <div className="p-4 pb-0"><CapabilityNotice explanation={settingsWrite.explanation} /></div> : null}
                  <SettingsForm audience="general" view={settingsScope.view} cwd={settingsCwd} catalog={catalog} snapshot={snapshot} decision={settingsWrite} onApply={apply} />
                </>
              ) : null}
              {shownTab === "advanced" ? (
                <AdvancedTab
                  view={advancedView}
                  onViewChange={setAdvancedView}
                  scopeView={settingsScope.view}
                  {...(settingsCwd ? { cwd: settingsCwd } : {})}
                  {...(catalog ? { catalog } : {})}
                  {...(snapshot && snapshotKey === currentLoadKey ? { snapshot } : {})}
                  loading={loading}
                  {...(error ? { error } : {})}
                  onReload={reload}
                  onApply={apply}
                />
              ) : null}
              {shownTab === "appearance" ? <AppearanceTab /> : null}
              {shownTab === "features" ? (
                <FeaturesScreen
                  view={settingsScope.view}
                  {...(explicitProjectCwd ? { projectCwd: explicitProjectCwd } : {})}
                  {...(neutralRouteCwd ? { neutralRouteCwd } : {})}
                  decision={featureWrite}
                  {...(mcp.state === "available" ? { onManageServers: () => setTab("mcp") } : {})}
                />
              ) : null}
              {shownTab === "mcp" && routeCwd ? <McpServersTab cwd={routeCwd} projectOpen={Boolean(ambientCwd)} decision={mcpWrite} /> : null}
              {shownTab === "models" && settingsCwd ? <ModelsTab cwd={settingsCwd} snapshot={snapshotKey === currentLoadKey ? snapshot : undefined} onApply={apply} /> : null}
              {shownTab === "usage" ? <UsageTab /> : null}
              {shownTab === "keyboard" ? <KeyboardTab cwd={routeCwd} decision={keybindingsWrite} /> : null}
              {shownTab === "projects" ? <ProjectsTab activeCwd={ambientCwd} /> : null}
              {shownTab === "trust" ? <TrustTab decision={trustWrite} /> : null}
              {shownTab === "device" ? <DeviceTab /> : null}
            </>
          )}
        </div>
        {switchingTarget ? (
          <div className="absolute inset-0 z-20 flex items-start justify-center bg-bg pt-16" aria-live="polite">
            <GenerationLoader label="Loading the selected settings target" layout="block" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Settings that belong to this device or host installation, never a project. */
export function DeviceTab() {
  const push = useCapability("pi/push/config");
  const logs = useCapability("pi/logs/stats");
  const setup = useCapability("pi/setup/complete");
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-160 flex-col gap-6 px-6 py-6">
        {push.state === "available" ? <NotificationsSetting /> : null}
        <DeviceCacheSetting />
        {logs.state === "available" ? <LogStoreSetting /> : null}
        {setup.state === "available" ? <RunSetupAgain /> : null}
      </div>
    </ScrollArea>
  );
}

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
        <h3 id="setup-again-title" className="text-base font-medium text-ink">Setup</h3>
      </div>
      <p className="text-sm leading-6 text-ink-2">
        The steps you saw the first time {PRODUCT_NAME} opened: connect a provider, choose a model, open a project. They start
        straight away and take over the window; the session you are reading stays in the sidebar. Nothing is undone by running
        them again — anything already set up is skipped.
      </p>
      <div>
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
