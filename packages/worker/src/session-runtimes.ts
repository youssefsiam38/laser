/**
 * The runtimes one worker holds, and the fences around them (RP-4).
 *
 * `WorkerServer` used to keep this as four maps and a handful of ad-hoc checks
 * spread through dispatch. The races that review found — a request accepted
 * between a safety answer and a stop, a fork leaving a path behind — were the
 * shape of that scattering, so the table and every transition over it live in
 * one place here:
 *
 * - **load fence** (`withLoad`) — one open per session file, ever
 *   (AGENTS.md invariant 8).
 * - **release fence** (`withRelease`) — a session being released is closed to
 *   new work from the instant the release begins, so nothing can start between
 *   the final safety recheck and the runtime going away.
 * - **retire fence** (`fence`) — the same idea for the whole worker: admission
 *   closes synchronously, accepted work drains, and anything that arrives in
 *   that window is the reason retirement is refused rather than something to
 *   queue.
 *
 * Nothing here is retained on behalf of a caller: there is no queue of raw
 * messages, because a queue is memory a peer controls (RP-7). A request that
 * arrives while a fence is closed is refused with a reason, and the refusal is
 * what makes the fence fail closed.
 */
import { ErrorCodes, LIFETIME_RETRY, ProtocolError } from "@lasercode/protocol";

/** Why a fence refused a request. Both are retryable the moment it reopens. */
export type FenceRefusal = "releasing" | "retiring";

/**
 * A fence refusal, marked retryable.
 *
 * Both fences refuse rather than queue — a queue is memory a peer controls
 * (RP-7) — and both refuse *before* any work runs, so the request was never
 * acted on. `data.retry` says so, and the host retries it once: for a release
 * the arrival is also what makes that release refuse, so the retry lands on
 * the same live runtime; for a retirement the retry opens a fresh worker.
 */
export function fenceRefusal(kind: FenceRefusal): ProtocolError {
  return kind === "releasing"
    ? new ProtocolError(
        ErrorCodes.SessionBusy,
        "This conversation was being put to sleep; it is awake again. Send that once more.",
        { retry: LIFETIME_RETRY },
      )
    : new ProtocolError(ErrorCodes.DriverUnavailable, "This project's worker is shutting down; it will start again on the next request.", {
        retry: LIFETIME_RETRY,
      });
}

export interface RuntimeTableOptions {
  /** Longest an accepted handler may take to settle before a drain gives up. */
  drainTimeoutMs?: number;
  now?: () => number;
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * One worker's live sessions, keyed by session file path, plus the three
 * fences. `Live` is the server's own record type; this table is deliberately
 * generic over it so it owns transitions, not session semantics.
 */
export class SessionRuntimes<Live extends { path: string }> {
  private readonly table = new Map<string, Live>();
  /** Opens in flight, keyed by path: a second load joins the first. */
  private readonly opens = new Map<string, Promise<Live>>();
  /** Releases in flight, keyed by path: the session is closed to new work. */
  private readonly releases = new Map<string, { gate: Promise<void>; arrived: number }>();
  /** Dispatches being served right now, by path (`""` for pathless requests). */
  private readonly inFlight = new Map<string, number>();
  private outstanding = 0;
  private drained: Array<() => void> = [];
  /** Set the instant a retirement begins; never reopened once acknowledged. */
  private retireFence: { arrived: number; acknowledged: boolean } | undefined;
  private readonly drainTimeoutMs: number;

  constructor(options: RuntimeTableOptions = {}) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  }

  // --------------------------------------------------------------- the table

  get(path: string): Live | undefined {
    return this.table.get(path);
  }

  has(path: string): boolean {
    return this.table.has(path);
  }

  get size(): number {
    return this.table.size;
  }

  paths(): string[] {
    return [...this.table.keys()];
  }

  values(): IterableIterator<Live> {
    return this.table.values();
  }

  attach(live: Live): void {
    this.table.set(live.path, live);
  }

  drop(path: string): Live | undefined {
    const live = this.table.get(path);
    this.table.delete(path);
    return live;
  }

  clear(): void {
    this.table.clear();
  }

  /** A fork moved a session's file: the runtime keeps its identity, not its key. */
  rekey(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const live = this.table.get(oldPath);
    if (!live) return;
    this.table.delete(oldPath);
    this.table.set(newPath, live);
    const held = this.inFlight.get(oldPath);
    if (held !== undefined) {
      this.inFlight.delete(oldPath);
      this.inFlight.set(newPath, (this.inFlight.get(newPath) ?? 0) + held);
    }
  }

  // --------------------------------------------------------------- admission

  /**
   * Admit one dispatch, or refuse it because a fence is closed.
   *
   * Returns the function that releases it again. A refusal is thrown, never
   * queued: the caller sees a sentence, and the fence that refused counts the
   * arrival so a retirement in progress knows it was not alone.
   */
  admit(path: string | undefined, options: { privileged?: boolean } = {}): () => void {
    if (this.retireFence && !options.privileged) {
      this.retireFence.arrived += 1;
      throw fenceRefusal("retiring");
    }
    const releasing = path !== undefined ? this.releases.get(path) : undefined;
    if (releasing && !options.privileged) {
      // Counted, because somebody wanting this conversation is the reason the
      // release will refuse itself and leave the runtime where it is.
      releasing.arrived += 1;
      throw fenceRefusal("releasing");
    }
    // The lifetime verbs are the fences themselves: counting them would make a
    // drain wait for the handler that is doing the waiting.
    if (options.privileged) return () => {};
    const key = path ?? "";
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    this.outstanding += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left > 0) this.inFlight.set(key, left);
      else this.inFlight.delete(key);
      this.outstanding -= 1;
      if (this.outstanding <= 0) {
        this.outstanding = 0;
        for (const resolve of this.drained.splice(0)) resolve();
      }
    };
  }

  /** Dispatches naming this session right now. */
  inFlightFor(path: string): number {
    return this.inFlight.get(path) ?? 0;
  }

  /** True while this exact session is being opened or released. */
  transitioning(path: string): boolean {
    return this.opens.has(path) || this.releases.has(path);
  }

  /** Requests refused because this session was being released. */
  arrivedDuringRelease(path: string): number {
    return this.releases.get(path)?.arrived ?? 0;
  }

  openPaths(): string[] {
    return [...this.opens.keys()];
  }

  releasingPaths(): string[] {
    return [...this.releases.keys()];
  }

  // ------------------------------------------------------------------ fences

  /** The open in flight for this path, if any: a second load joins it. */
  opening(path: string): Promise<Live> | undefined {
    return this.opens.get(path);
  }

  /** Run one open under the load fence, so one file never gets two runtimes. */
  async withLoad(path: string, work: () => Promise<Live>): Promise<Live> {
    const existing = this.opens.get(path);
    if (existing) return existing;
    const open = work();
    this.opens.set(path, open);
    try {
      return await open;
    } finally {
      this.opens.delete(path);
    }
  }

  /** Wait for a release of this path to finish, if one is running. */
  async settled(path: string): Promise<void> {
    const release = this.releases.get(path);
    if (release) await release.gate.catch(() => {});
  }

  /**
   * Run one release under the path's own fence.
   *
   * From the moment this is called, a request naming the session is refused
   * (`admit` above) rather than started, so nothing can begin between the final
   * safety recheck inside `work` and the runtime going away. A release that
   * refuses reopens the path by returning; the caller's own answer says why.
   */
  async withRelease<T>(path: string, work: () => Promise<T>): Promise<T> {
    const running = this.releases.get(path);
    if (running) {
      running.arrived += 1;
      await running.gate.catch(() => {});
      throw fenceRefusal("releasing");
    }
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    this.releases.set(path, { gate, arrived: 0 });
    try {
      return await work();
    } finally {
      this.releases.delete(path);
      settle();
    }
  }

  // ---------------------------------------------------------- retire fence

  get fenced(): boolean {
    return this.retireFence !== undefined;
  }

  get retiring(): boolean {
    return this.retireFence?.acknowledged === true;
  }

  /** Close admission synchronously. Returns false when one is already open. */
  fence(): boolean {
    if (this.retireFence) return false;
    this.retireFence = { arrived: 0, acknowledged: false };
    return true;
  }

  /** How many requests were refused because of this fence. */
  arrivedDuringFence(): number {
    return this.retireFence?.arrived ?? 0;
  }

  /** Reopen admission: the retirement was refused. */
  unfence(): void {
    if (this.retireFence?.acknowledged) return;
    this.retireFence = undefined;
  }

  /** The worker is going: admission never reopens. */
  acknowledgeRetirement(): void {
    if (!this.retireFence) this.retireFence = { arrived: 0, acknowledged: true };
    else this.retireFence.acknowledged = true;
  }

  /**
   * Wait for every already-accepted dispatch to settle.
   *
   * `true` means the worker is quiet; `false` means the bound passed with work
   * still running, which every caller treats as "not safe", never as "done".
   */
  async drain(timeoutMs = this.drainTimeoutMs): Promise<boolean> {
    if (this.outstanding <= 0) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.drained = this.drained.filter((entry) => entry !== done);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.drained.push(done);
    });
  }
}
