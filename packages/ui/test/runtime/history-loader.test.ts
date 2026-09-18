import { BODY_EXCERPT_MAX_BYTES } from "@/runtime/body-excerpt";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, boundedHistoryWindow, historyWindow, type ClientRequests, type SessionState } from "@lasercode/protocol";
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
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe("history request ownership", () => {
  it("replaces a complete cached tree with an authoritative recent tail and can page it again", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path, true);
    expect(f.view().blocks).toHaveLength(80);
    await f.loader.read(state.path, false, () => true, undefined, "recent");
    expect(request).toHaveBeenLastCalledWith({ path: state.path, window: { tail: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES, baseRevision: scope.revision });
    const expected = historyWindow(source, { tail: 40 }, scope);
    expect(f.view().entries).toEqual(expected.entries);
    expect(f.view().history).toEqual(expected.window);
    expect(f.view().historyRevision).toBeDefined();
    expect(f.view().blocks).toHaveLength(40);
    expect(f.view().history).toMatchObject({ complete: false, userOffset: 20 });
    const revision = f.view().historyRevision;
    expect(await f.loader.earlier(state.path, () => true)).toBe(true);
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

    expect(await f.loader.earlier(state.path, () => true)).toBe(true);

    expect(request.mock.calls.map(([params]) => params.window)).toEqual([
      { tail: 40 },
      { beforeEntry: "e79", limit: 40 },
    ]);
    expect(f.view().trimmed).toBeDefined();
    expect(f.view().entries.map(row => (row as { id?: string }).id)).toEqual(entries.slice(38).map(row => row.id));
    expect(f.view().history?.before).toBeDefined();
  });

  it("mints a cursor from the retained anchor without dropping an older focused row", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path, true);
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z",
      anchored: ["e10"], standing: { anchorEntryId: "e10", focusedEntryId: "e10" } });
    expect(f.view().trimmed).toBeDefined();
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "e10")).toBe(true);

    expect(await f.loader.earlier(state.path, () => true)).toBe(true);

    expect(request.mock.calls[1]![0]).toMatchObject({ window: { beforeEntry: "e10", limit: 40 }, baseRevision: scope.revision });
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "e10")).toBe(true);
    expect(f.view().entries.some(row => (row as { id?: string }).id === "e10")).toBe(true);
    expect(f.view().history).toMatchObject({ anchor: "e79", complete: false });
    // The root page and retained latest suffix are disjoint. The same bounded
    // control walks the missing middle instead of declaring false exhaustion.
    while (f.view().trimmed) expect(await f.loader.earlier(state.path, () => true)).toBe(true);
    expect(f.view().entries.map(row => (row as { id?: string }).id)).toEqual(entries.map(row => row.id));
    expect(f.view().history).toMatchObject({ anchor: "e0", complete: true });
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

    expect(f.view().history).toMatchObject({ anchor: "e40", complete: false });
    expect(f.view().history?.before).toBeUndefined();
    expect(await f.loader.earlier(state.path, () => true)).toBe(true);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ window: { beforeEntry: "e40", limit: 40 }, baseRevision: scope.revision }));
    expect(f.view().entries.map(row => (row as { id?: string }).id)).toEqual(entries.map(row => row.id));
    expect(f.view().history?.complete).toBe(true);
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
    f.dispatch({ type: "optimisticUser", path: state.path, id: "pending-user", text: "keep my prompt", images: [] });
    f.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: heavyScope.epoch, seq: 45, at: "2026-09-18T00:00:01.000Z", update: { kind: "message_start", role: "assistant" } } } as never);
    f.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: heavyScope.epoch, seq: 46, at: "2026-09-18T00:00:02.000Z", update: { kind: "text_delta", delta: "live output", contentIndex: 0 } } } as never);
    const optimistic = f.view().blocks.find(block => block.id === "pending-user");
    const streaming = f.view().blocks.find(block => block.kind === "assistant" && block.streaming);

    expect(await f.loader.earlier(state.path, () => true)).toBe(true);

    expect(request.mock.calls.map(([params]) => params.window)).not.toContainEqual({ from: "heavy-40" });
    expect(request.mock.calls.map(([params]) => params.window)).not.toContainEqual({ tail: 40 });
    expect(request.mock.calls[0]![0].window).toEqual({ beforeEntry: "heavy-40", limit: 40 });
    const afterIds = f.view().entries.map(row => (row as { id: string }).id);
    for (const id of retainedIds) expect(afterIds).toContain(id);
    expect(afterIds).toContain("heavy-0");
    expect(f.view().blocks.some(block => "entryId" in block && block.entryId === "heavy-40")).toBe(true);
    expect(f.view().blocks.find(block => block.id === "pending-user")).toBe(optimistic);
    expect(f.view().blocks.find(block => block.kind === "assistant" && block.streaming)).toBe(streaming);
  });

  it("recovers a stale opaque cursor by prepending before the retained anchor", async () => {
    const request = vi.fn(async (params: Params) => {
      if (params.window && "before" in params.window) throw { code: ErrorCodes.InvalidParams };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    const retained = f.view().entries;

    expect(await f.loader.earlier(state.path, () => true)).toBe(true);

    expect(request.mock.calls.map(([params]) => params.window)).toEqual([
      { tail: 40 },
      { before: expect.any(String), limit: 40 },
      { beforeEntry: "e40", limit: 40 },
    ]);
    expect(f.view().entries.slice(-retained.length)).toEqual(retained);
    expect(f.view().entries).toEqual(entries);
    expect(f.view().history).toMatchObject({ complete: true, userOffset: 0 });
  });

  it("keeps the retained window when both its cursor and anchor are stale", async () => {
    const request = vi.fn(async (params: Params) => {
      if (params.window && ("before" in params.window || "beforeEntry" in params.window)) throw { code: ErrorCodes.InvalidParams };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    const retained = f.view();

    expect(await f.loader.earlier(state.path, () => true)).toBe(false);

    expect(request.mock.calls.map(([params]) => params.window)).toEqual([
      { tail: 40 },
      { before: expect.any(String), limit: 40 },
      { beforeEntry: "e40", limit: 40 },
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
    await f.loader.read(state.path, true);
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z",
      anchored: ["e10"], standing: { anchorEntryId: "e10", focusedEntryId: "e10" } });
    recovering = true;
    const old = f.loader.earlier(state.path, () => true);
    await Promise.resolve();
    recovering = false;
    await f.loader.recent(state.path, () => true);
    const accepted = f.view();
    pending.resolve(historyWindow(source, { beforeEntry: "e10", limit: 40 }, scope));

    expect(await old).toBe(false);
    expect(f.view()).toBe(accepted);
  });

  it("rejects retained-anchor recovery when the producer cannot prove the held revision", async () => {
    let recovering = false;
    const request = vi.fn(async (params: Params) => {
      if (recovering) throw { code: ErrorCodes.RevisionUnavailable };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    await f.loader.read(state.path, true);
    f.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z",
      anchored: ["e10"], standing: { anchorEntryId: "e10", focusedEntryId: "e10" } });
    const held = f.view();
    recovering = true;

    expect(await f.loader.earlier(state.path, () => true)).toBe(false);
    expect(f.view()).toBe(held);
  });

  it("keeps the covered baseline until a recent delta acquires an append unseen by the older page", async () => {
    const appended = [
      { type: "message", id: "e80", parentId: "e79", message: { role: "user", content: "new prompt" } },
      { type: "message", id: "e81", parentId: "e80", message: { role: "assistant", content: "new answer" } },
    ];
    const evolvedSource = { entries: [...entries, ...appended], leafId: "e81" };
    const evolved = { ...scope, revision: "r1.test.appended" };
    let phase: "initial" | "page" | "recent" = "initial";
    const request = vi.fn(async (params: Params) => phase === "initial"
      ? historyWindow(source, params.window!, scope)
      : phase === "page"
        ? historyWindow(evolvedSource, params.window!, evolved)
        : historyWindow(evolvedSource, params.window!, { ...evolved, selection: { kind: "delta", after: "e79" } }));
    const f = fixture(request);
    await f.loader.read(state.path);
    const ownerRevision = f.view().historyRevision;
    phase = "page";

    expect(await f.loader.earlier(state.path, () => true)).toBe(true);
    expect(request.mock.calls[1]![0]).toMatchObject({ baseRevision: scope.revision });
    expect(f.view().entries).toEqual(entries);
    expect(f.view().history).toMatchObject({ revision: evolved.revision, complete: true });
    expect(f.view().validated?.revision).toBe(scope.revision);
    expect(f.view().historyRevision).toBe(ownerRevision);

    f.dispatch({ type: "optimisticUser", path: state.path, text: "unsent local prompt", images: [] });
    phase = "recent";
    await f.loader.recent(state.path, () => true);

    expect(request.mock.calls[2]![0]).toMatchObject({ window: { tail: 40 }, baseRevision: scope.revision });
    expect(f.view().entries).toEqual(evolvedSource.entries);
    expect(f.view().leafId).toBe("e81");
    expect(f.view().validated?.revision).toBe(evolved.revision);
    expect(f.view().blocks.some(block => block.kind === "user" && block.optimistic && block.text === "unsent local prompt")).toBe(true);
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
    expect(await stale).toBe(false);
    expect(f.view().entries).toBe(held);

    holdOlder = false;
    expect(await f.loader.earlier(state.path, () => true)).toBe(true);
    expect(f.view().trimmed).toBeDefined();
    expect(f.view().entries.map(row => (row as { id?: string }).id)).toEqual(entries.slice(38).map(row => row.id));
  });

  it("keeps the loaded transcript on screen until the recent one replaces it, and replays what arrives meanwhile", async () => {
    const pending = deferred<Result>();
    const f = fixture(async params => params.window && "tail" in params.window && f.view().hydrated
      ? pending.promise : historyWindow(source, params.window!, scope));
    await f.loader.read(state.path, true);
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
    pending.resolve(historyWindow(source, { tail: 40 }, { ...scope, seq: 8 }));
    await replacement;
    // One transaction replaced it: the older page is gone, the tail is here,
    // and the unsent message and the update that overtook the read both stand.
    expect(f.view().hydrated).toBe(true);
    expect(f.view().entries).toHaveLength(40);
    expect(f.view().blocks).toHaveLength(41);
    expect(f.view().blocks.at(-1)).toMatchObject({ id: "sending", optimistic: true });
    expect(f.view().lastSeq).toBe(9);
  });

  it("accepts the tail on every ordinary re-entry, not only the first", async () => {
    const request = vi.fn(async (params: Params) => historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.recent(state.path, () => true);
    const first = f.view().historyRevision;
    expect(f.view().blocks).toHaveLength(40);
    await f.loader.all(state.path, () => true);
    expect(f.view().blocks).toHaveLength(80);
    // The second return has a revision of its own to replace; retiring that
    // window must not make the read refuse its own answer.
    await f.loader.recent(state.path, () => true);
    expect(f.view()).toMatchObject({ hydrated: true });
    expect(f.view().blocks).toHaveLength(40);
    expect(f.view().entries).toHaveLength(40);
    expect(f.view().historyRevision).not.toBe(first);
    // One authoritative read per return, and nothing rescued it afterwards.
    expect(request.mock.calls.map(([params]) => params.window)).toEqual([{ tail: 40 }, { all: true }, { tail: 40 }]);
    await f.loader.recent(state.path, () => true);
    expect(f.view().blocks).toHaveLength(40);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("starts recent-tail replacement immediately instead of coalescing an older all read", async () => {
    const old = deferred<Result>();
    const request = vi.fn(async (params: Params) => params.window && "all" in params.window ? old.promise : historyWindow(source, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    const expanding = f.loader.all(state.path, () => true);
    const resetting = f.loader.read(state.path, false, () => true, undefined, "recent");
    expect(request.mock.calls.map(([p]) => p.window)).toEqual([{ tail: 40 }, { all: true }, { tail: 40 }]);
    await resetting;
    const accepted = f.view();
    old.resolve(historyWindow(source, { all: true }, scope));
    expect(await expanding).toBe(false);
    expect(f.view()).toBe(accepted);
    expect(f.view().blocks).toHaveLength(40);
    expect(f.view().historyPending).toBeUndefined();
  });

  it.each(["earlier", "metadata"] as const)("fences an old %s response even when the new tail has the same cursor and epoch", async kind => {
    const old = deferred<Result>();
    let hold = false;
    const request = vi.fn(async (params: Params) => hold && !(params.window && "tail" in params.window)
      ? old.promise : historyWindow(source, params.window!, { ...scope, seq: 2 }));
    const f = fixture(request);
    await f.loader.read(state.path);
    const before = f.view().history!.before!;
    hold = true;
    const stale = f.loader[kind](state.path, () => true);
    await f.loader.read(state.path, false, () => true, undefined, "recent");
    const accepted = f.view();
    expect(accepted.history?.before).toBe(before);
    const obsolete = { type: "message", id: "obsolete", parentId: "e79", message: { role: "assistant", content: "abandoned branch" } };
    old.resolve(kind === "earlier" ? historyWindow(source, { before }, scope)
      : historyWindow({ entries: [...entries, obsolete], leafId: "obsolete" }, { from: "e79" }, { ...scope, seq: 1 }));
    await stale;
    expect(f.view()).toBe(accepted);
    expect(f.view().entries).toHaveLength(40);
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
    expect(await earlier).toBe(false);
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

  it("finishes message paging without claiming unloaded versions, then explicitly loads those versions", async () => {
    const branched = { ...source, entries: [...entries, { type: "message", id: "other", parentId: "e1", message: { role: "user", content: "Another version" } }] };
    const request = vi.fn(async (params: Params) => historyWindow(branched, params.window!, scope));
    const f = fixture(request);
    await f.loader.read(state.path);
    expect(f.view().history).toMatchObject({ complete: false, branchesUnloaded: true });
    await f.loader.earlier(state.path, () => true);
    expect(f.view().history).toMatchObject({ complete: true, branchesUnloaded: true });
    expect(f.view().history?.before).toBeUndefined();
    expect(f.view().blocks).toHaveLength(80);
    const count = request.mock.calls.length;
    expect(await f.loader.earlier(state.path, () => true)).toBe(false);
    expect(request).toHaveBeenCalledTimes(count);
    expect(await f.loader.all(state.path, () => true)).toBe(true);
    expect(request).toHaveBeenLastCalledWith({ path: state.path, window: { all: true }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
    expect(f.view().history).toMatchObject({ complete: true, branchesUnloaded: false });
    expect(f.view().entries).toHaveLength(81);
    await f.loader.read(state.path);
    expect(f.view().history).toMatchObject({ complete: true, branchesUnloaded: false });
    expect(f.view().entries).toHaveLength(81);
    expect(request).toHaveBeenLastCalledWith({ path: state.path, window: { from: "e0" }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
  });

  it("keeps an active known tree after an invalid refresh anchor; an explicit recent read can replace it", async () => {
    let snapshot: { entries: unknown[]; leafId: string } = source;
    let epoch = scope.epoch;
    const request = vi.fn(async (params: Params) => historyWindow(snapshot, params.window!, { ...scope, epoch }));
    const f = fixture(request);
    await f.loader.read(state.path, true);
    const held = f.view();
    // A sibling before the old root makes that root an invalid active anchor.
    const other = { type: "message", id: "root-sibling", parentId: null, message: { role: "user", content: "Other root" } };
    snapshot = { entries: [...entries, other], leafId: other.id };
    await expect(f.loader.read(state.path)).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    expect(request.mock.calls.slice(1).map(([params]) => params.window)).toEqual([{ from: "e0" }]);
    expect(f.view().entries).toBe(held.entries);
    expect(f.view().blocks).toBe(held.blocks);
    epoch = "replacement";
    await f.loader.recent(state.path, () => true);
    expect(f.view().entries).toEqual([other]);
    expect(f.view().history).toMatchObject({ epoch, complete: true, branchesUnloaded: true });
  });

  it("keeps an active window when its refresh anchor is invalid", async () => {
    const request = vi.fn(async (params: Params) => {
      if (params.window && "from" in params.window) throw { code: ErrorCodes.InvalidParams };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    const held = f.view();
    await expect(f.loader.read(state.path)).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    expect(request.mock.calls.map(([params]) => params.window)).toEqual([{ tail: 40 }, { from: "e40" }]);
    expect(f.view().entries).toBe(held.entries);
    expect(f.view().blocks).toBe(held.blocks);
    expect(f.view().historyPending).toBeUndefined();
  });

  it("keeps an active window when a from or all range is too large to send at once", async () => {
    for (const all of [false, true]) {
      const request = vi.fn(async (params: Params) => {
        if (params.window && ("from" in params.window || "all" in params.window)) throw { code: ErrorCodes.RevisionUnavailable };
        return historyWindow(source, params.window!, scope);
      });
      const f = fixture(request);
      await f.loader.read(state.path);
      const held = f.view();
      await expect(f.loader.read(state.path, all)).rejects.toMatchObject({ code: ErrorCodes.RevisionUnavailable });
      expect(request.mock.calls.map(([params]) => params.window)).toEqual([{ tail: 40 }, all ? { all: true } : { from: "e40" }]);
      expect(f.view().entries).toBe(held.entries);
      expect(f.view().blocks).toBe(held.blocks);
      expect(f.view().historyPending).toBeUndefined();
      expect(f.view().historyError).toBeUndefined();
    }
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
    expect(await page).toBe(false);
    expect(f.view()).toBe(view);
  });

  it("adopts a restarted epoch and tracks the newer update replayed over its snapshot", async () => {
    const pending = deferred<Result>();
    const request = vi.fn().mockResolvedValueOnce(historyWindow(source, { tail: 40 }, { ...scope, seq: 500 })).mockReturnValueOnce(pending.promise);
    const f = fixture(request);
    await f.loader.read(state.path);
    const loading = f.loader.read(state.path);
    f.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: "two", seq: 2, at: "2026-01-01T00:00:00Z", update: { kind: "text_delta", delta: " after", contentIndex: 0 } } });
    pending.resolve(historyWindow(source, { tail: 40 }, { ...scope, epoch: "two", seq: 1, live: { running: true, tools: [], message: { id: "live", value: { content: [{ type: "text", text: "before" }] } } } }));
    await loading;
    expect(f.adoptEpoch).toHaveBeenCalledWith(state.path, 1);
    expect(f.track).toHaveBeenLastCalledWith(state.path, 2);
    expect(f.view().blocks.at(-1)).toMatchObject({ text: "before after" });
  });
});

describe("a read whose transcript was released while it was in flight (RP-5)", () => {
  it("lands nowhere, and leaves the dormant view empty", async () => {
    const pending = deferred<Result>();
    const f = fixture(async params => params.window && "all" in params.window
      ? pending.promise : historyWindow(source, params.window!, scope));
    await f.loader.read(state.path, false);
    expect(f.view().blocks).toHaveLength(40);

    const expanding = f.loader.all(state.path, () => true);
    // The bound released this conversation's transcript while the worker was
    // still answering: the answer is for a transcript that no longer exists.
    f.dispatch({ type: "views/evict", paths: [state.path], reason: "count", at: "2026-09-15T02:00:00.000Z" });
    pending.resolve(historyWindow(source, { all: true }, scope));
    expect(await expanding).toBe(false);

    expect(f.view().entries).toEqual([]);
    expect(f.view().blocks).toEqual([]);
    expect(f.view().hydrated).toBe(false);
    expect(f.view().dormant).toBeDefined();
  });

  it("refuses an older page and a metadata refresh for the same reason", async () => {
    const f = fixture(async params => historyWindow(source, params.window!, scope));
    await f.loader.read(state.path, false);
    expect(f.view().blocks).toHaveLength(40);
    f.dispatch({ type: "views/evict", paths: [state.path], reason: "bytes", at: "2026-09-15T02:00:00.000Z" });

    expect(await f.loader.earlier(state.path, () => true)).toBe(false);
    await f.loader.metadata(state.path, () => true);

    expect(f.view().entries).toEqual([]);
    expect(f.view().blocks).toEqual([]);
  });
});
