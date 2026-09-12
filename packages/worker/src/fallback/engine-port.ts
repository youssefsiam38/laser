/**
 * The fallback chain's window onto a live Pi session (M15-T3,
 * `docs/model-fallback-chains.md` §3).
 *
 * Everything engine-shaped about a fallback is here: reading the catalogue,
 * changing the model, and continuing the interrupted turn. The controller
 * above it is pure policy, and the driver below it supplies one thing — the
 * session — plus the small set of callbacks that belong to it (emitting an
 * update, reading the failure it observed on the event stream).
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
// The engine's own retry classifier, from the same exact pin the engine uses
// (`core/agent-session.js` imports it from here). Reproducing the
// continuation's retry decision with a copy would drift on the first Pi bump
// (MX-T2).
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  modelKey,
  SESSION_FALLBACK_ENTRY_TYPE,
  type ModelRef,
  type ProviderFailureSignal,
  type SessionFallbackEntry,
  type SessionUpdate,
  type ThinkingLevel,
} from "@lasercode/protocol";

import { disabledModelRefs, modelSwitchedOff, readEffectiveProductSettings, readFallbackChains } from "../settings.js";
import type { FallbackEngine } from "./controller.js";
import type { CandidateModel } from "./policy.js";

export interface FallbackPortOptions {
  /** The live session. Read each time: a runtime replacement swaps it. */
  session: () => AgentSession;
  /** Latest person-chosen intent, read after the asynchronous model switch. */
  explicitThinkingLevel?: () => ThinkingLevel | undefined;
  agentDir: string;
  cwd: string;
  projectTrusted: boolean | undefined;
  /** How the failed attempt looked on the driver's event stream. */
  failure: () => ProviderFailureSignal | undefined;
  emit: (update: SessionUpdate) => void;
  /** The selected model changed under the person: publish the session state. */
  onModelChanged: () => void;
}

export function createFallbackEnginePort(options: FallbackPortOptions): FallbackEngine {
  const { session, emit } = options;
  return {
    chains: () => readFallbackChains(options.agentDir),
    selectedModel: () => {
      const model = session().model;
      return model && model.provider !== "unknown" ? { provider: model.provider, id: model.id } : null;
    },
    catalogue: () => catalogueOf(options),
    names: () => namesOf(session),
    contextTokens: () => session().getContextUsage()?.tokens ?? null,
    lastFailure: () => options.failure(),
    setModel: async (model) => {
      const match = session().modelRuntime.getModels().find((m) => m.provider === model.provider && m.id === model.id);
      if (!match) throw new Error(`unknown model ${model.provider}/${model.id}`);
      const current = session();
      const thinkingLevel = current.thinkingLevel;
      await current.setModel(match);
      // Pi selects model/global defaults on setModel. A fallback changes only
      // the model, not the person's effort. Let Pi clamp and persist the level
      // for this model; re-read explicit intent in case it changed during auth
      // or model-select hooks, and retain it across less-capable candidates.
      current.setThinkingLevel(options.explicitThinkingLevel?.() ?? thinkingLevel);
      // The status line names the model being tried, so it has to hear about
      // it while the failover is still running.
      options.onModelChanged();
    },
    abortTurn: () => {
      void session().abort().catch(() => {});
    },
    continueTurn: (opts) => continueTurn(session(), opts, emit),
    appendEntry: (entry: SessionFallbackEntry) => {
      session().sessionManager.appendCustomEntry(SESSION_FALLBACK_ENTRY_TYPE, entry);
    },
    emit,
    now: () => Date.now(),
    newId: () => `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/**
 * Eligibility facts per model: is it in the catalogue, can it be used at all,
 * and how much conversation does it hold.
 *
 * `signedIn` is never assumed. `getAvailable()` is the engine's own answer and
 * is preferred; when it fails or says nothing, the synchronous credential
 * check stands in, and when that is unavailable too the model counts as not
 * signed in — a candidate the chain skips with a recorded reason. Claiming a
 * credential nobody could confirm only moves the refusal into `setModel`,
 * where it costs a round of the traversal to discover.
 */
async function catalogueOf(options: FallbackPortOptions): Promise<ReadonlyMap<string, CandidateModel>> {
  const runtime = options.session().modelRuntime;
  const all = runtime.getModels();
  let available: Set<string> | undefined;
  try {
    const list = await runtime.getAvailable();
    if (list.length > 0) available = new Set(list.map((model) => modelKey(model)));
  } catch {
    // Fall through to the credential check below.
  }
  const configured = (provider: string): boolean => {
    try {
      return runtime.hasConfiguredAuth(provider);
    } catch {
      return false;
    }
  };
  const disabled = disabledModelRefs(
    readEffectiveProductSettings(options.cwd, options.agentDir, options.projectTrusted)["disabledModels"],
  );
  const catalogue = new Map<string, CandidateModel>();
  for (const model of all) {
    catalogue.set(modelKey(model), {
      ref: { provider: model.provider, id: model.id },
      contextWindow: model.contextWindow,
      signedIn: available ? available.has(modelKey(model)) : configured(model.provider),
      offered: !modelSwitchedOff(model, disabled),
    });
  }
  return catalogue;
}

/** Catalogue names for what a person reads about a chain. */
function namesOf(session: () => AgentSession): ReadonlyMap<string, ModelRef> {
  const names = new Map<string, ModelRef>();
  try {
    for (const model of session().modelRuntime.getModels()) {
      names.set(modelKey(model), {
        provider: model.provider,
        id: model.id,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      });
    }
  } catch {
    // No runtime to ask: identities alone still render.
  }
  return names;
}

/**
 * Continue the interrupted turn on the model selected now (§3.1).
 *
 * The engine's own idiom, in its own two steps: the failed attempt is removed
 * from agent state (it stays in the session file as history, and
 * `agent.continue()` refuses a transcript whose last message is an assistant
 * message), then the agent continues from the transcript it already has — no
 * user message, no replayed tool, no second request in flight.
 *
 * The post-run loop the engine runs around this is private, so the two parts of
 * it that are policy are reproduced here from the same settings the engine
 * reads, with the same classifier it uses: the retry budget for a newly
 * activated model (`retries: "normal"`), and draining messages queued while the
 * turn ran. A return attempt gets `retries: "none"` — one request, as the
 * specification requires.
 */
async function continueTurn(
  session: AgentSession,
  options: { retries: "none" | "normal"; signal: AbortSignal },
  emit: (update: SessionUpdate) => void,
): Promise<void> {
  const settings = session.settingsManager.getRetrySettings();
  const budget = options.retries === "none" || !settings.enabled ? 0 : settings.maxRetries;
  let retried = 0;
  for (let attempt = 0; ; attempt++) {
    if (options.signal.aborted) return;
    dropTrailingErrorAssistant(session);
    await session.agent.continue();
    // What the engine's post-run loop does last: messages queued during the
    // turn get their continuation rather than waiting for the next prompt.
    while (!options.signal.aborted && session.agent.hasQueuedMessages()) await session.agent.continue();
    const last = lastAssistantMessage(session);
    if (!last || last.stopReason !== "error") {
      if (retried > 0) emit({ kind: "auto_retry_end", ok: true });
      return;
    }
    if (attempt >= budget || options.signal.aborted || !isRetryableAssistantError(last)) {
      if (retried > 0) emit({ kind: "auto_retry_end", ok: false });
      return;
    }
    retried = attempt + 1;
    emit({ kind: "auto_retry_start", attempt: retried, maxAttempts: budget });
    try {
      await sleep(settings.baseDelayMs * 2 ** attempt, options.signal);
    } catch {
      emit({ kind: "auto_retry_end", ok: false });
      return;
    }
  }
}

/**
 * Remove a failed attempt from agent state, leaving it in the session file.
 *
 * This is the engine's own move, in the two places it continues an interrupted
 * turn (`_prepareRetry`, and the overflow-recovery branch of `_checkCompaction`
 * in `core/agent-session.js`): `agent.continue()` rejects a transcript whose
 * last message is an assistant message, and the error is history, not context.
 */
export function dropTrailingErrorAssistant(session: AgentSession): void {
  const messages = session.agent.state.messages;
  const last = messages[messages.length - 1] as { role?: unknown; stopReason?: unknown } | undefined;
  if (last?.role !== "assistant") return;
  if (last.stopReason !== "error" && last.stopReason !== "aborted" && last.stopReason !== "length") return;
  session.agent.state.messages = messages.slice(0, -1);
}

/** The last assistant message in agent state, failed ones included. */
export function lastAssistantMessage(session: AgentSession): AssistantMessage | undefined {
  const messages = session.agent.state.messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

/** An abortable wait; rejects when the signal fires, so a stop is immediate. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
