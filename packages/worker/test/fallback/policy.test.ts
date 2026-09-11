/**
 * M15-T3: the traversal rules, on a fake clock and no engine at all.
 *
 * Everything the specification says about *order* and *eligibility* is here:
 * earlier models first with one request each, then the next fallback with its
 * normal retries; cooldowns, provider reset times and failures that will not
 * clear on their own; no candidate twice in one failover; and exhaustion that
 * says what stood in the way.
 */
import { describe, expect, it } from "vitest";

import {
  FALLBACK_DEFAULT_COOLDOWN_MS,
  modelKey,
  type FallbackActivation,
  type FallbackChain,
  type FallbackModelMemory,
  type FallbackModelRef,
} from "@lasercode/protocol";

import {
  activate,
  clearActivationMarks,
  exhaustionDetail,
  ineligibleReason,
  nextCandidate,
  opensFailover,
  rememberFailure,
  type CandidateContext,
  type CandidateModel,
} from "../../src/fallback/policy.js";
import {
  EMPTY_FALLBACK_STATE,
  entryFor,
  restoreFallbackState,
  summaryFor,
} from "../../src/fallback/state.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();

const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
const deepseek = { provider: "deepseek", id: "deepseek-chat" };
const gemini = { provider: "google", id: "gemini-2.5-pro" };
const openrouter = { provider: "openrouter", id: "auto" };

const chains: FallbackChain[] = [
  { models: [sonnet, deepseek, gemini, openrouter] },
  { models: [deepseek, gemini] },
];

const catalogue = (
  overrides: Partial<Record<string, Partial<CandidateModel>>> = {},
): Map<string, CandidateModel> => {
  const entries = new Map<string, CandidateModel>();
  for (const ref of [sonnet, deepseek, gemini, openrouter]) {
    const key = modelKey(ref);
    entries.set(key, { ref, signedIn: true, offered: true, contextWindow: 200_000, ...overrides[key] });
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) entries.delete(key);
  }
  return entries;
};

const activation = (position: number): FallbackActivation => ({
  id: "act-1",
  chainKey: modelKey(sonnet),
  models: chains[0]!.models,
  position,
  startedAt: iso(NOW - 60_000),
});

const context = (over: Partial<CandidateContext> & { position?: number } = {}): CandidateContext => ({
  activation: over.activation ?? activation(over.position ?? 0),
  memory: over.memory ?? {},
  event: over.event ?? { attempts: [] },
  catalogue: over.catalogue ?? catalogue(),
  contextTokens: over.contextTokens ?? 1_000,
  now: over.now ?? NOW,
});

describe("activation", () => {
  it("only a chain's first model starts one, and the snapshot is the chain as it is now", () => {
    const started = activate(chains, sonnet, { id: "a", at: iso(NOW) });
    expect(started).toEqual({ id: "a", chainKey: "anthropic/claude-sonnet-4-5", models: chains[0]!.models, position: 0, startedAt: iso(NOW) });
    // Gemini is a fallback in both chains and starts neither.
    expect(activate(chains, gemini, { id: "a", at: iso(NOW) })).toBeNull();
    // DeepSeek starts its own chain — never the one it is a fallback in.
    expect(activate(chains, deepseek, { id: "a", at: iso(NOW) })?.models).toEqual(chains[1]!.models);
    expect(activate([], sonnet, { id: "a", at: iso(NOW) })).toBeNull();
  });

  it("acts only on failures that are about reaching the model", () => {
    for (const failure of ["credential", "permission", "credits", "allowance", "rate_limit", "provider_down", "connection", "model_missing"] as const) {
      expect(opensFailover(failure), failure).toBe(true);
    }
    for (const failure of ["context_overflow", "safety", "aborted", "unknown"] as const) {
      expect(opensFailover(failure), failure).toBe(false);
    }
  });
});

describe("traversal order", () => {
  it("takes the next fallback when the chain's first model fails", () => {
    const decision = nextCandidate(context({ position: 0 }));
    expect(decision).toMatchObject({ kind: "attempt", model: deepseek, position: 1, direction: "advance", retries: "normal" });
  });

  it("tries every earlier model once, in the chain's order, before the next fallback", () => {
    // Active at Gemini (index 2): Sonnet and DeepSeek come first, in that
    // order, each with exactly one request; only then OpenRouter.
    const first = nextCandidate(context({ position: 2 }));
    expect(first).toMatchObject({ kind: "attempt", model: sonnet, position: 0, direction: "return", retries: "none" });

    const afterSonnet = context({
      position: 2,
      event: { attempts: [{ model: modelKey(sonnet), at: iso(NOW), outcome: "failed", class: "provider_down" }] },
    });
    expect(nextCandidate(afterSonnet)).toMatchObject({ kind: "attempt", model: deepseek, position: 1, direction: "return", retries: "none" });

    const afterBoth = context({
      position: 2,
      event: {
        attempts: [
          { model: modelKey(sonnet), at: iso(NOW), outcome: "failed", class: "provider_down" },
          { model: modelKey(deepseek), at: iso(NOW), outcome: "failed", class: "connection" },
        ],
      },
    });
    expect(nextCandidate(afterBoth)).toMatchObject({ kind: "attempt", model: openrouter, position: 3, direction: "advance", retries: "normal" });
  });

  it("never tries the same candidate twice in one failover, and stops when the chain runs out", () => {
    const attempts = [sonnet, deepseek, openrouter].map((model) => ({
      model: modelKey(model),
      at: iso(NOW),
      outcome: "failed" as const,
      class: "provider_down" as const,
    }));
    const decision = nextCandidate(context({ position: 2, event: { attempts } }));
    expect(decision.kind).toBe("exhausted");
    expect(decision.skipped.map((entry) => entry.reason)).toEqual([
      "already tried in this switch",
      "already tried in this switch",
      "already tried in this switch",
    ]);
  });

  it("passes over a candidate it cannot use and says why, in one sentence", () => {
    const decision = nextCandidate(
      context({
        position: 2,
        catalogue: catalogue({ [modelKey(sonnet)]: { signedIn: false }, [modelKey(deepseek)]: { offered: false } }),
      }),
    );
    expect(decision).toMatchObject({ kind: "attempt", model: openrouter });
    expect(decision.skipped).toEqual([
      { model: sonnet, reason: "not signed in" },
      { model: deepseek, reason: "switched off in Settings" },
    ]);
    expect(exhaustionDetail(decision.skipped, (model) => model.id)).toBe(
      "Fallback could not help: claude-sonnet-4-5 not signed in, deepseek-chat switched off in Settings.",
    );
  });
});

describe("eligibility", () => {
  const memoryWith = (entry: FallbackModelMemory, model: FallbackModelRef = sonnet) => ({ [modelKey(model)]: entry });

  it("holds a model back for the cooldown its failure earned, and lets it back afterwards", () => {
    const memory = rememberFailure({}, sonnet, { class: "provider_down" }, { now: NOW });
    expect(memory[modelKey(sonnet)]!.cooldownUntil).toBe(iso(NOW + FALLBACK_DEFAULT_COOLDOWN_MS));
    expect(ineligibleReason(sonnet, context({ memory, now: NOW + 60_000 }))).toBe("tried too recently");
    expect(ineligibleReason(sonnet, context({ memory, now: NOW + FALLBACK_DEFAULT_COOLDOWN_MS + 1 }))).toBeUndefined();
  });

  it("prefers the provider's own reset time to its own guess", () => {
    const resetAt = iso(NOW + 20_000);
    const memory = rememberFailure({}, sonnet, { class: "rate_limit", resetAt }, { now: NOW });
    expect(memory[modelKey(sonnet)]!.knownResetAt).toBe(resetAt);
    expect(memory[modelKey(sonnet)]!.cooldownUntil).toBe(resetAt);
    expect(ineligibleReason(sonnet, context({ memory, now: NOW + 10_000 }))).toContain("available again at");
    expect(ineligibleReason(sonnet, context({ memory, now: NOW + 25_000 }))).toBeUndefined();
  });

  it("does not put a clearly non-transient failure on a timer", () => {
    const memory = rememberFailure({}, sonnet, { class: "credits" }, { now: NOW });
    expect(memory[modelKey(sonnet)]).toEqual({ lastFailure: { class: "credits", at: iso(NOW) }, nonTransient: true });
    // Not even in a year: only a person's own model choice starts a fresh activation.
    expect(ineligibleReason(sonnet, context({ memory, now: NOW + 365 * 24 * 3_600_000 }))).toBe("has no credit left");
    const cleared = clearActivationMarks(memory);
    expect(ineligibleReason(sonnet, context({ memory: cleared }))).toBeUndefined();
  });

  it("treats a spent allowance as non-transient only while its reset is unknown", () => {
    const unknown = rememberFailure({}, sonnet, { class: "allowance" }, { now: NOW });
    expect(unknown[modelKey(sonnet)]!.nonTransient).toBe(true);
    expect(unknown[modelKey(sonnet)]!.cooldownUntil).toBeUndefined();
    const known = rememberFailure({}, sonnet, { class: "allowance", resetAt: iso(NOW + 3_600_000) }, { now: NOW });
    expect(known[modelKey(sonnet)]!.nonTransient).toBeUndefined();
    expect(ineligibleReason(sonnet, context({ memory: known, now: NOW + 3_600_001 }))).toBeUndefined();
  });

  it("keeps cooldowns across a fresh activation, because an instant is not an opinion", () => {
    const memory = rememberFailure({}, sonnet, { class: "provider_down" }, { now: NOW });
    const cleared = clearActivationMarks(memory);
    expect(cleared[modelKey(sonnet)]!.cooldownUntil).toBe(iso(NOW + FALLBACK_DEFAULT_COOLDOWN_MS));
    expect(ineligibleReason(sonnet, context({ memory: cleared, now: NOW + 1_000 }))).toBe("tried too recently");
  });

  it("refuses a model the conversation would not fit in, and a model that is not there", () => {
    expect(
      ineligibleReason(deepseek, context({ contextTokens: 300_000, catalogue: catalogue({ [modelKey(deepseek)]: { contextWindow: 128_000 } }) })),
    ).toBe("the conversation is longer than this model can hold");
    // An unknown window never disqualifies, and unknown usage never does either.
    expect(ineligibleReason(deepseek, context({ contextTokens: 300_000, catalogue: catalogue({ [modelKey(deepseek)]: { contextWindow: undefined } }) }))).toBeUndefined();
    expect(ineligibleReason(deepseek, context({ contextTokens: null }))).toBeUndefined();
    const missing = catalogue();
    missing.delete(modelKey(deepseek));
    expect(ineligibleReason(deepseek, context({ catalogue: missing }))).toBe("not in the model catalogue");
  });

  it("counts a skipped candidate as untried, so a later failover may still reach it", () => {
    const attempts = [{ model: modelKey(sonnet), at: iso(NOW), outcome: "skipped" as const, reason: "tried too recently" }];
    expect(ineligibleReason(sonnet, context({ event: { attempts } }))).toBeUndefined();
  });
});

describe("the durable state", () => {
  const state = {
    activation: activation(1),
    models: rememberFailure({}, sonnet, { class: "rate_limit" }, { now: NOW }),
    failover: { id: "fo-1", startedAt: iso(NOW), attempts: [{ model: modelKey(sonnet), at: iso(NOW), outcome: "failed" as const, class: "rate_limit" as const }] },
  };
  const entry = (data: unknown) => [{ type: "custom", customType: "lasercode/fallback", data }];

  it("writes a record that reads back as the same state", () => {
    const record = entryFor({ event: "switched", at: iso(NOW), state, from: sonnet, to: deepseek, failure: { class: "rate_limit", at: iso(NOW) } });
    const restored = restoreFallbackState(entry(JSON.parse(JSON.stringify(record))), { at: iso(NOW + 1) });
    expect(restored.activation).toEqual(state.activation);
    expect(restored.models).toEqual(state.models);
    // The event was still open when the process ended: it is closed, not resumed.
    expect(restored.failover).toMatchObject({ id: "fo-1", ended: "aborted", endedAt: iso(NOW + 1) });
    expect(restored.failover!.attempts).toEqual(state.failover.attempts);
  });

  it("restores the chain verbatim rather than resolving one from the model in use", () => {
    // Position 1 is DeepSeek, which starts a chain of its own. Restoring must
    // keep Sonnet's chain, at Sonnet's position, or a reload would quietly
    // change which models this conversation can reach.
    const restored = restoreFallbackState(entry(entryFor({ event: "switched", at: iso(NOW), state })));
    expect(restored.activation!.chainKey).toBe(modelKey(sonnet));
    expect(restored.activation!.models).toEqual(chains[0]!.models);
    expect(restored.activation!.position).toBe(1);
  });

  it("takes the last record, and nothing at all from one it cannot read", () => {
    const first = entryFor({ event: "activated", at: iso(NOW - 10), state: { activation: activation(0), models: {} } });
    const second = entryFor({ event: "switched", at: iso(NOW), state, from: sonnet, to: deepseek });
    expect(restoreFallbackState([...entry(first), ...entry(second)]).activation!.position).toBe(1);
    expect(restoreFallbackState(entry({ version: 2, event: "switched" }))).toEqual(EMPTY_FALLBACK_STATE);
    expect(restoreFallbackState([{ type: "message" }])).toEqual(EMPTY_FALLBACK_STATE);
    expect(restoreFallbackState([])).toEqual(EMPTY_FALLBACK_STATE);
  });

  it("summarises for the UI with catalogue names, and says nothing without an activation", () => {
    const names = new Map([[modelKey(deepseek), { ...deepseek, name: "DeepSeek V3" }]]);
    const summary = summaryFor(state, { catalogue: names, switching: true, lastSwitch: { from: sonnet, to: deepseek, reason: "rate_limit", at: iso(NOW) } })!;
    expect(summary.position).toBe(1);
    expect(summary.chain[1]).toEqual({ ...deepseek, name: "DeepSeek V3" });
    // A model the catalogue no longer has is still shown by its identity.
    expect(summary.chain[0]).toEqual(sonnet);
    expect(summary.switching).toBe(true);
    expect(summary.lastSwitch).toMatchObject({ reason: "rate_limit" });
    expect(summaryFor(EMPTY_FALLBACK_STATE, { catalogue: names })).toBeUndefined();
  });
});
