/**
 * Keystroke-timing defence (M6-T6), after OpenSSH 9.5's ObscureKeystrokeTiming.
 *
 * Both halves matter and shipping only one is close to worthless:
 *
 *   1. A fixed 20 ms send grid. Real frames leave on tick boundaries, so the
 *      inter-frame gaps an observer measures are quantised and stop encoding
 *      the digraph timings that make typed text recoverable.
 *   2. A random-length chaff tail. Without it, the *last* frame of a burst still
 *      marks where typing stopped, and the burst length still leaks the number
 *      of keystrokes. Chaff frames are ordinary encrypted frames of the same
 *      padded size; only the peer can tell them apart, and it drops them.
 *
 * The grid runs only while there is something to send plus the tail, exactly as
 * OpenSSH does: an idle session sends nothing and costs nothing.
 */

export interface KeystrokeShaperOptions {
  /** Grid period. OpenSSH uses 20 ms; matching it means matching its analysis. */
  gridMs?: number;
  /** Chaff tail length, in ticks, drawn uniformly for each burst. */
  minChaffTicks?: number;
  maxChaffTicks?: number;
  /**
   * Put one frame on the wire. Called at most once per tick, strictly in order,
   * and never re-entered. `null` means "emit a chaff frame now": the shaper
   * deliberately does not build frames itself, so encryption — and therefore
   * sequence-number assignment — happens here, in send order.
   */
  sendFrame(frame: Uint8Array | null): void | Promise<void>;
  /** Drop frames rather than grow without bound if the peer stalls. */
  maxQueue?: number;
  onError?(error: unknown): void;
  /** Test seams. */
  random?(): number;
  setTimer?(handler: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const KEYSTROKE_GRID_MS = 20;
export const DEFAULT_MIN_CHAFF_TICKS = 8;
export const DEFAULT_MAX_CHAFF_TICKS = 64;
const DEFAULT_MAX_QUEUE = 4096;

export class KeystrokeShaper {
  private readonly gridMs: number;
  private readonly minChaffTicks: number;
  private readonly maxChaffTicks: number;
  private readonly maxQueue: number;
  private readonly random: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private queue: Uint8Array[] = [];
  private timer: unknown = null;
  private chaffTicksLeft = 0;
  private ticking = false;
  private stopped = false;
  private droppedFrames = 0;

  constructor(private readonly options: KeystrokeShaperOptions) {
    this.gridMs = options.gridMs ?? KEYSTROKE_GRID_MS;
    this.minChaffTicks = options.minChaffTicks ?? DEFAULT_MIN_CHAFF_TICKS;
    this.maxChaffTicks = options.maxChaffTicks ?? DEFAULT_MAX_CHAFF_TICKS;
    if (this.maxChaffTicks < this.minChaffTicks) {
      throw new RangeError("maxChaffTicks must be at least minChaffTicks");
    }
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.random = options.random ?? Math.random;
    this.setTimer =
      options.setTimer ?? ((handler, ms) => setInterval(handler, ms) as unknown);
    this.clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get pending(): number {
    return this.queue.length;
  }

  /** True while the grid is running (real frames queued, or inside the chaff tail). */
  get active(): boolean {
    return this.timer !== null;
  }

  /** Frames dropped because the queue hit `maxQueue`. Surface this; do not hide it. */
  get dropped(): number {
    return this.droppedFrames;
  }

  enqueue(frame: Uint8Array): void {
    if (this.stopped) throw new Error("this shaper has been stopped");
    if (this.queue.length >= this.maxQueue) {
      this.droppedFrames++;
      this.options.onError?.(
        new Error(`keystroke shaper queue is full (${this.maxQueue} frames); dropped one. The peer is not draining.`),
      );
      return;
    }
    this.queue.push(frame);
    this.armTail();
    this.start();
  }

  /** Stop the grid and forget anything queued. Call on disconnect. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.chaffTicksLeft = 0;
    this.halt();
  }

  private start(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = this.setTimer(() => this.tick(), this.gridMs);
  }

  private halt(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private armTail(): void {
    const span = this.maxChaffTicks - this.minChaffTicks + 1;
    this.chaffTicksLeft = this.minChaffTicks + Math.floor(this.random() * span);
  }

  private tick(): void {
    // Never overlap ticks: a slow WebCrypto call must not reorder sequence numbers.
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    void this.sendOne()
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.ticking = false;
      });
  }

  private async sendOne(): Promise<void> {
    const next = this.queue.shift();
    if (next) {
      await this.options.sendFrame(next);
      return;
    }
    if (this.chaffTicksLeft > 0) {
      this.chaffTicksLeft--;
      await this.options.sendFrame(null);
      return;
    }
    this.halt();
  }
}
