/**
 * What the renderer keeps of a large body, and where the rest of it is (RP-5b).
 *
 * A transcript is a bounded cache of a conversation the host and the worker
 * own. Before this, it was not: a reply, a tool result or an image was held in
 * full, twice — once as the raw entry it came in and once as the block derived
 * from it — and one 2 MiB answer was enough to put a single pinned view at
 * twice the whole renderer's byte budget and the process at 2.5 GiB.
 *
 * So nothing here holds a whole body. A body larger than
 * {@link BODY_EXCERPT_MAX_BYTES} is kept as an **excerpt** — the first bytes of
 * it, cut on a character boundary — beside a {@link BodyRef} that says exactly
 * how large the whole thing is, which entry and component it belongs to, and
 * at which revision that was true. The rest is read back a slice at a time
 * with `session/entry_range`, from the worker that owns the session or from
 * the host's read-only projection of the stored conversation.
 *
 * A live turn has no entry yet, so its excerpt is the **tail**: the newest
 * bytes, which is what a person watching a reply arrive is reading. The head
 * it dropped is recorded exactly and becomes readable the moment the turn is
 * persisted and an entry id exists.
 *
 * Nothing is ever silently shortened: every excerpt carries the exact number
 * of bytes it is not showing, and every one of them can be read.
 *
 * Pure: no React, no DOM, no network, and no allocation proportional to the
 * body it measures.
 */
import { utf8ByteLength, type BodyComponent, type BodyRegion } from "@lasercode/protocol";

/** Bytes of one body this view keeps. */
export const BODY_EXCERPT_MAX_BYTES = 16 * 1024;
/**
 * Bytes of **one** live body this view keeps while a turn streams — its prose
 * and its reasoning are two, and they are shown together in one message, so
 * this is half the per-message render budget rather than all of it
 * ({@link MESSAGE_RENDER_MAX_BYTES}). Larger than a settled excerpt because it
 * is the only slice that can be shown at all until the turn is written and
 * becomes addressable.
 */
export const LIVE_TAIL_MAX_BYTES = 32 * 1024;

/**
 * What one message may render at once, every body of it together (RP-5b §7).
 * A streamed turn shows two bodies at their tail bound; a settled one shows
 * excerpts, which are smaller again.
 */
export const MESSAGE_RENDER_MAX_BYTES = 64 * 1024;

/**
 * Where a body lives, and how much of it this view is not holding.
 *
 * `excerpt` is the slice the view has: its offset into the body and its size.
 * A head excerpt starts at 0; a live tail starts at the bytes already dropped.
 */
export interface BodyRef {
  /** The durable entry; absent only while a live turn has not been written. */
  entryId?: string;
  component: BodyComponent;
  /** Exact UTF-8 size of the whole body. */
  totalBytes: number;
  /** The addressable window inside that body: how an attachment is addressed. */
  region?: BodyRegion;
  excerpt: { offset: number; bytes: number };
  /** The revision the entry was read at, for the range request's fence. */
  revision?: string;
  /** A live turn: the excerpt is its tail, and nothing can be read yet. */
  live?: true;
  /**
   * What an image reference costs once it is shown: its validated dimensions
   * read from a bounded prefix of its own bytes, and the decoded surface they
   * imply. Absent when no header could be validated — then the surface is
   * charged the declared floor instead, never zero (RP-5b §7.3).
   */
  image?: { width?: number; height?: number; decodedBytes: number } | undefined;
}

export interface Excerpt {
  text: string;
  ref?: BodyRef;
}

/** Cut on a character boundary, never inside one; no encode, no allocation. */
function headIndex(text: string, maxBytes: number): { index: number; bytes: number } {
  let bytes = 0;
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    let size: number;
    let step = 1;
    if (code < 0x80) size = 1;
    else if (code < 0x800) size = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) { size = 4; step = 2; } else size = 3;
    } else size = 3;
    if (bytes + size > maxBytes) return { index, bytes };
    bytes += size;
    index += step;
  }
  return { index: text.length, bytes };
}

/** The same walk from the end, for a live tail. */
function tailIndex(text: string, maxBytes: number): { index: number; bytes: number } {
  let bytes = 0;
  for (let index = text.length; index > 0; ) {
    const code = text.charCodeAt(index - 1);
    let size: number;
    let step = 1;
    if (code < 0x80) size = 1;
    else if (code >= 0xdc00 && code <= 0xdfff) {
      const high = index - 2 >= 0 ? text.charCodeAt(index - 2) : 0;
      if (high >= 0xd800 && high <= 0xdbff) { size = 4; step = 2; } else size = 3;
    } else if (code < 0x800) size = 2;
    else size = 3;
    if (bytes + size > maxBytes) return { index, bytes };
    bytes += size;
    index -= step;
  }
  return { index: 0, bytes };
}

export interface ExcerptSource {
  entryId?: string | undefined;
  component: BodyComponent;
  revision?: string | undefined;
  region?: BodyRegion | undefined;
}

/**
 * Keep the start of a settled body. Under the bound the text is kept as it is
 * and no reference is needed — the view is holding the whole thing.
 */
export function excerptHead(text: string, source: ExcerptSource, maxBytes = BODY_EXCERPT_MAX_BYTES): Excerpt {
  const total = utf8ByteLength(text);
  if (total <= maxBytes) return { text };
  const head = headIndex(text, maxBytes);
  return {
    text: text.slice(0, head.index),
    ref: {
      ...(source.entryId !== undefined ? { entryId: source.entryId } : {}),
      component: source.component,
      totalBytes: total,
      ...(source.region ? { region: source.region } : {}),
      ...(source.revision !== undefined ? { revision: source.revision } : {}),
      excerpt: { offset: 0, bytes: head.bytes },
    },
  };
}

/**
 * Keep the end of a body still being written. The head it drops is counted
 * exactly; `live` says the rest cannot be read yet because the turn has not
 * been persisted.
 */
export function excerptLiveTail(text: string, source: ExcerptSource, maxBytes = LIVE_TAIL_MAX_BYTES): Excerpt {
  const total = utf8ByteLength(text);
  if (total <= maxBytes) return { text };
  const tail = tailIndex(text, maxBytes);
  const offset = total - tail.bytes;
  return {
    text: text.slice(tail.index),
    ref: {
      ...(source.entryId !== undefined ? { entryId: source.entryId } : {}),
      component: source.component,
      totalBytes: total,
      ...(source.revision !== undefined ? { revision: source.revision } : {}),
      excerpt: { offset, bytes: tail.bytes },
      ...(source.entryId === undefined ? { live: true as const } : {}),
    },
  };
}

/**
 * Append to a live body without ever holding more than the tail bound.
 *
 * The delta is sliced, the old text is dropped, and the bytes that went are
 * added to what the reference already says is missing — so a turn that streams
 * eight megabytes costs the tail bound, not eight megabytes, and still says
 * exactly how much came before.
 */
export function appendLive(current: string, delta: string, previous: BodyRef | undefined, source: ExcerptSource, maxBytes = LIVE_TAIL_MAX_BYTES): Excerpt {
  const dropped = previous?.excerpt.offset ?? 0;
  const combined = current + delta;
  const total = dropped + utf8ByteLength(combined);
  if (total <= maxBytes) return { text: combined };
  const tail = tailIndex(combined, maxBytes);
  return {
    text: combined.slice(tail.index),
    ref: {
      ...(source.entryId !== undefined ? { entryId: source.entryId } : {}),
      component: source.component,
      totalBytes: total,
      ...(source.revision !== undefined ? { revision: source.revision } : {}),
      excerpt: { offset: total - tail.bytes, bytes: tail.bytes },
      ...(source.entryId === undefined ? { live: true as const } : {}),
    },
  };
}

/** Bytes of a body this view is not holding. Zero when it holds all of it. */
export function omittedBytes(ref: BodyRef | undefined): number {
  return ref ? Math.max(0, ref.totalBytes - ref.excerpt.bytes) : 0;
}

/**
 * A reference whose rest can be read right now: it names a persisted entry and
 * is not the tail of a turn still being written. The revision may be absent —
 * a body that arrived live carries none — and the reader asks the host for the
 * one it is serving before it reads (`session/revision`).
 */
export function isReadable(ref: BodyRef | undefined): ref is BodyRef & { entryId: string } {
  return ref !== undefined && ref.live !== true && typeof ref.entryId === "string" && ref.entryId !== "";
}
