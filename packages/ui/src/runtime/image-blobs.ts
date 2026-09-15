/**
 * Images, rebuilt outside the JavaScript heap and bounded (RP-5b §7.3).
 *
 * A prompt's image is never kept as base64 in a view: its bytes are read back
 * through the range contract into a `Blob`, which the browser keeps out of the
 * JavaScript heap. This pool is what bounds that: how many images, how many
 * encoded bytes, how much decoded surface — counting the reads in flight, not
 * only the ones that finished — and it never evicts an image a row is showing.
 */
import { imageDimensions, UNKNOWN_IMAGE_DECODED_BYTES } from "./view-measure.js";
import type { BodyRef } from "./body-excerpt.js";
import { BODY_SLICE_BYTES, checkRangeReply, type RangeRequest, type RevisionRequest } from "./body-reader.js";
import { Sha256Stream } from "./sha256.js";

/**
 * Images, rebuilt outside the JavaScript heap and bounded.
 *
 * Slices of the base64 payload are decoded on arrival and appended to the
 * growing `Blob` — a `Blob` of blobs, which the browser keeps out of the
 * JavaScript heap — so at most {@link IMAGE_INFLIGHT_MAX_BYTES} of decoded
 * bytes are ever in hand at once, whatever the image weighs. The URL is
 * reference counted by the rows showing it and revoked when the last of them
 * goes; a cache that is cleared fences every read still in flight, so a late
 * answer cannot resurrect a URL for an environment this device has left.
 */
export const IMAGE_BLOB_MAX = 24;
/** Decoded bytes this window may hold across every image at once. */
export const IMAGE_BLOB_MAX_BYTES = 128 * 1024 * 1024;
/** Decoded bytes in hand while one image is being read. */
export const IMAGE_INFLIGHT_MAX_BYTES = 256 * 1024;
/** A single image larger than this is not rebuilt in this window. */
export const IMAGE_MAX_ENCODED_BYTES = 48 * 1024 * 1024;
/**
 * Decoded surface this window admits at once, across every image it is
 * showing. The unchanged twelve-image fixture is 12 × 2048² × 4 = 192 MiB of
 * surface, so the budget admits it and refuses the next conversation's worth
 * rather than letting decoded memory grow without a number.
 */
export const IMAGE_SURFACE_MAX_BYTES = 256 * 1024 * 1024;

interface BlobEntry { url: string; blob: Blob; bytes: number; holders: number; surface: number }

export class ImageBlobs {
  private readonly entries = new Map<string, BlobEntry>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly revisions = new Map<string, Promise<string>>();
  /**
   * How many rows are showing each image, counted from the moment one asks —
   * including while the read is still in flight, so two rows that share a read
   * are two holders and the first unmount does not revoke what the second is
   * showing.
   */
  private readonly holds = new Map<string, number>();
  private bytes = 0;
  private surface = 0;
  private generation = 0;
  /**
   * What reads still in flight have already claimed. Admission counts these
   * too: without them, any number of rows could each start building a large
   * blob and only be refused afterwards, which is the memory this budget
   * exists to prevent.
   */
  private reserved = { images: 0, bytes: 0, surface: 0 };
  /** The reservations still owned by reads of the current generation. */
  private live = new Set<{ images: number; bytes: number; surface: number }>();

  constructor(private readonly request: RangeRequest, private readonly environmentKey = "", private readonly revisionOf?: RevisionRequest) {}

  /** What this window is holding: images, their bytes, their decoded surface. */
  get held(): { images: number; bytes: number; surface: number } {
    return { images: this.entries.size, bytes: this.bytes, surface: this.surface };
  }

  /** What it is holding **and** what reads in flight have claimed. */
  get committed(): { images: number; bytes: number; surface: number } {
    return {
      images: this.entries.size + this.reserved.images,
      bytes: this.bytes + this.reserved.bytes,
      surface: this.surface + this.reserved.surface,
    };
  }

  url(key: string): string | undefined {
    return this.entries.get(key)?.url;
  }

  /**
   * The image itself, for something that needs the bytes rather than a picture
   * — opening it, copying it, saving it. Taking it is a hold, so nothing
   * revokes the URL while a viewer is showing it, and the caller releases it
   * the way a row does. Nothing is copied: this is the blob the pool already
   * charged for, so opening an image costs no memory at all.
   */
  source(key: string): { url: string; blob: Blob; bytes: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.holders += 1;
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    return { url: entry.url, blob: entry.blob, bytes: entry.bytes };
  }

  private revision(path: string, ref: BodyRef): Promise<string> {
    if (ref.revision) return Promise.resolve(ref.revision);
    let pending = this.revisions.get(path);
    if (!pending) {
      pending = this.revisionOf ? this.revisionOf(path) : Promise.resolve("");
      this.revisions.set(path, pending);
    }
    return pending;
  }

  /** Load one image's bytes into a blob URL, or `undefined` when it cannot be read. */
  load(key: string, path: string, ref: BodyRef & { entryId: string }, mimeType: string): Promise<string | undefined> {
    // Every ask is a hold, whether it starts a read, joins one, or finds the
    // image already here.
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    const held = this.entries.get(key);
    if (held) { held.holders = this.holds.get(key) ?? 1; return Promise.resolve(held.url); }
    // The surface this image will occupy once the browser decodes it, from the
    // dimensions its own header gave, or the declared floor when it gave none:
    // a number nobody could read is never zero (RP-5b §7.3).
    const declared = ref.image?.decodedBytes;
    const claimed = typeof declared === "number" && Number.isFinite(declared) && declared > 0
      ? Math.floor(declared)
      : UNKNOWN_IMAGE_DECODED_BYTES;
    if (claimed > IMAGE_SURFACE_MAX_BYTES || ref.totalBytes > IMAGE_MAX_ENCODED_BYTES) {
      this.drop(key);
      return Promise.resolve(undefined);
    }
    // One read, one reservation: callers that join an existing read share it
    // and each keep their own hold.
    const active = this.inflight.get(key);
    if (active) return active;
    // Claim room before a byte is read. The encoded charge is what the
    // reference says the payload weighs; the decoded charge is what its header
    // will imply, corrected from the real header once the read has one.
    const reservation = { images: 1, bytes: ref.totalBytes, surface: claimed };
    if (!this.admits(reservation)) {
      this.drop(key);
      return Promise.resolve(undefined);
    }
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
    const work = this.read(path, ref, mimeType, generation, (surface) => {
      // The header says what it will really cost; the claim moves with it, and
      // a claim that no longer fits ends the read then and there.
      // A retired reservation never moves a current counter.
      if (generation !== this.generation || !this.live.has(reservation)) return false;
      const delta = surface - reservation.surface;
      if (delta > 0 && !this.admits({ images: 0, bytes: 0, surface: delta })) return false;
      this.reserved.surface += delta;
      reservation.surface = surface;
      return true;
    }).then((loaded) => {
      // A read that outlived its generation touches nothing current: not the
      // in-flight map, not a holder, not a counter. It only gives back the URL
      // it made.
      if (generation !== this.generation) {
        release();
        if (loaded) URL.revokeObjectURL(loaded.url);
        return undefined;
      }
      if (this.inflight.get(key) === work) this.inflight.delete(key);
      release();
      // A cache cleared while this was in flight has left the environment this
      // read belongs to: the bytes are dropped, never published.
      if (!loaded || generation !== this.generation) {
        if (loaded) URL.revokeObjectURL(loaded.url);
        this.drop(key);
        return undefined;
      }
      // Budgets are checked before a URL is ever published: what cannot fit
      // after releasing what nobody is showing is refused, and never takes an
      // image a row still has on screen.
      // What the image's **own header** says it will decode to, read from the
      // first slice of its bytes: a record this view only points at carries no
      // dimensions, and a declared floor would let a 2048² image in as if it
      // were a small one (RP-5b §7.3).
      if (!this.keep(key, loaded.url, loaded.blob, loaded.bytes, loaded.surface)) {
        URL.revokeObjectURL(loaded.url);
        this.drop(key);
        return undefined;
      }
      return loaded.url;
    }, () => {
      release();
      if (generation !== this.generation) return undefined;
      if (this.inflight.get(key) === work) this.inflight.delete(key);
      this.drop(key);
      return undefined;
    });
    this.inflight.set(key, work);
    return work;
  }

  /** One fewer row is showing this image; the last one out revokes it. */
  release(key: string): void {
    const holders = (this.holds.get(key) ?? 0) - 1;
    if (holders > 0) { this.holds.set(key, holders); }
    else this.holds.delete(key);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.holders = Math.max(0, holders);
    if (entry.holders > 0) return;
    URL.revokeObjectURL(entry.url);
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.surface -= entry.surface;
  }

  /** A hold that produced nothing. */
  private drop(key: string): void {
    const holders = (this.holds.get(key) ?? 0) - 1;
    if (holders > 0) this.holds.set(key, holders); else this.holds.delete(key);
  }

  clear(): void {
    this.generation += 1;
    // Every outstanding reservation is retired here, exactly once; the reads
    // holding them will find them gone and leave the counters alone.
    this.live.clear();
    this.reserved = { images: 0, bytes: 0, surface: 0 };
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.inflight.clear();
    this.revisions.clear();
    this.holds.clear();
    this.bytes = 0;
    this.surface = 0;
  }

  /**
   * Admit an image, or refuse it. Only images nobody is showing are released to
   * make room; one a row still has on screen is never taken away for a newer
   * one, and a newcomer that still does not fit is refused instead.
   */
  /** Whether a claim of this size fits beside everything held and in flight. */
  private admits(claim: { images: number; bytes: number; surface: number }): boolean {
    const committed = this.committed;
    return committed.images + claim.images <= IMAGE_BLOB_MAX
      && committed.bytes + claim.bytes <= IMAGE_BLOB_MAX_BYTES
      && committed.surface + claim.surface <= IMAGE_SURFACE_MAX_BYTES;
  }

  private keep(key: string, url: string, blob: Blob, bytes: number, surface: number): boolean {
    const fits = (): boolean =>
      this.entries.size + this.reserved.images + 1 <= IMAGE_BLOB_MAX
      && this.bytes + this.reserved.bytes + bytes <= IMAGE_BLOB_MAX_BYTES
      && this.surface + this.reserved.surface + surface <= IMAGE_SURFACE_MAX_BYTES;
    while (!fits()) {
      const victim = [...this.entries.entries()].find(([name, entry]) => name !== key && entry.holders <= 0 && (this.holds.get(name) ?? 0) <= 0);
      if (!victim) return false;
      URL.revokeObjectURL(victim[1].url);
      this.entries.delete(victim[0]);
      this.bytes -= victim[1].bytes;
      this.surface -= victim[1].surface;
    }
    this.entries.set(key, { url, blob, bytes, holders: this.holds.get(key) ?? 1, surface });
    this.bytes += bytes;
    this.surface += surface;
    return true;
  }

  private async read(
    path: string,
    ref: BodyRef & { entryId: string },
    mimeType: string,
    generation: number,
    claim: (surface: number) => boolean,
  ): Promise<{ url: string; blob: Blob; bytes: number; surface: number } | undefined> {
    if (ref.totalBytes > IMAGE_MAX_ENCODED_BYTES) return undefined;
    const revision = await this.revision(path, ref);
    let digest: string | undefined = ref.contentDigest;
    // Decoded chunks go into the blob as they arrive: at most one slice's
    // worth of bytes is ever in the JavaScript heap.
    let blob = new Blob([], { type: mimeType });
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let bytes = 0;
    let offset = 0;
    let seenTotal: number | undefined;
    let seenAuthority: "live" | "durable" | undefined;
    let surface: number | undefined;
    const running = new Sha256Stream();
    const flush = (): void => {
      if (pendingBytes === 0) return;
      blob = new Blob([blob, ...(pending as BlobPart[])], { type: mimeType });
      pending = [];
      pendingBytes = 0;
    };
    for (;;) {
      if (generation !== this.generation) return undefined;
      const reply = await checkRangeReply(
        await this.request({ path, environmentKey: this.environmentKey, revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
        { revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest: digest, ...(seenAuthority ? { authority: seenAuthority } : {}) },
      );
      seenTotal = reply.totalBytes;
      seenAuthority = reply.authority;
      digest = reply.contentDigest;
      running.updateText(reply.text);
      const decoded = decodeBase64(reply.text);
      if (!decoded) return undefined;
      if (surface === undefined) {
        // The header lives in the first bytes; an image whose header cannot be
        // read is charged the declared floor, and one whose dimensions are
        // impossible or over budget is refused outright.
        const dimensions = imageDimensions(reply.text.slice(0, 8192));
        const measured = dimensions ? dimensions.width * dimensions.height * 4 : (ref.image?.decodedBytes ?? UNKNOWN_IMAGE_DECODED_BYTES);
        if (!Number.isFinite(measured) || measured <= 0) return undefined;
        if (measured > IMAGE_SURFACE_MAX_BYTES) return undefined;
        surface = Math.floor(measured);
        // The real cost is known now; if it no longer fits, stop reading.
        if (!claim(surface)) return undefined;
      }
      bytes += decoded.byteLength;
      if (bytes > IMAGE_MAX_ENCODED_BYTES) return undefined;
      if (pendingBytes + decoded.byteLength > IMAGE_INFLIGHT_MAX_BYTES) flush();
      pending.push(decoded);
      pendingBytes += decoded.byteLength;
      if (reply.next === undefined) break;
      offset = reply.next;
    }
    flush();
    if (generation !== this.generation) return undefined;
    // An image is published only when what was read is the image the
    // conversation holds, whole.
    if (digest === undefined || running.digest() !== digest) return undefined;
    return { url: URL.createObjectURL(blob), blob, bytes, surface: surface ?? UNKNOWN_IMAGE_DECODED_BYTES };
  }
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
