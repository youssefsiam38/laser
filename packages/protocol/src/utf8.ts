/**
 * UTF-8 windows that never split a character.
 *
 * Every `ref` in the panel contract is read in ranges, and every offset on the
 * wire — `from`, `bytes`, the follower's own bookkeeping — is a **byte**
 * offset. A ranged read therefore lands on arbitrary byte boundaries, and
 * decoding such a window directly produces U+FFFD at both seams: once per
 * append for a live tail, which is most of a build log's box-drawing, every
 * em-dash and every emoji.
 *
 * These two functions are the one implementation both sides use, so the host's
 * disk reads and the client's local refs cannot drift apart the way they did.
 */

const CONTINUATION = 0b1000_0000;
const CONTINUATION_MASK = 0b1100_0000;

/** How many bytes the sequence starting with this lead byte occupies, or 0 if it is not a lead byte. */
function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((byte & 0b1111_0000) === 0b1110_0000) return 3;
  if ((byte & 0b1111_1000) === 0b1111_0000) return 4;
  return 0;
}

/**
 * Trim a byte window back to whole UTF-8 characters.
 *
 * `atOffsetZero` says whether the window starts at byte 0 of the content: only
 * then is a leading continuation byte real data rather than the tail of a
 * character the previous window already carried.
 *
 * Returns offsets *within* `bytes`, so the caller adds them to its own start.
 */
export function alignUtf8(bytes: Uint8Array, atOffsetZero: boolean): { start: number; end: number } {
  let start = 0;
  if (!atOffsetZero) {
    // At most three continuation bytes can precede a lead byte.
    while (start < bytes.length && start < 4 && (bytes[start]! & CONTINUATION_MASK) === CONTINUATION) start++;
    if (start === 4) start = 0; // Not UTF-8 at all: leave it alone rather than eating data.
  }
  let end = bytes.length;
  // Walk back over at most three continuation bytes to the sequence's lead byte.
  let back = 0;
  while (end - 1 - back >= start && back < 4 && (bytes[end - 1 - back]! & CONTINUATION_MASK) === CONTINUATION) back++;
  const leadIndex = end - 1 - back;
  if (leadIndex >= start) {
    const needed = sequenceLength(bytes[leadIndex]!);
    // A complete sequence ends exactly at `end`; a short one is the next read's.
    if (needed > 0 && leadIndex + needed > end) end = leadIndex;
  }
  return { start, end: Math.max(start, end) };
}

/** UTF-8 length of a string in bytes. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The `[from, to)` **byte** window of `text`, decoded without a split
 * character. `from` comes back adjusted to the character boundary the window
 * actually starts at, which is what a follower adds its chunk length to.
 */
export function sliceUtf8(text: string, from: number, to: number): { from: number; chunk: string; bytes: number } {
  const encoded = new TextEncoder().encode(text);
  const start = Math.max(0, Math.min(from, encoded.length));
  const stop = Math.max(start, Math.min(to, encoded.length));
  const window = encoded.subarray(start, stop);
  const aligned = alignUtf8(window, start === 0);
  const decoder = new TextDecoder("utf-8");
  return {
    from: start + aligned.start,
    chunk: decoder.decode(window.subarray(aligned.start, aligned.end)),
    bytes: encoded.length,
  };
}
