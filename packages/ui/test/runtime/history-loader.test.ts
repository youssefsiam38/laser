import { BODY_EXCERPT_MAX_BYTES } from "@/runtime/body-excerpt";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, historyWindow, type ClientRequests, type SessionState } from "@lasercode/protocol";
import { initialState, reduce, type Action } from "../../src/store.js";
import { createHistoryLoader } from "../../src/runtime/history-loader.js";

const state: SessionState = { path: "/session", id: "s", cwd: "/project", model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 80, pendingMessageCount: 0 };
const entries = Array.from({ length: 80 }, (_, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }] } }));
const source = { entries, leafId: "e79" };
const scope = { path: state.path, epoch: "one", seq: 0 };
type Params = ClientRequests["pi/session/entries"]["params"];
type Result = ClientRequests["pi/session/entries"]["result"];
function fixture(request: (params: Params) => Promise<Result>) {
  let app = reduce(initialState, { type: "opened", state });
  const dispatch = (action: Action) => { app = reduce(app, action); };
  const adoptEpoch = vi.fn(); const track = vi.fn();
  const replace = (request: (params: Params) => Promise<Result>) => createHistoryLoader({ get: path => app.open[path], request, dispatch, adoptEpoch, track });
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
    expect(request).toHaveBeenLastCalledWith({ path: state.path, window: { tail: 40 }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
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
    const earlier = f.loader.earlier(state.path, () => true);
    await f.replace(async params => historyWindow(source, params.window!, scope)).recent(state.path, () => true);
    const accepted = f.view();
    const stale = historyWindow(source, { before }, scope);
    old.resolve(stale);
    expect(await earlier).toBe(false);
    expect(f.view()).toBe(accepted);
    f.dispatch({ type: "historyPrepend", path: state.path, before, entries: stale.entries, window: stale.window });
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

  it("retains a known tree after an invalid branch anchor falls back to a tail, but drops it on epoch change", async () => {
    let snapshot: { entries: unknown[]; leafId: string } = source;
    let epoch = scope.epoch;
    const request = vi.fn(async (params: Params) => historyWindow(snapshot, params.window!, { ...scope, epoch }));
    const f = fixture(request);
    await f.loader.read(state.path, true);
    // A sibling before the old root makes that root an invalid active anchor.
    const other = { type: "message", id: "root-sibling", parentId: null, message: { role: "user", content: "Other root" } };
    snapshot = { entries: [...entries, other], leafId: other.id };
    await f.loader.read(state.path);
    expect(request.mock.calls.slice(1).map(([params]) => params.window)).toEqual([{ from: "e0" }, { tail: 40 }]);
    expect(f.view().entries).toHaveLength(81);
    expect(f.view().blocks).toHaveLength(1);
    expect(f.view().history).toMatchObject({ complete: true, branchesUnloaded: false, userOffset: 0 });
    expect(f.view().history?.before).toBeUndefined();
    epoch = "replacement";
    await f.loader.read(state.path);
    expect(f.view().entries).toEqual([other]);
    expect(f.view().history).toMatchObject({ epoch, complete: true, branchesUnloaded: true });
  });

  it("recovers an invalid retained anchor through a fresh tail", async () => {
    const request = vi.fn(async (params: Params) => {
      if (params.window && "from" in params.window) throw { code: ErrorCodes.InvalidParams };
      return historyWindow(source, params.window!, scope);
    });
    const f = fixture(request);
    await f.loader.read(state.path);
    await f.loader.read(state.path);
    expect(request.mock.calls.map(([params]) => params.window)).toEqual([{ tail: 40 }, { from: "e40" }, { tail: 40 }]);
    expect(f.view().blocks).toHaveLength(40);
    expect(f.view().historyPending).toBeUndefined();
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
