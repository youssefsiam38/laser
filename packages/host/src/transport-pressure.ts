/**
 * What one connection is allowed to cost this host (RP-7).
 *
 * A client that stops reading — a phone in a tunnel, a renderer that is
 * paused, a browser tab on a throttled timer — does not stop the host
 * producing. Without a bound the queue behind that socket is the host's heap,
 * and the only thing that ends it is the socket closing, eventually, maybe.
 *
 * So every byte we hand a socket is counted from the moment we enqueue it
 * until its send callback settles, and the connection moves through three
 * states:
 *
 * - **flowing** — everything goes out.
 * - **shedding** (past the soft mark) — the three notifications a client can
 *   read back explicitly are dropped and counted; everything else still goes.
 * - **fenced** (past the hard mark, or stuck above the soft mark) — nothing
 *   more is written and the connection is closed. Nothing is queued for it:
 *   the peer reconnects and re-reads authoritatively, which is the one resume
 *   path this product has (`docs/security.md` §7).
 *
 * State, attention, questions, tasks, runs and terminal frames are therefore
 * never silently dropped — a peer either receives them or is disconnected and
 * asks again. And nothing here touches work: no command is cancelled, paused
 * or throttled because a socket is slow.
 */
import {
  CLIENT_QUEUE_HARD_BYTES,
  CLIENT_QUEUE_SOFT_BYTES,
  CLIENT_STUCK_MS,
  SHED_COUNTER_METHODS_MAX,
  isSheddable,
  type ShedCounters,
} from "@lasercode/protocol";

export type PressureState = "flowing" | "shedding" | "fenced";

export interface OutboundPressureOptions {
  softBytes?: number;
  hardBytes?: number;
  stuckMs?: number;
  now?: () => number;
  /** The connection crossed the hard mark or sat above the soft one. */
  onFence?: (info: { reason: "hard-limit" | "stuck"; queuedBytes: number }) => void;
  /** A diagnostic notification was released. Numbers and method names only. */
  onShed?: (info: { method: string; total: number }) => void;
}

export interface PressureSnapshot {
  state: PressureState;
  queuedBytes: number;
  highWaterBytes: number;
  inFlight: number;
  shed: ShedCounters;
}

/** One connection's byte account and the state machine over it. */
export class OutboundPressure {
  private queued = 0;
  private inFlight = 0;
  private highWater = 0;
  private state: PressureState = "flowing";
  private softSince: number | undefined;
  private readonly shedTotals: ShedCounters = { total: 0, byMethod: {} };
  private readonly soft: number;
  private readonly hard: number;
  private readonly stuckMs: number;
  private readonly now: () => number;

  constructor(private readonly options: OutboundPressureOptions = {}) {
    this.soft = options.softBytes ?? CLIENT_QUEUE_SOFT_BYTES;
    this.hard = options.hardBytes ?? CLIENT_QUEUE_HARD_BYTES;
    this.stuckMs = options.stuckMs ?? CLIENT_STUCK_MS;
    this.now = options.now ?? Date.now;
  }

  get fenced(): boolean {
    return this.state === "fenced";
  }

  snapshot(): PressureSnapshot {
    return {
      state: this.state,
      queuedBytes: this.queued,
      highWaterBytes: this.highWater,
      inFlight: this.inFlight,
      shed: { total: this.shedTotals.total, byMethod: { ...this.shedTotals.byMethod } },
    };
  }

  /**
   * May this go out now?
   *
   * `method` is a notification's method; a response has none and is never
   * sheddable — somebody asked for it and is waiting.
   */
  admit(method?: string): "send" | "shed" | "fenced" {
    if (this.state === "fenced") return "fenced";
    if (this.state === "shedding" && method !== undefined && isSheddable(method)) {
      this.countShed(method);
      return "shed";
    }
    return "send";
  }

  /** Bytes handed to the socket. Counted once, here, until `settle`. */
  charge(bytes: number): void {
    this.queued += bytes;
    this.inFlight += 1;
    if (this.queued > this.highWater) this.highWater = this.queued;
    this.evaluate();
  }

  /** The socket took them (or failed to); the account is square either way. */
  settle(bytes: number): void {
    this.queued = Math.max(0, this.queued - bytes);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.evaluate();
  }

  /** The connection is gone; nothing is owed and nothing is retained. */
  reset(): void {
    this.queued = 0;
    this.inFlight = 0;
    this.softSince = undefined;
  }

  private countShed(method: string): void {
    this.shedTotals.total += 1;
    const known = Object.prototype.hasOwnProperty.call(this.shedTotals.byMethod, method);
    // Bounded on purpose: the method set is small and named, and a counter map
    // is not a place to accumulate whatever a peer can make us send.
    if (known || Object.keys(this.shedTotals.byMethod).length < SHED_COUNTER_METHODS_MAX) {
      this.shedTotals.byMethod[method] = (this.shedTotals.byMethod[method] ?? 0) + 1;
    }
    this.options.onShed?.({ method, total: this.shedTotals.total });
  }

  private evaluate(): void {
    if (this.state === "fenced") return;
    if (this.queued > this.hard) {
      this.fence("hard-limit");
      return;
    }
    if (this.queued > this.soft) {
      this.softSince ??= this.now();
      // Hysteresis, like the relay's own: a burst that drains is not a peer
      // that has stopped reading.
      if (this.now() - this.softSince > this.stuckMs) {
        this.fence("stuck");
        return;
      }
      this.state = "shedding";
      return;
    }
    if (this.queued <= this.soft / 2) {
      this.softSince = undefined;
      this.state = "flowing";
    }
  }

  private fence(reason: "hard-limit" | "stuck"): void {
    this.state = "fenced";
    const queuedBytes = this.queued;
    this.softSince = undefined;
    this.options.onFence?.({ reason, queuedBytes });
  }
}

/**
 * What a fenced peer is told, in a sentence a person could read in a log. It
 * carries no path, no method and no content: this is about bytes, not about
 * what was in them.
 */
export function fenceReasonText(reason: "hard-limit" | "stuck"): string {
  return reason === "hard-limit"
    ? "this connection fell too far behind to keep queueing for it; reconnecting reloads what it missed"
    : "this connection stopped reading; reconnecting reloads what it missed";
}
