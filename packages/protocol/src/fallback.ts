/**
 * Model profiles — Laser's one model-routing concept (`docs/model-profiles.md`,
 * D-346).
 *
 * A profile is a person-named, ordered list of connected models. The first
 * model is the one the profile prefers; the rest are what it moves to, in
 * order, when the model in use stops being reachable. Every surface that used
 * to choose a model chooses a profile; a session may pin one model instead,
 * and a pinned session has no second model to move to.
 *
 * This file also keeps the durable runtime record a session writes while it
 * moves through its profile — the M15-T3 state machine, with the profile as
 * its unit of activation (`docs/model-fallback-chains.md` §3–§6 is the runtime
 * record that describes it).
 *
 * Everything here is pure: the vocabulary, the rules a person's edit must
 * obey, and the shape of the record. No engine, no clock, no filesystem, and
 * no engine vocabulary.
 */

import { WIRE_NAMESPACE } from "./identity.js";
import type { ProviderFailureClass } from "./provider-failure.js";
import type { ModelCatalogEntry, ModelRef, SessionState, ThinkingLevel } from "./messages.js";

// --------------------------------------------------------------- the domain

/** A model's identity. Only this is stored; names come from the catalogue. */
export interface ModelIdentity {
  provider: string;
  id: string;
}

/** One entry of a profile: a model, and how hard it should think in this profile. */
export interface ProfileModelRef extends ModelIdentity {
  /** Absent means the model's own default level. */
  thinking?: ThinkingLevel;
}

/** Where a profile came from. Seeded profiles are ordinary, editable profiles. */
export type ModelProfileOrigin = "seeded" | "person";

/**
 * One profile.
 *
 * `id` is opaque and survives every rename, so an assignment never breaks when
 * a person renames what they chose.
 */
export interface ModelProfile {
  id: string;
  name: string;
  description?: string;
  models: ProfileModelRef[];
  origin: ModelProfileOrigin;
  /** ISO time of the last edit. History, not identity. */
  updatedAt: string;
}

/** What a save request carries: everything but the timestamp the writer stamps. */
export type ModelProfileInput = Omit<ModelProfile, "updatedAt"> & { updatedAt?: string };

/** The settings path profiles are written to, in the global settings file. */
export const MODEL_PROFILES_SETTING = "modelProfiles";

/** Storage and interface sanity, not a product tier. */
export const MAX_MODEL_PROFILES = 200;
/** A list, not a program. */
export const MAX_PROFILE_MODELS = 12;
export const PROFILE_NAME_MAX = 40;
export const PROFILE_DESCRIPTION_MAX = 200;

/** Profile ids are `mp_<ulid>`; the bound is generous so a different id source still reads. */
export const MODEL_PROFILE_ID_PREFIX = "mp_";
export const MODEL_PROFILE_ID_PATTERN = /^mp_[0-9A-Za-z]{8,48}$/;

export function isModelProfileId(value: unknown): value is string {
  return typeof value === "string" && MODEL_PROFILE_ID_PATTERN.test(value);
}

/** The three profiles Laser seeds, in the order a person sees them. */
export const SEEDED_PROFILE_NAMES = ["Smart", "Balanced", "Fast"] as const;
export type SeededProfileName = (typeof SEEDED_PROFILE_NAMES)[number];

/**
 * The settings keys that hold an assignment. Every surface that selects a model
 * holds one of these, never a raw model (`docs/model-profiles.md`
 * "Assignments").
 */
export const DEFAULT_PROFILE_SETTING = "defaultProfileId";
export const NAMING_PROFILE_SETTING = "namingProfileId";
export const ORACLE_PROFILE_SETTING = "oracleProfileId";
export const DESIGN_INDEX_PROFILE_SETTING = "designIndexProfileId";

export const PROFILE_ASSIGNMENT_SETTINGS = [
  DEFAULT_PROFILE_SETTING,
  NAMING_PROFILE_SETTING,
  ORACLE_PROFILE_SETTING,
  DESIGN_INDEX_PROFILE_SETTING,
] as const;
export type ProfileAssignmentSetting = (typeof PROFILE_ASSIGNMENT_SETTINGS)[number];

/** Which profile each assignable surface uses. `null` means nothing is assigned yet. */
export interface ProfileAssignments {
  defaultProfileId: string | null;
  namingProfileId: string | null;
  oracleProfileId: string | null;
  designIndexProfileId: string | null;
}

export const EMPTY_PROFILE_ASSIGNMENTS: ProfileAssignments = {
  defaultProfileId: null,
  namingProfileId: null,
  oracleProfileId: null,
  designIndexProfileId: null,
};

/** `provider/id`, lower-cased: the identity every table in this feature is keyed by. */
export function modelKey(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

export function sameModel(a: ModelIdentity | null | undefined, b: ModelIdentity | null | undefined): boolean {
  return !!a && !!b && modelKey(a) === modelKey(b);
}

/** The profile with this id, or undefined. Ids are opaque and compared exactly. */
export function profileById(
  profiles: readonly ModelProfile[],
  id: string | null | undefined,
): ModelProfile | undefined {
  if (!id) return undefined;
  return profiles.find((profile) => profile.id === id);
}

/** The first profile whose preferred model is `model`. Used by the migration only. */
export function profileStartingWith(
  profiles: readonly ModelProfile[],
  model: ModelIdentity | null | undefined,
): ModelProfile | undefined {
  if (!model) return undefined;
  const key = modelKey(model);
  return profiles.find((profile) => profile.models[0] !== undefined && modelKey(profile.models[0]) === key);
}

/** A profile with this name, ignoring case. Names are unique, so at most one. */
export function profileByName(profiles: readonly ModelProfile[], name: string): ModelProfile | undefined {
  const wanted = name.trim().toLowerCase();
  return profiles.find((profile) => profile.name.trim().toLowerCase() === wanted);
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function readThinking(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

/**
 * Read a settings value of unknown provenance as profiles, dropping nothing
 * usable. A file edited by hand is read for what it does say.
 */
export function readModelProfilesValue(value: unknown): ModelProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: ModelProfile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.trim() === "") continue;
    if (typeof raw.name !== "string" || raw.name.trim() === "") continue;
    if (!Array.isArray(raw.models)) continue;
    const models: ProfileModelRef[] = [];
    const seen = new Set<string>();
    for (const model of raw.models) {
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      const { provider, id, thinking } = model as { provider?: unknown; id?: unknown; thinking?: unknown };
      if (typeof provider !== "string" || typeof id !== "string") continue;
      if (provider.trim() === "" || id.trim() === "") continue;
      const ref: ProfileModelRef = { provider: provider.trim(), id: id.trim() };
      const level = readThinking(thinking);
      if (level) ref.thinking = level;
      const key = modelKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(ref);
    }
    if (models.length === 0) continue;
    const description = typeof raw.description === "string" ? raw.description : undefined;
    profiles.push({
      id: raw.id.trim(),
      name: raw.name.trim(),
      ...(description !== undefined && description !== "" ? { description } : {}),
      models,
      origin: raw.origin === "seeded" ? "seeded" : "person",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    });
  }
  return profiles;
}

// ------------------------------------------------------------- the edit rules

/** One thing wrong with a person's profiles, written for that person. */
export interface ModelProfileIssue {
  /** Index into the profiles list; `-1` for a problem with the list itself. */
  profile: number;
  /** Index into that profile's models, when the problem is one model. */
  model?: number;
  /** The form field to attach the message to. */
  field?: "id" | "name" | "description" | "models" | "origin";
  message: string;
}

/**
 * Every rule a saved set of profiles must obey. The worker runs this before it
 * writes (authoritative) and the Settings screen runs the same function to draw
 * its messages, so the two cannot disagree.
 *
 * A model that no longer exists or whose provider is signed out is **not** an
 * issue: the profile is a person's intent, and dropping an entry because a
 * credential expired would be worse than carrying it. The runtime skips such a
 * model with a recorded reason instead.
 */
export function validateModelProfiles(value: unknown): ModelProfileIssue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [{ profile: -1, message: "Model profiles must be a list." }];
  const issues: ModelProfileIssue[] = [];
  if (value.length > MAX_MODEL_PROFILES) {
    issues.push({ profile: -1, message: `Keep it to ${MAX_MODEL_PROFILES} profiles or fewer.` });
  }
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push({ profile: index, message: "A profile must be an object." });
      return;
    }
    const entry = raw as Record<string, unknown>;
    if (!isModelProfileId(entry.id)) {
      issues.push({ profile: index, field: "id", message: "A profile needs an id this app generated." });
    } else if (ids.has(entry.id)) {
      issues.push({ profile: index, field: "id", message: "Two profiles cannot share an id." });
    } else {
      ids.set(entry.id, index);
    }

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name === "") {
      issues.push({ profile: index, field: "name", message: "Give this profile a name." });
    } else if (name.length > PROFILE_NAME_MAX) {
      issues.push({ profile: index, field: "name", message: `Keep the name to ${PROFILE_NAME_MAX} characters or fewer.` });
    } else if (names.has(name.toLowerCase())) {
      issues.push({ profile: index, field: "name", message: `Another profile is already called “${name}”.` });
    } else {
      names.set(name.toLowerCase(), index);
    }

    if (entry.description !== undefined && typeof entry.description !== "string") {
      issues.push({ profile: index, field: "description", message: "Make the description text." });
    } else if (typeof entry.description === "string" && entry.description.length > PROFILE_DESCRIPTION_MAX) {
      issues.push({
        profile: index,
        field: "description",
        message: `Keep the description to ${PROFILE_DESCRIPTION_MAX} characters or fewer.`,
      });
    }

    if (entry.origin !== undefined && entry.origin !== "seeded" && entry.origin !== "person") {
      issues.push({ profile: index, field: "origin", message: "A profile is either seeded or made by you." });
    }

    const models = entry.models;
    if (!Array.isArray(models)) {
      issues.push({ profile: index, field: "models", message: "A profile must name its models." });
      return;
    }
    if (models.length === 0) {
      issues.push({ profile: index, field: "models", message: "Add a model to this profile." });
    }
    if (models.length > MAX_PROFILE_MODELS) {
      issues.push({ profile: index, field: "models", message: `Keep a profile to ${MAX_PROFILE_MODELS} models or fewer.` });
    }
    const seen = new Map<string, number>();
    models.forEach((model, modelIndex) => {
      if (!model || typeof model !== "object" || Array.isArray(model)) {
        issues.push({ profile: index, model: modelIndex, message: "A model needs a provider and a model id." });
        return;
      }
      const { provider, id, thinking } = model as { provider?: unknown; id?: unknown; thinking?: unknown };
      if (typeof provider !== "string" || provider.trim() === "" || typeof id !== "string" || id.trim() === "") {
        issues.push({ profile: index, model: modelIndex, message: "A model needs a provider and a model id." });
        return;
      }
      if (thinking !== undefined && readThinking(thinking) === undefined) {
        issues.push({ profile: index, model: modelIndex, message: "Choose a thinking level this app offers." });
        return;
      }
      const key = modelKey({ provider, id });
      if (seen.has(key)) {
        issues.push({ profile: index, model: modelIndex, message: `${id} is already in this profile.` });
        return;
      }
      seen.set(key, modelIndex);
    });
  });
  return issues;
}

// ------------------------------------------------------------- seeding

/**
 * The rule Laser uses to fill the three seeded profiles from what a person has
 * just connected — the same rule onboarding has always used to propose a model,
 * kept in one place so the seeds, the migration and onboarding cannot disagree.
 *
 * It is deliberately coarse: price is the only comparable signal every
 * provider's catalogue carries, and a model id that names the fast tier of its
 * family is the only other one. Nothing here is a benchmark, and none of it is
 * applied silently — a person reviews the seeds and edits them.
 */

/** Model ids that name the fast tier of their family. `gpt-5*` counts unless it is a `pro` variant. */
const FAST_TIER = /luna|sonnet|flash|mini|o4-mini|gpt-5(?!.*pro)/i;
/** Combined list price (input + output, per million tokens) of the mid-to-low band. */
const BAND_MIN = 0.2;
const BAND_MAX = 6;
/** A seeded profile is a starting point, not an inventory. */
export const SEEDED_PROFILE_MODELS_MAX = 4;

export interface ProfileSeedOptions {
  /**
   * Providers a credential is configured for. When given, only their models
   * qualify: a catalogue lists every model the engine knows, including ones
   * nobody has signed in to.
   */
  configuredProviders?: ReadonlySet<string>;
}

function combinedCost(entry: ModelCatalogEntry): number | undefined {
  const input = entry.cost?.input;
  const output = entry.cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return input + output;
}

const byName = (a: ModelCatalogEntry, b: ModelCatalogEntry) =>
  a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);

function usableModels(entries: readonly ModelCatalogEntry[], options: ProfileSeedOptions): ModelCatalogEntry[] {
  return entries.filter(
    (entry) => entry.enabled && (options.configuredProviders === undefined || options.configuredProviders.has(entry.provider)),
  );
}

function identity(entry: ModelCatalogEntry): ModelIdentity {
  return { provider: entry.provider, id: entry.id };
}

/**
 * The model a balanced, everyday profile should prefer: a fast-tier model in
 * the mid-to-low price band (the priciest of them, so the most capable of the
 * fast tier), else the median-priced usable model, else nothing.
 */
export function suggestBalancedModel(
  entries: readonly ModelCatalogEntry[],
  options: ProfileSeedOptions = {},
): ModelIdentity | null {
  const usable = usableModels(entries, options);
  if (usable.length === 0) return null;
  const priced = usable
    .map((entry) => ({ entry, cost: combinedCost(entry) }))
    .filter((item): item is { entry: ModelCatalogEntry; cost: number } => item.cost !== undefined)
    .sort((a, b) => a.cost - b.cost || byName(a.entry, b.entry));
  const fast = priced.filter(({ entry, cost }) => FAST_TIER.test(entry.id) && cost >= BAND_MIN && cost <= BAND_MAX);
  const pick = fast.length > 0
    ? fast[fast.length - 1]!.entry
    : priced.length > 0
      ? priced[Math.floor((priced.length - 1) / 2)]!.entry
      : [...usable].sort(byName)[0]!;
  return identity(pick);
}

/**
 * The ordered model list each seeded profile starts with. Empty lists when
 * nothing is connected: seeds are never invented from models a person cannot
 * reach.
 */
export function suggestSeededProfileModels(
  entries: readonly ModelCatalogEntry[],
  options: ProfileSeedOptions = {},
): Record<SeededProfileName, ModelIdentity[]> {
  const usable = usableModels(entries, options);
  if (usable.length === 0) return { Smart: [], Balanced: [], Fast: [] };

  const costOf = new Map(usable.map((entry) => [modelKey(entry), combinedCost(entry)] as const));
  const cost = (entry: ModelCatalogEntry): number | undefined => costOf.get(modelKey(entry));

  // Most capable first. Price is the proxy every catalogue carries; a model
  // that reasons wins a tie, and a model with no price sorts last because
  // nothing can be said about it.
  const smart = [...usable].sort((a, b) => {
    const ac = cost(a);
    const bc = cost(b);
    if (ac === undefined && bc === undefined) return byName(a, b);
    if (ac === undefined) return 1;
    if (bc === undefined) return -1;
    return bc - ac || Number(b.reasoning ?? false) - Number(a.reasoning ?? false) || byName(a, b);
  });

  // Cheapest first, with the fast tier ahead of anything priced the same.
  const fast = [...usable].sort((a, b) => {
    const ac = cost(a);
    const bc = cost(b);
    const fa = FAST_TIER.test(a.id) ? 0 : 1;
    const fb = FAST_TIER.test(b.id) ? 0 : 1;
    if (ac === undefined && bc === undefined) return fa - fb || byName(a, b);
    if (ac === undefined) return 1;
    if (bc === undefined) return -1;
    return fa - fb || ac - bc || byName(a, b);
  });

  const balancedPrimary = suggestBalancedModel(entries, options);
  const primaryKey = balancedPrimary ? modelKey(balancedPrimary) : undefined;
  const primaryCost = usable.find((entry) => modelKey(entry) === primaryKey);
  const anchor = primaryCost ? cost(primaryCost) : undefined;
  // Around the balanced pick: the models whose price is nearest to it.
  const balanced = [...usable].sort((a, b) => {
    if (modelKey(a) === primaryKey) return -1;
    if (modelKey(b) === primaryKey) return 1;
    const ac = cost(a);
    const bc = cost(b);
    if (anchor === undefined || (ac === undefined && bc === undefined)) return byName(a, b);
    if (ac === undefined) return 1;
    if (bc === undefined) return -1;
    return Math.abs(ac - anchor) - Math.abs(bc - anchor) || byName(a, b);
  });

  const take = (list: readonly ModelCatalogEntry[]): ModelIdentity[] =>
    list.slice(0, SEEDED_PROFILE_MODELS_MAX).map(identity);
  return { Smart: take(smart), Balanced: take(balanced), Fast: take(fast) };
}

// -------------------------------------------------------------- the live state

/**
 * A profile bound to one session.
 *
 * `models` is the snapshot taken when the profile activated, so a later edit
 * cannot re-order a conversation that is already running. `position` is the
 * index of the model that is selected now. `id` fences stale work against a
 * person's own choice.
 */
export interface FallbackActivation {
  id: string;
  /** The profile's stable id. The activation's identity; never changes. */
  profileId: string;
  /** The profile's models, exactly as they were when it activated. */
  models: ProfileModelRef[];
  position: number;
  startedAt: string;
}

/** One candidate tried while a session moved through its profile. */
export interface FallbackAttempt {
  /** `provider/id`, lower-cased. */
  model: string;
  at: string;
  outcome: "failed" | "succeeded" | "skipped";
  class?: ProviderFailureClass;
  /** Why it was skipped, in words a person can read. Never a provider payload. */
  reason?: string;
}

/** One traversal, opened by one eligible failure and closed by a success or exhaustion. */
export interface FallbackEvent {
  id: string;
  startedAt: string;
  attempts: FallbackAttempt[];
  /** Set when the event ended; absent while it is in flight. */
  endedAt?: string;
  ended?: "switched" | "returned" | "exhausted" | "aborted";
}

/** What this activation remembers about one model. Times are absolute instants. */
export interface FallbackModelMemory {
  lastFailure?: { class: ProviderFailureClass; at: string };
  /** Laser's own conservative cooldown. */
  cooldownUntil?: string;
  /** A provider-stated recovery instant. Only ever set from a header a provider sent. */
  knownResetAt?: string;
  /** Will not fix itself while this activation lasts. Cleared only by a manual choice. */
  nonTransient?: boolean;
}

export type FallbackEntryEvent =
  | "activated"
  | "switched"
  | "returned"
  | "attempt_failed"
  | "exhausted"
  | "cleared";

/**
 * The durable record. Appended on every transition; the **last** one is the
 * state, and the ones carrying `from`/`to` are what the transcript draws.
 */
export interface SessionFallbackEntry {
  version: 1;
  event: FallbackEntryEvent;
  at: string;
  from?: ModelIdentity;
  to?: ModelIdentity;
  failure?: { class: ProviderFailureClass; at: string };
  /** Null when a pin or a missing profile cleared the activation. */
  activation: FallbackActivation | null;
  /** The traversal in flight or just closed; absent between events. */
  failover?: FallbackEvent;
  /** Activation memory, keyed by `provider/id`. */
  models: Record<string, FallbackModelMemory>;
}

/**
 * A record written before M22, kept readable as history.
 *
 * Sessions written by the previous generation keyed their activation by the
 * first model of a chain. Those entries are read so a conversation's history
 * still renders, and they are **never** re-activated: the session has no
 * profile and displays as pinned (`docs/model-profiles.md`, "Migration").
 */
export interface LegacyChainActivation {
  id: string;
  chainKey: string;
  models: ModelIdentity[];
  position: number;
  startedAt: string;
}

/** True when a persisted activation is a pre-M22 one, keyed by a chain. */
export function isLegacyChainActivation(value: unknown): value is LegacyChainActivation {
  return (
    !!value
    && typeof value === "object"
    && typeof (value as { chainKey?: unknown }).chainKey === "string"
    && (value as { profileId?: unknown }).profileId === undefined
  );
}

/** The custom entry type the worker writes {@link SessionFallbackEntry} under. */
export const SESSION_FALLBACK_ENTRY_TYPE = `${WIRE_NAMESPACE}/fallback`;

/** Laser's own cooldown for a transient failure, when the provider stated nothing. */
export const FALLBACK_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- migration

/** The file the one-way migration writes its preview under, in the state directory. */
export const MODEL_PROFILE_MIGRATION_RECORD = "model-profiles-migration.json";

/**
 * One model a pre-M22 surface was set to, on its way to becoming a profile.
 *
 * The host holds these — a built-in agent's model choice, an agent file's
 * `model:` field — and only the worker may write the global settings file, so
 * they travel with the migration request and come back resolved to profile
 * ids (`docs/model-profiles.md`, "Migration").
 */
export interface LegacyModelChoice {
  /** The caller's own key for this choice: a built-in's name, a file path. */
  key: string;
  /** What a profile created for it is named after: the built-in, or the agent. */
  label: string;
  model: ModelIdentity;
}

/** Enough for every built-in and every definition a person could plausibly own. */
export const MAX_LEGACY_MODEL_CHOICES = 500;

/** The settings half of the migration: what the worker wrote, and why. */
export interface ModelProfileMigrationReport {
  /**
   * False when profiles already existed. The migration is one-way and
   * idempotent: it reads the old keys, writes the new ones once, and leaves
   * the old keys in place for one release (D-346).
   */
  ran: boolean;
  profiles: ModelProfile[];
  assignments: ProfileAssignments;
  /** One sentence per thing it did, for the preview a person reads. */
  notes: string[];
  /**
   * Each {@link LegacyModelChoice} key mapped to the profile it became — the
   * one that already preferred that model, or the one created for it. Present
   * whether or not anything was written: a second run resolves the same keys
   * to the same profiles and writes nothing.
   */
  resolved?: Record<string, string>;
}

/** The whole preview record, written once by the authority that owns the state directory. */
export interface ModelProfileMigrationRecord {
  version: 1;
  at: string;
  settings: ModelProfileMigrationReport;
  /**
   * Model choices the app itself held before profiles existed, and the profile
   * each became. `from` is the model, written as `provider/id`. Retained
   * because a record written by the M22 migration must stay readable.
   */
  builtins?: Array<{ name: string; from: string | null; to: string | null }>;
  /** Definition files whose `model:` became `profile:`. Only files actually rewritten. */
  agentFiles?: Array<{ path: string; from: string | null; to: string | null; note?: string }>;
}

// ------------------------------------------------------------------ methods

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * Every profile, and which surface uses which. Read-only, so any reach may
     * ask: a phone draws the same picker the desktop does.
     */
    "models/profiles/list": {
      params: { cwd?: string };
      result: { profiles: ModelProfile[]; assignments: ProfileAssignments };
    };
    /**
     * Create or replace one profile, by id. The whole profile is sent; the
     * writer stamps `updatedAt` and validates the whole list before writing.
     */
    "models/profiles/save": {
      params: { cwd?: string; profile: ModelProfileInput };
      result: { profiles: ModelProfile[]; assignments: ProfileAssignments };
    };
    /**
     * Delete one profile. A profile something still points at may only be
     * deleted with `replacementId`, which every reference is moved to in the
     * same write — a delete never leaves a dangling id.
     */
    "models/profiles/delete": {
      params: { cwd?: string; id: string; replacementId?: string };
      result: { profiles: ModelProfile[]; assignments: ProfileAssignments };
    };
    /**
     * Run the one-way settings migration and answer with what it did.
     *
     * Host → worker only: profiles are written to the global settings file
     * through `SettingsManager`, which lives in the worker, and the record a
     * person reviews is written by the authority that owns the state
     * directory. Idempotent — a second call reports `ran: false`.
     */
    "models/profiles/migrate": {
      params: { cwd: string; legacyChoices?: LegacyModelChoice[] };
      result: { report: ModelProfileMigrationReport };
    };
    /** Re-anchor one session to a profile: it continues on that profile's first model. */
    "session/profile/set": { params: { path: string; profileId: string }; result: { state: SessionState } };
    /**
     * Pin one session to one model, with nothing to move to. The deliberate
     * escape hatch of `docs/model-profiles.md` "Per-session override"; it
     * creates no profile and is never the default path.
     */
    "session/model/pin": { params: { path: string; model: ModelRef }; result: { state: SessionState } };
  }

  interface HostNotifications {
    /**
     * A first provider is connected and Laser filled the seeded profiles from
     * what it offers. The client shows them for review; nothing is pending.
     */
    "models/profiles/seeded": { profiles: ModelProfile[] };
  }
}
