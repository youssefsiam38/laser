"use client";

import { PRODUCT_DISPLAY_NAME, type FeatureScope, type FeatureState } from "@lasercode/protocol";
import { Bot, Check, CircleDot, Globe, Plug, RotateCw, Target } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

export function FeaturesScreen({ cwd, onManageServers }: { cwd?: string; onManageServers?: () => void }) {
  const { client, actions } = useLaserStable();
  const [features, setFeatures] = useState<FeatureState[]>([]);
  const [scope, setScope] = useState<FeatureScope>("global");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFeatures((await client.request("feature/list", { ...(cwd ? { cwd } : {}) })).features);
    } catch (error) {
      actions.toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [actions, client, cwd]);

  useEffect(() => { void load(); }, [load]);

  const change = async (feature: FeatureState, enabled: boolean | null) => {
    setBusy(feature.manifest.id);
    try {
      const result = await client.request("feature/set", {
        id: feature.manifest.id,
        enabled,
        scope,
        ...(cwd ? { cwd } : {}),
      });
      setFeatures(result.features);
      actions.toast(
        result.restartPending ? "warning" : "info",
        result.restartPending
          ? `${feature.manifest.name} will change when the current session finishes and its project restarts.`
          : enabled === null
            ? `${feature.manifest.name} now follows your every-project choice.`
            : `${feature.manifest.name} is ${enabled ? "enabled" : "disabled"}.`,
      );
    } catch (error) {
      actions.toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-4 py-5 md:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-140">
            <p className="eyebrow text-live">Capabilities</p>
            <h2 className="mt-1 text-lg font-semibold text-ink">Features built into {PRODUCT_DISPLAY_NAME}</h2>
            <p className="mt-1 text-sm leading-6 text-ink-2">
              Turn on what you want {PRODUCT_DISPLAY_NAME} to do. Every feature ships with the app and stays on the tested version.
            </p>
          </div>
          <div role="tablist" aria-label="Feature scope" className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            <ScopeButton active={scope === "global"} onClick={() => setScope("global")}>Every project</ScopeButton>
            <ScopeButton active={scope === "project"} disabled={!cwd} onClick={() => setScope("project")}>This project</ScopeButton>
          </div>
        </header>

        {loading ? (
          <GenerationLoader label="Loading features" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {features.map((feature) => {
              const Icon =
                feature.manifest.id === "goals"
                  ? Target
                  : feature.manifest.id === "web-search"
                    ? Globe
                    : feature.manifest.id === "mcp"
                      ? Plug
                      : Bot;
              const changing = busy === feature.manifest.id;
              const selected = scope === "global" ? feature.globalEnabled : feature.projectEnabled ?? feature.globalEnabled;
              return (
                <article key={feature.manifest.id} className="group flex min-h-56 flex-col rounded-xl border border-line bg-surface p-4 transition-colors duration-(--motion-fast) hover:border-line-strong">
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid size-10 place-items-center rounded-lg bg-[color-mix(in_oklab,var(--live)_12%,var(--surface))] text-live">
                      <Icon className="size-5" aria-hidden="true" />
                    </div>
                    <Toggle
                      variant="outline"
                      pressed={selected}
                      disabled={changing || (scope === "project" && !cwd)}
                      onPressedChange={(pressed) => void change(feature, pressed)}
                      aria-label={`${selected ? "Disable" : "Enable"} ${feature.manifest.name}`}
                      className="min-w-20"
                    >
                      {changing ? <RotateCw className="motion-safe:animate-busy" /> : selected ? <Check /> : <CircleDot />}
                      {selected ? "On" : "Off"}
                    </Toggle>
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-ink">{feature.manifest.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-ink-2">{feature.manifest.description}</p>
                  <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
                    {feature.manifest.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline" className="capitalize">{capability.replaceAll("-", " ")}</Badge>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-ink-3">
                    {scope === "global"
                      ? feature.globalSource === "default" ? `${PRODUCT_DISPLAY_NAME} default` : "Your every-project choice"
                      : feature.projectEnabled !== undefined ? "Overridden for this project" : "Follows every-project choice"}
                    {feature.manifest.restart === "worker" ? " · Changing this restarts the affected project" : ""}
                  </p>
                  {feature.manifest.id === "mcp" && onManageServers && (
                    <Button type="button" variant="link" size="sm" className="mt-2 h-auto self-start p-0 text-xs" onClick={onManageServers}>
                      Manage servers
                    </Button>
                  )}
                  {scope === "project" && feature.projectEnabled !== undefined && (
                    <Button type="button" variant="link" size="sm" className="mt-2 h-auto self-start p-0 text-xs" disabled={changing} onClick={() => void change(feature, null)}>
                      Use every-project choice
                    </Button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function ScopeButton({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-selected={active} role="tab" onClick={onClick} className={cn(active && "bg-surface text-ink")}>
      {children}
    </Button>
  );
}
