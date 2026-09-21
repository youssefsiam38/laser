/**
 * The profile design work runs on (M21-T14 follow-up).
 *
 * `docs/design-phase.md` ("Model profiles") sends three pieces of work to one
 * assignment: Index L1 synthesis, Foundation proposals and the Conform/Island
 * recommendation. `docs/model-profiles.md` gives that assignment
 * (`designIndexProfileId`) a default of Smart and records no opt-in exception
 * for it, so the ordinary inheritance rule applies **when nothing is
 * assigned**: the default for new sessions, then the first profile there is.
 *
 * What inheritance never does is override an explicit choice. A person who
 * assigned a profile to design work chose it; if that profile has no model in
 * it, or every model in it is spent, design work falls back to the parse and
 * to the neutral foundation and says *why* — it does not quietly run on some
 * other profile the person did not pick for this.
 *
 * Nothing here opens a connection or reads a credential: it reads the
 * settings file the same way session naming does, and hands back the profile
 * plus, when there is nothing to run on, one sentence a person can act on.
 */
import type { ModelProfile, ProfileAssignments } from "@lasercode/protocol";
import { readProfileSettings, resolveProfile } from "../settings.js";
import type { CompletionRuntime } from "../agents/session-naming.js";

/** Where the profile came from. */
export type DesignProfileSource =
  /** The person assigned this profile to design work. */
  | "assigned"
  /** Nothing is assigned to design work; this is the ordinary inheritance. */
  | "inherited"
  /** There is no profile to run design work on at all. */
  | "none";

export interface DesignProfileChoice {
  /** The profile design work runs on, or `null` when there is none. */
  profile: ModelProfile | null;
  source: DesignProfileSource;
  /**
   * Why design work has no model to run on, in one sentence. Present exactly
   * when there is nothing to run: no profile at all, or a profile with no
   * model in it. Never present when a model could be tried.
   */
  unavailable?: string;
}

/** True when this choice has at least one model to try. */
export function designProfileUsable(choice: DesignProfileChoice): boolean {
  return (choice.profile?.models.length ?? 0) > 0;
}

/** The machine has no profile at all — a fresh install with nothing connected. */
export const DESIGN_NO_PROFILE_SENTENCE = "No model profile is connected for design work.";

function emptyProfileSentence(profile: ModelProfile, source: DesignProfileSource): string {
  return source === "assigned"
    ? `“${profile.name}”, the profile assigned to design work, has no model in it.`
    : `“${profile.name}”, the profile this machine falls back to, has no model in it, and none is assigned to design work.`;
}

/**
 * The rule itself, over profiles and assignments that are already read.
 *
 * Pure, because the rule is what matters and the file is an accident of where
 * it is stored: an explicit assignment wins and is kept whatever it holds; an
 * absent one inherits; nothing at all is said as such.
 */
export function chooseDesignProfile(profiles: readonly ModelProfile[], assignments: ProfileAssignments): DesignProfileChoice {
  // `readProfileAssignments` answers `null` for an id that names no profile,
  // so an assignment that survives the read is a profile that exists. One
  // that was deleted is gone, not "unusable", and inherits like any absence.
  const assigned = assignments.designIndexProfileId;
  const explicit = assigned === null ? undefined : profiles.find((candidate) => candidate.id === assigned);
  if (explicit) {
    return explicit.models.length > 0
      ? { profile: explicit, source: "assigned" }
      : { profile: explicit, source: "assigned", unavailable: emptyProfileSentence(explicit, "assigned") };
  }
  const inherited = resolveProfile(profiles, assignments, "designIndexProfileId");
  if (!inherited) return { profile: null, source: "none", unavailable: DESIGN_NO_PROFILE_SENTENCE };
  return inherited.models.length > 0
    ? { profile: inherited, source: "inherited" }
    : { profile: inherited, source: "inherited", unavailable: emptyProfileSentence(inherited, "inherited") };
}

/**
 * Read the profile design work should use right now.
 *
 * Never throws: a settings file that cannot be read leaves design work on the
 * parse and the neutral foundation, which is a working state, rather than
 * failing a build or a tool call.
 */
export function designProfileChoice(agentDir: string): DesignProfileChoice {
  let profiles: readonly ModelProfile[];
  let assignments: ProfileAssignments;
  try {
    ({ profiles, assignments } = readProfileSettings(agentDir));
  } catch {
    return { profile: null, source: "none", unavailable: DESIGN_NO_PROFILE_SENTENCE };
  }
  return chooseDesignProfile(profiles, assignments);
}

/** What both design engines take: the models, the profile, and the honest why. */
export interface DesignModelAccess {
  models: () => Promise<CompletionRuntime>;
  profile: ModelProfile | null;
  unavailable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The access a build or a tool call runs with, resolved at the moment it is
 * asked for so a profile assigned in Settings while the worker is running
 * counts on the next call.
 */
export function designModelAccess(options: { agentDir: string; models: () => Promise<CompletionRuntime> }): DesignModelAccess {
  const choice = designProfileChoice(options.agentDir);
  return {
    models: options.models,
    profile: choice.profile,
    ...(choice.unavailable !== undefined ? { unavailable: choice.unavailable } : {}),
  };
}
