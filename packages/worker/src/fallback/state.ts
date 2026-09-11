/**
 * The durable half of a session's fallback chain (M15-T3,
 * `docs/model-fallback-chains.md` §4): building the record that is appended to
 * the session file, reading the last one back, and the summary the UI reads.
 *
 * Pure, like `policy.ts`. The driver appends what `entryFor` returns and hands
 * `restoreFallbackState` the entries the session file already had.
 */

import {
  modelKey,
  sessionFallbackEntrySchema,
  SESSION_FALLBACK_ENTRY_TYPE,
  type FallbackActivation,
  type FallbackEntryEvent,
  type FallbackEvent,
  type FallbackModelMemory,
  type FallbackModelRef,
  type ModelRef,
  type ProviderFailureClass,
  type SessionFallbackEntry,
  type SessionFallbackSummary,
} from "@lasercode/protocol";

export interface FallbackState {
  activation: FallbackActivation | null;
  models: Record<string, FallbackModelMemory>;
  /** Absent between failover events. */
  failover?: FallbackEvent;
}

export const EMPTY_FALLBACK_STATE: FallbackState = { activation: null, models: {} };

export interface EntryOptions {
  event: FallbackEntryEvent;
  at: string;
  state: FallbackState;
  from?: FallbackModelRef | undefined;
  to?: FallbackModelRef | undefined;
  failure?: { class: ProviderFailureClass; at: string } | undefined;
}

/** The record for one transition: the whole state, plus what caused this write. */
export function entryFor(options: EntryOptions): SessionFallbackEntry {
  const { state } = options;
  return {
    version: 1,
    event: options.event,
    at: options.at,
    ...(options.from ? { from: bare(options.from) } : {}),
    ...(options.to ? { to: bare(options.to) } : {}),
    ...(options.failure ? { failure: options.failure } : {}),
    activation: state.activation ? { ...state.activation, models: state.activation.models.map(bare) } : null,
    ...(state.failover ? { failover: state.failover } : {}),
    models: state.models,
  };
}

/**
 * The state a session file carries, from its last fallback record.
 *
 * Two rules that matter more than they look:
 *
 *  - the activation is restored **verbatim**. After a fallback the selected
 *    model is not the chain's first model, so resolving a chain from it again
 *    would either lose the chain or enter that model's own — the recursion the
 *    specification forbids.
 *  - a failover event that was still in flight is closed as `aborted`, not
 *    resumed: the turn it belonged to did not survive whatever ended the last
 *    process. Its attempts stay, so a model that failed a minute ago is not
 *    tried again the moment the session reopens.
 *
 * A malformed record leaves the session with no chain rather than half a
 * traversal; that is the same behaviour as a session that never had one.
 */
export function restoreFallbackState(entries: readonly unknown[], options?: { at?: string }): FallbackState {
  const raw = [...entries]
    .reverse()
    .find((entry) => {
      const candidate = entry as { type?: unknown; customType?: unknown } | null;
      return candidate?.type === "custom" && candidate.customType === SESSION_FALLBACK_ENTRY_TYPE;
    }) as { data?: unknown } | undefined;
  if (!raw) return EMPTY_FALLBACK_STATE;
  const parsed = sessionFallbackEntrySchema.safeParse(raw.data);
  if (!parsed.success) return EMPTY_FALLBACK_STATE;
  const entry = parsed.data as unknown as SessionFallbackEntry;
  const failover = entry.failover && entry.failover.ended === undefined
    ? { ...entry.failover, ended: "aborted" as const, endedAt: options?.at ?? new Date().toISOString() }
    : entry.failover;
  return {
    activation: entry.activation,
    models: entry.models,
    ...(failover ? { failover } : {}),
  };
}

/** What the UI reads: the chain resolved for display, where it is, and what just happened. */
export function summaryFor(
  state: FallbackState,
  options: {
    catalogue: ReadonlyMap<string, ModelRef>;
    switching?: boolean;
    lastSwitch?: { from: FallbackModelRef; to: FallbackModelRef; reason: ProviderFailureClass; at: string } | undefined;
  },
): SessionFallbackSummary | undefined {
  const activation = state.activation;
  if (!activation) return undefined;
  const resolve = (model: FallbackModelRef): ModelRef => options.catalogue.get(modelKey(model)) ?? bare(model);
  return {
    chain: activation.models.map(resolve),
    position: activation.position,
    ...(options.switching ? { switching: true } : {}),
    ...(options.lastSwitch
      ? {
          lastSwitch: {
            from: resolve(options.lastSwitch.from),
            to: resolve(options.lastSwitch.to),
            reason: options.lastSwitch.reason,
            at: options.lastSwitch.at,
          },
        }
      : {}),
  };
}

/** Identity only: a stored chain never carries a catalogue's names or sizes. */
function bare(model: FallbackModelRef): FallbackModelRef {
  return { provider: model.provider, id: model.id };
}
