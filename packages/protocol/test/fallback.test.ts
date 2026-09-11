import { describe, expect, it } from "vitest";

import {
  chainFor,
  FALLBACK_DEFAULT_COOLDOWN_MS,
  MAX_FALLBACK_CHAIN_MODELS,
  modelKey,
  readFallbackChainsValue,
  sameModel,
  SESSION_FALLBACK_ENTRY_TYPE,
  validateFallbackChains,
  type FallbackChain,
  type SessionFallbackEntry,
} from "../src/fallback.js";
import { WIRE_NAMESPACE } from "../src/identity.js";
import { sessionFallbackEntrySchema } from "../src/schemas.js";

const model = (provider: string, id: string) => ({ provider, id });

const chains: FallbackChain[] = [
  { models: [model("anthropic", "claude-sonnet-4-5"), model("deepseek", "deepseek-chat"), model("openrouter", "auto")] },
  { models: [model("deepseek", "deepseek-chat"), model("google", "gemini-2.5-pro")] },
];

describe("chain selection", () => {
  it("only the first model of a chain starts it", () => {
    // The rule the whole feature turns on: a session on Sonnet uses the first
    // chain; switching to DeepSeek mid-conversation does not enter the first
    // chain again, it resolves DeepSeek's own.
    expect(chainFor(chains, model("anthropic", "claude-sonnet-4-5"))).toBe(chains[0]);
    expect(chainFor(chains, model("deepseek", "deepseek-chat"))).toBe(chains[1]);
    // OpenRouter is a fallback in chain one and starts nothing.
    expect(chainFor(chains, model("openrouter", "auto"))).toBeUndefined();
    expect(chainFor(chains, model("google", "gemini-2.5-pro"))).toBeUndefined();
    expect(chainFor(chains, null)).toBeUndefined();
    expect(chainFor([], model("anthropic", "claude-sonnet-4-5"))).toBeUndefined();
  });

  it("identity is provider and id, without regard to case, and nothing else", () => {
    expect(modelKey(model("OpenAI", "GPT-5"))).toBe("openai/gpt-5");
    expect(chainFor(chains, model("Anthropic", "Claude-Sonnet-4-5"))).toBe(chains[0]);
    expect(sameModel(model("a", "b"), model("A", "B"))).toBe(true);
    expect(sameModel(model("a", "b"), model("a", "c"))).toBe(false);
    expect(sameModel(undefined, model("a", "b"))).toBe(false);
  });
});

describe("chain validation", () => {
  it("accepts an empty configuration, which is where everyone starts", () => {
    expect(validateFallbackChains(undefined)).toEqual([]);
    expect(validateFallbackChains([])).toEqual([]);
    expect(validateFallbackChains(chains)).toEqual([]);
  });

  it("asks for a model to fall back to rather than saving a chain of one", () => {
    expect(validateFallbackChains([{ models: [model("openai", "gpt-5")] }])).toEqual([
      { chain: 0, message: "Add a model to fall back to." },
    ]);
  });

  it("refuses the same model twice in one chain", () => {
    const issues = validateFallbackChains([
      { models: [model("openai", "gpt-5"), model("deepseek", "deepseek-chat"), model("OpenAI", "GPT-5")] },
    ]);
    expect(issues).toEqual([{ chain: 0, model: 2, message: "GPT-5 is already in this chain." }]);
  });

  it("refuses two chains starting on the same model, and allows every other reuse", () => {
    expect(
      validateFallbackChains([
        { models: [model("openai", "gpt-5"), model("deepseek", "deepseek-chat")] },
        { models: [model("openai", "gpt-5"), model("google", "gemini-2.5-pro")] },
      ]),
    ).toEqual([{ chain: 1, model: 0, message: "gpt-5 already starts a chain." }]);
    // A model may be a fallback in several chains and start one of its own.
    expect(
      validateFallbackChains([
        { models: [model("openai", "gpt-5"), model("deepseek", "deepseek-chat")] },
        { models: [model("google", "gemini-2.5-pro"), model("deepseek", "deepseek-chat")] },
        { models: [model("deepseek", "deepseek-chat"), model("openrouter", "auto")] },
      ]),
    ).toEqual([]);
  });

  it("refuses shapes a person could not have meant", () => {
    expect(validateFallbackChains("chains")).toEqual([{ chain: -1, message: "Fallback chains must be a list." }]);
    expect(validateFallbackChains([1])).toEqual([
      { chain: 0, message: "A chain must be an object with a list of models." },
    ]);
    expect(validateFallbackChains([{}])).toEqual([{ chain: 0, message: "A chain must name its models." }]);
    expect(validateFallbackChains([{ models: [model("openai", ""), model("", "x")] }])).toEqual([
      { chain: 0, model: 0, message: "A model needs a provider and a model id." },
      { chain: 0, model: 1, message: "A model needs a provider and a model id." },
    ]);
    const long = { models: Array.from({ length: MAX_FALLBACK_CHAIN_MODELS + 1 }, (_, i) => model("p", `m${i}`)) };
    expect(validateFallbackChains([long])).toEqual([
      { chain: 0, message: `Keep a chain to ${MAX_FALLBACK_CHAIN_MODELS} models or fewer.` },
    ]);
  });

  it("reads a file written by hand without throwing away what is usable", () => {
    expect(readFallbackChainsValue("nonsense")).toEqual([]);
    expect(readFallbackChainsValue([{ models: [{ provider: " openai ", id: " gpt-5 " }, { provider: 1 }] }])).toEqual([
      { models: [model("openai", "gpt-5")] },
    ]);
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
        chainKey: "anthropic/claude-sonnet-4-5",
        models: chains[0]!.models,
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

  it("refuses a record it cannot act on, so a bad file loses the chain and not the session", () => {
    const minimal: SessionFallbackEntry = { version: 1, event: "cleared", at: "2026-09-11T12:00:00.000Z", activation: null, models: {} };
    expect(sessionFallbackEntrySchema.parse(minimal)).toEqual(minimal);
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, version: 2 })).toThrow();
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, event: "rerouted" })).toThrow();
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, failure: { class: "teapot", at: "x" } })).toThrow();
    // Strict: a field cannot arrive without this schema saying what it means.
    expect(() => sessionFallbackEntrySchema.parse({ ...minimal, resumeAt: "2026-09-11T12:00:00.000Z" })).toThrow();
    expect(() =>
      sessionFallbackEntrySchema.parse({ ...minimal, activation: { id: "a", chainKey: "p/m", models: [], position: 0, startedAt: "t" } }),
    ).toThrow();
  });

  it("keeps one conservative cooldown, in the engine's own order of magnitude", () => {
    // The engine spends ~14s retrying (3 attempts, 2s base, exponential) before
    // it gives up; five minutes is long enough that a failing provider cannot
    // be re-attempted repeatedly in one conversation.
    expect(FALLBACK_DEFAULT_COOLDOWN_MS).toBe(300_000);
  });
});
