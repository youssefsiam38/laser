/**
 * The state machine a session moves through its Model Profile with, as pure
 * functions (`docs/model-profiles.md` "Runtime"; the mechanics are the M15-T3
 * ones recorded in `docs/model-fallback-chains.md` §2).
 *
 * Nothing here touches the engine, the clock or a file: an activation, what a
 * failure did to a model's standing, which model is tried next and why one is
 * skipped are all decided from values that are handed in. That is deliberate —
 * traversal order, cooldowns and the bounded return attempt are the rules the
 * specification is written in, and rules that need a live provider to test are
 * rules nobody checks.
 *
 * The driver owns everything this file does not: making the request, changing
 * the model, and writing the record.
 */

import {
  FALLBACK_DEFAULT_COOLDOWN_MS,
  isFallbackEligible,
  modelKey,
  NON_TRANSIENT_FAILURES,
  type FallbackActivation,
  type FallbackEvent,
  type FallbackModelMemory,
  type ModelIdentity,
  type ModelProfile,
  type ProfileModelRef,
  type ProviderFailure,
  type ProviderFailureClass,
} from "@lasercode/protocol";

/** What the engine's catalogue says about one model, for eligibility only. */
export interface CandidateModel {
  ref: ModelIdentity;
  /** Absent when the catalogue does not state one; then it never disqualifies. */
  contextWindow?: number | undefined;
  /** The provider has a credential. `setModel` refuses the rest outright. */
  signedIn: boolean;
  /** In the catalogue and not switched off in Providers and models. */
  offered: boolean;
}

export type ModelMemory = Readonly<Record<string, FallbackModelMemory>>;

export interface CandidateContext {
  activation: FallbackActivation;
  memory: ModelMemory;
  /** The failover event in flight: its attempts bound this traversal. */
  event: Pick<FallbackEvent, "attempts">;
  /** The engine catalogue, by `provider/id`. A model absent from it is not usable. */
  catalogue: ReadonlyMap<string, CandidateModel>;
  /** Tokens the conversation currently occupies, or null when unknown. */
  contextTokens: number | null;
  now: number;
}

/** Why a candidate is skipped when the conversation does not fit its window. */
export const CONTEXT_TOO_LONG_REASON = "the conversation is longer than this model can hold";

/** One candidate the traversal passed over, with the sentence a person reads. */
export interface SkippedCandidate {
  model: ProfileModelRef;
  reason: string;
}

export type Traversal =
  | {
      kind: "attempt";
      model: ProfileModelRef;
      /** Index in the activation's snapshot. */
      position: number;
      /**
       * `return` is a model earlier in the chain: exactly one request, no retry
       * cycle. `advance` is the next fallback: its own normal retry policy.
       */
      direction: "return" | "advance";
      retries: "none" | "normal";
      skipped: SkippedCandidate[];
    }
  | { kind: "exhausted"; skipped: SkippedCandidate[] };

/**
 * One profile, bound to one session.
 *
 * The snapshot is taken here and never re-read: editing a profile must not
 * re-order a conversation that is already running (`docs/model-profiles.md`,
 * "Runtime"). A later activation picks the new list up.
 */
export function activate(
  profile: ModelProfile | null | undefined,
  options: { id: string; at: string; position?: number },
): FallbackActivation | null {
  if (!profile || profile.models.length === 0) return null;
  const models = profile.models.map((entry) => ({ ...entry }));
  const position = Math.min(Math.max(options.position ?? 0, 0), models.length - 1);
  return {
    id: options.id,
    profileId: profile.id,
    models,
    position,
    startedAt: options.at,
  };
}

/**
 * Where a session that is just starting should begin inside its profile.
 *
 * The first model the profile prefers, unless it cannot be used right now (no
 * credential, switched off, not in the catalogue) — then the next, and so on,
 * with every model passed over recorded exactly as a move would record it. A
 * profile whose every model is unusable starts on the first one anyway, so the
 * failure a person sees is the provider's, not a silent refusal to start.
 */
export function startPosition(context: Omit<CandidateContext, "event">): { position: number; skipped: SkippedCandidate[] } {
  const models = context.activation.models;
  const skipped: SkippedCandidate[] = [];
  for (const [index, model] of models.entries()) {
    const reason = ineligibleReason(model, { ...context, event: { attempts: [] } });
    if (reason === undefined) return { position: index, skipped };
    skipped.push({ model, reason });
  }
  return { position: 0, skipped };
}

/** Whether this failure is one a chain may act on at all (the table in §2.4). */
export function opensFailover(failure: ProviderFailureClass): boolean {
  return isFallbackEligible(failure);
}

/**
 * What a failure does to a model's standing for the rest of this activation.
 *
 * A provider-stated reset wins over Laser's own cooldown, because the provider
 * knows and we are guessing. Nothing is invented when it said nothing: the
 * conservative default stands in, and a class that will not fix itself is
 * marked instead of being given a time it does not have.
 */
export function rememberFailure(
  memory: ModelMemory,
  model: ModelIdentity,
  failure: ProviderFailure,
  options: { now: number; cooldownMs?: number },
): Record<string, FallbackModelMemory> {
  const key = modelKey(model);
  const at = new Date(options.now).toISOString();
  const nonTransient = NON_TRANSIENT_FAILURES.includes(failure.class)
    || (failure.class === "allowance" && failure.resetAt === undefined);
  const next: FallbackModelMemory = {
    ...memory[key],
    lastFailure: { class: failure.class, at },
    ...(failure.resetAt ? { knownResetAt: failure.resetAt } : {}),
    ...(nonTransient ? { nonTransient: true } : {}),
  };
  if (!nonTransient) {
    next.cooldownUntil = failure.resetAt ?? new Date(options.now + (options.cooldownMs ?? FALLBACK_DEFAULT_COOLDOWN_MS)).toISOString();
  }
  return { ...memory, [key]: next };
}

/**
 * Clear what only a person's decision can clear.
 *
 * A fresh activation is the specification's "evidence the condition changed":
 * the marks that say a model will not recover on its own go, and the cooldowns
 * — which are instants, not opinions — stay until they expire.
 */
export function clearActivationMarks(memory: ModelMemory): Record<string, FallbackModelMemory> {
  const next: Record<string, FallbackModelMemory> = {};
  for (const [key, entry] of Object.entries(memory)) {
    const { nonTransient: _nonTransient, lastFailure: _lastFailure, ...rest } = entry;
    if (Object.keys(rest).length > 0) next[key] = rest;
  }
  return next;
}

/** Why this candidate cannot be used right now, or undefined when it can. */
export function ineligibleReason(model: ModelIdentity, context: CandidateContext): string | undefined {
  const key = modelKey(model);
  if (context.event.attempts.some((attempt) => attempt.model === key && attempt.outcome !== "skipped")) {
    return "already tried in this switch";
  }
  const candidate = context.catalogue.get(key);
  if (!candidate) return "not in the model catalogue";
  if (!candidate.signedIn) return "not signed in";
  if (!candidate.offered) return "switched off in Settings";
  const memory = context.memory[key];
  const reset = instant(memory?.knownResetAt);
  if (reset !== undefined && reset > context.now) return `available again at ${memory!.knownResetAt}`;
  if (memory?.nonTransient) return nonTransientReason(memory.lastFailure?.class);
  const cooldown = instant(memory?.cooldownUntil);
  if (cooldown !== undefined && cooldown > context.now) return "tried too recently";
  const tokens = context.contextTokens;
  if (tokens !== null && candidate.contextWindow !== undefined && tokens > candidate.contextWindow) {
    return CONTEXT_TOO_LONG_REASON;
  }
  return undefined;
}

/**
 * The next model to try, in the specification's order: every eligible earlier
 * model first, in the chain's own priority order and with one bounded request
 * each, then the next fallback with its normal retries.
 *
 * The models it passed over come back with it, so the caller records why
 * without asking again.
 */
export function nextCandidate(context: CandidateContext): Traversal {
  const { models, position } = context.activation;
  const skipped: SkippedCandidate[] = [];
  const order: Array<{ index: number; direction: "return" | "advance" }> = [
    ...models.slice(0, Math.max(0, position)).map((_, index) => ({ index, direction: "return" as const })),
    ...models.slice(position + 1).map((_, offset) => ({ index: position + 1 + offset, direction: "advance" as const })),
  ];
  for (const { index, direction } of order) {
    const model = models[index];
    if (!model) continue;
    const reason = ineligibleReason(model, context);
    if (reason !== undefined) {
      skipped.push({ model, reason });
      continue;
    }
    return {
      kind: "attempt",
      model,
      position: index,
      direction,
      retries: direction === "return" ? "none" : "normal",
      skipped,
    };
  }
  return { kind: "exhausted", skipped };
}

/**
 * `return` is an earlier model than the one the profile is standing on; `advance`
 * is a later fallback. Same mapping {@link nextCandidate} uses, so a size
 * recovery can join the shared attempt path without asking the traversal for
 * a model it has just moved onto.
 */
export function attemptDirection(position: number, index: number): "return" | "advance" {
  return index < position ? "return" : "advance";
}

/**
 * One sentence for a person when a chain could not help: what was tried, and
 * what stood in the way. Never a provider payload, never a credential.
 */
export function exhaustionDetail(skipped: readonly SkippedCandidate[], names: (model: ModelIdentity) => string): string {
  if (skipped.length === 0) return "No other model in this profile was available.";
  const parts = skipped.map((entry) => `${names(entry.model)} ${entry.reason}`);
  return `No other model in this profile could take over: ${parts.join(", ")}.`;
}

function nonTransientReason(failure: ProviderFailureClass | undefined): string {
  switch (failure) {
    case "credits":
      return "has no credit left";
    case "credential":
      return "did not accept the credential";
    case "permission":
      return "refused this key";
    case "allowance":
      return "has no allowance left";
    case "model_missing":
      return "is not offered by that provider";
    default:
      return "failed in a way that will not clear on its own";
  }
}

function instant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}
