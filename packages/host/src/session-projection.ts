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

/**
 * What one elided row costs on the wire: identity plus one metadata row per
 * body. Conservative, and only used to plan — the exact size is checked again
 * on the real page before it is answered.
 */
const ELIDED_ROW_ESTIMATE = 1024;

function withinPlannedBounds(entries: readonly IndexedEntry[], selected: readonly number[], context: readonly number[], bodyLimit?: number): boolean {
  const unique = new Set([...selected, ...context]);
  if (unique.size > HISTORY_PAGE_ENTRY_LIMIT) return false;
  // Two JSON arrays contribute four brackets and their own commas. The index
  // retained each row's exact parse/stringify UTF-8 length, so this is the same
  // body accounting used after materialization and by the live authority.
  let bytes = 4 + Math.max(0, selected.length - 1) + Math.max(0, context.length - 1);
  const cost = (index: number): number => {
    const length = entries[index]!.serializedLength;
    // A row no larger than the caller's per-body limit cannot carry a body
    // larger than it; a bigger row may be elided, and is planned as such.
    return bodyLimit !== undefined && length > bodyLimit ? ELIDED_ROW_ESTIMATE : length;
  };
  for (const index of selected) {
    bytes += cost(index);
    if (bytes > HISTORY_PAGE_BYTE_LIMIT) return false;
  }
  for (const index of context) {
    bytes += cost(index);
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
