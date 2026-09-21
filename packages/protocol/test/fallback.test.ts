import { describe, expect, it } from "vitest";

import {
  EMPTY_PROFILE_ASSIGNMENTS,
  FALLBACK_DEFAULT_COOLDOWN_MS,
  isLegacyChainActivation,
  isModelProfileId,
  MAX_PROFILE_MODELS,
  MODEL_PROFILES_SETTING,
  PROFILE_ASSIGNMENT_SETTINGS,
  PROFILE_NAME_MAX,
  modelKey,
  profileById,
  profileByName,
  profileStartingWith,
  readModelProfilesValue,
  sameModel,
  SEEDED_PROFILE_NAMES,
  SESSION_FALLBACK_ENTRY_TYPE,
  validateModelProfiles,
  type ModelProfile,
  type SessionFallbackEntry,
} from "../src/fallback.js";
import { WIRE_NAMESPACE } from "../src/identity.js";
import {
  clientParamsSchemas,
  modelProfileInputSchema,
  modelProfileSchema,
  sessionFallbackEntrySchema,
} from "../src/schemas.js";

const model = (provider: string, id: string) => ({ provider, id });

const profiles: ModelProfile[] = [
  {
    id: "mp_01jbalanced0000000000000",
    name: "Balanced",
    description: "Everyday work.",
    models: [
      model("anthropic", "claude-sonnet-4-5"),
      { ...model("deepseek", "deepseek-chat"), thinking: "high" },
      model("openrouter", "auto"),
    ],
    origin: "seeded",
    updatedAt: "2026-09-21T10:00:00.000Z",
  },
  {
    id: "mp_01jfast00000000000000000",
    name: "Fast",
    models: [model("deepseek", "deepseek-chat"), model("google", "gemini-2.5-pro")],
    origin: "seeded",
    updatedAt: "2026-09-21T10:00:00.000Z",
  },
];

describe("the profile domain", () => {
  it("is addressed by an opaque id that survives a rename", () => {
    expect(profileById(profiles, "mp_01jfast00000000000000000")).toBe(profiles[1]);
    const renamed = [{ ...profiles[1]!, name: "Quick" }, profiles[0]!];
    expect(profileById(renamed, "mp_01jfast00000000000000000")?.name).toBe("Quick");
    expect(profileById(profiles, "mp_missing000000000000000")).toBeUndefined();
    expect(profileById(profiles, null)).toBeUndefined();
  });

  it("knows a generated id from anything else", () => {
    expect(isModelProfileId("mp_01jfast00000000000000000")).toBe(true);
    expect(isModelProfileId("balanced")).toBe(false);
    expect(isModelProfileId("mp_short")).toBe(false);
    expect(isModelProfileId(42)).toBe(false);
  });

  it("finds by name without regard to case, and by preferred model for the migration only", () => {
    expect(profileByName(profiles, "  balanced ")).toBe(profiles[0]);
    expect(profileStartingWith(profiles, model("Anthropic", "Claude-Sonnet-4-5"))).toBe(profiles[0]);
    // DeepSeek is the second model of Balanced and the first of Fast.
    expect(profileStartingWith(profiles, model("deepseek", "deepseek-chat"))).toBe(profiles[1]);
    expect(profileStartingWith(profiles, model("openrouter", "auto"))).toBeUndefined();
  });

  it("keys models by provider and id, without regard to case, and nothing else", () => {
    expect(modelKey(model("OpenAI", "GPT-5"))).toBe("openai/gpt-5");
    expect(sameModel(model("a", "b"), model("A", "B"))).toBe(true);
    expect(sameModel(model("a", "b"), model("a", "c"))).toBe(false);
    expect(sameModel(undefined, model("a", "b"))).toBe(false);
  });

  it("names its settings key and its assignments once, for everyone", () => {
    expect(MODEL_PROFILES_SETTING).toBe("modelProfiles");
    expect([...PROFILE_ASSIGNMENT_SETTINGS]).toEqual([
      "defaultProfileId",
      "namingProfileId",
      "oracleProfileId",
      "designIndexProfileId",
    ]);
    expect(Object.keys(EMPTY_PROFILE_ASSIGNMENTS).sort()).toEqual([...PROFILE_ASSIGNMENT_SETTINGS].sort());
    expect([...SEEDED_PROFILE_NAMES]).toEqual(["Smart", "Balanced", "Fast"]);
  });
});

describe("profile validation", () => {
  it("accepts an empty configuration, which is where everyone starts", () => {
    expect(validateModelProfiles(undefined)).toEqual([]);
    expect(validateModelProfiles([])).toEqual([]);
    expect(validateModelProfiles(profiles)).toEqual([]);
  });

  it("accepts one model: a profile of one is a preference, not a broken list", () => {
    expect(
      validateModelProfiles([{ ...profiles[1]!, models: [model("openai", "gpt-5")] }]),
    ).toEqual([]);
  });

  it("asks for a name, and refuses two profiles with the same one", () => {
    expect(validateModelProfiles([{ ...profiles[0]!, name: "  " }])).toEqual([
      { profile: 0, field: "name", message: "Give this profile a name." },
    ]);
    expect(
      validateModelProfiles([profiles[0]!, { ...profiles[1]!, name: "balanced" }]),
    ).toEqual([{ profile: 1, field: "name", message: "Another profile is already called “balanced”." }]);
    expect(validateModelProfiles([{ ...profiles[0]!, name: "x".repeat(PROFILE_NAME_MAX + 1) }])).toEqual([
      { profile: 0, field: "name", message: `Keep the name to ${PROFILE_NAME_MAX} characters or fewer.` },
    ]);
  });

  it("refuses the same model twice in one profile", () => {
    const issues = validateModelProfiles([
      {
        ...profiles[0]!,
        models: [model("openai", "gpt-5"), model("deepseek", "deepseek-chat"), model("OpenAI", "GPT-5")],
      },
    ]);
    expect(issues).toEqual([{ profile: 0, model: 2, message: "GPT-5 is already in this profile." }]);
  });

  it("lets one model appear in as many profiles as a person likes", () => {
    expect(
      validateModelProfiles([
        { ...profiles[0]!, models: [model("openai", "gpt-5"), model("deepseek", "deepseek-chat")] },
        { ...profiles[1]!, models: [model("openai", "gpt-5"), model("google", "gemini-2.5-pro")] },
      ]),
    ).toEqual([]);
  });

  it("refuses shapes a person could not have meant", () => {
    expect(validateModelProfiles("profiles")).toEqual([{ profile: -1, message: "Model profiles must be a list." }]);
    expect(validateModelProfiles([1])).toEqual([{ profile: 0, message: "A profile must be an object." }]);
    expect(validateModelProfiles([{ ...profiles[0]!, id: "balanced" }])).toEqual([
      { profile: 0, field: "id", message: "A profile needs an id this app generated." },
    ]);
    expect(validateModelProfiles([profiles[0]!, { ...profiles[1]!, id: profiles[0]!.id }])).toEqual([
      { profile: 1, field: "id", message: "Two profiles cannot share an id." },
    ]);
    expect(validateModelProfiles([{ ...profiles[0]!, models: [{ provider: "openai", id: "" }] }])).toEqual([
      { profile: 0, model: 0, message: "A model needs a provider and a model id." },
    ]);
    expect(
      validateModelProfiles([{ ...profiles[0]!, models: [{ provider: "openai", id: "gpt-5", thinking: "ludicrous" }] }]),
    ).toEqual([{ profile: 0, model: 0, message: "Choose a thinking level this app offers." }]);
    const long = { ...profiles[0]!, models: Array.from({ length: MAX_PROFILE_MODELS + 1 }, (_, i) => model("p", `m${i}`)) };
    expect(validateModelProfiles([long])).toEqual([
      { profile: 0, field: "models", message: `Keep a profile to ${MAX_PROFILE_MODELS} models or fewer.` },
    ]);
  });

  it("never says a model that is no longer connected is a mistake", () => {
    // A profile is a person's intent. A signed-out provider is a runtime skip
    // with a recorded reason, not a validation failure that deletes the entry.
    expect(validateModelProfiles([{ ...profiles[0]!, models: [model("gone", "model-x")] }])).toEqual([]);
  });

  it("reads a file written by hand without throwing away what is usable", () => {
    expect(readModelProfilesValue("nonsense")).toEqual([]);
    expect(
      readModelProfilesValue([
        { id: " mp_01jread0000000000000000 ", name: "  Reads  ", models: [{ provider: " openai ", id: " gpt-5 " }, { provider: 1 }, { provider: "openai", id: "GPT-5" }] },
        { id: "mp_01jnomodels000000000000", name: "Empty", models: [] },
      ]),
    ).toEqual([
      {
        id: "mp_01jread0000000000000000",
        name: "Reads",
        models: [model("openai", "gpt-5")],
        origin: "person",
        updatedAt: "",
      },
    ]);
  });
});

describe("the wire shapes", () => {
  it("round-trips a profile and a save request through their strict schemas", () => {
    for (const profile of profiles) {
      expect(modelProfileSchema.parse(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    }
    const input = { ...profiles[0]!, updatedAt: undefined };
    delete (input as { updatedAt?: unknown }).updatedAt;
    expect(modelProfileInputSchema.parse(input)).toEqual(input);
    expect(() => modelProfileSchema.parse({ ...profiles[0]!, models: [] })).toThrow();
    expect(() => modelProfileSchema.parse({ ...profiles[0]!, origin: "vendor" })).toThrow();
    expect(() => modelProfileSchema.parse({ ...profiles[0]!, colour: "red" })).toThrow();
  });

  it("round-trips every new method's params and refuses what they do not mean", () => {
    const samples = {
      "models/profiles/list": { cwd: "/w" },
      "models/profiles/save": { profile: profiles[0]! },
      "models/profiles/delete": { id: profiles[0]!.id, replacementId: profiles[1]!.id },
      "session/profile/set": { path: "/s.jsonl", profileId: profiles[0]!.id },
      "session/model/pin": { path: "/s.jsonl", model: model("anthropic", "claude-sonnet-4-5") },
    } as const;
    for (const [method, params] of Object.entries(samples)) {
      const schema = clientParamsSchemas[method as keyof typeof clientParamsSchemas];
      expect(JSON.parse(JSON.stringify(schema.parse(params)))).toEqual(params);
    }
    // A profile is chosen by id, never by name, and never by a raw model.
    expect(clientParamsSchemas["session/profile/set"].safeParse({ path: "/s.jsonl", profileId: "Balanced" }).success).toBe(false);
    expect(clientParamsSchemas["models/profiles/delete"].safeParse({ id: profiles[0]!.id, replacementId: "none" }).success).toBe(false);
    expect(clientParamsSchemas["session/model/pin"].safeParse({ path: "/s.jsonl", profileId: profiles[0]!.id }).success).toBe(false);
  });

  it("no longer answers to the methods profiles replaced", () => {
    expect("agents/builtin/set-model" in clientParamsSchemas).toBe(false);
    expect("agents/namer/qualify" in clientParamsSchemas).toBe(false);
    expect("models/profiles/save" in clientParamsSchemas).toBe(true);
  });
});

describe("the durable record", () => {
  it("names its entry type from the wire namespace, never a literal", () => {
    expect(SESSION_FALLBACK_ENTRY_TYPE).toBe(`${WIRE_NAMESPACE}/fallback`);
  });

  it("round-trips a full entry through JSON and its schema", () => {
    const entry: SessionFallbackEntry = {
      version: 1,
      event: "switched",
      at: "2026-09-11T12:00:00.000Z",
      from: model("anthropic", "claude-sonnet-4-5"),
      to: model("deepseek", "deepseek-chat"),
      failure: { class: "rate_limit", at: "2026-09-11T11:59:58.000Z" },
      activation: {
        id: "act-1",
        profileId: profiles[0]!.id,
        models: profiles[0]!.models,
        position: 1,
        startedAt: "2026-09-11T11:40:00.000Z",
      },
      failover: {
        id: "fo-1",
        startedAt: "2026-09-11T11:59:58.000Z",
        attempts: [
          { model: "anthropic/claude-sonnet-4-5", at: "2026-09-11T11:59:58.000Z", outcome: "failed", class: "rate_limit" },
          { model: "deepseek/deepseek-chat", at: "2026-09-11T12:00:00.000Z", outcome: "succeeded" },
        ],
        endedAt: "2026-09-11T12:00:00.000Z",
        ended: "switched",
      },
      models: {
        "anthropic/claude-sonnet-4-5": {
          lastFailure: { class: "rate_limit", at: "2026-09-11T11:59:58.000Z" },
          cooldownUntil: "2026-09-11T12:04:58.000Z",
        },
        "openrouter/auto": { nonTransient: true, lastFailure: { class: "credits", at: "2026-09-11T11:50:00.000Z" } },
      },
    };
    expect(sessionFallbackEntrySchema.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  it("still reads a record written before profiles existed, as history", () => {
    const legacy = {
      version: 1,
      event: "switched",
      at: "2026-09-11T12:00:00.000Z",
      activation: {
        id: "act-0",
        chainKey: "anthropic/claude-sonnet-4-5",
        models: [model("anthropic", "claude-sonnet-4-5"), model("deepseek", "deepseek-chat")],
        position: 1,
        startedAt: "2026-09-11T11:40:00.000Z",
      },
      models: {},
    };
    const parsed = sessionFallbackEntrySchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(isLegacyChainActivation(parsed.activation)).toBe(true);
    expect(isLegacyChainActivation({ id: "a", profileId: profiles[0]!.id, models: [], position: 0, startedAt: "t" })).toBe(false);
    expect(isLegacyChainActivation(null)).toBe(false);
  });

  it("refuses a record it cannot act on, so a bad file loses the profile and not the session", () => {
    const minimal: SessionFallbackEntry = { version: 1, event: "cleared", at: "2026-09-11T12:00:00.000Z", activation: null, models: {} };
    expect(sessionFallbackEntrySchema.parse(minimal)).toEqual(minimal);
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, version: 2 })).toThrow();
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, event: "rerouted" })).toThrow();
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, failure: { class: "teapot", at: "x" } })).toThrow();
    // Strict: a field cannot arrive without this schema saying what it means.
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, resumeAt: "2026-09-11T12:00:00.000Z" })).toThrow();
    expect(() =>
      sessionFallbackEntrySchema.parse({ ...minimal, activation: { id: "a", profileId: profiles[0]!.id, models: [], position: 0, startedAt: "t" } }),
    ).toThrow();
  });

  it("keeps one conservative cooldown, in the engine's own order of magnitude", () => {
    expect(FALLBACK_DEFAULT_COOLDOWN_MS).toBe(300_000);
  });
});
