/**
 * Worker-free authoritative history pages (RP-12).
 *
 * The index owns only offsets, identities and revision folds. This projection
 * plans over those lightweight rows, then opens the transcript once and reads
 * only the selected page bodies. It never repairs, migrates or writes JSONL.
 */
import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import {
  DURABLE_HISTORY_EPOCH,
  ErrorCodes,
  HISTORY_PAGE_BYTE_LIMIT,
  HISTORY_PAGE_ENTRY_LIMIT,
  ProtocolError,
  fitHistoryWindowPlan,
  historyContentSerializedBytes,
  historyWindowNode,
  withElidedBodies,
  type ClientRequests,
  type HistoryWindow,
  type HistoryWindowRequest,
  type HistoryWindowScope,
} from "@lasercode/protocol";
import type { FileIdentity, IndexedEntry, SessionIndex, SessionIndexCache, SessionIndexFailure } from "./session-index.js";
import type { SessionRevisions } from "./session-revision.js";
import { sha256Hex } from "./session-body-range.js";

const MATERIALISE_ATTEMPTS = 2;

export interface SessionProjectionOptions {
  index: SessionIndexCache;
  revisions: SessionRevisions;
  /** Deterministic race seam; runs after planning and before the fd is opened. */
  beforeMaterialize?: ((index: SessionIndex, attempt: number) => void) | undefined;
  /** Test/measurement seam: one callback for each selected JSONL body read. */
  onMaterializeRead?: ((entry: IndexedEntry) => void) | undefined;
}

export type ProjectionAnswer =
  | { kind: "answer"; result: ClientRequests["pi/session/entries"]["result"] }
  | { kind: "route-live"; reason: SessionIndexFailure }
  | { kind: "refuse"; error: ProtocolError };

export class SessionProjection {
  constructor(private readonly options: SessionProjectionOptions) {}

  async read(path: string, requested: HistoryWindowRequest | undefined, baseRevision?: string, bodyLimit?: number): Promise<ProjectionAnswer> {
    for (let attempt = 0; attempt < MATERIALISE_ATTEMPTS; attempt++) {
      const indexed = await this.options.index.read(path);
      if (!indexed.ok) {
        return indexed.failure.reason === "unsupported-version"
          ? { kind: "route-live", reason: indexed.failure }
          : { kind: "refuse", error: refusal(indexed.failure) };
      }
      const index = indexed.index;
      const revision = this.options.revisions.revisionOf(index);
      const base = baseRevision === undefined ? undefined : this.options.revisions.resolveBase(index, baseRevision);
      const request = requested ?? { tail: 40 };
      // An older page is merged into a client-held window. Its base must still
      // be this exact state or a cryptographically proved canonical prefix;
      // an anchor/cursor alone cannot detect rewritten content with reused ids.
      if (("before" in request || "beforeEntry" in request) && (base?.base === "stale" || !base?.state)) {
        return { kind: "refuse", error: unavailable("This conversation changed since that page was read. Reload it and try again.") };
      }
      const common = {
        sessionId: index.header.id,
        epoch: DURABLE_HISTORY_EPOCH,
        seq: 0,
        revision,
        environmentKey: this.options.revisions.environmentKey,
        authority: "durable" as const,
      };
      const deltaScope: HistoryWindowScope | undefined =
        ("tail" in request) && base && base.base !== "stale" && base.state
          ? { ...common, selection: { kind: "delta", after: base.state.leafId } }
          : undefined;
      let scope: HistoryWindowScope = deltaScope ?? { ...common, selection: { kind: "replace" } };
      let plan = deltaScope
        ? fitHistoryWindowPlan(index.entries, index.leafId, request, deltaScope, candidate => withinPlannedBounds(index.entries, candidate.entryIndices, candidate.contextIndices, bodyLimit))
        : undefined;

      // A delta must contain the complete suffix. If it does not fit, plan the
      // caller's same tail request as an atomic replacement. Non-live-edge
      // shapes never enter delta planning in the first place.
      if (!plan) {
        scope = { ...common, selection: { kind: "replace" } };
        plan = fitHistoryWindowPlan(index.entries, index.leafId, request, scope, candidate => withinPlannedBounds(index.entries, candidate.entryIndices, candidate.contextIndices, bodyLimit));
      }
      // A single source row may itself exceed the page ceiling while its
      // elided identity is small (most visibly an image at max bodyLimit).
      // Materialize at most one such row as a bounded last resort; never use
      // the optimistic elided estimate to admit a whole large candidate.
      if (!plan && bodyLimit !== undefined && !("all" in request) && !("from" in request)) {
        plan = fitHistoryWindowPlan(index.entries, index.leafId, request, scope,
          candidate => withinSingleElidedFallback(index.entries, candidate.entryIndices, candidate.contextIndices, bodyLimit));
      }
      if (!plan) {
        const detail = "all" in request || "from" in request
          ? "The requested history range is too large to transfer safely. Ask for a bounded page instead."
          : "No bounded history page can represent this complete turn.";
        return { kind: "refuse", error: unavailable(detail) };
      }

      this.options.beforeMaterialize?.(index, attempt);
      const materialized = materialize(path, index, plan.entryIndices, plan.contextIndices, this.options.onMaterializeRead);
      if (materialized.kind === "changed") {
        this.options.index.invalidate(path);
        if (attempt + 1 < MATERIALISE_ATTEMPTS) continue;
        return { kind: "refuse", error: changed() };
      }
      if (materialized.kind === "unreadable") return { kind: "refuse", error: unavailable() };

      const selected = plan.entryIndices.map(index => materialized.values.get(index));
      const contextRows = plan.contextIndices.map(index => materialized.values.get(index));
      // RP-5b: with a per-body limit, a record carrying a larger body is left
      // out and listed with its identity and body metadata instead. Records
      // themselves are never rewritten.
      const page = bodyLimit === undefined
        ? { entries: selected, leafId: plan.leafId, window: { ...plan.window, context: contextRows } satisfies HistoryWindow }
        : withElidedBodies({ entries: selected, leafId: plan.leafId, window: { ...plan.window, context: contextRows } satisfies HistoryWindow }, bodyLimit, sha256Hex);
      if (historyContentSerializedBytes(page.entries, page.window.context)
        + historyContentSerializedBytes(page.window.elided ?? [], []) > HISTORY_PAGE_BYTE_LIMIT) {
        // Raw line lengths are conservative, but enforce the exact two-array
        // wire-body size at the final authority boundary too.
        return { kind: "refuse", error: unavailable("The selected history page is too large to transfer safely.") };
      }
      return { kind: "answer", result: { entries: page.entries, leafId: page.leafId, window: page.window } };
    }
    return { kind: "refuse", error: changed() };
  }
}

/** Room for identity plus many body metadata rows around retained prose. */
const ELIDED_METADATA_PLANNING_BYTES = 16 * 1024;

/**
 * Plan from exact source-wire bytes or a conservative elided ceiling. JSON can
 * expand one UTF-8 body byte to six (`\\u0001`), so `bodyLimit` alone is never
 * a wire estimate. Metadata gets its own fixed allowance, and the exact
 * materialized two-array check remains final.
 */
function withinPlannedBounds(
  entries: readonly IndexedEntry[],
  selected: readonly number[],
  context: readonly number[],
  bodyLimit?: number,
): boolean {
  if (selected.length > HISTORY_PAGE_ENTRY_LIMIT) return false;
  let bytes = 4 + Math.max(0, selected.length - 1) + Math.max(0, context.length - 1);
  const cost = (index: number): number => {
    const source = entries[index]!.serializedLength;
    if (bodyLimit === undefined || source <= bodyLimit) return source;
    const escaped = Math.min(Number.MAX_SAFE_INTEGER - ELIDED_METADATA_PLANNING_BYTES, bodyLimit * 6);
    return Math.min(source, escaped + ELIDED_METADATA_PLANNING_BYTES);
  };
  for (const index of [...selected, ...context]) {
    bytes += cost(index);
    if (bytes > HISTORY_PAGE_BYTE_LIMIT) return false;
  }
  return true;
}

/** One-row escape hatch for a source row whose elided form may fit. */
function withinSingleElidedFallback(
  entries: readonly IndexedEntry[],
  selected: readonly number[],
  context: readonly number[],
  bodyLimit: number,
): boolean {
  if (selected.length !== 1) return false;
  let bytes = 4;
  for (const index of context) bytes += entries[index]!.serializedLength;
  if (bytes > HISTORY_PAGE_BYTE_LIMIT) return false;
  const row = entries[selected[0]!]!;
  // Only a row larger than the requested body ceiling can possibly become
  // smaller through body elision. The exact materialized check remains final.
  return row.serializedLength > bodyLimit;
}

type Materialized =
  | { kind: "ok"; values: Map<number, unknown> }
  | { kind: "changed" }
  | { kind: "unreadable" };

function materialize(
  path: string,
  index: SessionIndex,
  selected: readonly number[],
  context: readonly number[],
  onRead?: (entry: IndexedEntry) => void,
): Materialized {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { kind: "unreadable" };
  }
  try {
    if (!sameIdentity(index.identity, fstatSync(fd))) return { kind: "changed" };
    const values = new Map<number, unknown>();
    for (const rowIndex of new Set([...selected, ...context])) {
      const row = index.entries[rowIndex]!;
      onRead?.(row);
      const buffer = Buffer.alloc(row.length);
      if (readSync(fd, buffer, 0, row.length, row.offset) !== row.length) return { kind: "changed" };
      const text = buffer.toString("utf8");
      if (!text.trimStart().startsWith("{")) return { kind: "changed" };
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { kind: "changed" };
      }
      const identity = historyWindowNode(value);
      if (identity.id !== row.id) return { kind: "changed" };
      values.set(rowIndex, value);
    }
    if (!sameIdentity(index.identity, fstatSync(fd))) return { kind: "changed" };
    return { kind: "ok", values };
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function sameIdentity(expected: FileIdentity, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

function changed(): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, "This history changed. Reload the conversation and try again.");
}

function unavailable(detail?: string): ProtocolError {
  return new ProtocolError(
    ErrorCodes.RevisionUnavailable,
    detail ?? "This conversation could not be read as it is stored right now. Open it again, and restart the app if it keeps happening.",
  );
}

function refusal(failure: SessionIndexFailure): ProtocolError {
  if (failure.reason === "missing") return new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");
  if (failure.reason === "not-a-session") return new ProtocolError(ErrorCodes.SessionNotFound, "That file is not a conversation this app can read.");
  return unavailable();
}
