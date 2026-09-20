import { describe, expect, it, vi } from "vitest";
import { historyWindow, HISTORY_FIRST_PAGE_TURNS, type ClientRequests, type SessionState } from "@lasercode/protocol";

import { BODY_EXCERPT_MAX_BYTES } from "../../src/runtime/body-excerpt.js";
import { createHistoryLoader } from "../../src/runtime/history-loader.js";
import { initialState, reduce, type Action } from "../../src/store.js";

/**
 * RP-11 reconciliation: what the host proved (a suffix) and what it replaced
 * (everything), through the one canonical fold.
 */
const state: SessionState = {
  path: "/p/session.jsonl", id: "session-1", cwd: "/p", model: null, thinkingLevel: "off",
  isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all",
  autoCompactionEnabled: true, messageCount: 80, pendingMessageCount: 0,
};

const entry = (index: number) => ({
  type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : null,
  message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${index}` }] },
});

const held = { entries: Array.from({ length: 80 }, (_, index) => entry(index)), leafId: "e79" };
const grown = { entries: [...held.entries, entry(80), entry(81)], leafId: "e81" };

const ENVIRONMENT = "e1.environment";
const scopeAt = (revision: string, over: Partial<Parameters<typeof historyWindow>[2]> = {}) => ({
  sessionId: state.id, epoch: "worker-1", seq: 40, revision, environmentKey: ENVIRONMENT, ...over,
});

type Params = ClientRequests["pi/session/entries"]["params"];
type Result = ClientRequests["pi/session/entries"]["result"];

function fixture(request: (params: Params) => Promise<Result>) {
  let app = reduce(initialState, { type: "opened", state });
  const dispatch = (action: Action) => { app = reduce(app, action); };
  const spy = vi.fn(request);
  const loader = createHistoryLoader({
    get: (path) => app.open[path],
    isCurrent: () => true,
    request: spy,
    dispatch,
    adoptEpoch: () => {},
    track: () => {},
  });
  return { loader, dispatch, request: spy, view: () => app.open[state.path]!, state: () => app };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const replaceReply = async (params: Params, revision: string, source = held): Promise<Result> =>
  historyWindow(source, params.window!, scopeAt(revision));

describe("reconciling a re-entry with its authority", () => {
  it("asks with the durable revision it holds whole, and only for a tail", async () => {
    const f = fixture(async (params) => replaceReply(params, "r1.env.40"));
    await f.loader.recent(state.path, () => true);
    // Nothing was held before this read, so nothing could be proved against.
    expect(f.request.mock.calls[0]![0]).toEqual({ path: state.path, window: { turns: HISTORY_FIRST_PAGE_TURNS }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
    expect(f.view().validated).toMatchObject({ revision: "r1.env.40", environmentKey: ENVIRONMENT });

    await f.loader.recent(state.path, () => true);
    expect(f.request.mock.calls[1]![0]).toMatchObject({ window: { turns: HISTORY_FIRST_PAGE_TURNS }, baseRevision: "r1.env.40" });

    // Older pages carry the held producer revision; whole-tree reads remain independent.
    expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    expect(f.request.mock.calls[2]![0].baseRevision).toBe("r1.env.40");
    while (f.view().history?.before) expect(await f.loader.earlier(state.path, () => true)).toMatchObject({ accepted: true });
    const count = f.request.mock.calls.length;
    await f.loader.all(state.path, () => true);
    expect(f.request).toHaveBeenCalledTimes(count);
  });

  it("appends a proved suffix, keeps the cached cursor and never claims the delta's own page", async () => {
    const f = fixture(async (params) => replaceReply(params, "r1.env.40"));
    await f.loader.recent(state.path, () => true);
    const before = f.view();
    expect(before.history?.before).toBeDefined();
    expect(before.history?.complete).toBe(false);
    const cursor = before.history!.before;
    const blocksBefore = before.blocks.length;

    f.request.mockImplementation(async (params) => {
      expect(params.baseRevision).toBe("r1.env.40");
      return historyWindow(grown, params.window!, scopeAt("r1.env.42", { seq: 42, selection: { kind: "delta", after: "e79" } }));
    });
    await f.loader.recent(state.path, () => true);

    const after = f.view();
    expect(after.entries.map((value) => (value as { id: string }).id).slice(-3)).toEqual(["e79", "e80", "e81"]);
    expect(after.entries).toHaveLength(before.entries.length + 2);
    expect(after.blocks).toHaveLength(blocksBefore + 2);
    expect(after.leafId).toBe("e81");
    expect(after.validated).toMatchObject({ revision: "r1.env.42", seq: 42 });
    expect(after.history?.revision).toBe("r1.env.42");
    // The suffix's own paging metadata describes the suffix, not this view.
    expect(after.history?.before).toBe(cursor);
    expect(after.history?.complete).toBe(false);
    expect(after.hydrated).toBe(true);
  });

  it("moves only the live edge for an empty delta", async () => {
    const f = fixture(async (params) => replaceReply(params, "r1.env.40"));
    await f.loader.recent(state.path, () => true);
    const before = f.view();

    f.request.mockImplementation(async (params) =>
      historyWindow(held, params.window!, scopeAt("r1.env.41", { seq: 41, selection: { kind: "delta", after: "e79" } })));
    await f.loader.recent(state.path, () => true);

    const after = f.view();
    expect(after.entries.map((value) => (value as { id: string }).id)).toEqual(before.entries.map((value) => (value as { id: string }).id));
    expect(after.history?.before).toBe(before.history?.before);
    expect(after.validated).toMatchObject({ revision: "r1.env.41", seq: 41 });
  });

  it("refuses a suffix whose base moved while it was in flight, and replaces instead", async () => {
    const f = fixture(async (params) => replaceReply(params, "r1.env.40"));
    await f.loader.recent(state.path, () => true);
    expect(f.view().validated?.revision).toBe("r1.env.40");

    const pending = deferred<Result>();
    f.request.mockImplementationOnce(async () => pending.promise);
    f.request.mockImplementationOnce(async (params) => replaceReply(params, "r1.env.44", grown));
    const reading = f.loader.recent(state.path, () => true);

    // A turn lands while the read is in flight: what this view holds is no
    // longer the revision the host was asked to prove a suffix against.
    f.dispatch({
      type: "notification", method: "session/update",
      params: {
        sessionPath: state.path, epoch: "worker-1", seq: 41, at: "2026-09-16T00:00:00.000Z",
        update: { kind: "entry_appended", entry: { id: "goal-1", parentId: "e79", type: "custom", customType: "goal-state" } },
      },
    } as never);
    expect(f.view().validated).toBeUndefined();

    pending.resolve(await historyWindow(grown, { tail: 40 }, scopeAt("r1.env.42", { seq: 42, selection: { kind: "delta", after: "e79" } })));
    await reading;

    // The refused page was kept by nobody; one replacement stands in its place.
    const requests = f.request.mock.calls.map(([params]) => params.baseRevision);
    expect(requests).toEqual([undefined, "r1.env.40", undefined]);
    expect(f.view().validated).toMatchObject({ revision: "r1.env.44" });
    expect(f.view().hydrated).toBe(true);
    expect(f.view().entries.map((value) => (value as { id: string }).id)).not.toContain("e0");
  });

  it("keeps an unsent prompt and an update that overtook the reply through a proved suffix", async () => {
    const f = fixture(async (params) => replaceReply(params, "r1.env.40"));
    await f.loader.recent(state.path, () => true);
    f.dispatch({ type: "optimisticUser", path: state.path, id: "unsent", text: "Mine, not sent yet", images: [] });

    const pending = deferred<Result>();
    f.request.mockImplementationOnce(async () => pending.promise);
    const reading = f.loader.recent(state.path, () => true);
    f.dispatch({
      type: "notification", method: "session/update",
      params: { sessionPath: state.path, epoch: "worker-1", seq: 43, at: "2026-09-16T00:00:00.000Z", update: { kind: "agent_start" } },
    } as never);

    pending.resolve(historyWindow(grown, { tail: 40 }, scopeAt("r1.env.42", { seq: 42, selection: { kind: "delta", after: "e79" } })));
    await reading;

    expect(f.view().blocks.at(-1)).toMatchObject({ id: "unsent", optimistic: true });
    expect(f.view().lastSeq).toBe(43);
  });
});
