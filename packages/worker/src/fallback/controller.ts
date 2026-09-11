/**
 * The fallback chain controller (M15-T3, `docs/model-fallback-chains.md` §2–§4).
 *
 * It owns one session's chain: when one activates, what a failed turn does to
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
  modelKey,
  sameModel,
  type FallbackActivation,
  type FallbackChain,
  type FallbackEvent,
  type FallbackModelRef,
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
  clearActivationMarks,
  exhaustionDetail,
  nextCandidate,
  opensFailover,
  rememberFailure,
  type CandidateModel,
} from "./policy.js";
import { EMPTY_FALLBACK_STATE, entryFor, restoreFallbackState, summaryFor, type FallbackState } from "./state.js";

/** The one skip reason that is bookkeeping rather than something to tell a person. */
const ALREADY_TRIED = "already tried in this switch";

/** Everything the controller needs from the live session, and nothing more. */
export interface FallbackEngine {
  /** Read fresh: a saved edit applies to the next activation, never to this one. */
  chains(): FallbackChain[];
  selectedModel(): FallbackModelRef | null;
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
  setModel(model: FallbackModelRef): Promise<void>;
  /** Continue the interrupted turn on the model that is selected now. */
  continueTurn(options: { retries: "none" | "normal"; signal: AbortSignal }): Promise<void>;
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
  private lastSwitch: { from: FallbackModelRef; to: FallbackModelRef; reason: ProviderFailureClass; at: string } | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly engine: FallbackEngine) {}

  /** A failover event is in flight: the session is working, on no settled model. */
  get busy(): boolean {
    return this.switching;
  }

  summary(): SessionFallbackSummary | undefined {
    return summaryFor(this.state, {
      catalogue: this.engine.names(),
      ...(this.switching ? { switching: true } : {}),
      ...(this.lastSwitch ? { lastSwitch: this.lastSwitch } : {}),
    });
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
    const activation = activate(this.engine.chains(), this.engine.selectedModel(), {
      id: this.engine.newId(),
      at: this.iso(),
    });
    if (activation) this.state = { ...this.state, activation };
  }

  /**
   * A person chose a model. Their choice wins over anything in flight: the
   * failover is cancelled, the activation is replaced by whatever chain that
   * model starts (or none), and the marks that only a decision can clear go
   * with it. Cooldowns are instants and survive.
   */
  onManualSelection(model: FallbackModelRef): void {
    this.generation++;
    this.abort?.abort();
    const had = this.state.activation !== null || Object.keys(this.state.models).length > 0;
    const activation = activate(this.engine.chains(), model, { id: this.engine.newId(), at: this.iso() });
    this.state = {
      activation,
      models: clearActivationMarks(this.state.models),
    };
    this.lastSwitch = undefined;
    if (had) this.write(activation ? "activated" : "cleared", { to: model });
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
    try {
      if (!failed) return false;
      this.openEvent(failed, failure);
      this.engine.emit({
        kind: "model_fallback",
        phase: "switching",
        from: this.ref(failed),
        reason: failure.class,
        detail: `${this.name(failed)} ${failureWording(failure.class)}.`,
        position: activation.position,
      });

      for (;;) {
        if (this.stale(generation, abort)) return this.closeEvent("aborted");
        const traversal = nextCandidate({
          activation: this.state.activation ?? activation,
          memory: this.state.models,
          event: this.event(),
          catalogue: await this.engine.catalogue(),
          contextTokens: this.engine.contextTokens(),
          now: this.engine.now(),
        });
        for (const skipped of traversal.skipped) this.recordAttempt(skipped.model, { outcome: "skipped", reason: skipped.reason });
        if (this.stale(generation, abort)) return this.closeEvent("aborted");
        if (traversal.kind === "exhausted") {
          this.exhausted(
            standing ?? failed,
            standingFailure,
            // "already tried in this switch" is bookkeeping, not a reason a
            // person needs; the attempt it refers to already had its say.
            traversal.skipped.filter((entry) => entry.reason !== ALREADY_TRIED).map((entry) => ({ model: entry.model, reason: entry.reason })),
          );
          return false;
        }

        const candidate = traversal.model;
        try {
          await this.engine.setModel(candidate);
        } catch (error) {
          // A model the catalogue offered and the engine then refused: record
          // the refusal in the person's words and carry on down the chain.
          this.recordAttempt(candidate, { outcome: "skipped", reason: "could not be selected" });
          if (error instanceof Error && error.message) this.note(candidate, error.message);
          continue;
        }
        if (this.stale(generation, abort)) return this.closeEvent("aborted");

        let thrown: unknown;
        try {
          await this.engine.continueTurn({ retries: traversal.retries, signal: abort.signal });
        } catch (error) {
          thrown = error;
        }
        if (this.stale(generation, abort)) return this.closeEvent("aborted");

        const after = this.engine.lastFailure();
        if (!after && !thrown) {
          this.succeeded(failed, candidate, traversal.position, traversal.direction, failure);
          return true;
        }
        const next = after ? classifyProviderFailure(after) : { class: "unknown" as const };
        this.recordAttempt(candidate, { outcome: "failed", class: next.class });
        this.state = {
          ...this.state,
          models: rememberFailure(this.state.models, candidate, next, { now: this.engine.now() }),
        };
        this.engine.emit({
          kind: "model_fallback",
          phase: "attempt_failed",
          to: this.ref(candidate),
          reason: next.class,
          detail: `${this.name(candidate)} ${failureWording(next.class)}.`,
          position: traversal.position,
        });
        this.write("attempt_failed", { to: candidate, failure: { class: next.class, at: this.iso() } });
        standing = candidate;
        standingFailure = next;
        if (!opensFailover(next.class)) {
          // The new model failed for a reason a chain cannot answer (the
          // conversation is too long, the provider refused the content, the
          // person stopped it). Leave the session here and say so once.
          this.exhausted(candidate, next, []);
          return false;
        }
      }
    } finally {
      this.switching = false;
      if (this.abort === abort) this.abort = undefined;
    }
  }

  // ------------------------------------------------------------------ internals

  private stale(generation: number, abort: AbortController): boolean {
    return generation !== this.generation || abort.signal.aborted;
  }

  private event(): FallbackEvent {
    return this.state.failover ?? { id: "none", startedAt: this.iso(), attempts: [] };
  }

  private openEvent(failed: FallbackModelRef, failure: ProviderFailure): void {
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

  private closeEvent(ended: NonNullable<FallbackEvent["ended"]>): boolean {
    const failover = this.state.failover;
    if (failover && failover.ended === undefined) {
      this.state = { ...this.state, failover: { ...failover, ended, endedAt: this.iso() } };
    }
    return false;
  }

  private recordAttempt(model: FallbackModelRef, outcome: Omit<FallbackEvent["attempts"][number], "model" | "at">): void {
    const failover = this.state.failover;
    if (!failover) return;
    this.state = {
      ...this.state,
      failover: { ...failover, attempts: [...failover.attempts, { model: modelKey(model), at: this.iso(), ...outcome }] },
    };
  }

  private succeeded(
    from: FallbackModelRef,
    to: FallbackModelRef,
    position: number,
    direction: "return" | "advance",
    failure: ProviderFailure,
  ): void {
    const at = this.iso();
    this.recordAttempt(to, { outcome: "succeeded" });
    const activation = this.state.activation;
    this.state = {
      ...this.state,
      ...(activation ? { activation: { ...activation, position } } : {}),
    };
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
      position,
    });
  }

  private exhausted(
    failed: FallbackModelRef,
    failure: ProviderFailure,
    skipped: ReadonlyArray<{ model: FallbackModelRef; reason: string }>,
  ): void {
    const at = this.iso();
    this.closeEvent("exhausted");
    this.write("exhausted", { from: failed, failure: { class: failure.class, at } });
    const detail = `${this.name(failed)} ${failureWording(failure.class)}. ${exhaustionDetail(skipped, (model) => this.name(model))}`;
    this.engine.emit({
      kind: "model_fallback",
      phase: "exhausted",
      from: this.ref(failed),
      reason: failure.class,
      detail,
      position: this.state.activation?.position ?? 0,
    });
  }

  /** A refusal the engine worded itself, kept as this model's last failure note. */
  private note(model: FallbackModelRef, _message: string): void {
    this.state = {
      ...this.state,
      models: {
        ...this.state.models,
        [modelKey(model)]: { ...this.state.models[modelKey(model)], lastFailure: { class: "unknown", at: this.iso() } },
      },
    };
  }

  private write(
    event: SessionFallbackEntry["event"],
    options: { from?: FallbackModelRef; to?: FallbackModelRef; failure?: { class: ProviderFailureClass; at: string } } = {},
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

  private ref(model: FallbackModelRef): ModelRef {
    return this.engine.names().get(modelKey(model)) ?? { provider: model.provider, id: model.id };
  }

  private name(model: FallbackModelRef): string {
    const known = this.engine.names().get(modelKey(model));
    return known?.name ?? model.id;
  }

  private iso(): string {
    return new Date(this.engine.now()).toISOString();
  }
}

/** What happened, for a person, with no provider payload and no credential in it. */
export function failureWording(failure: ProviderFailureClass): string {
  switch (failure) {
    case "credential":
      return "did not accept its credential";
    case "permission":
      return "refused this request";
    case "credits":
      return "has no credit left";
    case "allowance":
      return "has used up its allowance";
    case "rate_limit":
      return "is being rate-limited";
    case "provider_down":
      return "is not answering";
    case "connection":
      return "could not be reached";
    case "model_missing":
      return "is no longer offered by its provider";
    case "context_overflow":
      return "cannot hold this conversation";
    case "safety":
      return "declined to answer";
    case "aborted":
      return "was stopped";
    default:
      return "failed";
  }
}

/** Exported for the driver's own equality checks. */
export { sameModel };
export type { FallbackActivation };
