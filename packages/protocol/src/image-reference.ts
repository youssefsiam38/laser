/**
 * Serving an image as a reference (M16-T89).
 *
 * The bytes of a picture never travel inside a message. One rule, applied
 * before anything is measured: whatever its size, whatever its role, whatever
 * its position, an `image` part is served with its payload removed and an
 * {@link ImagePartReference} beside it, and the payload is read back with
 * `session/entry_range` exactly as an elided body is. A page's size therefore
 * stops depending on what a person screenshotted — which is how a 27 MB
 * conversation stopped paging at all, at two `toolResult` screenshots of about
 * 2.4 MB that no page could carry.
 *
 * Everything here is pure apart from the caller's own digest function: this
 * package links no crypto, and the same functions run in the worker, in the
 * host and in a browser bundle, so the two authorities publish byte-identical
 * references for identical records.
 */

import { utf8ByteLength } from "./body-utf8.js";
import { imageHeaderSize } from "./image-header.js";
import type { BodyComponent } from "./body-range.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * One image, as every page serves it.
 *
 * It carries who the bytes belong to, the component `session/entry_range`
 * accepts for them, how many there are, what they hash to, and — when the bytes
 * themselves declare a size we can believe — how large the picture is, so a
 * reader can reserve its space before the first byte arrives.
 *
 * Additive by construction: the part keeps its `type` and `mimeType`, so a
 * reader that has never heard of this still draws a picture-shaped row.
 */
export interface ImagePartReference {
  /** The entry the bytes belong to; a range request echoes it. */
  entryId: string;
  /** Which body of that entry: `{ kind: "image", index }`. */
  component: BodyComponent;
  mimeType: string;
  /** Exact UTF-8 size of the base64 payload the component serves. */
  totalBytes: number;
  /** The producer's own digest of that whole payload. */
  contentDigest: string;
  /** Intrinsic size from the image's own header, when it declares a believable one. */
  width?: number;
  height?: number;
}

/**
 * The digest width both producers sign a body with: SHA-256 in hexadecimal.
 *
 * A reader that only has to *price* a record — the host's index, planning a
 * page it has not read — projects it with this in place of the real digest, so
 * it never hashes a picture to find out what serving one costs. The price is
 * exact for a 64-character digest and too large for a shorter one, never too
 * small; a producer that signed with something longer would have to change this
 * number, and `reference pricing` in the tests refuses to let the two drift.
 */
export const REFERENCE_DIGEST_HEX_LENGTH = 64;

const PLACEHOLDER_DIGEST = "0".repeat(REFERENCE_DIGEST_HEX_LENGTH);
const placeholderDigest = (): string => PLACEHOLDER_DIGEST;

/** The reference a served image part carries, when it is one. */
export function imagePartReference(part: unknown): ImagePartReference | undefined {
  const value = record(part).ref;
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  return typeof row.entryId === "string" && typeof row.totalBytes === "number" && Number.isSafeInteger(row.totalBytes)
    && record(row.component).kind === "image" && typeof row.mimeType === "string" && typeof row.contentDigest === "string"
    ? (value as ImagePartReference)
    : undefined;
}

/**
 * One page's worth of projected records.
 *
 * A page is planned by binary search, so the same rows are projected many times
 * and a picture would be hashed once per attempt. This holds the projections
 * for exactly as long as the **synchronous** call that created it: a record
 * cannot change underneath a cache that cannot outlive the page it was made
 * for, so a stale projection can never be served. It is deliberately not a
 * module-level memo — one of those returned the previous content of a record
 * that had been mutated since.
 */
export type ImageReferenceCache = WeakMap<object, unknown>;

export const createImageReferenceCache = (): ImageReferenceCache => new WeakMap<object, unknown>();

/**
 * One record as a page serves it: every `image` part turned into its
 * {@link ImagePartReference}.
 *
 * No threshold, no exception. A 4 KB avatar and a 2.4 MB screenshot take the
 * same path, in every role and at every position; M16-T88's record ceiling
 * stays behind this as a net for a record that is large for some other reason.
 *
 * Two records are left exactly as they are: one with no identity, because
 * nothing could read its bytes back, and one whose images are already
 * references, so projecting a page twice cannot lose what the first pass said.
 */
export function entryWithImageReferences(entry: unknown, digest: (text: string) => string, cache?: ImageReferenceCache): unknown {
  if (entry === null || typeof entry !== "object") return entry;
  const held = cache?.get(entry);
  if (held !== undefined) return held;
  const served = referencedRecord(entry as Record<string, unknown>, digest);
  cache?.set(entry, served);
  return served;
}

function referencedRecord(value: Record<string, unknown>, digest: (text: string) => string): unknown {
  // Without an entry id nothing could address the bytes, so they stay in the
  // record rather than becoming a reference nobody can read (RP-5b).
  const entryId = typeof value.id === "string" ? value.id : undefined;
  if (entryId === undefined) return value;
  if (value.type === "custom_message") {
    const content = referencedContent(value.content, entryId, digest);
    return content ? { ...value, content } : value;
  }
  if (value.type !== "message") return value;
  const message = record(value.message);
  const content = referencedContent(message.content, entryId, digest);
  return content ? { ...value, message: { ...message, content } } : value;
}

/** Whether this content array has a picture whose bytes still have to move. */
function carriesImageBytes(content: readonly unknown[]): boolean {
  for (const part of content) {
    const row = record(part);
    if (row.type === "image" && typeof row.data === "string" && imagePartReference(row) === undefined) return true;
  }
  return false;
}

/** The same content array with its images referenced, or undefined when it has none to move. */
function referencedContent(content: unknown, entryId: string, digest: (text: string) => string): unknown[] | undefined {
  if (!Array.isArray(content)) return undefined;
  // Looked at before anything is allocated: an ordinary record is every record
  // in an ordinary conversation, and pricing one is on the host's cold-scan
  // path, which walks every line of a stored conversation.
  if (!carriesImageBytes(content)) return undefined;
  let index = 0;
  let moved = false;
  const rows = content.map((part) => {
    const row = record(part);
    if (row.type !== "image" || typeof row.data !== "string") return part;
    const component: BodyComponent = { kind: "image", index: index++ };
    if (imagePartReference(row)) return part;
    moved = true;
    const totalBytes = utf8ByteLength(row.data);
    const size = imageHeaderSize(row.data, totalBytes);
    const ref: ImagePartReference = {
      entryId,
      component,
      mimeType: typeof row.mimeType === "string" ? row.mimeType : "",
      totalBytes,
      contentDigest: digest(row.data),
      ...(size ? { width: size.width, height: size.height } : {}),
    };
    return { ...row, data: "", ref };
  });
  return moved ? rows : undefined;
}

/**
 * The exact wire length of one record **as a page serves it**, without hashing
 * a byte of any picture in it.
 *
 * This is what the host's index stores so a page can be planned before it is
 * read. It is the same projection the page itself uses, with a placeholder
 * digest of the width both producers actually sign with, so the number is
 * exact rather than an allowance over two untrusted strings — an entry id and a
 * media type are copied verbatim out of a record and have no length anybody
 * declared. It also shares the projection's own id rule, so a record whose
 * images cannot be referenced at all (it has no `id`) is priced with its bytes
 * in it, as it will be sent.
 *
 * A planner that under-prices a row admits a page the exact check then refuses,
 * which is the failure this milestone exists to delete; this can only be exact
 * or too large, never too small.
 *
 * `measure` counts the UTF-8 bytes of the projected JSON. It is injectable for
 * one reason: the host prices **every line** of a conversation on a cold scan
 * and passes Node's own native counter, which this package cannot name.
 */
export function servedEntryWireBytes(entry: unknown, measure: (text: string) => number = utf8ByteLength): number {
  const served = entryWithImageReferences(entry, placeholderDigest);
  try {
    return measure(JSON.stringify(served) ?? "");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * An image part as a **body** carries it: its type and its media type, never
 * its bytes and never the reference around them.
 *
 * Idempotent, and that is the point. A structured `tool_result` holds the
 * result's own content parts, images included, so the text an authority serves
 * for that component and the text a client derives from the record it was
 * *given* have to be the same string — and one of those records holds the bytes
 * while the other holds a reference to them. Normalizing both to this form is
 * what keeps a range reply's `totalBytes` from contradicting the page that
 * named it.
 */
function bodyImagePart(part: Record<string, unknown>): Record<string, unknown> {
  const { data: _data, ref: _reference, ...rest } = part;
  // `data` last, whatever order it arrived in: the canonical text of this part
  // must not depend on how the record that carried it was written.
  return { ...rest, data: "" };
}

/** One content array with every image part in its body form; identity when it has none. */
export function bodyImageContent(content: readonly unknown[]): unknown[] {
  let images = false;
  const rows = content.map((part) => {
    const row = record(part);
    if (row.type !== "image" || typeof row.data !== "string") return part;
    images = true;
    return bodyImagePart(row);
  });
  return images ? rows : (content as unknown[]);
}

/**
 * The images one message carries, in its own content order — **whatever its
 * role**. A picture a tool answered with is as addressable as one a person
 * attached: it is the same kind of body, in the same component space, and a
 * page never carries its bytes at all, so the client reads them back through
 * `session/entry_range` (M16-T88, M16-T89).
 *
 * A part of some other type carrying bytes (a file, audio, something this
 * version has never seen) has no component of its own; it stays inside the
 * structured component that holds it — `tool_result` or `custom_details` —
 * which is addressable in exactly the same way. Nothing is ever unreachable
 * because of the part type it arrived as.
 *
 * `referenced` says the part in hand is the *served* form: it holds no bytes
 * and only says how many there are. Its size is still published, because that
 * is what a client needs to read it; its body is not readable **from this
 * record**, because this record does not have it.
 */
export function imageParts(content: unknown): Array<{ component: BodyComponent; value: string; totalBytes: number; referenced: boolean }> {
  if (!Array.isArray(content)) return [];
  const rows: Array<{ component: BodyComponent; value: string; totalBytes: number; referenced: boolean }> = [];
  let index = 0;
  for (const part of content) {
    const row = record(part);
    if (row.type !== "image" || typeof row.data !== "string") continue;
    const reference = imagePartReference(row);
    rows.push({
      component: { kind: "image", index: index++ },
      value: row.data,
      totalBytes: reference?.totalBytes ?? utf8ByteLength(row.data),
      referenced: reference !== undefined,
    });
  }
  return rows;
}
