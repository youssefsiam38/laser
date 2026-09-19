"use client";

import type { SettingChange, SettingsCatalog, SettingsScope, SettingsSnapshot } from "@lasercode/protocol";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Tabs } from "@/components/ui/tabs";
import { useCapability, type SettingsScopeView } from "@/runtime";
import { CapabilityNotice } from "@/components/capability-gate";

import { SettingsForm } from "./SettingsForm.js";
import { ResourceDiagnostics } from "./resources/ResourceDiagnostics.js";

export type AdvancedView = "resources" | "configuration";

export interface AdvancedTabProps {
  view: AdvancedView;
  onViewChange: (view: AdvancedView) => void;
  scopeView: SettingsScopeView;
  cwd?: string | undefined;
  catalog?: SettingsCatalog | undefined;
  snapshot?: SettingsSnapshot | undefined;
  loading: boolean;
  error?: string | undefined;
  onReload: () => void;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}

/** Machine-wide resource truth beside, but never confused with, project-scoped engine configuration. */
export function AdvancedTab({ view, onViewChange, scopeView, cwd, catalog, snapshot, loading, error, onReload, onApply }: AdvancedTabProps) {
  const resources = useCapability("resource/snapshot");
  const configuration = useCapability("pi/settings/get");
  const settingsWrite = useCapability("pi/settings/set", { presentation: "explained" });
  let shownView = view;
  if (shownView === "resources" && resources.state !== "available") shownView = "configuration";
  if (shownView === "configuration" && configuration.state !== "available") shownView = "resources";
  const configured = Boolean(cwd && catalog && snapshot);
  return <div className="flex h-full min-h-0 flex-col">
    {/* The shared strip (`components/ui/tabs.tsx`): the product's one idiom,
        and the roving tabindex these two sections never had. */}
    <Tabs
      label="Advanced settings sections"
      value={shownView}
      onChange={onViewChange}
      className="shrink-0 px-3 pt-2"
      options={[
        ...(resources.state === "available"
          ? [{ value: "resources" as const, label: "Resources", controls: "advanced-resources" }]
          : []),
        ...(configuration.state === "available"
          ? [{ value: "configuration" as const, label: "Configuration", controls: "advanced-configuration" }]
          : []),
      ]}
    />

    <div id="advanced-resources" role="tabpanel" aria-label="Resources" className="min-h-0 flex-1" hidden={shownView !== "resources"}>
      {shownView === "resources" ? <ResourceDiagnostics /> : null}
    </div>

    <div
      id="advanced-configuration"
      role="tabpanel"
      aria-label="Configuration"
      className="min-h-0 flex-1"
      hidden={shownView !== "configuration"}
      inert={shownView !== "configuration" ? true : undefined}
    >
      {error ? (
        <div className="mx-auto max-w-160 px-6 py-6">
          <ErrorState title="Could not read advanced configuration" detail={error} onRetry={onReload} />
        </div>
      ) : null}
      {!error && loading && !configured ? (
        <div className="flex h-full items-start justify-center pt-16">
          <GenerationLoader label="Loading advanced configuration" layout="block" />
        </div>
      ) : null}
      {!error && !loading && !cwd ? (
        <div className="mx-auto max-w-120 px-6 py-16 text-center">
          <h2 className="text-base font-semibold text-ink">Configuration target unavailable</h2>
          <p className="mt-1 text-sm leading-6 text-ink-2">
            Resource diagnostics remain available. Choose an explicit Settings project above, or switch to Global configuration.
          </p>
        </div>
      ) : null}
      {!error && cwd && catalog && snapshot ? (
        <>
          {settingsWrite.state === "explained" ? <div className="p-4 pb-0"><CapabilityNotice explanation={settingsWrite.explanation} /></div> : null}
          <SettingsForm audience="advanced" view={scopeView} cwd={cwd} catalog={catalog} snapshot={snapshot} decision={settingsWrite} onApply={onApply} />
        </>
      ) : null}
    </div>
  </div>;
}
