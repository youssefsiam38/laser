/**
 * What points at a profile, and the small edits the Model profiles tab makes
 * to one (`docs/model-profiles.md` "Assignments").
 *
 * Pure: no React, no client, no DOM. The tab draws the "used by" line from
 * here and the delete dialog decides from the same function, so a profile can
 * never be offered for deletion on one line and refused on the next. Tested in
 * test/settings/profile-usage.test.ts.
 */
import {
  DEFAULT_PROFILE_SETTING,
  DESIGN_INDEX_PROFILE_SETTING,
  NAMING_PROFILE_SETTING,
  ORACLE_PROFILE_SETTING,
  PROFILE_NAME_MAX,
  profileByName,
  type AgentDefinition,
  type BuiltinProfiles,
  type ModelProfile,
  type ProfileAssignments,
  type ProfileModelRef,
} from "@lasercode/protocol";

/** The four assignable surfaces, in the order the screen names them. */
export const ASSIGNMENT_LABELS: ReadonlyArray<{ setting: keyof ProfileAssignments; label: string; description: string }> = [
  {
    setting: DEFAULT_PROFILE_SETTING,
    label: "New conversations",
    description: "What a conversation you start runs on, unless its agent names its own.",
  },
  {
    setting: NAMING_PROFILE_SETTING,
    label: "Naming conversations",
    description: "One short request that gives a conversation its title.",
  },
  {
    setting: ORACLE_PROFILE_SETTING,
    label: "Consultation",
    description: "A second opinion asked in a fresh context, with no tools and no history.",
  },
  {
    setting: DESIGN_INDEX_PROFILE_SETTING,
    label: "Design index",
    description: "Reading a design and proposing foundations from it.",
  },
];

export interface ProfileUsage {
  /** One phrase per thing that points here, in the order the screen reads them. */
  labels: string[];
  /** True when deleting this profile has to move something somewhere else. */
  referenced: boolean;
}

/**
 * Everything that points at `profileId`, written as a person would say it.
 *
 * Built-ins count as agents while they exist: from the person's side a
 * built-in is an agent with a profile, and a "used by" line that leaves one
 * out would make a delete refuse for a reason the line did not mention.
 */
export function profileUsage(
  profileId: string,
  assignments: ProfileAssignments,
  agents: readonly AgentDefinition[] = [],
  builtins?: BuiltinProfiles | undefined,
): ProfileUsage {
  const labels: string[] = [];
  for (const { setting, label } of ASSIGNMENT_LABELS) {
    if (assignments[setting] === profileId) labels.push(label);
  }
  const named = agents.filter((agent) => agent.profileId === profileId).length
    + (builtins ? Object.values(builtins).filter((id) => id === profileId).length : 0);
  if (named > 0) labels.push(`${named} ${named === 1 ? "agent" : "agents"}`);
  return { labels, referenced: labels.length > 0 };
}

/** "Used by New conversations and 2 agents." — one sentence, or nothing at all. */
export function usageSentence(usage: ProfileUsage): string {
  if (usage.labels.length === 0) return "Nothing uses this profile yet.";
  if (usage.labels.length === 1) return `Used by ${usage.labels[0]}.`;
  const head = usage.labels.slice(0, -1).join(", ");
  return `Used by ${head} and ${usage.labels.at(-1)}.`;
}

/**
 * A name for the copy of `profile` that no other profile already has.
 *
 * "Balanced copy", then "Balanced copy 2" — never a duplicate, because a
 * duplicate is the one thing `validateModelProfiles` refuses outright, and a
 * Duplicate button that refuses is a Duplicate button that is broken.
 */
export function duplicateName(profiles: readonly ModelProfile[], name: string): string {
  const base = `${name} copy`.slice(0, PROFILE_NAME_MAX);
  if (!profileByName(profiles, base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${base.slice(0, PROFILE_NAME_MAX - suffix.length)}${suffix}`;
    if (!profileByName(profiles, candidate)) return candidate;
  }
  return base;
}

/** The list with `from` moved to `to`; unchanged when the move would fall off an end. */
export function moveModel(models: readonly ProfileModelRef[], from: number, to: number): ProfileModelRef[] {
  if (to < 0 || to >= models.length || from < 0 || from >= models.length || from === to) return [...models];
  const next = [...models];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** The profiles a delete may move references to: everything but the one going away. */
export function replacementCandidates(profiles: readonly ModelProfile[], deleting: string): ModelProfile[] {
  return profiles.filter((profile) => profile.id !== deleting);
}
