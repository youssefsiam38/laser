/**
 * The bounded, immutable record a released transcript leaves behind (RP-5, the
 * seam RP-10 fills).
 *
 * What crosses this boundary is **already serialized**: a frozen object of
 * strings and numbers, cut to a declared number of entries and bytes. Never a
 * `SessionView`, never an entry object, never a block, never an `ImageContent`,
 * never a `File`, `Blob` or object URL, and never `unknown[]` — nothing a cache
 * could hold that would keep alive the graph this release just let go of.
 *
 * A tail is only worth keeping when it can be validated later, so a view with
 * no accepted durable revision produces an empty, `omitted` record rather than
 * an unverifiable one.
 *
 * T5 ships a sink that does nothing. Persistence, expiry and reading a tail
 * back belong to RP-10, and painting from one to RP-11.
 *
 * Pure: no React, no DOM, no storage.
 */
import type { SessionView } from "../store.js";
import { byteLength, entryBytes } from "./view-measure.js";

export const VIEW_TAIL_SCHEMA = "view-tail/1";
/** Entries one tail may carry: the same recent tail a re-entry reads. */
export const VIEW_TAIL_MAX_ENTRIES = 40;
/** Bytes one tail may carry, whichever bound is reached first. */
export const VIEW_TAIL_MAX_BYTES = 256 * 1024;

export interface ViewTailEntryDto {
  readonly id: string;
  readonly parentId: string | null;
  /** The entry as JSON. A string, never a live object. */
  readonly json: string;
}

export type ViewTailOmission = "no-revision" | "over-bounds" | "unserializable";

export interface ViewTailDto {
  readonly schema: typeof VIEW_TAIL_SCHEMA;
  readonly path: string;
  readonly environmentKey: string;
  readonly revision: string;
  readonly epoch: string;
  readonly seq: number;
  readonly leafId: string | null | undefined;
  readonly capturedAt: string;
  /** Newest last. Older rows are dropped before newer ones. */
  readonly entries: readonly ViewTailEntryDto[];
  /** Older rows existed and were dropped to stay inside the bounds. */
  readonly truncated: boolean;
  /** Exact UTF-8 bytes of the carried `json` values. */
  readonly bytes: number;
  readonly omitted?: ViewTailOmission;
}

/** Where a released tail goes. T5's default does nothing; RP-10 persists it. */
export interface ViewTailSink {
  release(tail: ViewTailDto): void;
}

export const NO_TAIL_SINK: ViewTailSink = { release: () => {} };

/**
 * The sink this renderer is using, process-wide.
 *
 * One stable seam, so the device cache (RP-10) is installed without this file
 * or the cache that calls it changing again: it installs its sink, gets the
 * previous one back, and restores it when it goes away. Reading happens at
 * delivery time — after the release has been published and painted — so a sink
 * installed a moment later still receives the tail, and a sink that has been
 * uninstalled never does.
 */
let installedSink: ViewTailSink = NO_TAIL_SINK;

/** Install a sink; the return value is the one it replaced, for restoring it. */
export function installViewTailSink(sink: ViewTailSink | undefined): ViewTailSink {
  const previous = installedSink;
  installedSink = sink ?? NO_TAIL_SINK;
  return previous;
}

/** The sink in force right now. Callers read this at the moment they deliver. */
export function viewTailSink(): ViewTailSink {
  return installedSink;
}

const identityOf = (entry: unknown): { id: string; parentId: string | null } | undefined => {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as { id?: unknown; parentId?: unknown };
  if (typeof record.id !== "string" || record.id === "") return undefined;
  return { id: record.id, parentId: typeof record.parentId === "string" ? record.parentId : null };
};

/**
 * Capture what this view is about to release. Called **before** the release,
 * in the same turn, so the bytes are still there; the result shares nothing
 * with the view it was taken from.
 */
export function captureViewTail(view: SessionView, capturedAt: string): ViewTailDto {
  const validated = view.validated;
  const base = {
    schema: VIEW_TAIL_SCHEMA,
    path: view.path,
    environmentKey: validated?.environmentKey ?? "",
    revision: validated?.revision ?? "",
    epoch: validated?.epoch ?? view.updateEpoch ?? "",
    seq: validated?.seq ?? view.lastSeq,
    leafId: view.leafId,
    capturedAt,
  } as const;
  // A tail nothing can validate is not a cache entry; it is a guess.
  if (!validated) return Object.freeze({ ...base, entries: Object.freeze([]), truncated: false, bytes: 0, omitted: "no-revision" as const });

  const entries: ViewTailEntryDto[] = [];
  let bytes = 0;
  let truncated = false;
  let unserializable = false;
  for (let index = view.entries.length - 1; index >= 0; index--) {
    if (entries.length >= VIEW_TAIL_MAX_ENTRIES) { truncated = true; break; }
    const raw = view.entries[index];
    const identity = identityOf(raw);
    if (!identity) { unserializable = true; continue; }
    // Measured through the same memoized estimator, so a capture costs nothing
    // the eviction pass has not already paid for.
    const size = entryBytes(raw);
    if (bytes + size > VIEW_TAIL_MAX_BYTES) { truncated = true; break; }
    let json: string;
    try {
      const text = JSON.stringify(raw);
      if (text === undefined) { unserializable = true; continue; }
      json = text;
    } catch {
      unserializable = true;
      continue;
    }
    bytes += byteLength(json);
    entries.push(Object.freeze({ ...identity, json }));
  }
  entries.reverse();
  return Object.freeze({
    ...base,
    entries: Object.freeze(entries),
    truncated,
    bytes,
    ...(truncated && entries.length === 0 ? { omitted: "over-bounds" as const }
      : unserializable && entries.length === 0 ? { omitted: "unserializable" as const } : {}),
  });
}
