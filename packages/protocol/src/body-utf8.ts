/**
 * UTF-8 by the byte (RP-5b).
 *
 * Every offset in this protocol is an exact UTF-8 byte offset into a body, and
 * every cut is on a character boundary. This is the machinery that counts and
 * cuts: no allocation proportional to what it measures, and a cursor so a body
 * read in five hundred slices is walked once rather than five hundred times.
 *
 * Pure: no I/O, no Pi, no DOM.
 */
/** A non-negative safe integer, or undefined. */
export function safeOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}


/**
 * Exact UTF-8 byte length, counted rather than produced: measuring a megabyte
 * of Markdown must not allocate a megabyte to find out how big it is. The two
 * cases a naive version gets wrong are handled the way `TextEncoder` does — a
 * surrogate pair is one four-byte character, a lone surrogate is the
 * three-byte replacement character.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export interface Utf8Slice {
  /** The slice, always valid UTF-8 and never a character the source did not have. */
  text: string;
  /** Exact UTF-8 offset this slice starts at. */
  offset: number;
  /** Exact UTF-8 bytes it carries. */
  bytes: number;
  /** Where the next slice starts; absent at the end of the component. */
  next?: number;
  /** A limit or a code-point boundary shortened this slice. */
  truncated: boolean;
}

/**
 * Slice a string by exact UTF-8 byte offsets without encoding it.
 *
 * `offset` must fall on a character boundary of the source; a request that
 * lands inside a character is refused by the caller, never silently moved. The
 * end is moved *back* to the nearest boundary so a slice never carries half a
 * character and never invents a replacement one.
 */
/**
 * Where a byte offset sits in a string, so the next slice does not start its
 * walk at the beginning again. Reading a thirty-megabyte body in sixty-four
 * kilobyte slices is O(total) once, not O(total) per slice.
 */
export interface Utf8Cursor {
  byteOffset: number;
  charIndex: number;
}

export interface CursoredSlice extends Utf8Slice {
  /** Where this slice ended, to hand to the next call. */
  cursor: Utf8Cursor;
  /** Exact UTF-8 size of the whole string, computed once per body. */
  totalBytes: number;
}

const ZERO: Utf8Cursor = { byteOffset: 0, charIndex: 0 };

/** The size in bytes of the character at `index`, and how many code units it spans. */
function charAt(text: string, index: number): { size: number; step: number } {
  const code = text.charCodeAt(index);
  if (code < 0x80) return { size: 1, step: 1 };
  if (code < 0x800) return { size: 2, step: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
    return low >= 0xdc00 && low <= 0xdfff ? { size: 4, step: 2 } : { size: 3, step: 1 };
  }
  return { size: 3, step: 1 };
}

/**
 * Slice a string by exact UTF-8 byte offsets without encoding it, continuing
 * from a cursor when one is supplied.
 *
 * `offset` must fall on a character boundary of the source; a request that
 * lands inside a character is refused by the caller, never silently moved. The
 * end is moved *back* to the nearest boundary so a slice never carries half a
 * character and never invents a replacement one.
 */
export function sliceUtf8RangeFrom(
  text: string,
  offset: number,
  limit: number,
  hint?: Utf8Cursor,
  knownTotal?: number,
): CursoredSlice | undefined {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0) return undefined;
  const total = knownTotal ?? utf8ByteLength(text);
  if (offset > total) return undefined;
  if (offset === total) return { text: "", offset, bytes: 0, truncated: false, totalBytes: total, cursor: { byteOffset: total, charIndex: text.length } };

  // Walk forward from the nearest known position rather than from the start.
  const from = hint && hint.byteOffset <= offset && hint.charIndex <= text.length ? hint : ZERO;
  let bytes = from.byteOffset;
  let index = from.charIndex;
  while (bytes < offset && index < text.length) {
    const { size, step } = charAt(text, index);
    // An offset inside a character addresses no slice; it is refused, never moved.
    if (bytes + size > offset) return undefined;
    bytes += size;
    index += step;
  }
  if (bytes !== offset) return undefined;
  const start = index;
  let taken = 0;
  while (index < text.length) {
    const { size, step } = charAt(text, index);
    if (taken + size > limit) break;
    taken += size;
    index += step;
  }
  // A limit smaller than the first character addresses nothing; refuse rather
  // than answer an empty slice a caller would loop on forever.
  if (taken === 0) return undefined;
  const consumed = offset + taken;
  return {
    text: text.slice(start, index),
    offset,
    bytes: taken,
    ...(consumed < total ? { next: consumed } : {}),
    truncated: consumed < total,
    totalBytes: total,
    cursor: { byteOffset: consumed, charIndex: index },
  };
}

/** The same slice, without a cursor, for callers that read one range and stop. */
export function sliceUtf8Range(text: string, offset: number, limit: number): Utf8Slice | undefined {
  const sliced = sliceUtf8RangeFrom(text, offset, limit);
  if (!sliced) return undefined;
  const { cursor: _cursor, totalBytes: _total, ...slice } = sliced;
  return slice;
}

/**
 * What a bounded projection actually looked at and produced, so a test can
 * prove a twelve-megabyte structured result was never materialised as a
 * string. Counting only; nothing reads it to make a decision.
 */

