import {
  ErrorCodes,
  HISTORY_EARLIER_PAGE_TURNS,
  HISTORY_FIRST_PAGE_TURNS,
  type ClientRequests,
  type HistoryWindow,
  type HistoryWindowRequest,
  type SessionUpdateParams,
} from "@lasercode/protocol";
import type { applyUpdate, blocksFromEntries, modelNamesOf, stampNewBlocks, textOf, Action, Block, HistoryViewState, SessionView, ValidatedRevision } from "../store.js";
import { awake } from "../view-summary.js";
import { retainEntries, stubOfElided, mergeStubs, type EntryStub } from "./retained-entries.js";
import { BODY_EXCERPT_MAX_BYTES, tailOfParts, type BodyRef } from "./body-excerpt.js";

import { deepEqual } from "./projection.js";

export type HistoryAction =
  | { type: "historyBegin"; path: string; token: string }
  | { type: "historyReset"; path: string; token: string }
  | { type: "historyEnd"; path: string; token: string }
  | { type: "historySnapshot"; path: string; token: string; entries: unknown[]; leafId?: string | null; window: HistoryWindow; replaceWindow?: true; keepStubs?: readonly EntryStub[] }
  /**
   * An append-only suffix the host proved against a revision this view still
   * holds (`mode: "delta"`, RP-9/RP-11). It is folded through the canonical
   * snapshot below — live turn, buffered updates, unsent prompts, block
   * identity and all — over the merged entry set, so a delta can never lose an
   * update that overtook it. Refused, whole, when the base has moved.
   */
  | { type: "historyDelta"; path: string; token: string; baseRevision: string; entries: unknown[]; leafId?: string | null | undefined; window: HistoryWindow }
  | { type: "historyPrepend"; path: string; before: string; anchor: string; baseRevision: string; entries: unknown[]; window: HistoryWindow; ownerRevision?: string | undefined }
  /** Bounded recovery before a retained anchor; it extends and never replaces. */
  | { type: "historyRecover"; path: string; anchor: string; baseRevision: string; expectedBefore?: string | undefined; trimAt?: string | undefined; entries: unknown[]; window: HistoryWindow; ownerRevision?: string | undefined }
  | { type: "historyPageRefused"; path: string; cause: "stale-base"; message: string };

/** Adopt a newer revision only after the producer proved the held base prefix. */
function adoptProvedPage(next: SessionView, previous: SessionView, window: Omit<HistoryWindow, "live">, baseRevision: string): SessionView {
  const covered = previous.validated ?? (previous.history?.revision === baseRevision ? validatedOf(previous.history, previous) : undefined);
  if (coveredBaselineOf(previous) !== baseRevision || !covered) {
    const { validated: _stale, ...rest } = next;
    return rest as SessionView;
  }
  // Prefix proof says the rows covered by the held baseline are unchanged; an
  // older page at a newer producer revision does not carry that revision's
  // unseen suffix. Keep the covered baseline until a delta acquires it.
  return { ...next, validated: window.revision === baseRevision ? validatedOf(window, next) : covered };
}

function coveredBaselineOf(view: SessionView | undefined): string | undefined {
  return view?.validated?.revision ?? view?.history?.revision;
}

function validatedOf(window: Omit<HistoryWindow, "live">, view: SessionView): ValidatedRevision {
  return { revision: window.revision, environmentKey: window.environmentKey, epoch: window.epoch, seq: window.seq,
    hasHistory: window.hasHistory, at: new Date().toISOString(), ...(sessionIdOf(view) ? { sessionId: sessionIdOf(view)! } : {}) };
}

/** Characters of a session id this keeps. Bounded before it is retained. */
const SESSION_ID_MAX = 128;

/**
 * The session's own durable id, from the state the worker published. Bounded,
 * and never invented: a view whose state carries none keeps none, and the
 * record it releases says so rather than carrying a guess.
 */
function sessionIdOf(view: SessionView): string | undefined {
  const id = (view.state as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id !== "" && id.length <= SESSION_ID_MAX ? id : undefined;
}

export const hasCompleteTree = (view: SessionView | undefined): boolean =>
  view?.history ? view.history.complete && !view.history.branchesUnloaded : Boolean(view?.hydrated);

/** The bodies a live message is only holding the tail of, if any. */
function liveBodies(text: BodyRef | undefined, thinking: BodyRef | undefined): { text?: BodyRef; thinking?: BodyRef } | undefined {
  if (!text && !thinking) return undefined;
  return { ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}

/** User/tool ids are canonical. Only assistants lack persisted ids in live events. */
function shareHistoryBlocks(next: Block[], previous: Block[]): Block[] {
  const byId = new Map(previous.map(block => [block.id, block]));
  const assistants = new Map<string, Block[]>();
  let turn = "";
  for (const block of previous) {
    if (block.kind === "user") turn = block.id;
    if (block.kind === "assistant") {
      const rows = assistants.get(turn) ?? [];
      rows.push(block); assistants.set(turn, rows);
    }
  }
  let ordinal = 0;
  turn = "";
  return next.map(block => {
    if (block.kind === "user") { turn = block.id; ordinal = 0; }
    const priorAssistant = block.kind === "assistant" ? assistants.get(turn)?.[ordinal++] : undefined;
    const old = byId.get(block.id) ?? priorAssistant;
    if (!old || old.kind !== block.kind) return block;
    const shared = block.id === old.id ? block : { ...block, id: old.id };
    return deepEqual(shared, old) ? old : shared;
  });
}

interface HistoryFold {
  applyUpdate: typeof applyUpdate;
  blocksFromEntries: typeof blocksFromEntries;
  modelNamesOf: typeof modelNamesOf;
  stampNewBlocks: typeof stampNewBlocks;
  textOf: typeof textOf;
}

/**
 * The tuple a released record is keyed by describes an exact set of entries on
 * an exact leaf. A live update that appends an entry or moves the leaf makes
 * that no longer true, and nothing here can compute the new revision: the
 * honest answer is to stop claiming one until an authoritative window says
 * what it is (RP-5/RP-10).
 */
function keepValidated(before: SessionView, after: SessionView): SessionView {
  if (after.validated === undefined) return after;
  if (before.entries === after.entries && before.leafId === after.leafId) return after;
  const { validated: _stale, ...rest } = after;
  return rest as SessionView;
}

const entryId = (entry: unknown): string | undefined => {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
};

/**
 * Insert a producer page at its exclusive boundary, preserving later islands.
 * The boundary is the oldest row this view holds. It is not always among the
 * entries it renders: an oversized record the page left out is held as a stub,
 * and a conversation whose oldest loaded row is one of those has no entry to
 * find. A `before` page is older than everything held by construction — every
 * identity, revision and environment fence has already been checked — so when
 * the boundary is not an entry the page belongs at the front rather than being
 * refused. Refusing it silently is what left a long conversation asking the
 * producer for the same page for ever (D-302).
 */
function insertBefore<T>(held: readonly T[], incoming: readonly T[], boundary: string, idOf: (value: T) => string | undefined): T[] {
  const at = held.findIndex(value => idOf(value) === boundary);
  return at < 0 ? [...incoming, ...held] : [...held.slice(0, at), ...incoming, ...held.slice(at)];
}

/**
 * The record a page's cursor names is a row of the conversation whether or not
 * this view holds it whole. A turn page begins at its prompt, and a prompt too
 * large for the page's body bound is delivered as a stub, not an entry — so the
 * next earlier page is anchored at an id that `entries` does not contain. Read
 * as "not held", that anchor put the page at the front of everything, ahead of
 * the stub's own row, and every page after it was inserted behind that row:
 * an eighteen-kilobyte prompt from the middle of a conversation sat above its
 * first message, as an empty bubble with "Show full message" (the 0.11.0
 * screenshot). The boundary in `entries` for a stubbed anchor is the first held
 * record that continues it: its child, or the child of a stub that descends
 * from it. Only an anchor nothing here descends from belongs at the front.
 */
function entryBoundaryOf(view: Pick<SessionView, "entries" | "stubs">, anchor: string): string {
  if (view.entries.some(entry => entryId(entry) === anchor)) return anchor;
  const stubs = new Map((view.stubs ?? []).map(stub => [stub.id, stub] as const));
  if (!stubs.has(anchor)) return anchor;
  // Walk down through stubs only: the first record held whole under the anchor
  // is where the anchor's row stands among `entries`.
  const frontier = new Set([anchor]);
  for (let depth = 0; depth < stubs.size + 1 && frontier.size > 0; depth += 1) {
    for (const entry of view.entries) {
      const parent = (entry as { parentId?: unknown } | null)?.parentId;
      if (typeof parent === "string" && frontier.has(parent)) {
        const id = entryId(entry);
        if (id) return id;
      }
    }
    const next = new Set<string>();
    for (const stub of stubs.values()) if (stub.parentId && frontier.has(stub.parentId)) next.add(stub.id);
    frontier.clear();
    for (const id of next) frontier.add(id);
  }
  return anchor;
}

type ActiveAncestry = { kind: "complete" } | { kind: "gap"; before: string } | { kind: "unknown" };

/** Prove the active ancestry whole, or name its first missing parent. */
function activeAncestry(view: Pick<SessionView, "entries" | "stubs" | "leafId">): ActiveAncestry {
  const records = new Map<string, { parentId: string | null }>();
  for (const entry of view.entries) {
    const value = entry as { id?: unknown; parentId?: unknown } | null;
    if (typeof value?.id === "string") records.set(value.id, { parentId: typeof value.parentId === "string" ? value.parentId : null });
  }
  for (const stub of view.stubs ?? []) records.set(stub.id, { parentId: stub.parentId });
  // Only the producer-owned leaf proves active ancestry. Never infer a gap
  // from the last locally appended/live-only row.
  let id = view.leafId;
  if (typeof id !== "string") return id === null ? { kind: "complete" } : { kind: "unknown" };
  const visited = new Set<string>();
  while (typeof id === "string") {
    if (visited.has(id)) return { kind: "unknown" };
    visited.add(id);
    const record = records.get(id);
    if (!record) return { kind: "unknown" };
    if (record.parentId === null) return { kind: "complete" };
    if (!records.has(record.parentId)) return { kind: "gap", before: id };
    id = record.parentId;
  }
  return { kind: "unknown" };
}

function acceptsPage(view: SessionView, action: Extract<HistoryAction, { type: "historyPrepend" | "historyRecover" }>): boolean {
  const held = view.history;
  if (!held || view.historyRevision !== action.ownerRevision || coveredBaselineOf(view) !== action.baseRevision
    || (held.anchor !== action.anchor && held.gapBefore !== action.anchor) || held.epoch !== action.window.epoch
    || held.environmentKey !== action.window.environmentKey) return false;
  if (action.type === "historyPrepend") return held.before === action.before;
  return held.before === action.expectedBefore && (action.trimAt === undefined || view.trimmed?.at === action.trimAt);
}

/** Keep lower-sequence new-generation events until a snapshot can adopt them. */
export function receiveHistoryUpdate(v: SessionView, p: SessionUpdateParams, { applyUpdate, stampNewBlocks }: HistoryFold): SessionView {
  const historyPending = v.historyPending ? { ...v.historyPending, updates: [...v.historyPending.updates, p] } : undefined;
  const epoch = v.history?.epoch ?? v.updateEpoch;
  if (p.seq <= v.lastSeq || (p.epoch && epoch && p.epoch !== epoch)) return historyPending ? { ...v, historyPending } : v;
  const next = applyUpdate(v, p.update);
  return keepValidated(v, { ...next, blocks: stampNewBlocks(v.blocks, next.blocks, p.at), lastSeq: p.seq,
    ...(p.epoch ? { updateEpoch: p.epoch } : {}), ...(historyPending ? { historyPending } : {}) });
}

/** The store routes history actions here; its ordinary event fold stays authoritative. */
export function reduceHistory(v: SessionView, action: HistoryAction, { applyUpdate, blocksFromEntries, modelNamesOf, stampNewBlocks, textOf }: HistoryFold): SessionView {
  switch (action.type) {
    // A read of this surface's own window has started: it is no longer a
    // released transcript, and the updates that arrive while it is in flight
    // belong in the buffer below rather than being dropped as dormant.
    case "historyBegin": return { ...awake(v), historyPending: { token: action.token, updates: [] } };
    case "historyReset": {
      // The loaded window goes before its replacement is requested, so no older
      // expanded transcript is on screen while the recent one is in flight. A
      // message this surface has already sent is not history and stays.
      if (v.historyPending?.token !== action.token) return v;
      const { history: _window, historyRevision: _revision, ...rest } = v;
      // A fresh authoritative read replaces what a trim released, cursor and
      // all: this view is what the authority just said it is (RP-5b).
      const { trimmed: _trimmed, ...reset } = rest as SessionView;
      return { ...awake(reset as SessionView), entries: [], stubs: [], blocks: v.blocks.filter(block => block.kind === "user" && block.optimistic), hydrated: false };
    }
    case "historyEnd": return v.historyPending?.token === action.token ? { ...v, historyPending: undefined } : v;
    case "historySnapshot": {
      if (v.historyPending?.token !== action.token) return v;
      const { live, ...window } = action.window;
      const oldEpoch = v.history?.epoch ?? v.updateEpoch;
      const changedEpoch = oldEpoch !== undefined && oldEpoch !== window.epoch;
      // A branch read moves the leaf; it does not unload the immutable tree
      // already fetched in this worker generation. Merge its fresh suffix
      // into that tree so known siblings remain immediately navigable. A new
      // epoch or an authoritative complete snapshot still replaces the cache.
      const retainTree = !action.replaceWindow && oldEpoch === window.epoch && hasCompleteTree(v) && (!window.complete || window.branchesUnloaded);
      // RP-5b: records larger than this view may hold are pointed at, never
      // rewritten, and the producer's own elisions fold in the same way.
      const incoming = retainEntries(action.entries);
      const elided = (action.window.elided ?? []).map(stubOfElided);
      const entries = retainTree ? [...new Map([...v.entries, ...incoming.entries].map(entry => [(entry as { id: string }).id, entry])).values()] : incoming.entries;
      // `keepStubs` is how a page that *extends* what this view holds keeps the
      // rows it already points at (RP-11 delta). A replacement carries none.
      const stubs = retainTree ? mergeStubs(v.stubs ?? [], [...incoming.stubs, ...elided]) : mergeStubs(action.keepStubs ?? [], [...incoming.stubs, ...elided]);
      const history = retainTree ? { ...window, complete: true, branchesUnloaded: false, userOffset: 0, context: [], priorGoalIds: [] } : window;
      if (retainTree) delete history.before;
      const { trimmed: _released, ...base } = v;
      let next: SessionView = { ...awake(base as SessionView), entries, stubs, leafId: action.leafId, history, hydrated: true, validated: validatedOf(window, v),
        // The host has answered: nothing on screen is this device's guess now.
        provisional: undefined,
        historyRevision: action.replaceWindow ? action.token : v.historyRevision,
        blocks: blocksFromEntries(entries, action.leafId, modelNamesOf(v.state), { stubs, revision: window.revision }),
        running: live?.running ?? v.running, lastSeq: action.window.seq, updateEpoch: history.epoch, pendingSentBy: undefined, historyPending: undefined };
      if (live?.message) {
        // A turn in flight can be megabytes, and it arrives beside a page this
        // view has already bounded. It goes through the same live tail as a
        // streamed one: newest bytes kept, the rest counted and readable when
        // the turn is written. No durable identity is invented for it.
        const message = live.message.value as { content?: unknown };
        const parts = Array.isArray(message.content) ? message.content as { type?: string; text?: string; thinking?: string }[] : [];
        const prose = tailOfParts(parts.filter(part => part.type === "text").map(part => part.text ?? ""), { component: { kind: "assistant_text" } });
        const reasoning = tailOfParts(parts.filter(part => part.type === "thinking").map(part => part.thinking ?? ""), { component: { kind: "reasoning" } });
        const bodies = liveBodies(prose.ref, reasoning.ref);
        next.blocks.push({ kind: "assistant", id: live.message.id, text: prose.text, thinking: reasoning.text, streaming: true,
          ...(bodies ? { bodies } : {}),
          ...(live.message.speaker ? { speaker: live.message.speaker } : {}) });
      }
      for (const tool of live?.tools ?? []) {
        if (!next.blocks.some(b => b.kind === "tool" && b.id === tool.toolCallId)) next = applyUpdate(next, { kind: "tool_execution_start", ...tool });
        if (tool.partial !== undefined) next = applyUpdate(next, { kind: "tool_execution_update", toolCallId: tool.toolCallId, partial: tool.partial });
      }
      for (const update of v.historyPending.updates) {
        if (update.epoch ? update.epoch !== history.epoch : changedEpoch) continue;
        if (update.seq <= next.lastSeq) continue;
        const applied = applyUpdate(next, update.update);
        next = { ...applied, blocks: stampNewBlocks(next.blocks, applied.blocks, update.at), lastSeq: update.seq };
      }
      // A prompt this surface sent and the authority has not published yet
      // stays on screen. One it *has* published must not: the stand-in and the
      // canonical row never share an id — the stand-in's is a local block id,
      // the record's is `entry:<id>` — so an id-only test re-appended a copy
      // of the person's own message at the end of the transcript, dimmed, for
      // ever (every later snapshot re-appended it again). It is settled when
      // the page's newest prompt is the same words: prompts are serial, so a
      // stand-in still waiting is always for a turn after everything the page
      // holds.
      const newestPrompt = [...next.blocks].reverse().find(b => b.kind === "user" && !b.optimistic);
      const settledText = newestPrompt?.kind === "user" ? newestPrompt.text : undefined;
      const optimistic = v.blocks.filter(b => b.kind === "user" && b.optimistic
        && (settledText === undefined || b.text !== settledText));
      const existingIds = new Set(next.blocks.map(b => b.id));
      next.blocks = [...next.blocks, ...optimistic.filter(b => !existingIds.has(b.id))];
      const settled: SessionView = { ...next, blocks: shareHistoryBlocks(next.blocks, v.blocks),
        lastSeq: changedEpoch ? next.lastSeq : Math.max(next.lastSeq, v.lastSeq) };
      // The buffered updates replayed above can have appended an entry or moved
      // the leaf since the window was read: then the window's revision no
      // longer describes what this view holds.
      return settled.entries === entries && settled.leafId === action.leafId
        ? settled : keepValidated({ ...settled, entries, leafId: action.leafId }, settled);
    }
    case "historyDelta": {
      if (v.historyPending?.token !== action.token) return v;
      const base = v.validated;
      const held = v.history;
      // Every fence, and all of them: this view must still hold the exact
      // authoritative window the host proved the suffix against, in this
      // environment and this worker generation. Anything else is replaced.
      if (!base || !held || base.revision !== action.baseRevision
        || (held.revision !== action.baseRevision && held.revision !== action.window.revision)
        || base.environmentKey !== action.window.environmentKey || held.environmentKey !== action.window.environmentKey
        || held.epoch !== action.window.epoch) return v;
      const known = new Set<string>();
      for (const entry of v.entries) {
        const id = (entry as { id?: unknown } | null)?.id;
        if (typeof id === "string") known.add(id);
      }
      for (const stub of v.stubs ?? []) known.add(stub.id);
      const suffix = action.entries.filter(entry => {
        const id = (entry as { id?: unknown } | null)?.id;
        return typeof id === "string" && !known.has(id);
      });
      // A delta's own page metadata describes the suffix it carries, not the
      // conversation this view holds: the cached cursor, anchor, coverage and
      // goal context stay exactly as they were, and only the live edge moves.
      const { before: _suffixCursor, anchor: _suffixAnchor, ...answered } = action.window;
      const window: HistoryWindow = {
        ...answered,
        ...(held.before !== undefined ? { before: held.before } : {}),
        ...(held.anchor !== undefined ? { anchor: held.anchor } : {}),
        userOffset: held.userOffset,
        complete: held.complete,
        branchesUnloaded: held.branchesUnloaded || action.window.branchesUnloaded,
        hasHistory: held.hasHistory || action.window.hasHistory,
        context: held.context,
        priorGoalIds: held.priorGoalIds,
      };
      return reduceHistory(v, {
        type: "historySnapshot", path: action.path, token: action.token, window, replaceWindow: true,
        entries: [...v.entries, ...suffix], keepStubs: v.stubs ?? [],
        ...(action.leafId !== undefined ? { leafId: action.leafId } : {}),
      }, { applyUpdate, blocksFromEntries, modelNamesOf, stampNewBlocks, textOf });
    }
    case "historyPageRefused": {
      if (!v.history) return v;
      return { ...v, history: { ...v.history, refusal: { cause: action.cause, message: action.message } } };
    }
    case "historyPrepend":
    case "historyRecover": {
      const held = v.history;
      if (!held || !acceptsPage(v, action)) return v;
      const ids = new Set([...v.entries.map(entryId), ...(v.stubs ?? []).map(stub => stub.id)]);
      const projected = retainEntries(action.entries);
      const retained = retainEntries(action.entries.filter(entry => !ids.has(entryId(entry))));
      const allWireStubs = (action.window.elided ?? []).map(stubOfElided);
      const wireStubs = allWireStubs.filter(stub => !ids.has(stub.id));
      const incomingStubs = mergeStubs(retained.stubs, wireStubs);
      const entryBoundary = entryBoundaryOf(v, action.anchor);
      const entries = insertBefore(v.entries, retained.entries, entryBoundary, entryId);
      const projectedStubs = mergeStubs(projected.stubs, allWireStubs);
      const blockIds = new Set(v.blocks.map(block => block.id));
      const pageBlocks = blocksFromEntries(projected.entries, undefined, modelNamesOf(v.state), { stubs: projectedStubs, revision: action.window.revision })
        .filter(block => !blockIds.has(block.id));
      if (retained.entries.length === 0 && incomingStubs.length === 0 && pageBlocks.length === 0) return v;
      let blocks = v.blocks;
      if (pageBlocks.length > 0) {
        // An invisible custom record or a tool result folded into its call can
        // be the entry boundary without owning a block. Insert before the first
        // rendered block at or after that boundary; when the retained suffix is
        // entirely invisible, its visible predecessor belongs at the end.
        const boundary = v.entries.findIndex(entry => entryId(entry) === entryBoundary);
        // No entry boundary: the page precedes everything rendered here.
        const suffix = new Set(boundary < 0 ? v.entries.map(entryId) : v.entries.slice(boundary).map(entryId));
        // An anchor held as a stub owns a block of its own, and the page goes
        // in front of that block, not behind it.
        if (entryBoundary !== action.anchor) suffix.add(action.anchor);
        const found = v.blocks.findIndex(block => "entryId" in block && suffix.has(block.entryId));
        const at = found < 0 ? (boundary < 0 ? 0 : v.blocks.length) : found;
        blocks = [...v.blocks.slice(0, at), ...pageBlocks, ...v.blocks.slice(at)];
      }
      const stubs = mergeStubs(incomingStubs, v.stubs ?? []);
      const { live: _live, ...answered } = action.window;
      const { before: _pageBefore, anchor: _pageAnchor, ...pageMetadata } = answered;
      const atHead = held.gapBefore === undefined && held.anchor === action.anchor;
      let history: HistoryViewState = atHead ? {
        ...answered,
        branchesUnloaded: held.branchesUnloaded || answered.branchesUnloaded,
        hasHistory: held.hasHistory || answered.hasHistory,
      } : {
        ...pageMetadata,
        ...(held.before !== undefined ? { before: held.before } : {}),
        ...(held.anchor !== undefined ? { anchor: held.anchor } : {}),
        userOffset: held.userOffset,
        context: held.context,
        priorGoalIds: held.priorGoalIds,
        branchesUnloaded: held.branchesUnloaded || answered.branchesUnloaded,
        hasHistory: held.hasHistory || answered.hasHistory,
      };
      const candidate = { ...v, entries, stubs, blocks };
      const ancestry = activeAncestry(candidate);
      if (ancestry.kind === "gap" && history.before === undefined) history = { ...history, gapBefore: ancestry.before, complete: false };
      else if (ancestry.kind === "gap") history = { ...history, complete: false };
      else if (ancestry.kind === "complete") {
        const { gapBefore: _gap, ...whole } = history;
        history = { ...whole, complete: history.before === undefined };
      } else {
        history = { ...history, ...(held.gapBefore ? { gapBefore: held.gapBefore } : {}), complete: false };
      }
      return adoptProvedPage({ ...v, trimmed: undefined, history, entries, stubs, blocks }, v, action.window, action.baseRevision);
    }
  }
}

interface HistoryLoaderDeps {
  get(path: string): SessionView | undefined;
  /** Whether this is the conversation on screen (RP-5b §7). */
  isCurrent(path: string): boolean;
  request(params: ClientRequests["pi/session/entries"]["params"]): Promise<ClientRequests["pi/session/entries"]["result"]>;
  dispatch(action: Action): void;
  adoptEpoch(path: string, seq: number): void;
  track(path: string, seq: number): void;
}

// A replacement client can share the store while its predecessor settles.
let nextToken = 0;

/** Every read one rendered surface can ask for; scoped surfaces have their own. */
export type HistoryReads = ReturnType<typeof createHistoryLoader>;

/**
 * One request owner for tail reads, generation adoption and cursor recovery.
 *
 * Nothing here ever asks for the whole conversation. `{ all: true }` is an
 * indivisible read the producer refuses past one page, which for a person is
 * every conversation long enough to matter, and the refusal had a sentence of
 * its own that a person could be shown. The transcript is read in turn pages
 * that cannot be refused for size; other versions of a message come from a
 * bounded window of that message's siblings (D-340). There is no whole-read
 * path left to refuse, and no sentence for it.
 */
const STALE_BASE_MESSAGE = "This conversation changed since that page was read. Re-read recent messages to continue.";

/**
 * What one earlier-history request came to: whether it added rows to the
 * view, and how many serialized bytes the page carried. The bytes travel with
 * the answer so a caller pacing itself can count them — there is one loader
 * per surface (main, Beam's bubble), and a shared cell would let one surface's
 * page be charged to another's budget.
 */
export interface EarlierPage { accepted: boolean; bytes: number }
export const NO_EARLIER_PAGE: EarlierPage = Object.freeze({ accepted: false, bytes: 0 });

function pageBytes(entries: readonly unknown[]): number {
  try {
    return new TextEncoder().encode(JSON.stringify(entries)).byteLength;
  } catch {
    return 0;
  }
}

export function createHistoryLoader(deps: HistoryLoaderDeps) {
  const reads = new Map<string, Promise<void>>();
  /** The stamp a reconciliation is in flight for, per path. */
  const reconciling = new Map<string, string>();
  /**
   * The loaded authority identity at the last refusal. Automatic retries do
   * not poll again until sequence, revision or leaf moves; a person's explicit
   * history request uses `earlier` and is never gated here.
   */
  const reconciled = new Map<string, { at: string; lastSeq: number; leafId?: string | null | undefined; revision?: string | undefined }>();
  const generations = new Map<string, number>();
  const fence = (path: string, accepting: () => boolean) => {
    const generation = generations.get(path) ?? 0;
    const revision = deps.get(path)?.historyRevision;
    // The transcript this read is for can be released while it is in flight
    // (RP-5). Its epoch moves when that happens, so the answer lands nowhere.
    const hydration = deps.get(path)?.hydrationEpoch ?? 0;
    return () => accepting() && (generations.get(path) ?? 0) === generation && deps.get(path)?.historyRevision === revision
      && (deps.get(path)?.hydrationEpoch ?? 0) === hydration;
  };
  const read = async (path: string, accepting: () => boolean = () => true, legacySeq?: number, policy?: "recent" | "reread" | "refresh", allowDelta = true): Promise<void> => {
    if (!accepting()) return;
    if (policy === "recent" || policy === "reread") generations.set(path, (generations.get(path) ?? 0) + 1);
    const active = fence(path, accepting);
    const pending = policy === "recent" || policy === "reread" ? undefined : reads.get(path);
    if (pending) {
      await pending;
      return;
    }
    const token = String(++nextToken);
    const expectSeq = deps.get(path)?.lastSeq ?? 0;
    // Nothing is retired before the answer arrives (RP-11): what this surface
    // is showing — the conversation it already held, or the tail this device
    // painted from its cache — stays on screen until the authoritative window
    // replaces it in one transaction, or does not arrive at all.
    deps.dispatch({ type: "historyBegin", path, token });
    /** A proved suffix the fold refused: the same read is spent again, once. */
    let refusedDelta = false;
    const work = (async () => {
      const window: HistoryWindowRequest = { turns: HISTORY_FIRST_PAGE_TURNS };
      // The durable revision this view still holds, when it holds one whole
      // (RP-9): the host may then answer the tail as a proved suffix instead of
      // a replacement. A cache-painted view holds no window, so it asks for a
      // replacement and gets one.
      const base = allowDelta ? deltaBaseOf(deps.get(path)) : undefined;
      // RP-5b: this surface cannot hold a body larger than its excerpt bound,
      // so every page it asks for leaves those bodies out and lists the records
      // that carry them — which is also what lets a page of a conversation with
      // one enormous turn still carry the turns around it.
      const result = await deps.request({ path, window, bodyLimit: BODY_EXCERPT_MAX_BYTES, ...(base ? { baseRevision: base } : {}) });
      const current = deps.get(path);
      if (!active() || !current || current.historyPending?.token !== token) return;

      const epoch = current.history?.epoch ?? current.updateEpoch;
      if (result.window && epoch && epoch !== result.window.epoch) deps.adoptEpoch(path, result.window.seq);
      if (result.window && base !== undefined && result.window.mode === "delta") {
        deps.dispatch({ type: "historyDelta", path, token, baseRevision: base, entries: result.entries, window: result.window, ...(result.leafId !== undefined ? { leafId: result.leafId } : {}) });
        // Only a person's explicit re-read may replace a suffix whose base
        // moved while it was in flight. Background refresh leaves the window.
        if (deps.get(path)?.historyRevision !== token && (policy === "recent" || policy === "reread")) { refusedDelta = true; return; }
      } else if (result.window && base !== undefined && policy === "refresh") {
        // An unsolicited refresh whose base the producer could not prove a
        // suffix against. Nobody asked for a page, so nobody is told one was
        // refused, and nothing the person is reading is replaced: the held
        // window — every page they scrolled up into, the cursor before it and
        // the row under their eye — stays exactly as it is (D-302). Live
        // updates keep arriving through the stream; the next page they ask for
        // that the stale base cannot serve is answered with the explicit
        // re-read, at the moment they ask.
      } else if (result.window && base !== undefined && policy !== "recent" && policy !== "reread") {
        deps.dispatch({ type: "historyPageRefused", path, cause: "stale-base", message: STALE_BASE_MESSAGE });
      } else if (result.window) {
        deps.dispatch({ type: "historySnapshot", path, token, ...result, window: result.window, ...(policy === "recent" ? { replaceWindow: true } : {}) });
      } else {
        deps.dispatch({ type: "hydrate", path, entries: result.entries, leafId: result.leafId, expectSeq, ...(legacySeq !== undefined ? { seq: legacySeq } : {}) });
      }
      deps.track(path, deps.get(path)?.lastSeq ?? 0);
    })();
    reads.set(path, work);
    try { await work; } catch (error) { if (active()) throw error; } finally {
      deps.dispatch({ type: "historyEnd", path, token });
      if (reads.get(path) === work) reads.delete(path);
    }
    if (refusedDelta) await read(path, accepting, legacySeq, policy === "reread" ? "reread" : "recent", false);
  };

  /**
   * The revision a delta may be proved against, or nothing.
   *
   * A proved older page can know a newer producer revision without covering
   * its suffix. In that case the validated record remains the older covered
   * baseline and asks the producer for precisely that missing delta.
   */
  const deltaBaseOf = (view: SessionView | undefined): string | undefined => {
    const base = coveredBaselineOf(view);
    if (!base || !view?.history || (view.validated && view.history.environmentKey !== view.validated.environmentKey)
      || !view.hydrated || view.provisional !== undefined) return undefined;
    return base;
  };
  /**
   * Ask the producer for one bounded page ending before the retained entry.
   * This is the only recovery for a lost or stale cursor: it extends the view
   * in place and never exchanges the person's old window for a recent tail.
   */
  const pageAddsRecords = (view: SessionView, result: ClientRequests["pi/session/entries"]["result"]): boolean => {
    const known = new Set([...view.entries.map(entryId), ...(view.stubs ?? []).map(stub => stub.id)]);
    return result.entries.some(entry => !known.has(entryId(entry))) || (result.window?.elided ?? []).some(stub => !known.has(stub.id));
  };
  const refuseStaleBase = (path: string, error: unknown): void => {
    const raw = error as { message?: unknown } | null;
    const message = typeof raw?.message === "string" && raw.message ? raw.message : STALE_BASE_MESSAGE;
    deps.dispatch({ type: "historyPageRefused", path, cause: "stale-base", message });
  };
  const recoverEarlier = async (path: string, accepting: () => boolean): Promise<EarlierPage> => {
    const view = deps.get(path);
    const history = view?.history;
    const anchor = history?.gapBefore ?? history?.anchor;
    if (!view || !history || !anchor) return NO_EARLIER_PAGE;
    const expectedBefore = history.before;
    const trimAt = view.trimmed?.at;
    const ownerRevision = view.historyRevision;
    const baseRevision = coveredBaselineOf(view);
    const active = fence(path, accepting);
    if (!baseRevision || !active()) return NO_EARLIER_PAGE;
    const result = await deps.request({ path, window: { beforeEntry: anchor, turns: HISTORY_EARLIER_PAGE_TURNS }, bodyLimit: BODY_EXCERPT_MAX_BYTES, baseRevision }).catch(error => {
      if (!active()) return undefined;
      const code = (error as { code?: number }).code;
      if (code === ErrorCodes.InvalidParams) return undefined;
      if (code === ErrorCodes.RevisionUnavailable) { refuseStaleBase(path, error); return undefined; }
      throw error;
    });
    if (!result?.window || !active()) return NO_EARLIER_PAGE;
    const current = deps.get(path);
    if (!current) return NO_EARLIER_PAGE;
    const added = pageAddsRecords(current, result);
    deps.dispatch({ type: "historyRecover", path, anchor, baseRevision, ownerRevision, entries: result.entries, window: result.window,
      ...(expectedBefore !== undefined ? { expectedBefore } : {}), ...(trimAt !== undefined ? { trimAt } : {}) });
    const accepted = added && deps.get(path) !== current;
    return accepted ? { accepted, bytes: pageBytes(result.entries) } : NO_EARLIER_PAGE;
  };
  const earlier = async (path: string, accepting: () => boolean): Promise<EarlierPage> => {
    if (!accepting()) return NO_EARLIER_PAGE;
    const view = deps.get(path);
    // A trim releases the producer-owned cursor with the older rows. Recover
    // directly before the retained anchor; asking for its suffix can exceed a
    // page and a tail replacement would delete the window being read.
    if (!view?.history?.before && (view?.trimmed || view?.history?.gapBefore || view?.history?.complete === false)) return recoverEarlier(path, accepting);
    const active = fence(path, accepting);
    const before = view?.history?.before;
    const anchor = view?.history?.anchor;
    const ownerRevision = view?.historyRevision;
    const baseRevision = coveredBaselineOf(view);
    if (!before || !anchor || !baseRevision || !active()) return NO_EARLIER_PAGE;
    let result: ClientRequests["pi/session/entries"]["result"] | undefined;
    try {
      result = await deps.request({ path, window: { before, turns: HISTORY_EARLIER_PAGE_TURNS }, bodyLimit: BODY_EXCERPT_MAX_BYTES, baseRevision });
    } catch (error) {
      if (!active()) return NO_EARLIER_PAGE;
      const code = (error as { code?: number }).code;
      if (code === ErrorCodes.InvalidParams) return NO_EARLIER_PAGE;
      if (code === ErrorCodes.RevisionUnavailable) { refuseStaleBase(path, error); return NO_EARLIER_PAGE; }
      throw error;
    }
    if (!result.window || !active()) return NO_EARLIER_PAGE;
    const current = deps.get(path);
    if (!current) return NO_EARLIER_PAGE;
    const added = pageAddsRecords(current, result);
    deps.dispatch({ type: "historyPrepend", path, before, anchor, baseRevision, ownerRevision, entries: result.entries, window: result.window });
    const accepted = added && deps.get(path) !== current;
    return accepted ? { accepted, bytes: pageBytes(result.entries) } : NO_EARLIER_PAGE;
  };
  const metadata = (path: string, accepting: () => boolean): Promise<void> =>
    deps.get(path)?.hydrated ? read(path, accepting, undefined, "refresh") : Promise.resolve();
  const recent = (path: string, accepting: () => boolean, legacySeq?: number) => read(path, accepting, legacySeq, "recent");
  const reread = (path: string, accepting: () => boolean) => read(path, accepting, undefined, "reread");
  /**
   * Replace what a trim released, if the replacement really contains what the
   * surface is standing on (RP-5b §7).
   *
   * There is no read budget. Safe attempts ask again only after the loaded
   * authority identity moves; viewport/focus publication cannot poll the host.
   * A refused page is retained nowhere.
   */
  const reconcile = async (path: string, accepting: () => boolean = () => true): Promise<void> => {
    // Only the conversation on screen. One that is not rehydrates when a
    // person comes back to it, through the ordinary re-entry read.
    if (!deps.isCurrent(path)) return;
    const eligible = (): string | undefined => {
      const view = deps.get(path);
      const stamp = view?.trimmed;
      if (!stamp) { reconciled.delete(path); return undefined; }
      const previous = reconciled.get(path);
      if (previous && previous.at !== stamp.at) reconciled.delete(path);
      if (reconciling.get(path) === stamp.at) return undefined;
      // A refused tail cannot become acceptable until the loaded authority
      // identity moves. Viewport publication is not such a change.
      if (previous?.at === stamp.at && previous.lastSeq === view.lastSeq
        && previous.leafId === view.leafId && previous.revision === view.validated?.revision) return undefined;
      return stamp.at;
    };
    if (eligible() === undefined) return;
    // One at a time, and never beside another history read.
    const pending = reads.get(path);
    if (pending) await pending.catch(() => {});
    // That read may have replaced the trim or left this surface somewhere else
    // entirely: everything is asked again before a request of our own goes out.
    if (!deps.isCurrent(path)) return;
    const at = eligible();
    if (at === undefined) return;
    reconciling.set(path, at);
    const active = fence(path, accepting);
    const token = String(++nextToken);
    // The updates that arrive while this is in flight are buffered by the
    // canonical fold rather than lost.
    deps.dispatch({ type: "historyBegin", path, token });
    try {
      const result = await deps.request({ path, window: { turns: HISTORY_FIRST_PAGE_TURNS }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
      if (!active() || deps.get(path)?.trimmed?.at !== at || deps.get(path)?.historyPending?.token !== token) {
        deps.dispatch({ type: "historyEnd", path, token });
        return;
      }
      if (!result.window) {
        deps.dispatch({ type: "views/reconcileFailed", path, at, token });
        return;
      }
      deps.dispatch({ type: "views/reconcile", path, at, token, entries: result.entries, leafId: result.leafId, window: result.window });
      const refused = deps.get(path);
      if (refused?.trimmed?.at === at) {
        reconciled.set(path, { at, lastSeq: refused.lastSeq, leafId: refused.leafId, revision: refused.validated?.revision });
      } else {
        reconciled.delete(path);
      }
    } catch {
      if (active() && deps.get(path)?.trimmed?.at === at) deps.dispatch({ type: "views/reconcileFailed", path, at, token });
      else deps.dispatch({ type: "historyEnd", path, token });
    } finally {
      if (reconciling.get(path) === at) reconciling.delete(path);
    }
  };

  return { read, recent, reread, earlier, metadata, reconcile };
}
