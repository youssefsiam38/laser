"use client";

import type { SettingChange, SettingsCatalog, SettingsScope, SettingsSnapshot } from "@lasercode/protocol";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCapability } from "@/runtime";
import { CapabilityGate } from "@/components/capability-gate";

import { SettingsForm } from "./SettingsForm.js";
import { ResourceDiagnostics } from "./resources/ResourceDiagnostics.js";

export type AdvancedView = "resources" | "configuration";

export interface AdvancedTabProps {
  view: AdvancedView;
  onViewChange: (view: AdvancedView) => void;
  cwd?: string | undefined;
  catalog?: SettingsCatalog | undefined;
  snapshot?: SettingsSnapshot | undefined;
  loading: boolean;
  error?: string | undefined;
  onReload: () => void;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}

/** Machine-wide resource truth beside, but never confused with, project-scoped engine configuration. */
export function AdvancedTab({ view, onViewChange, cwd, catalog, snapshot, loading, error, onReload, onApply }: AdvancedTabProps) {
  const resources = useCapability("resource/snapshot", { capabilities: ["diagnostics"] });
  const configuration = useCapability("pi/settings/get");
  const shownView = view === "resources" && resources.state !== "available" ? "configuration"
    : view === "configuration" && configuration.state !== "available" ? "resources"
    : view;
  const configured = Boolean(cwd && catalog && snapshot);
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 px-3 py-2 hairline-b" role="tablist" aria-label="Advanced settings sections">
      {resources.state === "available" ? <Button
        type="button"
        role="tab"
        aria-selected={shownView === "resources"}
        aria-controls="advanced-resources"
        variant="ghost"
        size="sm"
        onClick={() => onViewChange("resources")}
        className={cn("pointer-coarse:min-h-11", shownView === "resources" && "bg-surface-2 text-ink")}
      >
        Resources
      </Button> : null}
      {configuration.state === "available" ? <Button
        type="button"
        role="tab"
        aria-selected={shownView === "configuration"}
        aria-controls="advanced-configuration"
        variant="ghost"
        size="sm"
        onClick={() => onViewChange("configuration")}
        className={cn("pointer-coarse:min-h-11", shownView === "configuration" && "bg-surface-2 text-ink")}
      >
        Configuration
      </Button> : null}
    </div>

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
          <h2 className="text-base font-semibold text-ink">Configuration needs a project</h2>
          <p className="mt-1 text-sm leading-6 text-ink-2">
            Resource diagnostics remain available without one. Open a project to inspect global, project and effective specialist configuration.
          </p>
        </div>
      ) : null}
      {!error && cwd && catalog && snapshot ? (
        <CapabilityGate method="pi/settings/set">
          <SettingsForm audience="advanced" cwd={cwd} catalog={catalog} snapshot={snapshot} onApply={onApply} />
        </CapabilityGate>
      ) : null}
    </div>
  </div>;
}
