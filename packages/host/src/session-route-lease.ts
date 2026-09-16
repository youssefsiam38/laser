/**
 * RP-4c · per-session route leases: releasing a runtime releases a *runtime*,
 * never the host's mutation authority over that conversation.
 *
 * The defect this exists for is a check-then-act inside the router: it read
 * "this session is open in that worker", then awaited the pool, then awaited a
 * `session/load` it decided to skip, and finally wrote the mutation — while the
 * lifetime sweep was entitled, correctly, to ask the worker to let that runtime
 * go. The worker then refused a prompt that had never been delivered, with a
 * sentence nobody could act on. The same shape exists whenever a worker is
 * retired or replaced under those awaits.
 *
 * The rule here is a readers–writer lease per session path, host-local:
 *
 * - **path-routed requests are readers.** One lease covers choosing the worker,
 *   ensure-open, the request itself *and* the host bookkeeping that records
 *   where that session now lives, so none of those decisions can go stale
 *   between the others.
 * - **a lifetime release is a writer.** It runs only when no reader holds the
 *   path, and it declines synchronously when one does — no worker is asked, so
 *   nothing is written and nothing is refused after the fact.
 * - **moving a session is the other writer.** Closing the runtime, rewriting the
 *   file and handing the caches their new path is one exclusive operation over
 *   both the old and the new path: readers cannot run beside it, and it is
 *   refused outright rather than queued when anything else holds either path.
 *
 * And the fail-closed half (D-260): a route that meets a release in flight waits
 * for that release's *outcome*, bounded. A release that failed, and a gate that
 * passed the bound, both refuse the route with one temporary, actionable
 * sentence, having written nothing to any worker. Cleaning the bookkeeping up is
 * a memory obligation; it is never permission to route into uncertain authority.
 *
 * Nothing is queued and nothing is retained: a reader entry lives exactly as
 * long as one in-flight request, at most one release gate exists per path, and
 * both maps are empty again when a path goes quiet (RP-7).
 */
import { ErrorCodes, ProtocolError } from "@lasercode/protocol";

/**
 * Longest a routed request waits for a release to finish letting go before it
 * refuses. Same order of magnitude as the pool's retirement timeout: past this,
 * the host cannot prove who owns the runtime, and says so.
 */
export const ROUTE_GATE_WAIT_MS = 10_000;

/**
 * What a person sees when the host declined to route: what happened, that
 * nothing was sent, and what to do. No path, no engine words, no stack.
 */
export const ROUTE_GATE_REFUSAL =
  "This conversation is being put to sleep and has not finished letting go. Nothing was sent. Try again in a moment.";

/** The same, for a route that met a move of the same conversation. */
export const MOVE_GATE_REFUSAL =
  "This conversation is being moved to another project. Nothing was sent. Try again in a moment.";

/** And what a move is told when the conversation is busy with something else. */
export const EXCLUSIVE_BUSY_REFUSAL =
  "This conversation is busy right now. Nothing was moved. Try again in a moment.";

/**
 * How many consecutive release gates one routed request waits out before it
 * refuses. A release never waits for a reader, so a route can only ever meet a
 * *new* release that started after the previous one finished; this keeps that
 * bounded by construction rather than by luck.
 */
const MAX_GATES_PER_ROUTE = 3;

type GateOutcome = "settled" | "failed";

/** Why a path is held against readers: released, or moved. */
type WriterKind = "release" | "move";

export interface SessionRouteLeaseOptions {
  /** Test seam for the route wait bound. */
  waitMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * One release in flight for one path. The promise **never rejects**: it resolves
 * with the release's outcome, so no waiter can see an unhandled rejection and no
 * waiter can mistake a failed release for a finished one.
 */
class WriterGate {
  /** Set when the shared bound passed while this gate was still unsettled. */
  overBound = false;
  readonly outcome: Promise<GateOutcome>;
  private resolveOutcome!: (outcome: GateOutcome) => void;
  /** One expiry promise and one timer for every waiter on this gate. */
  private expiry: Promise<"expired"> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;

  constructor(
    readonly kind: WriterKind,
    private readonly waitMs: number,
    private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
    private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
  ) {
    this.outcome = new Promise<GateOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
  }

  /** Wait for the outcome, or for the bound to pass — whichever comes first. */
  wait(): Promise<GateOutcome | "expired"> {
    if (this.done) return this.outcome;
    if (!this.expiry) {
      this.expiry = new Promise<"expired">((resolve) => {
        this.timer = this.setTimer(() => {
          this.overBound = true;
          resolve("expired");
        }, this.waitMs);
        (this.timer as { unref?: () => void }).unref?.();
      });
    }
    return Promise.race([this.outcome, this.expiry]);
  }

  settle(outcome: GateOutcome): void {
    if (this.done) return;
    this.done = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.overBound = false;
    this.resolveOutcome(outcome);
  }
}

export class SessionRouteLeases {
  /** Routed requests in flight, by path. Deleted at zero. */
  private readonly routed = new Map<string, number>();
  /** Routed requests waiting on a writer, by path. Deleted at zero. */
  private readonly waiting = new Map<string, number>();
  /** At most one writer gate per path. Deleted when that writer finishes. */
  private readonly writers = new Map<string, WriterGate>();
  private readonly waitMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(options: SessionRouteLeaseOptions = {}) {
    this.waitMs = options.waitMs ?? ROUTE_GATE_WAIT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /**
   * Run one path-routed request — ensure-open *and* the request — under the
   * lease.
   *
   * A release in flight is waited out first, so the ensure-open decision inside
   * `work` is made against the pool as it is *after* that release's own
   * bookkeeping has landed. A release that failed, or one that passed the bound,
   * refuses instead: `work` is never called, so no worker is asked anything.
   */
  async route<T>(path: string, work: () => Promise<T>): Promise<T> {
    for (let gates = 0; ; gates += 1) {
      const gate = this.writers.get(path);
      if (!gate) break;
      // A gate that already passed its bound refuses at once: N waiters must not
      // each pay the full wait for one uncertainty.
      if (gate.overBound || gates >= MAX_GATES_PER_ROUTE) throw routeRefusal(gate.kind);
      this.note(this.waiting, path, 1);
      let outcome: GateOutcome | "expired";
      try {
        outcome = await gate.wait();
      } finally {
        this.note(this.waiting, path, -1);
      }
      if (outcome !== "settled") throw routeRefusal(gate.kind);
    }
    this.routed.set(path, (this.routed.get(path) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.routed.get(path) ?? 1) - 1;
      if (left > 0) this.routed.set(path, left);
      else this.routed.delete(path);
    }
  }

  /** Routed requests holding this path right now. */
  routedHolders(path: string): number {
    return this.routed.get(path) ?? 0;
  }

  /** Routed requests parked on a writer of this path right now. */
  waitingRoutes(path: string): number {
    return this.waiting.get(path) ?? 0;
  }

  /** Whether a writer of this path is in flight, and which kind. */
  writerPending(path: string): WriterKind | undefined {
    return this.writers.get(path)?.kind;
  }

  /** Bookkeeping sizes, so a test can prove nothing is retained per path. */
  stats(): { routed: number; waiting: number; writers: number } {
    return { routed: this.routed.size, waiting: this.waiting.size, writers: this.writers.size };
  }

  /**
   * Run one release, or decline it.
   *
   * Two synchronous declines, both before `work` can ask a worker anything: a
   * routed request holds the path, or a release for it is already in flight (so
   * a second `pi/session/unload` is never sent and a second gate can never
   * exist). A decline answers `undefined`; the caller turns that into the
   * "nothing happened" shape its own protocol uses.
   */
  async release<T>(path: string, work: () => Promise<T>): Promise<T | undefined> {
    if (this.routedHolders(path) > 0) return undefined;
    if (this.writers.has(path)) return undefined;
    const gate = new WriterGate("release", this.waitMs, this.setTimer, this.clearTimer);
    this.writers.set(path, gate);
    let outcome: GateOutcome = "failed";
    try {
      const result = await work();
      outcome = "settled";
      return result;
    } finally {
      // Cleanup always happens — a failed release, a dead worker, an unknown
      // method — so no path can be leased for ever. The outcome is what decides
      // whether a waiting route may run, and only `settled` does.
      this.writers.delete(path);
      gate.settle(outcome);
    }
  }

  /**
   * Run one exclusive operation over these paths: no reader may run beside it
   * and no release may start under it, for the whole of it.
   *
   * Moving a session is the case this exists for. It closes a runtime, rewrites
   * a file and moves the host's record of where that conversation lives, and
   * every one of those steps is authority over the same path — a reader lease,
   * which coexists with other readers, would not make it the one writer.
   *
   * Unlike a release, this is a person's operation, so it never waits on an
   * uncertain authority: anything else holding either path refuses it at once,
   * with a sentence saying nothing was moved. Acquisition is synchronous across
   * every path, so two exclusive operations can never each hold half of what
   * they need.
   */
  async exclusive<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
    const held = [...new Set(paths)];
    for (const path of held) {
      if (this.routedHolders(path) > 0 || this.waitingRoutes(path) > 0 || this.writers.has(path)) {
        throw new ProtocolError(ErrorCodes.SessionBusy, EXCLUSIVE_BUSY_REFUSAL);
      }
    }
    const gates = held.map((path) => {
      const gate = new WriterGate("move", this.waitMs, this.setTimer, this.clearTimer);
      this.writers.set(path, gate);
      return { path, gate };
    });
    let outcome: GateOutcome = "failed";
    try {
      const result = await work();
      outcome = "settled";
      return result;
    } finally {
      // A move that failed leaves the same uncertainty a failed release does:
      // the entries go, so nothing is held for ever, and the waiters that were
      // parked on it are refused rather than let through.
      for (const { path, gate } of gates) {
        this.writers.delete(path);
        gate.settle(outcome);
      }
    }
  }

  /** Move a bounded counter, deleting the row at zero. */
  private note(counters: Map<string, number>, path: string, delta: number): void {
    const next = (counters.get(path) ?? 0) + delta;
    if (next > 0) counters.set(path, next);
    else counters.delete(path);
  }
}

function routeRefusal(kind: WriterKind): ProtocolError {
  return new ProtocolError(ErrorCodes.SessionBusy, kind === "move" ? MOVE_GATE_REFUSAL : ROUTE_GATE_REFUSAL);
}
