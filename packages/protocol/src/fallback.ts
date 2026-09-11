/**
 * Model fallback chains — Laser's own vocabulary (`docs/model-fallback-chains.md`).
 *
 * A chain is an ordered list of models a person writes down once: the first
 * model *starts* the chain, the rest take over when it cannot answer. It is not
 * routing and not a cost policy; it exists for the moment a provider stops
 * being usable and the work in flight must not die with it.
 *
 * Everything here is pure: the vocabulary, the rules a person's edit must obey,
 * and the shape of the durable record a session keeps. No engine, no clock, no
 * filesystem.
 */

import { WIRE_NAMESPACE } from "./identity.js";
import type { ProviderFailureClass } from "./provider-failure.js";

// ---------------------------------------------------------------- the chains

/** A model in a chain. Only the identity is stored; names come from the catalogue. */
export interface FallbackModelRef {
  provider: string;
  id: string;
}

/** One chain. `models[0]` starts it; the rest are its fallbacks, in order. */
export interface FallbackChain {
  models: FallbackModelRef[];
}

/** The settings path chains are written to, in the global settings file. */
export const FALLBACK_CHAINS_SETTING = "fallbackChains";

/** A list, not a program. */
export const MAX_FALLBACK_CHAIN_MODELS = 12;
export const MAX_FALLBACK_CHAINS = 50;

/** `provider/id`, lower-cased: the identity every table in this feature is keyed by. */
export function modelKey(model: FallbackModelRef): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

export function sameModel(a: FallbackModelRef | null | undefined, b: FallbackModelRef | null | undefined): boolean {
  return !!a && !!b && modelKey(a) === modelKey(b);
}

/**
 * The chain `model` starts, or undefined.
 *
 * Only the **first** model of a chain matches. A model that appears later in a
 * chain does not activate it — that rule is the whole reason chains never merge
 * and never nest.
 */
export function chainFor(
  chains: readonly FallbackChain[],
  model: FallbackModelRef | null | undefined,
): FallbackChain | undefined {
  if (!model) return undefined;
  const key = modelKey(model);
  return chains.find((chain) => chain.models[0] !== undefined && modelKey(chain.models[0]) === key);
}

/** Read a settings value of unknown provenance as chains, dropping nothing valid. */
export function readFallbackChainsValue(value: unknown): FallbackChain[] {
  if (!Array.isArray(value)) return [];
  const chains: FallbackChain[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const models = (entry as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    const refs: FallbackModelRef[] = [];
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const { provider, id } = model as { provider?: unknown; id?: unknown };
      if (typeof provider !== "string" || typeof id !== "string") continue;
      if (provider.trim() === "" || id.trim() === "") continue;
      refs.push({ provider: provider.trim(), id: id.trim() });
    }
    chains.push({ models: refs });
  }
  return chains;
}

// ------------------------------------------------------------- the edit rules

/** One thing wrong with a person's chains, written for that person. */
export interface FallbackChainIssue {
  /** Index into the chains array. */
  chain: number;
  /** Index into that chain's models, when the problem is one model. */
  model?: number;
  message: string;
}

/**
 * Every rule a saved set of chains must obey. The worker runs this before it
 * writes (authoritative) and the Settings screen runs the same function to draw
 * its messages, so the two cannot disagree.
 *
 * A model that no longer exists or whose provider is signed out is **not** an
 * issue: the chain is a person's intent, and deleting it because a credential
 * expired would be worse than carrying it. The runtime skips such a model with
 * a recorded reason instead.
 */
export function validateFallbackChains(value: unknown): FallbackChainIssue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [{ chain: -1, message: "Fallback chains must be a list." }];
  const issues: FallbackChainIssue[] = [];
  if (value.length > MAX_FALLBACK_CHAINS) {
    issues.push({ chain: -1, message: `Keep it to ${MAX_FALLBACK_CHAINS} chains or fewer.` });
  }
  const starters = new Map<string, number>();
  value.forEach((raw, chainIndex) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push({ chain: chainIndex, message: "A chain must be an object with a list of models." });
      return;
    }
    const models = (raw as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      issues.push({ chain: chainIndex, message: "A chain must name its models." });
      return;
    }
    if (models.length < 2) {
      issues.push({ chain: chainIndex, message: "Add a model to fall back to." });
    }
    if (models.length > MAX_FALLBACK_CHAIN_MODELS) {
      issues.push({ chain: chainIndex, message: `Keep a chain to ${MAX_FALLBACK_CHAIN_MODELS} models or fewer.` });
    }
    const seen = new Map<string, number>();
    models.forEach((model, modelIndex) => {
      if (!model || typeof model !== "object" || Array.isArray(model)) {
        issues.push({ chain: chainIndex, model: modelIndex, message: "A model needs a provider and a model id." });
        return;
      }
      const { provider, id } = model as { provider?: unknown; id?: unknown };
      if (typeof provider !== "string" || provider.trim() === "" || typeof id !== "string" || id.trim() === "") {
        issues.push({ chain: chainIndex, model: modelIndex, message: "A model needs a provider and a model id." });
        return;
      }
      const key = modelKey({ provider, id });
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push({ chain: chainIndex, model: modelIndex, message: `${id} is already in this chain.` });
        return;
      }
      seen.set(key, modelIndex);
      if (modelIndex !== 0) return;
      const other = starters.get(key);
      if (other !== undefined) {
        issues.push({ chain: chainIndex, model: 0, message: `${id} already starts a chain.` });
        return;
      }
      starters.set(key, chainIndex);
    });
  });
  return issues;
}

// -------------------------------------------------------------- the live state

/**
 * A chain bound to one session.
 *
 * `models` is the snapshot taken when the chain activated, so a later settings
 * edit cannot re-order a conversation that is already running. `position` is
 * the index of the model that is selected now. `id` fences stale failover work
 * against a person's own model choice.
 */
export interface FallbackActivation {
  id: string;
  /** `provider/id` of the chain's first model. The chain's identity; never changes. */
  chainKey: string;
  models: FallbackModelRef[];
  position: number;
  startedAt: string;
}

/** One candidate tried during one failover event. */
export interface FallbackAttempt {
  /** `provider/id`, lower-cased. */
  model: string;
  at: string;
  outcome: "failed" | "succeeded" | "skipped";
  class?: ProviderFailureClass;
  /** Why it was skipped, in words a person can read. Never a provider payload. */
  reason?: string;
}

/** One traversal, opened by one eligible failure and closed by a success or exhaustion. */
export interface FallbackEvent {
  id: string;
  startedAt: string;
  attempts: FallbackAttempt[];
  /** Set when the event ended; absent while it is in flight. */
  endedAt?: string;
  ended?: "switched" | "returned" | "exhausted" | "aborted";
}

/** What this activation remembers about one model. Times are absolute instants. */
export interface FallbackModelMemory {
  lastFailure?: { class: ProviderFailureClass; at: string };
  /** Laser's own conservative cooldown. */
  cooldownUntil?: string;
  /** A provider-stated recovery instant. Only ever set from a header a provider sent. */
  knownResetAt?: string;
  /** Will not fix itself while this activation lasts. Cleared only by a manual model change. */
  nonTransient?: boolean;
}

export type FallbackEntryEvent =
  | "activated"
  | "switched"
  | "returned"
  | "attempt_failed"
  | "exhausted"
  | "cleared";

/**
 * The durable record. Appended on every transition; the **last** one is the
 * state, and the ones carrying `from`/`to` are what the transcript draws.
 */
export interface SessionFallbackEntry {
  version: 1;
  event: FallbackEntryEvent;
  at: string;
  from?: FallbackModelRef;
  to?: FallbackModelRef;
  failure?: { class: ProviderFailureClass; at: string };
  /** Null when a manual selection cleared the activation without resolving a new one. */
  activation: FallbackActivation | null;
  /** The failover event in flight or just closed; absent between events. */
  failover?: FallbackEvent;
  /** Activation memory, keyed by `provider/id`. */
  models: Record<string, FallbackModelMemory>;
}

/** The custom entry type the worker writes {@link SessionFallbackEntry} under. */
export const SESSION_FALLBACK_ENTRY_TYPE = `${WIRE_NAMESPACE}/fallback`;

/** Laser's own cooldown for a transient failure, when the provider stated nothing (§2.6). */
export const FALLBACK_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
