"use client";
/**
 * Settings → Providers and models → Model profiles (M22-T6,
 * `docs/model-profiles.md`).
 *
 * A profile is a named, ordered list of models: the first is the one it uses,
 * and the rest are what it moves to when that one cannot answer. Every surface
 * that used to choose a model chooses a profile, so this screen also holds the
 * assignments — what new conversations use, what names them, what a second
 * opinion uses, and what reads a design.
 *
 * The host is the only writer. Every edit is a `models/profiles/save` and every
 * delete a `models/profiles/delete`, but the same `validateModelProfiles` the
 * worker refuses with runs here first, so the sentence a person reads is the
 * sentence that would have come back.
 */
import { ArrowDown, ArrowUp, Copy, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  MAX_MODEL_PROFILES,
  MAX_PROFILE_MODELS,
  PROFILE_NAME_MAX,
  modelKey,
  validateModelProfiles,
  type ModelCatalogEntry,
  type ModelProfile,
  type ModelProfileInput,
  type ModelProfileIssue,
  type ProfileAssignments,
  type ProfileModelRef,
  type SettingChange,
  type SettingsScope,
  type ThinkingLevel,
} from "@lasercode/protocol";

import { useConnectedModels } from "@/components/assistant-ui/elements/connected-models";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import {
  ProfilePicker,
  isModelUnavailable,
  modelDisplayName,
  newProfileId,
  useModelProfiles,
} from "@/components/assistant-ui/elements/model-profiles";
import { ProviderModelPicker, modelOptionId } from "@/components/assistant-ui/elements/model-selector";
import { CapabilityNotice } from "@/components/capability-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useLaserState } from "@/runtime";
import type { CapabilityDecision } from "@/runtime/environment-capabilities";
import type { SettingsScopeView } from "@/runtime/settings-scope";
import type { ScopeDraft } from "../ScopeDraftGuard.js";
import {
  ASSIGNMENT_LABELS,
  duplicateName,
  moveModel,
  profileUsage,
  replacementCandidates,
  usageSentence,
} from "./profile-usage.js";

export interface ModelProfilesTabProps {
  cwd: string;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
  scopeView: SettingsScopeView;
  decision?: CapabilityDecision | undefined;
  onDraftChange?: ((draft: ScopeDraft | undefined) => void) | undefined;
}

/** A profile being made: real enough to see, not yet real enough to save. */
interface Draft {
  name: string;
  models: ProfileModelRef[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function ModelProfilesTab({ cwd, onApply, scopeView, decision, onDraftChange }: ModelProfilesTabProps) {
  const writable = scopeView === "global" && (decision?.state === "available" || decision === undefined);
  const readOnlyExplanation = scopeView !== "global"
    ? "Model profiles are yours, not a project’s. Choose Global above to edit them."
    : decision?.state === "explained" ? decision.explanation : undefined;

  const { profiles, assignments, loading, error, reload, save, remove } = useModelProfiles(cwd);
  const { models: catalogue, loading: modelsLoading, error: modelsError, none } = useConnectedModels(cwd, "global");
  const agentsSnapshot = useLaserState((state) => state.agents.snapshot);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const [deleting, setDeleting] = useState<ModelProfile | null>(null);

  useEffect(() => {
    setDraft(null);
    setRefused(undefined);
    setDeleting(null);
  }, [cwd, scopeView]);

  useEffect(() => {
    if (!draft) {
      onDraftChange?.(undefined);
      return;
    }
    onDraftChange?.({ id: "model-profile", label: "New model profile", discard: () => setDraft(null) });
    return () => onDraftChange?.(undefined);
  }, [draft, onDraftChange]);

  const issues = useMemo(() => validateModelProfiles(profiles), [profiles]);
  const issuesFor = useCallback(
    (index: number): ModelProfileIssue[] => issues.filter((issue) => issue.profile === index),
    [issues],
  );

  /** Save one profile after the whole list has passed the rules the worker applies. */
  const commit = useCallback(
    async (profile: ModelProfileInput): Promise<boolean> => {
      const next = profiles.some((entry) => entry.id === profile.id)
        ? profiles.map((entry) => (entry.id === profile.id ? { ...entry, ...profile } : entry))
        : [...profiles, { ...profile, updatedAt: new Date().toISOString() }];
      const problems = validateModelProfiles(next);
      if (problems.length > 0) {
        setRefused(problems[0]!.message);
        return false;
      }
      setRefused(undefined);
      setBusy(true);
      try {
        await save(profile);
        return true;
      } catch (saveError) {
        setRefused(messageOf(saveError));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [profiles, save],
  );

  const addProfile = () => {
    setRefused(undefined);
    setDraft({ name: "", models: [] });
  };

  const createDraft = async () => {
    if (!draft) return;
    const ok = await commit({ id: newProfileId(), name: draft.name.trim(), models: draft.models, origin: "person" });
    if (ok) setDraft(null);
  };

  const duplicate = (profile: ModelProfile) =>
    void commit({
      id: newProfileId(),
      name: duplicateName(profiles, profile.name),
      ...(profile.description ? { description: profile.description } : {}),
      models: profile.models.map((model) => ({ ...model })),
      origin: "person",
    });

  const confirmDelete = async (replacementId?: string) => {
    if (!deleting) return;
    setBusy(true);
    try {
      await remove(deleting.id, replacementId);
      setRefused(undefined);
      setDeleting(null);
    } catch (deleteError) {
      setRefused(messageOf(deleteError));
    } finally {
      setBusy(false);
    }
  };

  const setAssignment = (setting: keyof ProfileAssignments, id: string | null) => {
    void onApply("global", [id === null ? { path: setting, op: "unset" } : { path: setting, op: "set", value: id }]).then((ok) => {
      if (ok) reload();
    });
  };

  const usageOf = useCallback(
    (profile: ModelProfile) =>
      profileUsage(profile.id, assignments, agentsSnapshot?.agents ?? []),
    [agentsSnapshot, assignments],
  );

  const catalogueReady = !modelsLoading && catalogue.length > 0;
  const atLimit = profiles.length >= MAX_MODEL_PROFILES;
  const showEmpty = !loading && error === undefined && profiles.length === 0 && draft === null;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-240 flex-col gap-5 px-4 py-4">
        {!writable && readOnlyExplanation ? <CapabilityNotice explanation={readOnlyExplanation} /> : null}

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Model profiles</h2>
            {(loading || modelsLoading || busy) && (
              <GenerationLoader label={busy ? "Saving" : "Loading profiles"} layout="inline" />
            )}
          </div>
          <p className="text-xs leading-5 text-ink-2">
            A profile is a name for how you want something answered, and the models that answer it. The first model is the
            one it uses; if that model cannot answer — the provider is down, the credit is gone, the subscription window is
            spent — the conversation moves to the next one, with its history and tool results intact.
          </p>
          <p className="text-xs leading-5 text-ink-3">
            Profiles are yours, not a project’s. An edit applies to conversations started afterwards; one already running
            keeps the models it started with.
          </p>
          {modelsError && (
            <p role="status" className="text-xs leading-5 text-attention">
              The model catalogue could not be read: {modelsError}
            </p>
          )}
          {none && !modelsLoading && (
            <p role="status" className="text-xs leading-5 text-attention">
              Connect a provider under Models and dictation first — a profile can only name models you can actually use.
            </p>
          )}
          {refused && (
            <p role="status" data-slot="profile-refusal" className="text-xs leading-5 text-attention">
              {refused}
            </p>
          )}
        </section>

        {error !== undefined ? (
          <ErrorState
            title="Couldn’t read your model profiles"
            detail={error}
            onRetry={reload}
          />
        ) : loading ? (
          <div data-slot="profiles-loading" className="rounded-xl border border-line bg-surface px-4 py-6">
            <GenerationLoader label="Loading your profiles" layout="inline" />
          </div>
        ) : (
          <>
            <AssignmentsSection
              profiles={profiles}
              assignments={assignments}
              catalogue={catalogue}
              writable={writable && profiles.length > 0}
              onChange={setAssignment}
            />

            {showEmpty ? (
              <section
                data-slot="profiles-empty"
                className="flex flex-col items-start gap-3 rounded-xl border border-line bg-surface px-4 py-5"
              >
                <p className="text-sm font-medium text-ink">No model profiles yet</p>
                <p className="max-w-140 text-xs leading-5 text-ink-2">
                  Make one and everything that asks a model — new conversations, titles, your agents — can point at it. Name
                  the model you want first, then the ones that should step in for it.
                </p>
                <Button size="sm" data-slot="add-profile" onClick={addProfile} disabled={!writable || modelsLoading || none}>
                  <Plus aria-hidden="true" /> Add a profile
                </Button>
              </section>
            ) : (
              <div className="flex flex-col gap-3">
                {profiles.map((profile, index) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    index={index}
                    catalogue={catalogue}
                    catalogueReady={catalogueReady}
                    issues={issuesFor(index)}
                    usage={usageSentence(usageOf(profile))}
                    busy={busy}
                    writable={writable}
                    onEdit={(patch) => void commit({ ...profile, ...patch })}
                    onDuplicate={() => duplicate(profile)}
                    onDelete={() => setDeleting(profile)}
                  />
                ))}

                {draft && (
                  <DraftCard
                    draft={draft}
                    catalogue={catalogue}
                    busy={busy}
                    onChange={setDraft}
                    onCreate={() => void createDraft()}
                    onDiscard={() => setDraft(null)}
                  />
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-slot="add-profile"
                    onClick={addProfile}
                    disabled={!writable || modelsLoading || none || draft !== null || atLimit}
                  >
                    <Plus aria-hidden="true" /> Add a profile
                  </Button>
                  {atLimit && (
                    <span className="text-xs leading-5 text-ink-3">
                      {MAX_MODEL_PROFILES} profiles is the most this app keeps. Delete one to make another.
                    </span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <DeleteProfileDialog
        profile={deleting}
        profiles={profiles}
        usage={deleting ? usageOf(deleting) : undefined}
        busy={busy}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={(replacementId) => void confirmDelete(replacementId)}
      />
    </ScrollArea>
  );
}

// ---------------------------------------------------------------- assignments

function AssignmentsSection({
  profiles,
  assignments,
  catalogue,
  writable,
  onChange,
}: {
  profiles: readonly ModelProfile[];
  assignments: ProfileAssignments;
  catalogue: readonly ModelCatalogEntry[];
  writable: boolean;
  onChange(setting: keyof ProfileAssignments, id: string | null): void;
}) {
  return (
    <section data-slot="profile-assignments" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">What uses which profile</h3>
      <p className="text-xs leading-5 text-ink-2">
        Each of these picks a profile, never a single model. Rename a profile and these keep pointing at it.
      </p>
      <div className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2">
        {ASSIGNMENT_LABELS.map(({ setting, label, description }) => (
          <div key={setting} className="flex min-w-0 flex-col gap-1" data-slot="assignment" data-setting={setting}>
            <span className="text-sm font-medium text-ink">{label}</span>
            <p className="text-xs leading-5 text-ink-3">{description}</p>
            <ProfilePicker
              profiles={profiles}
              catalogue={catalogue}
              value={assignments[setting]}
              disabled={!writable}
              aria-label={`Profile for ${label.toLowerCase()}`}
              placeholder="Not chosen yet"
              onValueChange={(id) => onChange(setting, id)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

// -------------------------------------------------------------------- a card

const THINKING_FALLBACK: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function ModelRows({
  models,
  catalogue,
  catalogueReady,
  issues,
  busy,
  writable,
  owner,
  onChange,
}: {
  models: readonly ProfileModelRef[];
  catalogue: readonly ModelCatalogEntry[];
  catalogueReady: boolean;
  issues: readonly ModelProfileIssue[];
  busy: boolean;
  writable: boolean;
  /** The profile's name, so every control says what it acts on. */
  owner: string;
  onChange(models: ProfileModelRef[]): void;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {models.map((model, position) => {
        const label = modelDisplayName(model, catalogue);
        const entry = catalogue.find((option) => modelKey(option) === modelKey(model));
        const unavailable = catalogueReady && isModelUnavailable(model, catalogue);
        const problem = issues.find((issue) => issue.model === position);
        const levels = entry?.thinkingLevels.length ? entry.thinkingLevels : THINKING_FALLBACK;
        return (
          <li
            key={modelKey(model)}
            data-slot="profile-model"
            data-model={modelKey(model)}
            data-position={position}
            data-unavailable={unavailable ? "true" : undefined}
            className={cn(
              "flex flex-wrap items-center gap-2 rounded-lg border border-line/60 bg-surface-2 px-2.5 py-1.5",
              problem && "border-attention",
            )}
          >
            <span className="w-4 shrink-0 text-center text-xs text-ink-3 tabular-nums" aria-hidden="true">
              {position + 1}
            </span>
            <ProviderLogo provider={model.provider} className="size-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-sm text-ink" title={`${model.provider}/${model.id}`}>
              {label}
            </span>
            {position === 0 && (
              <Badge variant="outline" className="shrink-0 text-ink-2">
                Preferred
              </Badge>
            )}
            {unavailable && (
              <Badge variant="attention" data-slot="model-unavailable" className="shrink-0">
                Not connected
              </Badge>
            )}
            {writable && (
              <label className="flex shrink-0 items-center gap-1 text-xs text-ink-3">
                <span className="sr-only">Thinking level for {label} in {owner}</span>
                <select
                  aria-label={`Thinking level for ${label} in ${owner}`}
                  value={model.thinking ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const level = event.target.value === "" ? undefined : (event.target.value as ThinkingLevel);
                    onChange(
                      models.map((entryModel, at) =>
                        at === position
                          ? ({ provider: entryModel.provider, id: entryModel.id, ...(level ? { thinking: level } : {}) })
                          : entryModel,
                      ),
                    );
                  }}
                  className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs text-ink outline-none focus-visible:border-live"
                >
                  <option value="">thinking: model default</option>
                  {levels.map((level) => (
                    <option key={level} value={level}>
                      thinking: {level}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {writable && (
              <TooltipIconButton
                tooltip={`Move ${label} up`}
                side="top"
                variant="ghost"
                size="icon-sm"
                className="text-ink-3 pointer-coarse:size-11"
                disabled={busy || position === 0}
                onClick={() => onChange(moveModel(models, position, position - 1))}
              >
                <ArrowUp aria-hidden="true" />
              </TooltipIconButton>
            )}
            {writable && (
              <TooltipIconButton
                tooltip={`Move ${label} down`}
                side="top"
                variant="ghost"
                size="icon-sm"
                className="text-ink-3 pointer-coarse:size-11"
                disabled={busy || position === models.length - 1}
                onClick={() => onChange(moveModel(models, position, position + 1))}
              >
                <ArrowDown aria-hidden="true" />
              </TooltipIconButton>
            )}
            {writable && (
              <TooltipIconButton
                tooltip={
                  models.length > 1
                    ? `Remove ${label} from ${owner}`
                    : "A profile needs a model — delete the profile instead"
                }
                side="top"
                variant="ghost"
                size="icon-sm"
                className="text-ink-3 hover:text-attention pointer-coarse:size-11"
                disabled={busy || models.length <= 1}
                onClick={() => onChange(models.filter((_, at) => at !== position))}
              >
                <X aria-hidden="true" />
              </TooltipIconButton>
            )}
            {unavailable && (
              <p className="basis-full text-xs leading-5 text-ink-3">
                {label} is not offered right now — its provider is signed out, or the model is switched off. It stays in the
                profile and is skipped until it comes back.
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function AddModelRow({
  models,
  catalogue,
  busy,
  placeholder,
  onAdd,
}: {
  models: readonly ProfileModelRef[];
  catalogue: readonly ModelCatalogEntry[];
  busy: boolean;
  placeholder: string;
  onAdd(model: ProfileModelRef): void;
}) {
  const present = new Set(models.map(modelKey));
  const addable = catalogue.filter((entry) => !present.has(modelKey(entry)));
  const full = models.length >= MAX_PROFILE_MODELS;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProviderModelPicker
        models={addable}
        value=""
        onValueChange={(id) => {
          const chosen = addable.find((entry) => modelOptionId(entry) === id);
          if (chosen) onAdd({ provider: chosen.provider, id: chosen.id });
        }}
        disabled={busy || addable.length === 0 || full}
        placeholder={full ? `${MAX_PROFILE_MODELS} models is the most a profile holds` : placeholder}
        className="max-w-72"
        side="bottom"
        align="start"
      />
    </div>
  );
}

function ProfileCard({
  profile,
  index,
  catalogue,
  catalogueReady,
  issues,
  usage,
  busy,
  writable,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  profile: ModelProfile;
  index: number;
  catalogue: readonly ModelCatalogEntry[];
  catalogueReady: boolean;
  issues: ModelProfileIssue[];
  usage: string;
  busy: boolean;
  writable: boolean;
  onEdit(patch: Partial<ModelProfileInput>): void;
  onDuplicate(): void;
  onDelete(): void;
}) {
  const [name, setName] = useState(profile.name);
  useEffect(() => setName(profile.name), [profile.name]);
  const commitName = () => {
    const next = name.trim();
    if (next === profile.name) return;
    if (next === "") {
      setName(profile.name);
      return;
    }
    onEdit({ name: next });
  };

  return (
    <article
      data-slot="model-profile"
      data-profile={profile.id}
      data-index={index}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {writable ? (
          <input
            aria-label={`Name of the ${profile.name} profile`}
            data-slot="profile-name"
            value={name}
            maxLength={PROFILE_NAME_MAX}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") setName(profile.name);
            }}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium text-ink outline-none transition-colors duration-(--motion-instant) hover:border-line focus-visible:border-live motion-reduce:transition-none"
          />
        ) : (
          <h3 data-slot="profile-name" className="min-w-0 flex-1 truncate px-1.5 py-1 text-sm font-medium text-ink">
            {profile.name}
          </h3>
        )}
        <span className="shrink-0 text-xs text-ink-3 tabular-nums">
          {profile.models.length} {profile.models.length === 1 ? "model" : "models"}
        </span>
        {writable && (
          <TooltipIconButton
            tooltip={`Duplicate ${profile.name}`}
            side="top"
            variant="ghost"
            size="icon-sm"
            className="text-ink-3 pointer-coarse:size-11"
            disabled={busy}
            onClick={onDuplicate}
          >
            <Copy aria-hidden="true" />
          </TooltipIconButton>
        )}
        {writable && (
          <TooltipIconButton
            tooltip={`Delete ${profile.name}`}
            side="left"
            variant="ghost"
            size="icon-sm"
            className="text-ink-3 hover:text-attention pointer-coarse:size-11"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
          </TooltipIconButton>
        )}
      </div>

      <ModelRows
        models={profile.models}
        catalogue={catalogue}
        catalogueReady={catalogueReady}
        issues={issues}
        busy={busy}
        writable={writable}
        owner={profile.name}
        onChange={(models) => onEdit({ models })}
      />

      {issues.length > 0 && (
        <ul data-slot="profile-issues" className="flex flex-col gap-0.5">
          {issues.map((issue) => (
            <li key={`${issue.model ?? issue.field ?? "profile"}-${issue.message}`} className="text-xs leading-5 text-attention">
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {writable && (
        <AddModelRow
          models={profile.models}
          catalogue={catalogue}
          busy={busy}
          placeholder="Add a model to step in"
          onAdd={(model) => onEdit({ models: [...profile.models, model] })}
        />
      )}

      <p data-slot="profile-usage" className="text-xs leading-5 text-ink-3">
        {usage}
      </p>
    </article>
  );
}

function DraftCard({
  draft,
  catalogue,
  busy,
  onChange,
  onCreate,
  onDiscard,
}: {
  draft: Draft;
  catalogue: readonly ModelCatalogEntry[];
  busy: boolean;
  onChange(draft: Draft): void;
  onCreate(): void;
  onDiscard(): void;
}) {
  const ready = draft.name.trim() !== "" && draft.models.length > 0;
  return (
    <article
      data-slot="model-profile"
      data-draft="true"
      className="flex flex-col gap-3 rounded-xl border border-live/40 bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Name for the new profile"
          data-slot="profile-name"
          autoFocus
          value={draft.name}
          maxLength={PROFILE_NAME_MAX}
          placeholder="Name this profile, e.g. Deep work"
          disabled={busy}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-1 text-sm font-medium text-ink outline-none placeholder:text-ink-3 focus-visible:border-live"
        />
      </div>

      {draft.models.length > 0 ? (
        <ModelRows
          models={draft.models}
          catalogue={catalogue}
          catalogueReady={false}
          issues={[]}
          busy={busy}
          writable
          owner={draft.name.trim() === "" ? "this profile" : draft.name.trim()}
          onChange={(models) => onChange({ ...draft, models })}
        />
      ) : (
        <p data-slot="profile-issues" className="text-xs leading-5 text-ink-3">
          Choose the model this profile should use first.
        </p>
      )}

      <AddModelRow
        models={draft.models}
        catalogue={catalogue}
        busy={busy}
        placeholder={draft.models.length === 0 ? "Choose the first model" : "Add a model to step in"}
        onAdd={(model) => onChange({ ...draft, models: [...draft.models, model] })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-slot="create-profile" disabled={busy || !ready} aria-busy={busy || undefined} onClick={onCreate}>
          {busy ? <RotateCw aria-hidden="true" className="motion-safe:animate-busy" /> : <Plus aria-hidden="true" />}
          {busy ? "Saving…" : "Create profile"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </article>
  );
}

// ------------------------------------------------------------- delete dialog

function DeleteProfileDialog({
  profile,
  profiles,
  usage,
  busy,
  onOpenChange,
  onConfirm,
}: {
  profile: ModelProfile | null;
  profiles: readonly ModelProfile[];
  usage: { labels: string[]; referenced: boolean } | undefined;
  busy: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(replacementId?: string): void;
}) {
  const [replacement, setReplacement] = useState<string | null>(null);
  useEffect(() => {
    setReplacement(null);
  }, [profile?.id]);
  const candidates = profile ? replacementCandidates(profiles, profile.id) : [];
  const referenced = usage?.referenced ?? false;
  const blocked = referenced && (replacement === null || candidates.length === 0);

  return (
    <Dialog open={profile !== null} onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent data-slot="delete-profile-dialog">
        <DialogHeader>
          <DialogTitle>Delete {profile?.name ?? "this profile"}?</DialogTitle>
          <DialogDescription>
            {referenced
              ? `${usage?.labels.join(", ")} still point at it. Choose what they should use instead — they move in the same step, so nothing is left pointing at a profile that is gone.`
              : "Nothing points at this profile, so deleting it changes nothing that is running."}
          </DialogDescription>
        </DialogHeader>
        {referenced && (
          candidates.length === 0 ? (
            <p className="text-sm leading-5 text-attention">
              This is your only profile, and things still use it. Make another profile first, then delete this one.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-ink">Use instead</span>
              <ProfilePicker
                profiles={candidates}
                value={replacement}
                aria-label="Profile to use instead"
                placeholder="Choose a replacement"
                onValueChange={setReplacement}
              />
            </div>
          )
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || blocked}
            aria-busy={busy || undefined}
            onClick={() => onConfirm(referenced && replacement ? replacement : undefined)}
          >
            {busy ? <RotateCw aria-hidden="true" className="motion-safe:animate-busy" /> : <Trash2 aria-hidden="true" />}
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
