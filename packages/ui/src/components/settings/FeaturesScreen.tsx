"use client";
import type { CapabilityDecision } from "@/runtime/environment-capabilities";
import type { SettingsScopeView } from "@/runtime/settings-scope";

import { PRODUCT_DISPLAY_NAME, type FeatureScope, type FeatureState } from "@lasercode/protocol";
import { Bot, Check, CircleDot, Globe, Plug, RotateCw, Target } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { CapabilityNotice } from "@/components/capability-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toggle } from "@/components/ui/toggle";
import { WorkerRecoveryNotice } from "@/components/worker-recovery-notice";
import { useLaserStable, useLaserState } from "@/runtime";
import { featureSource, selectedFeatureValue } from "./feature-scope.js";

export interface FeaturesScreenProps {
  view: SettingsScopeView;
  /** Present only for a validated, explicitly selected project. */
  projectCwd?: string | undefined;
  /** Internal execution route for Global writes; never a Settings target. */
  neutralRouteCwd?: string | undefined;
  onManageServers?: (() => void) | undefined;
  decision?: CapabilityDecision | undefined;
}

export function FeaturesScreen({ view, projectCwd, neutralRouteCwd, onManageServers, decision }: FeaturesScreenProps) {
  const writable = decision?.state === "available" || decision === undefined;
  const readOnlyExplanation = decision?.state === "explained" ? decision.explanation : undefined;
  const { client, actions } = useLaserStable();
  const [features, setFeatures] = useState<FeatureState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const generation = useRef(0);
  const targetKey = `${view}:${projectCwd ?? ""}`;
  const worker = useLaserState(state => projectCwd ? state.workers[projectCwd] : undefined);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    if (view !== "global" && !projectCwd) {
      setFeatures([]);
      setLoading(false);
      return;
    }
    try {
      const routeCwd = view === "global" ? undefined : projectCwd;
      const next = (await client.request("feature/list", routeCwd ? { cwd: routeCwd } : {})).features;
      if (request === generation.current) setFeatures(next);
    } catch (error) {
      if (request === generation.current) {
        actions.toast("error", error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [actions, client, projectCwd, targetKey, view]);

  // Invalidate the old target at commit time, before a stale promise can
  // settle in the render-to-effect gap. Abandoned renders never touch refs.
  useLayoutEffect(() => {
    generation.current += 1;
  }, [targetKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (feature: FeatureState, enabled: boolean | null) => {
    if (view === "effective") return;
    if (view === "project" && !projectCwd) return;
    if (needsNeutralRoute(feature, view, enabled) && !neutralRouteCwd) {
      actions.toast("error", "Global Web Search needs the Settings service connection before it can be enabled.");
      return;
    }
    const mutationGeneration = generation.current;
    const scope: FeatureScope = view;
    setBusy(feature.manifest.id);
    try {
      const routeCwd = view === "global" ? neutralRouteCwd : projectCwd;
      const result = await client.request("feature/set", {
        id: feature.manifest.id,
        enabled,
        scope,
        ...(routeCwd ? { cwd: routeCwd } : {}),
      });
      actions.toast(
        result.restartPending ? "warning" : "info",
        result.restartPending
          ? `${feature.manifest.name} will change when the current session finishes and its project restarts.`
          : enabled === null
            ? `${feature.manifest.name} now follows your Global choice.`
            : `${feature.manifest.name} is ${enabled ? "enabled" : "disabled"}.`,
      );
      if (generation.current === mutationGeneration) await load();
    } catch (error) {
      actions.toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-4 py-5 md:px-6">
        <header className="max-w-140">
          <p className="eyebrow text-live">Capabilities</p>
          <h2 className="mt-1 text-lg font-semibold text-ink">Features built into {PRODUCT_DISPLAY_NAME}</h2>
          <p className="mt-1 text-sm leading-6 text-ink-2">
            {view === "effective"
              ? "Resolved feature choices are read-only here. Their labels show where each choice came from."
              : `Turn on what you want ${PRODUCT_DISPLAY_NAME} to do. Every feature ships with the app and stays on the tested version.`}
          </p>
        </header>

        {!writable && readOnlyExplanation ? <CapabilityNotice explanation={readOnlyExplanation} /> : null}

        {view === "project" && projectCwd ? (
          <WorkerRecoveryNotice
            worker={worker}
            onRestart={(mode) => void actions.restartWorker(projectCwd, mode)}
          />
        ) : null}

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
              const selected = selectedFeatureValue(feature, view);
              const routeUnavailable = !neutralRouteCwd && needsNeutralRoute(feature, view, !selected);
              return (
                <article key={feature.manifest.id} className="group flex min-h-56 flex-col rounded-xl border border-line bg-surface p-4 transition-colors duration-(--motion-fast) hover:border-line-strong">
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid size-10 place-items-center rounded-lg bg-[color-mix(in_oklab,var(--live)_12%,var(--surface))] text-live">
                      <Icon className="size-5" aria-hidden="true" />
                    </div>
                    <Toggle
                      variant="outline"
                      pressed={selected}
                      disabled={!writable || changing || view === "effective" || routeUnavailable}
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
                    {featureSource(feature, view)}
                    {feature.manifest.restart === "worker" ? " · Changing this restarts the affected project" : ""}
                  </p>
                  {routeUnavailable ? (
                    <p className="mt-2 text-xs leading-5 text-attention">Reconnect the Settings service before enabling Web Search.</p>
                  ) : null}
                  {feature.manifest.id === "mcp" && onManageServers ? (
                    <Button type="button" variant="link" size="sm" className="mt-2 h-auto self-start p-0 text-xs" onClick={onManageServers}>
                      Manage servers
                    </Button>
                  ) : null}
                  {writable && view === "project" && feature.projectEnabled !== undefined ? (
                    <Button type="button" variant="link" size="sm" className="mt-2 h-auto self-start p-0 text-xs" disabled={changing} onClick={() => void change(feature, null)}>
                      Use Global choice
                    </Button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function needsNeutralRoute(feature: FeatureState, view: SettingsScopeView, enabled: boolean | null): boolean {
  return view === "global"
    && feature.manifest.id === "web-search"
    && (enabled === true || (enabled === null && feature.globalEnabled));
}
