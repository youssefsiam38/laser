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
import { imageDimensions, UNKNOWN_IMAGE_DECODED_BYTES } from "./view-measure.js";
import { Sha256Stream } from "./sha256.js";

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

export interface ReplyExpectation {
  revision: string;
  component: BodyRef["component"];
  offset: number;
  limit: number;
  totalBytes?: number | undefined;
  contentDigest?: string | undefined;
}

/**
 * Everything about a reply that can be checked without hashing it: which body
 * it is, where it starts, how much it carries, whether it says it has more,
 * and that it is actually moving forward. A shape that does not hold together
 * is refused before a byte of it is shown.
 */
export function validateRangeReply(reply: RangeResult, expected: ReplyExpectation): RangeResult {
  const fail = (detail: string): never => { throw new BodyReplyRefused(detail); };
  if (reply.revision !== expected.revision) fail("revision");
  if (!sameBodyComponent(reply.component, expected.component)) fail("component");
  if (reply.offset !== expected.offset) fail("offset");
  if (!Number.isInteger(reply.totalBytes) || reply.totalBytes < 0) fail("total");
  if (expected.totalBytes !== undefined && reply.totalBytes !== expected.totalBytes) fail("total-changed");
  if (typeof reply.contentDigest !== "string" || !DIGEST.test(reply.contentDigest)) fail("content-digest-shape");
  if (expected.contentDigest !== undefined && reply.contentDigest !== expected.contentDigest) fail("content-digest");
  if (typeof reply.sliceDigest !== "string" || !DIGEST.test(reply.sliceDigest)) fail("slice-digest-shape");
  if (typeof reply.text !== "string") fail("text");
  const bytes = utf8ByteLength(reply.text);
  if (reply.bytes !== bytes) fail("bytes");
  if (bytes > Math.min(expected.limit, ENTRY_RANGE_MAX_BYTES)) fail("over-limit");
  if (reply.offset + bytes > reply.totalBytes) fail("past-end");
  // `truncated` is not decoration: it says exactly whether there is more, and
  // must agree with the cursor the reply carries.
  if (reply.truncated !== (reply.next !== undefined)) fail("truncated");
  if (reply.next !== undefined) {
    if (reply.next !== reply.offset + bytes) fail("next");
    // A continuation that advances nothing is a loop, not an answer.
    if (bytes === 0) fail("zero-progress");
    if (reply.next <= reply.offset) fail("not-monotonic");
    if (reply.next > reply.totalBytes) fail("next-past-end");
  } else {
    // The last slice ends the body exactly; an empty one only at its very end.
    if (reply.offset + bytes !== reply.totalBytes) fail("unterminated");
    if (bytes === 0 && reply.offset !== reply.totalBytes) fail("empty");
  }
  return reply;
}

const DIGEST = /^[0-9a-f]{64}$/;

/** SHA-256 of a slice, as the authorities write it. */
export async function sliceDigestOf(text: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The shape **and** the bytes: a slice whose digest does not match what the
 * authority said it sent is never shown, never decoded and never copied. A
 * window with no way to hash refuses rather than trusting the bytes, because
 * "we could not check" is not "it is fine".
 */
export async function checkRangeReply(reply: RangeResult, expected: ReplyExpectation): Promise<RangeResult> {
  validateRangeReply(reply, expected);
  const digest = await sliceDigestOf(reply.text);
  if (digest === undefined) throw new BodyReplyRefused("no-digest-support");
  if (digest !== reply.sliceDigest) throw new BodyReplyRefused("slice-digest");
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
  private seenDigest: string | undefined = undefined;

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
  private async revision(generation: number): Promise<string> {
    if (this.ref.revision) return this.ref.revision;
    if (this.resolved !== undefined) return this.resolved;
    const answer = this.revisionOf ? await this.revisionOf(this.path) : "";
    // What a read of a retired generation learned is its own business: it is
    // used to finish that read and never written where a successor reads it.
    if (generation === this.generation) this.resolved = answer;
    return answer;
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

  /**
   * Read one slice at an exact offset, replacing the window.
   *
   * `align` is the viewer looking for its **own** starting point: a backward
   * step of a fixed number of bytes can land inside a character, and the
   * authority rightly refuses that, so the search moves forward by up to three
   * bytes to the next boundary. An offset that came from somewhere real — an
   * excerpt, a find result — is never shifted.
   */
  jump(offset: number, options: { align?: boolean } = {}): Promise<void> {
    return this.fenced(async (generation) => {
      const result = options.align ? await this.alignedSlice(offset, generation) : await this.slice(offset, generation);
      this.commit(generation, {
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
    return this.fenced(async (generation) => {
      const from = this.state.slices.length === 0 ? this.ref.excerpt.offset + this.ref.excerpt.bytes : this.state.next;
      if (from === undefined) return;
      const result = await this.slice(from, generation);
      const slices = [...this.state.slices, { offset: result.offset, bytes: result.bytes, text: result.text }];
      let held = this.state.heldBytes + result.bytes;
      let evicted = this.state.evicted;
      // Paging forward drops what is furthest behind rather than growing.
      while (held > this.aggregate && slices.length > 1) {
        held -= slices[0]!.bytes;
        slices.shift();
        evicted += 1;
      }
      this.commit(generation, {
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
    return this.jump(from, { align: true });
  }

  /** Read the last window of the body, for End. */
  last(): Promise<void> {
    const total = this.state.totalBytes;
    if (total <= 0) return this.more();
    return this.jump(Math.max(0, total - BODY_SLICE_BYTES), { align: true });
  }

  /** Walk forward to the next character boundary, at most three bytes. */
  private async alignedSlice(offset: number, generation = this.generation): Promise<RangeResult> {
    let failure: unknown;
    for (let step = 0; step <= 3; step++) {
      try {
        return await this.slice(offset + step, generation);
      } catch (error) {
        // Only "that is not a boundary" is worth another try; everything else
        // is the authority saying something this viewer must not paper over.
        if ((error as { code?: number } | null)?.code !== -32602) throw error;
        failure = error;
      }
    }
    throw failure;
  }

  /** Forget everything held, and fence anything still in flight. */
  clear(): void {
    this.generation += 1;
    this.inflight = undefined;
    this.token = undefined;
    // Everything this window believed about the body it was reading goes with
    // it: the next read starts from what its own reference says.
    this.resolved = undefined;
    this.seenTotal = undefined;
    this.seenDigest = undefined;
    this.publish(EMPTY);
  }

  /**
   * One read at a time. A person holding PageDown, or clicking while a key
   * repeat is in flight, must not produce two reads of the same offset — and
   * must never interleave two answers into the window.
   */
  private fenced(work: (generation: number) => Promise<void>): Promise<void> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const token = Symbol("read");
    this.token = token;
    const settled = (async () => {
      try {
        if (generation !== this.generation) return;
        // The fence is checked again where the result lands, not only here: a
        // read that was in flight when the viewer was cleared must not paint
        // its answer over an empty window, or over a successor's.
        await work(generation);
      } finally {
        // Only the read that owns the slot may clear it; a late one must not
        // settle a successor's request.
        if (this.token === token) this.inflight = undefined;
      }
    })();
    this.inflight = settled;
    return settled;
  }

  private async slice(offset: number, generation = this.generation): Promise<RangeResult> {
    const revision = await this.revision(generation);
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
    const checked = await checkRangeReply(reply, {
      revision,
      component: this.ref.component,
      offset,
      limit,
      totalBytes: generation === this.generation ? this.seenTotal : undefined,
      contentDigest: generation === this.generation ? (this.seenDigest ?? this.ref.contentDigest) : this.ref.contentDigest,
    });
    // The same fence on what this read *learned*: a late reply must not tell a
    // successor what size or digest to expect.
    if (generation === this.generation) {
      this.seenTotal = checked.totalBytes;
      this.seenDigest = checked.contentDigest;
    }
    return checked;
  }

  /** Publish only if this read still owns the window (see `fenced`). */
  private commit(generation: number, state: BodyWindowState): void {
    if (generation !== this.generation) return;
    this.publish(state);
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
): Promise<{ bytes: number; totalBytes: number; contentDigest?: string; verified: boolean }> {
  const revision = ref.revision ?? options.revision ?? (options.revisionOf ? await options.revisionOf(path) : "");
  let offset = 0;
  let bytes = 0;
  let totalBytes = 0;
  let contentDigest: string | undefined = ref.contentDigest;
  let seenTotal: number | undefined;
  // The whole body's digest, computed as it goes by: a reconstruction that
  // matched every slice can still be the wrong body, and a stream that was cut
  // short is never published as verified (RP-5b §7).
  const running = new Sha256Stream();
  let complete = true;
  for (;;) {
    if (options.signal?.aborted) { complete = false; break; }
    const reply = await checkRangeReply(
      await request({ path, environmentKey: options.environmentKey ?? "", revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
      { revision, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest },
    );
    seenTotal = reply.totalBytes;
    contentDigest = reply.contentDigest;
    totalBytes = reply.totalBytes;
    running.updateText(reply.text);
    await sink(reply.text);
    bytes += reply.bytes;
    if (reply.next === undefined) break;
    offset = reply.next;
  }
  const verified = complete && bytes === totalBytes && running.digest() === contentDigest;
  return { bytes, totalBytes, ...(contentDigest ? { contentDigest } : {}), verified };
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
  // A find query is scratch this viewer holds for every slice it reads, so it
  // has a stated bound like everything else here, and a query past it is
  // refused in words rather than answered "not found".
  if (utf8ByteLength(query) > FIND_QUERY_MAX_BYTES) {
    throw new BodyReplyRefused("This search is too long to look for in a message this size. Try a shorter phrase.");
  }
  const revision = ref.revision ?? (options.revisionOf ? await options.revisionOf(path) : "");
  let offset = 0;
  let carry = "";
  let carryOffset = 0;
  let seenTotal: number | undefined;
  let digest: string | undefined = ref.contentDigest;
  // Case folding can change length — `İ` lowercases to two code units — so a
  // match is located in the **original** text and never by mapping an index
  // back from a lowercased copy. The overlap kept between slices is generous
  // for the same reason.
  // The overlap between slices is the query plus room for a fold that grows,
  // and it is bounded by the same declared ceiling the query is.
  const carryChars = Math.min(Math.max(query.length * 2 + 8, 64), FIND_CARRY_MAX_CHARS);
  for (;;) {
    if (options.signal?.aborted) return undefined;
    const reply = await checkRangeReply(
      await request({ path, environmentKey: options.environmentKey ?? "", revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
      { revision, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest: digest },
    );
    seenTotal = reply.totalBytes;
    digest = reply.contentDigest;
    const window = carry + reply.text;
    const at = indexOfFolded(window, query);
    if (at >= 0) return carryOffset + utf8ByteLength(window.slice(0, at));
    const keep = Math.min(window.length, carryChars);
    carry = window.slice(window.length - keep);
    carryOffset = reply.offset + reply.bytes - utf8ByteLength(carry);
    if (reply.next === undefined) return undefined;
    offset = reply.next;
  }
}

/**
 * Where `needle` first matches `haystack`, ignoring case, in **haystack's own**
 * index space. Folding is applied to candidate windows rather than to the whole
 * string, so a fold that changes length cannot move the answer.
 */
export function indexOfFolded(haystack: string, needle: string): number {
  const folded = needle.toLowerCase();
  if (folded.length === 0) return -1;
  // One fold of the window, one search in it: the work is linear in the window,
  // not in the window times the query.
  const lowered = haystack.toLowerCase();
  const at = lowered.indexOf(folded);
  if (at < 0) return -1;
  // Folding can change length — `İ` lowercases to two code units — so the
  // folded index is walked back to the original one character at a time, and
  // that walk touches each character once.
  let original = 0;
  let mapped = 0;
  while (original < haystack.length && mapped < at) {
    const point = haystack.codePointAt(original)!;
    const character = String.fromCodePoint(point);
    original += character.length;
    mapped += character.toLowerCase().length;
  }
  // A fold that merged characters can land between two of them; the match then
  // begins at the character containing that point.
  return original;
}

/** Whether this window can take a whole body without assembling it in JS. */
export function canCopyWholeBody(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * Copy a whole body to the clipboard without ever holding it.
 *
 * Slices are folded into a `Blob` as they arrive — the browser keeps that out
 * of the JavaScript heap — and the clipboard is handed the blob itself. At
 * most {@link COPY_INFLIGHT_MAX_BYTES} of slice text is in hand at once, so a
 * thirty-two megabyte message costs a few hundred kilobytes of scratch. A
 * window that cannot take a blob is told so and offers the marked partial copy
 * instead; nothing is assembled as a fallback.
 */
export const COPY_INFLIGHT_MAX_BYTES = 256 * 1024;

/** The longest phrase this viewer will look for in a body it does not hold. */
export const FIND_QUERY_MAX_BYTES = 4 * 1024;

/** The overlap carried between slices, in code units; bounded by the query's. */
const FIND_CARRY_MAX_CHARS = 8 * 1024;

export async function copyWholeBody(
  request: RangeRequest,
  path: string,
  ref: BodyRef & { entryId: string },
  options: { environmentKey?: string; revisionOf?: RevisionRequest; clipboard?: { write: (items: unknown[]) => Promise<void> } } = {},
): Promise<{ ok: true; bytes: number } | { ok: false; reason: "unsupported" | "short" | "corrupt" }> {
  if (!options.clipboard && !canCopyWholeBody()) return { ok: false, reason: "unsupported" };
  let blob = new Blob([], { type: "text/plain" });
  let pending: string[] = [];
  let pendingBytes = 0;
  const fold = (): void => {
    if (pendingBytes === 0) return;
    blob = new Blob([blob, ...pending], { type: "text/plain" });
    pending = [];
    pendingBytes = 0;
  };
  const outcome = await streamBody(request, path, ref, options, (slice) => {
    // Bytes, not code units, and room made *before* the slice is taken: the
    // ceiling is what this holds at its peak, not what it holds after a flush.
    const size = utf8ByteLength(slice);
    if (pendingBytes + size > COPY_INFLIGHT_MAX_BYTES) fold();
    pending.push(slice);
    pendingBytes += size;
  });
  fold();
  if (outcome.bytes !== outcome.totalBytes) return { ok: false, reason: "short" };
  // Nothing reaches the clipboard unless it is the body the conversation says
  // it is, whole.
  if (!outcome.verified) return { ok: false, reason: "corrupt" };
  if (options.clipboard) await options.clipboard.write([blob]);
  else await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  return { ok: true, bytes: outcome.bytes };
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
      if (!this.keep(key, loaded.url, loaded.bytes, loaded.surface)) {
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

  private keep(key: string, url: string, bytes: number, surface: number): boolean {
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
    this.entries.set(key, { url, bytes, holders: this.holds.get(key) ?? 1, surface });
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
  ): Promise<{ url: string; bytes: number; surface: number } | undefined> {
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
        { revision, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest: digest },
      );
      seenTotal = reply.totalBytes;
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
    return { url: URL.createObjectURL(blob), bytes, surface: surface ?? UNKNOWN_IMAGE_DECODED_BYTES };
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
