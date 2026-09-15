/**
 * What one cached conversation tail is, on this device (RP-10).
 *
 * The record is deliberately two things at once:
 *
 * - an **identity** the cache can validate without reading a byte of content —
 *   the opaque environment key, the session's own opaque id, RP-9's opaque
 *   revision, the branch leaf, and the accounting numbers; and
 * - a **body** — the entries exactly as the host sent them, re-serialized by
 *   RP-5 — which is the only part that is ever sealed, and the only part that
 *   costs anything.
 *
 * Three rules hold everywhere below:
 *
 * 1. **No key material but opaque identity.** A record is addressed by
 *    `(environmentKey, sessionId)`. No path is ever part of a key (the path is
 *    an index for lookup, and a record whose environment does not match the
 *    live one is refused whatever its path says), no raw environment id, no
 *    device or actor id, and no conversation content.
 * 2. **Exact UTF-8 bytes.** Every number here is what a `TextEncoder` would
 *    write, counted through RP-5's allocation-free counter.
 * 3. **Bounded references, never a second copy of a picture.** A base64 body
 *    over the inline threshold is replaced by a reference carrying its mime
 *    type, its exact size and a checksum — never the bytes, and never in more
 *    than one record.
 *
 * Pure: no DOM, no storage, no React.
 */
import { MESSAGE_METADATA_NS, isEnvironmentKey, isSessionRevision } from "@lasercode/protocol";
import { byteLength } from "../view-measure.js";
import { TAIL_HARD_LIMITS, TAIL_RECORD_SCHEMA, type TailBounds } from "./bounds.js";

/** One cached entry: the host's own entry JSON, as a string. Never an object. */
export interface TailEntryRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly json: string;
}

/**
 * A picture this record deliberately did not keep.
 *
 * `checksum` identifies the dropped payload so two snapshots of the same
 * conversation can be recognised as carrying the same picture. It is a
 * corruption/identity check, not a security boundary — authentication is the
 * vault's job (`vault.ts`), and under a policy of `attachments: "none"` not
 * even this is recorded.
 */
export interface TailAttachmentRef {
  readonly entryId: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly checksum: string;
}

/** The decrypted, validated, frozen record the cache hands out. */
export interface TailRecord {
  readonly schema: typeof TAIL_RECORD_SCHEMA;
  readonly appVersion: string;
  readonly environmentKey: string;
  readonly sessionId: string;
  readonly path: string;
  readonly revision: string;
  readonly leafId: string | null;
  readonly epoch: string;
  readonly seq: number;
  readonly entries: readonly TailEntryRecord[];
  readonly truncated: boolean;
  readonly attachments: readonly TailAttachmentRef[];
  /** References a stricter policy would not even keep. Counted, never guessed. */
  readonly attachmentsOmitted: number;
  /** Exact UTF-8 bytes of the body this record carries. */
  readonly bytes: number;
  readonly capturedAt: string;
  readonly lastUsedAt: string;
  readonly checksum: string;
}

/** The body, and only the body, is what the vault seals. */
export interface TailBody {
  readonly entries: readonly TailEntryRecord[];
  readonly attachments: readonly TailAttachmentRef[];
}

export type TailKey = readonly [environmentKey: string, sessionId: string];

/**
 * A checksum for corruption, not for secrecy.
 *
 * FNV-1a over the string's UTF-16 code units, folded to 32 bits and written as
 * hex. It is synchronous and allocation-free, which matters because it runs on
 * every write and every read; `crypto.subtle` is promise-only and absent on an
 * insecure origin, so a digest could not be a precondition of reading a record
 * back. What this detects is a truncated, rewritten or half-written body —
 * which is exactly what it is used for. Tamper resistance on the desktop comes
 * from AES-GCM and its additional authenticated data, never from this.
 */
export function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Length is folded in so a truncation that happens to preserve the hash of a
  // prefix is still a mismatch.
  return `${hash.toString(16)}-${text.length.toString(16)}`;
}

/** The canonical bytes a body is measured, checksummed and sealed as. */
export function bodyText(body: TailBody): string {
  return JSON.stringify({ entries: body.entries, attachments: body.attachments });
}

/**
 * The identity a sealed body is bound to.
 *
 * Passed to the vault as additional authenticated data, so a ciphertext lifted
 * out of one row cannot be replayed in another: a record for another
 * environment, another session or another revision will not open at all.
 */
export function identityAad(record: {
  schema: string;
  appVersion: string;
  environmentKey: string;
  sessionId: string;
  revision: string;
}): string {
  return [record.schema, record.appVersion, record.environmentKey, record.sessionId, record.revision].join("\u0000");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Longest identity or metadata string a record may carry. */
const FIELD_MAX = 512;
const boundedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= FIELD_MAX ? value : undefined;

/**
 * Validate one entry row, field for field, with no cast.
 *
 * A row from storage was written by some build of this app, possibly not this
 * one, possibly by something else entirely. Nothing here trusts a shape.
 */
function parseEntry(value: unknown): TailEntryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedString(value["id"]);
  const json = typeof value["json"] === "string" ? value["json"] : undefined;
  if (id === undefined || id === "" || json === undefined) return undefined;
  const parent = value["parentId"];
  if (parent !== null && typeof parent !== "string") return undefined;
  if (typeof parent === "string" && parent.length > FIELD_MAX) return undefined;
  return Object.freeze({ id, parentId: parent === null ? null : parent, json });
}

function parseAttachment(value: unknown): TailAttachmentRef | undefined {
  if (!isRecord(value)) return undefined;
  const entryId = boundedString(value["entryId"]);
  const mimeType = boundedString(value["mimeType"]);
  const checksum = boundedString(value["checksum"]);
  const bytes = value["bytes"];
  if (entryId === undefined || mimeType === undefined || checksum === undefined) return undefined;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
  return Object.freeze({ entryId, mimeType, bytes, checksum });
}

/** A body read back from storage, or `undefined` for anything not exactly right. */
export function parseBody(text: string): TailBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const rawEntries = parsed["entries"];
  const rawAttachments = parsed["attachments"];
  if (!Array.isArray(rawEntries) || !Array.isArray(rawAttachments)) return undefined;
  if (rawEntries.length > TAIL_HARD_LIMITS.entriesPerSession) return undefined;
  if (rawAttachments.length > TAIL_HARD_LIMITS.entriesPerSession * 4) return undefined;
  const entries: TailEntryRecord[] = [];
  for (const row of rawEntries) {
    const entry = parseEntry(row);
    if (!entry) return undefined;
    entries.push(entry);
  }
  const attachments: TailAttachmentRef[] = [];
  for (const row of rawAttachments) {
    const reference = parseAttachment(row);
    if (!reference) return undefined;
    attachments.push(reference);
  }
  return Object.freeze({ entries: Object.freeze(entries), attachments: Object.freeze(attachments) });
}

/**
 * Exact UTF-8 bytes of the body **as it is stored**.
 *
 * Not the sum of the entry JSON: a record also carries every entry's id and
 * parent id, its attachment references, and the JSON structure and escaping
 * around all of it. Measuring the pieces and calling the total exact would
 * under-count a record by everything between them — so this measures the one
 * string that is actually written, which is also the string the checksum is
 * taken over and the vault seals. Counted, never allocated.
 */
export function bodyBytes(body: TailBody): number {
  return byteLength(bodyText(body));
}

/** Exact UTF-8 bytes of an already-serialized body. The same number. */
export function bodyTextBytes(text: string): number {
  return byteLength(text);
}

/**
 * Is this identity one this build may read at all?
 *
 * Schema and app version are exact: the body is host JSON, but everything that
 * derives blocks from it is this build's code, and a cache hit is never worth
 * a cross-generation projection bug.
 */
export function identityIsReadable(
  row: { schema?: unknown; appVersion?: unknown; environmentKey?: unknown; sessionId?: unknown; revision?: unknown },
  appVersion: string,
  environmentKey: string,
): boolean {
  return row.schema === TAIL_RECORD_SCHEMA
    && row.appVersion === appVersion
    && typeof row.environmentKey === "string"
    && row.environmentKey === environmentKey
    && isEnvironmentKey(row.environmentKey)
    && typeof row.sessionId === "string"
    && row.sessionId !== ""
    && row.sessionId.length <= FIELD_MAX
    && isSessionRevision(row.revision);
}

/** An ISO timestamp this device may believe, or `undefined`. Never immortal. */
export function readableAge(at: unknown, now: number, ageMs: number): number | undefined {
  if (typeof at !== "string") return undefined;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return undefined;
  // The drafts rule, verbatim: a timestamp from the future is corrupt rather
  // than immortal, and one past its age is gone.
  if (parsed > now + 60_000) return undefined;
  if (now - parsed > ageMs) return undefined;
  return parsed;
}

/** The marker a consumer (RP-11) reads to draw "this picture is not kept here". */
export const TAIL_OMITTED_ATTACHMENT = "omitted";

/**
 * Where that marker sits on a content part.
 *
 * The product's own metadata namespace, derived rather than spelled: the same
 * one message metadata already uses, so a cached entry carries exactly one
 * product-owned key and a rename cannot leave a literal behind.
 */
export const TAIL_ATTACHMENT_MARKER_KEY = MESSAGE_METADATA_NS;

interface Normalized {
  json: string;
  references: TailAttachmentRef[];
  omitted: number;
}

/** How deep the walk looks for a picture before it stops caring. */
const WALK_MAX_DEPTH = 12;

/**
 * Replace every oversized picture in one entry with a bounded reference.
 *
 * A user message keeps its image bytes in the transcript (M16-T1), so a tail
 * of a conversation with pictures would otherwise write the same base64 body
 * into the cache again for every snapshot. Instead the part keeps its type and
 * mime type, its `data` becomes empty, and it carries
 * a product-namespaced marker — `{ cached: "omitted", bytes }` under
 * {@link TAIL_ATTACHMENT_MARKER_KEY} — which is the documented contract RP-11
 * draws a placeholder from. A small picture (under the policy's inline threshold) is
 * cheaper to keep than to reference, so it stays.
 *
 * Returns `undefined` when the entry cannot be read or re-serialized at all;
 * the caller drops it and marks the record truncated rather than storing
 * something it does not understand.
 */
export function normalizeEntry(entry: TailEntryRecord, bounds: TailBounds): Normalized | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.json);
  } catch {
    return undefined;
  }
  const references: TailAttachmentRef[] = [];
  let omitted = 0;
  let touched = false;

  const walk = (value: unknown, depth: number): void => {
    if (depth > WALK_MAX_DEPTH || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const node = value as Record<string, unknown>;
    const data = node["data"];
    if (node["type"] === "image" && typeof data === "string" && data !== "") {
      if (data.length > bounds.inlineAttachmentBytes) {
        const mimeType = typeof node["mimeType"] === "string" ? node["mimeType"].slice(0, 128) : "application/octet-stream";
        node["data"] = "";
        node[TAIL_ATTACHMENT_MARKER_KEY] = { cached: TAIL_OMITTED_ATTACHMENT, bytes: data.length };
        touched = true;
        if (bounds.attachments === "reference") {
          references.push(Object.freeze({ entryId: entry.id, mimeType, bytes: data.length, checksum: checksumOf(data) }));
        } else {
          // Not even a reference: nothing derived from those bytes is kept.
          omitted += 1;
        }
        return;
      }
      if (bounds.attachments === "none") {
        node["data"] = "";
        node[TAIL_ATTACHMENT_MARKER_KEY] = { cached: TAIL_OMITTED_ATTACHMENT, bytes: data.length };
        touched = true;
        omitted += 1;
        return;
      }
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };

  walk(parsed, 0);
  if (!touched) return { json: entry.json, references, omitted };
  try {
    const json = JSON.stringify(parsed);
    if (json === undefined) return undefined;
    return { json, references, omitted };
  } catch {
    return undefined;
  }
}
