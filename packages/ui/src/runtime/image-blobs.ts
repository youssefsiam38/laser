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
  /** The person asked for this one by name; it keeps that rank. */
  asked: boolean;
  decoded?: Decoded | undefined;
  reading: boolean;
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
    this.trim();
    this.pump();
  }

  /**
   * The image itself, for something that needs the bytes rather than a picture
   * — opening it, copying it, saving it. Taking it is a hold **and** a pin, so
   * nothing revokes or evicts the URL while a viewer is showing it. Nothing is
   * copied: this is the blob the pool already charged for, so opening an image
   * the window has costs no memory at all.
   */
  source(key: string): ImagePicture | undefined {
    const tracked = this.queue.get(key);
    if (!tracked?.decoded) return undefined;
    tracked.holds += 1;
    tracked.pins += 1;
    this.rank(tracked, IMAGE_PRIORITY.requested);
    tracked.asked = true;
    const { url, blob, bytes } = tracked.decoded;
    return { url, blob, bytes, release: () => this.unpin(key) };
  }

  /**
   * Open one image because the person asked for it (M16-T82).
   *
   * A picture this window is holding is handed over as it is. One it is not —
   * because the pool had no room, or gave its decode up while it was off
   * screen — is read back from the conversation's own authority through the
   * same fence and the same whole-image digest, so the action works whenever
   * the bytes exist, whatever the decode pool is doing. Only the image itself
   * being unreadable is a failure.
   */
  async open(key: string, path: string, ref: BodyRef & { entryId: string }, mimeType: string): Promise<ImagePicture | { failed: ImageFailure }> {
    const held = this.source(key);
    if (held) return held;
    const tracked = this.remember(key, path, ref, mimeType, IMAGE_PRIORITY.requested);
    tracked.asked = true;
    this.rank(tracked, IMAGE_PRIORITY.requested);
    if (tracked.failure) return { failed: tracked.failure };
    if (oversized(ref, claimOf(ref))) {
      tracked.failure = "too-large";
      this.announce(key);
      return { failed: "too-large" };
    }
    // The viewer's hold is taken before the read, so a row that goes while the
    // person is opening it cannot revoke the picture under the viewer.
    tracked.holds += 1;
    tracked.pins += 1;
    const generation = this.generation;
    const pooled = await new Promise<ImageState>(resolve => {
      if (tracked.decoded) { resolve({ state: "ready", url: tracked.decoded.url }); return; }
      tracked.waiters.push(resolve);
      this.pump();
    });
    if (generation !== this.generation) { this.unpin(key); return { failed: "unavailable" }; }
    if (pooled.state === "ready" && tracked.decoded) {
      const { url, blob, bytes } = tracked.decoded;
      return { url, blob, bytes, release: () => this.unpin(key) };
    }
    if (pooled.state === "failed") { this.unpin(key); return { failed: pooled.reason }; }
    // No room in the pool, and the person is asking for this one: read it for
    // the viewer alone. It is bounded by the single-image limits, and it is
    // revoked when the viewer closes.
    const outcome = await this.read(path, ref, mimeType, generation, () => true);
    this.unpin(key);
    if (!outcome.ok) {
      if (outcome.reason === "retired" || outcome.reason === "room") return { failed: "unavailable" };
      return { failed: outcome.reason };
    }
    if (generation !== this.generation) { URL.revokeObjectURL(outcome.url); return { failed: "unavailable" }; }
    let released = false;
    return {
      url: outcome.url,
      blob: outcome.blob,
      bytes: outcome.bytes,
      release: () => { if (released) return; released = true; URL.revokeObjectURL(outcome.url); },
    };
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

  private remember(key: string, path: string, ref: BodyRef & { entryId: string }, mimeType: string, priority: ImagePriority): Tracked {
    const existing = this.queue.get(key);
    if (existing) {
      // The same image, asked for again: keep its history, take the newest
      // reference so a re-read uses the revision the row is showing now.
      existing.path = path;
      existing.ref = ref;
      existing.mimeType = mimeType;
      this.rank(existing, priority);
      return existing;
    }
    const tracked: Tracked = {
      key, path, ref, mimeType,
      holds: 0, pins: 0, asked: false, reading: false,
      priority, stamp: isActive({ priority, stamp: 0, seq: 0 }) ? ++this.clock : 0,
      seq: this.queue.next(), waiters: [],
    };
    return this.queue.set(key, tracked);
  }

  /** Where an image stands now. What the person asked for keeps its rank. */
  private rank(tracked: Tracked, priority: ImagePriority): void {
    const wanted = tracked.asked ? IMAGE_PRIORITY.requested : priority;
    if (wanted >= IMAGE_PRIORITY.visible) tracked.stamp = ++this.clock;
    tracked.priority = wanted;
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
      if (this.running >= IMAGE_READS_MAX) return;
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

  private begin(request: Tracked, claim: Claim): void {
    const reservation = { ...claim };
    this.reserved.images += reservation.images;
    this.reserved.bytes += reservation.bytes;
    this.reserved.surface += reservation.surface;
    // The reservation belongs to this read and this generation. Releasing it
    // twice, or releasing it after `clear()` already retired it, would drive
    // the budget negative and let the next image in on borrowed room.
    this.live.add(reservation);
    const release = (): void => {
      if (!this.live.delete(reservation)) return;
      this.reserved.images -= reservation.images;
      this.reserved.bytes -= reservation.bytes;
      this.reserved.surface -= reservation.surface;
    };
    const generation = this.generation;
    request.reading = true;
    request.wait = undefined;
    this.running += 1;
    void this.read(request.path, request.ref, request.mimeType, generation, (surface) => {
      // The header says what it will really cost; the claim moves with it, and
      // a claim that no longer fits ends the read then and there.
      // A retired reservation never moves a current counter.
      if (generation !== this.generation || !this.live.has(reservation)) return false;
      const delta = surface - reservation.surface;
      if (delta > 0 && !this.fits({ images: 0, bytes: 0, surface: delta }, request.priority)) return false;
      this.reserved.surface += delta;
      reservation.surface = surface;
      return true;
    }).then(outcome => this.finish(request, generation, release, outcome));
  }

  private finish(request: Tracked, generation: number, release: () => void, outcome: ReadOutcome): void {
    release();
    // A read that outlived its generation touches nothing current: not a
    // holder, not a counter, not a row. It only gives back what it made.
    if (generation !== this.generation) {
      if (outcome.ok) URL.revokeObjectURL(outcome.url);
      return;
    }
    this.running = Math.max(0, this.running - 1);
    request.reading = false;
    if (!outcome.ok) {
      if (outcome.reason === "retired") { this.pump(); return; }
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

  /** Whether a claim of this size fits beside everything held and in flight. */
  private fits(claim: Claim, priority: ImagePriority): boolean {
    const ceiling = priority >= IMAGE_PRIORITY.visible ? IMAGE_BLOB_ACTIVE_MAX : IMAGE_BLOB_MAX;
    const committed = this.committed;
    return committed.images + claim.images <= ceiling
      && committed.bytes + claim.bytes <= IMAGE_BLOB_MAX_BYTES
      && committed.surface + claim.surface <= IMAGE_SURFACE_MAX_BYTES;
  }

  /**
   * Make room for an image somebody is looking at, by giving up the picture
   * that has been off screen longest. A picture in a viewer, or one on screen,
   * is never taken; speculative work never takes anything at all.
   */
  private makeRoom(claim: Claim, request: Tracked): boolean {
    if (this.fits(claim, request.priority)) return true;
    if (!isActive(request)) return false;
    const victims = this.queue.stalest(item =>
      item.key !== request.key && item.decoded !== undefined && item.pins === 0 && item.priority <= IMAGE_PRIORITY.nearby && item.priority < request.priority);
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
    if (this.decodedCount <= IMAGE_BLOB_MAX) return;
    for (const victim of this.queue.stalest(item => item.decoded !== undefined && item.pins === 0 && item.priority <= IMAGE_PRIORITY.nearby)) {
      if (this.decodedCount <= IMAGE_BLOB_MAX) return;
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

  private unpin(key: string): void {
    const tracked = this.queue.get(key);
    if (tracked) tracked.pins = Math.max(0, tracked.pins - 1);
    this.release(key);
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
        if (generation !== this.generation) return { ok: false, reason: "retired" };
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
