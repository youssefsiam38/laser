/**
 * What a session view keeps once its transcript has been released (RP-5).
 *
 * A leaf on purpose: it imports the store's *types* only, so the readers that
 * name a session — the sidebar, the thread list, the fleet, the top bar — can
 * call into it without joining the store's own import cycle.
 *
 * Pure: no React, no DOM.
 */
import type { Block, SessionView } from "./store.js";

/** Why a view's transcript was released. Reported, never guessed. */
export type EvictionReason = "count" | "bytes" | "pressure";

/**
 * The identity of the last authoritative window this view accepted. Bytes are
 * not here on purpose: this is what a dormant view keeps, and it is small.
 */
export interface ValidatedRevision {
  revision: string;
  /**
   * The session's own durable id, as the authoritative session state gives it
   * (`SessionState.id`). Never a path and never read out of an entry: a cache
   * (RP-10) keys by this, and an identity guessed from storage is not one.
   * Absent only when the state carried none or one this refused to bound.
   */
  sessionId?: string | undefined;
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
    stubs: [],
    hydrated: false,
    namerLabels: {},
    // Nothing painted from this device survives a release: the next open reads
    // it again, from the cache or from the host (RP-11).
    provisional: undefined,
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

/**
 * Release the **older settled part** of one view, keeping the newest turns
 * (RP-5b).
 *
 * This is what makes the per-view byte bound true for a conversation somebody
 * is using: a view that is pinned — current, running, holding a question,
 * holding a draft — is never dehydrated, so without this it could grow without
 * limit. It is not eviction: the session stays open, its transcript stays on
 * screen, and everything the person is doing with it is untouched.
 *
 * Never released: the streaming turn, a row carrying a question or an
 * approval, the person's own unsent prompt, and the rows the caller names as
 * anchored (the message the viewport sits on and the focused one). Goal
 * records, drafts, the tray, the queue and every identity are untouched.
 *
 * `userOffset` rises by exactly the prompts that went, so ordinals, "the first
 * message of this conversation" and every message action keep their meaning;
 * the page cursor is dropped rather than invented, because only a producer can
 * mint one. What was released is read again through the ordinary bounded tail
 * read, exactly like re-entering a released conversation.
 */
export interface TrimOptions {
  /** Exact UTF-8 bytes of hydrated content this view may keep. */
  keepBytes: number;
  /** Exact bytes of one block, from the same estimator the cache uses. */
  measure: (block: Block) => number;
  /** Rows that must not be released whatever their age. */
  anchored?: ReadonlySet<string> | undefined;
  /** Entry ids carrying a question or an approval. */
  answerable?: ReadonlySet<string> | undefined;
  /**
   * What the surface is standing on: identity strings only, carried into the
   * stamp so a replacement page can be checked against them (RP-5b §7).
   */
  standing?: { anchorEntryId?: string; focusedEntryId?: string; actionTargetEntryIds?: readonly string[] } | undefined;
}

export interface TrimResult {
  view: SessionView;
  releasedBlocks: number;
  releasedBytes: number;
  releasedPrompts: number;
}

export function trimView(view: SessionView, options: TrimOptions, at: string): TrimResult {
  const none: TrimResult = { view, releasedBlocks: 0, releasedBytes: 0, releasedPrompts: 0 };
  if (view.dormant !== undefined) return none;
  const keep = Math.max(0, options.keepBytes);
  const sizes = view.blocks.map(options.measure);
  const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
  if (total <= keep) return none;

  // Walk from the newest backwards, keeping whole turns until the budget is
  // spent; a turn starts at the prompt that began it.
  const held = new Set<number>();
  let bytes = 0;
  let cut = view.blocks.length;
  for (let index = view.blocks.length - 1; index >= 0; index--) {
    const block = view.blocks[index]!;
    const keepAlways = isUnreleasable(block, options);
    const next = bytes + sizes[index]!;
    if (!keepAlways && next > keep && index < view.blocks.length - 1) { cut = index + 1; break; }
    bytes = next;
    held.add(index);
    cut = index;
  }
  // Anything above the cut that must not be released stays where it is.
  for (let index = 0; index < cut; index++) if (isUnreleasable(view.blocks[index]!, options)) held.add(index);
  if (held.size === view.blocks.length) return none;

  const blocks = view.blocks.filter((_, index) => held.has(index));
  const releasedPrompts = view.blocks.filter((block, index) => !held.has(index) && block.kind === "user").length;
  const releasedBytes = sizes.reduce((sum, size, index) => held.has(index) ? sum : sum + size, 0);
  // Only the records of the rows that were actually released go with them. A
  // record whose row carries no entry id — a turn this surface watched arrive
  // and has not read back yet — is nobody's to drop.
  const releasedIds = new Set(view.blocks.flatMap((block, index) =>
    held.has(index) ? [] : entryIdOf(block) ? [entryIdOf(block)!] : []));
  const entries = view.entries.filter(entry => !releasedIds.has(idOfEntry(entry) ?? ""));
  const stubs = (view.stubs ?? []).filter(stub => !releasedIds.has(stub.id));
  const anchor = entries.length > 0 ? idOfEntry(entries[0]) : undefined;
  const { history, ...rest } = view;
  let window: SessionView["history"];
  if (history) {
    // A cursor is the producer's to mint; this view simply no longer has one.
    const { before: _cursor, anchor: _anchor, ...page } = history;
    window = { ...page, complete: false, userOffset: history.userOffset + releasedPrompts, ...(anchor !== undefined ? { anchor } : {}) };
  }
  const trimmed: SessionView = {
    ...rest,
    blocks,
    entries,
    stubs,
    ...(window ? { history: window } : {}),
    trimmed: {
      at,
      prompts: releasedPrompts,
      // Tens of bytes, measured with the view like everything else it keeps.
      ...(options.standing || view.leafId !== undefined
        ? {
            identities: {
              ...(options.standing?.anchorEntryId ? { anchorEntryId: options.standing.anchorEntryId } : {}),
              ...(options.standing?.focusedEntryId ? { focusedEntryId: options.standing.focusedEntryId } : {}),
              ...(options.standing?.actionTargetEntryIds?.length ? { actionTargetEntryIds: [...options.standing.actionTargetEntryIds] } : {}),
              ...(view.leafId !== undefined ? { leafId: view.leafId } : {}),
            },
          }
        : {}),
    },
  };
  return { view: trimmed, releasedBlocks: view.blocks.length - blocks.length, releasedBytes, releasedPrompts };
}

function isUnreleasable(block: Block, options: TrimOptions): boolean {
  if (block.kind === "user" && block.optimistic === true) return true;
  if (block.kind === "assistant" && block.streaming) return true;
  if (block.kind === "tool" && !block.done) return true;
  const id = entryIdOf(block);
  if (id !== undefined && (options.anchored?.has(id) || options.answerable?.has(id))) return true;
  return options.anchored?.has(block.id) === true || options.answerable?.has(block.id) === true;
}

function entryIdOf(block: Block): string | undefined {
  return "entryId" in block ? block.entryId : undefined;
}

function idOfEntry(entry: unknown): string | undefined {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}
