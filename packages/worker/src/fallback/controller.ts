/**
 * The Model Profile controller (`docs/model-profiles.md` "Runtime"; the
 * mechanics are M15-T3's, recorded in `docs/model-fallback-chains.md` §2–§4).
 *
 * It owns one session's profile: when one activates, what a failed turn does to
 * it, which model is tried next, and what is written down. Everything it needs
 * from the engine comes through {@link FallbackEngine}, so the whole state
 * machine runs in tests without a provider — the driver is the only thing that
 * knows an `AgentSession` exists.
 *
 * The shape of one failover, in the order it happens:
 *
 *   the engine finishes its own retries and gives up
 *     → classify; a failure that is not about reaching the model stops here
 *     → open a failover event, remember what this model did
 *     → earlier models in the chain, one request each, in chain order
 *     → then the next fallback, with its normal retry policy
 *     → the first normal response wins and the session stays on that model
 *     → nothing left: preserve the task, say what stood in the way, schedule
 *       nothing.
 */

import {
  classifyProviderFailure,
  failureWording,
  modelKey,
  sameModel,
  type FallbackActivation,
  type FallbackEvent,
  type ModelIdentity,
  type ModelProfile,
  type ProfileModelRef,
  type ModelRef,
  type ProviderFailure,
  type ProviderFailureClass,
  type ProviderFailureSignal,
  type SessionFallbackEntry,
  type SessionFallbackSummary,
  type SessionUpdate,
} from "@lasercode/protocol";

import {
  activate,
  attemptDirection,
  clearActivationMarks,
  CONTEXT_TOO_LONG_REASON,
  exhaustionDetail,
  nextCandidate,
  opensFailover,
  rememberFailure,
  startPosition,
  type CandidateModel,
  type SkippedCandidate,
} from "./policy.js";
import { EMPTY_FALLBACK_STATE, entryFor, restoreFallbackState, summaryFor, type FallbackState } from "./state.js";

/** The one skip reason that is bookkeeping rather than something to tell a person. */
const ALREADY_TRIED = "already tried in this switch";

type AttemptResult =
  | { kind: "succeeded" }
  | { kind: "aborted" }
  | { kind: "stopped" }
  | { kind: "failed"; failure: ProviderFailure };

type RecoverResult =
  | { kind: "succeeded" }
  | { kind: "aborted" }
  | { kind: "stopped" }
  | { kind: "exhausted" }
  | { kind: "none" }
  | { kind: "reenter"; tokens: number; skipped: readonly SkippedCandidate[] }
  | { kind: "failed"; failure: ProviderFailure; candidate: ProfileModelRef; tokens: number };

/**
 * Person-facing exhaustion reasons: drop bookkeeping, drop a size skip that a
 * later non-skipped attempt superseded, and keep each model once.
 */
function personFacingSkips(
  skipped: readonly SkippedCandidate[],
  failover: FallbackEvent | null | undefined,
): SkippedCandidate[] {
  const attempted = new Set(
    (failover?.attempts ?? [])
      .filter((attempt) => attempt.outcome !== "skipped")
      .map((attempt) => attempt.model),
  );
  const seen = new Set<string>();
  const out: SkippedCandidate[] = [];
  for (const entry of skipped) {
    if (entry.reason === ALREADY_TRIED) continue;
    const key = modelKey(entry.model);
    if (attempted.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ model: entry.model, reason: entry.reason });
  }
  return out;
}

/** Everything the controller needs from the live session, and nothing more. */
export interface FallbackEngine {
  /**
   * The profile this session is running on, read fresh. A saved edit applies
   * to the next activation, never to the one already in flight.
   */
  profile(): ModelProfile | null;
  selectedModel(): ProfileModelRef | null;
  /** Eligibility facts per `provider/id`. */
  catalogue(): Promise<ReadonlyMap<string, CandidateModel>>;
  /** Names for what a person reads, per `provider/id`. */
  names(): ReadonlyMap<string, ModelRef>;
  contextTokens(): number | null;
  /**
   * The failure of the last assistant message, or undefined when it did not
   * fail. This is what makes "did the new model answer" a fact rather than a
   * guess: a normal response clears it.
   */
  lastFailure(): ProviderFailureSignal | undefined;
  setModel(model: ProfileModelRef): Promise<void>;
  /** Stop whatever the engine has in flight, so a person's choice is final. */
  abortTurn(): void;
  /** Continue the interrupted turn on the model that is selected now. */
  continueTurn(options: { retries: "none" | "normal"; signal: AbortSignal }): Promise<void>;
  /** Settings → Auto-compaction. Size recovery does not run when this is off. */
  autoCompactionEnabled(): boolean;
  /**
   * Summarise history on the model already selected. Must return a finite
   * nonnegative `estimatedTokensAfter`; a missing estimate is a compact failure.
   */
  compact(signal: AbortSignal): Promise<{ estimatedTokensAfter: number }>;
  appendEntry(entry: SessionFallbackEntry): void;
  emit(update: SessionUpdate): void;
  now(): number;
  newId(): string;
}

export class FallbackController {
  private state: FallbackState = EMPTY_FALLBACK_STATE;
  /** Bumped by a person's own model choice; a failover step older than this stops. */
  private generation = 0;
  private switching = false;
  private lastSwitch: { from: ProfileModelRef; to: ProfileModelRef; reason: ProviderFailureClass; at: string } | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly engine: FallbackEngine) {}

  /** A failover event is in flight: the session is working, on no settled model. */
  get busy(): boolean {
    return this.switching;
  }

  summary(): SessionFallbackSummary | undefined {
    const profile = this.engine.profile();
    return summaryFor(this.state, {
      catalogue: this.engine.names(),
      ...(profile && profile.id === this.state.activation?.profileId ? { profile } : {}),
      ...(this.switching ? { switching: true } : {}),
      ...(this.lastSwitch ? { lastSwitch: this.lastSwitch } : {}),
    });
  }

  /** The profile id this session is actually running on, or null when it is pinned. */
  activeProfileId(): string | null {
    return this.state.activation?.profileId ?? null;
  }

  /** The session file's own last word, restored verbatim (§4). */
  restore(entries: readonly unknown[]): void {
    this.state = restoreFallbackState(entries, { at: this.iso() });
  }

  /**
   * Resolve a chain for the model this session is on, when no traversal was
   * restored. Nothing is written: an activation with no history is exactly
   * what the next open would resolve again, and a record per open would be
   * noise in every session that never fails.
   */
  activateIfUnset(): void {
    if (this.state.activation) return;
    const activation = this.activationForSelectedModel();
    if (activation) this.state = { ...this.state, activation };
  }

  /**
   * A pristine session accepted the agent/model tuple prepared for its first
   * turn. Runtime preparation can replace the model that `open()` saw, so its
   * provisional activation must follow the accepted runtime's actual model.
   *
   * A traversal that has already moved is never re-resolved here, and the rule
   * is enforced in this method rather than left to the caller: the driver only
   * reaches this boundary on a pristine session today, but a restored
   * traversal must survive whatever a future caller believes about that.
   */
  activateForAcceptedSelection(): void {
    if (this.state.failover || (this.state.activation?.position ?? 0) > 0) return;
    const selected = this.engine.selectedModel();
    const activation = this.state.activation;
    const active = activation?.models[activation.position];
    if (sameModel(active, selected)) return;
    this.state = { ...this.state, activation: this.activationForSelectedModel() };
  }

  /**
   * A person pinned this session to one model.
   *
   * A pin is the deliberate escape hatch: the session leaves its profile and
   * has nothing to move to. Anything in flight is cancelled, the activation
   * goes, and the marks only a decision can clear go with it. Cooldowns are
   * instants and survive.
   */
  onPin(model: ProfileModelRef): void {
    this.stopInFlight();
    const had = this.state.activation !== null || Object.keys(this.state.models).length > 0;
    this.state = { activation: null, models: clearActivationMarks(this.state.models) };
    this.lastSwitch = undefined;
    if (had) this.write("cleared", { to: model });
  }

  /**
   * A person chose a profile. Their choice wins over anything in flight: the
   * session re-anchors to that profile's first model and starts a fresh
   * activation, with a fresh snapshot of the profile as it is now.
   */
  onProfileChosen(profile: ModelProfile): FallbackActivation | null {
    this.stopInFlight();
    const activation = activate(profile, { id: this.engine.newId(), at: this.iso() });
    this.state = { activation, models: clearActivationMarks(this.state.models) };
    this.lastSwitch = undefined;
    this.write(activation ? "activated" : "cleared", {
      ...(activation?.models[activation.position] ? { to: activation.models[activation.position]! } : {}),
    });
    return activation;
  }

  /**
   * Where this session should begin inside its profile.
   *
   * The profile's first model unless it cannot be used right now, in which case
   * the walk continues in order and every model it passed over is recorded —
   * exactly as a move would record it, so "why am I not on the model I chose"
   * is answerable from the session's own file.
   *
   * Returns the model to select, or `null` when position 0 already stands.
   * A session with a traversal behind it is never re-walked.
   */
  async startWalk(): Promise<ProfileModelRef | null> {
    const activation = this.state.activation;
    if (!activation || activation.position !== 0 || this.state.failover) return null;
    const catalogue = await this.engine.catalogue();
    const { position, skipped } = startPosition({
      activation,
      // Availability only. A cooldown is what a *move* respects; at the moment
      // a person anchors a session to a profile, the question is whether the
      // model can be reached at all — not whether it was unlucky ten minutes
      // ago (`docs/model-profiles.md`, "Runtime").
      memory: {},
      catalogue,
      contextTokens: null,
      now: this.engine.now(),
    });
    if (position === 0 || skipped.length === 0) return null;
    const at = this.iso();
    this.state = {
      ...this.state,
      activation: { ...activation, position },
      failover: {
        id: this.engine.newId(),
        startedAt: at,
        attempts: skipped.map((entry) => ({ model: modelKey(entry.model), at, outcome: "skipped" as const, reason: entry.reason })),
        endedAt: at,
        ended: "switched" as const,
      },
    };
    const model = activation.models[position]!;
    this.write("activated", { to: model });
    this.engine.emit({
      kind: "model_fallback",
      phase: "switched",
      to: this.ref(model),
      reason: "unknown",
      detail: `Started on ${this.name(model)}: ${skipped.map((entry) => `${this.name(entry.model)} ${entry.reason}`).join(", ")}.`,
      profileId: activation.profileId,
      position,
    });
    return model;
  }

  /** Stop a failover: an abort, a cancelled turn, a disposed session. */
  cancel(): void {
    this.generation++;
    this.abort?.abort();
  }

  /**
   * Whether the turn that just settled might fail over. The driver holds the
   * engine's `agent_settled` on this, because the engine emits it before the
   * failover can even begin and the harness reads it as "the run is over".
   */
  pending(): boolean {
    if (this.switching || !this.state.activation) return false;
    const signal = this.engine.lastFailure();
    if (!signal) return false;
    return opensFailover(classifyProviderFailure(signal).class);
  }

  /**
   * The failover itself, run after the engine's own turn has settled. Resolves
   * when the session is on a model that answered, or when the chain is spent.
   */
  async settle(): Promise<boolean> {
    const activation = this.state.activation;
    if (this.switching || !activation) return false;
    const signal = this.engine.lastFailure();
    if (!signal) return false;
    const failure = classifyProviderFailure(signal);
    if (!opensFailover(failure.class)) return false;

    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.switching = true;
    const failed = activation.models[activation.position] ?? this.engine.selectedModel();
    // The model the chain is standing on, as the traversal moves: the sentence
    // a person reads at the end is about what failed last, not what failed
    // first.
    let standing = failed;
    let standingFailure = failure;
    // After a compact, Pi's usage is null until the next assistant. Freeze the
    // estimate for the rest of this failover so later models are sized against
    // it, never against a blind attempt.
    let tokensForTraversal: number | null | undefined;
    let compactedThisEvent = false;
    // One policy skip is one attempt record even when compact recovery causes
    // another traversal over the same candidates.
    const recordedSkips = new Set<string>();
    const recordSkip = (entry: SkippedCandidate): void => {
      const key = `${modelKey(entry.model)}\0${entry.reason}`;
      if (recordedSkips.has(key)) return;
      recordedSkips.add(key);
      this.recordAttempt(entry.model, { outcome: "skipped", reason: entry.reason });
    };
    // Size skips recorded while B is selected vanish from the next traversal
    // (B is the active model). Carry them so later exhaustion still names them.
    let carriedSkips: SkippedCandidate[] = [];
    try {
      if (!failed) return false;
      this.openEvent(failed, failure);
      this.engine.emit({
        kind: "model_fallback",
        phase: "switching",
        from: this.ref(failed),
        reason: failure.class,
        detail: `${this.name(failed)} ${failureWording(failure.class)}.`,
        profileId: activation.profileId,
        position: activation.position,
      });

      for (;;) {
        if (this.stale(generation, abort)) return this.closeEvent("aborted");
        const live = this.state.activation ?? activation;
        // One snapshot per traversal step. Recovery uses this same map — compact
        // must not re-read the catalogue and chase a window that has since moved.
        const catalogue = await this.engine.catalogue();
        const traversal = nextCandidate({
          activation: live,
          memory: this.state.models,
          event: this.event(),
          catalogue,
          contextTokens: tokensForTraversal !== undefined ? tokensForTraversal : this.engine.contextTokens(),
          now: this.engine.now(),
        });
        if (traversal.kind === "exhausted") {
          const sizeBlocked = traversal.skipped.filter((entry) => entry.reason === CONTEXT_TOO_LONG_REASON);
          if (!compactedThisEvent && this.engine.autoCompactionEnabled() && sizeBlocked.length > 0) {
            const recovered = await this.recoverOversized({
              sizeBlocked,
              allSkipped: traversal.skipped,
              catalogue,
              exhaustionPosition: live.position,
              models: live.models,
              origin: failed,
              originFailure: failure,
              standing: standing ?? failed,
              standingFailure,
              generation,
              abort,
              markCompacted: () => {
                compactedThisEvent = true;
              },
              recordSkip,
            });
            if (recovered.kind === "aborted") return this.closeEvent("aborted");
            if (recovered.kind === "exhausted" || recovered.kind === "stopped") return false;
            if (recovered.kind === "succeeded") return true;
            if (recovered.kind === "reenter" || recovered.kind === "failed") {
              tokensForTraversal = recovered.tokens;
              if (recovered.kind === "reenter") {
                carriedSkips = [...carriedSkips, ...recovered.skipped];
              }
              if (recovered.kind === "failed") {
                standing = recovered.candidate;
                standingFailure = recovered.failure;
              }
              continue;
            }
            // `none`: every size-blocked candidate refused setModel. Re-run the
            // traversal so those failures are "already tried", not a stale size skip.
            continue;
          }
          for (const skipped of traversal.skipped) recordSkip(skipped);
          if (this.stale(generation, abort)) return this.closeEvent("aborted");
          this.exhausted(standing ?? failed, standingFailure, [...carriedSkips, ...traversal.skipped]);
          return false;
        }

        for (const skipped of traversal.skipped) recordSkip(skipped);
        if (this.stale(generation, abort)) return this.closeEvent("aborted");

        const candidate = traversal.model;
        const selected = await this.selectCandidate(candidate);
        if (selected === "refused") continue;
        this.moveTo(traversal.position);
        const result = await this.finishAttempt({
          origin: failed,
          originFailure: failure,
          candidate,
          position: traversal.position,
          direction: traversal.direction,
          retries: traversal.retries,
          generation,
          abort,
        });
        if (result.kind === "aborted") return this.closeEvent("aborted");
        if (result.kind === "succeeded") return true;
        if (result.kind === "stopped") return false;
        standing = candidate;
        standingFailure = result.failure;
      }
    } finally {
      this.switching = false;
      if (this.abort === abort) this.abort = undefined;
    }
  }

  // ------------------------------------------------------------------ internals

  /**
   * Shared continuation/result path: the model is already selected and the
   * activation already stands on it. Recovery joins here after compact; the
   * ordinary attempt path joins after `setModel`.
   */
  private async finishAttempt(options: {
    origin: ProfileModelRef;
    originFailure: ProviderFailure;
    candidate: ProfileModelRef;
    position: number;
    direction: "return" | "advance";
    retries: "none" | "normal";
    generation: number;
    abort: AbortController;
  }): Promise<AttemptResult> {
    if (this.stale(options.generation, options.abort)) return { kind: "aborted" };
    let thrown: unknown;
    try {
      await this.engine.continueTurn({ retries: options.retries, signal: options.abort.signal });
    } catch (error) {
      thrown = error;
    }
    if (this.stale(options.generation, options.abort)) return { kind: "aborted" };

    const after = this.engine.lastFailure();
    if (!after && !thrown) {
      this.succeeded(options.origin, options.candidate, options.position, options.direction, options.originFailure);
      return { kind: "succeeded" };
    }
    const next = after ? classifyProviderFailure(after) : { class: "unknown" as const };
    this.recordAttempt(options.candidate, { outcome: "failed", class: next.class });
    this.state = {
      ...this.state,
      models: rememberFailure(this.state.models, options.candidate, next, { now: this.engine.now() }),
    };
    this.engine.emit({
      kind: "model_fallback",
      phase: "attempt_failed",
      to: this.ref(options.candidate),
      reason: next.class,
      detail: `${this.name(options.candidate)} ${failureWording(next.class)}.`,
      ...this.profileRef(),
      position: options.position,
    });
    this.write("attempt_failed", { to: options.candidate, failure: { class: next.class, at: this.iso() } });
    if (!opensFailover(next.class)) {
      // The new model failed for a reason a chain cannot answer (the
      // conversation is too long, the provider refused the content, the
      // person stopped it). Leave the session here and say so once.
      this.exhausted(options.candidate, next, []);
      return { kind: "stopped" };
    }
    return { kind: "failed", failure: next };
  }

  private async selectCandidate(candidate: ProfileModelRef): Promise<"selected" | "refused"> {
    try {
      await this.engine.setModel(candidate);
      return "selected";
    } catch {
      // A model the catalogue offered and the engine then refused — no
      // credential, gone from the catalogue since. That is an attempt, not
      // a skip: it counts against this failover and marks the model for
      // the rest of the activation, so the traversal moves on instead of
      // knocking on the same door forever.
      this.recordAttempt(candidate, { outcome: "failed", class: "credential", reason: "could not be selected" });
      this.state = {
        ...this.state,
        models: rememberFailure(this.state.models, candidate, { class: "credential" }, { now: this.engine.now() }),
      };
      this.write("attempt_failed", { to: candidate, failure: { class: "credential", at: this.iso() } });
      return "refused";
    }
  }

  /**
   * Size-only exhaustion: compact once under the first selectable oversized
   * candidate, then either continue that candidate or re-enter traversal from
   * it with the frozen estimate so a later larger window can take the turn.
   */
  private async recoverOversized(options: {
    sizeBlocked: SkippedCandidate[];
    allSkipped: SkippedCandidate[];
    catalogue: ReadonlyMap<string, CandidateModel>;
    exhaustionPosition: number;
    models: readonly ProfileModelRef[];
    origin: ProfileModelRef;
    originFailure: ProviderFailure;
    standing: ProfileModelRef;
    standingFailure: ProviderFailure;
    generation: number;
    abort: AbortController;
    markCompacted: () => void;
    recordSkip: (entry: SkippedCandidate) => void;
  }): Promise<RecoverResult> {
    for (const entry of options.sizeBlocked) {
      if (this.stale(options.generation, options.abort)) return { kind: "aborted" };
      const index = options.models.findIndex((model) => sameModel(model, entry.model));
      if (index < 0) continue;
      const direction = attemptDirection(options.exhaustionPosition, index);
      const retries = direction === "return" ? "none" : "normal";
      const selected = await this.selectCandidate(entry.model);
      if (selected === "refused") continue;
      this.moveTo(index);
      if (this.stale(options.generation, options.abort)) return { kind: "aborted" };
      // The exhausted snapshot already observed these candidates. Persist its
      // non-size reasons before compact starts; size candidates remain
      // recoverable and are recorded only if recovery cannot make them fit.
      for (const skipped of options.allSkipped) {
        if (skipped.reason !== CONTEXT_TOO_LONG_REASON) options.recordSkip(skipped);
      }
      options.markCompacted();
      let estimate: number;
      try {
        estimate = (await this.engine.compact(options.abort.signal)).estimatedTokensAfter;
      } catch {
        if (this.stale(options.generation, options.abort)) return { kind: "aborted" };
        options.recordSkip(entry);
        this.exhausted(options.standing, options.standingFailure, options.allSkipped);
        return { kind: "exhausted" };
      }
      if (this.stale(options.generation, options.abort)) return { kind: "aborted" };
      if (!Number.isFinite(estimate) || estimate < 0) {
        options.recordSkip(entry);
        this.exhausted(options.standing, options.standingFailure, options.allSkipped);
        return { kind: "exhausted" };
      }
      const window = options.catalogue.get(modelKey(entry.model))?.contextWindow;
      if (window !== undefined && estimate > window) {
        options.recordSkip(entry);
        return { kind: "reenter", tokens: estimate, skipped: [entry] };
      }
      const result = await this.finishAttempt({
        origin: options.origin,
        originFailure: options.originFailure,
        candidate: entry.model,
        position: index,
        direction,
        retries,
        generation: options.generation,
        abort: options.abort,
      });
      if (result.kind === "failed") return { kind: "failed", failure: result.failure, candidate: entry.model, tokens: estimate };
      return result;
    }
    return { kind: "none" };
  }

  private activationForSelectedModel(): FallbackActivation | null {
    const profile = this.engine.profile();
    if (!profile) return null;
    const selected = this.engine.selectedModel();
    const index = selected ? profile.models.findIndex((model) => sameModel(model, selected)) : -1;
    return activate(profile, {
      id: this.engine.newId(),
      at: this.iso(),
      ...(index > 0 ? { position: index } : {}),
    });
  }

  /** Cancel whatever is in flight so a person's own choice is final, not a race. */
  private stopInFlight(): void {
    const wasSwitching = this.switching;
    this.generation++;
    this.abort?.abort();
    // A request may already be out on a model the person has just replaced.
    // Stopping the engine is what makes their choice final: a late answer would
    // otherwise land, and its failure would open a move inside a profile that
    // no longer applies.
    if (wasSwitching) this.engine.abortTurn();
  }

  private stale(generation: number, abort: AbortController): boolean {
    return generation !== this.generation || abort.signal.aborted;
  }

  private event(): FallbackEvent {
    return this.state.failover ?? { id: "none", startedAt: this.iso(), attempts: [] };
  }

  private openEvent(failed: ProfileModelRef, failure: ProviderFailure): void {
    const at = this.iso();
    this.state = {
      ...this.state,
      models: rememberFailure(this.state.models, failed, failure, { now: this.engine.now() }),
      failover: {
        id: this.engine.newId(),
        startedAt: at,
        attempts: [{ model: modelKey(failed), at, outcome: "failed", class: failure.class }],
      },
    };
    this.write("attempt_failed", { from: failed, failure: { class: failure.class, at } });
  }

  /** The session is on the model at this index now; the activation says so. */
  private moveTo(position: number): void {
    const activation = this.state.activation;
    if (!activation || activation.position === position) return;
    this.state = { ...this.state, activation: { ...activation, position } };
  }

  private closeEvent(ended: NonNullable<FallbackEvent["ended"]>): boolean {
    const failover = this.state.failover;
    if (failover && failover.ended === undefined) {
      this.state = { ...this.state, failover: { ...failover, ended, endedAt: this.iso() } };
    }
    return false;
  }

  private recordAttempt(model: ProfileModelRef, outcome: Omit<FallbackEvent["attempts"][number], "model" | "at">): void {
    const failover = this.state.failover;
    if (!failover) return;
    this.state = {
      ...this.state,
      failover: { ...failover, attempts: [...failover.attempts, { model: modelKey(model), at: this.iso(), ...outcome }] },
    };
  }

  private succeeded(
    from: ProfileModelRef,
    to: ProfileModelRef,
    position: number,
    direction: "return" | "advance",
    failure: ProviderFailure,
  ): void {
    const at = this.iso();
    this.recordAttempt(to, { outcome: "succeeded" });
    this.moveTo(position);
    this.closeEvent(direction === "return" ? "returned" : "switched");
    this.lastSwitch = { from: this.ref(from), to: this.ref(to), reason: failure.class, at };
    this.write(direction === "return" ? "returned" : "switched", {
      from,
      to,
      failure: { class: failure.class, at },
    });
    this.engine.emit({
      kind: "model_fallback",
      phase: "switched",
      from: this.ref(from),
      to: this.ref(to),
      reason: failure.class,
      detail: `${this.name(from)} ${failureWording(failure.class)}.`,
      ...this.profileRef(),
      position,
    });
  }

  private exhausted(
    failed: ProfileModelRef,
    failure: ProviderFailure,
    skipped: ReadonlyArray<{ model: ProfileModelRef; reason: string }>,
  ): void {
    const at = this.iso();
    this.closeEvent("exhausted");
    this.write("exhausted", { from: failed, failure: { class: failure.class, at } });
    const detail = `${this.name(failed)} ${failureWording(failure.class)}. ${exhaustionDetail(personFacingSkips(skipped, this.state.failover), (model) => this.name(model))}`;
    this.engine.emit({
      kind: "model_fallback",
      phase: "exhausted",
      from: this.ref(failed),
      reason: failure.class,
      detail,
      ...this.profileRef(),
      position: this.state.activation?.position ?? 0,
    });
  }

  private write(
    event: SessionFallbackEntry["event"],
    options: { from?: ProfileModelRef; to?: ProfileModelRef; failure?: { class: ProviderFailureClass; at: string } } = {},
  ): void {
    try {
      this.engine.appendEntry(
        entryFor({
          event,
          at: this.iso(),
          state: this.state,
          ...(options.from ? { from: options.from } : {}),
          ...(options.to ? { to: options.to } : {}),
          ...(options.failure ? { failure: options.failure } : {}),
        }),
      );
    } catch {
      // A record that could not be written must not cost the person the
      // switch it describes: the session keeps working, the next transition
      // writes the whole state again.
    }
  }

  /** The profile a move happened inside, for the update a client draws. */
  private profileRef(): { profileId?: string } {
    const id = this.state.activation?.profileId;
    return id ? { profileId: id } : {};
  }

  private ref(model: ProfileModelRef): ModelRef {
    return this.engine.names().get(modelKey(model)) ?? { provider: model.provider, id: model.id };
  }

  private name(model: ProfileModelRef): string {
    const known = this.engine.names().get(modelKey(model));
    return known?.name ?? model.id;
  }

  private iso(): string {
    return new Date(this.engine.now()).toISOString();
  }
}


/** Exported for the driver's own equality checks. */
export { sameModel };
export type { FallbackActivation };
