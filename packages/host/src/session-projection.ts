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
  historyEntriesSerializedBytes,
  historyWindowNode,
  historyWindowPlan,
  type ClientRequests,
  type HistoryWindow,
  type HistoryWindowRequest,
  type HistoryWindowScope,
} from "@lasercode/protocol";
import type { FileIdentity, IndexedEntry, SessionIndex, SessionIndexCache, SessionIndexFailure } from "./session-index.js";
import type { SessionRevisions } from "./session-revision.js";

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

  async read(path: string, requested: HistoryWindowRequest | undefined, baseRevision?: string): Promise<ProjectionAnswer> {
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
      const scope: HistoryWindowScope = {
        sessionId: index.header.id,
        epoch: DURABLE_HISTORY_EPOCH,
        seq: 0,
        revision,
        environmentKey: this.options.revisions.environmentKey,
        authority: "durable",
        mode: base && base.base !== "stale" ? "delta" : "replace",
        ...(base?.state ? { deltaAfter: base.state.leafId } : {}),
      };
      let request = requested ?? { tail: 40 };
      let plan = historyWindowPlan(index.entries, index.leafId, request, scope);

      // A delta is useful only while it remains one bounded page. Otherwise the
      // answer is an explicit replacement, never a partial suffix to mis-splice.
      if (scope.mode === "delta" && !withinPlannedBounds(index.entries, plan.entryIndices, plan.contextIndices)) {
        delete scope.deltaAfter;
        scope.mode = "replace";
        request = replacementRequest(request);
        plan = historyWindowPlan(index.entries, index.leafId, request, scope);
      }
      const bounded = boundedReplacement(index, request, scope, plan);
      if (!bounded) return { kind: "refuse", error: unavailable("No bounded history page can represent the latest turn.") };
      plan = bounded.plan;

      this.options.beforeMaterialize?.(index, attempt);
      const materialized = materialize(path, index, plan.entryIndices, plan.contextIndices, this.options.onMaterializeRead);
      if (materialized.kind === "changed") {
        this.options.index.invalidate(path);
        if (attempt + 1 < MATERIALISE_ATTEMPTS) continue;
        return { kind: "refuse", error: changed() };
      }
      if (materialized.kind === "unreadable") return { kind: "refuse", error: unavailable() };

      const entries = plan.entryIndices.map(index => materialized.values.get(index));
      const context = plan.contextIndices.map(index => materialized.values.get(index));
      if (historyEntriesSerializedBytes([...entries, ...context]) > HISTORY_PAGE_BYTE_LIMIT) {
        // Raw line lengths are a conservative planning bound, but keep this
        // exact serialized-value check at the wire boundary too.
        return { kind: "refuse", error: unavailable("The selected history page is too large to transfer safely.") };
      }
      return {
        kind: "answer",
        result: {
          entries,
          leafId: plan.leafId,
          window: { ...plan.window, context } satisfies HistoryWindow,
        },
      };
    }
    return { kind: "refuse", error: changed() };
  }
}

function boundedReplacement(
  index: SessionIndex,
  request: HistoryWindowRequest,
  scope: HistoryWindowScope,
  initial: ReturnType<typeof historyWindowPlan>,
): { plan: ReturnType<typeof historyWindowPlan> } | undefined {
  if (withinPlannedBounds(index.entries, initial.entryIndices, initial.contextIndices)) return { plan: initial };
  scope.mode = "replace";
  delete scope.deltaAfter;
  const preferred = "tail" in request ? request.tail : "before" in request ? request.limit ?? 40 : 40;
  for (let limit = Math.min(preferred, HISTORY_PAGE_ENTRY_LIMIT); limit >= 1; limit--) {
    const smaller: HistoryWindowRequest = "before" in request ? { before: request.before, limit } : { tail: limit };
    const plan = historyWindowPlan(index.entries, index.leafId, smaller, scope);
    if (withinPlannedBounds(index.entries, plan.entryIndices, plan.contextIndices)) return { plan };
  }
  // An empty conversation has a useful empty page even though there is no turn.
  if (index.entries.length === 0) {
    return { plan: historyWindowPlan(index.entries, index.leafId, { tail: 1 }, scope) };
  }
  return undefined;
}

function replacementRequest(request: HistoryWindowRequest): HistoryWindowRequest {
  if ("tail" in request) return request;
  if ("before" in request) return { tail: request.limit ?? 40 };
  return { tail: 40 };
}

function withinPlannedBounds(entries: readonly IndexedEntry[], selected: readonly number[], context: readonly number[]): boolean {
  const unique = new Set([...selected, ...context]);
  if (unique.size > HISTORY_PAGE_ENTRY_LIMIT) return false;
  // JSON arrays add at most one comma per row and two brackets. Raw JSONL line
  // lengths conservatively include whitespace JSON.stringify may remove.
  let bytes = 2 + Math.max(0, unique.size - 1);
  for (const index of unique) {
    bytes += entries[index]!.length;
    if (bytes > HISTORY_PAGE_BYTE_LIMIT) return false;
  }
  return true;
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
