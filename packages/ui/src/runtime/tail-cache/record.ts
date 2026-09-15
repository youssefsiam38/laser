/**
 * What one cached conversation tail is, on this device (RP-10).
 *
 * A record is two things, and the split is the security boundary:
 *
 * - **outside** the sealed payload, the least this device needs to find a row
 *   and bound it: the opaque environment key, the session's own opaque id, when
 *   it was captured, when it was last used, and how many bytes the payload
 *   weighs;
 * - **inside** the payload, everything derived from the conversation: the
 *   entries, the attachment references, the revision, the branch leaf, the
 *   engine epoch and sequence, and the checksum that detects a corrupted body.
 *
 * Three rules hold everywhere below:
 *
 * 1. **No path, and no path-derived token, anywhere.** A session path is a
 *    private filesystem locator. It is not a key, not an index, not a row
 *    field, not part of the additional authenticated data, not in the counters
 *    and not in the payload: the app already knows which conversation it is
 *    looking at, and resolves that to the session's own opaque id from
 *    canonical state. Browser storage gets no locator either — being openly
 *    unencrypted is not a licence to write one.
 * 2. **Exact UTF-8 bytes.** Every number here is what a `TextEncoder` would
 *    write, counted through RP-5's allocation-free counter, and always measured
 *    from the bytes that are actually stored.
 * 3. **Bounded references, never a second copy of a picture.** A base64 body
 *    over the inline threshold becomes a reference — mime type, exact size and
 *    a checksum — and that reference lives *inside* the sealed payload with the
 *    content it describes.
 *
 * Pure: no DOM, no storage, no React.
 */
import { MESSAGE_METADATA_NS } from "@lasercode/protocol";
import { byteLength } from "../view-measure.js";
import { TAIL_RECORD_SCHEMA, type TailBounds } from "./bounds.js";

/** One cached entry: the host's own entry JSON, as a string. Never an object. */
export interface TailEntryRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly json: string;
}

/**
 * A picture this record deliberately did not keep.
 *
 * `checksum` identifies the dropped payload so two snapshots of one
 * conversation are recognisably carrying the same picture. It is a
 * corruption/identity check, not a security boundary — authentication is the
 * vault's job — and it lives inside the sealed payload, because a mime type and
 * a size sitting in the clear beside a ciphertext would disclose what the
 * conversation contains. Under `attachments: "none"` not even this is recorded.
 */
export interface TailAttachmentRef {
  readonly entryId: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly checksum: string;
}

/** The conversation itself: everything derived from what was said. */
export interface TailContent {
  readonly entries: readonly TailEntryRecord[];
  readonly attachments: readonly TailAttachmentRef[];
}

/** Payload generation, inside the sealed body. */
export const TAIL_PAYLOAD_VERSION = 2;

/**
 * The sealed payload: the content, its checksum, and every field derived from
 * the conversation rather than needed to address it.
 */
export interface TailPayload {
  readonly v: typeof TAIL_PAYLOAD_VERSION;
  readonly revision: string;
  readonly leafId: string | null;
  readonly epoch: string;
  readonly seq: number;
  readonly truncated: boolean;
  readonly attachmentsOmitted: number;
  /** Over `content` only, so a corrupted body is detectable from inside. */
  readonly checksum: string;
  readonly content: TailContent;
}

/** The decrypted, validated, frozen record the cache hands out. */
export interface TailRecord {
  readonly schema: typeof TAIL_RECORD_SCHEMA;
  readonly appVersion: string;
  readonly environmentKey: string;
  readonly sessionId: string;
  readonly revision: string;
  readonly leafId: string | null;
  readonly epoch: string;
  readonly seq: number;
  readonly entries: readonly TailEntryRecord[];
  readonly truncated: boolean;
  readonly attachments: readonly TailAttachmentRef[];
  /** References a stricter policy would not even keep. Counted, never guessed. */
  readonly attachmentsOmitted: number;
  /** Exact UTF-8 bytes of the payload this record was read from or written as. */
  readonly bytes: number;
  readonly capturedAt: string;
  readonly lastUsedAt: string;
}

/** Identity is opaque, and it is all of it: no path, ever. */
export type TailKey = readonly [environmentKey: string, sessionId: string];

/**
 * A checksum for corruption, not for secrecy.
 *
 * FNV-1a over the string's UTF-16 code units, folded to 32 bits and written as
 * hex with the length beside it. It is synchronous and allocation-free, which
 * matters because it runs on every write and every validated read;
 * `crypto.subtle` is promise-only and absent on an insecure origin, so a digest
 * could not be a precondition of reading a record back. What this detects is a
 * truncated, rewritten or half-written body — which is what it is used for, in
 * both storage modes. Tamper resistance on the desktop comes from AES-GCM and
 * its additional authenticated data, never from this.
 */
export function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${text.length.toString(16)}`;
}

/** The canonical bytes the checksum is taken over. */
export function contentText(content: TailContent): string {
  return JSON.stringify({ entries: content.entries, attachments: content.attachments });
}

/** The canonical bytes a payload is measured, sealed and stored as. */
export function payloadText(payload: TailPayload): string {
  return JSON.stringify(payload);
}

/** Exact UTF-8 bytes of an already-serialized payload. */
export function payloadBytes(text: string): number {
  return byteLength(text);
}

/**
 * The identity a sealed payload is bound to.
 *
 * Passed to the vault as additional authenticated data, so a ciphertext lifted
 * out of one row cannot be replayed in another: a row for another environment,
 * another session or another capture will not open at all. Every field here is
 * one of the row's outside fields — no path, and nothing derived from the
 * conversation.
 */
export function identityAad(row: {
  schema: string;
  appVersion: string;
  environmentKey: string;
  sessionId: string;
  capturedAt: string;
}): string {
  return [row.schema, row.appVersion, row.environmentKey, row.sessionId, row.capturedAt].join("\u0000");
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

export interface NormalizedEntry {
  json: string;
  references: TailAttachmentRef[];
  omitted: number;
}

/** How deep the walk looks for a picture before it stops caring. */
const WALK_MAX_DEPTH = 12;

/**
 * Replace every oversized picture in one entry with a bounded reference.
 *
 * A user message keeps its image bytes in the transcript (M16-T1), so a tail of
 * a conversation with pictures would otherwise write the same base64 body into
 * the cache again for every snapshot. Instead the part keeps its type and mime
 * type, its `data` becomes empty, and it carries a product-namespaced marker —
 * `{ cached: "omitted", bytes }` under {@link TAIL_ATTACHMENT_MARKER_KEY} —
 * which is the documented contract RP-11 draws a placeholder from. A small
 * picture (under the policy's inline threshold) is cheaper to keep than to
 * reference, so it stays.
 *
 * `undefined` when the entry cannot be read or re-serialized at all; the caller
 * drops it and marks the record truncated rather than storing something it does
 * not understand.
 */
export function normalizeEntry(entry: TailEntryRecord, bounds: TailBounds): NormalizedEntry | undefined {
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
