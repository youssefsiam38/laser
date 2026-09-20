import { BODY_EXCERPT_MAX_BYTES } from "@/runtime/body-excerpt";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, boundedHistoryWindow, historyWindow, withElidedBodies, HISTORY_EARLIER_PAGE_TURNS, HISTORY_FIRST_PAGE_TURNS, isLiveEdgeWindow, type ClientRequests, type SessionState } from "@lasercode/protocol";
import { initialState, reduce, type Action } from "../../src/store.js";
import { createHistoryLoader } from "../../src/runtime/history-loader.js";

const state: SessionState = { path: "/session", id: "s", cwd: "/project", model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 80, pendingMessageCount: 0 };
const entries = Array.from({ length: 80 }, (_, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }] } }));
const source = { entries, leafId: "e79" };
const scope = { sessionId: state.id, epoch: "one", seq: 0, revision: "r1.test.base", environmentKey: "e1.test" };
type Params = ClientRequests["pi/session/entries"]["params"];
type Result = ClientRequests["pi/session/entries"]["result"];
function fixture(request: (params: Params) => Promise<Result>) {
  let app = reduce(initialState, { type: "opened", state });
  const dispatch = (action: Action) => { app = reduce(app, action); };
  const adoptEpoch = vi.fn(); const track = vi.fn();
  const replace = (request: (params: Params) => Promise<Result>) => createHistoryLoader({ get: path => app.open[path], isCurrent: path => path === state.path, request, dispatch, adoptEpoch, track });
  const loader = replace(request);
  return { loader, replace, dispatch, adoptEpoch, track, view: () => app.open[state.path]! };
}
function hydrateComplete(f: ReturnType<typeof fixture>, src: { entries: unknown[]; leafId: string } = source, sc: typeof scope = scope) {
  f.dispatch({ type: "historyBegin", path: state.path, token: "complete" });
  f.dispatch({ type: "historySnapshot", path: state.path, token: "complete", ...historyWindow(src, { all: true }, sc) });
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe("history request ownership", () => {
  it("replaces a complete cached tree with an authoritative recent tail and can page it again", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    hydrateComplete(f);
    expect(f.view().blocks).toHaveLength(80);
    await f.loader.read(state.path, () => true, undefined, "recent");
    expect(request).toHaveBeenLastCalledWith({ path: state.path, window: { turns: HISTORY_FIRST_PAGE_TURNS }, bodyLimit: BODY_EXCERPT_MAX_BYTES, baseRevision: scope.revision });
    const expected = historyWindow(source, { turns: HISTORY_FIRST_PAGE_TURNS }, scope);
    expect(f.view().entries).toEqual(expected.entries);
    expect(f.view().history).toEqual(expected.window);
    expect(f.view().historyRevision).toBeDefined();
    expect(f.view().blocks).toHaveLength(20);
    expect(f.view().history).toMatchObject({ complete: false, userOffset: 30 });
    const revision = f.view().historyRevision;
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().entries).toEqual(entries);
    expect(new Set(f.view().blocks.map(block => block.id)).size).toBe(80);
    expect(f.view().historyRevision).toBe(revision);
  });

  it("turns one earlier request on a trimmed view into cursor recovery and an older page", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z" });
    expect(f.view().trimmed).toBeDefined();
    expect(f.view().history?.before).toBeUndefined();

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });

    expect(request.mock.calls.map(([params]) => params.window)).toEqual([
      { turns: HISTORY_FIRST_PAGE_TURNS },
      { beforeEntry: "e79", turns: HISTORY_EARLIER_PAGE_TURNS },
    ]);
    expect(f.view().trimmed).toBeUndefined();
    expect(f.view().entries.map(row => (row as { id?: string }).id)).toEqual(entries.slice(40).map(row => row.id));
    expect(f.view().history?.before).toBeDefined();
    const recovered = f.view();
    await f.loader.reconcile(state.path);
    expect(request).toHaveBeenCalledTimes(2);
    expect(f.view()).toBe(recovered);
  });

  it("mints a cursor from the retained anchor without dropping an older focused row", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    hydrateComplete(f);
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z",
      anchored: ["e10"], standing: { anchorEntryId: "e10", focusedEntryId: "e10" } });
    expect(f.view().trimmed).toBeDefined();
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "e10")).toBe(true);
    const recovery = f.view().history?.anchor;
    expect(recovery).toBeDefined();
    expect(recovery).not.toBe("e0");

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });

    expect(request.mock.calls[0]![0]).toMatchObject({ window: { beforeEntry: recovery, turns: HISTORY_EARLIER_PAGE_TURNS }, baseRevision: scope.revision });
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "e10")).toBe(true);
    expect(f.view().entries.some(row => (row as { id?: string }).id === "e10")).toBe(true);
    // The same bounded control walks the missing middle instead of declaring false exhaustion.
    while (f.view().history?.gapBefore || f.view().history?.before) expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(new Set(f.view().entries.map(row => (row as { id?: string }).id))).toEqual(new Set(entries.map(row => row.id)));
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "e10")).toBe(true);
    expect(f.view().history).toMatchObject({ complete: true });
  });

  it("keeps an earlier page whose boundary row is held as a stub rather than an entry", async () => {
    // The person's real session: the oldest row this view held was an
    // oversized record the producer had left out of the page, so the boundary
    // the next request names is a stub and not one of the rendered entries.
    // The page used to be dropped on the way in, the same cursor was asked for
    // again for ever, and the top of the conversation stayed a skeleton while
    // the person scrolled (D-302).
    const oversized = { ...entries[60]!, message: { role: "user", content: [{ type: "text", text: "x".repeat(4096) }] } };
    const elidedSource = { entries: entries.map((entry, index) => (index === 60 ? oversized : entry)), leafId: "e79" };
    const request = vi.fn(async (params: Params) => withElidedBodies(historyWindow(elidedSource, params.window!, scope), 512, text => `digest-${text.length}`));
    const f = fixture(request);
    await f.loader.read(state.path);
    const held = f.view();
    expect(held.history?.anchor).toBe("e60");
    expect(held.entries.some(entry => (entry as { id?: string }).id === "e60")).toBe(false);
    expect(held.stubs?.some(stub => stub.id === "e60")).toBe(true);
    const before = held.history!.before!;

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    while (f.view().history?.before) expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });

    // The page landed at the front, whole, and the cursor moved on.
    expect(f.view().entries.map(entry => (entry as { id: string }).id))
      .toEqual([...entries.slice(0, 60), ...entries.slice(61)].map(entry => entry.id));
    expect(f.view().history?.before).not.toBe(before);
    expect(f.view().history?.complete).toBe(true);
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "e0")).toBe(true);
    // And the loader is not asking the producer the same question again.
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: false });
    expect(request.mock.calls[1]![0].window).toMatchObject({ before });
  });

  it("recovers a producer-split middle gap even when no device trim created it", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    const held = f.view();
    const root = historyWindow({ entries: entries.slice(0, 10), leafId: "e9" }, { all: true }, scope);
    f.dispatch({ type: "historyPrepend", path: state.path, before: held.history!.before!, anchor: held.history!.anchor!,
      baseRevision: scope.revision, ownerRevision: held.historyRevision, entries: root.entries,
      window: { ...root.window, complete: false } });

    expect(f.view().history).toMatchObject({ anchor: "e0", gapBefore: "e60", complete: false });
    expect(f.view().history?.before).toBeUndefined();
    while (f.view().history?.gapBefore || f.view().history?.before) expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ window: { beforeEntry: "e60", turns: HISTORY_EARLIER_PAGE_TURNS }, baseRevision: scope.revision }));
    expect(f.view().entries.map(row => (row as { id?: string }).id)).toEqual(entries.map(row => row.id));
    expect(f.view().history?.complete).toBe(true);
  });

  it("walks a multi-page middle gap without repointing the oldest anchor or page metadata", async () => {
    const many = Array.from({ length: 160 }, (_, i) => ({ type: "message", id: `g${i}`, parentId: i ? `g${i - 1}` : null,
      message: { role: i % 2 ? "assistant" : "user", content: `gap ${i}` } }));
    const gapSource = { entries: many, leafId: "g159" };
    const request = vi.fn(async (params: Params) => historyWindow(gapSource, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    const held = f.view();
    const root = historyWindow({ entries: many.slice(0, 10), leafId: "g9" }, { all: true }, scope);
    f.dispatch({ type: "historyPrepend", path: state.path, before: held.history!.before!, anchor: held.history!.anchor!,
      baseRevision: scope.revision, ownerRevision: held.historyRevision, entries: root.entries,
      window: { ...root.window, complete: false, priorGoalIds: ["held-goal"] } });
    expect(f.view().history).toMatchObject({ anchor: "g0", gapBefore: "g140", userOffset: 0, priorGoalIds: ["held-goal"] });

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().history).toMatchObject({ anchor: "g0", gapBefore: "g100", userOffset: 0, priorGoalIds: ["held-goal"] });
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().history).toMatchObject({ anchor: "g0", gapBefore: "g60", userOffset: 0, priorGoalIds: ["held-goal"] });
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().history).toMatchObject({ anchor: "g0", gapBefore: "g20", userOffset: 0, priorGoalIds: ["held-goal"] });
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().history).toMatchObject({ anchor: "g0", complete: true, userOffset: 0, priorGoalIds: ["held-goal"] });
    expect(f.view().history?.gapBefore).toBeUndefined();
    expect(f.view().entries.map(entry => (entry as { id: string }).id)).toEqual(many.map(entry => entry.id));
  });

  it("keeps a body-heavy retained window when its old anchor-to-live suffix exceeds the page ceiling", async () => {
    const heavyEntries = Array.from({ length: 320 }, (_, index) => ({
      type: "message", id: `heavy-${index}`, parentId: index ? `heavy-${index - 1}` : null,
      message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `${index}:${"x".repeat(8 * 1024)}` }] },
    }));
    const heavySource = { entries: heavyEntries, leafId: "heavy-319" };
    const heavyScope = { ...scope, seq: 44 };
    const request = vi.fn(async (params: Params) => {
      const page = boundedHistoryWindow(heavySource, params.window!, heavyScope);
      if (!page) throw { code: ErrorCodes.RevisionUnavailable };
      return page;
    });
    const f = fixture(request);
    f.dispatch({ type: "historyBegin", path: state.path, token: "loaded-pages" });
    f.dispatch({ type: "historySnapshot", path: state.path, token: "loaded-pages", ...historyWindow(heavySource, { all: true }, heavyScope) });
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 32 * 1024, at: "2026-09-18T00:00:00.000Z",
      anchored: ["heavy-40"], standing: { anchorEntryId: "heavy-40", focusedEntryId: "heavy-40" } });
    const retained = f.view();
    const retainedIds = retained.entries.map(row => (row as { id: string }).id);
    expect(retained.trimmed).toBeDefined();
    expect(retainedIds).toContain("heavy-40");
    expect(boundedHistoryWindow(heavySource, { from: "heavy-40" }, heavyScope)).toBeUndefined();
    const recovery = retained.history?.anchor;
    expect(recovery).toBeDefined();
    expect(recovery).not.toBe("heavy-0");
    f.dispatch({ type: "optimisticUser", path: state.path, id: "pending-user", text: "keep my prompt", images: [] });
    f.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: heavyScope.epoch, seq: 45, at: "2026-09-18T00:00:01.000Z", update: { kind: "message_start", role: "assistant" } } } as never);
    f.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: heavyScope.epoch, seq: 46, at: "2026-09-18T00:00:02.000Z", update: { kind: "text_delta", delta: "live output", contentIndex: 0 } } } as never);
    const optimistic = f.view().blocks.find(block => block.id === "pending-user");
    const streaming = f.view().blocks.find(block => block.kind === "assistant" && block.streaming);

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });

    expect(request.mock.calls.map(([params]) => params.window)).not.toContainEqual({ from: "heavy-40" });
    expect(request.mock.calls.map(([params]) => params.window)).not.toContainEqual({ tail: 40 });
    expect(request.mock.calls[0]![0].window).toEqual({ beforeEntry: recovery, turns: HISTORY_EARLIER_PAGE_TURNS });
    const afterIds = f.view().entries.map(row => (row as { id: string }).id);
    for (const id of retainedIds) expect(afterIds).toContain(id);
    expect(afterIds.length).toBeGreaterThan(retainedIds.length);
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "heavy-40")).toBe(true);
    expect(f.view().blocks.find(block => block.id === "pending-user")).toBe(optimistic);
    expect(f.view().blocks.find(block => block.kind === "assistant" && block.streaming)).toBe(streaming);
  });

  it("keeps an invalid opaque cursor as a silent no-op", async () => {
    const request = vi.fn(async (params: Params) => {
      if (params.window && "before" in params.window) throw { code: ErrorCodes.InvalidParams };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    const retained = f.view();

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: false });

    expect(request.mock.calls.map(([params]) => params.window)).toEqual([
      { turns: HISTORY_FIRST_PAGE_TURNS },
      { before: expect.any(String), turns: HISTORY_EARLIER_PAGE_TURNS },
    ]);
    expect(f.view()).toBe(retained);
  });

  it("keeps the retained window when both its cursor and anchor are stale", async () => {
    const request = vi.fn(async (params: Params) => {
      if (params.window && ("before" in params.window || "beforeEntry" in params.window)) throw { code: ErrorCodes.InvalidParams };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    const retained = f.view();

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: false });

    expect(request.mock.calls.map(([params]) => params.window)).toEqual([
      { turns: HISTORY_FIRST_PAGE_TURNS },
      { before: expect.any(String), turns: HISTORY_EARLIER_PAGE_TURNS },
    ]);
    expect(f.view().entries).toBe(retained.entries);
    expect(f.view().blocks).toBe(retained.blocks);
  });

  it("fences a retained-anchor recovery that a recent replacement overtakes", async () => {
    const pending = deferred<Result>();
    let recovering = false;
    const request = vi.fn(async (params: Params) => recovering && params.window && "beforeEntry" in params.window
      ? pending.promise : historyWindow(source, params.window!, scope));
    const f = fixture(request);
    hydrateComplete(f);
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z",
      anchored: ["e10"], standing: { anchorEntryId: "e10", focusedEntryId: "e10" } });
    recovering = true;
    const old = f.loader.earlier(state.path, () => true);
    await Promise.resolve();
    recovering = false;
    await f.loader.recent(state.path, () => true);
    const accepted = f.view();
    pending.resolve(historyWindow(source, { beforeEntry: "e10", limit: 40 }, scope));

    expect(await old).toMatchObject({ accepted: false });
    expect(f.view()).toBe(accepted);
  });

  it("rejects retained-anchor recovery when the producer cannot prove the held revision", async () => {
    let recovering = false;
    const request = vi.fn(async (params: Params) => {
      if (recovering) throw { code: ErrorCodes.RevisionUnavailable };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    hydrateComplete(f);
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z",
      anchored: ["e10"], standing: { anchorEntryId: "e10", focusedEntryId: "e10" } });
    const held = f.view();
    recovering = true;

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: false });
    expect(f.view().entries).toBe(held.entries);
    expect(f.view().history?.refusal).toEqual({ cause: "stale-base", message: "This conversation changed since that page was read. Re-read recent messages to continue." });
  });

  it("surfaces a compaction refusal and rereads the bounded current tail without reload", async () => {
    const compacted = { ...scope, revision: "r1.test.compacted" };
    let phase: "initial" | "refused" | "reread" = "initial";
    const request = vi.fn(async (params: Params) => {
      if (phase === "initial") return historyWindow(source, params.window!, scope);
      if (phase === "refused") throw { code: ErrorCodes.RevisionUnavailable, message: "This conversation changed since that page was read. Reload it and try again." };
      return historyWindow(source, params.window!, compacted);
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    const held = f.view();
    phase = "refused";

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: false });
    expect(request).toHaveBeenCalledTimes(2);
    expect(f.view().entries).toBe(held.entries);
    expect(f.view().history?.refusal).toEqual({ cause: "stale-base", message: "This conversation changed since that page was read. Reload it and try again." });

    phase = "reread";
    await f.loader.reread(state.path, () => true);
    expect(request.mock.calls[2]![0]).toMatchObject({ window: { turns: HISTORY_FIRST_PAGE_TURNS }, baseRevision: scope.revision });
    expect(f.view().history).toMatchObject({ revision: compacted.revision });
    expect(f.view().history?.refusal).toBeUndefined();
  });

  it("keeps one covered baseline through two moved pages, then acquires both appends as a delta", async () => {
    const baseEntries = Array.from({ length: 120 }, (_, i) => ({ type: "message", id: `p${i}`, parentId: i ? `p${i - 1}` : null,
      message: { role: i % 2 ? "assistant" : "user", content: `page ${i}` } }));
    const appendOne = [
      { type: "message", id: "p120", parentId: "p119", message: { role: "user", content: "first append" } },
      { type: "message", id: "p121", parentId: "p120", message: { role: "assistant", content: "first answer" } },
    ];
    const appendTwo = [
      { type: "message", id: "p122", parentId: "p121", message: { role: "user", content: "second append" } },
      { type: "message", id: "p123", parentId: "p122", message: { role: "assistant", content: "second answer" } },
    ];
    const baseSource = { entries: baseEntries, leafId: "p119" };
    const once = { entries: [...baseEntries, ...appendOne], leafId: "p121" };
    const twice = { entries: [...once.entries, ...appendTwo], leafId: "p123" };
    const pageOne = { ...scope, revision: "r1.test.page-one" };
    const pageTwo = { ...scope, revision: "r1.test.page-two" };
    let phase: "initial" | "page-one" | "page-two" | "recent" = "initial";
    const request = vi.fn(async (params: Params) => phase === "initial"
      ? historyWindow(baseSource, params.window!, scope)
      : phase === "page-one"
        ? historyWindow(once, params.window!, pageOne)
        : phase === "page-two"
          ? historyWindow(twice, params.window!, pageTwo)
          : historyWindow(twice, params.window!, { ...pageTwo, selection: { kind: "delta", after: "p119" } }));
    const f = fixture(request);
    await f.loader.read(state.path);
    const ownerRevision = f.view().historyRevision;

    phase = "page-one";
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    phase = "page-two";
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(request.mock.calls[1]![0]).toMatchObject({ baseRevision: scope.revision });
    expect(request.mock.calls[2]![0]).toMatchObject({ baseRevision: scope.revision });
    while (f.view().history?.before) expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().entries).toEqual(baseEntries);
    expect(f.view().validated?.revision).toBe(scope.revision);
    expect(f.view().historyRevision).toBe(ownerRevision);

    f.dispatch({ type: "optimisticUser", path: state.path, text: "unsent local prompt", images: [] });
    phase = "recent";
    await f.loader.recent(state.path, () => true);

    expect(request.mock.calls.at(-1)![0]).toMatchObject({ window: { turns: HISTORY_FIRST_PAGE_TURNS }, baseRevision: scope.revision });
    expect(f.view().entries).toEqual(twice.entries);
    expect(f.view().validated?.revision).toBe(pageTwo.revision);
    expect(f.view().blocks.some(block => block.kind === "user" && block.optimistic && block.text === "unsent local prompt")).toBe(true);
    f.dispatch({ type: "views/evict", paths: [state.path], reason: "count", at: "2026-09-18T00:00:10.000Z" });
    expect(f.view().validated?.revision).toBe(pageTwo.revision);
  });

  it("drops an older page when a trim overtakes it, then the same control path still works", async () => {
    const pending = deferred<Result>();
    let holdOlder = false;
    const request = vi.fn(async (params: Params) => holdOlder && params.window && "before" in params.window
      ? pending.promise : historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    holdOlder = true;
    const stale = f.loader.earlier(state.path, () => true);
    await Promise.resolve();
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z" });
    const held = f.view().entries;
    expect(f.view().trimmed).toBeDefined();
    pending.resolve(historyWindow(source, { before: historyWindow(source, { tail: 40 }, scope).window!.before! }, scope));
    expect(await stale).toMatchObject({ accepted: false });
    expect(f.view().entries).toBe(held);

    holdOlder = false;
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().trimmed).toBeUndefined();
    expect(f.view().entries.map(row => (row as { id?: string }).id)).toEqual(entries.slice(40).map(row => row.id));
  });

  it("keeps the loaded transcript on screen until the recent one replaces it, and replays what arrives meanwhile", async () => {
    const pending = deferred<Result>();
    const f = fixture(async params => params.window && isLiveEdgeWindow(params.window) && f.view().hydrated
      ? pending.promise : historyWindow(source, params.window!, scope));
    hydrateComplete(f);
    expect(f.view().blocks).toHaveLength(80);
    const before = f.view().blocks;
    f.dispatch({ type: "optimisticUser", path: state.path, id: "sending", text: "Sent from here", images: [] });
    const replacement = f.loader.recent(state.path, () => true);
    // Nothing is retired before the answer arrives (RP-11): what a person was
    // reading stays exactly where it was, and their unsent message with it.
    expect(f.view().entries).toHaveLength(80);
    expect(f.view().blocks.slice(0, 80)).toEqual(before);
    expect(f.view().blocks.at(-1)).toMatchObject({ id: "sending", optimistic: true });
    expect(f.view().hydrated).toBe(true);
    expect(f.view().history).toBeDefined();
    f.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: scope.epoch, seq: 9, at: "2026-01-01T00:00:00Z", update: { kind: "agent_start" } } });
    pending.resolve(historyWindow(source, { turns: HISTORY_FIRST_PAGE_TURNS }, { ...scope, seq: 8 }));
    await replacement;
    // One transaction replaced it: the older page is gone, the tail is here,
    // and the unsent message and the update that overtook the read both stand.
    expect(f.view().hydrated).toBe(true);
    expect(f.view().entries).toHaveLength(20);
    expect(f.view().blocks).toHaveLength(21);
    expect(f.view().blocks.at(-1)).toMatchObject({ id: "sending", optimistic: true });
    expect(f.view().lastSeq).toBe(9);
  });

  it("accepts the tail on every ordinary re-entry, not only the first", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.recent(state.path, () => true);
    const first = f.view().historyRevision;
    expect(f.view().blocks).toHaveLength(20);
    hydrateComplete(f);
    expect(f.view().blocks).toHaveLength(80);
    // The second return has a revision of its own to replace; retiring that
    // window must not make the read refuse its own answer.
    await f.loader.recent(state.path, () => true);
    expect(f.view()).toMatchObject({ hydrated: true });
    expect(f.view().blocks).toHaveLength(20);
    expect(f.view().entries).toHaveLength(20);
    expect(f.view().historyRevision).not.toBe(first);
    // One authoritative read per return, and nothing rescued it afterwards.
    expect(request.mock.calls.map(([params]) => params.window)).toEqual([{ turns: HISTORY_FIRST_PAGE_TURNS }, { turns: HISTORY_FIRST_PAGE_TURNS }]);
    await f.loader.recent(state.path, () => true);
    expect(f.view().blocks).toHaveLength(20);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["earlier", "metadata"] as const)("fences an old %s response even when the new tail has the same cursor and epoch", async kind => {
    const old = deferred<Result>();
    let hold = false;
    const request = vi.fn(async (params: Params) => hold && !(params.window && isLiveEdgeWindow(params.window))
      ? old.promise : historyWindow(source, params.window!, { ...scope, seq: 2 }));
    const f = fixture(request);
    await f.loader.read(state.path);
    const before = f.view().history!.before!;
    hold = true;
    const stale = f.loader[kind](state.path, () => true);
    await f.loader.read(state.path, () => true, undefined, "recent");
    const accepted = f.view();
    expect(accepted.history?.before).toBe(before);
    const obsolete = { type: "message", id: "obsolete", parentId: "e79", message: { role: "assistant", content: "abandoned branch" } };
    old.resolve(kind === "earlier" ? historyWindow(source, { before }, scope)
      : historyWindow({ entries: [...entries, obsolete], leafId: "obsolete" }, { from: "e79" }, { ...scope, seq: 1 }));
    await stale;
    expect(f.view()).toBe(accepted);
    expect(f.view().entries).toHaveLength(20);
    expect(f.view().leafId).toBe("e79");
  });

  it("fences earlier replies from a predecessor loader after another loader accepts a recent tail", async () => {
    const old = deferred<Result>();
    const f = fixture(async params => params.window && "before" in params.window ? old.promise : historyWindow(source, params.window!, scope));
    await f.loader.read(state.path);
    const before = f.view().history!.before!;
    const staleAnchor = f.view().history!.anchor!;
    const staleBaseRevision = f.view().history!.revision;
    const staleOwnerRevision = f.view().historyRevision;
    const earlier = f.loader.earlier(state.path, () => true);
    await f.replace(async params => historyWindow(source, params.window!, scope)).recent(state.path, () => true);
    const accepted = f.view();
    const stale = historyWindow(source, { before }, scope);
    old.resolve(stale);
    expect(await earlier).toMatchObject({ accepted: false });
    expect(f.view()).toBe(accepted);
    f.dispatch({ type: "historyPrepend", path: state.path, before, anchor: staleAnchor, baseRevision: staleBaseRevision, ownerRevision: staleOwnerRevision, entries: stale.entries, window: stale.window });
    expect(f.view()).toBe(accepted);
  });

  it("does not claim window metadata a response without any did not carry", async () => {
    const f = fixture(async () => source);
    await f.loader.recent(state.path, () => true);
    // The legacy shape still loads the session; it simply is not a window, so
    // nothing downstream may treat it as an accepted recent-tail revision.
    expect(f.view().hydrated).toBe(true);
    expect(f.view().entries).toEqual(entries);
    expect(f.view().history).toBeUndefined();
    expect(f.view().historyRevision).toBeUndefined();
  });

  it("coalesces concurrent tail reads and drops a late result after close", async () => {
    const pending = deferred<Result>();
    const request = vi.fn(() => pending.promise);
    const f = fixture(request);
    const first = f.loader.read(state.path);
    const second = f.loader.read(state.path);
    expect(request).toHaveBeenCalledTimes(1);
    f.dispatch({ type: "closeView", path: state.path });
    pending.resolve(historyWindow(source, { tail: 40 }, scope));
    await Promise.all([first, second]);
    expect(f.view()).toBeUndefined();
    expect(f.track).not.toHaveBeenCalled();
  });

  it("does not let a replaced client settle or clear its successor's request", async () => {
    const oldRead = deferred<Result>(); const newRead = deferred<Result>();
    const f = fixture(() => oldRead.promise);
    const first = f.loader.read(state.path);
    const second = f.replace(() => newRead.promise).read(state.path);
    oldRead.resolve(historyWindow(source, { tail: 40 }, scope));
    await first;
    expect(f.view().hydrated).toBe(false);
    expect(f.view().historyPending).toBeDefined();
    expect(f.track).not.toHaveBeenCalled();
    newRead.resolve(historyWindow(source, { tail: 40 }, { ...scope, epoch: "two" }));
    await second;
    expect(f.view().history?.epoch).toBe("two");
    expect(f.view().historyPending).toBeUndefined();
  });

  it("finishes message paging without claiming unloaded versions", async () => {
    const branched = { ...source, entries: [...entries, { type: "message", id: "other", parentId: "e1", message: { role: "user", content: "Another version" } }] };
    const request = vi.fn(async (params: Params) => historyWindow(branched, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    expect(f.view().history).toMatchObject({ complete: false, branchesUnloaded: true });
    while (f.view().history?.before) expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.view().history).toMatchObject({ complete: true, branchesUnloaded: true });
    expect(f.view().history?.before).toBeUndefined();
    expect(f.view().blocks).toHaveLength(80);
    const count = request.mock.calls.length;
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: false });
    expect(request).toHaveBeenCalledTimes(count);
    expect(request.mock.calls.every(([params]) => !params.window || !("all" in params.window))).toBe(true);
    expect(f.view().entries).toHaveLength(80);
  });

  it("keeps an active tree when a bounded refresh cannot prove its base, then explicit reread replaces it", async () => {
    let snapshot: { entries: unknown[]; leafId: string } = source;
    let epoch = scope.epoch;
    const request = vi.fn(async (params: Params) => historyWindow(snapshot, params.window!, { ...scope, epoch }));
    const f = fixture(request);
    hydrateComplete(f);
    const held = f.view();
    const other = { type: "message", id: "root-sibling", parentId: null, message: { role: "user", content: "Other root" } };
    snapshot = { entries: [...entries, other], leafId: other.id };

    await f.loader.read(state.path);

    expect(request.mock.calls[0]![0]).toMatchObject({ window: { turns: HISTORY_FIRST_PAGE_TURNS }, baseRevision: scope.revision });
    expect(f.view().entries).toBe(held.entries);
    expect(f.view().blocks).toBe(held.blocks);
    expect(f.view().history?.refusal?.cause).toBe("stale-base");
    epoch = "replacement";
    await f.loader.recent(state.path, () => true);
    expect(f.view().entries).toEqual([other]);
    expect(f.view().history).toMatchObject({ epoch, complete: true, branchesUnloaded: true });
    expect(f.view().history?.refusal).toBeUndefined();
  });

  it("refreshes a large active window with one bounded proved delta", async () => {
    let first = true;
    const request = vi.fn(async (params: Params) => {
      if (first) { first = false; return historyWindow(source, params.window!, scope); }
      return historyWindow(source, params.window!, { ...scope, selection: { kind: "delta", after: "e79" } });
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    const held = f.view().entries;

    await f.loader.read(state.path);

    expect(request.mock.calls.map(([params]) => params)).toEqual([
      { path: state.path, window: { turns: HISTORY_FIRST_PAGE_TURNS }, bodyLimit: BODY_EXCERPT_MAX_BYTES },
      { path: state.path, window: { turns: HISTORY_FIRST_PAGE_TURNS }, bodyLimit: BODY_EXCERPT_MAX_BYTES, baseRevision: scope.revision },
    ]);
    expect(f.view().entries).toEqual(held);
    expect(f.view().history?.refusal).toBeUndefined();
  });

  it("does not announce an accepted page that contains no new records", async () => {
    const f = fixture(async params => historyWindow(source, params.window!, scope));
    await f.loader.read(state.path);
    const held = f.view();
    const duplicate = historyWindow(source, { turns: HISTORY_FIRST_PAGE_TURNS }, scope);
    f.dispatch({ type: "historyPrepend", path: state.path, before: held.history!.before!, anchor: held.history!.anchor!,
      baseRevision: scope.revision, ownerRevision: held.historyRevision, entries: duplicate.entries, window: duplicate.window });
    expect(f.view()).toBe(held);
  });

  it("reprojects a released visible block even when its canonical record is still retained", async () => {
    const f = fixture(async params => historyWindow(source, params.window!, scope));
    await f.loader.read(state.path);
    const held = f.view();
    const released = held.blocks.at(-1)!;
    held.blocks = held.blocks.slice(0, -1);
    const duplicate = historyWindow(source, { tail: 40 }, scope);
    f.dispatch({ type: "historyPrepend", path: state.path, before: held.history!.before!, anchor: held.history!.anchor!,
      baseRevision: scope.revision, ownerRevision: held.historyRevision, entries: duplicate.entries, window: duplicate.window });
    expect(f.view().blocks.some(block => block.id === released.id)).toBe(true);
  });

  it("does not claim complete ancestry when the producer leaf is unavailable", async () => {
    const f = fixture(async params => historyWindow(source, params.window!, scope));
    await f.loader.read(state.path);
    const held = f.view();
    f.dispatch({ type: "entries", path: state.path, entries: held.entries, leafId: "missing-leaf" });
    const older = historyWindow(source, { before: held.history!.before! }, scope);
    f.dispatch({ type: "historyPrepend", path: state.path, before: held.history!.before!, anchor: held.history!.anchor!,
      baseRevision: scope.revision, ownerRevision: held.historyRevision, entries: older.entries, window: older.window });
    expect(f.view().history?.complete).toBe(false);
  });

  it("does not install a page after its caller changes intent", async () => {
    const pending = deferred<Result>();
    const request = vi.fn().mockResolvedValueOnce(historyWindow(source, { tail: 40 }, scope)).mockReturnValueOnce(pending.promise);
    const f = fixture(request);
    await f.loader.read(state.path);
    const view = f.view();
    let accepting = true;
    const page = f.loader.earlier(state.path, () => accepting);
    accepting = false;
    pending.resolve(historyWindow(source, { before: view.history!.before! }, scope));
    expect(await page).toMatchObject({ accepted: false });
    expect(f.view()).toBe(view);
  });

  it("adopts a restarted epoch and tracks the newer update replayed over its snapshot", async () => {
    const pending = deferred<Result>();
    const request = vi.fn().mockResolvedValueOnce(historyWindow(source, { tail: 40 }, { ...scope, seq: 500 })).mockReturnValueOnce(pending.promise);
    const f = fixture(request);
    await f.loader.read(state.path);
    const loading = f.loader.recent(state.path, () => true);
    f.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: "two", seq: 2, at: "2026-01-01T00:00:00Z", update: { kind: "text_delta", delta: " after", contentIndex: 0 } } });
    pending.resolve(historyWindow(source, { tail: 40 }, { ...scope, epoch: "two", seq: 1, live: { running: true, tools: [], message: { id: "live", value: { content: [{ type: "text", text: "before" }] } } } }));
    await loading;
    expect(f.adoptEpoch).toHaveBeenCalledWith(state.path, 1);
    expect(f.track).toHaveBeenLastCalledWith(state.path, 2);
    expect(f.view().blocks.at(-1)).toMatchObject({ text: "before after" });
  });

  it("asks for turn windows, never a 40-entry tail or limit", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(request.mock.calls.map(([params]) => params.window)).toEqual([
      { turns: HISTORY_FIRST_PAGE_TURNS },
      { before: expect.any(String), turns: HISTORY_EARLIER_PAGE_TURNS },
    ]);
    expect(request.mock.calls.some(([params]) => params.window && ("tail" in params.window || ("limit" in params.window && !("turns" in params.window))))).toBe(false);
  });

  it("keeps every page the person scrolled into when a background refresh cannot prove its base, and refuses nothing", async () => {
    // The measured session: a turn appends more rows than the producer keeps
    // checkpoints for, so at the turn's end the base this view holds is stale
    // and the refresh is answered with a replacement page — the newest ten
    // turns. Meanwhile the person has paged up two pages and is reading there.
    const grown = {
      entries: [...entries, { type: "message", id: "e80", parentId: "e79", message: { role: "user", content: "later" } }],
      leafId: "e80",
    };
    let stale = false;
    const request = vi.fn(async (params: Params) => stale
      ? historyWindow(grown, params.window!, { ...scope, revision: "r1.test.grown", seq: 1, selection: { kind: "replace" } })
      : historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    const idOf = (row: unknown) => (row as { id: string }).id;
    const held = f.view();
    const heldIds = held.entries.map(idOf);
    expect(heldIds[0]).toBe("e20");
    expect(heldIds).toHaveLength(60);
    expect(held.history?.before).toBeDefined();

    stale = true;
    await f.loader.metadata(state.path, () => true);

    // Nobody asked for a page, so nobody is told one was refused; and nothing
    // the person is reading was replaced by the newest ten turns.
    expect(f.view().history?.refusal).toBeUndefined();
    expect(f.view().entries.map(idOf)).toEqual(heldIds);
    expect(f.view().blocks).toBe(held.blocks);
    expect(f.view().history?.before).toBe(held.history?.before);
    expect(f.view().history?.anchor).toBe(held.history?.anchor);
    expect(f.view().history?.complete).toBe(held.history?.complete);
    expect(f.view().historyPending).toBeUndefined();
  });

  it("inserts a page before a stubbed anchor's own block, not at the front of the transcript", async () => {
    const at = "2026-09-18T12:00:00.000Z";
    const oversized = { ...entries[60]!, timestamp: at, message: { role: "user", content: [{ type: "text", text: "x".repeat(4096) }] } };
    const elidedSource = { entries: entries.map((entry, index) => (index === 60 ? oversized : entry)), leafId: "e79" };
    const request = vi.fn(async (params: Params) => withElidedBodies(historyWindow(elidedSource, params.window!, scope), 512, text => `digest-${text.length}`));
    const f = fixture(request);
    await f.loader.read(state.path);
    expect(f.view().history?.anchor).toBe("e60");
    const stub = f.view().stubs?.find(row => row.id === "e60");
    expect(stub).toBeDefined();
    expect(stub?.at).toBe(at);
    expect(f.view().blocks.findIndex(block => "entryId" in block && block.entryId === "e60")).toBe(0);

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });

    const ids = f.view().blocks.flatMap(block => "entryId" in block && block.entryId ? [block.entryId] : []);
    const stubAt = ids.indexOf("e60");
    const pageFirst = ids.indexOf("e20");
    expect(pageFirst).toBe(0);
    expect(stubAt).toBeGreaterThan(0);
    expect(pageFirst).toBeLessThan(stubAt);
    expect(ids[stubAt - 1]).toBe("e59");
  });

  it("recovers from the first retained branch record after a trim, not the session's first record", async () => {
    const prologue = { type: "label", id: "session-root", parentId: null, targetId: "e0", label: "start" };
    const chained = entries.map((entry, index) => (index === 0 ? { ...entry, parentId: "session-root" } : entry));
    const rooted = { entries: [prologue, ...chained], leafId: "e79" };
    const request = vi.fn(async (params: Params) => historyWindow(rooted, params.window!, scope));
    const f = fixture(request);
    const page = historyWindow(rooted, { all: true }, scope);
    f.dispatch({ type: "historyBegin", path: state.path, token: "root" });
    f.dispatch({ type: "historySnapshot", path: state.path, token: "root", ...page, entries: [prologue, ...page.entries] });
    expect(f.view().history?.complete).toBe(true);
    expect(f.view().entries.some(entry => (entry as { id: string }).id === "session-root")).toBe(true);
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "session-root")).toBe(false);

    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z" });
    const history = f.view().history!;
    expect(history.anchor).toBeDefined();
    expect(history.anchor).not.toBe("session-root");
    expect(history.anchor).not.toBe("e0");
    expect(f.view().entries.some(entry => (entry as { id: string }).id === "session-root")).toBe(false);
    expect(f.view().entries.some(entry => (entry as { id: string }).id === history.anchor)).toBe(true);
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
  });
});

describe("a read whose transcript was released while it was in flight (RP-5)", () => {
  it("lands nowhere, and leaves the dormant view empty", async () => {
    const pending = deferred<Result>();
    const f = fixture(async params => params.window && isLiveEdgeWindow(params.window) && f.view().hydrated
      ? pending.promise : historyWindow(source, params.window!, scope));
    await f.loader.read(state.path);
    expect(f.view().blocks).toHaveLength(20);

    const inFlight = f.loader.recent(state.path, () => true);
    await Promise.resolve();
    // The bound released this conversation's transcript while the worker was
    // still answering: the answer is for a transcript that no longer exists.
    f.dispatch({ type: "views/evict", paths: [state.path], reason: "count", at: "2026-09-15T02:00:00.000Z" });
    pending.resolve(historyWindow(source, { turns: HISTORY_FIRST_PAGE_TURNS }, scope));
    await inFlight;

    expect(f.view().entries).toEqual([]);
    expect(f.view().blocks).toEqual([]);
    expect(f.view().hydrated).toBe(false);
    expect(f.view().dormant).toBeDefined();
  });

  it("refuses an older page and a metadata refresh for the same reason", async () => {
    const f = fixture(async params => historyWindow(source, params.window!, scope));
    await f.loader.read(state.path);
    expect(f.view().blocks).toHaveLength(20);
    f.dispatch({ type: "views/evict", paths: [state.path], reason: "bytes", at: "2026-09-15T02:00:00.000Z" });

    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: false });
    await f.loader.metadata(state.path, () => true);

    expect(f.view().entries).toEqual([]);
    expect(f.view().blocks).toEqual([]);
  });
});
