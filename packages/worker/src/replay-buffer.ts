import type { SessionUpdateParams } from "@lasercode/protocol";

/**
 * One worker's whole replay allowance (RP-4).
 *
 * The per-session bounds below are what a single conversation may keep. This is
 * what the *process* may keep across all of them: without it, fifty open
 * sessions each entitled to a 16 MiB suffix are a 800 MiB entitlement nobody
 * ever asked for.
 *
 * The ceiling is hard. When it is reached the oldest replayable updates are
 * dropped — from the least recently active session first, the session that is
 * pushing right now last — and each buffer's floor rises with them, which is
 * exactly the signal `session/load` already turns into "resync": the client is
 * told the earliest seq that can still be replayed and re-reads the transcript
 * when that is later than what it holds. Nothing canonical is involved: replay
 * is a convenience over the session record, and dropping a suffix never drops
 * an entry, a question or a terminal event.
 *
 * Streaming is a tie-break, never an exemption. If every session is streaming
 * the budget still holds: suffixes are dropped, floors advance, and those
 * clients resync. The alternative — exceeding the budget while pressure lasts —
 * is the unbounded growth this exists to stop.
 */
export class ReplayBudget {
  private readonly buffers = new Set<ReplayBuffer>();
  private retained = 0;
  private droppedUpdates = 0;
  private floorAdvancesCount = 0;

  constructor(readonly limitBytes: number) {}

  /** Bytes retained across every registered buffer right now. */
  get bytes(): number {
    return this.retained;
  }

  /** Updates dropped to keep the ceiling, over this process's life. */
  get evictions(): number {
    return this.droppedUpdates;
  }

  /** How many times a buffer's floor moved because of the global ceiling. */
  get floorAdvances(): number {
    return this.floorAdvancesCount;
  }

  register(buffer: ReplayBuffer): void {
    this.buffers.add(buffer);
    this.retained += buffer.bytes;
  }

  /** A session let go of its buffer: its bytes are no longer this worker's. */
  release(buffer: ReplayBuffer): void {
    if (!this.buffers.delete(buffer)) return;
    this.retained -= buffer.bytes;
    if (this.retained < 0) this.retained = 0;
  }

  /** Called by a buffer whenever its own retained bytes change. */
  note(delta: number): void {
    this.retained += delta;
    if (this.retained < 0) this.retained = 0;
  }

  /**
   * Bring the process back inside the ceiling after `origin` pushed.
   *
   * Victims are ordered by last activity, oldest first, and `origin` is always
   * last: a conversation somebody is watching keeps its suffix while a dormant
   * one still has bytes to give. When only `origin` is left it gives too, down
   * to nothing, so a single very large update cannot hold the budget open.
   */
  /**
   * Give bytes back until this worker is under `targetBytes` (RP-8).
   *
   * The same eviction the ceiling already performs, asked for early: the least
   * recently active session goes first, each drop advances that buffer's floor
   * — which `session/load` already turns into a resync — and the retained
   * total is kept exact by the buffers themselves. There is no origin to spare
   * here: nothing is pushing, this is a pass deciding to hold less.
   *
   * Bounded by `maxDrops`, so one pass can never walk an unbounded number of
   * updates. Reaching the bound is reported by the caller as work left over,
   * never as a failure.
   */
  trimTo(targetBytes: number, options: { maxDrops?: number } = {}): { dropped: number; bytes: number; boundReached: boolean } {
    const maxDrops = Math.max(0, Math.floor(options.maxDrops ?? 512));
    const target = Math.max(0, Math.floor(targetBytes));
    const before = this.retained;
    if (maxDrops === 0) return { dropped: 0, bytes: 0, boundReached: this.retained > target };
    let dropped = 0;
    const victims = [...this.buffers].sort((a, b) => a.lastActivity - b.lastActivity);
    for (const victim of victims) {
      while (this.retained > target && victim.size > 0 && dropped < maxDrops) {
        if (victim.dropOldest() === undefined) break;
        this.droppedUpdates += 1;
        this.floorAdvancesCount += 1;
        dropped += 1;
      }
      if (this.retained <= target || dropped >= maxDrops) break;
    }
    return { dropped, bytes: Math.max(0, before - this.retained), boundReached: dropped >= maxDrops && this.retained > target };
  }

  enforce(origin: ReplayBuffer): void {
    if (this.retained <= this.limitBytes) return;
    const victims = [...this.buffers].sort((a, b) => {
      if (a === origin) return 1;
      if (b === origin) return -1;
      return a.lastActivity - b.lastActivity;
    });
    for (const victim of victims) {
      while (this.retained > this.limitBytes && victim.size > 0) {
        const dropped = victim.dropOldest();
        if (dropped === undefined) break;
        this.droppedUpdates += 1;
        this.floorAdvancesCount += 1;
      }
      if (this.retained <= this.limitBytes) return;
    }
  }
}

/** A FIFO with O(1) front removal and both count and serialized-byte admission.
 * Dropping an oversized update clears its predecessors: replay must always be
 * a contiguous suffix. The live driver and pending questions are not owned here.
 *
 * The buffer also remembers its **floor**: the highest seq it no longer has, so
 * `session/load` can tell a client the earliest seq it can actually replay
 * instead of implying it missed nothing (see `WorkerServer.replayFloor`).
 */
export class ReplayBuffer implements Iterable<SessionUpdateParams> {
  private readonly entries = new Map<number, { value: SessionUpdateParams; bytes: number }>();
  private retainedBytes = 0;
  private floorSeq = 0;
  private lastActivityAt = 0;

  constructor(
    private readonly limit: number,
    private readonly byteLimit: number,
    private readonly budget?: ReplayBudget,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastActivityAt = this.now();
    budget?.register(this);
  }

  get first(): SessionUpdateParams | undefined { return this.entries.values().next().value?.value; }
  get bytes(): number { return this.retainedBytes; }
  get size(): number { return this.entries.size; }
  /** The highest seq that is no longer replayable from here. 0 when nothing was dropped. */
  get floor(): number { return this.floorSeq; }
  /** When this session last produced an update; the global ceiling evicts oldest first. */
  get lastActivity(): number { return this.lastActivityAt; }

  push(value: SessionUpdateParams): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    this.entries.set(value.seq, { value, bytes });
    this.retainedBytes += bytes;
    this.budget?.note(bytes);
    this.lastActivityAt = this.now();
    while (this.entries.size > this.limit || this.retainedBytes > this.byteLimit) {
      if (this.dropOldest() === undefined) break;
    }
    // The per-session bounds are satisfied; the process-wide one may not be.
    this.budget?.enforce(this);
  }

  /** Drop the oldest retained update and raise the floor to its seq. */
  dropOldest(): number | undefined {
    const first = this.entries.entries().next().value;
    if (!first) return undefined;
    const [seq, entry] = first;
    this.entries.delete(seq);
    this.retainedBytes -= entry.bytes;
    if (this.retainedBytes < 0) this.retainedBytes = 0;
    this.budget?.note(-entry.bytes);
    if (seq > this.floorSeq) this.floorSeq = seq;
    return seq;
  }

  /** The session let go: its bytes leave this worker's allowance. */
  dispose(): void {
    this.budget?.release(this);
    this.entries.clear();
    this.retainedBytes = 0;
  }

  *[Symbol.iterator](): Iterator<SessionUpdateParams> {
    for (const { value } of this.entries.values()) yield value;
  }
}
