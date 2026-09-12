import { ErrorCodes, type ClientRequests, type HistoryWindow, type HistoryWindowRequest, type SessionUpdateParams } from "@lasercode/protocol";
import type { applyUpdate, blocksFromEntries, modelNamesOf, stampNewBlocks, textOf, Action, Block, SessionView } from "../store.js";
import { deepEqual } from "./projection.js";

export type HistoryAction =
  | { type: "historyBegin"; path: string; token: string }
  | { type: "historyEnd"; path: string; token: string }
  | { type: "historySnapshot"; path: string; token: string; entries: unknown[]; leafId?: string | null; window: HistoryWindow }
  | { type: "historyPrepend"; path: string; before: string; entries: unknown[]; window: HistoryWindow }
  | { type: "historyMetadata"; path: string; from?: string | null | undefined; entries: unknown[]; leafId?: string | null | undefined; window: HistoryWindow };

export const hasCompleteTree = (view: SessionView | undefined): boolean =>
  view?.history ? view.history.complete && !view.history.branchesUnloaded : Boolean(view?.hydrated);

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

/** Keep lower-sequence new-generation events until a snapshot can adopt them. */
export function receiveHistoryUpdate(v: SessionView, p: SessionUpdateParams, { applyUpdate, stampNewBlocks }: HistoryFold): SessionView {
  const historyPending = v.historyPending ? { ...v.historyPending, updates: [...v.historyPending.updates, p] } : undefined;
  const epoch = v.history?.epoch ?? v.updateEpoch;
  if (p.seq <= v.lastSeq || (p.epoch && epoch && p.epoch !== epoch)) return historyPending ? { ...v, historyPending } : v;
  const next = applyUpdate(v, p.update);
  return { ...next, blocks: stampNewBlocks(v.blocks, next.blocks, p.at), lastSeq: p.seq,
    ...(p.epoch ? { updateEpoch: p.epoch } : {}), ...(historyPending ? { historyPending } : {}) };
}

/** The store routes history actions here; its ordinary event fold stays authoritative. */
export function reduceHistory(v: SessionView, action: HistoryAction, { applyUpdate, blocksFromEntries, modelNamesOf, stampNewBlocks, textOf }: HistoryFold): SessionView {
  switch (action.type) {
    case "historyBegin": return { ...v, historyPending: { token: action.token, updates: [] } };
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
      const retainTree = oldEpoch === window.epoch && hasCompleteTree(v) && (!window.complete || window.branchesUnloaded);
      const entries = retainTree ? [...new Map([...v.entries, ...action.entries].map(entry => [(entry as { id: string }).id, entry])).values()] : action.entries;
      const history = retainTree ? { ...window, complete: true, branchesUnloaded: false, userOffset: 0, context: [], priorGoalIds: [] } : window;
      if (retainTree) delete history.before;
      let next: SessionView = { ...v, entries, leafId: action.leafId, history, hydrated: true,
        blocks: blocksFromEntries(entries, action.leafId, modelNamesOf(v.state)),
        running: live?.running ?? v.running, lastSeq: action.window.seq, updateEpoch: history.epoch, pendingSentBy: undefined, historyPending: undefined };
      if (live?.message) {
        const message = live.message.value as { content?: unknown };
        const parts = Array.isArray(message.content) ? message.content as { type?: string; thinking?: string }[] : [];
        next.blocks.push({ kind: "assistant", id: live.message.id, text: textOf(message.content),
          thinking: parts.filter(p => p.type === "thinking").map(p => p.thinking ?? "").join(""), streaming: true,
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
      return { ...next, blocks: shareHistoryBlocks(next.blocks, v.blocks), lastSeq: changedEpoch ? next.lastSeq : Math.max(next.lastSeq, v.lastSeq) };
    }
    case "historyMetadata": {
      if (v.history && v.history.epoch !== action.window.epoch) return v;
      const index = action.from ? v.entries.findIndex(e => (e as { id?: string }).id === action.from) : -1;
      if (action.from && index < 0) return v;
      // Entries are an append-only tree, not a contiguous active branch.
      // Splicing a new continuation at its parent would put it before older
      // siblings abandoned by an edit, reversing their version numbers.
      // Replace known records in place and append only newly persisted ids.
      const entries = [...new Map([...v.entries, ...action.entries].map(entry => [(entry as { id: string }).id, entry])).values()];
      const { live: _live, before: _before, ...history } = action.window;
      return { ...v, entries, leafId: action.leafId,
        history: v.history ? { ...v.history, seq: history.seq, hasHistory: v.history.hasHistory || history.hasHistory } : { ...history, userOffset: 0, context: [], priorGoalIds: [], complete: true } };
    }
    case "historyPrepend": {
      if (v.history?.before !== action.before || v.history.epoch !== action.window.epoch) return v;
      const ids = new Set(v.entries.map(e => (e as { id?: string }).id));
      const entries = action.entries.filter(e => !ids.has((e as { id?: string }).id));
      const { live: _live, ...history } = action.window;
      // The page plus the existing suffix covers the branch exactly when no
      // earlier cursor remains. Alternative versions are a separate scope.
      return { ...v, history: { ...history, complete: history.before === undefined }, entries: [...entries, ...v.entries],
        blocks: [...blocksFromEntries(entries, undefined, modelNamesOf(v.state)), ...v.blocks] };
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

/** One request owner for tail/all reads, generation adoption and cursor recovery. */
export function createHistoryLoader(deps: HistoryLoaderDeps) {
  const reads = new Map<string, Promise<void>>();
  const read = async (path: string, all = false, accepting: () => boolean = () => true, legacySeq?: number): Promise<void> => {
    const pending = reads.get(path);
    if (pending) {
      await pending;
      if (!all || hasCompleteTree(deps.get(path))) return;
    }
    const token = String(++nextToken);
    const expectSeq = deps.get(path)?.lastSeq ?? 0;
    deps.dispatch({ type: "historyBegin", path, token });
    const work = (async () => {
      const anchor = deps.get(path)?.history?.anchor;
      const window: HistoryWindowRequest = all ? { all: true } : anchor ? { from: anchor } : { tail: 40 };
      const result = await deps.request({ path, window }).catch(error => {
        if (!("from" in window) || (error as { code?: number }).code !== ErrorCodes.InvalidParams) throw error;
        return deps.request({ path, window: { tail: 40 } });
      });
      const current = deps.get(path);
      if (!accepting() || !current || current.historyPending?.token !== token) return;
      const epoch = current.history?.epoch ?? current.updateEpoch;
      if (result.window && epoch && epoch !== result.window.epoch) deps.adoptEpoch(path, result.window.seq);
      if (result.window) deps.dispatch({ type: "historySnapshot", path, token, ...result, window: result.window });
      else deps.dispatch({ type: "hydrate", path, entries: result.entries, leafId: result.leafId, expectSeq, ...(legacySeq !== undefined ? { seq: legacySeq } : {}) });
      deps.track(path, deps.get(path)?.lastSeq ?? 0);
    })();
    reads.set(path, work);
    try { await work; } finally {
      deps.dispatch({ type: "historyEnd", path, token });
      if (reads.get(path) === work) reads.delete(path);
    }
  };
  const all = async (path: string, accepting: () => boolean): Promise<boolean> => {
    if (deps.get(path)?.history && hasCompleteTree(deps.get(path))) return true;
    if (!accepting()) return false;
    await read(path, true, accepting);
    return hasCompleteTree(deps.get(path));
  };
  const earlier = async (path: string, accepting: () => boolean): Promise<boolean> => {
    const before = deps.get(path)?.history?.before;
    if (!before || !accepting()) return false;
    const result = await deps.request({ path, window: { before, limit: 40 } }).catch(async error => {
      if ((error as { code?: number }).code !== ErrorCodes.InvalidParams || !accepting()) throw error;
      await read(path, false, accepting); return undefined;
    });
    if (!result || !accepting() || !result.window) return false;
    deps.dispatch({ type: "historyPrepend", path, before, entries: result.entries, window: result.window });
    return deps.get(path)?.history?.before !== before;
  };
  const metadata = async (path: string, accepting: () => boolean): Promise<void> => {
    if (!accepting()) return;
    const from = deps.get(path)?.leafId;
    const result = await deps.request({ path, window: from ? { from } : { all: true } }).catch(async error => {
      if ((error as { code?: number }).code !== ErrorCodes.InvalidParams || !accepting()) throw error;
      await read(path, false, accepting); return undefined;
    });
    if (!result || !accepting()) return;
    const previousEpoch = deps.get(path)?.history?.epoch ?? deps.get(path)?.updateEpoch;
    if (result.window && previousEpoch && previousEpoch !== result.window.epoch) { await read(path, false, accepting); return; }
    if (result.window) deps.dispatch({ type: "historyMetadata", path, from, ...result, window: result.window });
    else deps.dispatch({ type: "entries", path, entries: result.entries, leafId: result.leafId });
  };
  const ensure = async (path: string, entryId: string, accepting: () => boolean): Promise<void> => {
    const view = deps.get(path);
    if (view?.entries.some(entry => (entry as { id?: string }).id === entryId) || !view?.history || hasCompleteTree(view)) return;
    await read(path, true, accepting);
  };
  return { read, all, earlier, metadata, ensure };
}
