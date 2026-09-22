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
  ELIDED_RECORD_LIMITS,
  ELIDED_RECORD_MAX_BYTES,
  ErrorCodes,
  HISTORY_PAGE_BYTE_LIMIT,
  HISTORY_PAGE_ENTRY_LIMIT,
  ProtocolError,
  fitHistoryWindowPlan,
  historyContentSerializedBytes,
  historyWindowNode,
  isLiveEdgeWindow,
  withElidedBodies,
  type ClientRequests,
  type HistoryWindow,
  type HistoryWindowPlan,
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
      // A proved prefix behind a compaction barrier still carries its state:
      // the rows before the cursor are unchanged, only a suffix merge is out.
      if (("before" in request || "beforeEntry" in request) && !base?.state) {
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
        // A newest-page read, counted in turns or in entries alike (M16-T90).
        isLiveEdgeWindow(request) && base && base.base !== "stale" && base.state
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
      // elided identity is small (a very large body of prose or structure;
      // never a picture any more, M16-T89). Materialize at most one such row as
      // a bounded last resort; never use the optimistic elided estimate to
      // admit a whole large candidate.
      if (!plan && !("all" in request) && !("from" in request)) {
        plan = fitHistoryWindowPlan(index.entries, index.leafId, request, scope,
          candidate => withinSingleElidedFallback(index.entries, candidate.entryIndices, candidate.contextIndices, bodyLimit));
      }
      if (!plan) {
        const detail = "all" in request || "from" in request
          ? "The requested history range is too large to transfer safely. Ask for a bounded page instead."
          : "versionsOf" in request
            ? "No bounded history page can represent these versions."
            : "No bounded history page can represent this complete turn.";
        return { kind: "refuse", error: unavailable(detail) };
      }

      // The plan, then the exact page it produces. A plan is an estimate over
      // rows nobody has read yet, so a page that does not fit is **re-planned
      // smaller**, never refused: a byte ceiling may shrink a page and may not
      // take a conversation away (`docs/transcript-parity.md` §2, M16-T90).
      const bounded = !("all" in request) && !("from" in request);
      let attemptPlan: HistoryWindowPlan | undefined = plan;
      for (let shrink = 0; attemptPlan; shrink++) {
        this.options.beforeMaterialize?.(index, attempt);
        const materialized = materialize(path, index, attemptPlan.entryIndices, attemptPlan.contextIndices, this.options.onMaterializeRead);
        if (materialized.kind === "changed") {
          this.options.index.invalidate(path);
          if (attempt + 1 < MATERIALISE_ATTEMPTS) break;
          return { kind: "refuse", error: changed() };
        }
        if (materialized.kind === "unreadable") return { kind: "refuse", error: unavailable() };

        const selected = attemptPlan.entryIndices.map(index => materialized.values.get(index));
        const contextRows = attemptPlan.contextIndices.map(index => materialized.values.get(index));
        // RP-5b: with a per-body limit, a record carrying a larger body is left
        // out and listed with its identity and body metadata instead. Records
        // themselves are never rewritten.
        // A record too large for any page travels as identity even when the
        // caller asked for no body limit at all: a page is never refused
        // because one record is too large (M16-T88).
        // Images become references here, for both authorities, in the one shared
        // projection: a served page never carries a picture's bytes (M16-T89).
        const page = servedPage({ entries: selected, leafId: attemptPlan.leafId, window: { ...attemptPlan.window, context: contextRows } satisfies HistoryWindow }, bodyLimit);
        if (page) return { kind: "answer", result: { entries: page.entries, leafId: page.leafId, window: page.window } };
        // Nothing this page can be elided down to fits. Ask for a smaller one,
        // priced by served bytes alone, and read it: an indivisible request
        // (`all`, `from`) and a delta are answered exactly or not at all, so
        // they are refused here as they always were.
        const budget = SHRINK_BUDGETS[shrink];
        if (!bounded || budget === undefined) {
          return { kind: "refuse", error: unavailable("The selected history page is too large to transfer safely.") };
        }
        attemptPlan = fitHistoryWindowPlan(index.entries, index.leafId, request, { ...common, selection: { kind: "replace" } },
          candidate => withinServedBounds(index.entries, candidate.entryIndices, candidate.contextIndices, budget));
      }
      if (bounded && !attemptPlan) {
        return {
          kind: "refuse",
          error: unavailable(
            "versionsOf" in request
              ? "No bounded history page can represent these versions."
              : "No bounded history page can represent this complete turn.",
          ),
        };
      }
    }
    return { kind: "refuse", error: changed() };
  }
}

/**
 * The ceilings a page is re-planned against once its first exact form did not
 * fit. Each one is priced by served bytes alone, so each really is smaller than
 * the last; the floor is small enough that any single record a page can carry
 * fits inside it.
 */
const SHRINK_BUDGETS: readonly number[] = [HISTORY_PAGE_BYTE_LIMIT / 2, HISTORY_PAGE_BYTE_LIMIT / 8, 64 * 1024];

/**
 * One materialized page as it will be sent, or nothing when even its smallest
 * elided form does not fit.
 *
 * The record ceiling steps exactly as the live authority's does
 * (`boundedHistoryWindow`): a page that only fits when more of it travels as
 * identity is served rather than refused, and the two authorities answer the
 * same request the same way (M16-T88, M16-T90).
 */
function servedPage(
  materialized: { entries: unknown[]; leafId: string | null; window: HistoryWindow },
  bodyLimit: number | undefined,
): { entries: unknown[]; leafId: string | null; window: HistoryWindow } | undefined {
  for (const recordLimit of ELIDED_RECORD_LIMITS) {
    const page = withElidedBodies(materialized, bodyLimit, sha256Hex, recordLimit);
    // The exact two-array wire-body size, at the final authority boundary.
    if (historyContentSerializedBytes(page.entries, page.window.context)
      + historyContentSerializedBytes(page.window.elided ?? [], []) <= HISTORY_PAGE_BYTE_LIMIT) return page;
  }
  return undefined;
}

/** Room for identity plus many body metadata rows around retained prose. */
const ELIDED_METADATA_PLANNING_BYTES = 16 * 1024;

/**
 * Plan from exact served-wire bytes, or from the elided form for a row the
 * index can **prove** will be elided.
 *
 * The proof matters more than the estimate. A page is planned before it is read,
 * and the two costs are wildly different: a record that travels whole costs its
 * own length, one elided costs identity and body metadata. `elideOversizedEntries`
 * elides on exactly two facts, and the index carries both — the served length of
 * the record and its largest non-image body — so this asks rather than guesses.
 * Guessing "elided" for every row over the body limit under-priced the ordinary
 * heavy record (a long reply, long reasoning, a few tool calls, every body
 * small) five-fold, and the durable authority then refused pages it had served
 * before; guessing "whole" for every row over it charged 112 KB for rows that
 * cost a fraction of that and shrank pages the live authority served whole.
 *
 * Only a prompt can carry its complete text beside its metadata, and JSON can
 * expand one UTF-8 byte of it to six, so only a prompt is priced for that.
 *
 * The estimate can still be wrong — an elided row's body metadata is unbounded
 * in the number of components a record has — so it is not what makes the page
 * safe: the exact stage re-plans against served bytes rather than refusing
 * ({@link SessionProjection.read}).
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
    const row = entries[index]!;
    if (!willElide(row, bodyLimit)) return row.servedLength;
    const escaped = row.isUser
      ? Math.min(Number.MAX_SAFE_INTEGER - ELIDED_METADATA_PLANNING_BYTES, (bodyLimit ?? 0) * 6)
      : 0;
    return Math.min(row.servedLength, escaped + ELIDED_METADATA_PLANNING_BYTES);
  };
  for (const index of [...selected, ...context]) {
    bytes += cost(index);
    if (bytes > HISTORY_PAGE_BYTE_LIMIT) return false;
  }
  return true;
}

/**
 * Whether a page will leave this row out and list it as identity — the same two
 * facts `elideOversizedEntries` decides on, read from the index instead of from
 * the record: a record larger than any page can carry, or one carrying a body
 * larger than the caller asked to receive. An image is neither: it travels as a
 * reference at any size (M16-T89).
 */
function willElide(row: IndexedEntry, bodyLimit: number | undefined, recordLimit = ELIDED_RECORD_MAX_BYTES): boolean {
  return row.servedLength > recordLimit || (bodyLimit !== undefined && row.largestBodyBytes > bodyLimit);
}

/**
 * The size past which a served row can only travel as identity: the caller's
 * body ceiling when it asked for one, and in every case the record ceiling the
 * page itself imposes (`ELIDED_RECORD_MAX_BYTES`).
 */
function elisionThreshold(bodyLimit?: number): number {
  return Math.min(bodyLimit ?? ELIDED_RECORD_MAX_BYTES, ELIDED_RECORD_MAX_BYTES);
}

/**
 * A plan priced with nothing but served bytes, against a reduced budget.
 *
 * What the exact stage falls back to when its first page did not fit: every row
 * costs what it will cost if it travels whole, which is never less than it can
 * cost, so the page it admits is genuinely smaller. A byte ceiling may shrink a
 * page; it may never refuse one (`docs/transcript-parity.md` §2).
 */
function withinServedBounds(
  entries: readonly IndexedEntry[],
  selected: readonly number[],
  context: readonly number[],
  budget: number,
): boolean {
  if (selected.length > HISTORY_PAGE_ENTRY_LIMIT) return false;
  let bytes = 4 + Math.max(0, selected.length - 1) + Math.max(0, context.length - 1);
  for (const index of [...selected, ...context]) {
    bytes += entries[index]!.servedLength;
    if (bytes > budget) return false;
  }
  return true;
}

/** One-row escape hatch for a source row whose elided form may fit. */
function withinSingleElidedFallback(
  entries: readonly IndexedEntry[],
  selected: readonly number[],
  context: readonly number[],
  bodyLimit?: number,
): boolean {
  if (selected.length !== 1) return false;
  let bytes = 4;
  for (const index of context) bytes += entries[index]!.servedLength;
  if (bytes > HISTORY_PAGE_BYTE_LIMIT) return false;
  const row = entries[selected[0]!]!;
  // Only a row larger than the ceiling it will be elided against can possibly
  // become smaller. The exact materialized check remains final.
  return row.servedLength > elisionThreshold(bodyLimit);
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
