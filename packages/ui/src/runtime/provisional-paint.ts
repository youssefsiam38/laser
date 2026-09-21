/**
 * Painting a conversation from this device before the host has answered (RP-11).
 *
 * The device cache (RP-10) holds the recent tail of conversations this person
 * has already seen. When one of them is opened again, the rows can be on screen
 * in the same frame as the click — but what is on screen then is **provisional**:
 * it is what this device last saw, not what the host says now.
 *
 * Three rules hold for everything below, and they are the whole point:
 *
 * 1. **Provisional is never authority.** A view painted from here carries a
 *    {@link ProvisionalMark} and no `validated` revision. Nothing may send,
 *    approve, stop, fork, jump or mutate while that mark is present — the
 *    destination is still resolving, so `requireCurrent`/`assertCanAct` already
 *    refuse — and the record it came from is never written back to the cache.
 * 2. **A record that cannot be trusted never paints.** Another environment,
 *    another build, another record schema, an expired capture, or a record with
 *    no usable canonical identity produces nothing at all. There is no partial
 *    paint and no adapted record.
 * 3. **The same bounds as everything else.** Entries go through RP-5b's
 *    {@link retainEntries}, so an oversized body is pointed at, never held and
 *    never rewritten. The cache's own bounds (≤40 entries, ≤256 KiB) already
 *    cap what can arrive here.
 *
 * Pure: no React, no DOM, no storage, no cache instance, and no block building
 * (the reducer owns that, so provisional rows are folded exactly like
 * authoritative ones).
 */
import type { SessionState, SessionSummary } from "@lasercode/protocol";

import type { AppState, SessionView } from "../store.js";
import { retainEntries, type EntryStub } from "./retained-entries.js";
import { TAIL_HARD_LIMITS, TAIL_RECORD_SCHEMA } from "./tail-cache/bounds.js";
import type { TailRecord } from "./tail-cache/record.js";

/** Characters of a session id this will carry. Bounded before it is used. */
export const PROVISIONAL_SESSION_ID_MAX = 128;

/**
 * What a provisional view knows about where it came from.
 *
 * It is deliberately *not* a `ValidatedRevision`: the revision here was
 * authoritative when the record was captured, and may be anything now. It is
 * carried so the reconciliation that follows can say whether the host agreed,
 * and so the cache row can be superseded when it did not.
 */
export interface ProvisionalMark {
  readonly revision: string;
  readonly environmentKey: string;
  readonly sessionId: string;
  readonly epoch: string;
  readonly seq: number;
  /** When the record was captured, as the cache recorded it. */
  readonly capturedAt: string;
  /** When this paint happened. */
  readonly at: string;
}

export interface ProvisionalPaint {
  readonly entries: unknown[];
  readonly stubs: EntryStub[];
  readonly leafId: string | null;
  readonly mark: ProvisionalMark;
  /**
   * A placeholder for a conversation this page has no session state for yet.
   * Present only when there is no open view to paint into. Nothing renders it
   * as model, thinking, mode or usage metadata: the composer's metadata
   * controls are not mounted while a view is fenced, and every reader of those
   * fields reads the *committed* session, which a provisional view is not.
   * `session/load` replaces it whole.
   */
  readonly state?: SessionState | undefined;
}

/** Why a record was refused. Reported by {@link provisionalPaintFrom} in tests. */
export type ProvisionalRefusal =
  | "schema"
  | "app-version"
  | "environment"
  | "identity"
  | "foreign-session"
  | "revision"
  | "expired"
  | "empty";

export interface ProvisionalPaintOptions {
  path: string;
  /**
   * The session this paint is for, from canonical state. A record that is not
   * this exact conversation's never paints, however well formed it is and
   * whatever handed it over: the cache's authenticated lookup is the first
   * layer of that boundary, and this is the second.
   */
  expectedSessionId: string;
  /** The environment the open connection is in. A record from another never paints. */
  environmentKey: string;
  /** This build. A record written by another build of the app never paints. */
  appVersion: string;
  now: number;
  /** The view this would paint into, when the page still holds one. */
  previous?: SessionView | undefined;
  /** The catalog row, for the placeholder state of a view this page lacks. */
  summary?: SessionSummary | undefined;
  /** Age ceiling; the cache's hard limit unless a narrower one is given. */
  maxAgeMs?: number | undefined;
}

const DEFAULT_MAX_AGE_MS = TAIL_HARD_LIMITS.ageHours * 60 * 60 * 1000;

const boundedId = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" && value.length <= PROVISIONAL_SESSION_ID_MAX ? value : undefined;

/**
 * The opaque id of the conversation at this path, from canonical state.
 *
 * The device cache is addressed by the session's own id and never by a path
 * (RP-10). The open view's authoritative session state comes first, then the
 * catalog row; nothing here reads a path or an entry for an identity.
 */
export function sessionIdForPath(state: AppState, path: string): string | undefined {
  return boundedId(state.open[path]?.state.id)
    ?? boundedId(state.sessions.find((summary) => summary.path === path)?.id);
}

/** The catalog row for a path, when the catalog has one. */
export function summaryForPath(state: AppState, path: string): SessionSummary | undefined {
  return state.sessions.find((summary) => summary.path === path);
}

/**
 * May this record be painted at all? Identity, provenance and age only — the
 * bytes were authenticated by the cache before they were handed out.
 */
export function refusalFor(record: TailRecord, options: ProvisionalPaintOptions): ProvisionalRefusal | undefined {
  if (record.schema !== TAIL_RECORD_SCHEMA) return "schema";
  if (record.appVersion !== options.appVersion) return "app-version";
  if (record.environmentKey !== options.environmentKey) return "environment";
  if (boundedId(record.sessionId) === undefined) return "identity";
  if (record.sessionId !== options.expectedSessionId) return "foreign-session";
  if (typeof record.revision !== "string" || record.revision === "") return "revision";
  const captured = Date.parse(record.capturedAt);
  const age = Number.isFinite(captured) ? options.now - captured : Number.POSITIVE_INFINITY;
  if (!(age >= 0) || age > (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) return "expired";
  if (record.entries.length === 0) return "empty";
  return undefined;
}

/**
 * A placeholder session state for a conversation this page has never opened.
 *
 * Every field that can be true is taken from the catalog row the host
 * published; the rest are the neutral values a session that has told us
 * nothing has. It exists because `SessionView.state` is required, it is marked
 * provisional on the view that carries it, and `session/load` replaces it in
 * full before anything may act on the conversation.
 */
export function placeholderStateFor(path: string, sessionId: string, summary: SessionSummary | undefined): SessionState {
  return {
    path,
    id: sessionId,
    cwd: summary?.cwd ?? "",
    ...(summary?.name !== undefined ? { name: summary.name } : {}),
    model: null,
    // Nothing is known about this conversation's intent until `session/load`
    // answers; a profile guessed from a catalog row would be a claim.
    profile: null,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: false,
    messageCount: summary?.messageCount ?? 0,
    pendingMessageCount: 0,
    ...(summary?.agent !== undefined ? { agent: summary.agent } : {}),
  };
}

/**
 * Turn one cached record into the rows a provisional view holds, or nothing.
 *
 * The entries arrive as the strings the authority produced; a row this build
 * cannot parse is dropped rather than guessed at, and the rest still paint.
 */
export function provisionalPaintFrom(
  record: TailRecord,
  options: ProvisionalPaintOptions,
): ProvisionalPaint | undefined {
  if (refusalFor(record, options) !== undefined) return undefined;
  const parsed: unknown[] = [];
  for (const entry of record.entries) {
    try {
      const value: unknown = JSON.parse(entry.json);
      if (value && typeof value === "object" && (value as { id?: unknown }).id === entry.id) parsed.push(value);
    } catch {
      // One unreadable row is one row: the conversation around it still paints.
    }
  }
  if (parsed.length === 0) return undefined;
  // RP-5b: a record carrying a body larger than this view may hold is pointed
  // at, never rewritten to fit.
  const retained = retainEntries(parsed);
  if (retained.entries.length === 0 && retained.stubs.length === 0) return undefined;
  const mark: ProvisionalMark = {
    revision: record.revision,
    environmentKey: record.environmentKey,
    sessionId: record.sessionId,
    epoch: record.epoch,
    seq: record.seq,
    capturedAt: record.capturedAt,
    at: new Date(options.now).toISOString(),
  };
  return {
    entries: retained.entries,
    stubs: retained.stubs,
    leafId: record.leafId,
    mark,
    ...(options.previous ? {} : { state: placeholderStateFor(options.path, record.sessionId, options.summary) }),
  };
}
