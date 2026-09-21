/**
 * The one-way migration onto Model Profiles (`docs/model-profiles.md`,
 * "Migration"; D-346).
 *
 * It reads the keys the previous generation wrote — the person's fallback
 * lists, the default provider and model, the thinking levels — and writes the
 * profiles and assignments that replace them. It runs through `SettingsManager`
 * like every other settings write, it is idempotent, and it **leaves the old
 * keys in place** for one release so rolling the app back reads them unchanged.
 *
 * The planner below is pure: settings in, changes and a report out. The writer
 * underneath it is the only part that touches a file, and it writes nothing
 * when the plan is empty — a settings file must not be rewritten on every
 * worker start.
 */

import {
  EMPTY_PROFILE_ASSIGNMENTS,
  DEFAULT_PROFILE_SETTING,
  DESIGN_INDEX_PROFILE_SETTING,
  MODEL_PROFILES_SETTING,
  NAMING_PROFILE_SETTING,
  ORACLE_PROFILE_SETTING,
  PRODUCT_NAME,
  PROFILE_NAME_MAX,
  modelKey,
  profileById,
  profileByName,
  profileStartingWith,
  type LegacyModelChoice,
  type ModelCatalogEntry,
  type ModelIdentity,
  type ModelProfile,
  type ModelProfileMigrationReport,
  type ProfileAssignments,
  type ProfileModelRef,
  type SettingChange,
  type ThinkingLevel,
} from "@lasercode/protocol";

import { assignmentsFromDoc, profilesFromDoc, type SettingsAdapter } from "../settings.js";
import { newProfileId, seededProfiles } from "./seeds.js";

type Doc = Record<string, unknown>;

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface MigrationInput {
  /** The global settings file as it stands. Never a project file: profiles are global. */
  doc: Doc;
  /** The catalogue the seeds are drawn from; empty means nothing is connected yet. */
  models?: readonly ModelCatalogEntry[];
  configuredProviders?: ReadonlySet<string>;
  at: string;
  newId?: () => string;
  /** A model's catalogue name, for the profiles the old lists become. */
  modelName?: (model: ModelIdentity) => string | undefined;
  /**
   * The model choices the host holds — each built-in's model, each agent
   * file's `model:` — which only this writer can turn into profiles.
   */
  legacyChoices?: readonly LegacyModelChoice[];
}

export interface MigrationPlan extends ModelProfileMigrationReport {
  /** Empty when the settings file already says everything this migration would. */
  changes: SettingChange[];
}

/**
 * What the migration would do, without doing it.
 *
 * Every branch is idempotent by construction: it reads what is already there
 * first, and only names the gaps. Running it twice on the same file produces
 * an empty change list the second time.
 */
export function planModelProfileMigration(input: MigrationInput): MigrationPlan {
  const { doc, at } = input;
  const newId = input.newId ?? (() => newProfileId());
  const notes: string[] = [];
  const existing = profilesFromDoc(doc);
  const profiles: ModelProfile[] = existing.map((profile) => ({ ...profile, models: profile.models.map((m) => ({ ...m })) }));
  const createdProfiles = profiles.length === 0;

  const thinkingFor = thinkingReader(doc);
  const withThinking = (model: ModelIdentity): ProfileModelRef => {
    const thinking = thinkingFor(model);
    return thinking ? { ...model, thinking } : { ...model };
  };

  // 1. The person's own ordered lists become profiles, named after the model
  //    each one prefers. The name is editable; the order is theirs.
  if (createdProfiles) {
    for (const models of legacyModelLists(doc)) {
      const first = models[0];
      if (!first) continue;
      const label = input.modelName?.(first) ?? first.id;
      profiles.push({
        id: newId(),
        name: uniqueName(profiles, `${label} profile`),
        models: models.map(withThinking),
        origin: "person",
        updatedAt: at,
      });
    }
    if (profiles.length > 0) {
      notes.push(
        profiles.length === 1
          ? "Your saved model list became a profile."
          : `Your ${profiles.length} saved model lists became profiles.`,
      );
    }
  }

  // 2. The default provider and model. A profile that already prefers that
  //    model *is* the default; otherwise one profile of one model is created.
  // The question is asked only while `defaultProfileId` is unset (D-h): once
  // this migration has written an assignment, or a person has chosen one, the
  // old key is history and is never read again — which is what makes a
  // half-migrated file converge instead of growing a profile per run.
  const startingModel = legacyDefaultModel(doc);
  let defaultProfile = profileById(profiles, readId(doc, DEFAULT_PROFILE_SETTING));
  if (!defaultProfile && startingModel) {
    defaultProfile = profileStartingWith(profiles, startingModel);
    if (!defaultProfile) {
      defaultProfile = {
        id: newId(),
        name: uniqueName(profiles, "Default"),
        models: [withThinking(startingModel)],
        origin: "person",
        updatedAt: at,
      };
      profiles.push(defaultProfile);
      notes.push(`The model new conversations started on became the profile “${defaultProfile.name}”.`);
    } else {
      notes.push(`New conversations start on “${defaultProfile.name}”, which already prefers that model.`);
    }
  }

  // 3. Nothing to migrate from: seed Smart, Balanced and Fast from whatever
  //    the person has connected, with the same rule onboarding uses.
  let seeded = false;
  if (profiles.length === 0) {
    const seeds = seededProfiles(input.models ?? [], {
      ...(input.configuredProviders ? { configuredProviders: input.configuredProviders } : {}),
      at,
      newId,
      thinkingFor,
    });
    if (seeds.length > 0) {
      profiles.push(...seeds);
      seeded = true;
      notes.push(`${PRODUCT_NAME} created ${seeds.map((profile) => `“${profile.name}”`).join(", ")} from the models you have connected.`);
    }
  }

  // 4. The model choices the host holds: a built-in's, an agent file's. Each
  //    becomes the profile that already prefers that model, or a new
  //    single-model profile named after whatever made the choice.
  const resolved: Record<string, string> = {};
  for (const choice of input.legacyChoices ?? []) {
    if (!choice.model.provider || !choice.model.id || resolved[choice.key]) continue;
    const match = profileStartingWith(profiles, choice.model);
    if (match) {
      resolved[choice.key] = match.id;
      continue;
    }
    const created: ModelProfile = {
      id: newId(),
      name: uniqueName(profiles, choice.label),
      models: [withThinking(choice.model)],
      origin: "person",
      updatedAt: at,
    };
    profiles.push(created);
    resolved[choice.key] = created.id;
    notes.push(`“${choice.label}” kept the model it was on, as the profile “${created.name}”.`);
  }

  const assignments = resolveAssignments(doc, profiles, defaultProfile);

  // 5. The changes themselves. A file that already says all of this gets none.
  const changes: SettingChange[] = [];
  const profilesChanged = JSON.stringify(stripped(existing)) !== JSON.stringify(stripped(profiles));
  if (profiles.length > 0 && profilesChanged) {
    changes.push({ path: MODEL_PROFILES_SETTING, op: "set", value: profiles });
  }
  for (const [key, value] of [
    [DEFAULT_PROFILE_SETTING, assignments.defaultProfileId],
    [NAMING_PROFILE_SETTING, assignments.namingProfileId],
    [ORACLE_PROFILE_SETTING, assignments.oracleProfileId],
    [DESIGN_INDEX_PROFILE_SETTING, assignments.designIndexProfileId],
  ] as const) {
    if (value && doc[key] !== value) changes.push({ path: key, op: "set", value });
  }

  if (changes.length > 0 && notes.length === 0) {
    notes.push("Your model choices were written as profile assignments.");
  }
  if (seeded) notes.push("Review the profiles and edit them however you like; nothing is fixed.");

  return {
    ran: changes.length > 0,
    profiles,
    assignments,
    notes,
    ...(Object.keys(resolved).length > 0 ? { resolved } : {}),
    changes,
  };
}

/**
 * Run the migration through the adapter's own write path, so it takes the same
 * lock and reloads live sessions like any other settings change.
 */
export async function migrateModelProfiles(
  settings: SettingsAdapter,
  options: Omit<MigrationInput, "doc">,
): Promise<ModelProfileMigrationReport> {
  await settings.refresh();
  const plan = planModelProfileMigration({ ...options, doc: settings.snapshot().global.values });
  // A resolution is an answer, not a change: the second run maps the same keys
  // to the same profiles and writes nothing, which is what makes the host's
  // half of the migration idempotent too.
  const resolved = plan.resolved ? { resolved: plan.resolved } : {};
  if (plan.changes.length === 0) {
    return { ran: false, profiles: plan.profiles, assignments: plan.assignments, notes: [], ...resolved };
  }
  await settings.apply("global", plan.changes);
  return { ran: true, profiles: plan.profiles, assignments: plan.assignments, notes: plan.notes, ...resolved };
}

// ---------------------------------------------------------------- internals

/** The old `fallbackChains` value, as ordered model lists. Anything else reads as nothing. */
function legacyModelLists(doc: Doc): ModelIdentity[][] {
  const raw = doc["fallbackChains"];
  if (!Array.isArray(raw)) return [];
  const lists: ModelIdentity[][] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const models = (entry as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    const seen = new Set<string>();
    const refs: ModelIdentity[] = [];
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const { provider, id } = model as { provider?: unknown; id?: unknown };
      if (typeof provider !== "string" || typeof id !== "string") continue;
      const ref = { provider: provider.trim(), id: id.trim() };
      if (ref.provider === "" || ref.id === "") continue;
      const key = modelKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
    if (refs.length > 0) lists.push(refs);
  }
  return lists;
}

function legacyDefaultModel(doc: Doc): ModelIdentity | undefined {
  const provider = doc["defaultProvider"];
  const id = doc["defaultModel"];
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  if (provider.trim() === "" || id.trim() === "") return undefined;
  return { provider: provider.trim(), id: id.trim() };
}

/** `modelThinkingLevels` first, then `defaultThinkingLevel`; neither is invented. */
function thinkingReader(doc: Doc): (model: ModelIdentity) => ThinkingLevel | undefined {
  const perModel = doc["modelThinkingLevels"];
  const map = new Map<string, ThinkingLevel>();
  if (perModel && typeof perModel === "object" && !Array.isArray(perModel)) {
    for (const [key, value] of Object.entries(perModel as Record<string, unknown>)) {
      if (typeof value === "string" && THINKING_LEVELS.includes(value)) map.set(key.toLowerCase(), value as ThinkingLevel);
    }
  }
  const fallbackLevel = doc["defaultThinkingLevel"];
  const shared = typeof fallbackLevel === "string" && THINKING_LEVELS.includes(fallbackLevel)
    ? (fallbackLevel as ThinkingLevel)
    : undefined;
  return (model) => map.get(modelKey(model)) ?? shared;
}

function readId(doc: Doc, key: string): string | undefined {
  const value = doc[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Which profile each surface ends up on.
 *
 * An assignment already in the file and still pointing at a real profile is
 * left alone — this migration never overrules a person's own choice. A gap is
 * filled by intent: naming prefers the quickest profile, a second opinion and
 * design synthesis prefer the most capable one, everything else the default.
 */
function resolveAssignments(
  doc: Doc,
  profiles: readonly ModelProfile[],
  preferredDefault: ModelProfile | undefined,
): ProfileAssignments {
  const current = assignmentsFromDoc(doc, profiles);
  const fallbackDefault =
    profileById(profiles, current.defaultProfileId)
    ?? preferredDefault
    ?? profileByName(profiles, "Balanced")
    ?? profiles[0];
  const quick = profileByName(profiles, "Fast") ?? fallbackDefault;
  const capable = profileByName(profiles, "Smart") ?? fallbackDefault;
  return {
    ...EMPTY_PROFILE_ASSIGNMENTS,
    defaultProfileId: current.defaultProfileId ?? fallbackDefault?.id ?? null,
    namingProfileId: current.namingProfileId ?? quick?.id ?? null,
    oracleProfileId: current.oracleProfileId ?? capable?.id ?? null,
    designIndexProfileId: current.designIndexProfileId ?? capable?.id ?? null,
  };
}

function uniqueName(profiles: readonly ModelProfile[], wanted: string): string {
  const trimmed = wanted.trim().slice(0, PROFILE_NAME_MAX) || "Profile";
  if (!profileByName(profiles, trimmed)) return trimmed;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${trimmed.slice(0, PROFILE_NAME_MAX - 4)} ${suffix}`;
    if (!profileByName(profiles, candidate)) return candidate;
  }
  return `${trimmed.slice(0, PROFILE_NAME_MAX - 8)} ${Date.now().toString(36)}`;
}

/** Compare what matters: ids, names, order and models — never a timestamp. */
function stripped(profiles: readonly ModelProfile[]): unknown {
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description ?? "",
    origin: profile.origin,
    models: profile.models,
  }));
}
