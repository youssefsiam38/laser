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
    expect(request).toHaveBeenLastCalledWith({ path: state.path, window: { all: true } });
    expect(f.view().history).toMatchObject({ complete: true, branchesUnloaded: false });
    expect(f.view().entries).toHaveLength(81);
    await f.loader.read(state.path);
    expect(f.view().history).toMatchObject({ complete: true, branchesUnloaded: true });
    expect(f.view().entries).toHaveLength(80);
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
