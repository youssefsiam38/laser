/**
 * The files inside a prompt (RP-5b §2).
 *
 * A prompt with attachments is stored as one text with canonical wrappers
 * around the files. This recognises those wrappers — only complete, canonical
 * ones — and says where each file's **stored** bytes are, so a surface holding
 * an excerpt can show its chips and read one of them without holding the
 * prompt. The same recogniser answers in one pass over a whole component and
 * incrementally over a body that arrives a slice at a time.
 *
 * Pure: no I/O, no Pi, no DOM. Hashing is the caller's own.
 */
import { safeOffset, sliceUtf8RangeFrom, utf8ByteLength } from "./body-utf8.js";

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

/**
 * The canonical attachment wrapper, recognised here exactly as the composer
 * writes it and the prompt reader takes it apart — same opener, same attribute
 * escaping, same blank-line separators, same closing tag. This module does not
 * import that code (nothing above the worker may), so the two are kept in step
 * by their tests, not by a shared import.
 */
/** The longest name and media type a region describes before it is cut. */
const REGION_NAME_MAX_BYTES = 256;
const REGION_MEDIA_TYPE_MAX_BYTES = 128;

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
