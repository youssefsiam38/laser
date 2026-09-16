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
 * - **path-routed requests are readers.** One lease covers ensure-open *and*
 *   the request that follows it, so the decision not to re-open cannot go stale
 *   between the two.
 * - **a lifetime release is the writer.** It runs only when no reader holds the
 *   path, and it declines synchronously when one does — no worker is asked, so
 *   nothing is written and nothing is refused after the fact.
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

/**
 * How many consecutive release gates one routed request waits out before it
 * refuses. A release never waits for a reader, so a route can only ever meet a
 * *new* release that started after the previous one finished; this keeps that
 * bounded by construction rather than by luck.
 */
const MAX_GATES_PER_ROUTE = 3;

type GateOutcome = "settled" | "failed";

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
class ReleaseGate {
  /** Set when the shared bound passed while this gate was still unsettled. */
  overBound = false;
  readonly outcome: Promise<GateOutcome>;
  private resolveOutcome!: (outcome: GateOutcome) => void;
  /** One expiry promise and one timer for every waiter on this gate. */
  private expiry: Promise<"expired"> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;

  constructor(
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
  /** At most one release gate per path. Deleted when the release finishes. */
  private readonly releasing = new Map<string, ReleaseGate>();
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
      const gate = this.releasing.get(path);
      if (!gate) break;
      // A gate that already passed its bound refuses at once: N waiters must not
      // each pay the full wait for one uncertainty.
      if (gate.overBound || gates >= MAX_GATES_PER_ROUTE) throw routeRefusal();
      const outcome = await gate.wait();
      if (outcome !== "settled") throw routeRefusal();
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

  /** Whether a release for this path is in flight. */
  releasePending(path: string): boolean {
    return this.releasing.has(path);
  }

  /** Bookkeeping sizes, so a test can prove nothing is retained per path. */
  stats(): { routed: number; releasing: number } {
    return { routed: this.routed.size, releasing: this.releasing.size };
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
    if (this.releasing.has(path)) return undefined;
    const gate = new ReleaseGate(this.waitMs, this.setTimer, this.clearTimer);
    this.releasing.set(path, gate);
    let outcome: GateOutcome = "failed";
    try {
      const result = await work();
      outcome = "settled";
      return result;
    } finally {
      // Cleanup always happens — a failed release, a dead worker, an unknown
      // method — so no path can be leased for ever. The outcome is what decides
      // whether a waiting route may run, and only `settled` does.
      this.releasing.delete(path);
      gate.settle(outcome);
    }
  }
}

function routeRefusal(): ProtocolError {
  return new ProtocolError(ErrorCodes.SessionBusy, ROUTE_GATE_REFUSAL);
}
