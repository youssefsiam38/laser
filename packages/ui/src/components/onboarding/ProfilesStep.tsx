"use client";
/**
 * Step: review the profiles Laser filled in (M22-T7,
 * `docs/model-profiles.md` "What a person sees").
 *
 * Connecting a provider is enough: the app writes three profiles — Smart,
 * Balanced and Fast — from the models that provider actually offers, and this
 * step shows them. A person keeps them, changes which model each one reaches
 * for first, or chooses a different one for new conversations, and then moves
 * on. Nothing here has to be done, which is why the step never blocks: leaving
 * it untouched leaves the profiles exactly as they were filled in.
 *
 * Everything deeper — renaming, adding models, reordering the rest — lives in
 * Settings → Providers and models → Model profiles, and the step says so
 * rather than growing a second copy of that screen.
 */
import { Check, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useConnectedModels } from "@/components/assistant-ui/elements/connected-models";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { modelDisplayName, useModelProfiles } from "@/components/assistant-ui/elements/model-profiles";
import { ProviderModelPicker, modelOptionId } from "@/components/assistant-ui/elements/model-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import {
  DEFAULT_PROFILE_SETTING,
  modelKey,
  profileById,
  type ModelProfile,
  type ProfileModelRef,
} from "@lasercode/protocol";

export interface ProfilesStepProps {
  cwd: string;
  /**
   * True once there is a profile to run on and new conversations point at one
   * — the only thing this step must leave behind.
   */
  onReady: (ready: boolean) => void;
}

export function ProfilesStep({ cwd, onReady }: ProfilesStepProps) {
  const { client, actions } = useLaserStable();
  const { profiles, assignments, loading, error, reload, save } = useModelProfiles(cwd);
  const { models: catalogue } = useConnectedModels(cwd, "global");
  const [saving, setSaving] = useState<string>();

  const defaultId = assignments.defaultProfileId;
  const ready = profiles.length > 0 && profileById(profiles, defaultId) !== undefined;
  useEffect(() => {
    onReady(ready);
  }, [onReady, ready]);

  const chooseDefault = useCallback(
    async (profile: ModelProfile) => {
      setSaving(profile.id);
      try {
        await client.request("pi/settings/set", {
          cwd,
          scope: "global",
          changes: [{ path: DEFAULT_PROFILE_SETTING, op: "set", value: profile.id }],
        });
        reload();
      } catch (saveError) {
        actions.toast("error", saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(undefined);
      }
    },
    [actions, client, cwd, reload],
  );

  const choosePreferred = useCallback(
    async (profile: ModelProfile, model: ProfileModelRef) => {
      const rest = profile.models.filter((entry) => modelKey(entry) !== modelKey(model));
      setSaving(profile.id);
      try {
        await save({ ...profile, models: [model, ...rest] });
      } catch (saveError) {
        actions.toast("error", saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(undefined);
      }
    },
    [actions, save],
  );

  const otherUses = useMemo(() => {
    const named = (id: string | null) => profileById(profiles, id)?.name;
    const naming = named(assignments.namingProfileId);
    const oracle = named(assignments.oracleProfileId);
    if (!naming && !oracle) return undefined;
    if (naming && oracle) return `Titles are written by ${naming}, and second opinions come from ${oracle}.`;
    return naming ? `Titles are written by ${naming}.` : `Second opinions come from ${oracle}.`;
  }, [assignments, profiles]);

  if (error !== undefined) {
    return <ErrorState title="Could not read your profiles" detail={error} onRetry={reload} retryLabel="Try again" />;
  }
  if (loading && profiles.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-line px-3 py-8">
        <GenerationLoader label="Reading your profiles" layout="inline" />
      </div>
    );
  }
  if (profiles.length === 0) {
    return (
      <div data-slot="profiles-pending" className="flex flex-col items-start gap-2 rounded-xl border border-line px-3 py-6">
        <p className="text-sm font-medium text-ink">Your profiles are not filled in yet</p>
        <p className="text-sm leading-6 text-ink-2">
          They are written from the models the provider you just connected offers. If you connected one a moment ago, check
          again; otherwise go back a step and connect one.
        </p>
        <Button variant="secondary" size="sm" onClick={reload}>
          <RefreshCw aria-hidden="true" /> Check again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {profiles.map((profile) => {
          const preferred = profile.models[0];
          const isDefault = profile.id === defaultId;
          const busy = saving === profile.id;
          return (
            <li
              key={profile.id}
              data-slot="setup-profile"
              data-profile={profile.id}
              data-default={isDefault ? "true" : undefined}
              className={cn(
                "flex flex-col gap-2 rounded-xl border bg-surface px-3 py-2.5",
                isDefault ? "border-live" : "border-line",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{profile.name}</span>
                {isDefault ? (
                  <Badge variant="live" data-slot="default-badge">
                    <Check aria-hidden="true" /> New conversations
                  </Badge>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    aria-label={`Start new conversations on ${profile.name}`}
                    onClick={() => void chooseDefault(profile)}
                  >
                    Use for new conversations
                  </Button>
                )}
                <span className="ms-auto text-xs text-ink-3 tabular-nums">
                  {profile.models.length} {profile.models.length === 1 ? "model" : "models"}
                </span>
              </div>

              <ol className="flex flex-wrap items-center gap-1.5">
                {profile.models.map((model, position) => (
                  <li
                    key={modelKey(model)}
                    data-slot="setup-profile-model"
                    className="flex items-center gap-1.5 rounded-md border border-line/60 bg-surface-2 px-1.5 py-0.5"
                  >
                    <ProviderLogo provider={model.provider} className="size-3.5 shrink-0 text-ink-3" />
                    <span className="max-w-48 truncate text-xs text-ink" title={`${model.provider}/${model.id}`}>
                      {modelDisplayName(model, catalogue)}
                    </span>
                    {position === 0 && <span className="text-xs text-ink-3">first</span>}
                  </li>
                ))}
              </ol>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-3">Reach for</span>
                <ProviderModelPicker
                  models={catalogue}
                  {...(preferred ? { value: modelOptionId(preferred) } : {})}
                  disabled={busy || catalogue.length === 0}
                  placeholder="Choose the first model"
                  className="max-w-64"
                  onValueChange={(id) => {
                    const chosen = catalogue.find((entry) => modelOptionId(entry) === id);
                    if (chosen) void choosePreferred(profile, { provider: chosen.provider, id: chosen.id });
                  }}
                />
                <span className="text-xs text-ink-3">first</span>
              </div>
            </li>
          );
        })}
      </ul>
      {otherUses && <p className="text-xs leading-5 text-ink-3">{otherUses}</p>}
      <p className="text-xs leading-5 text-ink-3">
        Keep these as they are, or change them here. Renaming a profile, adding models and making new ones all live in
        Settings → Providers and models → Model profiles.
      </p>
    </div>
  );
}
