/**
 * What may be written, and what may be believed (RP-10).
 *
 * Pure by design — no storage, no clock, no state — because these are the two
 * decisions the rest of the cache is built on and they must be testable on
 * their own:
 *
 * 1. **What a released tail becomes**: {@link fitRelease} normalizes it, fits
 *    the *canonical payload* inside the per-record byte bound (not a sum of its
 *    parts), and refuses anything it cannot fully account for — including a
 *    tail carrying a field this build does not know, which a later slice may
 *    add (RP-5b) and which must never be filed as a complete conversation.
 * 2. **What a stored row is allowed to be**: {@link parseStoredRow} validates
 *    every field of a row, with no cast, and {@link openPayload} authenticates
 *    its body — exact measured size, then checksum, then shape — before a
 *    single entry of it is trusted. A row this build did not write can claim
 *    anything; nothing here believes a claim it can measure instead.
 */
import { isEnvironmentKey, isSessionRevision } from "@lasercode/protocol";
import { byteLength } from "../view-measure.js";
import { VIEW_TAIL_SCHEMA, type ViewTailDto } from "../view-tail.js";
import { TAIL_RECORD_SCHEMA, type TailBounds } from "./bounds.js";
import type { TailDiscardReason } from "./counters.js";
import {
  TAIL_PAYLOAD_VERSION,
  checksumOf,
  contentText,
  payloadBytes,
  payloadText,
  normalizeEntry,
  type TailAttachmentRef,
  type TailEntryRecord,
  type TailPayload,
  type TailRecord,
} from "./record.js";
import type { SealedBody } from "./vault.js";
import type { StoredRow } from "./store.js";

/** Longest identity or metadata string a row may carry. */
const FIELD_MAX = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" && value.length <= FIELD_MAX ? value : undefined;

const wholeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;

const timestamp = (value: unknown): string | undefined => {
  const text = boundedString(value);
  if (text === undefined) return undefined;
  return Number.isFinite(Date.parse(text)) ? text : undefined;
};

// --------------------------------------------------------------- the DTO side

/**
 * Every field of a released tail this cache understands.
 *
 * A tail that carries anything else is refused, not stored. RP-5 owns that DTO
 * and may add to it — a later slice plans a marker for a tail whose oversized
 * entry bodies were left out (RP-5b) — and a cache that ignored an unknown
 * field would file an excerpt as if it were the whole conversation, for RP-11
 * to paint as one. Failing closed costs a cache hit until this file learns the
 * new field; assuming completeness would cost the truth.
 */
const KNOWN_TAIL_FIELDS: ReadonlySet<string> = new Set([
  "schema",
  "path",
  "sessionId",
  "environmentKey",
  "revision",
  "epoch",
  "seq",
  "leafId",
  "capturedAt",
  "entries",
  "truncated",
  "bytes",
  "omitted",
]);

/** Fields of one entry row this cache understands, for the same reason. */
const KNOWN_ENTRY_FIELDS: ReadonlySet<string> = new Set(["id", "parentId", "at", "json"]);

export function carriesOnlyKnownFields(tail: ViewTailDto): boolean {
  for (const field of Object.keys(tail)) if (!KNOWN_TAIL_FIELDS.has(field)) return false;
  for (const entry of tail.entries) {
    for (const field of Object.keys(entry)) if (!KNOWN_ENTRY_FIELDS.has(field)) return false;
  }
  return true;
}

export type ReleaseRefusal = "not-a-tail" | "foreign" | "unknown-field" | "identity" | "no-content" | "over-bounds";

export interface FittedRelease {
  readonly payload: TailPayload;
  readonly text: string;
  readonly bytes: number;
  readonly capturedAt: string;
  readonly sessionId: string;
}

/**
 * Fit one released tail into a record, or refuse it.
 *
 * The bound is applied to the **canonical payload** — every entry's id and
 * parent id, the JSON structure around them, the escaping inside them and the
 * attachment references beside them — because that is what is written.
 * Measuring only `entry.json` let a record whose ids are long, or whose text is
 * not Latin, cross the bound: it was written, read back as over-bound on the
 * next start, and purged. Rows are dropped oldest-first until the payload fits;
 * a single row that cannot fit alone is refused.
 */
export function fitRelease(
  tail: ViewTailDto,
  environmentKey: string,
  bounds: TailBounds,
): FittedRelease | { refusal: ReleaseRefusal } {
  if (tail.schema !== VIEW_TAIL_SCHEMA || tail.omitted !== undefined) return { refusal: "not-a-tail" };
  if (tail.environmentKey !== environmentKey) return { refusal: "foreign" };
  if (!carriesOnlyKnownFields(tail)) return { refusal: "unknown-field" };
  const sessionId = boundedString(tail.sessionId);
  const capturedAt = timestamp(tail.capturedAt);
  if (sessionId === undefined || capturedAt === undefined || !isSessionRevision(tail.revision)) {
    return { refusal: "identity" };
  }

  const rows: Array<{ entry: TailEntryRecord; references: readonly TailAttachmentRef[]; omitted: number }> = [];
  let truncated = tail.truncated;
  for (let index = tail.entries.length - 1; index >= 0; index--) {
    const source = tail.entries[index]!;
    if (rows.length >= bounds.entriesPerSession) {
      truncated = true;
      break;
    }
    const normalized = normalizeEntry(source, bounds);
    if (!normalized) {
      truncated = true;
      continue;
    }
    rows.push({
      entry: Object.freeze({ id: source.id, parentId: source.parentId, json: normalized.json }),
      references: normalized.references,
      omitted: normalized.omitted,
    });
  }
  rows.reverse();

  const build = (): { payload: TailPayload; text: string } => {
    const content = Object.freeze({
      entries: Object.freeze(rows.map((row) => row.entry)),
      attachments: Object.freeze(rows.flatMap((row) => [...row.references])),
    });
    const payload: TailPayload = Object.freeze({
      v: TAIL_PAYLOAD_VERSION,
      revision: tail.revision,
      leafId: tail.leafId ?? null,
      epoch: tail.epoch,
      seq: tail.seq,
      truncated,
      attachmentsOmitted: rows.reduce((sum, row) => sum + row.omitted, 0),
      checksum: checksumOf(contentText(content)),
      content,
    });
    return { payload, text: payloadText(payload) };
  };

  let fitted = build();
  while (rows.length > 0 && byteLength(fitted.text) > bounds.bytesPerSession) {
    rows.shift();
    truncated = true;
    fitted = build();
  }
  if (rows.length === 0) return { refusal: "no-content" };
  const bytes = payloadBytes(fitted.text);
  if (bytes > bounds.bytesPerSession) return { refusal: "over-bounds" };
  return { payload: fitted.payload, text: fitted.text, bytes, capturedAt, sessionId };
}

// ------------------------------------------------------------- the stored side

/** A row whose every outside field this build has validated. */
export interface ValidatedRow {
  readonly key: TailKeyTuple;
  readonly schema: string;
  readonly appVersion: string;
  readonly environmentKey: string;
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly lastUsedAt: string;
  /** What the row claims its payload weighs. Checked against the real bytes. */
  readonly bytes: number;
  readonly body: SealedBody;
}

type TailKeyTuple = readonly [string, string];

/**
 * Validate one stored row, field for field, with no cast.
 *
 * A row was written by some build of this app, possibly not this one, possibly
 * by something else entirely — every field is therefore parsed rather than
 * trusted, and the reason a row fails is the reason it is counted under.
 */
export function parseStoredRow(
  stored: StoredRow,
  expect: { appVersion: string; environmentKey: string },
): ValidatedRow | { discard: TailDiscardReason } {
  const key = stored.key;
  if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== "string" || typeof key[1] !== "string") {
    // Not addressable as a record of ours: countable, and removable only by the
    // primary key the store hands over with it.
    return { discard: "invalid" };
  }
  const row = stored.row;
  if (!isRecord(row)) return { discard: "invalid" };
  if (row["schema"] !== TAIL_RECORD_SCHEMA) return { discard: "schema" };
  if (row["appVersion"] !== expect.appVersion) return { discard: "version" };

  const environmentKey = boundedString(row["environmentKey"]);
  if (environmentKey === undefined || !isEnvironmentKey(environmentKey)) return { discard: "invalid" };
  if (environmentKey !== expect.environmentKey) return { discard: "foreign" };
  if (environmentKey !== key[0]) return { discard: "invalid" };

  const sessionId = boundedString(row["sessionId"]);
  if (sessionId === undefined || sessionId !== key[1]) return { discard: "invalid" };

  const capturedAt = timestamp(row["capturedAt"]);
  const lastUsedAt = timestamp(row["lastUsedAt"]);
  const bytes = wholeNumber(row["bytes"]);
  if (capturedAt === undefined || lastUsedAt === undefined || bytes === undefined) return { discard: "invalid" };

  const body = parseSealedBody(row["body"]);
  if (!body) return { discard: "invalid" };

  // A path, or anything shaped like one, has no business in a row: a build that
  // wrote one is not a build whose rows this one reads. `schema` is this
  // build's own constant and is compared exactly above; every other field is
  // free-form and is checked here.
  for (const name of ["appVersion", "environmentKey", "sessionId", "capturedAt", "lastUsedAt"] as const) {
    const value = row[name];
    if (typeof value === "string" && value.includes("/")) return { discard: "invalid" };
  }
  if (Object.keys(row).length !== 8) return { discard: "invalid" };

  return Object.freeze({
    key: [key[0], key[1]] as TailKeyTuple,
    schema: TAIL_RECORD_SCHEMA,
    appVersion: expect.appVersion,
    environmentKey,
    sessionId,
    capturedAt,
    lastUsedAt,
    bytes,
    body,
  });
}

function parseSealedBody(value: unknown): SealedBody | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "plain") {
    const text = value["text"];
    return typeof text === "string" && Object.keys(value).length === 2 ? { kind: "plain", text } : undefined;
  }
  if (value["kind"] === "aes-gcm-256") {
    const iv = value["iv"];
    const data = value["data"];
    if (!(iv instanceof Uint8Array) || iv.byteLength !== 12) return undefined;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return undefined;
    return Object.keys(value).length === 3 ? { kind: "aes-gcm-256", iv, data } : undefined;
  }
  return undefined;
}

/** What a stored row really costs to read, measured rather than asked. */
export function storedBytesOf(body: SealedBody): number {
  return body.kind === "plain" ? byteLength(body.text) : body.data.byteLength + body.iv.byteLength;
}

/**
 * Authenticate one payload and turn it into a record.
 *
 * In order: the payload is inside the per-record byte bound **as measured**, it
 * weighs exactly what the row claimed, its checksum matches the content it
 * carries, and its shape is exactly this generation's. A row that claims to be
 * tiny and carries a megabyte therefore never becomes a record — the
 * measurement is what is trusted, not the claim.
 */
export function openPayload(
  row: ValidatedRow,
  text: string,
  bounds: TailBounds,
): TailRecord | { discard: TailDiscardReason } {
  const exact = payloadBytes(text);
  if (exact > bounds.bytesPerSession) return { discard: "oversize" };
  if (exact !== row.bytes) return { discard: "corrupt" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { discard: "corrupt" };
  }
  const payload = parsePayload(parsed, bounds);
  if (!payload) return { discard: "corrupt" };
  if (checksumOf(contentText(payload.content)) !== payload.checksum) return { discard: "corrupt" };
  return Object.freeze({
    schema: TAIL_RECORD_SCHEMA,
    appVersion: row.appVersion,
    environmentKey: row.environmentKey,
    sessionId: row.sessionId,
    revision: payload.revision,
    leafId: payload.leafId,
    epoch: payload.epoch,
    seq: payload.seq,
    entries: payload.content.entries,
    truncated: payload.truncated,
    attachments: payload.content.attachments,
    attachmentsOmitted: payload.attachmentsOmitted,
    bytes: exact,
    capturedAt: row.capturedAt,
    lastUsedAt: row.lastUsedAt,
  } satisfies TailRecord);
}

function parsePayload(value: unknown, bounds: TailBounds): TailPayload | undefined {
  if (!isRecord(value)) return undefined;
  if (value["v"] !== TAIL_PAYLOAD_VERSION) return undefined;
  const revision = boundedString(value["revision"]);
  const epoch = value["epoch"];
  const seq = wholeNumber(value["seq"]);
  const checksum = boundedString(value["checksum"]);
  const leaf = value["leafId"];
  const omitted = wholeNumber(value["attachmentsOmitted"]);
  if (revision === undefined || !isSessionRevision(revision)) return undefined;
  if (typeof epoch !== "string" || epoch.length > FIELD_MAX) return undefined;
  if (seq === undefined || checksum === undefined || omitted === undefined) return undefined;
  if (leaf !== null && (typeof leaf !== "string" || leaf.length > FIELD_MAX)) return undefined;
  if (typeof value["truncated"] !== "boolean") return undefined;
  const content = parseContent(value["content"], bounds);
  if (!content) return undefined;
  if (Object.keys(value).length !== 9) return undefined;
  return Object.freeze({
    v: TAIL_PAYLOAD_VERSION,
    revision,
    leafId: leaf === null ? null : leaf,
    epoch,
    seq,
    truncated: value["truncated"],
    attachmentsOmitted: omitted,
    checksum,
    content,
  });
}

function parseContent(value: unknown, bounds: TailBounds): TailPayload["content"] | undefined {
  if (!isRecord(value)) return undefined;
  const rawEntries = value["entries"];
  const rawAttachments = value["attachments"];
  if (!Array.isArray(rawEntries) || !Array.isArray(rawAttachments)) return undefined;
  if (rawEntries.length === 0 || rawEntries.length > bounds.entriesPerSession) return undefined;
  if (rawAttachments.length > bounds.entriesPerSession * 4) return undefined;
  const entries: TailEntryRecord[] = [];
  for (const row of rawEntries) {
    if (!isRecord(row)) return undefined;
    const id = boundedString(row["id"]);
    const json = row["json"];
    const parent = row["parentId"];
    if (id === undefined || typeof json !== "string") return undefined;
    if (parent !== null && (typeof parent !== "string" || parent.length > FIELD_MAX)) return undefined;
    if (Object.keys(row).length !== 3) return undefined;
    entries.push(Object.freeze({ id, parentId: parent === null ? null : parent, json }));
  }
  const attachments: TailAttachmentRef[] = [];
  for (const row of rawAttachments) {
    if (!isRecord(row)) return undefined;
    const entryId = boundedString(row["entryId"]);
    const mimeType = boundedString(row["mimeType"]);
    const checksum = boundedString(row["checksum"]);
    const bytes = wholeNumber(row["bytes"]);
    if (entryId === undefined || mimeType === undefined || checksum === undefined || bytes === undefined) return undefined;
    if (Object.keys(row).length !== 4) return undefined;
    attachments.push(Object.freeze({ entryId, mimeType, bytes, checksum }));
  }
  return Object.freeze({ entries: Object.freeze(entries), attachments: Object.freeze(attachments) });
}

/**
 * An ISO timestamp this device may believe, or `undefined`. Never immortal: a
 * timestamp from the future is corrupt rather than eternal, and one past its
 * age is gone — the rule the drafts store already keeps.
 */
export function readableAge(at: string, now: number, ageMs: number): number | undefined {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed > now + 60_000) return undefined;
  if (now - parsed > ageMs) return undefined;
  return parsed;
}
