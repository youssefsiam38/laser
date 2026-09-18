/**
 * Images, rebuilt outside the JavaScript heap and bounded (RP-5b §7.3, D-295).
 *
 * A prompt's image is never kept as base64 in a view: its bytes are read back
 * through the range contract into a `Blob`, which the browser keeps out of the
 * JavaScript heap. This pool is what bounds that: how many images, how many
 * encoded bytes, how much decoded surface — counting the reads in flight, not
 * only the ones that finished.
 *
 * What it does **not** do is refuse a picture for good. The budgets bound what
 * is decoded *at once*, never what a person can reach: an image the pool has
 * no room for is queued, not failed, and one that is on screen takes its room
 * from the least recently visible picture nobody is looking at. A picture that
 * loses its decode says it will come back, and opening one always reads its
 * bytes from the conversation's own authority, whatever the pool is holding
 * (M16-T82).
 *
 * Because it keeps decoded pictures for rows nobody is looking at, the pool is
 * a releasable cache: {@link ImageBlobs.releaseIdle} gives that residue back,
 * and the window registers it with the renderer's pressure controller
 * (RP-8 step 1, `runtime/pressure/ephemeral.ts`).
 */
import { imageDimensions, UNKNOWN_IMAGE_DECODED_BYTES } from "./view-measure.js";
import type { BodyRef } from "./body-excerpt.js";
import { BODY_SLICE_BYTES, BodyReplyRefused, BodyRevisionFence, checkRangeReply, type RangeRequest, type RevisionRequest } from "./body-reader.js";
import { IMAGE_PRIORITY, ImageWorkQueue, isActive, type ImagePriority, type Prioritised } from "./image-queue.js";
import { Sha256Stream } from "./sha256.js";

export { IMAGE_PRIORITY, type ImagePriority } from "./image-queue.js";

/**
 * Images this window keeps decoded for rows that are **not** on screen: the
 * speculative residue of scrolling, bounded so a long conversation does not
 * quietly accumulate bitmaps.
 */
export const IMAGE_BLOB_MAX = 24;
/**
 * Images decoded at once while rows are actually showing them. A person
 * looking at a twenty-five-image prompt sees twenty-five pictures: active
 * conversation content outranks an ordinary cache share (D-295), and what
 * bounds it is memory — the byte and surface budgets below — with this as the
 * hard stop on the number of live object URLs.
 */
export const IMAGE_BLOB_ACTIVE_MAX = 256;
/** Decoded bytes this window may hold across every image at once. */
export const IMAGE_BLOB_MAX_BYTES = 128 * 1024 * 1024;
/** Decoded bytes in hand while one image is being read. */
export const IMAGE_INFLIGHT_MAX_BYTES = 256 * 1024;
/** A single image larger than this is not rebuilt in this window. */
export const IMAGE_MAX_ENCODED_BYTES = 48 * 1024 * 1024;
/**
 * Decoded surface this window admits at once, across every image it is
 * showing. The unchanged twelve-image fixture is 12 × 2048² × 4 = 192 MiB of
 * surface, so the budget admits it and queues the next conversation's worth
 * rather than letting decoded memory grow without a number.
 */
export const IMAGE_SURFACE_MAX_BYTES = 256 * 1024 * 1024;
/**
 * Reads in flight at once. The queue decides which images those are, so a
 * conversation full of pictures spends its bandwidth on what is on screen
 * instead of starting forty reads and sorting it out afterwards.
 */
export const IMAGE_READS_MAX = 4;

/** Why an image is not showing, when the reason is the image itself. */
export type ImageFailure =
  /** Past what one window may rebuild at all. */
  | "too-large"
  /** What came back was not this image. */
  | "corrupt"
  /** The conversation moved under the read, or its identity changed. */
  | "moved"
  /** The authority could not be asked just now. */
  | "unavailable";

/** Why an image is not decoded, when the reason is this window's capacity. */
export type ImageWait =
  /** Nothing is showing it; it comes back when it does. */
  | "offscreen"
  /** Wanted, but this window has no room for it yet. */
  | "room"
  /** The pool it belonged to is gone (a cleared cache, another environment). */
  | "retired";

export type ImageState =
  | { state: "ready"; url: string }
  | { state: "loading" }
  | { state: "waiting"; reason: ImageWait }
  | { state: "failed"; reason: ImageFailure };

/** The picture itself, for a viewer: the pool's own blob, given back on close. */
export interface ImagePicture {
  url: string;
  blob: Blob;
  bytes: number;
  release: () => void;
}

interface Decoded { url: string; blob: Blob; bytes: number; surface: number }
interface Claim { images: number; bytes: number; surface: number }

interface Tracked extends Prioritised {
  key: string;
  path: string;
  ref: BodyRef & { entryId: string };
  mimeType: string;
  /** Rows and viewers that asked for it and have not given it back. */
  holds: number;
  /** Viewers showing the blob itself: never evicted under them. */
  pins: number;
  /**
   * Where the row says this picture is. The rank the queue sorts on is
   * derived from it and from {@link Tracked.pins}, never stored a second time:
   * a picture is `requested` exactly while a viewer is holding it, and rejoins
   * the ordinary order the moment that viewer closes.
   */
  placed: ImagePriority;
  decoded?: Decoded | undefined;
  reading: boolean;
  /** The viewer read in flight, so a second click joins it instead of doubling it. */
  opening?: Promise<ReadOutcome> | undefined;
  wait?: ImageWait | undefined;
  failure?: ImageFailure | undefined;
  waiters: Array<(state: ImageState) => void>;
}

type ReadOutcome =
  | { ok: true; url: string; blob: Blob; bytes: number; surface: number }
  | { ok: false; reason: ImageFailure | "room" | "retired" };

/** What an image will cost, from the reference alone, before a byte is read. */
function claimOf(ref: BodyRef & { entryId: string }): Claim {
  const declared = ref.image?.decodedBytes;
  const surface = typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? Math.floor(declared)
    : UNKNOWN_IMAGE_DECODED_BYTES;
  return { images: 1, bytes: ref.totalBytes, surface };
}

/** Past what one window may ever rebuild — not a capacity question. */
function oversized(ref: BodyRef & { entryId: string }, claim: Claim): boolean {
  return claim.surface > IMAGE_SURFACE_MAX_BYTES || ref.totalBytes > IMAGE_MAX_ENCODED_BYTES;
}

/**
 * A hold is given back exactly once, whoever calls and however often.
 *
 * A second call is not a no-op without this: a hold belongs to a row or a
 * viewer, and giving one back twice consumes another holder's and can revoke a
 * URL a visible tile is still showing. React updaters and cleanup paths both
 * run more than once, so the guard lives here rather than in every caller.
 */
function once(release: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

export class ImageBlobs {
  private readonly queue = new ImageWorkQueue<Tracked>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private decodedCount = 0;
  private bytes = 0;
  private surface = 0;
  private generation = 0;
  private running = 0;
  /** Monotonic "last seen on screen" clock; no wall time is involved. */
  private clock = 0;
  private pumping = false;
  private again = false;
  private scheduled = false;
  /**
   * What reads still in flight have already claimed. Admission counts these
   * too: without them, any number of rows could each start building a large
   * blob and only be refused afterwards, which is the memory this budget
   * exists to prevent.
   */
  private reserved = { images: 0, bytes: 0, surface: 0 };
  /** The reservations still owned by reads of the current generation. */
  private live = new Set<Claim>();
  /**
   * Reads waiting for one of the {@link IMAGE_READS_MAX} slots. Only a
   * person's own open ever waits here — queued rows wait in the queue — and a
   * finishing read hands its slot straight over, so the bound is exact.
   */
  private readonly slots: Array<() => void> = [];

  constructor(private readonly request: RangeRequest, private readonly environmentKey = "", private readonly revisionOf?: RevisionRequest) {}

  /** What this window is holding: images, their bytes, their decoded surface. */
  get held(): { images: number; bytes: number; surface: number } {
    return { images: this.decodedCount, bytes: this.bytes, surface: this.surface };
  }

  /** What it is holding **and** what reads in flight have claimed. */
  get committed(): { images: number; bytes: number; surface: number } {
    return {
      images: this.decodedCount + this.reserved.images,
      bytes: this.bytes + this.reserved.bytes,
      surface: this.surface + this.reserved.surface,
    };
  }

  url(key: string): string | undefined {
    return this.queue.get(key)?.decoded?.url;
  }

  /**
   * Give back every picture nobody is looking at (RP-8 step 1).
   *
   * This is the pool's whole idle residue: decoded pictures kept for rows that
   * are off screen, which cost nothing to lose but a re-read when they scroll
   * back. Nothing a row is showing and nothing a viewer is holding is touched,
   * and no read is started to replace them — each one goes back to saying it
   * will come when it is on screen.
   *
   * `bytes` is the decoded surface given back: what a picture actually costs a
   * window. The encoded blob it drops with it is smaller by two orders of
   * magnitude and is reported by {@link ImageBlobs.held}.
   */
  releaseIdle(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const victim of this.queue.stalest(item => item.decoded !== undefined && item.pins === 0 && !isActive(item))) {
      bytes += victim.decoded?.surface ?? 0;
      count += 1;
      this.evict(victim);
    }
    return { count, bytes };
  }

  /** What one image is doing right now, in the words the row needs. */
  stateOf(key: string): ImageState {
    const tracked = this.queue.get(key);
    if (!tracked) return { state: "loading" };
    if (tracked.decoded) return { state: "ready", url: tracked.decoded.url };
    if (tracked.failure) return { state: "failed", reason: tracked.failure };
    if (tracked.wait && !tracked.reading) return { state: "waiting", reason: tracked.wait };
    return { state: "loading" };
  }

  /** Tell a row when its image changes: decoded, queued, given up, failed. */
  watch(key: string, listener: () => void): () => void {
    const listeners = this.watchers.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.watchers.set(key, listeners);
    return () => {
      const current = this.watchers.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.watchers.delete(key);
    };
  }

  /**
   * Ask for one image. Every ask is a hold, whether it starts a read, joins
   * one, or finds the picture already here; the caller gives it back exactly
   * once with {@link release}.
   *
   * The promise says what happened *for now*: `ready`, `waiting` when this
   * window has no room yet, or `failed` when the image itself is the problem.
   * Waiting is never the end of it — the row is watched, and the queue comes
   * back to it as capacity or visibility changes.
   */
  load(key: string, path: string, ref: BodyRef & { entryId: string }, mimeType: string, priority: ImagePriority = IMAGE_PRIORITY.visible): Promise<ImageState> {
    const tracked = this.remember(key, path, ref, mimeType, priority);
    tracked.holds += 1;
    if (tracked.decoded) return Promise.resolve({ state: "ready", url: tracked.decoded.url });
    if (tracked.failure) return Promise.resolve({ state: "failed", reason: tracked.failure });
    if (oversized(ref, claimOf(ref))) {
      tracked.failure = "too-large";
      this.announce(key);
      return Promise.resolve({ state: "failed", reason: "too-large" });
    }
    const outcome = new Promise<ImageState>(resolve => tracked.waiters.push(resolve));
    this.pump();
    return outcome;
  }

  /** Say where an image is now: on screen, near it, or neither. */
  prioritize(key: string, priority: ImagePriority): void {
    const tracked = this.queue.get(key);
    if (!tracked) return;
    const before = tracked.priority;
    this.rank(tracked, priority);
    if (tracked.priority === before) return;
    // Trimming happens once for the whole batch, inside the pump: a row that
    // moves twenty pictures at once is one pass, not twenty.
    this.pump();
  }

  /**
   * Open one image because the person asked for it (M16-T82).
   *
   * A picture this window is holding is handed over as it is — nothing copied,
   * nothing charged twice. One it is not, because the pool had no room or gave
   * its decode up off screen, is read back from the conversation's own
   * authority through the same fence and the same whole-image digest, inside
   * the same budgets and the same four read slots as every other read, and
   * published into the pool so the row showing it gets the same picture.
   *
   * The person's own picture outranks a thumbnail: a read for a viewer may
   * take room from a picture on screen (never from one another viewer holds),
   * which says it will come back and does, as soon as the viewer closes. Only
   * the image itself being unreadable is a failure.
   */
  async open(key: string, path: string, ref: BodyRef & { entryId: string }, mimeType: string): Promise<ImagePicture | { failed: ImageFailure }> {
    const tracked = this.remember(key, path, ref, mimeType);
    if (tracked.failure) return { failed: tracked.failure };
    if (oversized(ref, claimOf(ref))) {
      tracked.failure = "too-large";
      this.announce(key);
      return { failed: "too-large" };
    }
    // The viewer's hold and pin are taken before anything is read: a row that
    // goes while the person is opening cannot revoke the picture under the
    // viewer, and a pinned picture ranks `requested` while it is open.
    this.pin(tracked);
    if (tracked.decoded) return this.handle(tracked);
    const generation = this.generation;
    const settled = (): ImagePicture | { failed: ImageFailure } | undefined => {
      if (generation !== this.generation) { this.unpin(key); return { failed: "unavailable" }; }
      if (tracked.decoded) return this.handle(tracked);
      if (tracked.failure) { this.unpin(key); return { failed: tracked.failure }; }
      return undefined;
    };
    // A read in flight for this picture is joined, never repeated — whether the
    // pool started it or an earlier click did. Two passes are all the pool can
    // need: once this picture is pinned it outranks whatever it has to give up,
    // so a second refusal for room is a real answer, not a race.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = settled();
      if (answer) return answer;
      if (tracked.reading) {
        await new Promise<ImageState>(resolve => tracked.waiters.push(resolve));
        continue;
      }
      // The pool had no room for it, and the person asked for this one by
      // name: it is read now rather than queued behind what is merely mounted.
      const outcome = await (tracked.opening ??= this.openRead(tracked, generation));
      if (!outcome.ok && outcome.reason === "room") break;
    }
    const answer = settled();
    if (answer) return answer;
    this.unpin(key);
    return { failed: "unavailable" };
  }

  /** Try a failed image again, because a person asked to. */
  retry(key: string): void {
    const tracked = this.queue.get(key);
    if (!tracked?.failure) return;
    tracked.failure = undefined;
    tracked.wait = undefined;
    this.announce(key);
    this.pump();
  }

  /** One fewer row or viewer is showing this image; the last one out revokes it. */
  release(key: string): void {
    const tracked = this.queue.get(key);
    if (!tracked) return;
    tracked.holds = Math.max(0, tracked.holds - 1);
    if (tracked.holds > 0) return;
    this.discard(tracked);
    this.pump();
  }

  clear(): void {
    this.generation += 1;
    // Every outstanding reservation is retired here, exactly once; the reads
    // holding them will find them gone and leave the counters alone.
    this.live.clear();
    this.reserved = { images: 0, bytes: 0, surface: 0 };
    // Anything waiting for a read slot wakes, finds the generation gone, and
    // gives up rather than waiting for a pool that no longer exists.
    const waiting = this.slots.splice(0, this.slots.length);
    for (const wake of waiting) wake();
    const tracked = [...this.queue.values()];
    this.queue.clear();
    for (const item of tracked) {
      if (item.decoded) URL.revokeObjectURL(item.decoded.url);
      item.decoded = undefined;
      item.reading = false;
      this.settle(item, { state: "waiting", reason: "retired" });
    }
    this.decodedCount = 0;
    this.bytes = 0;
    this.surface = 0;
    this.running = 0;
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  private remember(key: string, path: string, ref: BodyRef & { entryId: string }, mimeType: string, placed?: ImagePriority): Tracked {
    const existing = this.queue.get(key);
    if (existing) {
      // The same image, asked for again: keep its history, take the newest
      // reference so a re-read uses the revision the row is showing now.
      existing.path = path;
      existing.ref = ref;
      existing.mimeType = mimeType;
      // Opening says nothing about where the picture is; only a row does.
      if (placed !== undefined) this.rank(existing, placed);
      return existing;
    }
    const priority = placed ?? IMAGE_PRIORITY.visible;
    const tracked: Tracked = {
      key, path, ref, mimeType,
      holds: 0, pins: 0, reading: false, placed: priority,
      priority, stamp: isActive({ priority, stamp: 0, seq: 0 }) ? ++this.clock : 0,
      seq: this.queue.next(), waiters: [],
    };
    return this.queue.set(key, tracked);
  }

  /** Where the row says this image is now. */
  private rank(tracked: Tracked, placed: ImagePriority): void {
    tracked.placed = placed;
    this.settleRank(tracked);
  }

  /**
   * The rank the queue sorts on, derived rather than remembered: a picture a
   * viewer is holding is `requested`, and one nobody is holding is wherever
   * the row last said it was. Nothing keeps a rank it has stopped earning — a
   * picture opened once and closed again is evictable like any other.
   */
  private settleRank(tracked: Tracked): void {
    const wanted = tracked.pins > 0 ? IMAGE_PRIORITY.requested : tracked.placed;
    if (wanted >= IMAGE_PRIORITY.visible) tracked.stamp = ++this.clock;
    tracked.priority = wanted;
  }

  /** A viewer takes this picture: one hold, one pin, and the rank that follows. */
  private pin(tracked: Tracked): void {
    tracked.holds += 1;
    tracked.pins += 1;
    this.settleRank(tracked);
  }

  /**
   * The pool's own blob, for a viewer that has already pinned it. Nothing is
   * copied, and the hold is given back exactly once however many times the
   * caller releases it.
   */
  private handle(tracked: Tracked): ImagePicture {
    const { url, blob, bytes } = tracked.decoded!;
    const key = tracked.key;
    return { url, blob, bytes, release: once(() => this.unpin(key)) };
  }

  /**
   * Decide what to read next, once, after the caller has finished asking.
   *
   * A row mounts its pictures in one pass, and the queue is only a queue if it
   * sees that pass whole: scheduling the decision one microtask later is what
   * lets the image a person is looking at overtake the twenty that happened to
   * be asked for first.
   */
  private pump(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.pumping) { this.again = true; return; }
      this.pumping = true;
      try {
        do {
          this.again = false;
          this.trim();
          this.dispatch();
        } while (this.again);
      } finally {
        this.pumping = false;
      }
    });
  }

  /** Start what fits, most wanted first; queue the rest without failing it. */
  private dispatch(): void {
    const waiting = this.queue.urgent(item => item.holds > 0 && !item.decoded && !item.failure && !item.reading);
    for (const request of waiting) {
      // A person's own open waits for a slot; speculative work never takes one
      // out from under it.
      if (this.running >= IMAGE_READS_MAX || this.slots.length > 0) return;
      const claim = claimOf(request.ref);
      if (!this.makeRoom(claim, request)) {
        this.stall(request, isActive(request) ? "room" : "offscreen");
        continue;
      }
      this.begin(request, claim);
    }
  }

  /** Queued, not failed: say so once, and keep the row watching. */
  private stall(tracked: Tracked, reason: ImageWait): void {
    const changed = tracked.wait !== reason;
    tracked.wait = reason;
    this.settle(tracked, { state: "waiting", reason }, changed);
  }

  private settle(tracked: Tracked, state: ImageState, announce = true): void {
    const waiters = tracked.waiters;
    tracked.waiters = [];
    for (const waiter of waiters) waiter(state);
    if (announce) this.announce(tracked.key);
  }

  private announce(key: string): void {
    const listeners = this.watchers.get(key);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }

  /**
   * Charge what a read is about to cost, before a byte of it arrives.
   *
   * The reservation belongs to this read and this generation. Releasing it
   * twice, or releasing it after `clear()` already retired it, would drive the
   * budget negative and let the next image in on borrowed room.
   */
  private reserve(claim: Claim): { reservation: Claim; release: () => void } {
    const reservation = { ...claim };
    this.reserved.images += reservation.images;
    this.reserved.bytes += reservation.bytes;
    this.reserved.surface += reservation.surface;
    this.live.add(reservation);
    return { reservation, release: once(() => {
      if (!this.live.delete(reservation)) return;
      this.reserved.images -= reservation.images;
      this.reserved.bytes -= reservation.bytes;
      this.reserved.surface -= reservation.surface;
    }) };
  }

  /**
   * The header says what an image will really cost; the reservation moves with
   * it, and a claim that no longer fits ends the read then and there. A
   * retired reservation never moves a current counter.
   */
  private charge(reservation: Claim, priority: ImagePriority, generation: number, surface: number): boolean {
    if (generation !== this.generation || !this.live.has(reservation)) return false;
    const delta = surface - reservation.surface;
    if (delta > 0 && !this.fits({ images: 0, bytes: 0, surface: delta }, priority)) return false;
    this.reserved.surface += delta;
    reservation.surface = surface;
    return true;
  }

  /** One of the read slots, waiting for it if every one is busy. */
  private takeSlot(): Promise<void> {
    if (this.running < IMAGE_READS_MAX) { this.running += 1; return Promise.resolve(); }
    return new Promise<void>(resolve => { this.slots.push(resolve); });
  }

  /** Hand the slot to whoever is waiting for it, or give it back. */
  private freeSlot(): void {
    const next = this.slots.shift();
    if (next) { next(); return; }
    this.running = Math.max(0, this.running - 1);
  }

  private begin(request: Tracked, claim: Claim): void {
    const { reservation, release } = this.reserve(claim);
    const generation = this.generation;
    request.reading = true;
    request.wait = undefined;
    this.running += 1;
    void this.read(request.path, request.ref, request.mimeType, generation,
      surface => this.charge(reservation, request.priority, generation, surface),
      // Nobody is waiting for these bytes any more: the row went while they
      // were arriving, so the rest of them is not asked for.
      () => request.holds > 0,
    ).then(outcome => this.finish(request, generation, release, outcome));
  }

  /**
   * Read one picture for the person who asked for it, inside every bound the
   * pool applies to its own reads: a reservation `held`/`committed` can see,
   * one of the {@link IMAGE_READS_MAX} slots, and the in-flight byte bound of
   * {@link ImageBlobs.read}. What it reads is published into the pool, so it
   * is charged exactly once and the row showing the same picture gets it too.
   */
  private async openRead(tracked: Tracked, generation: number): Promise<ReadOutcome> {
    const claim = claimOf(tracked.ref);
    // Marked before the first await: the pool's own pass must not start a
    // second read of the same picture while this one is being set up.
    tracked.reading = true;
    tracked.wait = undefined;
    let slot = false;
    try {
      if (!this.makeRoom(claim, tracked)) {
        tracked.reading = false;
        this.stall(tracked, "room");
        return { ok: false, reason: "room" };
      }
      await this.takeSlot();
      slot = true;
      if (generation !== this.generation) return { ok: false, reason: "retired" };
      const { reservation, release } = this.reserve(claim);
      const outcome = await this.read(tracked.path, tracked.ref, tracked.mimeType, generation,
        surface => this.charge(reservation, tracked.priority, generation, surface));
      release();
      if (generation !== this.generation) {
        if (outcome.ok) URL.revokeObjectURL(outcome.url);
        return { ok: false, reason: "retired" };
      }
      tracked.reading = false;
      if (!outcome.ok) {
        if (outcome.reason === "retired" || outcome.reason === "room") {
          this.stall(tracked, isActive(tracked) ? "room" : "offscreen");
          return outcome;
        }
        tracked.failure = outcome.reason;
        this.settle(tracked, { state: "failed", reason: outcome.reason });
        return outcome;
      }
      if (!this.keep(tracked, outcome)) {
        URL.revokeObjectURL(outcome.url);
        this.stall(tracked, "room");
        return { ok: false, reason: "room" };
      }
      this.settle(tracked, { state: "ready", url: outcome.url });
      return outcome;
    } finally {
      tracked.reading = false;
      tracked.opening = undefined;
      if (slot) this.freeSlot();
      this.pump();
    }
  }

  private finish(request: Tracked, generation: number, release: () => void, outcome: ReadOutcome): void {
    release();
    // A read that outlived its generation touches nothing current: not a
    // holder, not a counter, not a row. It only gives back what it made.
    if (generation !== this.generation) {
      if (outcome.ok) URL.revokeObjectURL(outcome.url);
      return;
    }
    this.freeSlot();
    request.reading = false;
    if (!outcome.ok) {
      if (outcome.reason === "retired") {
        // Abandoned mid-read, or retired by a cleared pool: keep nothing.
        if (request.holds <= 0) { this.queue.delete(request.key); this.settle(request, { state: "waiting", reason: "retired" }, false); }
        this.pump();
        return;
      }
      if (outcome.reason === "room") { this.stall(request, isActive(request) ? "room" : "offscreen"); this.pump(); return; }
      request.failure = outcome.reason;
      this.settle(request, { state: "failed", reason: outcome.reason });
      this.pump();
      return;
    }
    // Nobody is showing it any more: it was read for a row that has gone.
    if (request.holds <= 0) {
      URL.revokeObjectURL(outcome.url);
      this.queue.delete(request.key);
      this.settle(request, { state: "waiting", reason: "retired" });
      this.pump();
      return;
    }
    // Budgets are checked before a URL is ever published: what cannot fit
    // after giving up what nobody is looking at is queued, and never takes an
    // image a row still has on screen.
    if (!this.keep(request, outcome)) {
      URL.revokeObjectURL(outcome.url);
      this.stall(request, isActive(request) ? "room" : "offscreen");
      this.pump();
      return;
    }
    this.settle(request, { state: "ready", url: outcome.url });
    this.pump();
  }

  // -------------------------------------------------------------------------
  // Room
  // -------------------------------------------------------------------------

  /**
   * Pictures decoded (or being read) for rows nobody is looking at: the
   * speculative residue, which is what {@link IMAGE_BLOB_MAX} bounds. What is
   * on screen is not part of it — it is bounded by bytes and by surface — so a
   * screenful of pictures never spends the lookahead's budget.
   */
  private residue(): number {
    let count = 0;
    for (const item of this.queue.values()) {
      if ((item.decoded !== undefined || item.reading) && !isActive(item)) count += 1;
    }
    return count;
  }

  /** Whether a claim of this size fits beside everything held and in flight. */
  private fits(claim: Claim, priority: ImagePriority): boolean {
    const committed = this.committed;
    if (committed.bytes + claim.bytes > IMAGE_BLOB_MAX_BYTES) return false;
    if (committed.surface + claim.surface > IMAGE_SURFACE_MAX_BYTES) return false;
    // A correction to a read already counted is a byte question only.
    if (claim.images === 0) return true;
    return isActive({ priority, stamp: 0, seq: 0 })
      ? committed.images + claim.images <= IMAGE_BLOB_ACTIVE_MAX
      : this.residue() + claim.images <= IMAGE_BLOB_MAX;
  }

  /**
   * Make room for an image somebody wants, by giving up the picture that has
   * been off screen longest. A picture a viewer is holding is never taken, and
   * a picture is only ever taken by something wanted **more** than it is: a
   * row on screen takes from what is off screen, speculative work takes only
   * from the speculative residue, and the one picture a person explicitly
   * asked to open may, last of all, take from one on screen — which says it
   * will come back, and does, as soon as the viewer closes.
   */
  private makeRoom(claim: Claim, request: Tracked): boolean {
    if (this.fits(claim, request.priority)) return true;
    const opened = request.priority >= IMAGE_PRIORITY.requested;
    const victims = this.queue.stalest(item =>
      item.key !== request.key && item.decoded !== undefined && item.pins === 0
      && item.priority < request.priority && (opened || !isActive(item)));
    for (const victim of victims) {
      this.evict(victim);
      if (this.fits(claim, request.priority)) return true;
    }
    return this.fits(claim, request.priority);
  }

  /**
   * Give one picture's decode up. The row keeps its place and its reference:
   * it says it will come back, and it does — this is never a failure.
   */
  private evict(tracked: Tracked): void {
    const decoded = tracked.decoded;
    if (!decoded) return;
    URL.revokeObjectURL(decoded.url);
    tracked.decoded = undefined;
    this.decodedCount = Math.max(0, this.decodedCount - 1);
    this.bytes -= decoded.bytes;
    this.surface -= decoded.surface;
    if (tracked.holds <= 0 && !tracked.reading) { this.queue.delete(tracked.key); return; }
    tracked.wait = isActive(tracked) ? "room" : "offscreen";
    this.announce(tracked.key);
  }

  /** Bring the off-screen residue back inside its own, smaller, budget. */
  private trim(): void {
    if (this.residue() <= IMAGE_BLOB_MAX) return;
    for (const victim of this.queue.stalest(item => item.decoded !== undefined && item.pins === 0 && !isActive(item))) {
      if (this.residue() <= IMAGE_BLOB_MAX) return;
      this.evict(victim);
    }
  }

  private keep(request: Tracked, read: { url: string; blob: Blob; bytes: number; surface: number }): boolean {
    const claim = { images: 1, bytes: read.bytes, surface: read.surface };
    if (!this.makeRoom(claim, request)) return false;
    request.decoded = { url: read.url, blob: read.blob, bytes: read.bytes, surface: read.surface };
    request.wait = undefined;
    this.decodedCount += 1;
    this.bytes += read.bytes;
    this.surface += read.surface;
    return true;
  }

  /**
   * A viewer closed. The picture stops being `requested` and rejoins the order
   * where its row says it is, so an image somebody opened once is evictable
   * again like any other.
   */
  private unpin(key: string): void {
    const tracked = this.queue.get(key);
    if (tracked) {
      tracked.pins = Math.max(0, tracked.pins - 1);
      this.settleRank(tracked);
    }
    this.release(key);
    this.pump();
  }

  /** Nothing is holding this image any more. */
  private discard(tracked: Tracked): void {
    if (tracked.decoded) {
      URL.revokeObjectURL(tracked.decoded.url);
      this.decodedCount = Math.max(0, this.decodedCount - 1);
      this.bytes -= tracked.decoded.bytes;
      this.surface -= tracked.decoded.surface;
      tracked.decoded = undefined;
    }
    // A read still in flight keeps its record until it lands, so its
    // reservation and its generation fence are released exactly once.
    if (!tracked.reading) this.queue.delete(tracked.key);
    this.settle(tracked, { state: "waiting", reason: "retired" }, false);
  }

  // -------------------------------------------------------------------------
  // The read itself
  // -------------------------------------------------------------------------

  private async read(
    path: string,
    ref: BodyRef & { entryId: string },
    mimeType: string,
    generation: number,
    claim: (surface: number) => boolean,
    /** Whether anyone is still waiting for these bytes. */
    alive: () => boolean = () => true,
  ): Promise<ReadOutcome> {
    if (ref.totalBytes > IMAGE_MAX_ENCODED_BYTES) return { ok: false, reason: "too-large" };
    const revisions = new BodyRevisionFence(path, ref.revision, ref.contentDigest, this.revisionOf);
    let digest: string | undefined = ref.contentDigest;
    // Decoded chunks go into the blob as they arrive: at most one slice's
    // worth of bytes is ever in the JavaScript heap.
    let blob = new Blob([], { type: mimeType });
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let bytes = 0;
    let offset = 0;
    let seenTotal: number | undefined = ref.totalBytes;
    let seenAuthority: "live" | "durable" | undefined;
    let surface: number | undefined;
    const running = new Sha256Stream();
    const flush = (): void => {
      if (pendingBytes === 0) return;
      blob = new Blob([blob, ...(pending as BlobPart[])], { type: mimeType });
      pending = [];
      pendingBytes = 0;
    };
    try {
      for (;;) {
        if (generation !== this.generation || !alive()) return { ok: false, reason: "retired" };
        const reply = await revisions.read(async (revision) => checkRangeReply(
          await this.request({ path, environmentKey: this.environmentKey, revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
          { revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest: digest, ...(seenAuthority ? { authority: seenAuthority } : {}) },
        ), () => generation === this.generation);
        seenTotal = reply.totalBytes;
        seenAuthority = reply.authority;
        digest = reply.contentDigest;
        running.updateText(reply.text);
        const decoded = decodeBase64(reply.text);
        if (!decoded) return { ok: false, reason: "corrupt" };
        if (surface === undefined) {
          // The header lives in the first bytes; an image whose header cannot be
          // read is charged the declared floor, and one whose dimensions are
          // impossible or over budget is refused outright.
          const dimensions = imageDimensions(reply.text.slice(0, 8192));
          const measured = dimensions ? dimensions.width * dimensions.height * 4 : (ref.image?.decodedBytes ?? UNKNOWN_IMAGE_DECODED_BYTES);
          if (!Number.isFinite(measured) || measured <= 0) return { ok: false, reason: "corrupt" };
          if (measured > IMAGE_SURFACE_MAX_BYTES) return { ok: false, reason: "too-large" };
          surface = Math.floor(measured);
          // The real cost is known now; if it no longer fits, stop reading —
          // and say it is room, not a broken image.
          if (!claim(surface)) return { ok: false, reason: generation === this.generation ? "room" : "retired" };
        }
        bytes += decoded.byteLength;
        if (bytes > IMAGE_MAX_ENCODED_BYTES) return { ok: false, reason: "too-large" };
        if (pendingBytes + decoded.byteLength > IMAGE_INFLIGHT_MAX_BYTES) flush();
        pending.push(decoded);
        pendingBytes += decoded.byteLength;
        if (reply.next === undefined) break;
        offset = reply.next;
      }
    } catch (failure) {
      return { ok: false, reason: generation === this.generation ? classify(failure) : "retired" };
    }
    flush();
    if (generation !== this.generation) return { ok: false, reason: "retired" };
    // An image is published only when what was read is the image the
    // conversation holds, whole.
    if (digest === undefined || running.digest() !== digest) return { ok: false, reason: "corrupt" };
    return { ok: true, url: URL.createObjectURL(blob), blob, bytes, surface: surface ?? UNKNOWN_IMAGE_DECODED_BYTES };
  }
}

/**
 * What went wrong, in the terms a person is told about: bytes that were not
 * this image, a conversation that moved under the read, or an authority that
 * could not be asked just now. Every one of them is retryable except a picture
 * that is simply too big for this window.
 *
 * A refused reply is always "not this image", whether its digest, its entry or
 * its revision is the part that did not match: the window refuses to show it
 * either way, and saying so is the honest sentence. A revision the authority
 * itself will not serve, after the fence has already tried once, is the
 * conversation moving.
 */
function classify(failure: unknown): ImageFailure {
  if (failure instanceof BodyReplyRefused) return failure.detail === "read-retired" ? "unavailable" : "corrupt";
  if ((failure as { code?: number } | null)?.code === -32007) return "moved";
  return "unavailable";
}

function decodeBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}
