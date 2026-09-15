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
  | { type: "historySnapshot"; path: string; token: string; entries: unknown[]; leafId?: string | null; window: HistoryWindow; replaceWindow?: true }
  | { type: "historyPrepend"; path: string; before: string; entries: unknown[]; window: HistoryWindow; revision?: string | undefined }
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
      const stubs = retainTree ? mergeStubs(v.stubs ?? [], [...incoming.stubs, ...elided]) : [...incoming.stubs, ...elided];
      const history = retainTree ? { ...window, complete: true, branchesUnloaded: false, userOffset: 0, context: [], priorGoalIds: [] } : window;
      if (retainTree) delete history.before;
      const { trimmed: _released, ...base } = v;
      let next: SessionView = { ...awake(base as SessionView), entries, stubs, leafId: action.leafId, history, hydrated: true, validated: validatedOf(window, v),
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
    case "historyPrepend": {
      if (v.historyRevision !== action.revision || v.history?.before !== action.before || v.history.epoch !== action.window.epoch) return v;
      const ids = new Set([...v.entries.map(e => (e as { id?: string }).id), ...(v.stubs ?? []).map(stub => stub.id)]);
      const incoming = retainEntries(action.entries.filter(e => !ids.has((e as { id?: string }).id)));
      const entries = incoming.entries;
      const stubs = mergeStubs([...incoming.stubs, ...(action.window.elided ?? []).map(stubOfElided)], v.stubs ?? []);
      const { live: _live, ...history } = action.window;
      // The page plus the existing suffix covers the branch exactly when no
      // earlier cursor remains. Alternative versions are a separate scope.
      return adopt({ ...v, history: { ...history, complete: history.before === undefined }, entries: [...entries, ...v.entries], stubs,
        blocks: [...blocksFromEntries(entries, undefined, modelNamesOf(v.state), { stubs: incoming.stubs, revision: action.window.revision }), ...v.blocks] }, v, action.window);
    }
  }
}

interface HistoryLoaderDeps {
  get(path: string): SessionView | undefined;
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
export function createHistoryLoader(deps: HistoryLoaderDeps) {
  const reads = new Map<string, Promise<void>>();
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
  const read = async (path: string, all = false, accepting: () => boolean = () => true, legacySeq?: number, policy?: "recent"): Promise<void> => {
    if (!accepting()) return;
    if (policy === "recent") generations.set(path, (generations.get(path) ?? 0) + 1);
    let active = fence(path, accepting);
    const pending = policy === "recent" ? undefined : reads.get(path);
    if (pending) {
      await pending;
      if (!active() || !all || hasCompleteTree(deps.get(path))) return;
    }
    const token = String(++nextToken);
    const expectSeq = deps.get(path)?.lastSeq ?? 0;
    deps.dispatch({ type: "historyBegin", path, token });
    if (policy === "recent") {
      // Retiring the window clears the revision this read is replacing, so the
      // fence is taken again afterwards: a read must not refuse its own reset.
      deps.dispatch({ type: "historyReset", path, token });
      active = fence(path, accepting);
    }
    const work = (async () => {
      const anchor = policy === "recent" ? undefined : deps.get(path)?.history?.anchor;
      const window: HistoryWindowRequest = policy === "recent" ? { tail: 40 } : all ? { all: true } : anchor ? { from: anchor } : { tail: 40 };
      // RP-5b: this surface cannot hold a body larger than its excerpt bound,
      // so every page it asks for leaves those bodies out and lists the records
      // that carry them — which is also what lets a page of a conversation with
      // one enormous turn still carry the turns around it.
      const result = await deps.request({ path, window, bodyLimit: BODY_EXCERPT_MAX_BYTES }).catch(error => {
        if (!("from" in window) || (error as { code?: number }).code !== ErrorCodes.InvalidParams) throw error;
        return deps.request({ path, window: { tail: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
      });
      const current = deps.get(path);
      if (!active() || !current || current.historyPending?.token !== token) return;

      const epoch = current.history?.epoch ?? current.updateEpoch;
      if (result.window && epoch && epoch !== result.window.epoch) deps.adoptEpoch(path, result.window.seq);
      if (result.window) deps.dispatch({ type: "historySnapshot", path, token, ...result, window: result.window, ...(policy === "recent" ? { replaceWindow: true } : {}) });
      else deps.dispatch({ type: "hydrate", path, entries: result.entries, leafId: result.leafId, expectSeq, ...(legacySeq !== undefined ? { seq: legacySeq } : {}) });
      deps.track(path, deps.get(path)?.lastSeq ?? 0);
    })();
    reads.set(path, work);
    try { await work; } catch (error) { if (active()) throw error; } finally {
      deps.dispatch({ type: "historyEnd", path, token });
      if (reads.get(path) === work) reads.delete(path);
    }
  };
  const all = async (path: string, accepting: () => boolean): Promise<boolean> => {
    const active = fence(path, accepting);
    if (!active()) return false;
    if (!reads.has(path) && deps.get(path)?.history && hasCompleteTree(deps.get(path))) return true;
    await read(path, true, active);
    return active() && hasCompleteTree(deps.get(path));
  };
  const earlier = async (path: string, accepting: () => boolean): Promise<boolean> => {
    const active = fence(path, accepting);
    const before = deps.get(path)?.history?.before;
    const revision = deps.get(path)?.historyRevision;
    if (!before || !active()) return false;
    const result = await deps.request({ path, window: { before, limit: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES }).catch(async error => {
      if (!active()) return undefined;
      if ((error as { code?: number }).code !== ErrorCodes.InvalidParams) throw error;
      await read(path, false, active); return undefined;
    });
    if (!result || !active() || !result.window) return false;
    deps.dispatch({ type: "historyPrepend", path, before, revision, entries: result.entries, window: result.window });
    return deps.get(path)?.history?.before !== before;
  };
  const metadata = async (path: string, accepting: () => boolean): Promise<void> => {
    const active = fence(path, accepting);
    if (!active()) return;
    const from = deps.get(path)?.leafId;
    const revision = deps.get(path)?.historyRevision;
    const result = await deps.request({ path, window: from ? { from } : { all: true }, bodyLimit: BODY_EXCERPT_MAX_BYTES }).catch(async error => {
      if (!active()) return undefined;
      if ((error as { code?: number }).code !== ErrorCodes.InvalidParams) throw error;
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
  return { read, recent, all, earlier, metadata, ensure };
}
