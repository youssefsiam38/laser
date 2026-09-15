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
import { ATTACHMENT_MAX_BYTES, BODY_REGION_MAX_ITEMS, BODY_REGION_METADATA_MAX_BYTES, createAttachmentScanner, type AttachmentRegions } from "@lasercode/protocol";
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
  /** The entry asked about; a reply that names another one is refused. */
  entryId?: string | undefined;
  /** The authority that answered the previous slice of this same read. */
  authority?: "live" | "durable" | undefined;
  component: BodyRef["component"];
  offset: number;
  limit: number;
  totalBytes?: number | undefined;
  contentDigest?: string | undefined;
  /** The attachment asked for: the echo must be exactly this. */
  region?: { offset: number; bytes: number } | undefined;
  /** The digest the authority published for that region's stored bytes. */
  regionDigest?: string | undefined;
}

/**
 * Everything about a reply that can be checked without hashing it: which body
 * it is, where it starts, how much it carries, whether it says it has more,
 * and that it is actually moving forward. A shape that does not hold together
 * is refused before a byte of it is shown.
 */
export function validateRangeReply(reply: RangeResult, expected: ReplyExpectation): RangeResult {
  const fail = (detail: string): never => { throw new BodyReplyRefused(detail); };
  // Shape before arithmetic: every number a safe integer, the text really a
  // string, and one end-of-slice computed once and proved safe before it is
  // compared with anything (RP-5b).
  for (const [name, value] of [["offset", reply.offset], ["bytes", reply.bytes], ["total", reply.totalBytes]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name}-shape`);
  }
  if (reply.next !== undefined && (!Number.isSafeInteger(reply.next) || reply.next < 0)) fail("next-shape");
  if (typeof reply.text !== "string") fail("text");
  const bytes = utf8ByteLength(reply.text);
  if (reply.bytes !== bytes) fail("bytes");
  const sliceEnd = reply.offset + bytes;
  if (!Number.isSafeInteger(sliceEnd)) fail("slice-end-unsafe");
  // Exactly the two authorities this protocol has, and the same one all the
  // way through one read: a window cannot be half live and half stored.
  if (reply.authority !== "live" && reply.authority !== "durable") fail("authority");
  if (expected.authority !== undefined && reply.authority !== expected.authority) fail("authority-changed");
  // The entry a body belongs to is always said, and is always the one asked
  // about: an answer that names nothing could be any message's.
  if (typeof reply.entryId !== "string" || reply.entryId === "") fail("entry-missing");
  if (expected.entryId !== undefined && reply.entryId !== expected.entryId) fail("entry");
  if (reply.revision !== expected.revision) fail("revision");
  if (!sameBodyComponent(reply.component, expected.component)) fail("component");
  if (reply.offset !== expected.offset) fail("offset");
  if (expected.totalBytes !== undefined && reply.totalBytes !== expected.totalBytes) fail("total-changed");
  if (typeof reply.contentDigest !== "string" || !DIGEST.test(reply.contentDigest)) fail("content-digest-shape");
  if (expected.contentDigest !== undefined && reply.contentDigest !== expected.contentDigest) fail("content-digest");
  if (typeof reply.sliceDigest !== "string" || !DIGEST.test(reply.sliceDigest)) fail("slice-digest-shape");
  let regionEnd: number | undefined;
  if (expected.region !== undefined) {
    // A region read is answered for exactly the region asked for, in the
    // component's own offsets, with that region's own digest.
    const echo = reply.region;
    if (!echo || echo.offset !== expected.region.offset || echo.bytes !== expected.region.bytes) fail("region-echo");
    if (typeof reply.regionDigest !== "string" || !DIGEST.test(reply.regionDigest)) fail("region-digest-shape");
    if (expected.regionDigest !== undefined && reply.regionDigest !== expected.regionDigest) fail("region-digest");
    if (!Number.isSafeInteger(expected.region.offset) || !Number.isSafeInteger(expected.region.bytes)) fail("region-unsafe");
    regionEnd = expected.region.offset + expected.region.bytes;
    if (!Number.isSafeInteger(regionEnd)) fail("region-unsafe");
    if (reply.offset < expected.region.offset) fail("region-before");
    if (sliceEnd > regionEnd) fail("region-past-end");
  } else if (reply.region !== undefined) {
    fail("region-unasked");
  }
  if (bytes > Math.min(expected.limit, ENTRY_RANGE_MAX_BYTES)) fail("over-limit");
  if (sliceEnd > reply.totalBytes) fail("past-end");
  // `truncated` is not decoration: it says exactly whether there is more, and
  // must agree with the cursor the reply carries.
  if (reply.truncated !== (reply.next !== undefined)) fail("truncated");
  // For a region read the body ends at the region's end, even though the
  // component carries on past it.
  const endOfRead = regionEnd ?? reply.totalBytes;
  if (reply.next !== undefined) {
    if (reply.next !== sliceEnd) fail("next");
    // A continuation that advances nothing is a loop, not an answer.
    if (bytes === 0) fail("zero-progress");
    if (reply.next <= reply.offset) fail("not-monotonic");
    if (reply.next > endOfRead) fail("next-past-end");
  } else {
    // The last slice ends the read exactly; an empty one only at its very end.
    if (sliceEnd !== endOfRead) fail("unterminated");
    if (bytes === 0 && reply.offset !== endOfRead) fail("empty");
  }
  return reply;
}

/** The shape of every digest this protocol writes. */
export const DIGEST = /^[0-9a-f]{64}$/;

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
  /** Which authority answered this window; it may not change mid-read. */
  private seenAuthority: "live" | "durable" | undefined;

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
    this.seenAuthority = undefined;
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
      entryId: this.ref.entryId,
      ...(generation === this.generation && this.seenAuthority ? { authority: this.seenAuthority } : {}),
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
      this.seenAuthority = checked.authority;
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
  let seenAuthority: "live" | "durable" | undefined;
  // The whole body's digest, computed as it goes by: a reconstruction that
  // matched every slice can still be the wrong body, and a stream that was cut
  // short is never published as verified (RP-5b §7).
  const running = new Sha256Stream();
  let complete = true;
  for (;;) {
    if (options.signal?.aborted) { complete = false; break; }
    const reply = await checkRangeReply(
      await request({ path, environmentKey: options.environmentKey ?? "", revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES }),
      { revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest, ...(seenAuthority ? { authority: seenAuthority } : {}) },
    );
    seenTotal = reply.totalBytes;
    seenAuthority = reply.authority;
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
  let seenAuthority: "live" | "durable" | undefined;
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
      { revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, contentDigest: digest, ...(seenAuthority ? { authority: seenAuthority } : {}) },
    );
    seenTotal = reply.totalBytes;
    seenAuthority = reply.authority;
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


// The attachment and image readers were part of this module; they are their
// own now, and re-exported here so every caller keeps one import.
export * from "./attachment-reader.js";
export * from "./image-blobs.js";
