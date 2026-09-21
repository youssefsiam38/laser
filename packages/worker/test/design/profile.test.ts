/**
 * Which profile design work runs on (M21-T14 follow-up).
 *
 * `docs/model-profiles.md` gives `designIndexProfileId` a default and records
 * no opt-in exception, so an **absent** assignment inherits the ordinary way.
 * What is asserted hardest here is the other half: an **explicit** assignment
 * is never traded for another profile because it turned out to be empty — the
 * person chose it, and design work says why it has nothing to run on rather
 * than spending a profile they did not pick for this.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_PROFILE_ASSIGNMENTS, type ModelProfile, type ProfileAssignments } from "@lasercode/protocol";
import { chooseDesignProfile, designModelAccess, designProfileChoice, designProfileUsable } from "../../src/design/profile.js";
import type { CompletionRuntime } from "../../src/agents/session-naming.js";

let agentDir: string;

const SMART = "mp_smart00000000000000000";
const BALANCED = "mp_balanced00000000000000";
const EMPTY = "mp_empty00000000000000000";

function profile(id: string, name: string, models: Array<{ provider: string; id: string }>) {
  return { id, name, models, origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function settings(doc: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(doc));
}

const PROFILES = [
  profile(BALANCED, "Balanced", [{ provider: "p", id: "balanced-1" }]),
  profile(SMART, "Smart", [{ provider: "p", id: "smart-1" }]),
  profile(EMPTY, "Bare", []),
];

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "design-profile-"));
  mkdirSync(agentDir, { recursive: true });
});
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("the profile design work runs on", () => {
  it("uses the profile assigned to design work, not the default", () => {
    settings({ modelProfiles: PROFILES, defaultProfileId: BALANCED, designIndexProfileId: SMART });
    const choice = designProfileChoice(agentDir);
    expect(choice.profile?.id).toBe(SMART);
    expect(choice.source).toBe("assigned");
    expect(choice.unavailable).toBeUndefined();
    expect(designProfileUsable(choice)).toBe(true);
  });

  it("inherits the default when nothing is assigned to design work", () => {
    settings({ modelProfiles: PROFILES, defaultProfileId: BALANCED });
    const choice = designProfileChoice(agentDir);
    expect(choice.profile?.id).toBe(BALANCED);
    expect(choice.source).toBe("inherited");
    expect(choice.unavailable).toBeUndefined();
  });

  it("falls back to the first profile when there is no default either", () => {
    settings({ modelProfiles: PROFILES });
    const choice = designProfileChoice(agentDir);
    expect(choice.profile?.id).toBe(BALANCED);
    expect(choice.source).toBe("inherited");
  });

  it("inherits when the assigned profile was deleted, because it is gone, not unusable", () => {
    settings({ modelProfiles: PROFILES, defaultProfileId: BALANCED, designIndexProfileId: "mp_deleted0000000000000" });
    const choice = designProfileChoice(agentDir);
    expect(choice.profile?.id).toBe(BALANCED);
    expect(choice.source).toBe("inherited");
  });

  it("answers nothing, with a reason, when the machine has no profile at all", () => {
    settings({ modelProfiles: [] });
    const choice = designProfileChoice(agentDir);
    expect(choice.profile).toBeNull();
    expect(choice.source).toBe("none");
    expect(choice.unavailable).toContain("No model profile is connected");
  });

  it("never throws on a settings file that cannot be read", () => {
    writeFileSync(join(agentDir, "settings.json"), "{ not json");
    const choice = designProfileChoice(join(agentDir, "nowhere"));
    expect(choice.profile).toBeNull();
    expect(choice.unavailable).toContain("No model profile is connected");
    expect(designProfileChoice(agentDir).profile).toBeNull();
  });
});

/**
 * A profile with no model in it never survives the settings read, so the rule
 * is exercised where it lives: over profiles and assignments directly.
 */
describe("the rule, over profiles and assignments", () => {
  const bare = profile(EMPTY, "Bare", []) as ModelProfile;
  const balanced = profile(BALANCED, "Balanced", [{ provider: "p", id: "balanced-1" }]) as ModelProfile;
  const assign = (over: Partial<ProfileAssignments>): ProfileAssignments => ({ ...EMPTY_PROFILE_ASSIGNMENTS, ...over });

  it("keeps an assigned profile that has no model in it, and says so", () => {
    // The person chose "Bare" for design work. Running on "Balanced" instead
    // would be spending a profile they did not pick for this.
    const choice = chooseDesignProfile([balanced, bare], assign({ defaultProfileId: BALANCED, designIndexProfileId: EMPTY }));
    expect(choice.profile?.id).toBe(EMPTY);
    expect(choice.source).toBe("assigned");
    expect(designProfileUsable(choice)).toBe(false);
    expect(choice.unavailable).toContain("Bare");
    expect(choice.unavailable).toContain("assigned to design work");
  });

  it("says which profile it fell back to when that one is empty too", () => {
    const choice = chooseDesignProfile([bare], assign({ defaultProfileId: EMPTY }));
    expect(choice.source).toBe("inherited");
    expect(choice.unavailable).toContain("none is assigned to design work");
  });
});

describe("the access both design engines take", () => {
  it("carries the profile, the runtime and the honest reason together", async () => {
    settings({ modelProfiles: [], designIndexProfileId: SMART });
    const runtime = {} as CompletionRuntime;
    const access = designModelAccess({ agentDir, models: async () => runtime });
    expect(access.profile).toBeNull();
    expect(access.unavailable).toContain("No model profile is connected");
    expect(await access.models()).toBe(runtime);
  });

  it("is read again on the next call, so a profile assigned now counts", () => {
    settings({ modelProfiles: PROFILES });
    const models = async (): Promise<CompletionRuntime> => ({}) as CompletionRuntime;
    expect(designModelAccess({ agentDir, models }).profile?.id).toBe(BALANCED);
    settings({ modelProfiles: PROFILES, designIndexProfileId: SMART });
    expect(designModelAccess({ agentDir, models }).profile?.id).toBe(SMART);
  });
});
