/**
 * The intrinsic size an image's own header declares (M16-T89).
 *
 * A page never carries a picture's bytes: an `image` part travels as a
 * reference, and its bytes are read back with `session/entry_range` exactly as
 * an elided body is. A reader that knows nothing about the picture cannot
 * reserve the space it will occupy, so the reference carries the size the
 * bytes themselves declare — read here, from a bounded prefix of the payload.
 *
 * Two rules:
 *
 * 1. **Only a validated header.** PNG, JPEG, GIF and WebP are recognised. A
 *    format this does not know — an SVG, a truncated payload, something newer —
 *    has no dimensions rather than guessed ones, and the reference simply omits
 *    them.
 * 2. **Only the header.** At most {@link IMAGE_HEADER_PROBE_BYTES} of the
 *    payload is decoded, so asking a 2.4 MB screenshot how large it is costs a
 *    few kilobytes, not a copy of it.
 * 3. **Only a size the bytes could carry.** A header is untrusted data
 *    (AGENTS.md invariant 9): a three-hundred-byte payload declaring
 *    65,536 × 65,536 is a lie, and a reader that believed it would reserve a
 *    seventeen-gigabyte surface for it. A size that could not be encoded in the
 *    payload's own length is omitted, exactly like a format we do not know.
 *
 * Pure: no DOM, no Node, no allocation proportional to the image. This is the
 * **one** implementation — the worker, the host and the browser all call it, so
 * the two authorities and the renderer cannot answer differently for one set of
 * bytes.
 */

/** Decoded prefix this is willing to look at to find an image's dimensions. */
export const IMAGE_HEADER_PROBE_BYTES = 4 * 1024;

/** JPEG segments walked before the probe gives up. */
const PROBE_MAX_SEGMENTS = 16;

/** A side outside this is not a picture we measured; it is noise. */
const MAX_SIDE = 1 << 16;

/**
 * The most pixels one encoded byte can plausibly carry.
 *
 * Deflate cannot expand by more than 1032:1, a PNG scanline carries at least one
 * bit per pixel, and base64 packs three bytes into four characters: about 6,200
 * pixels per encoded character is therefore the ceiling for the most compressible
 * real image, and the same order of magnitude holds for GIF's LZW and WebP's
 * lossless coder. Eight thousand is that, rounded up, so nothing a person could
 * actually screenshot is refused. An image that genuinely compresses better than
 * this loses only its *declared size* — never its bytes, which are read back in
 * full either way.
 */
const MAX_PIXELS_PER_ENCODED_BYTE = 8 * 1024;

export interface ImageHeaderSize {
  width: number;
  height: number;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64.length; index++) table[BASE64.charCodeAt(index)] = index;
  // The URL-safe alphabet decodes to the same bytes.
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

/**
 * Decode at most {@link IMAGE_HEADER_PROBE_BYTES} of a base64 payload.
 *
 * Four base64 characters carry three bytes, so a prefix decodes on its own
 * without touching the rest of the payload. Decoded by hand rather than through
 * `atob`/`Buffer`, because this module is shared by a browser bundle, the host
 * and the worker and must mean the same thing in all three — and that includes
 * `atob`'s own forgiving rule: **ASCII whitespace is not data**. A payload
 * written in wrapped lines is the same picture as one written on a single line,
 * and before this it measured in the browser and not in the reference an
 * authority published. Anything else outside the alphabet stops the decode:
 * what was read before it is still a valid prefix of the header.
 *
 * Bounded twice over, so whitespace cannot turn a bounded probe into a scan:
 * at most {@link IMAGE_HEADER_PROBE_BYTES} are produced, and at most twice as
 * many characters are looked at to produce them.
 */
function probePrefix(base64: string): Uint8Array | undefined {
  const wanted = Math.ceil(IMAGE_HEADER_PROBE_BYTES / 3) * 4;
  const scanned = Math.min(base64.length, wanted * 2);
  const bytes = new Uint8Array(Math.ceil(wanted / 4) * 3);
  let out = 0;
  let word = 0;
  let digits = 0;
  for (let index = 0; index < scanned; index++) {
    const code = base64.charCodeAt(index);
    // Space, tab, line feed, form feed, carriage return: skipped, as `atob` does.
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) continue;
    const value = code < 128 ? REVERSE[code]! : -1;
    // Padding or anything unexpected: stop at the last whole group.
    if (value < 0) break;
    word = (word << 6) | value;
    if (++digits < 4) continue;
    bytes[out++] = (word >>> 16) & 0xff;
    bytes[out++] = (word >>> 8) & 0xff;
    bytes[out++] = word & 0xff;
    word = 0;
    digits = 0;
    if (out >= bytes.length) break;
  }
  return out > 0 ? bytes.subarray(0, out) : undefined;
}

const valid = (width: number, height: number): ImageHeaderSize | undefined =>
  Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE
    ? { width, height }
    : undefined;

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0);
const u24le = (b: Uint8Array, at: number): number => ((b[at + 2] ?? 0) << 16) | ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0);
const u32be = (b: Uint8Array, at: number): number =>
  (((b[at] ?? 0) << 24) >>> 0) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  for (let index = 0; index < text.length; index++) if (b[at + index] !== text.charCodeAt(index)) return false;
  return true;
};

/**
 * The size a base64 image payload's header declares, or `undefined` when this
 * recognises no header in it or the size it declares could not be true.
 *
 * `encodedBytes` is the payload's own length, for the plausibility bound; pass
 * it when it is already known, and it is read from the string otherwise.
 */
export function imageHeaderSize(base64: string, encodedBytes = base64.length): ImageHeaderSize | undefined {
  const declared = declaredHeaderSize(base64);
  if (!declared) return undefined;
  // A header is untrusted data: a size that its own payload could not possibly
  // encode is a claim, not a measurement, and it is refused here rather than
  // reserved for by a reader downstream.
  return declared.width * declared.height <= Math.max(1, encodedBytes) * MAX_PIXELS_PER_ENCODED_BYTE ? declared : undefined;
}

function declaredHeaderSize(base64: string): ImageHeaderSize | undefined {
  const bytes = probePrefix(base64);
  if (!bytes || bytes.length < 16) return undefined;
  // PNG: the signature, then IHDR's first eight bytes.
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG") && ascii(bytes, 12, "IHDR")) return valid(u32be(bytes, 16), u32be(bytes, 20));
  // GIF: the logical screen descriptor follows the six-byte signature.
  if (ascii(bytes, 0, "GIF8")) return valid(u16le(bytes, 6), u16le(bytes, 8));
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpSize(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return undefined;
}

function webpSize(bytes: Uint8Array): ImageHeaderSize | undefined {
  if (ascii(bytes, 12, "VP8X")) return valid(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  if (ascii(bytes, 12, "VP8L")) {
    // VP8L packs 14-bit width-1 and height-1, little-endian, after the 0x2f tag.
    if (bytes[20] !== 0x2f) return undefined;
    const packed = (((bytes[24] ?? 0) << 24) | ((bytes[23] ?? 0) << 16) | ((bytes[22] ?? 0) << 8) | (bytes[21] ?? 0)) >>> 0;
    return valid((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (ascii(bytes, 12, "VP8 ")) return valid(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  return undefined;
}

function jpegSize(bytes: Uint8Array): ImageHeaderSize | undefined {
  let at = 2;
  for (let segment = 0; segment < PROBE_MAX_SEGMENTS; segment++) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    const length = u16be(bytes, at + 2);
    if (length < 2) return undefined;
    // SOF0..SOF15, minus the four markers that are not frame headers.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) return undefined;
      return valid(u16be(bytes, at + 7), u16be(bytes, at + 5));
    }
    at += 2 + length;
  }
  return undefined;
}
