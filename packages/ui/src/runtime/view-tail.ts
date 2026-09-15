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

export type ViewTailOmission = "no-revision" | "no-session-id" | "over-bounds" | "unserializable";

/** Characters of the session's own durable id. Bounded before it is carried. */
export const VIEW_TAIL_SESSION_ID_MAX = 128;

export interface ViewTailDto {
  readonly schema: typeof VIEW_TAIL_SCHEMA;
  readonly path: string;
  /**
   * The session's own durable id, from the authoritative session state — never
   * derived from a path or from an entry. A cache keys by this; a record that
   * cannot carry one is refused rather than adapted (RP-10).
   */
  readonly sessionId: string;
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

/**
 * What holding this record actually costs, in exact UTF-8 bytes.
 *
 * {@link ViewTailDto.bytes} is the *content* contract RP-10 reads: the entries
 * this record carries, and nothing else. A queue that holds records has to
 * account for the whole of one — its path and identity, the revision, epoch and
 * timestamps, every entry's own id and parent id, the JSON structure around all
 * of it — so it measures the canonical serialization of the record itself.
 *
 * Pure, exact, and deliberately not the same number as `bytes`.
 */
export function viewTailRetainedBytes(tail: ViewTailDto): number {
  return byteLength(JSON.stringify(tail));
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
  // The identity comes from the session state the worker published, and is
  // preserved on the light record; nothing here reads a path or an entry for it.
  const sessionId = validated?.sessionId ?? "";
  const base = {
    schema: VIEW_TAIL_SCHEMA,
    path: view.path,
    sessionId,
    environmentKey: validated?.environmentKey ?? "",
    revision: validated?.revision ?? "",
    epoch: validated?.epoch ?? view.updateEpoch ?? "",
    seq: validated?.seq ?? view.lastSeq,
    leafId: view.leafId,
    capturedAt,
  } as const;
  const empty = (omitted: ViewTailOmission): ViewTailDto =>
    Object.freeze({ ...base, entries: Object.freeze([]), truncated: false, bytes: 0, omitted });
  // A tail nothing can validate is not a cache entry; it is a guess.
  if (!validated) return empty("no-revision");
  // A tail nothing can identify is the same: a cache keys by the session's own
  // id, and an unidentified record would have to be adapted to be usable.
  if (sessionId === "" || sessionId.length > VIEW_TAIL_SESSION_ID_MAX) return empty("no-session-id");

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
