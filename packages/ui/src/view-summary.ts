/**
 * What a session view keeps once its transcript has been released (RP-5).
 *
 * A leaf on purpose: it imports the store's *types* only, so the readers that
 * name a session — the sidebar, the thread list, the fleet, the top bar — can
 * call into it without joining the store's own import cycle.
 *
 * Pure: no React, no DOM.
 */
import type { SessionView } from "./store.js";

/** Why a view's transcript was released. Reported, never guessed. */
export type EvictionReason = "count" | "bytes" | "pressure";

/**
 * The identity of the last authoritative window this view accepted. Bytes are
 * not here on purpose: this is what a dormant view keeps, and it is small.
 */
export interface ValidatedRevision {
  revision: string;
  environmentKey: string;
  epoch: string;
  seq: number;
  /** Durable messages exist in some branch, even when none are loaded here. */
  hasHistory: boolean;
  /** ISO time this window was accepted. */
  at: string;
}

/**
 * What a released transcript leaves behind for the rows that name a session:
 * the sidebar subtitle, the thread-list title, an unlisted fleet root.
 */
export interface SessionViewSummary {
  /** The session's own first user line, when this view held the start of it. */
  firstUser?: string | undefined;
  /** The view held at least one user message. */
  hasUser: boolean;
  /** How many blocks were released, for the counters only. */
  blocks: number;
}

/** A view is dormant when its transcript was released and not read again. */
export const isDormantView = (view: SessionView | undefined): boolean => view?.dormant !== undefined;

/** The longest first line a dormant row keeps. A title, not a transcript. */
const SUMMARY_TEXT_MAX = 120;

/**
 * The first user line this view can honestly claim as the session's first.
 * A window that starts part-way through the conversation claims none, exactly
 * as the live readers already do (`history.userOffset`).
 */
export function summaryOfView(view: SessionView): SessionViewSummary {
  const fromStart = (view.history?.userOffset ?? 0) === 0;
  let firstUser: string | undefined;
  let hasUser = false;
  for (const block of view.blocks) {
    if (block.kind !== "user") continue;
    hasUser = true;
    if (fromStart && firstUser === undefined) firstUser = block.text.replace(/\s+/g, " ").trim().slice(0, SUMMARY_TEXT_MAX);
    if (hasUser && (firstUser !== undefined || !fromStart)) break;
  }
  return { ...(firstUser ? { firstUser } : {}), hasUser, blocks: view.blocks.length };
}

/**
 * The session's first user line for a row that only needs a name: the live
 * transcript when this view holds it, the summary kept at release when it does
 * not. One reader, so a dormant row says what the live one said.
 */
export function viewFirstUserText(view: SessionView | undefined): string | undefined {
  if (!view) return undefined;
  if (isDormantView(view)) return view.summary?.firstUser;
  if ((view.history?.userOffset ?? 0) > 0) return undefined;
  for (const block of view.blocks) if (block.kind === "user") return block.text;
  return undefined;
}

/** Whether this view has a user message, live or from what it kept at release. */
export function viewHasUserMessage(view: SessionView | undefined): boolean {
  if (!view) return false;
  if (isDormantView(view)) return view.summary?.hasUser === true;
  return view.blocks.some((block) => block.kind === "user");
}

/** Durable history exists, live or as the last accepted window said. */
export function viewHasHistory(view: SessionView | undefined): boolean {
  return view?.history?.hasHistory ?? view?.validated?.hasHistory ?? false;
}

/**
 * A message this surface sent that the engine has not persisted yet. It is
 * the person's words and nothing else holds them, so the transcript carrying
 * one is never released.
 */
export function hasUnsentWork(view: SessionView): boolean {
  return view.blocks.some((block) => block.kind === "user" && block.optimistic === true);
}

/**
 * Release one view's transcript, keeping everything a dormant session must
 * still know (RP-5 §2.1). Canonical history, drafts, questions, the tray and
 * the queue are untouched: none of them live here.
 */
export function dehydrateView(view: SessionView, reason: EvictionReason, at: string): SessionView {
  const { history: _window, historyPending: _pending, historyRevision: _revision, pendingSentBy: _sentBy, ...rest } = view;
  return {
    ...rest,
    blocks: [],
    entries: [],
    hydrated: false,
    namerLabels: {},
    summary: summaryOfView(view),
    ...(view.validated ? { validated: view.validated } : {}),
    hydrationEpoch: (view.hydrationEpoch ?? 0) + 1,
    dormant: { at, reason },
  };
}

/** The fence every asynchronous transcript writer captures and re-checks. */
export const hydrationEpochOf = (view: SessionView | undefined): number => view?.hydrationEpoch ?? 0;

/** A view that has read its transcript again is no longer dormant. */
export function awake<T extends SessionView>(view: T): T {
  if (view.dormant === undefined) return view;
  const { dormant: _gone, ...rest } = view;
  return rest as T;
}
