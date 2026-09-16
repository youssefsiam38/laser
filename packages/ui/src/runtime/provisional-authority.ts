/**
 * The lifecycle of a conversation this device painted before the host answered
 * (RP-11), in one place.
 *
 * It owns four things that have to agree with each other, and used to be spread
 * across the provider, the adapter and two action factories:
 *
 * 1. **the paint** — the synchronous, identity-checked transaction that puts
 *    this device's last view of a conversation on screen;
 * 2. **the settlement** — retiring the exact record that was painted, and only
 *    when the host actually replaced it;
 * 3. **warming** — promoting records for a later paint, fenced so a promotion
 *    that lands late can never leave a record the host has already contradicted
 *    behind, or act in an environment it does not belong to;
 * 4. **the fence** — the one synchronous question every host-mutating control
 *    asks before it acts: *is this conversation's authority confirmed?*
 *
 * The fence is addressed by conversation, never globally: a person stopping an
 * agent run or renaming a row in a conversation that is not the one being
 * painted is untouched. What is refused is a mutation aimed at a conversation
 * whose authority this device does not have yet — because it is painted from
 * the cache, because its navigation has not committed, or because it failed and
 * is offering Retry.
 *
 * Pure of React.
 */
import type { AgentRun } from "@lasercode/protocol";

import type { Action, AppState, SessionView } from "../store.js";
import { isMainReady, pendingSessionPath } from "./main-destination.js";
import { provisionalPaintFrom, sessionIdForPath, summaryForPath, type ProvisionalMark } from "./provisional-paint.js";
import { provisionalSource, type ProvisionalSource } from "./provisional-source.js";

/** What a person is told when a conversation's authority is not confirmed yet. */
export const NOT_CONFIRMED = "That conversation is still changing. Your action was not sent.";

/**
 * The fence, as the mutation owners see it. Injected rather than imported so a
 * factory stays testable and so nothing reaches into provider state.
 */
export interface MutationAuthority {
  /** Throw unless this conversation's authority is confirmed. `undefined` passes. */
  assertSession(path: string | undefined): void;
  /** The same question for the conversation an agent run belongs to. */
  assertRun(runId: string): void;
}

/** A fence that refuses nothing: for a surface with no destination of its own. */
export const OPEN_AUTHORITY: MutationAuthority = { assertSession: () => {}, assertRun: () => {} };

export interface ProvisionalAuthorityDeps {
  readState(): AppState;
  dispatch(action: Action): void;
  appVersion: string;
  now?: (() => number) | undefined;
  /** The device cache. Read at the moment of use, never captured at construction. */
  source?: (() => ProvisionalSource) | undefined;
}

export interface ProvisionalAuthority extends MutationAuthority {
  /**
   * Put this device's last view of `path` on screen, in this turn. Paints
   * nothing when there is no valid record for *this exact conversation*, and
   * warms the cache instead so the next visit can be immediate.
   */
  paint(path: string, intent: number): void;
  /**
   * The host has answered for `path`. Retires the record that was painted —
   * and only that record, and only when the answer replaced it.
   */
  settle(path: string): void;
  /**
   * How many paints this owner is still holding the identity of. One, or none:
   * the main window paints one conversation at a time, and a paint that was
   * never settled is replaced by the next rather than kept. For the bound's
   * own test; it carries no path and no revision.
   */
  retainedCaptures(): number;
  /** Promote records for a later paint, fenced against a late landing. */
  warm(targets: readonly { path: string; sessionId: string }[]): void;
  /** The refusal for this conversation, or `undefined` when it may act. */
  refusalForSession(path: string | undefined): string | undefined;
}

/**
 * Is this conversation's authority confirmed?
 *
 * Three states say no, and they are the three RP-11 creates: rows painted from
 * this device (`view.provisional`), a navigation that has not committed
 * (`resolving`), and one that failed and is offering Retry (`unavailable`).
 */
export function sessionAuthorityRefusal(state: AppState, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const view: SessionView | undefined = state.open[path];
  if (view?.provisional !== undefined) return NOT_CONFIRMED;
  const destination = state.destination;
  if (destination && !isMainReady(destination) && pendingSessionPath(destination) === path) return NOT_CONFIRMED;
  return undefined;
}

/**
 * The conversations an agent run belongs to: its own, its parent's and the root
 * of its tree, as the run registry records them. A run is stopped from a
 * conversation, so any of the three being unconfirmed refuses the stop.
 */
export function pathsOfRun(run: AgentRun | undefined): string[] {
  if (!run) return [];
  const paths = [run.sessionPath, run.parent?.sessionPath, run.rootSessionPath];
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && path !== ""))];
}

export function createProvisionalAuthority(deps: ProvisionalAuthorityDeps): ProvisionalAuthority {
  const now = deps.now ?? (() => Date.now());
  const sourceOf = deps.source ?? provisionalSource;
  /**
   * The one paint whose identity is still owed a settlement.
   *
   * Deliberately a single slot rather than a map by path: the main window is
   * painting one conversation at a time, a paint that is never settled — a host
   * that never answered, a person who navigated away — is replaced by the next
   * one, and nothing accumulates per conversation visited. A path this owner is
   * no longer holding simply settles nothing.
   */
  let capture: { path: string; mark: ProvisionalMark } | undefined;

  const refusalForSession = (path: string | undefined): string | undefined =>
    sessionAuthorityRefusal(deps.readState(), path);

  const assertSession = (path: string | undefined): void => {
    const refusal = refusalForSession(path);
    if (refusal) throw new Error(refusal);
  };

  /**
   * Promote records and then check what landed. A promotion that finishes after
   * the host has answered must not leave a record the host contradicted in the
   * hot set: it would be painted on the next visit. A promotion that finishes
   * in another environment, or against a cache this process has replaced, does
   * nothing at all.
   */
  const warm = (targets: readonly { path: string; sessionId: string }[]): void => {
    if (targets.length === 0) return;
    const state = deps.readState();
    const environmentKey = state.environment?.environmentKey;
    if (environmentKey === undefined) return;
    const source = sourceOf();
    void source.prime(targets.map((target) => target.sessionId)).then(() => {
      if (sourceOf() !== source) return;
      const after = deps.readState();
      if (after.environment?.environmentKey !== environmentKey) return;
      for (const target of targets) {
        const record = source.peek({ sessionId: target.sessionId });
        if (!record || record.environmentKey !== environmentKey || record.sessionId !== target.sessionId) continue;
        const validated = after.open[target.path]?.validated;
        // Only what this device can *prove* is stale: an accepted authoritative
        // revision for this very conversation that the record disagrees with.
        if (!validated || validated.sessionId !== target.sessionId) continue;
        if (validated.environmentKey !== environmentKey || validated.revision === record.revision) continue;
        source.supersede(target.sessionId, record.revision);
      }
    }).catch(() => {});
  };

  return {
    refusalForSession,
    assertSession,

    assertRun(runId) {
      const state = deps.readState();
      for (const path of pathsOfRun(state.agents.runs[runId])) {
        const refusal = sessionAuthorityRefusal(state, path);
        if (refusal) throw new Error(refusal);
      }
    },

    paint(path, intent) {
      const state = deps.readState();
      const environmentKey = state.environment?.environmentKey;
      if (environmentKey === undefined) return;
      const existing = state.open[path];
      // Authority, a read in flight, or rows already on screen: nothing to
      // paint. Rows already on screen *from this device* are a different
      // matter: a Retry after a host that would not answer repaints nothing and
      // must still own what is on screen, or the retry could never retire it.
      if (existing && (existing.hydrated || existing.historyPending !== undefined || existing.blocks.length > 0)) {
        capture = existing.provisional ? { path, mark: existing.provisional } : undefined;
        return;
      }
      // Whatever was owed for another conversation is not owed any more: this
      // navigation replaces it.
      capture = undefined;
      const sessionId = sessionIdForPath(state, path);
      if (sessionId === undefined) return;
      const source = sourceOf();
      const record = source.peek({ sessionId });
      if (!record) {
        warm([{ path, sessionId }]);
        return;
      }
      const paint = provisionalPaintFrom(record, {
        path,
        environmentKey,
        expectedSessionId: sessionId,
        appVersion: deps.appVersion,
        now: now(),
        previous: existing,
        summary: summaryForPath(state, path),
      });
      if (!paint) return;
      deps.dispatch({
        type: "views/provisional", path, intent,
        entries: paint.entries, stubs: paint.stubs, leafId: paint.leafId, mark: paint.mark,
        ...(paint.state ? { state: paint.state } : {}),
      });
      // What is on screen, captured **before** anything is asked of the host:
      // the settlement below retires this exact record and no other.
      if (deps.readState().open[path]?.provisional === paint.mark) capture = { path, mark: paint.mark };
    },

    retainedCaptures: () => (capture ? 1 : 0),

    settle(path) {
      if (capture?.path !== path) return;
      const captured = capture.mark;
      capture = undefined;
      const state = deps.readState();
      if (state.environment?.environmentKey !== captured.environmentKey) return;
      const validated = state.open[path]?.validated;
      // Nothing was accepted, or it was accepted for another conversation: this
      // device keeps what it has.
      if (!validated || validated.sessionId !== captured.sessionId) return;
      if (validated.environmentKey !== captured.environmentKey) return;
      // The host agreed with what was painted: the record is still true.
      if (validated.revision === captured.revision) return;
      // It did not: retire exactly the revision that was painted. A newer
      // record released while this was in flight is not it, and survives.
      sourceOf().supersede(captured.sessionId, captured.revision);
    },

    warm,
  };
}
