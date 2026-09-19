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
import { IMAGE_HEADER_PROBE_BYTES, imageHeaderSize, type ImageContent } from "@lasercode/protocol";
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

/**
 * Decoded prefix we are willing to look at to find an image's dimensions.
 * The authority's own bound, re-exported rather than restated: the producer
 * publishes the size it read from that prefix, and a second opinion about how
 * much of a picture to look at is a second answer about how big it is.
 */
export const IMAGE_PROBE_BYTES = IMAGE_HEADER_PROBE_BYTES;

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
  /**
   * Decoded surface the images in this view imply — the ones it holds and the
   * ones it points at. Reported beside the budget, never folded into it: the
   * bytes live in the browser's own image memory, not in this view.
   */
  referencedImageBytes: number;
  /**
   * The largest single block — every body of it together, which is what one
   * message renders — and the largest single body inside any of them.
   */
  largestBlockBytes: number;
  largestBodyBytes: number;
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
  stubsBytes: 0, referencedBytes: 0, referencedImageBytes: 0, largestBlockBytes: 0, largestBodyBytes: 0,
});

const entryCache = new WeakMap<object, number>();
const blockCache = new WeakMap<object, { text: number; images: number; estimated: number; count: number; referenced: number; referencedImages: number; largestBody: number }>();
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
  const served = image.ref;
  const encoded = served ? served.totalBytes : Math.floor((image.data.length * 3) / 4);
  // The producer read the header once and published what it found. Parsing is
  // for an image this view holds the bytes of — a picture still streaming in,
  // which no page has served yet.
  const dimensions = served
    ? (served.width !== undefined && served.height !== undefined ? { width: served.width, height: served.height } : undefined)
    : imageDimensions(image.data);
  const measure: ImageMeasure = dimensions
    ? { encoded, decoded: dimensions.width * dimensions.height * 4, dimensions }
    : { encoded, decoded: undefined };
  imageCache.set(image, measure);
  return measure;
}

/**
 * Dimensions from a validated image header, or `undefined`. One parser, and it
 * is the authority's: `@lasercode/protocol`'s `imageHeaderSize` is what fills
 * an image reference's `width`/`height` on the wire, so a picture measured
 * here and the same picture measured there can never disagree (M16-T92).
 */
export function imageDimensions(base64: string): { width: number; height: number } | undefined {
  return imageHeaderSize(base64);
}

/**
 * The same dimensions, for an image already written as a `data:` URI — what a
 * rendered image part carries. Only the prefix the parser needs is copied out
 * of the URI, so asking a megabyte-long picture how big it is stays cheap, and
 * a URI that is not inline base64 image bytes (a blob or a remote URL) is
 * honestly unknown rather than guessed.
 */
export function dataUriImageDimensions(src: string): { width: number; height: number } | undefined {
  const comma = src.indexOf(",");
  if (comma < 0 || !/^data:image\/[^;,]+;base64$/i.test(src.slice(0, comma))) return undefined;
  return imageDimensions(src.slice(comma + 1, comma + 1 + Math.ceil(IMAGE_PROBE_BYTES / 3) * 4));
}

/** Bytes of one derived block, memoized. Image payloads are counted separately. */
function blockMeasure(block: Block): { text: number; images: number; estimated: number; count: number; referenced: number; referencedImages: number; largestBody: number } {
  const cached = blockCache.get(block);
  if (cached) return cached;
  work.blocks += 1;
  let text = 0;
  let images = 0;
  let estimated = 0;
  let count = 0;
  // Bytes this block points at and does not hold (RP-5b): reported, not retained.
  let referenced = 0;
  // The largest single body: what one *part* of a message renders, as opposed
  // to the whole row, which is every body of it together.
  let largestBody = 0;
  const body = (bytes: number): number => { largestBody = Math.max(largestBody, bytes); return bytes; };
  // Decoded surfaces the references imply: reported, never counted as retained.
  let referencedImages = 0;
  for (const ref of bodyRefsOf(block)) {
    referenced += omittedBytes(ref);
    if (ref.image) referencedImages += ref.image.decodedBytes;
  }
  switch (block.kind) {
    case "user": {
      work.bytes += block.text.length;
      text = body(byteLength(block.text));
      for (const file of block.files) text += body(byteLength(file.content)) + byteLength(file.name);
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
      text = body(byteLength(block.text)) + body(byteLength(block.thinking)) + byteLength(block.errorMessage ?? "");
      break;
    case "tool":
      text = byteLength(block.name) + body(jsonBytes(block.args)) + body(jsonBytes(block.result)) + body(byteLength(block.partial ?? ""));
      break;
    case "notice":
      text = body(byteLength(block.text));
      break;
    case "custom":
      text = body(byteLength(block.text)) + body(jsonBytes(block.details));
      break;
  }
  const measure = { text, images, estimated, count, referenced, referencedImages, largestBody };
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
export function entryStubBytes(stub: EntryStub): number {
  let bytes = byteLength(stub.id) + byteLength(stub.parentId ?? "") + byteLength(stub.type)
    + byteLength(stub.role ?? "") + byteLength(stub.toolCallId ?? "") + byteLength(stub.at ?? "");
  for (const body of stub.bodies) {
    bytes += byteLength(body.component.kind) + 16 + byteLength(body.contentDigest ?? "");
    if (body.text !== undefined) bytes += byteLength(body.text);
  }
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
  let largestBodyBytes = 0;
  let referencedBytes = 0;
  let referencedImageBytes = 0;
  for (const block of view.blocks) {
    const measure = blockMeasure(block);
    blocksBytes += measure.text;
    imagesBytes += measure.images;
    imagesEstimated += measure.estimated;
    images += measure.count;
    largestBlockBytes = Math.max(largestBlockBytes, measure.text + measure.images);
    largestBodyBytes = Math.max(largestBodyBytes, measure.largestBody);
    referencedBytes += measure.referenced;
    referencedImageBytes += measure.referencedImages;
  }
  for (const entry of view.history?.context ?? []) entriesBytes += entryBytes(entry);
  // A stub normally holds pointers; complete retained prompt prose is charged
  // exactly here and is not also described as referenced/absent.
  let stubsBytes = 0;
  for (const stub of view.stubs ?? []) {
    stubsBytes += entryStubBytes(stub);
    for (const body of stub.bodies) if (body.text === undefined) referencedBytes += body.totalBytes;
  }
  return { entriesBytes, blocksBytes, imagesBytes, imagesEstimated, images, stubsBytes, referencedBytes, referencedImageBytes, largestBlockBytes, largestBodyBytes,
    bytes: entriesBytes + blocksBytes + imagesBytes + stubsBytes };
}
