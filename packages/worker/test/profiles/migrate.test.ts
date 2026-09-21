/**
 * M22-T2 · the one-way migration onto Model Profiles, and the seeds.
 *
 * Three fixtures, because three files exist in the world: a settings file the
 * previous generation wrote, an empty one, and one a half-finished migration
 * left behind. Every case runs through the real `SettingsAdapter`, so what is
 * asserted is the file on disk, not a plan in memory.
 */
import { PRODUCT_NAME, type ModelCatalogEntry } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsAdapter, readModelProfiles, readProfileAssignments } from "../../src/settings.js";
import { migrateModelProfiles, planModelProfileMigration } from "../../src/profiles/migrate.js";
import { newProfileId, seededProfiles } from "../../src/profiles/seeds.js";

let base: string;
let cwd: string;
let agentDir: string;
let ids = 0;

const AT = "2026-09-21T10:00:00.000Z";
const nextId = () => `mp_testmigration${String(++ids).padStart(8, "0")}`;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-migrate-`));
  cwd = join(base, "project");
  agentDir = join(base, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  ids = 0;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const adapter = () => new SettingsAdapter({ cwd, agentDir });
const writeGlobal = (doc: unknown) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(doc, null, 2), "utf8");
const readGlobal = (): Record<string, unknown> => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;

function entry(provider: string, id: string, cost?: { input: number; output: number }): ModelCatalogEntry {
  return {
    provider,
    id,
    name: id,
    contextWindow: 200_000,
    reasoning: false,
    vision: false,
    thinkingLevels: ["off"],
    enabled: true,
    ...(cost ? { cost } : {}),
  };
}

/** What a person who has connected two providers has, priced across the band. */
const CATALOGUE: ModelCatalogEntry[] = [
  entry("anthropic", "claude-opus-4", { input: 15, output: 75 }),
  entry("anthropic", "claude-sonnet-4-5", { input: 3, output: 15 }),
  entry("openai", "gpt-5-mini", { input: 0.25, output: 2 }),
  entry("openai", "gpt-5-nano", { input: 0.05, output: 0.4 }),
  entry("gone", "unreachable", { input: 1, output: 1 }),
];
const CONNECTED = new Set(["anthropic", "openai"]);

/** A settings file as the generation before profiles wrote it. */
const ZERO_ELEVEN = {
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-4-5",
  defaultThinkingLevel: "medium",
  modelThinkingLevels: { "openai/gpt-5-mini": "low" },
  steeringMode: "all",
  fallbackChains: [
    { models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }, { provider: "openai", id: "gpt-5-mini" }] },
    { models: [{ provider: "openai", id: "gpt-5-nano" }, { provider: "anthropic", id: "claude-opus-4" }] },
  ],
};

describe("migrating a 0.11-era settings file", () => {
  it("turns the saved model lists into profiles and points every surface at one", async () => {
    writeGlobal(ZERO_ELEVEN);
    const report = await migrateModelProfiles(adapter(), {
      at: AT,
      models: CATALOGUE,
      configuredProviders: CONNECTED,
      newId: nextId,
      modelName: (model) => CATALOGUE.find((item) => item.provider === model.provider && item.id === model.id)?.name,
    });

    expect(report.ran).toBe(true);
    const profiles = readModelProfiles(agentDir);
    expect(profiles.map((profile) => profile.name)).toEqual(["claude-sonnet-4-5 profile", "gpt-5-nano profile"]);
    expect(profiles.every((profile) => profile.origin === "person")).toBe(true);

    // Each list keeps its order, and the thinking levels are folded into the
    // entries they belonged to: the per-model one wins, the shared one stands in.
    expect(profiles[0]!.models).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
      { provider: "openai", id: "gpt-5-mini", thinking: "low" },
    ]);
    expect(profiles[1]!.models).toEqual([
      { provider: "openai", id: "gpt-5-nano", thinking: "medium" },
      { provider: "anthropic", id: "claude-opus-4", thinking: "medium" },
    ]);

    // The model new conversations started on already begins a profile, so no
    // second "Default" profile is invented for it.
    const assignments = readProfileAssignments(agentDir);
    expect(assignments.defaultProfileId).toBe(profiles[0]!.id);
    expect(assignments.namingProfileId).toBe(profiles[0]!.id);
    expect(assignments.oracleProfileId).toBe(profiles[0]!.id);
    expect(assignments.designIndexProfileId).toBe(profiles[0]!.id);

    // The old keys are left exactly as they were: rolling the app back reads
    // them unchanged for one release (D-346).
    const file = readGlobal();
    expect(file.fallbackChains).toEqual(ZERO_ELEVEN.fallbackChains);
    expect(file.defaultProvider).toBe("anthropic");
    expect(file.defaultModel).toBe("claude-sonnet-4-5");
    expect(file.defaultThinkingLevel).toBe("medium");
    expect(file.modelThinkingLevels).toEqual({ "openai/gpt-5-mini": "low" });
    expect(file.steeringMode).toBe("all");

    // Idempotent: a second run says there was nothing left to do and writes
    // nothing, so a worker start is not a settings rewrite.
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    const again = await migrateModelProfiles(adapter(), { at: AT, models: CATALOGUE, configuredProviders: CONNECTED, newId: nextId });
    expect(again.ran).toBe(false);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
  });

  it("creates one profile for a default model no saved list began with", async () => {
    writeGlobal({
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
      fallbackChains: [{ models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }, { provider: "openai", id: "gpt-5-nano" }] }],
    });
    await migrateModelProfiles(adapter(), { at: AT, models: CATALOGUE, configuredProviders: CONNECTED, newId: nextId });
    const profiles = readModelProfiles(agentDir);
    expect(profiles.map((profile) => profile.name)).toEqual(["claude-sonnet-4-5 profile", "Default"]);
    expect(profiles[1]!.models).toEqual([{ provider: "openai", id: "gpt-5-mini" }]);
    expect(readProfileAssignments(agentDir).defaultProfileId).toBe(profiles[1]!.id);
  });
});

describe("migrating a settings file with nothing in it", () => {
  it("seeds Smart, Balanced and Fast from the models that are actually connected", async () => {
    writeGlobal({});
    const report = await migrateModelProfiles(adapter(), {
      at: AT,
      models: CATALOGUE,
      configuredProviders: CONNECTED,
      newId: nextId,
    });

    expect(report.ran).toBe(true);
    const profiles = readModelProfiles(agentDir);
    expect(profiles.map((profile) => profile.name)).toEqual(["Smart", "Balanced", "Fast"]);
    expect(profiles.every((profile) => profile.origin === "seeded")).toBe(true);
    // A provider nobody signed in to is never seeded into a profile.
    expect(JSON.stringify(profiles)).not.toContain("unreachable");
    // Smart prefers the most capable, Fast the cheapest of the fast tier.
    expect(profiles[0]!.models[0]).toEqual({ provider: "anthropic", id: "claude-opus-4" });
    expect(profiles[2]!.models[0]).toEqual({ provider: "openai", id: "gpt-5-nano" });
    // And each seed has somewhere to move to when its first model stops.
    expect(profiles.every((profile) => profile.models.length > 1)).toBe(true);

    const assignments = readProfileAssignments(agentDir);
    expect(assignments.defaultProfileId).toBe(profiles[1]!.id);
    expect(assignments.namingProfileId).toBe(profiles[2]!.id);
    expect(assignments.oracleProfileId).toBe(profiles[0]!.id);
    expect(assignments.designIndexProfileId).toBe(profiles[0]!.id);
    expect(report.notes.join(" ")).toContain("Smart");
  });

  it("writes nothing at all when nothing is connected yet", async () => {
    writeGlobal({});
    const report = await migrateModelProfiles(adapter(), { at: AT, models: [], newId: nextId });
    expect(report.ran).toBe(false);
    expect(readModelProfiles(agentDir)).toEqual([]);
    // A seeded profile with no model is a dead end in every picker that would
    // offer it; onboarding asks for a provider instead.
    expect(readGlobal()).toEqual({});
  });
});

describe("migrating a file a half-finished migration left behind", () => {
  it("keeps the profiles it finds and only fills the assignments that are missing", async () => {
    const existing = {
      id: "mp_testhalfdone0000000000",
      name: "Mine",
      models: [{ provider: "openai", id: "gpt-5-mini" }],
      origin: "person",
      updatedAt: "2026-09-20T09:00:00.000Z",
    };
    writeGlobal({
      ...ZERO_ELEVEN,
      modelProfiles: [existing],
      namingProfileId: existing.id,
      // A dangling assignment from a profile that was deleted mid-migration.
      oracleProfileId: "mp_testgone00000000000000",
    });

    const report = await migrateModelProfiles(adapter(), { at: AT, models: CATALOGUE, configuredProviders: CONNECTED, newId: nextId });
    expect(report.ran).toBe(true);

    // The person's own profile is untouched — no second pass over the old
    // lists, and no re-ordering of what they already have.
    const profiles = readModelProfiles(agentDir);
    expect(profiles).toEqual([existing]);
    const assignments = readProfileAssignments(agentDir);
    expect(assignments.namingProfileId).toBe(existing.id);
    expect(assignments.defaultProfileId).toBe(existing.id);
    // The dangling id is replaced rather than carried: nothing points at a
    // profile that is not there.
    expect(assignments.oracleProfileId).toBe(existing.id);
    expect(assignments.designIndexProfileId).toBe(existing.id);
  });

  it("is a plan before it is a write, and the plan is empty when there is nothing to do", () => {
    const done = {
      modelProfiles: [{
        id: "mp_testcomplete0000000000",
        name: "Only",
        models: [{ provider: "openai", id: "gpt-5-mini" }],
        origin: "person",
        updatedAt: AT,
      }],
      defaultProfileId: "mp_testcomplete0000000000",
      namingProfileId: "mp_testcomplete0000000000",
      oracleProfileId: "mp_testcomplete0000000000",
      designIndexProfileId: "mp_testcomplete0000000000",
    };
    const plan = planModelProfileMigration({ doc: done, at: AT, newId: nextId });
    expect(plan.changes).toEqual([]);
    expect(plan.ran).toBe(false);
  });
});

describe("the seeds themselves", () => {
  it("gives every profile an id this app generated, and the same rule every time", () => {
    const first = seededProfiles(CATALOGUE, { configuredProviders: CONNECTED, at: AT, newId: nextId });
    ids = 0;
    const second = seededProfiles(CATALOGUE, { configuredProviders: CONNECTED, at: AT, newId: nextId });
    expect(first).toEqual(second);
    expect(newProfileId(0, () => 0)).toMatch(/^mp_[0-9A-Za-z]{26}$/);
    // Time-ordered, so a list written in one pass keeps the order it was written in.
    expect(newProfileId(1, () => 0) < newProfileId(2, () => 0)).toBe(true);
  });
});
