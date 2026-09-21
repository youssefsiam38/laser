/**
 * The durable half of a session's profile: building the record that is appended
 * to the session file, reading the last one back, and the summary a client
 * reads (`docs/model-profiles.md` "Runtime"; the record's mechanics are
 * `docs/model-fallback-chains.md` §4).
 *
 * Pure, like `policy.ts`. The driver appends what `entryFor` returns and hands
 * `restoreFallbackState` the entries the session file already had.
 */

import {
  isLegacyChainActivation,
  isModelProfileId,
  modelKey,
  sameModel,
  sessionFallbackEntrySchema,
  SESSION_FALLBACK_ENTRY_TYPE,
  type FallbackActivation,
  type FallbackEntryEvent,
  type FallbackEvent,
  type FallbackModelMemory,
  type ModelIdentity,
  type ModelProfile,
  type ModelRef,
  type ProfileModelRef,
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
  from?: ModelIdentity | undefined;
  to?: ModelIdentity | undefined;
  failure?: { class: ProviderFailureClass; at: string } | undefined;
}

/** Validate a persisted envelope once for both restoration and admission. */
function fallbackEntryData(raw: unknown): SessionFallbackEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const envelope = raw as { type?: unknown; customType?: unknown; data?: unknown };
  if (envelope.type !== "custom" || envelope.customType !== SESSION_FALLBACK_ENTRY_TYPE) return undefined;
  const parsed = sessionFallbackEntrySchema.safeParse(envelope.data);
  return parsed.success ? parsed.data as unknown as SessionFallbackEntry : undefined;
}

/**
 * Whether one retained session entry proves only a person's pre-turn model setup.
 *
 * This is intentionally narrower than "a fallback entry": traversal, failure
 * memory, malformed data, and contradictory identities all mean the
 * conversation has history. The strict protocol schema owns the wire shape;
 * the canonical model helpers own identity comparisons.
 *
 * The one moved activation that is still setup is the **start-time walk**: a
 * session that has run no turn at all, standing on the first model of its
 * profile it can reach, with the models it passed over recorded as skips
 * (`docs/model-profiles.md`, "Runtime"). Counting that as history would refuse
 * the first-turn agent choice on exactly the machines the walk exists for.
 */
export function isSetupOnlyFallbackEntry(raw: unknown): boolean {
  const entry = fallbackEntryData(raw);
  if (!entry) return false;
  if (
    !entry.to
    || entry.from !== undefined
    || entry.failure !== undefined
    || Object.keys(entry.models).length > 0
  ) return false;
  if (entry.event === "cleared") return entry.activation === null && entry.failover === undefined;
  if (entry.event !== "activated" || !entry.activation) return false;
  // Persisted records are not necessarily current app writes. Refuse an
  // activation our setup path cannot produce, even if its fields pass the
  // wire schema — including a pre-M22 one, which is history and never setup.
  if (isLegacyChainActivation(entry.activation)) return false;
  if (!isModelProfileId(entry.activation.profileId)) return false;
  const models = entry.activation.models;
  if (models.length === 0 || models.length !== new Set(models.map(modelKey)).size) return false;
  const position = entry.activation.position;
  if (!isStartWalkOnly(entry.failover, position)) return false;
  return sameModel(models[position], entry.to);
}

/** A closed traversal that only ever skipped, one skip per model it started past. */
function isStartWalkOnly(failover: FallbackEvent | undefined, position: number): boolean {
  if (!failover) return position === 0;
  if (position === 0 || failover.ended !== "switched" || !failover.endedAt) return false;
  if (failover.attempts.length !== position) return false;
  return failover.attempts.every((attempt) => attempt.outcome === "skipped" && attempt.class === undefined);
}

/** The record for one transition: the whole state, plus what caused this write. */
export function entryFor(options: EntryOptions): SessionFallbackEntry {
  const { state } = options;
  return {
    version: 1,
    event: options.event,
    at: options.at,
    ...(options.from ? { from: identityOf(options.from) } : {}),
    ...(options.to ? { to: identityOf(options.to) } : {}),
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
 *  - the activation is restored **verbatim**. After a move the selected model
 *    is not the one the profile prefers, so re-resolving from it would put the
 *    conversation back on a model that has just failed.
 *  - an activation written before profiles existed is **not** restored as an
 *    activation. Its entries stay readable as history, and the session it
 *    belongs to keeps its model and displays as pinned
 *    (`docs/model-profiles.md`, "Migration").
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
  // Validate the last matching record, not the last valid record: a corrupt
  // tail must never resurrect an older traversal.
  const entry = fallbackEntryData(raw);
  if (!entry) return EMPTY_FALLBACK_STATE;
  const failover = entry.failover && entry.failover.ended === undefined
    ? { ...entry.failover, ended: "aborted" as const, endedAt: options?.at ?? new Date().toISOString() }
    : entry.failover;
  return {
    activation: isLegacyChainActivation(entry.activation) ? null : entry.activation,
    models: entry.models,
    ...(failover ? { failover } : {}),
  };
}

/** True when this session's last record was written before profiles existed. */
export function hasLegacyActivation(entries: readonly unknown[]): boolean {
  const raw = [...entries]
    .reverse()
    .find((entry) => {
      const candidate = entry as { type?: unknown; customType?: unknown } | null;
      return candidate?.type === "custom" && candidate.customType === SESSION_FALLBACK_ENTRY_TYPE;
    }) as { data?: unknown } | undefined;
  return isLegacyChainActivation(fallbackEntryData(raw)?.activation);
}

/** What the UI reads: the chain resolved for display, where it is, and what just happened. */
export function summaryFor(
  state: FallbackState,
  options: {
    catalogue: ReadonlyMap<string, ModelRef>;
    profile?: ModelProfile | undefined;
    switching?: boolean;
    lastSwitch?: { from: ModelIdentity; to: ModelIdentity; reason: ProviderFailureClass; at: string } | undefined;
  },
): SessionFallbackSummary | undefined {
  const activation = state.activation;
  if (!activation) return undefined;
  const resolve = (model: ModelIdentity): ModelRef => options.catalogue.get(modelKey(model)) ?? bare(model);
  return {
    profileId: activation.profileId,
    ...(options.profile ? { profileName: options.profile.name } : {}),
    models: activation.models.map(resolve),
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

/** A model's identity, and nothing a catalogue added to it. */
function identityOf(model: ModelIdentity): ModelIdentity {
  return { provider: model.provider, id: model.id };
}

/** Identity plus the profile's own thinking choice; never a catalogue's names or sizes. */
function bare(model: ProfileModelRef): ProfileModelRef {
  return { provider: model.provider, id: model.id, ...(model.thinking ? { thinking: model.thinking } : {}) };
}
