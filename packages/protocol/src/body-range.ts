/**
 * Addressing one body inside one canonical entry (RP-5b).
 *
 * A renderer holds a bounded excerpt of a large body and a reference to where
 * the rest of it lives. This module is the one place that says what "one body"
 * is: a **component** of an entry — its prose, its reasoning, a tool call's
 * arguments, a tool result, a custom payload, one image — named the same way
 * by the producer that serves it, by the search projection that indexes it and
 * by the surface that shows it. One projection, so a byte offset means the
 * same thing everywhere (docs/search-content.md).
 *
 * Nothing here reads a file, a path or an index. A component is addressed by
 * (session, revision, entry id, component), never by a byte offset into
 * storage: how a conversation is stored is not part of this contract (RP-9).
 *
 * Attachments are deliberately not a component of their own: the composer
 * writes them inside the prompt's own text, so an attachment is a *region* of
 * `user_text` and is addressed with {@link BodyRegion}.
 */

/** Every body a client may address. Closed: an unknown name is refused. */
export const BODY_COMPONENT_KINDS = [
  "user_text",
  "assistant_text",
  "reasoning",
  "tool_args",
  "tool_result",
  "tool_partial",
  "custom_details",
  "image",
] as const;

export type BodyComponentKind = (typeof BODY_COMPONENT_KINDS)[number];

export interface BodyComponent {
  kind: BodyComponentKind;
  /** Which one, for a component an entry can carry more than once. */
  index?: number;
}

/** A slice of one component: how an attachment inside a prompt is addressed. */
export interface BodyRegion {
  offset: number;
  bytes: number;
}

/**
 * One attachment inside a prompt, as the authority found it.
 *
 * Offsets are absolute in the component's own byte space — the same space the
 * excerpt and every range read use — so nothing is ever rebased silently.
 */
export interface AttachmentRegion {
  /**
   * Where the attachment's **stored** payload begins, in the component's own
   * bytes — the escaped form as it sits in the record, because that is the
   * space `session/entry_range` addresses. A reader reconstructs exactly this
   * range, checks it against `contentDigest`, and unescapes it afterwards.
   */
  offset: number;
  /** How many stored (escaped) bytes that payload takes. */
  bytes: number;
  name: string;
  mediaType: string;
  /** SHA-256 of the **stored** region bytes, not of the decoded file. */
  contentDigest: string;
  nameTruncated?: true;
  mediaTypeTruncated?: true;
}

/**
 * What one component's attachments look like, bounded.
 *
 * `omitted` is exact: the scan saw those wrappers and did not describe them.
 * `truncated` means the scan could not see the whole component, and then **no
 * count is claimed** — a surface says "more attachments" without a number
 * rather than one it cannot stand behind.
 */
export interface AttachmentRegions {
  items: AttachmentRegion[];
  omitted?: number;
  truncated?: true;
  scannedBytes: number;
  /** Where a next page of metadata would start, in component bytes. */
  next?: number;
}

/**
 * How far a scan for attachments will look into one component.
 *
 * The durable authority cannot hold a record larger than its own line ceiling,
 * so a scan that completes within this has seen the whole component and the
 * count it reports is exact. The host asserts its shipped line bound against
 * this value; the protocol never imports the host.
 */
export const BODY_REGION_SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** How many attachments one answer describes. */
export const BODY_REGION_MAX_ITEMS = 64;

/** How many UTF-8 bytes of attachment metadata one answer may carry. */
export const BODY_REGION_METADATA_MAX_BYTES = 16 * 1024;

/** The longest name and media type a region describes before it is cut. */
const REGION_NAME_MAX_BYTES = 256;
const REGION_MEDIA_TYPE_MAX_BYTES = 128;

/**
 * The canonical attachment wrapper, recognised here exactly as the composer
 * writes it and the prompt reader takes it apart — same opener, same attribute
 * escaping, same blank-line separators, same closing tag. This module does not
 * import that code (nothing above the worker may), so the two are kept in step
 * by their tests, not by a shared import.
 */
const OPENER = '<attached-file name="';
const CLOSER = "\n</attached-file>";

/** The largest attachment the composer will accept, mirrored here. */
export const ATTACHMENT_MAX_BYTES = 256 * 1024;

/**
 * The most stored characters an attachment's escaped payload can take: every
 * character of a 256 KiB file could be escaped to six (`&quot;`), and a single
 * byte is at least one character.
 */
const MAX_PAYLOAD_CHARS = ATTACHMENT_MAX_BYTES * 6;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#10": "\n", "#13": "\r", "#9": "\t" };

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const escapeAttribute = (text: string): string =>
  escapeText(text).replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");
const unescapeText = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|#10|#13|#9);/g, (_, entity: string) => ENTITIES[entity]!);

/** Bytes between two character positions, counted without copying either. */
function utf8BytesBetween(text: string, fromChar: number, toChar: number): number {
  let bytes = 0;
  for (let index = fromChar; index < toChar; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < toChar) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Find the attachments inside one component's text, bounded in what it
 * describes and in how far it looks.
 *
 * Only a **complete canonical wrapper** counts: the opener at the start of the
 * component or after a blank line, attributes that survive a re-encode
 * unchanged, the closing tag, a blank line or the end after it, a payload with
 * no NUL whose entities are the ones this format defines, and a decoded size
 * that is exactly the size the wrapper declares. Anything else is prose that
 * happens to look like markup, and naming it would point a reader at bytes that
 * are not a file.
 *
 * **What a region addresses**: the **stored, escaped payload** — the bytes as
 * they are in the component, because that is the space `session/entry_range`
 * addresses and digests. A reader reconstructs that exact range, verifies it
 * against `contentDigest`, and only then unescapes it into the file's own text.
 *
 * Bounded work: one forward pass, `indexOf` rather than a regular expression
 * over the whole component, no second copy of it, and per-candidate work capped
 * by the largest attachment the composer accepts.
 */
export function attachmentRegions(
  text: string,
  createHasher: () => { update(chunk: string): void; digest(): string },
  options: { from?: number; maxItems?: number; maxBytes?: number; scanBytes?: number } = {},
): AttachmentRegions {
  const maxItems = Math.max(1, Math.min(options.maxItems ?? BODY_REGION_MAX_ITEMS, BODY_REGION_MAX_ITEMS));
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? BODY_REGION_METADATA_MAX_BYTES, BODY_REGION_METADATA_MAX_BYTES));
  const scanBytes = Math.min(options.scanBytes ?? BODY_REGION_SCAN_MAX_BYTES, BODY_REGION_SCAN_MAX_BYTES);
  const from = safeOffset(options.from) ?? 0;
  const items: AttachmentRegion[] = [];
  let omitted = 0;
  let metadata = 0;
  let next: number | undefined;
  let truncated: true | undefined;
  // One forward pass, counting bytes as it goes: no copy of the component and
  // no regular expression over it.
  let charPos = 0;
  let bytePos = 0;
  for (;;) {
    const at = text.indexOf(OPENER, charPos);
    if (at < 0) {
      if (utf8BytesBetween(text, charPos, text.length) + bytePos > scanBytes) truncated = true;
      break;
    }
    bytePos += utf8BytesBetween(text, charPos, at);
    charPos = at;
    if (bytePos > scanBytes) { truncated = true; break; }
    // A wrapper begins the component or follows a blank line; anything else is
    // prose that mentions the markup.
    const separated = at === 0 || (at >= 2 && text.charCodeAt(at - 1) === 10 && text.charCodeAt(at - 2) === 10);
    const found = separated ? readWrapper(text, at) : undefined;
    const candidate = found === "incomplete" ? undefined : found;
    if (!candidate) {
      // Move one character on, counting its bytes, and keep looking.
      bytePos += utf8BytesBetween(text, at, at + 1);
      charPos = at + 1;
      continue;
    }
    const contentStart = bytePos + utf8BytesBetween(text, at, candidate.payloadFrom);
    const storedBytes = utf8BytesBetween(text, candidate.payloadFrom, candidate.payloadTo);
    // Where the scan continues, in both spaces, whatever this candidate costs.
    const afterBytes = contentStart + storedBytes + utf8BytesBetween(text, candidate.payloadTo, candidate.end);
    if (contentStart >= from) {
      if (items.length >= maxItems) {
        next ??= contentStart;
        omitted += 1;
      } else {
        const name = boundedField(candidate.name, REGION_NAME_MAX_BYTES);
        const mediaType = boundedField(candidate.mediaType, REGION_MEDIA_TYPE_MAX_BYTES);
        const hasher = createHasher();
        hasher.update(candidate.payload);
        const region: AttachmentRegion = {
          offset: contentStart,
          bytes: storedBytes,
          name: name.text,
          mediaType: mediaType.text,
          contentDigest: hasher.digest(),
          ...(name.cut ? { nameTruncated: true as const } : {}),
          ...(mediaType.cut ? { mediaTypeTruncated: true as const } : {}),
        };
        const cost = utf8ByteLength(JSON.stringify(region));
        if (metadata + cost > maxBytes) { next ??= contentStart; omitted += 1; }
        else { metadata += cost; items.push(region); }
      }
    }
    bytePos = afterBytes;
    charPos = candidate.end;
    if (bytePos > scanBytes) { truncated = true; break; }
  }
  return {
    items,
    ...(truncated ? { truncated: true as const } : omitted > 0 ? { omitted } : {}),
    ...(next !== undefined ? { next } : {}),
    scannedBytes: Math.min(bytePos, scanBytes),
  };
}

/**
 * The same recogniser, fed a component a piece at a time (RP-5b §2).
 *
 * An authority that does not know about attachment regions cannot be asked for
 * them, so a reader streams the parent body through ordinary range replies and
 * finds the wrappers itself — with the **same** semantics as
 * {@link attachmentRegions}, because it is the same recogniser: this holds only
 * a bounded carry (a candidate wrapper, capped at what the composer accepts)
 * and never the parent.
 */
export function createAttachmentScanner(
  createHasher: () => { update(chunk: string): void; digest(): string },
  options: { maxItems?: number; maxBytes?: number; from?: number } = {},
): { push(chunk: string): void; end(): AttachmentRegions } {
  const maxItems = Math.max(1, Math.min(options.maxItems ?? BODY_REGION_MAX_ITEMS, BODY_REGION_MAX_ITEMS));
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? BODY_REGION_METADATA_MAX_BYTES, BODY_REGION_METADATA_MAX_BYTES));
  const from = safeOffset(options.from) ?? 0;
  const items: AttachmentRegion[] = [];
  let omitted = 0;
  let metadata = 0;
  let next: number | undefined;
  // What has been seen but not yet resolved: at most one candidate wrapper.
  let carry = "";
  let carryOffset = 0;
  let scanned = 0;

  const drain = (final: boolean): void => {
    for (;;) {
      const at = carry.indexOf(OPENER);
      if (at < 0) {
        // Keep only enough to recognise an opener split across two chunks, and
        // the blank line that would have to come before it.
        const keep = Math.min(carry.length, OPENER.length + 2);
        carryOffset += utf8BytesBetween(carry, 0, carry.length - keep);
        carry = carry.slice(carry.length - keep);
        return;
      }
      // A wrapper starts the body or follows a blank line.
      const separated = carryOffset === 0 && at === 0
        ? true
        : at >= 2 && carry.charCodeAt(at - 1) === 10 && carry.charCodeAt(at - 2) === 10;
      if (!separated) {
        carryOffset += utf8BytesBetween(carry, 0, at + 1);
        carry = carry.slice(at + 1);
        continue;
      }
      const wrapper = readWrapper(carry, at, { partial: !final });
      if (wrapper === "incomplete") {
        // Wait for more bytes — unless the candidate is already past anything
        // that could be a wrapper, in which case it is prose.
        if (carry.length - at <= MAX_PAYLOAD_CHARS + 4096) {
          // Keep the separator before it too: the recogniser needs it.
          const from = Math.max(0, at - 2);
          carryOffset += utf8BytesBetween(carry, 0, from);
          carry = carry.slice(from);
          return;
        }
        carryOffset += utf8BytesBetween(carry, 0, at + 1);
        carry = carry.slice(at + 1);
        continue;
      }
      if (wrapper === undefined) {
        carryOffset += utf8BytesBetween(carry, 0, at + 1);
        carry = carry.slice(at + 1);
        continue;
      }
      const offset = carryOffset + utf8BytesBetween(carry, 0, wrapper.payloadFrom);
      const bytes = utf8BytesBetween(carry, wrapper.payloadFrom, wrapper.payloadTo);
      // One page at a time, bounded exactly as the authority's own answer is:
      // a page's worth of items, a page's worth of metadata, and where the next
      // page would start.
      if (offset < from) {
        // Before this page; not this page's business and not counted in it.
      } else if (items.length >= maxItems) {
        next ??= offset;
        omitted += 1;
      } else {
        const name = boundedField(wrapper.name, REGION_NAME_MAX_BYTES);
        const mediaType = boundedField(wrapper.mediaType, REGION_MEDIA_TYPE_MAX_BYTES);
        const hasher = createHasher();
        hasher.update(wrapper.payload);
        const region: AttachmentRegion = {
          offset,
          bytes,
          name: name.text,
          mediaType: mediaType.text,
          contentDigest: hasher.digest(),
          ...(name.cut ? { nameTruncated: true as const } : {}),
          ...(mediaType.cut ? { mediaTypeTruncated: true as const } : {}),
        };
        const cost = utf8ByteLength(JSON.stringify(region));
        if (metadata + cost > maxBytes) { next ??= offset; omitted += 1; }
        else { metadata += cost; items.push(region); }
      }
      carryOffset += utf8BytesBetween(carry, 0, wrapper.end);
      carry = carry.slice(wrapper.end);
    }
  };

  return {
    push(chunk: string) {
      scanned += utf8ByteLength(chunk);
      carry += chunk;
      drain(false);
    },
    end() {
      drain(true);
      return {
        items,
        ...(omitted > 0 ? { omitted } : {}),
        ...(next !== undefined ? { next } : {}),
        scannedBytes: scanned,
      };
    },
  };
}

/**
 * One complete canonical wrapper starting at `at`, or undefined.
 *
 * Every check the prompt reader makes, made here: attributes with no quote or
 * newline in them, a numeric size within the accepted bound, a closing tag, a
 * blank line or the end after it, no NUL, only this format's entities, a
 * decoded size equal to the declared one, and a re-encode identical to what is
 * stored — so nothing that merely looks like a wrapper is ever named as a file.
 */
function readWrapper(text: string, at: number, options: { partial?: boolean } = {}): { name: string; mediaType: string; payload: string; payloadFrom: number; payloadTo: number; end: number } | undefined | "incomplete" {
  // While streaming, "not yet" is different from "no": a wrapper cut by the
  // end of a chunk is waited for, never rejected.
  const unfinished = options.partial ? ("incomplete" as const) : undefined;
  const nameFrom = at + OPENER.length;
  const nameTo = text.indexOf('"', nameFrom);
  if (nameTo < 0) return unfinished;
  if (text.indexOf("\n", nameFrom) !== -1 && text.indexOf("\n", nameFrom) < nameTo) return undefined;
  const TYPE = ' type="';
  if (!text.startsWith(TYPE, nameTo + 1)) return text.length < nameTo + 1 + TYPE.length ? unfinished : undefined;
  const typeFrom = nameTo + 1 + TYPE.length;
  const typeTo = text.indexOf('"', typeFrom);
  if (typeTo < 0) return unfinished;
  if (text.indexOf("\n", typeFrom) !== -1 && text.indexOf("\n", typeFrom) < typeTo) return undefined;
  const SIZE = ' size="';
  if (!text.startsWith(SIZE, typeTo + 1)) return text.length < typeTo + 1 + SIZE.length ? unfinished : undefined;
  const sizeFrom = typeTo + 1 + SIZE.length;
  const sizeTo = text.indexOf('"', sizeFrom);
  if (sizeTo < 0) return unfinished;
  if (!text.startsWith('">\n', sizeTo)) return text.length < sizeTo + 3 ? unfinished : undefined;
  const digits = text.slice(sizeFrom, sizeTo);
  if (!/^\d{1,9}$/.test(digits)) return undefined;
  const declared = Number(digits);
  if (!Number.isSafeInteger(declared) || declared > ATTACHMENT_MAX_BYTES) return undefined;

  const payloadFrom = sizeTo + 3;
  // A payload longer than the largest attachment the composer accepts, at its
  // worst escaping, cannot be one: the search for the closer is bounded by it.
  const searchTo = Math.min(text.length, payloadFrom + MAX_PAYLOAD_CHARS + CLOSER.length);
  const closerAt = text.lastIndexOf(CLOSER, searchTo) >= payloadFrom ? text.indexOf(CLOSER, payloadFrom) : -1;
  if (closerAt < payloadFrom) return text.length <= searchTo ? unfinished : undefined;
  if (closerAt > searchTo) return undefined;
  const end = closerAt + CLOSER.length;
  // A blank line or the end of the component after it, and nothing else.
  if (options.partial && end + 2 > text.length) return unfinished;
  if (end !== text.length && !text.startsWith("\n\n", end)) return undefined;

  const payload = text.slice(payloadFrom, closerAt);
  if (payload.includes("\0")) return undefined;
  const name = unescapeText(text.slice(nameFrom, nameTo));
  const mediaType = unescapeText(text.slice(typeFrom, typeTo));
  if (!name) return undefined;
  const content = unescapeText(payload);
  if (content.includes("\0")) return undefined;
  if (utf8ByteLength(content) !== declared) return undefined;
  // The canonical form of what was decoded must be exactly what is stored:
  // that rejects a half-escaped payload, an unknown entity and an attribute
  // that would not survive a re-encode.
  if (escapeText(content) !== payload) return undefined;
  if (escapeAttribute(name) !== text.slice(nameFrom, nameTo)) return undefined;
  if (escapeAttribute(mediaType) !== text.slice(typeFrom, typeTo)) return undefined;
  return { name, mediaType, payload, payloadFrom, payloadTo: closerAt, end };
}

function boundedField(raw: string, maxBytes: number): { text: string; cut: boolean } {
  const value = raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  if (utf8ByteLength(value) <= maxBytes) return { text: value, cut: false };
  return { text: sliceUtf8RangeFrom(value, 0, maxBytes)?.text ?? "", cut: true };
}

/** A non-negative safe integer, or undefined. */
export function safeOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Hard ceiling on one range response's payload, in exact UTF-8 bytes. */
export const ENTRY_RANGE_MAX_BYTES = 64 * 1024;

export function isBodyComponentKind(value: unknown): value is BodyComponentKind {
  return typeof value === "string" && (BODY_COMPONENT_KINDS as readonly string[]).includes(value);
}

export function bodyComponentKey(component: BodyComponent): string {
  return component.index === undefined ? component.kind : `${component.kind}:${component.index}`;
}

export function parseBodyComponentKey(key: string): BodyComponent | undefined {
  const [kind, index] = key.split(":");
  if (!isBodyComponentKind(kind)) return undefined;
  if (index === undefined) return { kind };
  const value = Number(index);
  return Number.isInteger(value) && value >= 0 ? { kind, index: value } : undefined;
}

export function sameBodyComponent(a: BodyComponent, b: BodyComponent): boolean {
  return a.kind === b.kind && (a.index ?? 0) === (b.index ?? 0);
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
const projection = { calls: 0, emittedChars: 0, scannedChars: 0 };

export interface ProjectionWork {
  readonly calls: number;
  /** Characters actually written into the excerpt. */
  readonly emittedChars: number;
  /** Characters of the source looked at, including the ones only counted. */
  readonly scannedChars: number;
}

export const bodyProjectionWork = (): ProjectionWork => ({ ...projection });
export const resetBodyProjectionWork = (): void => { projection.calls = 0; projection.emittedChars = 0; projection.scannedChars = 0; };

export interface BoundedBody {
  /** The first `maxBytes` of the body, cut on a character boundary. */
  text: string;
  /**
   * Exact UTF-8 size of the whole body, or `undefined` when this projection
   * cannot predict the canonical text and refuses to build it to find out.
   * Never zero for something it did not measure.
   */
  totalBytes: number | undefined;
  /** The body is larger than the excerpt, or could not be projected at all. */
  truncated: boolean;
  /** The size and the excerpt are unavailable; read it from the authority. */
  unknown?: true;
}

/**
 * Bytes a JSON string literal takes, counted rather than produced — exactly as
 * `JSON.stringify` writes it, including the two cases that are easy to get
 * wrong: an astral character is one four-byte pair, and an **unpaired**
 * surrogate (high or low) is written as a six-character `\uXXXX` escape rather
 * than as UTF-8.
 */
function jsonStringBytes(value: string): number {
  let bytes = 2; // the quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      // A pair is four bytes; a lone high surrogate is escaped.
      if (low >= 0xdc00 && low <= 0xdfff) { bytes += 4; index += 1; } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6; // a lone low surrogate
    else bytes += 3;
  }
  return bytes;
}

/**
 * The first bytes of `JSON.stringify(value, null, 2)` and the exact size of all
 * of it, **without ever building all of it** (RP-5b §3.2).
 *
 * A tool result is often a structure, not a string, and the old path ran the
 * whole value through `JSON.stringify` before cutting it — which is exactly
 * the copy this bound exists to prevent: twelve megabytes of result became
 * another twelve-megabyte string in the renderer before a single byte was
 * dropped. This writes only while there is room left in the excerpt and counts
 * everything after that, so the peak is the excerpt, not the body.
 *
 * The excerpt is byte-for-byte the prefix `JSON.stringify(value, null, 2)`
 * would have produced, so an offset into the whole body means the same thing
 * to the authority that serves it.
 */
export function boundedBodyText(value: unknown, maxBytes: number): BoundedBody {
  projection.calls += 1;
  if (typeof value === "string") {
    const total = utf8ByteLength(value);
    projection.scannedChars += value.length;
    if (total <= maxBytes) { projection.emittedChars += value.length; return { text: value, totalBytes: total, truncated: false }; }
    const head = sliceUtf8RangeFrom(value, 0, maxBytes);
    projection.emittedChars += head?.text.length ?? 0;
    return { text: head?.text ?? "", totalBytes: total, truncated: true };
  }
  if (value === undefined) return { text: "", totalBytes: 0, truncated: false };

  const parts: string[] = [];
  let bytes = 0;
  let emitted = 0;
  /** Write while there is room; count always. */
  /**
   * Write while there is room; count always. Once the room is gone nothing
   * more is written, ever — what comes out is a strict prefix of the whole
   * text, so an offset into it means the same thing to the authority.
   */
  let full = false;
  const put = (text: string, size = utf8ByteLength(text)): void => {
    if (!full) {
      if (emitted + size <= maxBytes) { parts.push(text); emitted += size; }
      else {
        const room = maxBytes - emitted;
        const fitted = room > 0 ? sliceUtf8RangeFrom(text, 0, room) : undefined;
        if (fitted) { parts.push(fitted.text); emitted += fitted.bytes; }
        full = true;
      }
    }
    bytes += size;
  };
  const putString = (text: string): void => {
    projection.scannedChars += text.length;
    const size = jsonStringBytes(text);
    if (!full) {
      if (emitted + size <= maxBytes) { parts.push(JSON.stringify(text)); emitted += size; }
      else {
        // Only as much of the string as fits is ever escaped, so a huge value
        // is never copied to be thrown away.
        const room = maxBytes - emitted;
        // The escape of a prefix is a prefix of the escape, so cutting the
        // written form is safe and keeps the result an exact prefix.
        const head = room > 0 ? sliceUtf8RangeFrom(text, 0, room) : undefined;
        const written = head ? JSON.stringify(head.text) : "";
        const fitted = room > 0 ? sliceUtf8RangeFrom(written, 0, room) : undefined;
        if (fitted) { parts.push(fitted.text); emitted += fitted.bytes; }
        full = true;
      }
    }
    bytes += size;
  };
  /** A value that writes itself is not modelled here; the projection refuses. */
  let unmodelled = false;
  const seen = new Set<object>();
  const walk = (node: unknown, indent: string): void => {
    if (node === null) return put("null", 4);
    if (typeof node === "object") {
      if (seen.has(node)) { unmodelled = true; return; }
      seen.add(node);
    }
    if (typeof node === "object" && typeof (node as { toJSON?: unknown }).toJSON === "function") { unmodelled = true; return; }
    if (typeof node === "string") return putString(node);
    if (typeof node === "number") return put(Number.isFinite(node) ? String(node) : "null");
    if (typeof node === "boolean") return put(node ? "true" : "false");
    if (typeof node === "bigint") { unmodelled = true; return; }
    if (typeof node === "function" || typeof node === "symbol" || node === undefined) return put("null", 4);
    const inner = `${indent}  `;
    if (Array.isArray(node)) {
      if (node.length === 0) return put("[]", 2);
      put("[\n", 2);
      node.forEach((row, index) => {
        put(inner, inner.length);
        walk(row === undefined ? null : row, inner);
        put(index === node.length - 1 ? "\n" : ",\n", index === node.length - 1 ? 1 : 2);
      });
      return put(`${indent}]`, indent.length + 1);
    }
    if (typeof node === "object") {
      const rows = Object.entries(node as Record<string, unknown>).filter(([, row]) => row !== undefined && typeof row !== "function" && typeof row !== "symbol");
      if (rows.length === 0) return put("{}", 2);
      put("{\n", 2);
      rows.forEach(([key, row], index) => {
        put(inner, inner.length);
        putString(key);
        put(": ", 2);
        walk(row, inner);
        put(index === rows.length - 1 ? "\n" : ",\n", index === rows.length - 1 ? 1 : 2);
      });
      return put(`${indent}}`, indent.length + 1);
    }
    put("null", 4);
  };
  try {
    walk(value, "");
  } catch {
    unmodelled = true;
  }
  if (unmodelled) {
    // A value whose canonical text this projection cannot predict — one with
    // its own `toJSON`, a cycle, a `BigInt` — gets no excerpt and is declared
    // unknown. It is never built here to find out how big it is, and "unknown"
    // is never reported as zero: the caller reads it from its authority.
    return { text: "", totalBytes: undefined, truncated: true, unknown: true };
  }
  const text = parts.join("");
  projection.emittedChars += text.length;
  return { text, totalBytes: bytes, truncated: bytes > emitted };
}

/**
 * Persisted identity of one entry's bodies: what a client needs to address a
 * body it does not hold, and nothing else.
 *
 * Bounded on purpose. An entry with very many components must not produce an
 * unbounded frame, so at most {@link PERSISTED_IDENTITY_MAX_ITEMS} components
 * are described and at most {@link PERSISTED_IDENTITY_MAX_BYTES} of metadata is
 * emitted; anything left out is counted, and a client leaves the refs it did
 * not receive exactly as they were — live, unreadable, never guessed.
 */
export interface PersistedBodyIdentity {
  component: BodyComponent;
  totalBytes: number;
  contentDigest: string;
}

/** How many components one entry may describe. */
export const PERSISTED_IDENTITY_MAX_ITEMS = 16;

/** How many UTF-8 bytes that description may take. */
export const PERSISTED_IDENTITY_MAX_BYTES = 4 * 1024;

/**
 * Hash one entry's bodies without building them.
 *
 * A string body is hashed where it already is. A structured body is walked
 * through the same canonical projection the excerpts and the offsets come from,
 * fed to the hash a fragment at a time and never assembled — so naming a
 * thirty-two megabyte body costs a hash, not a copy.
 *
 * `createHasher` comes from the caller's own crypto (Node's `createHash` in the
 * worker and the host); this module links none.
 */
export function entryBodyIdentities(
  entry: unknown,
  createHasher: () => { update(chunk: string): void; digest(): string },
  limits: { items?: number; bytes?: number } = {},
): { bodies: PersistedBodyIdentity[]; omitted: number; truncated?: true } {
  const maxItems = limits.items ?? PERSISTED_IDENTITY_MAX_ITEMS;
  const maxBytes = limits.bytes ?? PERSISTED_IDENTITY_MAX_BYTES;
  const bodies: PersistedBodyIdentity[] = [];
  let omitted = 0;
  let truncated: true | undefined;
  let metadataBytes = 0;
  for (const source of entryBodySources(entry)) {
    if (bodies.length >= maxItems) { omitted += 1; continue; }
    const hasher = createHasher();
    let bytes = 0;
    const sink = (chunk: string): void => { hasher.update(chunk); bytes += utf8ByteLength(chunk); };
    const complete = streamBodyText(source.value, sink);
    // A body this projection cannot predict has no digest anyone could trust.
    if (!complete) { omitted += 1; continue; }
    const row = { component: source.component, totalBytes: bytes, contentDigest: hasher.digest() };
    // `component` (kind plus optional index), size and a 64-character digest:
    // a little over a hundred bytes, counted exactly rather than estimated.
    const size = utf8ByteLength(JSON.stringify(row));
    if (metadataBytes + size > maxBytes) { omitted += 1; truncated = true; continue; }
    metadataBytes += size;
    bodies.push(row);
  }
  return { bodies, omitted, ...(truncated ? { truncated } : {}) };
}

/**
 * Feed a body's canonical text to a sink, a fragment at a time, never holding
 * it. Returns false for a value this projection cannot predict (its own
 * `toJSON`, a cycle, a `BigInt`) — the same refusal `boundedBodyText` makes.
 */
export function streamBodyText(value: unknown, sink: (chunk: string) => void): boolean {
  if (typeof value === "string") { sink(value); return true; }
  if (value === undefined) return true;
  let unmodelled = false;
  const seen = new Set<object>();
  const put = (text: string): void => { if (!unmodelled) sink(text); };
  const walk = (node: unknown, indent: string): void => {
    if (unmodelled) return;
    if (node === null) return put("null");
    if (typeof node === "object") {
      if (seen.has(node)) { unmodelled = true; return; }
      seen.add(node);
      if (typeof (node as { toJSON?: unknown }).toJSON === "function") { unmodelled = true; return; }
    }
    if (typeof node === "string") return put(JSON.stringify(node));
    if (typeof node === "number") return put(Number.isFinite(node) ? String(node) : "null");
    if (typeof node === "boolean") return put(node ? "true" : "false");
    if (typeof node === "bigint") { unmodelled = true; return; }
    if (typeof node === "function" || typeof node === "symbol" || node === undefined) return put("null");
    const inner = `${indent}  `;
    if (Array.isArray(node)) {
      if (node.length === 0) return put("[]");
      put("[\n");
      node.forEach((row, index) => {
        put(inner);
        walk(row === undefined ? null : row, inner);
        put(index === node.length - 1 ? "\n" : ",\n");
      });
      return put(`${indent}]`);
    }
    const rows = Object.entries(node as Record<string, unknown>).filter(([, row]) => row !== undefined && typeof row !== "function" && typeof row !== "symbol");
    if (rows.length === 0) return put("{}");
    put("{\n");
    rows.forEach(([key, row], index) => {
      put(inner);
      put(JSON.stringify(key));
      put(": ");
      walk(row, inner);
      put(index === rows.length - 1 ? "\n" : ",\n");
    });
    put(`${indent}}`);
  };
  try { walk(value, ""); } catch { unmodelled = true; }
  return !unmodelled;
}

/** Canonical display text of a value that may not be a string. */
export function displayBodyText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

const textPartsOf = (content: unknown, type: string, field: string): string => {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === type)
    .map((part) => String((part as Record<string, unknown>)[field] ?? ""))
    .join("");
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * What a tool result is stored and shown as. Mirrors the transcript's own rule:
 * a text-only result is its text; anything carrying structure keeps it.
 */
export function toolResultValue(message: unknown): unknown {
  const value = record(message);
  const content = value.content;
  const details = value.details;
  const hasDetails = typeof details === "object" && details !== null && !Array.isArray(details);
  const hasNonText = Array.isArray(content) &&
    content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type !== "text");
  if (!hasDetails && !hasNonText) return textPartsOf(content, "text", "text");
  return { content: Array.isArray(content) ? content : [{ type: "text", text: textPartsOf(content, "text", "text") }], ...(hasDetails ? { details } : {}) };
}

export interface EntryBody {
  component: BodyComponent;
  text: string;
}

/**
 * Every addressable body of an entry as its **source value**, not its text: a
 * string stays the string it already is and a structured value stays the value,
 * so a caller that only needs to hash or measure never pays for a copy.
 */
export function entryBodySources(entry: unknown): Array<{ component: BodyComponent; value: unknown }> {
  const value = record(entry);
  const type = typeof value.type === "string" ? value.type : "";
  const rows: Array<{ component: BodyComponent; value: unknown }> = [];
  if (type === "custom_message") {
    const text = textPartsOf(value.content, "text", "text");
    if (text) rows.push({ component: { kind: "custom_details" }, value: text });
    if (value.details !== undefined) rows.push({ component: { kind: "custom_details", index: 1 }, value: value.details });
    return rows;
  }
  if (type !== "message") return rows;
  const message = record(value.message);
  const role = typeof message.role === "string" ? message.role : "";
  const content = Array.isArray(message.content) ? message.content : [];
  if (role === "user") {
    rows.push({ component: { kind: "user_text" }, value: textPartsOf(message.content, "text", "text") });
    let image = 0;
    for (const part of content) {
      const row = record(part);
      if (row.type === "image" && typeof row.data === "string") rows.push({ component: { kind: "image", index: image++ }, value: row.data });
    }
    return rows;
  }
  if (role === "assistant") {
    rows.push({ component: { kind: "assistant_text" }, value: textPartsOf(message.content, "text", "text") });
    const thinking = textPartsOf(message.content, "thinking", "thinking");
    if (thinking) rows.push({ component: { kind: "reasoning" }, value: thinking });
    let call = 0;
    for (const part of content) {
      const row = record(part);
      if (row.type === "toolCall") rows.push({ component: { kind: "tool_args", index: call++ }, value: row.arguments });
    }
    return rows;
  }
  if (role === "toolResult") {
    rows.push({ component: { kind: "tool_result" }, value: toolResultValue(message) });
    return rows;
  }
  if (role === "custom") {
    rows.push({ component: { kind: "custom_details" }, value: textPartsOf(message.content, "text", "text") });
    if (message.details !== undefined) rows.push({ component: { kind: "custom_details", index: 1 }, value: message.details });
  }
  return rows;
}

/**
 * Every addressable body of one canonical entry, in a stable order.
 *
 * Pure and storage-neutral: it takes the record itself, so the worker (from
 * memory) and the host (from the stored conversation) answer identically.
 */
export function entryBodies(entry: unknown): EntryBody[] {
  const value = record(entry);
  const type = typeof value.type === "string" ? value.type : "";
  const bodies: EntryBody[] = [];
  if (type === "custom_message") {
    const text = textPartsOf(value.content, "text", "text");
    if (text) bodies.push({ component: { kind: "custom_details" }, text });
    if (value.details !== undefined) bodies.push({ component: { kind: "custom_details", index: 1 }, text: displayBodyText(value.details) });
    return bodies;
  }
  if (type !== "message") return bodies;
  const message = record(value.message);
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "user") {
    bodies.push({ component: { kind: "user_text" }, text: textPartsOf(message.content, "text", "text") });
    const content = Array.isArray(message.content) ? message.content : [];
    let image = 0;
    for (const part of content) {
      const row = record(part);
      if (row.type === "image" && typeof row.data === "string") {
        bodies.push({ component: { kind: "image", index: image++ }, text: row.data });
      }
    }
    return bodies;
  }
  if (role === "assistant") {
    bodies.push({ component: { kind: "assistant_text" }, text: textPartsOf(message.content, "text", "text") });
    const thinking = textPartsOf(message.content, "thinking", "thinking");
    if (thinking) bodies.push({ component: { kind: "reasoning" }, text: thinking });
    const content = Array.isArray(message.content) ? message.content : [];
    let call = 0;
    for (const part of content) {
      const row = record(part);
      if (row.type === "toolCall") bodies.push({ component: { kind: "tool_args", index: call++ }, text: displayBodyText(row.arguments) });
    }
    return bodies;
  }
  if (role === "toolResult") {
    bodies.push({ component: { kind: "tool_result" }, text: displayBodyText(toolResultValue(message)) });
    return bodies;
  }
  if (role === "custom") {
    bodies.push({ component: { kind: "custom_details" }, text: textPartsOf(message.content, "text", "text") });
    if (message.details !== undefined) bodies.push({ component: { kind: "custom_details", index: 1 }, text: displayBodyText(message.details) });
  }
  return bodies;
}

/**
 * The size of every addressable body of an entry, **without building any of
 * them** (RP-5b §3.2).
 *
 * `entryBodies` is for an authority that is about to answer with the text; a
 * client deciding whether it may keep a record must not pay for the text to
 * find out. Strings are counted where they already are, and a structured value
 * is walked through the same bounded projection the excerpt uses, which writes
 * at most `maxBytes` and counts the rest.
 */
export function entryBodyMetadata(entry: unknown, maxBytes = 0): Array<{ component: BodyComponent; totalBytes: number; unknown?: true }> {
  const value = record(entry);
  const type = typeof value.type === "string" ? value.type : "";
  const rows: Array<{ component: BodyComponent; totalBytes: number; unknown?: true }> = [];
  const structured = (component: BodyComponent, node: unknown): void => {
    const bounded = boundedBodyText(node, maxBytes);
    // A body whose size cannot be predicted without building it is declared
    // unknown and treated as oversized: the view points at it rather than
    // guessing, and never records zero for it.
    rows.push(bounded.totalBytes === undefined
      ? { component, totalBytes: Number.MAX_SAFE_INTEGER, unknown: true }
      : { component, totalBytes: bounded.totalBytes });
  };
  const partsSize = (content: unknown, kind: string, field: string): number => {
    if (typeof content === "string") return kind === "text" ? utf8ByteLength(content) : 0;
    if (!Array.isArray(content)) return 0;
    let bytes = 0;
    for (const part of content) {
      const row = record(part);
      if (row.type === kind) bytes += utf8ByteLength(String(row[field] ?? ""));
    }
    return bytes;
  };
  if (type === "custom_message") {
    const text = partsSize(value.content, "text", "text");
    if (text > 0) rows.push({ component: { kind: "custom_details" }, totalBytes: text });
    if (value.details !== undefined) structured({ kind: "custom_details", index: 1 }, value.details);
    return rows;
  }
  if (type !== "message") return rows;
  const message = record(value.message);
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "user") {
    rows.push({ component: { kind: "user_text" }, totalBytes: partsSize(message.content, "text", "text") });
    const content = Array.isArray(message.content) ? message.content : [];
    let image = 0;
    for (const part of content) {
      const row = record(part);
      if (row.type === "image" && typeof row.data === "string") rows.push({ component: { kind: "image", index: image++ }, totalBytes: utf8ByteLength(row.data) });
    }
    return rows;
  }
  if (role === "assistant") {
    rows.push({ component: { kind: "assistant_text" }, totalBytes: partsSize(message.content, "text", "text") });
    const thinking = partsSize(message.content, "thinking", "thinking");
    if (thinking > 0) rows.push({ component: { kind: "reasoning" }, totalBytes: thinking });
    const content = Array.isArray(message.content) ? message.content : [];
    let call = 0;
    for (const part of content) {
      const row = record(part);
      if (row.type === "toolCall") structured({ kind: "tool_args", index: call++ }, row.arguments);
    }
    return rows;
  }
  if (role === "toolResult") {
    const content = message.content;
    const details = message.details;
    const hasDetails = typeof details === "object" && details !== null && !Array.isArray(details);
    const hasNonText = Array.isArray(content) &&
      content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type !== "text");
    // A text-only result is its own text, counted where it already is.
    if (!hasDetails && !hasNonText) rows.push({ component: { kind: "tool_result" }, totalBytes: partsSize(content, "text", "text") });
    else structured({ kind: "tool_result" }, toolResultValue(message));
    return rows;
  }
  if (role === "custom") {
    rows.push({ component: { kind: "custom_details" }, totalBytes: partsSize(message.content, "text", "text") });
    if (message.details !== undefined) structured({ kind: "custom_details", index: 1 }, message.details);
  }
  return rows;
}

/** One named body of one entry, or `undefined` when the entry has no such body. */
export function entryBody(entry: unknown, component: BodyComponent): string | undefined {
  for (const body of entryBodies(entry)) if (sameBodyComponent(body.component, component)) return body.text;
  return undefined;
}

/** The largest body this entry carries, in exact UTF-8 bytes. */
export function largestBodyBytes(entry: unknown): number {
  let largest = 0;
  for (const body of entryBodies(entry)) largest = Math.max(largest, utf8ByteLength(body.text));
  return largest;
}

/** What a range request asks for, independent of who answers it. */
export interface BodyRangeRequest {
  component: BodyComponent;
  offset: number;
  limit?: number;
  /**
   * Read only this part of the component — an attachment inside a prompt.
   *
   * `offset` stays absolute in the component's own byte space; the region
   * narrows what may be served, so nothing is silently rebased. The answer
   * echoes the region and carries the region's own digest.
   */
  region?: BodyRegion;
}

export interface BodyRangeAnswerResult {
  authority: "live" | "durable";
  revision: string;
  component: BodyComponent;
  /** Always the **whole component's** size, never the region's. */
  totalBytes: number;
  offset: number;
  bytes: number;
  /**
   * Where the next slice starts. For a region read it is absent at the
   * region's end — `region.offset + region.bytes` — even though the component
   * continues past it.
   */
  next?: number;
  /** For a region read: this reply did not carry the whole **region**. */
  truncated: boolean;
  sliceDigest: string;
  contentDigest: string;
  /** Echo of the region asked for, exactly as asked. */
  region?: BodyRegion;
  /** SHA-256 of the region's bytes, when a region was asked for. */
  regionDigest?: string;
  text: string;
}

export type BodyRangeRefusal =
  | { reason: "unknown-component"; available: BodyComponentKind[] }
  | { reason: "bad-range" }
  /** The region is not a part of this component at all. */
  | { reason: "bad-region" };

/**
 * Slice one body of one entry. The one implementation both authorities use, so
 * a live answer and a durable one cannot disagree about totals, digests,
 * character boundaries or refusals. The digest function is the caller's: this
 * package links no crypto.
 */
export function bodyRangeSlice(
  entry: unknown,
  request: BodyRangeRequest,
  revision: string,
  authority: "live" | "durable",
  digest: (text: string) => string,
): { ok: true; result: BodyRangeAnswerResult } | { ok: false; refusal: BodyRangeRefusal } {
  const body = entryBody(entry, request.component);
  if (body === undefined) {
    return { ok: false, refusal: { reason: "unknown-component", available: [...new Set(entryBodies(entry).map((row) => row.component.kind))] } };
  }
  const totalBytes = utf8ByteLength(body);
  const bounds = regionBounds(request.region, totalBytes);
  if (bounds === "refuse") return { ok: false, refusal: { reason: "bad-region" } };
  const limit = regionLimit(request, bounds);
  if (limit === undefined) return { ok: false, refusal: { reason: "bad-range" } };
  const slice = sliceUtf8Range(body, request.offset, limit);
  if (!slice) return { ok: false, refusal: { reason: "bad-range" } };
  return {
    ok: true,
    result: regionAnswer({
      authority, revision, component: request.component, totalBytes, slice, body, digest, region: bounds,
    }),
  };
}

/**
 * Where a region begins and ends, validated: non-negative safe integers that
 * name a part of this component, and nothing else. No arithmetic is done on a
 * value before it is known to be a safe integer.
 */
export function regionBounds(region: BodyRegion | undefined, totalBytes: number): { offset: number; bytes: number; end: number } | undefined | "refuse" {
  if (region === undefined) return undefined;
  const offset = safeOffset(region.offset);
  const bytes = safeOffset(region.bytes);
  if (offset === undefined || bytes === undefined) return "refuse";
  const end = offset + bytes;
  if (!Number.isSafeInteger(end) || end > totalBytes) return "refuse";
  return { offset, bytes, end };
}

/** How much may be served, so a region read never reaches past its region. */
function regionLimit(request: BodyRangeRequest, bounds: { offset: number; end: number } | undefined | "refuse"): number | undefined {
  const asked = Math.min(request.limit ?? ENTRY_RANGE_MAX_BYTES, ENTRY_RANGE_MAX_BYTES);
  if (bounds === undefined || bounds === "refuse") return asked;
  // The offset is absolute; a read that starts outside the region is refused
  // rather than moved into it.
  if (request.offset < bounds.offset || request.offset > bounds.end) return undefined;
  return Math.max(0, Math.min(asked, bounds.end - request.offset));
}

/** The answer for one slice, with region echo, region digest and region end. */
function regionAnswer(input: {
  authority: "live" | "durable";
  revision: string;
  component: BodyComponent;
  totalBytes: number;
  slice: { offset: number; bytes: number; next?: number; truncated: boolean; text: string };
  body: string;
  digest: (text: string) => string;
  region: { offset: number; bytes: number; end: number } | undefined | "refuse";
  contentDigest?: string;
}): BodyRangeAnswerResult {
  const { slice, region } = input;
  const inRegion = region !== undefined && region !== "refuse";
  const reachedEnd = inRegion ? slice.offset + slice.bytes >= region.end : slice.next === undefined;
  return {
    authority: input.authority,
    revision: input.revision,
    component: input.component,
    totalBytes: input.totalBytes,
    offset: slice.offset,
    bytes: slice.bytes,
    ...(!reachedEnd && slice.next !== undefined ? { next: slice.next } : {}),
    truncated: !reachedEnd,
    sliceDigest: input.digest(slice.text),
    contentDigest: input.contentDigest ?? input.digest(input.body),
    ...(inRegion
      ? {
          region: { offset: region.offset, bytes: region.bytes },
          regionDigest: input.digest(sliceUtf8RangeFrom(input.body, region.offset, region.bytes)?.text ?? ""),
        }
      : {}),
    text: slice.text,
  };
}

/** What one page of attachment metadata answers with. */
export interface EntryRegionsResult {
  authority: "live" | "durable";
  revision: string;
  component: BodyComponent;
  /** The whole component's size. */
  totalBytes: number;
  items: AttachmentRegion[];
  /** Exact count of wrappers seen and not described. Absent when `truncated`. */
  omitted?: number;
  /** The scan could not see the whole component, so no count is claimed. */
  truncated?: true;
  scannedBytes: number;
  /** Where the next page starts, in component bytes. */
  next?: number;
}

/**
 * One page of the attachments inside one component.
 *
 * Bounded twice over: what it describes ({@link BODY_REGION_MAX_ITEMS},
 * {@link BODY_REGION_METADATA_MAX_BYTES}) and how far it looks
 * ({@link BODY_REGION_SCAN_MAX_BYTES}). A reply is therefore far inside the
 * transport's own ceiling, whatever the component holds.
 */
export function entryRegionsPage(
  entry: unknown,
  request: { component: BodyComponent; from?: number; limit?: number },
  revision: string,
  authority: "live" | "durable",
  createHasher: () => { update(chunk: string): void; digest(): string },
): { ok: true; result: EntryRegionsResult } | { ok: false; refusal: BodyRangeRefusal } {
  const body = entryBody(entry, request.component);
  if (body === undefined) {
    return { ok: false, refusal: { reason: "unknown-component", available: [...new Set(entryBodies(entry).map((row) => row.component.kind))] } };
  }
  const from = safeOffset(request.from);
  if (request.from !== undefined && from === undefined) return { ok: false, refusal: { reason: "bad-region" } };
  const limit = safeOffset(request.limit);
  if (request.limit !== undefined && (limit === undefined || limit === 0)) return { ok: false, refusal: { reason: "bad-range" } };
  const found = attachmentRegions(body, createHasher, { ...(from !== undefined ? { from } : {}), ...(limit !== undefined ? { maxItems: limit } : {}) });
  return {
    ok: true,
    result: {
      authority,
      revision,
      component: request.component,
      totalBytes: utf8ByteLength(body),
      items: found.items,
      ...(found.truncated ? { truncated: found.truncated } : found.omitted !== undefined ? { omitted: found.omitted } : {}),
      ...(found.next !== undefined ? { next: found.next } : {}),
      scannedBytes: found.scannedBytes,
    },
  };
}

/**
 * One body, read many times (RP-5b).
 *
 * A thirty-megabyte body is read in five hundred slices. Without this, every
 * one of them re-derived the body from its record, re-hashed all of it and
 * walked it from the first byte — quadratic in the size of the thing the bound
 * exists to make cheap. The reader keeps **one** body at a time: its text, its
 * size, its digest and where the last slice ended, all of which belong to an
 * exact (session, revision, entry, component) and are dropped the moment any
 * of those change. It is a memo of what the authority just produced, never a
 * second transcript: nothing is stored, nothing is served from it that the
 * record itself would not answer.
 */
export interface BodyRangeKey {
  path: string;
  revision: string;
  entryId: string;
  component: BodyComponent;
  /** Anything else that must invalidate the memo — a file identity, a seq. */
  fence?: string;
}

interface MemoisedBody {
  key: string;
  text: string;
  totalBytes: number;
  contentDigest: string;
  cursor: Utf8Cursor;
}

const memoKey = (key: BodyRangeKey): string =>
  `${key.path}\u0000${key.revision}\u0000${key.entryId}\u0000${bodyComponentKey(key.component)}\u0000${key.fence ?? ""}`;

export interface BodyRangeReader {
  read(
    key: BodyRangeKey,
    entry: () => unknown,
    request: BodyRangeRequest,
    authority: "live" | "durable",
    digest: (text: string) => string,
  ): { ok: true; result: BodyRangeAnswerResult } | { ok: false; refusal: BodyRangeRefusal };
  forget(): void;
}

/** One reader per authority instance; it holds at most one body. */
export function createBodyRangeReader(): BodyRangeReader {
  let held: MemoisedBody | undefined;
  return {
    read(key, entry, request, authority, digest) {
      const id = memoKey(key);
      if (!held || held.key !== id) {
        const record = entry();
        const body = entryBody(record, request.component);
        if (body === undefined) {
          return { ok: false, refusal: { reason: "unknown-component", available: [...new Set(entryBodies(record).map((row) => row.component.kind))] } };
        }
        held = { key: id, text: body, totalBytes: utf8ByteLength(body), contentDigest: digest(body), cursor: { byteOffset: 0, charIndex: 0 } };
      }
      const bounds = regionBounds(request.region, held.totalBytes);
      if (bounds === "refuse") return { ok: false, refusal: { reason: "bad-region" } };
      const limit = regionLimit(request, bounds);
      if (limit === undefined) return { ok: false, refusal: { reason: "bad-range" } };
      const slice = sliceUtf8RangeFrom(held.text, request.offset, limit, held.cursor, held.totalBytes);
      if (!slice) return { ok: false, refusal: { reason: "bad-range" } };
      held.cursor = slice.cursor;
      return {
        ok: true,
        result: regionAnswer({
          authority,
          revision: key.revision,
          component: request.component,
          totalBytes: held.totalBytes,
          slice,
          body: held.text,
          digest,
          region: bounds,
          contentDigest: held.contentDigest,
        }),
      };
    },
    forget() { held = undefined; },
  };
}

/**
 * An entry a page did not deliver because one of its bodies is larger than the
 * caller asked to receive. Identity and shape only: the record itself is never
 * rewritten, so nothing a client holds is a lossy copy of a canonical entry.
 */
export interface ElidedEntry {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  /** The call a `toolResult` answers, so a client can put its row back. */
  toolCallId?: string;
  /** The calls an assistant record made, so their rows survive the elision. */
  toolCalls?: Array<{ id: string; name: string }>;
  /** Exact size and digest of every body, so a client can address them. */
  bodies: Array<{ component: BodyComponent; totalBytes: number; contentDigest: string; regions?: AttachmentRegions }>;
}

/** A one-shot hasher around an authority's own digest function. */
function hasherOf(digest: (text: string) => string): { update(chunk: string): void; digest(): string } {
  let held = "";
  return { update(chunk: string) { held += chunk; }, digest: () => digest(held) };
}

/** The tool calls one assistant record made, identity and name only. */
export function entryToolCalls(entry: unknown): Array<{ id: string; name: string }> {
  const message = record(record(entry).message);
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; name: string }> = [];
  for (const part of message.content) {
    const row = record(part);
    if (row.type === "toolCall" && typeof row.id === "string") calls.push({ id: row.id, name: typeof row.name === "string" ? row.name : "tool" });
  }
  return calls;
}

/**
 * Split a planned page into the records that fit the caller's per-body limit
 * and the ones that do not. Pure; the digest function is supplied by the
 * producer (the protocol package links no crypto).
 */
export function elideOversizedEntries(
  entries: readonly unknown[],
  bodyLimit: number,
  digest: (text: string) => string,
): { entries: unknown[]; elided: ElidedEntry[] } {
  const kept: unknown[] = [];
  const elided: ElidedEntry[] = [];
  for (const entry of entries) {
    const bodies = entryBodies(entry);
    const value = record(entry);
    const id = typeof value.id === "string" ? value.id : undefined;
    const oversized = bodies.some((body) => utf8ByteLength(body.text) > bodyLimit);
    if (!oversized || id === undefined) {
      kept.push(entry);
      continue;
    }
    elided.push({
      id,
      parentId: typeof value.parentId === "string" ? value.parentId : null,
      type: typeof value.type === "string" ? value.type : "",
      ...(typeof record(value.message).role === "string" ? { role: record(value.message).role as string } : {}),
      ...(typeof record(value.message).toolCallId === "string" ? { toolCallId: record(value.message).toolCallId as string } : {}),
      ...(entryToolCalls(entry).length > 0 ? { toolCalls: entryToolCalls(entry) } : {}),
      bodies: bodies.map((body) => {
        // A prompt's attachments are named here, bounded, so a surface holding
        // only an excerpt still shows its file chips and can read one of them
        // without scanning the body it does not have (RP-5b §2).
        const regions = body.component.kind === "user_text"
          ? attachmentRegions(body.text, () => hasherOf(digest))
          : undefined;
        return {
          component: body.component,
          totalBytes: utf8ByteLength(body.text),
          contentDigest: digest(body.text),
          ...(regions && (regions.items.length > 0 || regions.truncated || regions.omitted) ? { regions } : {}),
        };
      }),
    });
  }
  return { entries: kept, elided };
}
