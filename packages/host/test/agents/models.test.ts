/**
 * Beam's proposed model: fast tier, mid-to-low price, only from providers the
 * person actually connected — or nothing, so the dialog opens without a guess.
 */
import type { ModelCatalogEntry } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { suggestBeamModel } from "../../src/agents/models.js";

function model(provider: string, id: string, input: number, output: number, enabled = true): ModelCatalogEntry {
  return { provider, id, thinkingLevels: ["off"], enabled, cost: { input, output } };
}

const CATALOG = [
  model("anthropic", "claude-opus-4", 15, 75),
  model("anthropic", "claude-sonnet-4", 3, 15),
  model("anthropic", "claude-haiku-4", 0.8, 4),
  model("openai", "gpt-5", 1.25, 10),
  model("openai", "gpt-5-pro", 15, 120),
  model("openai", "gpt-5-mini", 0.25, 2),
  model("openai", "gpt-5-nano", 0.05, 0.4),
  model("google", "gemini-2.5-flash", 0.3, 2.5),
];

describe("suggestBeamModel", () => {
  it("picks the priciest fast-tier model inside the band", () => {
    // gpt-5-mini (2.25) and gemini flash (2.8) are in the band; sonnet (18) and gpt-5 (11.25) are not; nano is too cheap.
    expect(suggestBeamModel(CATALOG)).toEqual({ provider: "google", id: "gemini-2.5-flash" });
  });

  it("only considers providers with a credential, and only enabled models", () => {
    expect(suggestBeamModel(CATALOG, { configuredProviders: new Set(["openai"]) })).toEqual({ provider: "openai", id: "gpt-5-mini" });
    const disabled = CATALOG.map((entry) => (entry.id === "gemini-2.5-flash" ? { ...entry, enabled: false } : entry));
    expect(suggestBeamModel(disabled)).toEqual({ provider: "openai", id: "gpt-5-mini" });
  });

  it("falls back to the median-priced usable model when no fast-tier model is in the band", () => {
    const heavy = [model("x", "alpha", 10, 30), model("x", "beta", 20, 40), model("x", "gamma", 30, 50)];
    expect(suggestBeamModel(heavy)).toEqual({ provider: "x", id: "beta" });
    const unpriced = [{ provider: "x", id: "mystery", thinkingLevels: [], enabled: true } as ModelCatalogEntry];
    expect(suggestBeamModel(unpriced)).toEqual({ provider: "x", id: "mystery" });
  });

  it("returns null when nothing is usable", () => {
    expect(suggestBeamModel([])).toBeNull();
    expect(suggestBeamModel(CATALOG, { configuredProviders: new Set() })).toBeNull();
    expect(suggestBeamModel(CATALOG.map((entry) => ({ ...entry, enabled: false })))).toBeNull();
  });
});
