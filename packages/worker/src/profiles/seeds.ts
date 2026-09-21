/**
 * The three profiles Laser seeds, built from what a person has actually
 * connected (`docs/model-profiles.md`, "Domain" and "Migration").
 *
 * Seeds are ordinary profiles: renamable, reorderable, deletable. The only
 * thing special about them is that Laser wrote them first, so a person reaches
 * a working conversation without composing a list by hand.
 *
 * Pure: a catalogue in, profiles out. No clock (the caller stamps one), no
 * settings file, no engine.
 */

import {
  MODEL_PROFILE_ID_PREFIX,
  SEEDED_PROFILE_NAMES,
  suggestSeededProfileModels,
  type ModelCatalogEntry,
  type ModelProfile,
  type ProfileModelRef,
  type SeededProfileName,
} from "@lasercode/protocol";

/** What each seeded profile is for, in the words a person reads beside its name. */
export const SEEDED_PROFILE_DESCRIPTIONS: Readonly<Record<SeededProfileName, string>> = {
  Smart: "The most capable models you have connected, for work that needs the best answer.",
  Balanced: "Everyday work: capable enough for most things, quick enough to stay out of the way.",
  Fast: "Short, cheap requests — naming a conversation, a quick rewrite.",
};

/** Crockford's alphabet, as ULIDs use it. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A new profile id: `mp_` and a ULID.
 *
 * Time-ordered so a list written in one pass keeps the order it was written
 * in, and random enough that two machines editing the same synced file do not
 * collide. Ids are opaque everywhere else; this is the only place that knows
 * what one is made of.
 */
export function newProfileId(now: number = Date.now(), random: () => number = Math.random): string {
  let time = "";
  let remaining = Math.floor(now);
  for (let index = 0; index < 10; index++) {
    time = CROCKFORD[remaining % 32]! + time;
    remaining = Math.floor(remaining / 32);
  }
  let entropy = "";
  for (let index = 0; index < 16; index++) {
    entropy += CROCKFORD[Math.floor(random() * 32) % 32]!;
  }
  return `${MODEL_PROFILE_ID_PREFIX}${time}${entropy}`;
}

export interface SeedOptions {
  /** Providers a credential is configured for; without it every model qualifies. */
  configuredProviders?: ReadonlySet<string>;
  at: string;
  newId?: () => string;
  /** The thinking level saved for a model before profiles existed, if any. */
  thinkingFor?: (model: { provider: string; id: string }) => ProfileModelRef["thinking"];
}

/**
 * Smart, Balanced and Fast, filled from the catalogue.
 *
 * A seed with no model is not created: an empty profile is a dead end in every
 * picker that offers it, and a person who has connected nothing yet is asked
 * to connect a provider, not to review three empty lists.
 */
export function seededProfiles(entries: readonly ModelCatalogEntry[], options: SeedOptions): ModelProfile[] {
  const suggested = suggestSeededProfileModels(entries, {
    ...(options.configuredProviders ? { configuredProviders: options.configuredProviders } : {}),
  });
  const newId = options.newId ?? (() => newProfileId());
  const profiles: ModelProfile[] = [];
  for (const name of SEEDED_PROFILE_NAMES) {
    const models = suggested[name];
    if (models.length === 0) continue;
    profiles.push({
      id: newId(),
      name,
      description: SEEDED_PROFILE_DESCRIPTIONS[name],
      models: models.map((model) => {
        const thinking = options.thinkingFor?.(model);
        return thinking ? { ...model, thinking } : { ...model };
      }),
      origin: "seeded",
      updatedAt: options.at,
    });
  }
  return profiles;
}
