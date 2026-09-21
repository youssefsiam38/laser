"use client";
/**
 * Model profiles, everywhere a surface chooses one (`docs/model-profiles.md`,
 * D-346).
 *
 * A profile is a person-named, ordered list of models: the first is the one it
 * prefers, the rest are what it moves to when that one stops answering. Every
 * control that used to choose a model chooses a profile, so this file holds the
 * one hook that reads them and the one picker that offers them — a second
 * implementation is how two screens end up disagreeing about what "Balanced"
 * is.
 *
 * The host is the only writer (`models/profiles/save`/`delete`), so a save here
 * is a request, never a local mutation that hopes to match.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EMPTY_PROFILE_ASSIGNMENTS,
  MODEL_PROFILE_ID_PREFIX,
  modelKey,
  profileById,
  type ModelCatalogEntry,
  type ModelIdentity,
  type ModelProfile,
  type ModelProfileInput,
  type ProfileAssignments,
} from "@lasercode/protocol";

import { useLaserStable } from "@/runtime";
import { cn } from "@/lib/utils";

import { ErrorState } from "./error-state.js";
import { GenerationLoader } from "./loading-state.js";
import { ProviderLogo } from "./logos.js";
import {
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorSearch,
  ModelSelectorTrigger,
  ModelSelectorValue,
  type ModelOption,
  type ModelSelectorContentProps,
} from "./model-selector.js";

/**
 * A new profile's id, minted where the profile is made.
 *
 * Opaque, stable and prefixed so a person reading the settings file can tell
 * what it is; it satisfies the protocol's `MODEL_PROFILE_ID_PATTERN`, which is
 * what the worker validates before it writes.
 */
export function newProfileId(): string {
  return `${MODEL_PROFILE_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The catalogue's name for a model, or its id when the catalogue does not carry it. */
export function modelDisplayName(model: ModelIdentity, catalogue: readonly ModelCatalogEntry[]): string {
  return catalogue.find((entry) => modelKey(entry) === modelKey(model))?.name ?? model.id;
}

/** True when this model is not something the person can currently use. */
export function isModelUnavailable(model: ModelIdentity, catalogue: readonly ModelCatalogEntry[]): boolean {
  return !catalogue.some((entry) => modelKey(entry) === modelKey(model));
}

/**
 * One line naming what a profile runs on: the model it prefers, and how many
 * stand behind it. Never the whole list — that is the card's job, and a picker
 * row that wraps is a picker row nobody reads.
 */
export function profileModelSummary(profile: ModelProfile, catalogue: readonly ModelCatalogEntry[]): string {
  const first = profile.models[0];
  if (!first) return "No model yet";
  const name = modelDisplayName(first, catalogue);
  const rest = profile.models.length - 1;
  if (rest === 0) return `${name} · nothing behind it`;
  return `${name} · then ${rest} more`;
}

export interface ModelProfilesState {
  profiles: ModelProfile[];
  assignments: ProfileAssignments;
  loading: boolean;
  error?: string;
  /** Ask the host again. Used by an error state's "Try again". */
  reload(): void;
  /** Create or replace one profile. Rejects with the host's refusal. */
  save(profile: ModelProfileInput): Promise<void>;
  /** Delete one profile, moving every reference to `replacementId` first. */
  remove(id: string, replacementId?: string): Promise<void>;
}

const NOTHING: Pick<ModelProfilesState, "profiles" | "assignments"> = {
  profiles: [],
  assignments: EMPTY_PROFILE_ASSIGNMENTS,
};

/**
 * Every profile and the assignments that point at them, from the host.
 *
 * Read-only for any reach (`models/profiles/list`), so a phone draws the same
 * picker the desktop does.
 */
export function useModelProfiles(cwd: string | undefined, enabled = true): ModelProfilesState {
  const { client } = useLaserStable();
  const [state, setState] = useState<{ profiles: ModelProfile[]; assignments: ProfileAssignments; loading: boolean; error?: string }>({
    ...NOTHING,
    loading: enabled,
  });
  const [generation, setGeneration] = useState(0);
  // Which directory the state on screen belongs to. A save that resolves after
  // the screen moved to another project must not repaint this one (RP-11).
  const settled = useRef(cwd);

  useEffect(() => {
    settled.current = cwd;
    if (!enabled) {
      setState({ ...NOTHING, loading: false });
      return;
    }
    let live = true;
    setState(({ profiles, assignments }) => ({ profiles, assignments, loading: true }));
    client
      .request("models/profiles/list", cwd ? { cwd } : {})
      .then((result) => {
        if (!live) return;
        // A host that answers without the lists is a host with nothing to say
        // about profiles yet; an empty screen with its empty state is the
        // honest reading of that, not a crash.
        setState({
          profiles: result.profiles ?? [],
          assignments: result.assignments ?? EMPTY_PROFILE_ASSIGNMENTS,
          loading: false,
        });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({ ...NOTHING, loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [client, cwd, enabled, generation]);

  const adopt = useCallback(
    (result: { profiles: ModelProfile[]; assignments: ProfileAssignments }, forCwd: string | undefined) => {
      if (settled.current !== forCwd) return;
      setState({
        profiles: result.profiles ?? [],
        assignments: result.assignments ?? EMPTY_PROFILE_ASSIGNMENTS,
        loading: false,
      });
    },
    [],
  );

  const save = useCallback(
    async (profile: ModelProfileInput) => {
      adopt(await client.request("models/profiles/save", { ...(cwd ? { cwd } : {}), profile }), cwd);
    },
    [adopt, client, cwd],
  );

  const remove = useCallback(
    async (id: string, replacementId?: string) => {
      adopt(
        await client.request("models/profiles/delete", {
          ...(cwd ? { cwd } : {}),
          id,
          ...(replacementId ? { replacementId } : {}),
        }),
        cwd,
      );
    },
    [adopt, client, cwd],
  );

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  return useMemo(
    () => ({ ...state, reload, save, remove }),
    [state, reload, save, remove],
  );
}

/** The sentinel a picker uses for "no profile of its own"; never a profile id. */
export const INHERIT_PROFILE = "__inherit__";

export interface ProfilePickerProps {
  profiles: readonly ModelProfile[];
  /** The chosen profile id, or `null` for nothing chosen / inherited. */
  value: string | null | undefined;
  onValueChange(id: string | null): void;
  /** Models the catalogue knows, so each row can name the model it prefers. */
  catalogue?: readonly ModelCatalogEntry[];
  disabled?: boolean;
  loading?: boolean;
  error?: string | undefined;
  placeholder?: string;
  /** Offer "Follow the default" as the first row (agents, built-ins). */
  inheritLabel?: string;
  /** The profile the inherit row resolves to right now, named on that row. */
  inheritTarget?: string | undefined;
  className?: string;
  side?: ModelSelectorContentProps["side"];
  align?: ModelSelectorContentProps["align"];
  container?: HTMLElement | null | undefined;
  "aria-label"?: string;
}

/**
 * The one control that chooses a profile.
 *
 * It names the profile and, underneath, the model that profile prefers, so the
 * intent and the thing it resolves to are never two separate lookups.
 */
export function ProfilePicker({
  profiles,
  value,
  onValueChange,
  catalogue = [],
  disabled,
  loading = false,
  error,
  placeholder = "Choose a profile",
  inheritLabel,
  inheritTarget,
  className,
  side,
  align,
  container,
  "aria-label": ariaLabel,
}: ProfilePickerProps) {
  const options = useMemo<ModelOption[]>(() => {
    const rows: ModelOption[] = profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profileModelSummary(profile, catalogue),
      keywords: [profile.name, ...profile.models.map((model) => model.id)],
      ...(profile.models[0] ? { icon: <ProviderLogo provider={profile.models[0].provider} className="size-3.5" /> } : {}),
    }));
    if (inheritLabel) {
      rows.unshift({
        id: INHERIT_PROFILE,
        name: inheritLabel,
        description: inheritTarget ? `Uses ${inheritTarget} today` : "Whatever new conversations use",
      });
    }
    return rows;
  }, [catalogue, inheritLabel, inheritTarget, profiles]);

  const selected = value ?? (inheritLabel ? INHERIT_PROFILE : undefined);

  return (
    <ModelSelectorRoot
      models={options}
      {...(selected !== undefined ? { value: selected } : {})}
      onValueChange={(next) => onValueChange(next === INHERIT_PROFILE ? null : next)}
    >
      <ModelSelectorTrigger
        disabled={disabled}
        data-slot="profile-picker-trigger"
        {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
        className={cn("w-full max-w-96", className)}
      >
        <ModelSelectorValue placeholder={loading ? "Loading profiles…" : placeholder} className="min-w-0" />
      </ModelSelectorTrigger>
      <ModelSelectorContent
        searchable={false}
        {...(side ? { side } : {})}
        {...(align ? { align } : {})}
        container={container}
      >
        <ModelSelectorSearch aria-label="Search profiles" placeholder="Search profiles" />
        <ModelSelectorList>
          {error ? (
            <ErrorState className="m-2" title="Couldn’t load your profiles" detail={error} />
          ) : loading ? (
            <div className="px-3 py-3">
              <GenerationLoader label="Loading profiles" layout="inline" />
            </div>
          ) : options.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-ink-3">
              No profiles yet. Make one in Settings → Providers and models → Model profiles.
            </p>
          ) : (
            <>
              <ModelSelectorEmpty>No profile matches.</ModelSelectorEmpty>
              <ModelSelectorGroup heading="Profiles">
                {options.map((option) => (
                  <ModelSelectorItem key={option.id} model={option} data-profile={option.id} />
                ))}
              </ModelSelectorGroup>
            </>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}

/** The profile named by an id, for a surface that holds the id and not the profile. */
export function profileNamed(profiles: readonly ModelProfile[], id: string | null | undefined): ModelProfile | undefined {
  return profileById(profiles, id);
}
