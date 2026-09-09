/**
 * M13-T49: which models the pickers offer, and why the off side of the model
 * switches is a product-owned list rather than a pattern in `enabledModels`.
 *
 * The engine's allow-list matcher is exercised directly, not its docs: the
 * question "can a glob take one model away?" decides the design, and the
 * answer must survive an engine upgrade.
 */
import { resolveModelScopeWithDiagnostics, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { durableOverrides } from "../src/settings-overrides.js";
import { SettingsAdapter, disabledModelRefs, engineSettingsOnly, laserEngineSettings, modelSwitchedOff, readEffectiveProductSettings } from "../src/settings.js";

const models = [
  { provider: "openai", id: "gpt-5" },
  { provider: "openai", id: "gpt-6-astra" },
  { provider: "anthropic", id: "claude-sonnet-4" },
];
/** The matcher only reads `getAvailable`; the rest of a ModelRuntime is irrelevant to it. */
const runtime = { getAvailable: async () => models } as unknown as ModelRuntime;
const refs = async (patterns: string[]) =>
  (await resolveModelScopeWithDiagnostics(patterns, runtime)).scopedModels.map((s) => `${s.model.provider}/${s.model.id}`);

describe("the engine's allow-list has no negation", () => {
  it("treats a leading ! without glob characters as an exact reference that matches nothing", async () => {
    for (const pattern of ["!openai/gpt-5", "!gpt-5", "!(openai/gpt-5)"]) {
      const scope = await resolveModelScopeWithDiagnostics([pattern], runtime);
      expect(scope.scopedModels, pattern).toEqual([]);
      expect(scope.diagnostics.map((d) => d.code), pattern).toEqual(["no-match"]);
    }
  });

  it("cannot take a model away with a negated glob: the bare-id branch matches it back in", async () => {
    // minimatch does honour `!`: against the bare id "gpt-5" the pattern is
    // false. But the matcher ORs that with the same test against the full id
    // "openai/gpt-5", which "gpt-5*" never matched — so the negation is true
    // there, and the model is added. Every model comes back, gpt-5 included.
    expect(await refs(["!gpt-5*"])).toEqual(["openai/gpt-5", "openai/gpt-6-astra", "anthropic/claude-sonnet-4"]);
  });

  it("only ever adds: a second pattern can widen the list, never narrow it", async () => {
    expect(await refs(["*", "!openai/gpt-5"])).toEqual(["openai/gpt-5", "openai/gpt-6-astra", "anthropic/claude-sonnet-4"]);
    expect(await refs(["gpt-5*", "anthropic/*"])).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-4"]);
  });
});

describe("the product's disable list", () => {
  it("names exact references, case-insensitively, and ignores anything else", () => {
    const set = disabledModelRefs([" OpenAI/GPT-5 ", "", 3, null, "anthropic/claude-sonnet-4"]);
    expect([...set]).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-4"]);
    expect(modelSwitchedOff({ provider: "openai", id: "gpt-5" }, set)).toBe(true);
    expect(disabledModelRefs("openai/gpt-5").size).toBe(0);
    expect(disabledModelRefs(undefined).size).toBe(0);
  });

  it("leaves a model added to the catalogue later switched on", () => {
    // The whole point: switching one model off must never hide the next one
    // the provider ships, which an enumerated allow-list would.
    const set = disabledModelRefs(["openai/gpt-5"]);
    expect(modelSwitchedOff({ provider: "openai", id: "gpt-7-nova" }, set)).toBe(false);
    expect(modelSwitchedOff({ provider: "anthropic", id: "gpt-5" }, set)).toBe(false);
  });
});

describe("where the disable list lives", () => {
  let base: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "model-offer-"));
    cwd = join(base, "project");
    agentDir = join(base, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("is read from the project file and never handed to the engine", () => {
    const doc = laserEngineSettings({ disabledModels: ["openai/gpt-5"], enabledModels: ["gpt-*"], terminal: {} });
    expect(doc).toEqual({ disabledModels: ["openai/gpt-5"], enabledModels: ["gpt-*"] });
    expect(engineSettingsOnly(doc)).toEqual({ enabledModels: ["gpt-*"] });
  });

  it("writes at both scopes through the settings adapter and stays out of the engine overrides", async () => {
    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    const global = await settings.apply("global", [{ path: "disabledModels", op: "set", value: ["openai/gpt-5"] }]);
    expect(global.global.values["disabledModels"]).toEqual(["openai/gpt-5"]);
    expect(global.effective["disabledModels"]).toEqual(["openai/gpt-5"]);

    const project = await settings.apply("project", [{ path: "disabledModels", op: "set", value: ["anthropic/claude-sonnet-4"] }]);
    expect(project.project.values["disabledModels"]).toEqual(["anthropic/claude-sonnet-4"]);
    // The project list replaces the global one, like every list the engine merges.
    expect(project.effective["disabledModels"]).toEqual(["anthropic/claude-sonnet-4"]);
    expect(durableOverrides(settings.settingsManager)).not.toHaveProperty("disabledModels");
  });

  it("is read fresh from both files for a live session's picker, the project replacing the global list", async () => {
    expect(readEffectiveProductSettings(cwd, agentDir, true)).toEqual({});
    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    await settings.apply("global", [{ path: "disabledModels", op: "set", value: ["openai/gpt-5"] }]);
    expect(readEffectiveProductSettings(cwd, agentDir, true)["disabledModels"]).toEqual(["openai/gpt-5"]);
    await settings.apply("project", [{ path: "disabledModels", op: "set", value: ["anthropic/claude-sonnet-4"] }]);
    expect(readEffectiveProductSettings(cwd, agentDir, true)["disabledModels"]).toEqual(["anthropic/claude-sonnet-4"]);
    // An untrusted project contributes nothing, like everywhere else.
    expect(readEffectiveProductSettings(cwd, agentDir, false)["disabledModels"]).toEqual(["openai/gpt-5"]);
  });

  it("refuses a list that is not strings", async () => {
    const settings = new SettingsAdapter({ cwd, agentDir, hostTrusted: true });
    await expect(settings.apply("global", [{ path: "disabledModels", op: "set", value: "openai/gpt-5" }])).rejects.toThrow(/list of strings/);
  });
});
