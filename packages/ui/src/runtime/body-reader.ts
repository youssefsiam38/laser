/**
 * Reading back what a transcript does not hold (RP-5b).
 *
 * A view keeps a bounded excerpt of a large body and a {@link BodyRef} saying
 * where the rest is. This is the one place that asks for the rest, through
 * `session/entry_range`, a slice at a time, bound to the revision the excerpt
 * was read at.
 *
 * Three shapes, all bounded on purpose:
 *
 * - {@link BodyWindow} pages text. It holds a deque of slices and evicts the
 *   oldest when the window would grow past its aggregate, so paging through a
 *   thirty-two megabyte tool result never builds a thirty-two megabyte string.
 *   Exactly one read is ever in flight, and a reply that does not describe the
 *   body that was asked for is refused rather than shown.
 * - {@link ImageBlobs} rebuilds an image outside the JavaScript heap: slices
 *   are decoded and appended to a `Blob` as they arrive — never collected in
 *   an array first — the object URL is reference counted by the rows showing
 *   it, and a device that switches environments fences everything in flight.
 * - {@link streamBody} hands a whole body to a consumer a slice at a time, for
 *   a copy-all that verifies its digest without ever retaining the body.
 *
 * A refusal is a person-facing sentence, never a stack trace: a conversation
 * that moved on says so and offers the one thing that helps — read it again.
 */
import { ENTRY_RANGE_MAX_BYTES, sameBodyComponent, utf8ByteLength, type ClientRequests } from "@lasercode/protocol";
import type { BodyRef } from "./body-excerpt.js";

export type RangeRequest = (params: ClientRequests["session/entry_range"]["params"]) => Promise<ClientRequests["session/entry_range"]["result"]>;
/** The revision this host is serving for one conversation (RP-9). */
export type RevisionRequest = (path: string) => Promise<string>;
type RangeResult = ClientRequests["session/entry_range"]["result"];

/** Bytes of a body the viewer may hold at once, across every slice. */
export const BODY_VIEWER_AGGREGATE_MAX_BYTES = 256 * 1024;
/** One step of reading. A multiple of four, so a base64 slice decodes alone. */
export const BODY_SLICE_BYTES = 64 * 1024;

export interface BodySlice {
  offset: number;
  bytes: number;
  text: string;
}

export interface BodyWindowState {
  slices: readonly BodySlice[];
  totalBytes: number;
  /** Bytes held across every slice right now. */
  heldBytes: number;
  /** Where reading forward would continue, or `undefined` at the end. */
  next?: number;
  /** Slices dropped to stay inside the aggregate. Said out loud in the UI. */
  evicted: number;
  contentDigest?: string;
}

const EMPTY: BodyWindowState = { slices: [], totalBytes: 0, heldBytes: 0, evicted: 0 };

/**
 * A reply that does not describe the body that was asked for is a bug or an
 * attack, and either way it is never shown. Everything checkable is checked
 * before a byte reaches the surface: the body it belongs to, where it starts,
 * how big it says it is, and that it is moving forward.
 */
export class BodyReplyRefused extends Error {
  constructor(readonly detail: string) {
    super("That part of the message did not arrive as expected. Open the conversation again.");
    this.name = "BodyReplyRefused";
  }
}

export function validateRangeReply(
  reply: RangeResult,
  expected: { revision: string; component: BodyRef["component"]; offset: number; limit: number; totalBytes?: number | undefined; contentDigest?: string | undefined },
): RangeResult {
  const fail = (detail: string): never => { throw new BodyReplyRefused(detail); };
  if (reply.revision !== expected.revision) fail("revision");
  if (!sameBodyComponent(reply.component, expected.component)) fail("component");
  if (reply.offset !== expected.offset) fail("offset");
  if (!Number.isInteger(reply.totalBytes) || reply.totalBytes < 0) fail("total");
  if (expected.totalBytes !== undefined && reply.totalBytes !== expected.totalBytes) fail("total-changed");
  if (expected.contentDigest !== undefined && reply.contentDigest !== expected.contentDigest) fail("content-digest");
  if (typeof reply.text !== "string") fail("text");
  const bytes = utf8ByteLength(reply.text);
  if (reply.bytes !== bytes) fail("bytes");
  if (bytes > Math.min(expected.limit, ENTRY_RANGE_MAX_BYTES)) fail("over-limit");
  if (reply.offset + bytes > reply.totalBytes) fail("past-end");
  if (reply.next !== undefined && reply.next !== reply.offset + bytes) fail("next");
  if (reply.next === undefined && reply.offset + bytes !== reply.totalBytes && bytes !== 0) fail("unterminated");
  if (reply.next !== undefined && reply.next <= reply.offset && bytes > 0) fail("not-monotonic");
  return reply;
}

/**
 * A bounded window over one body. Never more than
 * {@link BODY_VIEWER_AGGREGATE_MAX_BYTES} in hand, whatever the body's size,
 * and never two reads at once.
 */
export class BodyWindow {
  private state: BodyWindowState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private inflight: Promise<void> | undefined;
  private token: symbol | undefined;
  private resolved: string | undefined;
  private seenTotal: number | undefined;
  private seenDigest: string | undefined;

  constructor(
    private readonly request: RangeRequest,
    private readonly path: string,
    private readonly ref: BodyRef & { entryId: string },
    private readonly aggregate = BODY_VIEWER_AGGREGATE_MAX_BYTES,
    private readonly environmentKey = "",
    private readonly revisionOf?: RevisionRequest,
  ) {}

  /**
   * The revision to read at: the one the excerpt was taken at when it has one,
   * otherwise the one the host is serving right now. A body that arrived live
   * carries no revision, and inventing one would be a lie.
   */
  private async revision(): Promise<string> {
    if (this.ref.revision) return this.ref.revision;
    this.resolved ??= this.revisionOf ? await this.revisionOf(this.path) : "";
    return this.resolved;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BodyWindowState => this.state;

  /** Where reading backwards would continue, or `undefined` at the start. */
  get previous(): number | undefined {
    const first = this.state.slices[0];
    if (!first || first.offset === 0) return undefined;
    return Math.max(0, first.offset - BODY_SLICE_BYTES);
  }

  /** Read one slice at an exact offset, replacing the window. */
  jump(offset: number): Promise<void> {
    return this.fenced(async () => {
      const result = await this.slice(offset);
      this.publish({
        slices: [{ offset: result.offset, bytes: result.bytes, text: result.text }],
        totalBytes: result.totalBytes,
        heldBytes: result.bytes,
        ...(result.next !== undefined ? { next: result.next } : {}),
        evicted: this.state.slices.length,
        ...(result.contentDigest ? { contentDigest: result.contentDigest } : {}),
      });
    });
  }

  /** Read the next slice, evicting the oldest ones if the window is full. */
  more(): Promise<void> {
    return this.fenced(async () => {
      const from = this.state.slices.length === 0 ? this.ref.excerpt.offset + this.ref.excerpt.bytes : this.state.next;
      if (from === undefined) return;
      const result = await this.slice(from);
      const slices = [...this.state.slices, { offset: result.offset, bytes: result.bytes, text: result.text }];
      let held = this.state.heldBytes + result.bytes;
      let evicted = this.state.evicted;
      // Paging forward drops what is furthest behind rather than growing.
      while (held > this.aggregate && slices.length > 1) {
        held -= slices[0]!.bytes;
        slices.shift();
        evicted += 1;
      }
      this.publish({
        slices,
        totalBytes: result.totalBytes,
        heldBytes: held,
        ...(result.next !== undefined ? { next: result.next } : {}),
        evicted,
        ...(result.contentDigest ? { contentDigest: result.contentDigest } : {}),
      });
    });
  }

  /** Read the slice before the window, for PageUp. */
  back(): Promise<void> {
    const from = this.previous;
    if (from === undefined) return Promise.resolve();
    return this.jump(from);
  }

  /** Forget everything held, and fence anything still in flight. */
  clear(): void {
    this.generation += 1;
    this.inflight = undefined;
    this.publish(EMPTY);
  }

  /**
   * One read at a time. A person holding PageDown, or clicking while a key
   * repeat is in flight, must not produce two reads of the same offset — and
   * must never interleave two answers into the window.
   */
  private fenced(work: () => Promise<void>): Promise<void> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const token = Symbol("read");
    this.token = token;
    const settled = (async () => {
      try {
        if (generation !== this.generation) return;
        await work();
      } finally {
        if (this.token === token) this.inflight = undefined;
      }
    })();
    this.inflight = settled;
    return settled;
  }

  private async slice(offset: number): Promise<RangeResult> {
    const revision = await this.revision();
    const limit = Math.min(BODY_SLICE_BYTES, ENTRY_RANGE_MAX_BYTES);
    const reply = await this.request({
      path: this.path,
      environmentKey: this.environmentKey,
      revision,
      entryId: this.ref.entryId,
      component: this.ref.component,
      offset,
      limit,
    });
    const checked = validateRangeReply(reply, {
      revision,
      component: this.ref.component,
      offset,
      limit,
      totalBytes: this.seenTotal,
      contentDigest: this.seenDigest,
    });
    this.seenTotal = checked.totalBytes;
    this.seenDigest = checked.contentDigest;
    return checked;
  }

  private publish(state: BodyWindowState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Hand a whole body to a consumer a slice at a time, never retaining it.
 *
 * This is how "copy all of it" works: the slices go straight to the sink — a
 * clipboard writer, a file — and only the digest of what went through is kept,
 * so the caller can say whether what it handed over is what the conversation
 * holds.
 */
export async function streamBody(
  request: RangeRequest,
  path: string,
  ref: BodyRef & { entryId: string },
  options: { environmentKey?: string; revision?: string; revisionOf?: RevisionRequest; signal?: { aborted: boolean } },
  sink: (slice: string) => void | Promise<void>,
): Promise<{ bytes: number; totalBytes: number; contentDigest?: string }> {
  const revision = ref.revision ?? options.revision ?? (options.revisionOf ? await options.revisionOf(path) : "");
  let offset = 0;
  let bytes = 0;
  let totalBytes = 0;
  let contentDigest: string | undefined;
  let seenTotal: number | undefined;
  for (;;) {
    if (options.signal?.aborted) break;
    const reply = validateRangeReply(
      await request({ path, environmentKey: options.environmentKey ?? "", revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
      { revision, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest },
    );
    seenTotal = reply.totalBytes;
    contentDigest = reply.contentDigest;
    totalBytes = reply.totalBytes;
    await sink(reply.text);
    bytes += reply.bytes;
    if (reply.next === undefined) break;
    offset = reply.next;
  }
  return { bytes, totalBytes, ...(contentDigest ? { contentDigest } : {}) };
}

/**
 * Where a query first matches inside a body this window does not hold.
 *
 * Streams the body a slice at a time from its authority and returns the exact
 * byte offset of the first match, so find can open the viewer *at* the match
 * instead of pulling the whole body back into the transcript. One slice is in
 * hand at a time, plus the overlap a match spanning a seam needs.
 */
export async function findInBody(
  request: RangeRequest,
  path: string,
  ref: BodyRef & { entryId: string },
  query: string,
  options: { environmentKey?: string; revisionOf?: RevisionRequest; signal?: { aborted: boolean } } = {},
): Promise<number | undefined> {
  if (!query) return undefined;
  const revision = ref.revision ?? (options.revisionOf ? await options.revisionOf(path) : "");
  const needle = query.toLowerCase();
  let offset = 0;
  let carry = "";
  let carryOffset = 0;
  let seenTotal: number | undefined;
  let digest: string | undefined;
  for (;;) {
    if (options.signal?.aborted) return undefined;
    const reply = validateRangeReply(
      await request({ path, environmentKey: options.environmentKey ?? "", revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
      { revision, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest: digest },
    );
    seenTotal = reply.totalBytes;
    digest = reply.contentDigest;
    const window = carry + reply.text;
    const at = window.toLowerCase().indexOf(needle);
    if (at >= 0) return carryOffset + utf8ByteLength(window.slice(0, at));
    // Keep only what a match spanning this seam could need.
    const keep = Math.max(0, Math.min(window.length, query.length - 1));
    carry = window.slice(window.length - keep);
    carryOffset = reply.offset + reply.bytes - utf8ByteLength(carry);
    if (reply.next === undefined) return undefined;
    offset = reply.next;
  }
}

/**
 * A refusal, in a person's words. Nothing here shows a code or a path.
 */
export function bodyReadMessage(error: unknown): string {
  if (error instanceof BodyReplyRefused) return error.message;
  const code = (error as { code?: number } | null)?.code;
  if (code === -32007) return "This conversation moved on since this message was read. Open it again to see the rest.";
  if (code === -32000) return "This conversation is no longer stored here.";
  return "That part could not be read just now. Try again in a moment.";
}

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

interface BlobEntry { url: string; bytes: number; holders: number; surface: number }

export class ImageBlobs {
  private readonly entries = new Map<string, BlobEntry>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly revisions = new Map<string, Promise<string>>();
  private bytes = 0;
  private surface = 0;
  private generation = 0;

  constructor(private readonly request: RangeRequest, private readonly environmentKey = "", private readonly revisionOf?: RevisionRequest) {}

  /** What this window is holding: images, their bytes, their decoded surface. */
  get held(): { images: number; bytes: number; surface: number } {
    return { images: this.entries.size, bytes: this.bytes, surface: this.surface };
  }

  url(key: string): string | undefined {
    return this.entries.get(key)?.url;
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
    const held = this.entries.get(key);
    if (held) { held.holders += 1; return Promise.resolve(held.url); }
    // The surface this image will occupy once the browser decodes it, from the
    // dimensions its own header gave, or the declared floor when it gave none.
    const surface = ref.image?.decodedBytes ?? 0;
    if (surface > IMAGE_SURFACE_MAX_BYTES) return Promise.resolve(undefined);
    const active = this.inflight.get(key);
    if (active) return active;
    const generation = this.generation;
    const work = this.read(path, ref, mimeType, generation).then((loaded) => {
      this.inflight.delete(key);
      // A cache cleared while this was in flight has left the environment this
      // read belongs to: the bytes are dropped, never published.
      if (!loaded || generation !== this.generation) {
        if (loaded) URL.revokeObjectURL(loaded.url);
        return undefined;
      }
      this.keep(key, loaded.url, loaded.bytes, surface);
      return loaded.url;
    }, () => {
      this.inflight.delete(key);
      return undefined;
    });
    this.inflight.set(key, work);
    return work;
  }

  /** One fewer row is showing this image; the last one out revokes it. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.holders -= 1;
    if (entry.holders > 0) return;
    URL.revokeObjectURL(entry.url);
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.surface -= entry.surface;
  }

  clear(): void {
    this.generation += 1;
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.inflight.clear();
    this.revisions.clear();
    this.bytes = 0;
    this.surface = 0;
  }

  private keep(key: string, url: string, bytes: number, surface: number): void {
    this.entries.set(key, { url, bytes, holders: 1, surface });
    this.bytes += bytes;
    this.surface += surface;
    while ((this.entries.size > IMAGE_BLOB_MAX || this.bytes > IMAGE_BLOB_MAX_BYTES || this.surface > IMAGE_SURFACE_MAX_BYTES) && this.entries.size > 1) {
      // The oldest image nobody is showing goes first; a held one is only
      // dropped when the budget leaves no other choice.
      const victim = [...this.entries.entries()].find(([name, entry]) => name !== key && entry.holders <= 0)
        ?? [...this.entries.entries()].find(([name]) => name !== key);
      if (!victim) break;
      URL.revokeObjectURL(victim[1].url);
      this.entries.delete(victim[0]);
      this.bytes -= victim[1].bytes;
      this.surface -= victim[1].surface;
    }
  }

  private async read(path: string, ref: BodyRef & { entryId: string }, mimeType: string, generation: number): Promise<{ url: string; bytes: number } | undefined> {
    if (ref.totalBytes > IMAGE_MAX_ENCODED_BYTES) return undefined;
    const revision = await this.revision(path, ref);
    // Decoded chunks go into the blob as they arrive: at most one slice's
    // worth of bytes is ever in the JavaScript heap.
    let blob = new Blob([], { type: mimeType });
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let bytes = 0;
    let offset = 0;
    let seenTotal: number | undefined;
    let digest: string | undefined;
    const flush = (): void => {
      if (pendingBytes === 0) return;
      blob = new Blob([blob, ...(pending as BlobPart[])], { type: mimeType });
      pending = [];
      pendingBytes = 0;
    };
    for (;;) {
      if (generation !== this.generation) return undefined;
      const reply = validateRangeReply(
        await this.request({ path, environmentKey: this.environmentKey, revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
        { revision, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest: digest },
      );
      seenTotal = reply.totalBytes;
      digest = reply.contentDigest;
      const decoded = decodeBase64(reply.text);
      if (!decoded) return undefined;
      bytes += decoded.byteLength;
      if (bytes > IMAGE_MAX_ENCODED_BYTES) return undefined;
      pending.push(decoded);
      pendingBytes += decoded.byteLength;
      if (pendingBytes >= IMAGE_INFLIGHT_MAX_BYTES) flush();
      if (reply.next === undefined) break;
      offset = reply.next;
    }
    flush();
    if (generation !== this.generation) return undefined;
    return { url: URL.createObjectURL(blob), bytes };
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
