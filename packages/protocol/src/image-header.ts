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
 *
 * Pure: no DOM, no Node, no allocation proportional to the image. The same
 * function runs in the worker and in the host, so the two authorities publish
 * identical dimensions for identical bytes.
 */

/** Decoded prefix this is willing to look at to find an image's dimensions. */
export const IMAGE_HEADER_PROBE_BYTES = 4 * 1024;

/** JPEG segments walked before the probe gives up. */
const PROBE_MAX_SEGMENTS = 16;

/** A side outside this is not a picture we measured; it is noise. */
const MAX_SIDE = 1 << 16;

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
 * Four base64 characters carry three bytes, so a prefix cut on a four-character
 * boundary decodes on its own without touching the rest of the payload. Decoded
 * by hand rather than through `atob`/`Buffer`, because this module is shared by
 * a browser bundle, the host and the worker and must mean the same thing in all
 * three. A character outside the alphabet stops the decode: what was read
 * before it is still a valid prefix of the header.
 */
function probePrefix(base64: string): Uint8Array | undefined {
  const quads = Math.min(Math.floor(base64.length / 4), Math.ceil(IMAGE_HEADER_PROBE_BYTES / 3));
  if (quads <= 0) return undefined;
  const bytes = new Uint8Array(quads * 3);
  let out = 0;
  for (let quad = 0; quad < quads; quad++) {
    const at = quad * 4;
    let word = 0;
    for (let digit = 0; digit < 4; digit++) {
      const code = base64.charCodeAt(at + digit);
      const value = code < 128 ? REVERSE[code]! : -1;
      // Padding or anything unexpected: stop at the last whole group.
      if (value < 0) return out > 0 ? bytes.subarray(0, out) : undefined;
      word = (word << 6) | value;
    }
    bytes[out++] = (word >>> 16) & 0xff;
    bytes[out++] = (word >>> 8) & 0xff;
    bytes[out++] = word & 0xff;
  }
  return bytes.subarray(0, out);
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
 * recognises no header in it.
 */
export function imageHeaderSize(base64: string): ImageHeaderSize | undefined {
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
