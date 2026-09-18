import { ErrorCodes, type ClientRequests, type HistoryWindow, type HistoryWindowRequest, type SessionUpdateParams } from "@lasercode/protocol";
import type { applyUpdate, blocksFromEntries, modelNamesOf, stampNewBlocks, textOf, Action, Block, SessionView, ValidatedRevision } from "../store.js";
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
  | { type: "historyMetadata"; path: string; from?: string | null | undefined; entries: unknown[]; leafId?: string | null | undefined; window: HistoryWindow; revision?: string | undefined };

/**
 * What a dormant view keeps of an accepted window (RP-5/RP-9): the durable
 * revision it was valid at, the environment that revision belongs to, and
 * whether the session has any history at all.
 */
/**
 * Take the window's identity for a merged read, or take none.
 *
 * A page read and what this view already held describe one state when they
 * came from the same durable revision. When they did not, the merge is a set
 * no single revision names, and a record released from it would claim to be
 * something it is not.
 */
function adopt(next: SessionView, previous: SessionView, window: Omit<HistoryWindow, "live">): SessionView {
  if (previous.validated === undefined || previous.validated.revision !== window.revision) {
    const { validated: _stale, ...rest } = next;
    return rest as SessionView;
  }
  return { ...next, validated: validatedOf(window, next) };
}

/** Adopt a newer revision only after the producer proved the held base prefix. */
function adoptProvedPage(next: SessionView, previous: SessionView, window: Omit<HistoryWindow, "live">, baseRevision: string): SessionView {
  if (previous.validated === undefined || previous.validated.revision !== baseRevision) {
    const { validated: _stale, ...rest } = next;
    return rest as SessionView;
  }
  return { ...next, validated: validatedOf(window, next) };
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

/** Insert a producer page at its exclusive boundary, preserving later islands. */
function insertBefore<T>(held: readonly T[], incoming: readonly T[], boundary: string, idOf: (value: T) => string | undefined): T[] | undefined {
  const at = held.findIndex(value => idOf(value) === boundary);
  if (at < 0) return undefined;
  return [...held.slice(0, at), ...incoming, ...held.slice(at)];
}

/** First missing parent on the loaded active ancestry, nearest the live edge. */
function activeGapBoundary(view: Pick<SessionView, "entries" | "stubs" | "leafId">): string | undefined {
  const records = new Map<string, { parentId: string | null }>();
  for (const entry of view.entries) {
    const value = entry as { id?: unknown; parentId?: unknown } | null;
    if (typeof value?.id === "string") records.set(value.id, { parentId: typeof value.parentId === "string" ? value.parentId : null });
  }
  for (const stub of view.stubs ?? []) records.set(stub.id, { parentId: stub.parentId });
  // Only the producer-owned leaf proves active ancestry. Never infer a gap
  // from the last locally appended/live-only row.
  let id = view.leafId;
  const visited = new Set<string>();
  while (typeof id === "string") {
    if (visited.has(id)) return undefined;
    visited.add(id);
    const record = records.get(id);
    if (!record) return undefined;
    if (record.parentId === null) return undefined;
    if (!records.has(record.parentId)) return id;
    id = record.parentId;
  }
  return undefined;
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
      const optimistic = v.blocks.filter(b => b.kind === "user" && b.optimistic);
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
      if (!base || !held || base.revision !== action.baseRevision || held.revision !== action.baseRevision
        || base.environmentKey !== action.window.environmentKey || held.epoch !== action.window.epoch) return v;
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
    case "historyMetadata": {
      if (v.historyRevision !== action.revision || (v.history && v.history.epoch !== action.window.epoch)) return v;
      const index = action.from ? v.entries.findIndex(e => (e as { id?: string }).id === action.from) : -1;
      if (action.from && index < 0) return v;
      // Entries are an append-only tree, not a contiguous active branch.
      // Splicing a new continuation at its parent would put it before older
      // siblings abandoned by an edit, reversing their version numbers.
      // Replace known records in place and append only newly persisted ids.
      const incoming = retainEntries(action.entries);
      const entries = [...new Map([...v.entries, ...incoming.entries].map(entry => [(entry as { id: string }).id, entry])).values()];
      const stubs = mergeStubs(v.stubs ?? [], [...incoming.stubs, ...(action.window.elided ?? []).map(stubOfElided)]);
      const { live: _live, before: _before, ...history } = action.window;
      const merged = v.history ? { ...v.history, seq: history.seq, hasHistory: v.history.hasHistory || history.hasHistory } : { ...history, userOffset: 0, context: [], priorGoalIds: [], complete: true };
      // The merged set spans this read and what was already held. That is one
      // describable state only when both came from the same durable revision;
      // across revisions the tuple would name entries it does not cover.
      return adopt({ ...v, entries, stubs, leafId: action.leafId, history: merged }, v, action.window);
    }
    case "historyPrepend":
    case "historyRecover": {
      const held = v.history;
      if (!held || v.historyRevision !== action.ownerRevision || held.revision !== action.baseRevision
        || held.anchor !== action.anchor || held.epoch !== action.window.epoch
        || held.environmentKey !== action.window.environmentKey) return v;
      if (action.type === "historyPrepend" && held.before !== action.before) return v;
      if (action.type === "historyRecover" && (held.before !== action.expectedBefore
        || (action.trimAt !== undefined && v.trimmed?.at !== action.trimAt))) return v;
      const ids = new Set([...v.entries.map(entryId), ...(v.stubs ?? []).map(stub => stub.id)]);
      const retained = retainEntries(action.entries.filter(entry => !ids.has(entryId(entry))));
      const wireStubs = (action.window.elided ?? []).map(stubOfElided).filter(stub => !ids.has(stub.id));
      const incomingStubs = mergeStubs(retained.stubs, wireStubs);
      const entries = insertBefore(v.entries, retained.entries, action.anchor, entryId);
      if (!entries) return v;
      const pageBlocks = blocksFromEntries(retained.entries, undefined, modelNamesOf(v.state), { stubs: incomingStubs, revision: action.window.revision });
      let blocks = v.blocks;
      if (pageBlocks.length > 0) {
        // An invisible custom record or a tool result folded into its call can
        // be the entry boundary without owning a block. Insert before the first
        // rendered block at or after that boundary, not only an exact block id.
        const boundary = v.entries.findIndex(entry => entryId(entry) === action.anchor);
        const suffix = new Set(v.entries.slice(boundary).map(entryId));
        const at = v.blocks.findIndex(block => "entryId" in block && suffix.has(block.entryId));
        if (boundary < 0 || at < 0) return v;
        blocks = [...v.blocks.slice(0, at), ...pageBlocks, ...v.blocks.slice(at)];
      }
      const stubs = mergeStubs(incomingStubs, v.stubs ?? []);
      const { live: _live, ...answered } = action.window;
      let history: HistoryWindow = {
        ...answered,
        complete: answered.before === undefined,
        branchesUnloaded: held.branchesUnloaded || answered.branchesUnloaded,
        hasHistory: held.hasHistory || answered.hasHistory,
      };
      let trimmed = v.trimmed;
      const candidate = { ...v, entries, stubs, blocks };
      if (answered.before === undefined) {
        const gap = activeGapBoundary(candidate);
        if (gap) history = { ...history, anchor: gap, complete: false };
        else { history = { ...history, complete: true }; if (trimmed) trimmed = undefined; }
      }
      return adoptProvedPage({ ...v, ...(trimmed ? { trimmed } : { trimmed: undefined }), history, entries, stubs, blocks }, v, action.window, action.baseRevision);
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

/** One request owner for tail/all reads, generation adoption and cursor recovery. */
/** The window a reconciliation asks for: the conversation's recent tail. */
const HISTORY_TAIL = 40;

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
  const read = async (path: string, all = false, accepting: () => boolean = () => true, legacySeq?: number, policy?: "recent", allowDelta = true): Promise<void> => {
    if (!accepting()) return;
    if (policy === "recent") generations.set(path, (generations.get(path) ?? 0) + 1);
    const active = fence(path, accepting);
    const pending = policy === "recent" ? undefined : reads.get(path);
    if (pending) {
      await pending;
      if (!active() || !all || hasCompleteTree(deps.get(path))) return;
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
      const anchor = policy === "recent" ? undefined : deps.get(path)?.history?.anchor;
      const window: HistoryWindowRequest = policy === "recent" ? { tail: 40 } : all ? { all: true } : anchor ? { from: anchor } : { tail: 40 };
      // The durable revision this view still holds, when it holds one whole
      // (RP-9): the host may then answer the tail as a proved suffix instead of
      // a replacement. A cache-painted view holds no window, so it asks for a
      // replacement and gets one.
      const base = allowDelta && policy === "recent" ? deltaBaseOf(deps.get(path)) : undefined;
      // RP-5b: this surface cannot hold a body larger than its excerpt bound,
      // so every page it asks for leaves those bodies out and lists the records
      // that carry them — which is also what lets a page of a conversation with
      // one enormous turn still carry the turns around it.
      const result = await deps.request({ path, window, bodyLimit: BODY_EXCERPT_MAX_BYTES, ...(base ? { baseRevision: base } : {}) }).catch(error => {
        // `from` and `all` are indivisible. An unopened/released view can still
        // fall back to its bounded opening tail. A hydrated conversation on
        // screen keeps its logical window instead: refresh failure is honest,
        // while a tail replacement would erase what the person is reading.
        const code = (error as { code?: number }).code;
        const indivisible = "from" in window || "all" in window;
        if (!(("from" in window && code === ErrorCodes.InvalidParams) || (indivisible && code === ErrorCodes.RevisionUnavailable))) throw error;
        const held = deps.get(path);
        if (deps.isCurrent(path) && held?.hydrated && (held.entries.length > 0 || held.blocks.length > 0)) throw error;
        return deps.request({ path, window: { tail: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
      });
      const current = deps.get(path);
      if (!active() || !current || current.historyPending?.token !== token) return;

      const epoch = current.history?.epoch ?? current.updateEpoch;
      if (result.window && epoch && epoch !== result.window.epoch) deps.adoptEpoch(path, result.window.seq);
      if (result.window && base !== undefined && result.window.mode === "delta") {
        deps.dispatch({ type: "historyDelta", path, token, baseRevision: base, entries: result.entries, window: result.window, ...(result.leafId !== undefined ? { leafId: result.leafId } : {}) });
        // The fold refuses a suffix whose base moved while it was in flight. A
        // refused page is kept by nobody: the conversation is read again, once,
        // as an atomic replacement.
        if (deps.get(path)?.historyRevision !== token) { refusedDelta = true; return; }
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
    if (refusedDelta) await read(path, false, accepting, legacySeq, "recent", false);
  };

  /**
   * The revision a delta may be proved against, or nothing.
   *
   * Only a view that holds one whole authoritative window qualifies: the same
   * durable revision on the light record and on the loaded window. A view
   * painted from this device's cache (RP-11) holds a captured revision and no
   * window, so it asks for — and receives — a replacement.
   */
  const deltaBaseOf = (view: SessionView | undefined): string | undefined => {
    const revision = view?.validated?.revision;
    return revision !== undefined && view?.history?.revision === revision && view.hydrated && view.provisional === undefined
      ? revision : undefined;
  };
  const all = async (path: string, accepting: () => boolean): Promise<boolean> => {
    const active = fence(path, accepting);
    if (!active()) return false;
    if (!reads.has(path) && deps.get(path)?.history && hasCompleteTree(deps.get(path))) return true;
    await read(path, true, active);
    return active() && hasCompleteTree(deps.get(path));
  };
  /**
   * Ask the producer for one bounded page ending before the retained entry.
   * This is the only recovery for a lost or stale cursor: it extends the view
   * in place and never exchanges the person's old window for a recent tail.
   */
  const recoverEarlier = async (path: string, accepting: () => boolean): Promise<boolean> => {
    const view = deps.get(path);
    const history = view?.history;
    const anchor = history?.anchor;
    if (!view || !history || !anchor || view.trimmed?.earlierExhausted) return false;
    const expectedBefore = history.before;
    const trimAt = view.trimmed?.at;
    const ownerRevision = view.historyRevision;
    const baseRevision = history.revision;
    const epoch = history.epoch;
    const active = fence(path, accepting);
    if (!active()) return false;
    const result = await deps.request({ path, window: { beforeEntry: anchor, limit: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES, baseRevision }).catch(error => {
      if (!active()) return undefined;
      const code = (error as { code?: number }).code;
      if (code === ErrorCodes.InvalidParams || code === ErrorCodes.RevisionUnavailable) return undefined;
      throw error;
    });
    if (!result?.window || !active()) return false;
    const current = deps.get(path);
    if (!current || current.historyRevision !== ownerRevision || current.history?.revision !== baseRevision
      || current.history.anchor !== anchor || current.history.before !== expectedBefore || current.history.epoch !== epoch
      || current.history.environmentKey !== result.window.environmentKey
      || (trimAt !== undefined && current.trimmed?.at !== trimAt)) return false;
    deps.dispatch({ type: "historyRecover", path, anchor, baseRevision, ownerRevision, entries: result.entries, window: result.window,
      ...(expectedBefore !== undefined ? { expectedBefore } : {}), ...(trimAt !== undefined ? { trimAt } : {}) });
    return deps.get(path) !== current;
  };
  const earlier = async (path: string, accepting: () => boolean): Promise<boolean> => {
    if (!accepting()) return false;
    const view = deps.get(path);
    // A trim releases the producer-owned cursor with the older rows. Recover
    // directly before the retained anchor; asking for its suffix can exceed a
    // page and a tail replacement would delete the window being read.
    if (!view?.history?.before && (view?.trimmed || view?.history?.complete === false)) return recoverEarlier(path, accepting);
    const active = fence(path, accepting);
    const before = view?.history?.before;
    const anchor = view?.history?.anchor;
    const ownerRevision = view?.historyRevision;
    const baseRevision = view?.history?.revision;
    if (!before || !anchor || !baseRevision || !active()) return false;
    let result: ClientRequests["pi/session/entries"]["result"] | undefined;
    try {
      result = await deps.request({ path, window: { before, limit: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES, baseRevision });
    } catch (error) {
      if (!active()) return false;
      const code = (error as { code?: number }).code;
      if (code !== ErrorCodes.InvalidParams && code !== ErrorCodes.RevisionUnavailable) throw error;
      return recoverEarlier(path, active);
    }
    if (!result.window || !active()) return false;
    const current = deps.get(path);
    if (current?.history?.before !== before || current.history.anchor !== anchor
      || current.history.revision !== baseRevision || current.historyRevision !== ownerRevision) return false;
    deps.dispatch({ type: "historyPrepend", path, before, anchor, baseRevision, ownerRevision, entries: result.entries, window: result.window });
    return deps.get(path) !== current;
  };
  const metadata = async (path: string, accepting: () => boolean): Promise<void> => {
    const active = fence(path, accepting);
    if (!active()) return;
    const from = deps.get(path)?.leafId;
    const revision = deps.get(path)?.historyRevision;
    const result = await deps.request({ path, window: from ? { from } : { all: true }, bodyLimit: BODY_EXCERPT_MAX_BYTES }).catch(async error => {
      if (!active()) return undefined;
      const code = (error as { code?: number }).code;
      if (code !== ErrorCodes.InvalidParams && code !== ErrorCodes.RevisionUnavailable) throw error;
      await read(path, false, active); return undefined;
    });
    if (!result || !active()) return;
    const previousEpoch = deps.get(path)?.history?.epoch ?? deps.get(path)?.updateEpoch;
    if (result.window && previousEpoch && previousEpoch !== result.window.epoch) { await read(path, false, active); return; }
    if (result.window) deps.dispatch({ type: "historyMetadata", path, from, revision, ...result, window: result.window });
    else deps.dispatch({ type: "entries", path, entries: result.entries, leafId: result.leafId });
  };
  const ensure = async (path: string, entryId: string, accepting: () => boolean): Promise<void> => {
    const view = deps.get(path);
    if (view?.entries.some(entry => (entry as { id?: string }).id === entryId) || !view?.history || hasCompleteTree(view)) return;
    await read(path, true, accepting);
  };
  const recent = (path: string, accepting: () => boolean, legacySeq?: number) => read(path, false, accepting, legacySeq, "recent");
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
      const result = await deps.request({ path, window: { tail: HISTORY_TAIL }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
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

  return { read, recent, all, earlier, metadata, ensure, reconcile };
}
