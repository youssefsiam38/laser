import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry, ProviderAuthInfo } from "@lasercode/protocol";
import { narrowToConnected, withCurrentModel } from "../../src/components/assistant-ui/elements/connected-models.js";

const model = (provider: string, id: string, enabled = true): ModelCatalogEntry => ({ provider, id, name: id, thinkingLevels: ["off"], enabled });
const provider = (id: string, configured: boolean): ProviderAuthInfo => ({ id, name: id, configured, auth: {} } as ProviderAuthInfo);

const CATALOG = [model("anthropic", "sonnet"), model("anthropic", "opus"), model("openai", "gpt"), model("groq", "fast"), model("mistral", "old", false)];

describe("the models a person can choose", () => {
  it("keeps only enabled models whose provider is connected", () => {
    const { models, none } = narrowToConnected(CATALOG, [provider("anthropic", true), provider("openai", false), provider("groq", false)]);
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual(["anthropic/sonnet", "anthropic/opus"]);
    expect(none).toBe(false);
  });

  it("offers nothing, and says so, when no provider is connected", () => {
    const { models, none } = narrowToConnected(CATALOG, [provider("anthropic", false), provider("openai", false)]);
    expect(models).toEqual([]);
    // The caller turns this into "connect a provider first" rather than an empty menu.
    expect(none).toBe(true);
  });

  it("falls back to the enabled catalogue when the providers cannot be read", () => {
    // The narrowing is what is unavailable, not the models: an empty picker
    // would be a worse answer than an unnarrowed one.
    const { models, none } = narrowToConnected(CATALOG, undefined);
    expect(models.map((m) => m.id)).toEqual(["sonnet", "opus", "gpt", "fast"]);
    expect(none).toBe(false);
  });

  it("drops a disabled model even from a connected provider", () => {
    const { models } = narrowToConnected(CATALOG, [provider("mistral", true)]);
    expect(models).toEqual([]);
  });

  it("keeps the model a surface already holds, however the list narrowed", () => {
    const current = { provider: "groq", id: "fast" };
    const list = [{ provider: "anthropic", id: "sonnet" }];
    expect(withCurrentModel(list, current)).toEqual([current, ...list]);
    // Already there: not repeated.
    expect(withCurrentModel([current], current)).toEqual([current]);
    expect(withCurrentModel(list, null)).toEqual(list);
  });
});
