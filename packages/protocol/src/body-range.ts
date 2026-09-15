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
  /** Exact UTF-8 size of the whole body. */
  totalBytes: number;
  /** The body is larger than the excerpt. */
  truncated: boolean;
}

/** Bytes a JSON string literal takes, counted rather than produced. */
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
      if (low >= 0xdc00 && low <= 0xdfff) { bytes += 4; index += 1; } else bytes += 6;
    } else bytes += 3;
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
  const put = (text: string, size = utf8ByteLength(text)): void => {
    if (emitted + size <= maxBytes) { parts.push(text); emitted += size; }
    else if (emitted < maxBytes) {
      const room = sliceUtf8RangeFrom(text, 0, maxBytes - emitted);
      if (room) { parts.push(room.text); emitted += room.bytes; }
      else emitted = maxBytes;
    }
    bytes += size;
    projection.emittedChars += parts.length > 0 ? 0 : 0;
  };
  const putString = (text: string): void => {
    projection.scannedChars += text.length;
    const size = jsonStringBytes(text);
    if (emitted + size <= maxBytes) { parts.push(JSON.stringify(text)); emitted += size; bytes += size; return; }
    if (emitted < maxBytes) {
      // Only as much of the string as fits is ever escaped, so a huge value is
      // never copied to be thrown away.
      const room = maxBytes - emitted;
      const head = sliceUtf8RangeFrom(text, 0, Math.max(1, room));
      const written = head ? JSON.stringify(head.text) : "";
      const fitted = sliceUtf8RangeFrom(written, 0, room);
      if (fitted) { parts.push(fitted.text); emitted += fitted.bytes; }
      else emitted = maxBytes;
    }
    bytes += size;
  };
  const walk = (node: unknown, indent: string): void => {
    if (node === null) return put("null", 4);
    if (typeof node === "string") return putString(node);
    if (typeof node === "number") return put(Number.isFinite(node) ? String(node) : "null");
    if (typeof node === "boolean") return put(node ? "true" : "false");
    if (typeof node === "bigint" || typeof node === "function" || typeof node === "symbol" || node === undefined) return put("null", 4);
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
    return { text: "", totalBytes: 0, truncated: false };
  }
  const text = parts.join("");
  projection.emittedChars += text.length;
  return { text, totalBytes: bytes, truncated: bytes > emitted };
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
}

export interface BodyRangeAnswerResult {
  authority: "live" | "durable";
  revision: string;
  component: BodyComponent;
  totalBytes: number;
  offset: number;
  bytes: number;
  next?: number;
  truncated: boolean;
  sliceDigest: string;
  contentDigest: string;
  text: string;
}

export type BodyRangeRefusal =
  | { reason: "unknown-component"; available: BodyComponentKind[] }
  | { reason: "bad-range" };

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
  const limit = Math.min(request.limit ?? ENTRY_RANGE_MAX_BYTES, ENTRY_RANGE_MAX_BYTES);
  const slice = sliceUtf8Range(body, request.offset, limit);
  if (!slice) return { ok: false, refusal: { reason: "bad-range" } };
  return {
    ok: true,
    result: {
      authority,
      revision,
      component: request.component,
      totalBytes: utf8ByteLength(body),
      offset: slice.offset,
      bytes: slice.bytes,
      ...(slice.next !== undefined ? { next: slice.next } : {}),
      truncated: slice.truncated,
      sliceDigest: digest(slice.text),
      contentDigest: digest(body),
      text: slice.text,
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
      const limit = Math.min(request.limit ?? ENTRY_RANGE_MAX_BYTES, ENTRY_RANGE_MAX_BYTES);
      const slice = sliceUtf8RangeFrom(held.text, request.offset, limit, held.cursor, held.totalBytes);
      if (!slice) return { ok: false, refusal: { reason: "bad-range" } };
      held.cursor = slice.cursor;
      return {
        ok: true,
        result: {
          authority,
          revision: key.revision,
          component: request.component,
          totalBytes: held.totalBytes,
          offset: slice.offset,
          bytes: slice.bytes,
          ...(slice.next !== undefined ? { next: slice.next } : {}),
          truncated: slice.truncated,
          sliceDigest: digest(slice.text),
          contentDigest: held.contentDigest,
          text: slice.text,
        },
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
  bodies: Array<{ component: BodyComponent; totalBytes: number; contentDigest: string }>;
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
      bodies: bodies.map((body) => ({ component: body.component, totalBytes: utf8ByteLength(body.text), contentDigest: digest(body.text) })),
    });
  }
  return { entries: kept, elided };
}
