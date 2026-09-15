/**
 * The bound itself (RP-5): what is pinned, what is released, in what order,
 * against which limits, and what it costs to keep it up to date while an agent
 * streams.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRun, BackgroundTask, SessionState } from "@lasercode/protocol";

import { createStateStore } from "../../src/runtime/LaserProvider.js";
import { createViewCache, pinReason, rendererViewsStore, type ViewCacheEnvironment, type ViewCacheLimits } from "../../src/runtime/view-cache.js";
import { VIEW_TAIL_MAX_ENTRIES, type ViewTailDto } from "../../src/runtime/view-tail.js";
import { initialState, isDormantView, reduce, type AppState } from "../../src/store.js";
import { MessageEditPresentation, TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";

const CWD = "/p";
const pathOf = (index: number): string => `${CWD}/s${index}.jsonl`;

const sessionState = (path: string, over: Partial<SessionState> = {}): SessionState => ({
  path, cwd: CWD, messageCount: 4, pendingMessageCount: 0, isStreaming: false, isCompacting: false, ...over,
} as SessionState);

const entryOf = (path: string, index: number, size: number) => ({
  id: `${path}:e${index}`,
  parentId: index === 0 ? null : `${path}:e${index - 1}`,
  type: "message",
  message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${index} ${"x".repeat(size)}` }] },
});

const window = (seq: number) => ({
  epoch: "w1", seq, revision: `r1.env.${seq}`, environmentKey: "e1.key", userOffset: 0,
  complete: true, branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [],
});

/** One hydrated session with a transcript of roughly `size` bytes per entry. */
function hydrate(state: AppState, path: string, { entries = 4, size = 64, over = {} }: { entries?: number; size?: number; over?: Partial<SessionState> } = {}): AppState {
  let next = reduce(state, { type: "opened", state: sessionState(path, over) });
  next = reduce(next, { type: "historyBegin", path, token: `${path}:t` });
  const rows = Array.from({ length: entries }, (_, index) => entryOf(path, index, size));
  next = reduce(next, { type: "historySnapshot", path, token: `${path}:t`, entries: rows, leafId: rows.at(-1)!.id, window: window(entries) });
  return next;
}

const noDrafts: ViewCacheEnvironment = { scoped: () => [], hasDraft: () => false };

interface Harness {
  store: ReturnType<typeof createStateStore>;
  cache: ReturnType<typeof createViewCache>;
  tails: ViewTailDto[];
  passes: () => number;
  runDeferred: () => void;
  deliver: () => void;
  untracked: string[];
}

function harness({ limits, environment = noDrafts, deliverNow = true }: { limits?: Partial<ViewCacheLimits>; environment?: ViewCacheEnvironment; deliverNow?: boolean } = {}): Harness {
  const store = createStateStore({ ...initialState, connection: "open" });
  const tails: ViewTailDto[] = [];
  const untracked: string[] = [];
  let deferred: (() => void) | undefined;
  let delivery: (() => void) | undefined;
  let passes = 0;
  const cache = createViewCache({
    read: () => store.getSnapshot(),
    dispatch: store.dispatch,
    environment,
    sink: { release: (tail) => tails.push(tail) },
    limits: { views: 2, bytes: 4096, viewBytes: 2048, ...limits },
    now: () => new Date("2026-09-15T02:00:00.000Z"),
    defer: (run) => { deferred = () => { passes += 1; run(); }; return () => { deferred = undefined; }; },
    deliver: (run) => { delivery = run; if (deliverNow) run(); },
    onRelease: (paths) => untracked.push(...paths),
  });
  store.subscribe(() => cache.observe(store.getSnapshot()));
  return {
    store, cache, tails, untracked,
    passes: () => passes,
    runDeferred: () => { const run = deferred; deferred = undefined; run?.(); },
    deliver: () => { const run = delivery; delivery = undefined; run?.(); },
  };
}

const dormantPaths = (state: AppState): string[] =>
  Object.keys(state.open).filter((path) => isDormantView(state.open[path])).sort();

/** Replay one built session's load into a harness store, as the provider would. */
function load(h: Harness, path: string, options?: { entries?: number; size?: number; over?: Partial<SessionState> }): void {
  const built = hydrate(initialState, path, options);
  const rows = built.open[path]!.entries;
  h.store.dispatch({ type: "opened", state: built.open[path]!.state });
  h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
  h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: rows, leafId: (rows.at(-1) as { id: string }).id, window: window(rows.length) });
  h.cache.touch(path);
}

describe("what is never released", () => {
  it("names the pin that holds each session", () => {
    let state: AppState = { ...initialState, connection: "open" };
    state = hydrate(state, pathOf(1));
    state = hydrate(state, pathOf(2));
    state = hydrate(state, pathOf(3), { over: { messageCount: 0 } });
    state = hydrate(state, pathOf(4));
    state = { ...state, current: pathOf(1) };
    state = reduce(state, { type: "notification", method: "pi/ui/request", params: { path: pathOf(2), id: "q", method: "confirm", title: "Run?" } });
    const run: AgentRun = { runId: "r1", sessionPath: pathOf(4), rootSessionPath: pathOf(4), agentName: "worker", subagentName: "w", status: "running", origin: "agent", startedAt: "", updatedAt: "", cwd: CWD } as AgentRun;
    state = reduce(state, { type: "agents/run", run });

    const environment: ViewCacheEnvironment = { scoped: () => [pathOf(5)], hasDraft: (path) => path === pathOf(6) };
    expect(pinReason(state, pathOf(1), environment)).toBe("current");
    expect(pinReason(state, pathOf(2), environment)).toBe("question");
    expect(pinReason(state, pathOf(3), environment)).toBe("unstarted");
    expect(pinReason(state, pathOf(4), environment)).toBe("agent-run");
    expect(pinReason(state, pathOf(5), environment)).toBe("scope");
    expect(pinReason(state, pathOf(6), environment)).toBe("draft");
    expect(pinReason(state, pathOf(7), environment)).toBeUndefined();
  });

  it("holds a running turn, a queued message and a live command", () => {
    let state: AppState = { ...initialState, connection: "open" };
    state = hydrate(state, pathOf(1), { over: { isStreaming: true } });
    state = hydrate(state, pathOf(2));
    state = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: pathOf(2), seq: 99, at: "", update: { kind: "queue_update", steering: ["later"], followUp: [] } } as never });
    const task: BackgroundTask = { id: "t1", sessionPath: pathOf(3), command: "pnpm test", status: "running", outputBytes: 0, startedAt: "" } as BackgroundTask;
    state = hydrate(state, pathOf(3));
    state = reduce(state, { type: "tasks/update", task });
    expect(pinReason(state, pathOf(1), noDrafts)).toBe("running");
    expect(pinReason(state, pathOf(2), noDrafts)).toBe("queued");
    expect(pinReason(state, pathOf(3), noDrafts)).toBe("task");
  });

  it("keeps every pinned view and says so rather than releasing one", () => {
    const h = harness({ limits: { views: 1, bytes: 512, viewBytes: 512 }, environment: { scoped: () => [pathOf(2)], hasDraft: () => false } });
    for (const index of [1, 2]) load(h, pathOf(index), { entries: 6, size: 200 });
    h.store.dispatch({ type: "destination", destination: { phase: "ready-chat", intent: 1, target: { kind: "session", path: pathOf(1), visibleTab: "chat" }, path: pathOf(1), rememberedCode: { kind: "no-project-landing" } } as AppState["destination"] });

    const outcome = h.cache.maintain();

    expect(outcome.released).toEqual([]);
    expect(outcome.refused.map((row) => row.pin).sort()).toEqual(["current", "scope"]);
    expect(h.cache.counters().overflow).toBe("pinned");
    expect(dormantPaths(h.store.getSnapshot())).toEqual([]);
  });
});

describe("an edit a person started", () => {
  it("pins its conversation while it holds words, and not when it is empty", () => {
    const presentation = new TranscriptPresentation();
    const path = pathOf(1);
    const environment: ViewCacheEnvironment = { scoped: () => [], hasDraft: (candidate) => presentation.hasEditDraft(candidate) };
    let state = hydrate({ ...initialState, connection: "open" }, path);
    state = { ...state, current: pathOf(9) };

    const edit = new MessageEditPresentation("");
    presentation.rememberEdit(path, "m1", edit);
    expect(presentation.hasEditDraft(path)).toBe(false);
    expect(pinReason(state, path, environment)).toBeUndefined();

    edit.update({ draft: "a correction I have not sent", editing: true });
    expect(pinReason(state, path, environment)).toBe("draft");

    presentation.releaseEdit(path, "m1");
    expect(pinReason(state, path, environment)).toBeUndefined();
  });
});

describe("the bounds", () => {
  const seed = (h: Harness, count: number, options?: { entries?: number; size?: number }) => {
    for (let index = 1; index <= count; index++) {
      const path = pathOf(index);
      const built = hydrate(initialState, path, options);
      h.store.dispatch({ type: "opened", state: built.open[path]!.state });
      h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
      h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: built.open[path]!.entries.at(-1) ? (built.open[path]!.entries.at(-1) as { id: string }).id : null, window: window(4) });
      h.cache.touch(path);
    }
  };

  it("keeps the most recently used and releases the rest, oldest first", () => {
    const h = harness({ limits: { views: 2, bytes: 1 << 20, viewBytes: 1 << 20 } });
    seed(h, 5);
    h.cache.touch(pathOf(2));

    const outcome = h.cache.maintain();

    expect(outcome.released.map((row) => row.path).sort()).toEqual([pathOf(1), pathOf(3), pathOf(4)]);
    expect(outcome.released.every((row) => row.reason === "count")).toBe(true);
    expect(dormantPaths(h.store.getSnapshot())).toEqual([pathOf(1), pathOf(3), pathOf(4)].sort());
    // The two most recently used keep their transcripts.
    expect(h.store.getSnapshot().open[pathOf(5)]!.blocks.length).toBeGreaterThan(0);
    expect(h.store.getSnapshot().open[pathOf(2)]!.blocks.length).toBeGreaterThan(0);
    expect(h.untracked.sort()).toEqual([pathOf(1), pathOf(3), pathOf(4)].sort());
  });

  it("releases one huge dormant transcript even under the count", () => {
    const h = harness({ limits: { views: 6, bytes: 1 << 20, viewBytes: 4096 } });
    seed(h, 1, { entries: 2, size: 32 });
    seed(h, 0);
    // A second, very large one, still inside the count of six.
    const path = pathOf(9);
    const built = hydrate(initialState, path, { entries: 20, size: 800 });
    h.store.dispatch({ type: "opened", state: built.open[path]!.state });
    h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
    h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: (built.open[path]!.entries.at(-1) as { id: string }).id, window: window(20) });

    const outcome = h.cache.maintain();

    expect(outcome.released.map((row) => row.path)).toEqual([path]);
    expect(outcome.released[0]!.reason).toBe("bytes");
    expect(h.store.getSnapshot().open[pathOf(1)]!.blocks.length).toBeGreaterThan(0);
  });

  it("releases against the total when every transcript is inside its own share", () => {
    const h = harness({ limits: { views: 10, bytes: 3000, viewBytes: 1 << 20 } });
    seed(h, 4, { entries: 4, size: 120 });

    const outcome = h.cache.maintain();

    expect(outcome.released.length).toBeGreaterThan(0);
    expect(outcome.released.every((row) => row.reason === "bytes")).toBe(true);
    expect(h.cache.counters().bytes).toBeLessThanOrEqual(3000);
  });
});

describe("what a release hands over", () => {
  it("captures a bounded frozen tail before the release and delivers it after", () => {
    const h = harness({ limits: { views: 0, bytes: 0, viewBytes: 0 }, deliverNow: false });
    const path = pathOf(1);
    const built = hydrate(initialState, path, { entries: 60, size: 32 });
    h.store.dispatch({ type: "opened", state: built.open[path]!.state });
    h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
    h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: "leaf", window: window(60) });

    h.cache.maintain();

    // Released first: the tail has not even been offered yet.
    expect(isDormantView(h.store.getSnapshot().open[path])).toBe(true);
    expect(h.tails).toHaveLength(0);

    h.deliver();

    const tail = h.tails[0]!;
    expect(Object.isFrozen(tail)).toBe(true);
    expect(tail.schema).toBe("view-tail/1");
    expect(tail.revision).toBe("r1.env.60");
    expect(tail.entries.length).toBe(VIEW_TAIL_MAX_ENTRIES);
    expect(tail.truncated).toBe(true);
    expect(tail.entries.every((entry) => typeof entry.json === "string")).toBe(true);
  });

  it("is not delayed or prevented by a sink that throws or blocks", () => {
    const store = createStateStore({ ...initialState, connection: "open" });
    let released = false;
    const cache = createViewCache({
      read: () => store.getSnapshot(),
      dispatch: store.dispatch,
      environment: noDrafts,
      limits: { views: 0, bytes: 0, viewBytes: 0 },
      sink: { release: () => { released = true; throw new Error("the cache is on fire"); } },
      deliver: (run) => {
        // By the time the sink is even offered the tail, the view is dormant.
        expect(isDormantView(store.getSnapshot().open[pathOf(1)])).toBe(true);
        run();
      },
    });
    const path = pathOf(1);
    const built = hydrate(initialState, path);
    store.dispatch({ type: "opened", state: built.open[path]!.state });
    store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
    store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: built.open[path]!.entries.at(-1) ? (built.open[path]!.entries.at(-1) as { id: string }).id : null, window: window(4) });

    expect(() => cache.maintain()).not.toThrow();
    expect(released).toBe(true);
    expect(isDormantView(store.getSnapshot().open[path])).toBe(true);
  });
});

describe("pressure, counters and generations", () => {
  it("releaseUnder is exact, refuses pins and is idempotent", () => {
    const h = harness({ limits: { views: 2, bytes: 1 << 20, viewBytes: 1 << 20 } });
    for (const index of [1, 2, 3]) {
      const path = pathOf(index);
      const built = hydrate(initialState, path, { entries: 6, size: 200 });
      h.store.dispatch({ type: "opened", state: built.open[path]!.state });
      h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
      h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: (built.open[path]!.entries.at(-1) as { id: string }).id, window: window(6) });
      h.cache.touch(path);
    }
    h.store.dispatch({ type: "notification", method: "pi/ui/request", params: { path: pathOf(3), id: "q", method: "confirm", title: "Run?" } });

    const first = h.cache.releaseUnder("critical");
    expect(first.released.map((row) => row.path).sort()).toEqual([pathOf(1), pathOf(2)].sort());
    expect(first.released.every((row) => row.reason === "pressure")).toBe(true);
    expect(first.bytesReleased).toBe(first.released.reduce((sum, row) => sum + row.bytes, 0));
    expect(first.bytesReleased).toBeGreaterThan(0);
    expect(first.refused.map((row) => row.pin)).toEqual(["question"]);

    const again = h.cache.releaseUnder("critical");
    expect(again.released).toEqual([]);
    expect(again.bytesReleased).toBe(0);
    // The question's own transcript is still there.
    expect(h.store.getSnapshot().open[pathOf(3)]!.blocks.length).toBeGreaterThan(0);
  });

  it("counts light records, hydrated transcripts, bytes and evictions", () => {
    const h = harness({ limits: { views: 1, bytes: 1 << 20, viewBytes: 1 << 20 } });
    for (const index of [1, 2]) {
      const path = pathOf(index);
      const built = hydrate(initialState, path);
      h.store.dispatch({ type: "opened", state: built.open[path]!.state });
      h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
      h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: built.open[path]!.entries.at(-1) ? (built.open[path]!.entries.at(-1) as { id: string }).id : null, window: window(4) });
      h.cache.touch(path);
    }
    h.cache.maintain();

    const counters = h.cache.counters();
    expect(counters.views).toBe(2);
    expect(counters.hydrated).toBe(1);
    expect(counters.dormant).toBe(1);
    expect(counters.evictions).toBe(1);
    expect(counters.bytes).toBeGreaterThan(0);
    expect(counters.heapEquivalentBytes).toBeGreaterThan(counters.bytes);
    expect(counters.limits.views).toBe(1);
    expect(rendererViewsStore(counters)).toEqual({ count: counters.hydrated, bytes: counters.bytes });
    expect(Object.isFrozen(counters)).toBe(true);
  });

  it("forgets its generation when the environment changes", () => {
    const h = harness({ limits: { views: 1, bytes: 1 << 20, viewBytes: 1 << 20 }, deliverNow: false });
    const path = pathOf(1);
    const built = hydrate(initialState, path);
    h.store.dispatch({ type: "opened", state: built.open[path]!.state });
    h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
    h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: built.open[path]!.entries.at(-1) ? (built.open[path]!.entries.at(-1) as { id: string }).id : null, window: window(4) });
    h.cache.releaseUnder("critical");
    expect(h.cache.counters().evictions).toBe(1);

    h.cache.reset();
    h.store.dispatch({ type: "resetEnvironment" });
    // A tail captured in the old environment is never handed over in the new one.
    h.deliver();

    expect(h.tails).toEqual([]);
    expect(h.cache.counters().evictions).toBe(0);
    expect(h.cache.counters().views).toBe(0);
  });
});

describe("what it costs while an agent streams", () => {
  it("schedules no pass and measures nothing per streamed update", () => {
    const h = harness({ limits: { views: 4, bytes: 1 << 24, viewBytes: 1 << 24 } });
    const path = pathOf(1);
    const built = hydrate(initialState, path);
    h.store.dispatch({ type: "opened", state: built.open[path]!.state });
    h.store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
    h.store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: built.open[path]!.entries, leafId: built.open[path]!.entries.at(-1) ? (built.open[path]!.entries.at(-1) as { id: string }).id : null, window: window(4) });
    h.store.dispatch({ type: "destination", destination: { phase: "ready-chat", intent: 1, target: { kind: "session", path, visibleTab: "chat" }, path, rememberedCode: { kind: "no-project-landing" } } as AppState["destination"] });
    h.runDeferred();
    const before = h.passes();

    const stringify = vi.spyOn(JSON, "stringify");
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 100, at: "", update: { kind: "message_start", role: "assistant" } } as never });
    for (let index = 0; index < 1000; index++) {
      h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 101 + index, at: "", update: { kind: "text_delta", delta: `token ${index} `, contentIndex: 0 } } as never });
    }
    const during = stringify.mock.calls.length;
    stringify.mockRestore();
    h.runDeferred();

    // Growth is counted, not measured: nothing walked the transcript while it
    // streamed, and the pinned current session is never a release candidate.
    expect(during).toBe(0);
    expect(h.passes() - before).toBeLessThanOrEqual(1);
    expect(isDormantView(h.store.getSnapshot().open[path])).toBe(false);
  });
});
