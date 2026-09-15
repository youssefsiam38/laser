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
export function sliceUtf8Range(text: string, offset: number, limit: number): Utf8Slice | undefined {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0) return undefined;
  const total = utf8ByteLength(text);
  if (offset > total) return undefined;
  // The end of a component is an honest empty final slice, not a refusal.
  if (offset === total) return { text: "", offset, bytes: 0, truncated: false };
  let bytes = 0;
  let start = -1;
  let taken = 0;
  let end = text.length;
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    let size: number;
    let step = 1;
    if (code < 0x80) size = 1;
    else if (code < 0x800) size = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) { size = 4; step = 2; } else size = 3;
    } else size = 3;
    if (start < 0) {
      if (bytes === offset) start = index;
      // An offset inside a character addresses no slice; it is refused, never moved.
      else if (bytes + size > offset) return undefined;
    }
    if (start >= 0) {
      if (taken + size > limit) { end = index; break; }
      taken += size;
    }
    bytes += size;
    index += step;
    if (start >= 0) end = index;
  }
  // A limit smaller than the first character addresses nothing; refuse rather
  // than answer an empty slice a caller would loop on forever.
  if (start < 0 || taken === 0) return undefined;
  const consumed = offset + taken;
  return {
    text: text.slice(start, end),
    offset,
    bytes: taken,
    ...(consumed < total ? { next: consumed } : {}),
    truncated: consumed < total,
  };
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
  /** Exact size and digest of every body, so a client can address them. */
  bodies: Array<{ component: BodyComponent; totalBytes: number; contentDigest: string }>;
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
      bodies: bodies.map((body) => ({ component: body.component, totalBytes: utf8ByteLength(body.text), contentDigest: digest(body.text) })),
    });
  }
  return { entries: kept, elided };
}
