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

import { safeOffset, sliceUtf8Range, sliceUtf8RangeFrom, utf8ByteLength, type CursoredSlice, type Utf8Cursor, type Utf8Slice } from "./body-utf8.js";
import { attachmentRegions, type AttachmentRegion, type AttachmentRegions } from "./body-attachments.js";

export * from "./body-utf8.js";
export * from "./body-attachments.js";

/** Every body a client may address. Closed: an unknown name is refused. */
export const BODY_COMPONENT_KINDS = [
  "user_text",
  "assistant_text",
  "reasoning",
  "tool_args",
  "tool_result",
  /**
   * A tool result's output as a person reads it: its text parts, joined —
   * always plain text, whatever `details` or non-text parts the result also
   * carries. `tool_result` stays the structured record excerpts and digests
   * are taken from; a reader of the whole output reads this (D-275).
   */
  "tool_output",
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


/** The longest name and media type a region describes before it is cut. */
const REGION_NAME_MAX_BYTES = 256;
const REGION_MEDIA_TYPE_MAX_BYTES = 128;

/**
 * The most editable text a composer may hold, in exact UTF-8 bytes.
 *
 * An edit puts a whole message in the renderer, so a prompt larger than this is
 * never handed back into one: the worker leaves it out of its answer and says
 * how large it is instead (RP-5b B3).
 */
export const EDITABLE_TEXT_MAX_BYTES = 64 * 1024;

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

export interface ProjectionWork {
  readonly calls: number;
  /** Characters actually written into the excerpt. */
  readonly emittedChars: number;
  /** Characters of the source looked at, including the ones only counted. */
  readonly scannedChars: number;
}

/** What the projection has done, for tests and counters. */
const projection = { calls: 0, emittedChars: 0, scannedChars: 0 };

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
  // Once the room is gone nothing more is written, ever: what comes out is a
  // strict prefix of the canonical text, so an offset into it means the same
  // thing to the authority that serves the rest.
  let full = false;
  const take = (chunk: string): void => {
    const size = utf8ByteLength(chunk);
    projection.scannedChars += chunk.length;
    if (!full) {
      if (emitted + size <= maxBytes) { parts.push(chunk); emitted += size; }
      else {
        const room = maxBytes - emitted;
        const fitted = room > 0 ? sliceUtf8RangeFrom(chunk, 0, room) : undefined;
        if (fitted) { parts.push(fitted.text); emitted += fitted.bytes; }
        full = true;
      }
    }
    bytes += size;
  };
  const modelled = canonicalBodyJson(value, take, { stopped: () => full, countString: (size) => { bytes += size; } });
  if (!modelled) {
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
  // A text-only tool result is the same string as its output: hashed once.
  let previous: { value: string; totalBytes: number; contentDigest: string } | undefined;
  for (const source of entryBodySources(entry)) {
    if (bodies.length >= maxItems) { omitted += 1; continue; }
    let measured: { totalBytes: number; contentDigest: string };
    if (typeof source.value === "string" && previous !== undefined && previous.value === source.value) {
      measured = { totalBytes: previous.totalBytes, contentDigest: previous.contentDigest };
    } else {
      const hasher = createHasher();
      let bytes = 0;
      const sink = (chunk: string): void => { hasher.update(chunk); bytes += utf8ByteLength(chunk); };
      const complete = streamBodyText(source.value, sink);
      // A body this projection cannot predict has no digest anyone could trust.
      if (!complete) { omitted += 1; continue; }
      measured = { totalBytes: bytes, contentDigest: hasher.digest() };
      previous = typeof source.value === "string" ? { value: source.value, ...measured } : undefined;
    }
    const row = { component: source.component, ...measured };
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
  return canonicalBodyJson(value, sink);
}

/**
 * The canonical text of a value, written a fragment at a time (RP-5b B1).
 *
 * This is the **one** serializer: the bounded excerpt, the hash of a body and
 * the text an authority materializes all come through here, so a byte offset
 * means the same thing to every one of them. It is what `JSON.stringify(value,
 * null, 2)` produces, emitted incrementally — a string is written as its
 * opening quote, its characters escaped exactly as stringification escapes
 * them, and its closing quote — so nothing ever builds an escaped copy of a
 * body to throw most of it away.
 *
 * Returns false for a value whose canonical text cannot be predicted: one with
 * its own `toJSON`, a cycle, a `BigInt`. Those fail closed, and nothing
 * partial written before the refusal may be used.
 */
export function canonicalBodyJson(
  value: unknown,
  emit: (chunk: string) => void,
  options: { stopped?: () => boolean; countString?: (bytes: number) => void } = {},
): boolean {
  let unmodelled = false;
  const seen = new Set<object>();
  const put = (text: string): void => { if (!unmodelled) emit(text); };
  const putString = (text: string): void => {
    // Once nothing more will be written, a string is only counted, and counted
    // without escaping it: naming a thirty-megabyte body costs no copy of it.
    if (options.stopped?.() && options.countString) { options.countString(jsonStringBytes(text)); return; }
    put('"');
    let plain = 0;
    for (let index = 0; index < text.length; index++) {
      // What is left of this string, and the closing quote that will never be
      // written: the opening one already was.
      if (options.stopped?.() && options.countString) { options.countString(jsonStringBytes(text.slice(plain)) - 1); return; }
      const escape = jsonEscapeOf(text, index);
      if (escape === undefined) continue;
      if (index > plain) put(text.slice(plain, index));
      put(escape);
      plain = index + 1;
    }
    if (plain < text.length) put(text.slice(plain));
    put('"');
  };
  const walk = (node: unknown, indent: string): void => {
    if (unmodelled) return;
    if (node === null) return put("null");
    if (typeof node === "object") {
      if (seen.has(node)) { unmodelled = true; return; }
      seen.add(node);
      if (typeof (node as { toJSON?: unknown }).toJSON === "function") { unmodelled = true; return; }
    }
    if (typeof node === "string") return putString(node);
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
      putString(key);
      put(": ");
      walk(row, inner);
      put(index === rows.length - 1 ? "\n" : ",\n");
    });
    put(`${indent}}`);
  };
  try { walk(value, ""); } catch { unmodelled = true; }
  return !unmodelled;
}

/**
 * The escape `JSON.stringify` writes for the character at `index`, or
 * undefined when that character is written as itself. Lone surrogates are
 * escaped, exactly as well-formed stringification does.
 */
function jsonEscapeOf(text: string, index: number): string | undefined {
  const code = text.charCodeAt(index);
  if (code === 0x22) return '\\"';
  if (code === 0x5c) return "\\\\";
  if (code < 0x20) {
    switch (code) {
      case 0x08: return "\\b";
      case 0x09: return "\\t";
      case 0x0a: return "\\n";
      case 0x0c: return "\\f";
      case 0x0d: return "\\r";
      default: return `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
    return low >= 0xdc00 && low <= 0xdfff ? undefined : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    // The second half of a real pair is written as itself, with its first.
    const high = index > 0 ? text.charCodeAt(index - 1) : 0;
    return high >= 0xd800 && high <= 0xdbff ? undefined : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return undefined;
}

/** Canonical display text of a value that may not be a string. */
export function displayBodyText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  // The same serializer the excerpt and the hash use, so an authority's text
  // and a client's offsets can never disagree. It is assembled once, because
  // an authority answering with a body has to have it.
  const parts: string[] = [];
  if (canonicalBodyJson(value, (chunk) => { parts.push(chunk); })) return parts.join("");
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

/** A tool result's output as text: its text parts, joined. Never structured. */
export function toolOutputBody(message: unknown): string {
  return textPartsOf(record(message).content, "text", "text");
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
    rows.push({ component: { kind: "tool_output" }, value: toolOutputBody(message) });
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
    bodies.push({ component: { kind: "tool_output" }, text: toolOutputBody(message) });
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
    rows.push({ component: { kind: "tool_output" }, totalBytes: partsSize(content, "text", "text") });
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
  // Only the body asked for is built: reading a tool's output never pays for
  // the structured record beside it.
  for (const source of entryBodySources(entry)) if (sameBodyComponent(source.component, component)) return displayBodyText(source.value);
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
  /** The entry being read; the answer echoes it. */
  entryId: string;
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
  /** The entry this is a body of, always echoed so no reply can be mistaken. */
  entryId: string;
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
      authority, revision, entryId: request.entryId, component: request.component, totalBytes, slice, body, digest, region: bounds,
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
  entryId: string;
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
    entryId: input.entryId,
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
  /**
   * Let go of the body this reader is holding.
   *
   * Answers whether there was one. A caller giving memory back under pressure
   * (RP-8) reports a release only when something was actually released, and a
   * reader that was already empty is `nothing_to_give` rather than a claim
   * nobody can check.
   */
  forget(): boolean;
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
          entryId: key.entryId,
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
    forget() {
      const had = held !== undefined;
      held = undefined;
      return had;
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
