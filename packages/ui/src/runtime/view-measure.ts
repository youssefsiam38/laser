/**
 * What one session view's loaded transcript costs (RP-5).
 *
 * Three rules, and they are the reason this file exists rather than a
 * `JSON.stringify(...).length` at the call site:
 *
 * 1. **Exact UTF-8 bytes.** `String.length` counts UTF-16 code units, and a
 *    transcript is full of text that is not ASCII. Every number here is what a
 *    `TextEncoder` would write.
 * 2. **Measured once per object.** Entries, blocks and images keep their
 *    identity across a streamed turn (the store replaces only what a delta
 *    touched), so a measurement is cached against the object itself and a
 *    token costs the delta, never the transcript.
 * 3. **A number we cannot read is unavailable, never zero.** An image whose
 *    dimensions cannot be validated from a bounded prefix of its own bytes is
 *    counted as estimated and charged a declared floor — it is never reported
 *    as costing nothing.
 *
 * Bytes are an estimate of *serialized* size. They are not memory: the budget
 * that uses them is calibrated against measured heap (`docs/resource-view-budget.md`).
 *
 * Pure: no React, no DOM, no network.
 */
import type { ImageContent } from "@lasercode/protocol";
import type { Block, SessionView } from "../store.js";
import { omittedBytes, type BodyRef } from "./body-excerpt.js";
import type { EntryStub } from "./retained-entries.js";

/**
 * Exact UTF-8 byte length, counted rather than produced.
 *
 * `TextEncoder.encode` allocates a buffer as large as the string it measures,
 * and this measures transcripts: a megabyte of Markdown would cost a megabyte
 * of garbage to find out how big it is. The arithmetic below is the same
 * answer with no allocation at all, including for the two cases a naive
 * version gets wrong — a surrogate pair is one four-byte character, and an
 * unpaired surrogate is the three-byte replacement character, which is exactly
 * what `TextEncoder` writes.
 */
export function byteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * What measuring has actually done, for the tests that pin its cost. Counting
 * only; nothing reads it to make a decision.
 */
const work = { views: 0, blocks: 0, entries: 0, bytes: 0 };

export interface MeasurementWork {
  /** Whole views walked. */
  readonly views: number;
  /** Blocks measured for the first time. */
  readonly blocks: number;
  /** Entries measured for the first time. */
  readonly entries: number;
  /** Characters of content actually looked at. */
  readonly bytes: number;
}

export const measurementWork = (): MeasurementWork => ({ ...work });
export const resetMeasurementWork = (): void => { work.views = 0; work.blocks = 0; work.entries = 0; work.bytes = 0; };

const jsonBytes = (value: unknown): number => {
  if (value === undefined) return 0;
  if (typeof value === "string") { work.bytes += value.length; return byteLength(value); }
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) work.bytes += text.length;
    return text === undefined ? 0 : byteLength(text);
  } catch {
    // A value that cannot be serialized is still retained; charge its shape.
    return UNSERIALIZABLE_BYTES;
  }
};

/** What an unserializable retained value is charged. Declared, not guessed at zero. */
export const UNSERIALIZABLE_BYTES = 1024;

/**
 * Decoded bytes charged for an image whose real dimensions could not be read
 * (an SVG, a truncated payload, a format with no bounded header we validate).
 * A 512×512 RGBA surface: small enough not to dominate, large enough that such
 * an image is never free.
 */
export const UNKNOWN_IMAGE_DECODED_BYTES = 512 * 512 * 4;

/** Decoded prefix we are willing to look at to find an image's dimensions. */
export const IMAGE_PROBE_BYTES = 4 * 1024;
/** JPEG segments walked before the probe gives up. */
const IMAGE_PROBE_MAX_SEGMENTS = 16;
/** Dimensions outside this are not an image we measured; they are noise. */
const IMAGE_MAX_SIDE = 1 << 16;

export interface ImageMeasure {
  /** Exact bytes of the encoded payload. */
  encoded: number;
  /** `width × height × 4`, or `undefined` when no header could be validated. */
  decoded: number | undefined;
  dimensions?: { width: number; height: number } | undefined;
}

export interface ViewMeasure {
  /** Metadata of records this view points at rather than holds (RP-5b). */
  stubsBytes: number;
  /** Canonical bytes this view points at and does not hold. Never retained. */
  referencedBytes: number;
  /** The largest single block, for the counters that say what dominates. */
  largestBlockBytes: number;
  /** Raw Pi entries, as JSON. Carries encoded image payloads once. */
  entriesBytes: number;
  /** Derived blocks: prose, reasoning, tool arguments and results. No image payloads. */
  blocksBytes: number;
  /** Retained images: encoded payload plus the decoded surface they keep alive. */
  imagesBytes: number;
  /** Images counted at the declared floor because their size could not be read. */
  imagesEstimated: number;
  images: number;
  /** The budgeted total. */
  bytes: number;
}

export const EMPTY_MEASURE: ViewMeasure = Object.freeze({
  entriesBytes: 0, blocksBytes: 0, imagesBytes: 0, imagesEstimated: 0, images: 0, bytes: 0,
  stubsBytes: 0, referencedBytes: 0, largestBlockBytes: 0,
});

const entryCache = new WeakMap<object, number>();
const blockCache = new WeakMap<object, { text: number; images: number; estimated: number; count: number; referenced: number }>();
const imageCache = new WeakMap<object, ImageMeasure>();

/** Bytes of one raw entry, memoized against the entry object itself. */
export function entryBytes(entry: unknown): number {
  if (!entry || typeof entry !== "object") return jsonBytes(entry);
  const cached = entryCache.get(entry as object);
  if (cached !== undefined) return cached;
  work.entries += 1;
  const bytes = jsonBytes(entry);
  entryCache.set(entry as object, bytes);
  return bytes;
}

/**
 * The decoded size of one image, from a bounded prefix of its own retained
 * bytes. Nothing is decoded into an `Image`, a `Blob` or an `ImageBitmap`, and
 * at most {@link IMAGE_PROBE_BYTES} of the payload is base64-decoded.
 */
export function imageMeasure(image: ImageContent): ImageMeasure {
  const cached = imageCache.get(image);
  if (cached) return cached;
  const encoded = Math.floor((image.data.length * 3) / 4);
  const dimensions = imageDimensions(image.data);
  const measure: ImageMeasure = dimensions
    ? { encoded, decoded: dimensions.width * dimensions.height * 4, dimensions }
    : { encoded, decoded: undefined };
  imageCache.set(image, measure);
  return measure;
}

/** Decode at most {@link IMAGE_PROBE_BYTES} of a base64 payload. */
function probePrefix(data: string): Uint8Array | undefined {
  // 4 base64 characters carry 3 bytes, so a prefix cut on a 4-character
  // boundary decodes on its own without touching the rest of the payload.
  const chars = Math.min(data.length - (data.length % 4), Math.ceil(IMAGE_PROBE_BYTES / 3) * 4);
  if (chars <= 0) return undefined;
  try {
    const binary = atob(data.slice(0, chars));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

const valid = (width: number, height: number): { width: number; height: number } | undefined =>
  width > 0 && height > 0 && width <= IMAGE_MAX_SIDE && height <= IMAGE_MAX_SIDE ? { width, height } : undefined;

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0);
const u24le = (b: Uint8Array, at: number): number => ((b[at + 2] ?? 0) << 16) | ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0);
const u32be = (b: Uint8Array, at: number): number =>
  (((b[at] ?? 0) << 24) >>> 0) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/**
 * Dimensions from a validated image header, or `undefined`. PNG, GIF, WebP and
 * JPEG only: a format whose header this does not know is honestly unknown
 * rather than guessed.
 */
export function imageDimensions(base64: string): { width: number; height: number } | undefined {
  const bytes = probePrefix(base64);
  if (!bytes || bytes.length < 16) return undefined;
  // PNG: signature, then the IHDR chunk carries the size in its first 8 bytes.
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG") && ascii(bytes, 12, "IHDR")) {
    return valid(u32be(bytes, 16), u32be(bytes, 20));
  }
  // GIF: the logical screen descriptor follows the six-byte signature.
  if (ascii(bytes, 0, "GIF8")) return valid(u16le(bytes, 6), u16le(bytes, 8));
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpDimensions(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  return undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (ascii(bytes, 12, "VP8X")) return valid(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  if (ascii(bytes, 12, "VP8L")) {
    // VP8L packs 14-bit width-1 and height-1 little-endian after the 0x2f tag.
    if (bytes[20] !== 0x2f) return undefined;
    const packed = (((bytes[24] ?? 0) << 24) | ((bytes[23] ?? 0) << 16) | ((bytes[22] ?? 0) << 8) | (bytes[21] ?? 0)) >>> 0;
    return valid((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (ascii(bytes, 12, "VP8 ")) return valid(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let at = 2;
  for (let segment = 0; segment < IMAGE_PROBE_MAX_SEGMENTS; segment++) {
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

/** Bytes of one derived block, memoized. Image payloads are counted separately. */
function blockMeasure(block: Block): { text: number; images: number; estimated: number; count: number; referenced: number } {
  const cached = blockCache.get(block);
  if (cached) return cached;
  work.blocks += 1;
  let text = 0;
  let images = 0;
  let estimated = 0;
  let count = 0;
  // Bytes this block points at and does not hold (RP-5b): reported, not retained.
  let referenced = 0;
  for (const ref of bodyRefsOf(block)) referenced += omittedBytes(ref);
  switch (block.kind) {
    case "user": {
      work.bytes += block.text.length;
      text = byteLength(block.text);
      for (const file of block.files) text += byteLength(file.content) + byteLength(file.name);
      for (const image of block.images) {
        count += 1;
        // An image this view only points at costs nothing here: its bytes are
        // counted as referenced, and the transcript reads them on demand.
        if (image.data === "") continue;
        const measure = imageMeasure(image);
        images += measure.encoded + (measure.decoded ?? UNKNOWN_IMAGE_DECODED_BYTES);
        if (measure.decoded === undefined) estimated += 1;
      }
      break;
    }
    case "assistant":
      work.bytes += block.text.length + block.thinking.length;
      text = byteLength(block.text) + byteLength(block.thinking) + byteLength(block.errorMessage ?? "");
      break;
    case "tool":
      text = byteLength(block.name) + jsonBytes(block.args) + jsonBytes(block.result) + byteLength(block.partial ?? "");
      break;
    case "notice":
      text = byteLength(block.text);
      break;
    case "custom":
      text = byteLength(block.text) + jsonBytes(block.details);
      break;
  }
  const measure = { text, images, estimated, count, referenced };
  blockCache.set(block, measure);
  return measure;
}

/** Exact retained bytes of one block, memoized like every other measurement. */
export function blockBytes(block: Block): number {
  const measure = blockMeasure(block);
  return measure.text + measure.images;
}

/** Every reference this block carries, in no particular order. */
function bodyRefsOf(block: Block): BodyRef[] {
  const bodies = "bodies" in block ? block.bodies : undefined;
  if (!bodies) return [];
  const rows: BodyRef[] = [];
  for (const value of Object.values(bodies)) {
    if (Array.isArray(value)) { for (const row of value) if (row) rows.push(row); }
    else if (value) rows.push(value);
  }
  return rows;
}

/**
 * What one pointer costs to hold: its identity, its place in the tree and one
 * small row per body. Counted exactly, like everything else here.
 */
function stubBytes(stub: EntryStub): number {
  let bytes = byteLength(stub.id) + byteLength(stub.parentId ?? "") + byteLength(stub.type)
    + byteLength(stub.role ?? "") + byteLength(stub.toolCallId ?? "") + byteLength(stub.at ?? "");
  for (const body of stub.bodies) bytes += byteLength(body.component.kind) + 16 + byteLength(body.contentDigest ?? "");
  return bytes;
}

/**
 * What this view's loaded transcript costs right now. O(entries + blocks) of
 * memoized lookups: a settled row is measured once for as long as it lives.
 */
export function measureView(view: SessionView): ViewMeasure {
  work.views += 1;
  let entriesBytes = 0;
  for (const entry of view.entries) entriesBytes += entryBytes(entry);
  let blocksBytes = 0;
  let imagesBytes = 0;
  let imagesEstimated = 0;
  let images = 0;
  let largestBlockBytes = 0;
  let referencedBytes = 0;
  for (const block of view.blocks) {
    const measure = blockMeasure(block);
    blocksBytes += measure.text;
    imagesBytes += measure.images;
    imagesEstimated += measure.estimated;
    images += measure.count;
    largestBlockBytes = Math.max(largestBlockBytes, measure.text + measure.images);
    referencedBytes += measure.referenced;
  }
  for (const entry of view.history?.context ?? []) entriesBytes += entryBytes(entry);
  // What a pointer costs: identity and one row per body, never a body.
  let stubsBytes = 0;
  for (const stub of view.stubs ?? []) {
    stubsBytes += stubBytes(stub);
    for (const body of stub.bodies) referencedBytes += body.totalBytes;
  }
  return { entriesBytes, blocksBytes, imagesBytes, imagesEstimated, images, stubsBytes, referencedBytes, largestBlockBytes,
    bytes: entriesBytes + blocksBytes + imagesBytes + stubsBytes };
}
