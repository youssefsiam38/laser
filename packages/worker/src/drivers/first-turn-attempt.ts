import type { SessionAppendTransaction, SessionManager } from "@earendil-works/pi-coding-agent";
import type { DriverEvent } from "../driver.js";

interface FirstTurnAttemptCommon<Previous> {
  readonly token: symbol;
  readonly previous: Previous;
  readonly manager: SessionManager;
  readonly transaction: SessionAppendTransaction;
  cancelled: boolean;
  readonly deferred: DriverEvent[];
  readonly dialogIds: Set<string>;
}

export type FirstTurnAttemptState<Previous, Prepared> =
  | (FirstTurnAttemptCommon<Previous> & { readonly phase: "preparing" })
  | (FirstTurnAttemptCommon<Previous> & { readonly phase: "prepared"; readonly prepared: Prepared })
  | (FirstTurnAttemptCommon<Previous> & { readonly phase: "restoring" });

export interface FirstTurnAttemptOwner {
  readonly token: symbol;
}

type AttemptSlot<Previous, Prepared> =
  | { phase: "idle" }
  | { phase: "active"; attempt: FirstTurnAttemptState<Previous, Prepared> };

/**
 * The invariant boundary for Stable's speculative first-turn runtime.
 * There is either no attempt or one phase-complete attempt record; correlated
 * manager/transaction/rollback/provenance fields cannot drift independently.
 */
export class FirstTurnAttempt<Previous, Prepared> {
  private slot: AttemptSlot<Previous, Prepared> = { phase: "idle" };

  /** Deliberately boolean: callers cannot mutate the coordinator's live record. */
  get active(): boolean {
    return this.slot.phase === "active";
  }

  start(previous: Previous, manager: SessionManager, transaction: SessionAppendTransaction): FirstTurnAttemptOwner {
    if (this.slot.phase !== "idle") throw new Error("a first-turn attempt is already active");
    const token = Symbol("first-turn-attempt");
    this.slot = {
      phase: "active",
      attempt: {
        phase: "preparing",
        token,
        previous,
        manager,
        transaction,
        cancelled: false,
        deferred: [],
        dialogIds: new Set(),
      },
    };
    return Object.freeze({ token });
  }

  markPrepared(owner: FirstTurnAttemptOwner, prepared: Prepared): void {
    const attempt = this.requireOwned(owner, "mark prepared");
    if (attempt.cancelled) throw new Error("cannot mark a cancelled first-turn attempt prepared");
    if (attempt.phase !== "preparing") throw new Error(`cannot mark a ${attempt.phase} first-turn attempt prepared`);
    const next: Extract<FirstTurnAttemptState<Previous, Prepared>, { phase: "prepared" }> = {
      ...attempt,
      phase: "prepared",
      prepared,
    };
    this.slot = { phase: "active", attempt: next };
  }

  owns(owner: FirstTurnAttemptOwner): boolean {
    return this.slot.phase === "active" && this.slot.attempt.token === owner.token;
  }

  isCancelled(owner?: FirstTurnAttemptOwner): boolean {
    const attempt = owner ? this.requireOwned(owner, "check cancellation") : this.current();
    return attempt?.cancelled === true;
  }

  cancel(): string[] {
    const attempt = this.current();
    if (!attempt) return [];
    attempt.cancelled = true;
    const ids = [...attempt.dialogIds];
    attempt.dialogIds.clear();
    return ids;
  }

  /** False means cancellation already owns this late question; close it now. */
  ownDialog(id: string): boolean {
    const attempt = this.current();
    if (!attempt) return true;
    if (attempt.cancelled) return false;
    attempt.dialogIds.add(id);
    return true;
  }

  closeDialog(id: string): void {
    this.current()?.dialogIds.delete(id);
  }

  defer(event: DriverEvent): boolean {
    const attempt = this.current();
    if (!attempt) return false;
    const immediate = event.type === "ui_request"
      || (event.type === "ui_event" && (event.event.method === "dialogResolved" || event.event.method === "notify"))
      || (event.type === "update" && event.update.kind === "extension_error");
    if (immediate) return false;
    attempt.deferred.push(event);
    return true;
  }

  beginRestore(owner?: FirstTurnAttemptOwner): Extract<FirstTurnAttemptState<Previous, Prepared>, { phase: "restoring" }> | undefined {
    const attempt = owner ? this.requireOwned(owner, "restore") : this.current();
    if (!attempt) return undefined;
    if (attempt.phase === "restoring") throw new Error("first-turn restoration is already active");
    const next: Extract<FirstTurnAttemptState<Previous, Prepared>, { phase: "restoring" }> = {
      phase: "restoring",
      token: attempt.token,
      previous: attempt.previous,
      manager: attempt.manager,
      transaction: attempt.transaction,
      cancelled: attempt.cancelled,
      deferred: attempt.deferred,
      dialogIds: attempt.dialogIds,
    };
    this.slot = { phase: "active", attempt: next };
    return next;
  }

  finishRestore(attempt: Extract<FirstTurnAttemptState<Previous, Prepared>, { phase: "restoring" }>): void {
    const current = this.require("finish restoration");
    if (current !== attempt || current.token !== attempt.token || current.phase !== "restoring") {
      throw new Error("first-turn restoration lost its attempt ownership");
    }
    this.slot = { phase: "idle" };
  }

  takeForCommit(): Extract<FirstTurnAttemptState<Previous, Prepared>, { phase: "prepared" }> {
    const attempt = this.require("commit");
    if (attempt.cancelled) throw new Error("cannot commit a cancelled first-turn attempt");
    if (attempt.phase !== "prepared") throw new Error(`cannot commit an incomplete ${attempt.phase} first-turn attempt`);
    this.slot = { phase: "idle" };
    return attempt;
  }

  takeForDispose(): FirstTurnAttemptState<Previous, Prepared> | undefined {
    const attempt = this.current();
    this.slot = { phase: "idle" };
    return attempt;
  }

  private current(): FirstTurnAttemptState<Previous, Prepared> | undefined {
    return this.slot.phase === "active" ? this.slot.attempt : undefined;
  }

  private require(operation: string): FirstTurnAttemptState<Previous, Prepared> {
    const attempt = this.current();
    if (!attempt) throw new Error(`cannot ${operation} without an active first-turn attempt`);
    return attempt;
  }

  private requireOwned(owner: FirstTurnAttemptOwner, operation: string): FirstTurnAttemptState<Previous, Prepared> {
    const attempt = this.require(operation);
    if (attempt.token !== owner.token) throw new Error(`cannot ${operation}: stale first-turn attempt ownership`);
    return attempt;
  }
}
