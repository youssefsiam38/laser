import type { SessionAppendTransaction, SessionManager } from "@earendil-works/pi-coding-agent";
import type { DriverEvent } from "../driver.js";

export interface FirstTurnAttemptState<Previous, Prepared> {
  phase: "preparing" | "prepared" | "restoring";
  previous: Previous;
  manager: SessionManager;
  transaction: SessionAppendTransaction;
  prepared?: Prepared;
  cancelled: boolean;
  readonly deferred: DriverEvent[];
  readonly dialogIds: Set<string>;
}

type AttemptSlot<Previous, Prepared> =
  | { phase: "idle" }
  | { phase: "active"; attempt: FirstTurnAttemptState<Previous, Prepared> };

/**
 * The invariant boundary for Stable's speculative first-turn runtime.
 * There is either no attempt or one complete attempt record; correlated
 * manager/transaction/rollback/provenance fields cannot drift independently.
 */
export class FirstTurnAttempt<Previous, Prepared> {
  private slot: AttemptSlot<Previous, Prepared> = { phase: "idle" };

  get active(): FirstTurnAttemptState<Previous, Prepared> | undefined {
    return this.slot.phase === "active" ? this.slot.attempt : undefined;
  }

  start(previous: Previous, manager: SessionManager, transaction: SessionAppendTransaction): FirstTurnAttemptState<Previous, Prepared> {
    if (this.slot.phase !== "idle") throw new Error("a first-turn attempt is already active");
    const attempt: FirstTurnAttemptState<Previous, Prepared> = {
      phase: "preparing",
      previous,
      manager,
      transaction,
      cancelled: false,
      deferred: [],
      dialogIds: new Set(),
    };
    this.slot = { phase: "active", attempt };
    return attempt;
  }

  markPrepared(prepared: Prepared): void {
    const attempt = this.require("mark prepared");
    if (attempt.phase !== "preparing") throw new Error(`cannot mark a ${attempt.phase} first-turn attempt prepared`);
    attempt.prepared = prepared;
    attempt.phase = "prepared";
  }

  isCancelled(): boolean {
    return this.active?.cancelled === true;
  }

  cancel(): string[] {
    const attempt = this.active;
    if (!attempt) return [];
    attempt.cancelled = true;
    const ids = [...attempt.dialogIds];
    attempt.dialogIds.clear();
    return ids;
  }

  /** False means cancellation already owns this late question; close it now. */
  ownDialog(id: string): boolean {
    const attempt = this.active;
    if (!attempt) return true;
    if (attempt.cancelled) return false;
    attempt.dialogIds.add(id);
    return true;
  }

  closeDialog(id: string): void {
    this.active?.dialogIds.delete(id);
  }

  defer(event: DriverEvent): boolean {
    const attempt = this.active;
    if (!attempt) return false;
    const immediate = event.type === "ui_request"
      || (event.type === "ui_event" && (event.event.method === "dialogResolved" || event.event.method === "notify"))
      || (event.type === "update" && event.update.kind === "extension_error");
    if (immediate) return false;
    attempt.deferred.push(event);
    return true;
  }

  beginRestore(): FirstTurnAttemptState<Previous, Prepared> | undefined {
    const attempt = this.active;
    if (!attempt) return undefined;
    if (attempt.phase === "restoring") throw new Error("first-turn restoration is already active");
    attempt.phase = "restoring";
    return attempt;
  }

  finishRestore(attempt: FirstTurnAttemptState<Previous, Prepared>): void {
    if (this.active !== attempt || attempt.phase !== "restoring") throw new Error("first-turn restoration lost its attempt ownership");
    this.slot = { phase: "idle" };
  }

  takeForCommit(): FirstTurnAttemptState<Previous, Prepared> {
    const attempt = this.require("commit");
    if (attempt.phase !== "prepared" || attempt.prepared === undefined) {
      throw new Error(`cannot commit an incomplete ${attempt.phase} first-turn attempt`);
    }
    this.slot = { phase: "idle" };
    return attempt;
  }

  takeForDispose(): FirstTurnAttemptState<Previous, Prepared> | undefined {
    const attempt = this.active;
    this.slot = { phase: "idle" };
    return attempt;
  }

  private require(operation: string): FirstTurnAttemptState<Previous, Prepared> {
    const attempt = this.active;
    if (!attempt) throw new Error(`cannot ${operation} without an active first-turn attempt`);
    return attempt;
  }
}
