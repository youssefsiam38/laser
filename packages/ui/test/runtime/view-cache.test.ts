/**
 * The bound itself (RP-5): what is pinned, what is released, in what order,
 * against which limits, and what it costs to keep it up to date while an agent
 * streams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, BackgroundTask, SessionState } from "@lasercode/protocol";

import { createStateStore } from "../../src/runtime/LaserProvider.js";
import { createViewCache, DELIVERY_FALLBACK_MS, holdsTranscript, PENDING_TAIL_MAX_BYTES, PENDING_TAIL_MAX_ENTRIES, pinReason, protectsLogicalHistory, rendererViewsStore, type PinReason, type ViewCacheEnvironment, type ViewCacheLimits } from "../../src/runtime/view-cache.js";
import { VIEW_TAIL_MAX_ENTRIES, viewTailRetainedBytes, type ViewTailDto, type ViewTailSink } from "../../src/runtime/view-tail.js";
import { initialState, isDormantView, reduce, type AppState } from "../../src/store.js";
import { measurementWork, resetMeasurementWork } from "../../src/runtime/view-measure.js";
import { LIVE_TAIL_MAX_BYTES } from "../../src/runtime/body-excerpt.js";
import { MessageEditPresentation, TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";

const CWD = "/p";
const pathOf = (index: number): string => `${CWD}/s${index}.jsonl`;

const sessionState = (path: string, over: Partial<SessionState> = {}): SessionState => ({
  path, id: `id-${path}`, cwd: CWD, messageCount: 4, pendingMessageCount: 0, isStreaming: false, isCompacting: false, ...over,
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
    deliver: (run) => { delivery = run; if (deliverNow) run(); return () => { delivery = undefined; }; },
    onRelease: (paths) => untracked.push(...paths),
  });
  store.observeTransactions((action, before, after) => { cache.observeTransaction(action, before, after); return false; });
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
  it("decides transcript membership explicitly for every pin reason", () => {
    const policy = {
      current: true,
      destination: true,
      scope: false,
      question: true,
      running: true,
      queued: true,
      "agent-run": true,
      task: true,
      unstarted: false,
      loading: false,
      draft: true,
      unsent: true,
      action: true,
    } satisfies Record<PinReason, boolean>;
    for (const [pin, held] of Object.entries(policy) as [PinReason, boolean][]) expect(holdsTranscript(pin)).toBe(held);
    expect(holdsTranscript(undefined)).toBe(false);
  });

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

  it("keeps visible logical history even when it exceeds ordinary cache targets", () => {
    const h = harness({ limits: { views: 1, bytes: 4096, viewBytes: 1024 }, environment: { scoped: () => [pathOf(2)], hasDraft: () => false } });
    for (const index of [1, 2]) load(h, pathOf(index), { entries: 6, size: 200 });
    h.store.dispatch({ type: "destination", destination: { phase: "ready-chat", intent: 1, chat: { kind: "session", path: pathOf(1) }, rememberedCode: { kind: "no-project-landing" } } as AppState["destination"] });
    const before = [1, 2].map(index => h.store.getSnapshot().open[pathOf(index)]!.entries);

    const outcome = h.cache.maintain();

    expect(outcome.released).toEqual([]);
    expect(outcome.refused.map((row) => row.pin).sort()).toEqual(["current", "scope"]);
    expect(dormantPaths(h.store.getSnapshot())).toEqual([]);
    for (const [offset, index] of [1, 2].entries()) {
      expect(h.store.getSnapshot().open[pathOf(index)]!.entries).toBe(before[offset]);
      expect(h.cache.measure(pathOf(index)).bytes).toBeGreaterThan(1024);
    }
    expect(h.cache.counters().overflow).toBe("protected");
    // A second pass reports the same honest state without another trim.
    expect(h.cache.maintain().released).toEqual([]);
    expect(h.store.getSnapshot().open[pathOf(1)]!.entries).toBe(before[0]);
    expect(h.store.getSnapshot().open[pathOf(2)]!.entries).toBe(before[1]);
  });

  it("protects visible and user-owned views, but not background work by itself", () => {
    const protectedPins: PinReason[] = ["current", "destination", "scope", "draft", "unsent", "action"];
    for (const pin of protectedPins) expect(protectsLogicalHistory(pin), pin).toBe(true);
    for (const pin of ["running", "queued", "agent-run", "task", "question", "loading"] satisfies PinReason[]) {
      expect(protectsLogicalHistory(pin), pin).toBe(false);
    }
    expect(protectsLogicalHistory(undefined)).toBe(false);

    const h = harness({ limits: { views: 6, bytes: 1 << 20, viewBytes: 1024 } });
    load(h, pathOf(7), { entries: 8, size: 300, over: { isStreaming: true } });
    expect(pinReason(h.store.getSnapshot(), pathOf(7), noDrafts)).toBe("running");
    h.cache.maintain();
    expect(h.store.getSnapshot().open[pathOf(7)]!.trimmed).toBeDefined();
    expect(h.cache.measure(pathOf(7)).bytes).toBeLessThanOrEqual(1024);
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
        return () => {};
      },
    });
    store.observeTransactions((action, before, after) => { cache.observeTransaction(action, before, after); return false; });
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
    const h = harness({ limits: { views: 2, bytes: 3000, viewBytes: 1 << 20 } });
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
  it("plateaus with the capped live tail instead of counting every token, with fifty other conversations open", () => {
    const h = harness({ limits: { views: 8, bytes: 1 << 24, viewBytes: 1 << 24 } });
    const path = pathOf(1);
    load(h, path, { entries: 4 });
    // Fifty light records beside it: a pass must not walk them to keep count.
    for (let index = 2; index <= 51; index++) h.store.dispatch({ type: "opened", state: sessionState(pathOf(index)) });
    h.store.dispatch({ type: "destination", destination: { phase: "ready-chat", intent: 1, chat: { kind: "session", path }, rememberedCode: { kind: "no-project-landing" } } as AppState["destination"] });
    h.runDeferred();

    const before = h.cache.counters().bytes;
    resetMeasurementWork();
    const stringify = vi.spyOn(JSON, "stringify");
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 100, at: "", update: { kind: "message_start", role: "assistant" } } as never });
    let streamed = 0;
    const samples: number[] = [];
    let passes = 0;
    for (let index = 0; index < 12000; index++) {
      const delta = `token ${index} \u00e9\u{1F6F0}`;
      streamed += new TextEncoder().encode(delta).length;
      h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 101 + index, at: "", update: { kind: "text_delta", delta, contentIndex: 0 } } as never });
      if (index % 100 === 0) { h.runDeferred(); passes += 1; samples.push(h.cache.counters().bytes); }
    }
    h.runDeferred();
    const work = measurementWork();
    stringify.mockRestore();

    // The stream is far past the live tail cap, and the accounting says what
    // the view actually holds rather than what went through it (RP-5b §4.2).
    expect(streamed).toBeGreaterThan(4 * LIVE_TAIL_MAX_BYTES);
    const grown = h.cache.counters().bytes - before;
    expect(grown).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES + 4096);
    expect(grown).toBeLessThan(streamed / 4);
    // It plateaus: the last samples do not keep climbing with the stream.
    const tail = samples.slice(-5);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(4096);
    // Nothing is ever reported as over budget for a stream that is inside it.
    expect(h.cache.counters().overflow).toBeUndefined();
    // Only the view that changed is walked, once per pass, and what is looked
    // at is the capped tail — never the cumulative text that produced it.
    expect(work.views).toBeLessThanOrEqual(passes + 2);
    expect(work.bytes).toBeLessThanOrEqual((passes + 2) * (LIVE_TAIL_MAX_BYTES + 4096));
    // Each pass looks at the capped tail, not at everything that has streamed
    // through it: the cost per pass is the bound, not the conversation.
    expect(work.bytes / Math.max(1, work.views)).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES + 4096);
    expect(stringify).not.toHaveBeenCalled();
    // And the pinned conversation on screen is never a candidate.
    expect(isDormantView(h.store.getSnapshot().open[path])).toBe(false);
  });

  it("answers the counters from what it already knows", () => {
    const h = harness({ limits: { views: 8, bytes: 1 << 24, viewBytes: 1 << 24 } });
    load(h, pathOf(1), { entries: 4 });
    h.runDeferred();

    const first = h.cache.counters();
    resetMeasurementWork();
    const second = h.cache.counters();

    // The same frozen object, and not one byte re-measured to produce it.
    expect(second).toBe(first);
    expect(measurementWork()).toMatchObject({ views: 0, blocks: 0, entries: 0, bytes: 0 });

    // A number that moves invalidates it, once.
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: pathOf(1), seq: 200, at: "", update: { kind: "text_delta", delta: "more", contentIndex: 0 } } as never });
    const third = h.cache.counters();
    expect(third).not.toBe(first);
    expect(third.bytes).toBe(first.bytes + 4);
  });

  it("measures the settled turn once, replacing what the deltas counted", () => {
    const h = harness({ limits: { views: 8, bytes: 1 << 24, viewBytes: 1 << 24 } });
    const path = pathOf(1);
    load(h, path, { entries: 4 });
    h.runDeferred();
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 100, at: "", update: { kind: "message_start", role: "assistant" } } as never });
    for (let index = 0; index < 50; index++) {
      h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 101 + index, at: "", update: { kind: "text_delta", delta: "abcde", contentIndex: 0 } } as never });
    }
    h.runDeferred();
    const streamed = h.cache.counters().bytes;

    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 200, at: "",
      update: { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text: "abcde".repeat(50) }] }, stopReason: "stop" } } as never });
    h.runDeferred();

    // The settled turn is measured, not added to: the same text, once.
    expect(h.cache.counters().bytes).toBe(streamed);
  });
});

describe("when a pass happens", () => {
  it("runs after one large content transaction, without waiting for a stream of them", () => {
    const h = harness({ limits: { views: 6, bytes: 1 << 24, viewBytes: 4096 } });
    load(h, pathOf(1), { entries: 2, size: 32 });
    h.runDeferred();
    // One tool result, one transaction, far over the per-view share.
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: pathOf(1), seq: 90, at: "",
      update: { kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } } } as never });
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: pathOf(1), seq: 91, at: "",
      update: { kind: "tool_execution_end", toolCallId: "t1", result: "x".repeat(200_000), isError: false } } as never });

    h.runDeferred();

    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(true);
  });

  it("reconciles when a run goes terminal and `open` never changes", () => {
    // One transcript over the cache's count bound, held only by its agent run.
    const h = harness({ limits: { views: 0, bytes: 1 << 24, viewBytes: 1 << 24 } });
    load(h, pathOf(1), { entries: 8, size: 400 });
    const running: AgentRun = { runId: "r1", sessionPath: pathOf(1), rootSessionPath: pathOf(1), agentName: "worker", subagentName: "w", status: "running", origin: "agent", startedAt: "", updatedAt: "2026-09-15T00:00:00.000Z", cwd: CWD } as AgentRun;
    h.store.dispatch({ type: "agents/run", run: running });
    h.runDeferred();
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(false);
    // RP-5b: the run's own view is never evicted, and nothing settles over a
    // bound — with room to spare here, there is nothing to report.
    expect(h.cache.counters().overflow).toBeUndefined();
    const open = h.store.getSnapshot().open;

    h.store.dispatch({ type: "agents/run", run: { ...running, status: "completed", updatedAt: "2026-09-15T00:01:00.000Z" } as AgentRun });

    // The run registry moved and the open map did not.
    expect(h.store.getSnapshot().open).toBe(open);
    h.runDeferred();
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(true);
  });

  it("reconciles when a background command stops and `open` never changes", () => {
    const h = harness({ limits: { views: 0, bytes: 1 << 24, viewBytes: 1 << 24 } });
    load(h, pathOf(1), { entries: 8, size: 400 });
    const task: BackgroundTask = { id: "t1", sessionPath: pathOf(1), command: "pnpm test", status: "running", outputBytes: 0, startedAt: "" } as BackgroundTask;
    h.store.dispatch({ type: "tasks/update", task });
    h.runDeferred();
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(false);
    const open = h.store.getSnapshot().open;

    h.store.dispatch({ type: "tasks/update", task: { ...task, status: "completed", exitCode: 0 } as BackgroundTask });

    expect(h.store.getSnapshot().open).toBe(open);
    h.runDeferred();
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(true);
  });

  it("reconciles when a turn ends", () => {
    const h = harness({ limits: { views: 0, bytes: 1 << 24, viewBytes: 1 << 24 } });
    load(h, pathOf(1), { entries: 8, size: 400, over: { isStreaming: true } });
    h.runDeferred();
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(false);

    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: pathOf(1), seq: 95, at: "",
      update: { kind: "state", state: { ...h.store.getSnapshot().open[pathOf(1)]!.state, isStreaming: false } } } as never });
    h.runDeferred();

    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(true);
  });

  it("reconciles when a draft is cleared outside the store", () => {
    const drafts = new Set<string>([pathOf(1)]);
    const h = harness({ limits: { views: 0, bytes: 1 << 24, viewBytes: 1 << 24 }, environment: { scoped: () => [], hasDraft: (path) => drafts.has(path) } });
    load(h, pathOf(1), { entries: 8, size: 400 });
    h.runDeferred();
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(false);
    expect(h.cache.counters().overflow).toBeUndefined();

    // The person sent or cleared their words. The reducer never hears of it.
    drafts.delete(pathOf(1));
    h.cache.notifyPins();
    h.runDeferred();

    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(true);
  });
});

describe("an image whose decoded size nobody could read", () => {
  const unknownImage = { type: "image" as const, mimeType: "image/svg+xml", data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>') };

  const withUnknownImage = (h: Harness, path: string) => {
    load(h, path, { entries: 2, size: 8 });
    h.store.dispatch({ type: "optimisticUser", path, text: "a diagram", images: [unknownImage], id: `${path}:shown` });
    h.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: path, seq: 80, at: "",
      update: { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "a diagram" }, unknownImage] } } } as never });
  };

  it("is released rather than kept on a number nobody measured", () => {
    const h = harness({ limits: { views: 6, bytes: 1 << 24, viewBytes: 1 << 24 } });
    withUnknownImage(h, pathOf(1));
    load(h, pathOf(2), { entries: 2 });

    // A few encoded bytes, under every bound, and an unknown decoded surface.
    expect(h.cache.measure(pathOf(1)).imagesEstimated).toBe(1);
    const outcome = h.cache.maintain();

    expect(outcome.released.map((row) => row.path)).toEqual([pathOf(1)]);
    expect(outcome.released[0]!.reason).toBe("bytes");
    expect(h.cache.counters().imagesEstimated).toBe(0);
    expect(isDormantView(h.store.getSnapshot().open[pathOf(2)])).toBe(false);
  });

  it("is kept while somebody is using it, and counted honestly", () => {
    const h = harness({ limits: { views: 6, bytes: 1 << 24, viewBytes: 1 << 24 }, environment: { scoped: () => [pathOf(1)], hasDraft: () => false } });
    withUnknownImage(h, pathOf(1));

    const outcome = h.cache.maintain();

    expect(outcome.released).toEqual([]);
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(false);
    expect(h.cache.counters().imagesEstimated).toBe(1);
  });
});

describe("what each released record says about itself", () => {
  it("gives every view its own reason when one pass releases for two", () => {
    const h = harness({ limits: { views: 0, bytes: 1 << 24, viewBytes: 4096 } });
    load(h, pathOf(1), { entries: 2, size: 16 });
    load(h, pathOf(2), { entries: 20, size: 800 });
    load(h, pathOf(3), { entries: 2, size: 16 });
    h.store.dispatch({ type: "destination", destination: { phase: "ready-chat", intent: 1, chat: { kind: "session", path: pathOf(3) }, rememberedCode: { kind: "no-project-landing" } } as AppState["destination"] });

    const outcome = h.cache.maintain();

    expect(new Map(outcome.released.map((row) => [row.path, row.reason])))
      .toEqual(new Map([[pathOf(2), "bytes"], [pathOf(1), "count"]]));
    const open = h.store.getSnapshot().open;
    expect(open[pathOf(2)]!.dormant?.reason).toBe("bytes");
    expect(open[pathOf(1)]!.dormant?.reason).toBe("count");
  });

  it("reports only what the store actually released", () => {
    // The view stops being releasable between the decision and the release.
    const hydratedState = (() => {
      const h = harness();
      load(h, pathOf(1), { entries: 4 });
      return h.store.getSnapshot();
    })();
    const dormant = reduce(hydratedState, { type: "views/evict", paths: [pathOf(1)], reason: "count", at: "2026-09-15T02:00:00.000Z" });
    let reads = 0;
    const dispatch = vi.fn();
    const released: ViewTailDto[] = [];
    const cache = createViewCache({
      read: () => (++reads === 1 ? hydratedState : dormant),
      dispatch,
      environment: noDrafts,
      limits: { views: 0, bytes: 0, viewBytes: 0 },
      sink: { release: (tail) => released.push(tail) },
      deliver: (run) => { run(); return () => {}; },
    });

    const outcome = cache.maintain();

    expect(outcome.released).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(released).toEqual([]);
    expect(cache.counters().evictions).toBe(0);
  });
});

describe("when the tail is handed over", () => {
  const load1 = (cache: ReturnType<typeof createViewCache>, store: ReturnType<typeof createStateStore>) => {
    const path = pathOf(1);
    const built = hydrate(initialState, path, { entries: 4 });
    const rows = built.open[path]!.entries;
    store.dispatch({ type: "opened", state: built.open[path]!.state });
    store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
    store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: rows, leafId: (rows.at(-1) as { id: string }).id, window: window(4) });
    void cache;
  };

  const realFrame = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  let frames: Array<() => void>;

  const useFrames = (available: boolean) => {
    frames = [];
    if (available) {
      globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        frames.push(() => callback(0));
        return frames.length;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = ((handle: number) => { frames[handle - 1] = () => {}; }) as typeof cancelAnimationFrame;
    } else {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
      (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = undefined;
    }
  };

  const cacheOver = (store: ReturnType<typeof createStateStore>, sink: ViewTailSink) => {
    const cache = createViewCache({
      read: () => store.getSnapshot(), dispatch: store.dispatch, environment: noDrafts,
      limits: { views: 0, bytes: 0, viewBytes: 0 }, sink,
    });
    store.observeTransactions((action, before, after) => { cache.observeTransaction(action, before, after); return false; });
    return cache;
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = realFrame;
    globalThis.cancelAnimationFrame = realCancel;
  });

  it("waits for the frame that shows the release, then hands it over exactly once", () => {
    useFrames(true);
    const store = createStateStore({ ...initialState, connection: "open" });
    const release = vi.fn();
    const cache = cacheOver(store, { release });
    load1(cache, store);

    cache.maintain();

    // Released, painted by nobody yet: the record has not moved.
    expect(isDormantView(store.getSnapshot().open[pathOf(1)])).toBe(true);
    expect(release).not.toHaveBeenCalled();

    for (const frame of frames) frame();
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(release).toHaveBeenCalledTimes(1);

    // The bounded fallback cannot hand the same record over a second time.
    vi.advanceTimersByTime(1000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("hands it over anyway on a page that never paints", () => {
    useFrames(false);
    const store = createStateStore({ ...initialState, connection: "open" });
    const release = vi.fn();
    const cache = cacheOver(store, { release });
    load1(cache, store);

    cache.maintain();
    expect(release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("drops what it was about to hand over when the environment changes, or it goes away", () => {
    useFrames(true);
    const store = createStateStore({ ...initialState, connection: "open" });
    const release = vi.fn();
    const cache = cacheOver(store, { release });
    load1(cache, store);
    cache.maintain();
    cache.reset();

    for (const frame of frames) frame();
    vi.advanceTimersByTime(1000);
    expect(release).not.toHaveBeenCalled();

    const second = createStateStore({ ...initialState, connection: "open" });
    const other = vi.fn();
    const disposed = cacheOver(second, { release: other });
    load1(disposed, second);
    disposed.maintain();
    disposed.dispose();
    for (const frame of frames) frame();
    vi.advanceTimersByTime(1000);
    expect(other).not.toHaveBeenCalled();
  });
});

describe("the records waiting for that frame", () => {
  const realFrame = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = realFrame;
    globalThis.cancelAnimationFrame = realCancel;
  });

  /** A cache with no bounds at all, so every load releases on the next pass. */
  const releasing = (sink: ViewTailSink) => {
    const store = createStateStore({ ...initialState, connection: "open" });
    const cache = createViewCache({
      read: () => store.getSnapshot(), dispatch: store.dispatch, environment: noDrafts,
      limits: { views: 0, bytes: 0, viewBytes: 0 }, sink,
    });
    store.observeTransactions((action, before, after) => { cache.observeTransaction(action, before, after); return false; });
    const put = (path: string, options?: { entries?: number; size?: number }) => {
      const built = hydrate(initialState, path, options);
      const rows = built.open[path]!.entries;
      store.dispatch({ type: "opened", state: built.open[path]!.state });
      store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
      store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: rows, leafId: (rows.at(-1) as { id: string }).id, window: window(rows.length) });
      cache.maintain();
    };
    return { store, cache, put };
  };

  it("accounts the whole record it is holding, and re-accounts a replacement", () => {
    const released: ViewTailDto[] = [];
    const { cache, put } = releasing({ release: (tail) => released.push(tail) });

    put(pathOf(1), { entries: 4, size: 64 });
    const afterFirst = cache.counters().tailsPendingBytes;
    expect(afterFirst).toBeGreaterThan(0);

    // The same conversation again, with far more in it: the queue holds one
    // record for it, and the accounting is the new one's, not the sum.
    put(pathOf(1), { entries: 20, size: 800 });
    const afterSecond = cache.counters().tailsPendingBytes;
    expect(cache.counters().tailsPending).toBe(1);
    expect(afterSecond).toBeGreaterThan(afterFirst);

    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);

    expect(released).toHaveLength(1);
    // What was accounted is exactly what holding that record costs, and it is
    // more than the content bytes RP-10 reads from it.
    expect(afterSecond).toBe(viewTailRetainedBytes(released[0]!));
    expect(afterSecond).toBeGreaterThan(released[0]!.bytes);
    expect(cache.counters().tailsPendingBytes).toBe(0);
  });

  it("keeps one scheduler and one record per session, however fast the loop is", () => {
    const released: ViewTailDto[] = [];
    const { cache, put } = releasing({ release: (tail) => released.push(tail) });
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const deliveries = () => scheduled.mock.calls.filter(([, delay]) => delay === DELIVERY_FALLBACK_MS).length;

    // The same three conversations, hydrated and released again and again,
    // all inside one frame.
    for (let round = 0; round < 40; round++) for (const index of [1, 2, 3]) put(pathOf(index), { entries: 2, size: 16 });

    const counters = cache.counters();
    expect(counters.tailsPending).toBe(3);
    expect(counters.tailsDropped).toBe(0);
    // One delivery timer for the whole queue, not one per release.
    expect(deliveries()).toBe(1);
    scheduled.mockRestore();

    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);

    expect(released.map((tail) => tail.path).sort()).toEqual([pathOf(1), pathOf(2), pathOf(3)]);
    // The one that arrives is the last release of that conversation.
    expect(released.every((tail) => tail.capturedAt !== undefined)).toBe(true);
    expect(cache.counters().tailsPending).toBe(0);
    expect(cache.counters().tailsPendingBytes).toBe(0);
  });

  it("sheds its oldest records rather than growing past its bounds", () => {
    const released: ViewTailDto[] = [];
    const { cache, put } = releasing({ release: (tail) => released.push(tail) });

    // Far more distinct conversations than the queue may hold, in one frame.
    for (let index = 1; index <= PENDING_TAIL_MAX_ENTRIES * 4; index++) put(pathOf(index), { entries: 2, size: 16 });

    const counters = cache.counters();
    expect(counters.tailsPending).toBe(PENDING_TAIL_MAX_ENTRIES);
    expect(counters.tailsPendingBytes).toBeLessThanOrEqual(PENDING_TAIL_MAX_BYTES);
    expect(counters.tailsDropped).toBe(PENDING_TAIL_MAX_ENTRIES * 3);

    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);

    // The newest are what survived, deterministically.
    expect(released).toHaveLength(PENDING_TAIL_MAX_ENTRIES);
    expect(released.at(-1)!.path).toBe(pathOf(PENDING_TAIL_MAX_ENTRIES * 4));
    expect(released[0]!.path).toBe(pathOf(PENDING_TAIL_MAX_ENTRIES * 3 + 1));
  });

  it("stays inside its byte bound with large records", () => {
    const released: ViewTailDto[] = [];
    const { cache, put } = releasing({ release: (tail) => released.push(tail) });

    // Each tail near its own 256 KiB ceiling: the byte bound bites long before
    // the entry bound does.
    for (let index = 1; index <= 20; index++) put(pathOf(index), { entries: 40, size: 12_000 });

    const counters = cache.counters();
    expect(counters.tailsPendingBytes).toBeLessThanOrEqual(PENDING_TAIL_MAX_BYTES);
    expect(counters.tailsPending).toBeLessThan(PENDING_TAIL_MAX_ENTRIES);
    expect(counters.tailsDropped).toBe(20 - counters.tailsPending);

    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);
    expect(released.reduce((sum, tail) => sum + viewTailRetainedBytes(tail), 0)).toBeLessThanOrEqual(PENDING_TAIL_MAX_BYTES);
  });

  it("holds nothing through a reset or a disposal", () => {
    const released: ViewTailDto[] = [];
    const first = releasing({ release: (tail) => released.push(tail) });
    first.put(pathOf(1), { entries: 2 });
    expect(first.cache.counters().tailsPending).toBe(1);

    first.cache.reset();
    expect(first.cache.counters().tailsPending).toBe(0);
    expect(first.cache.counters().tailsPendingBytes).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(released).toEqual([]);

    const second = releasing({ release: (tail) => released.push(tail) });
    second.put(pathOf(2), { entries: 2 });
    second.cache.dispose();
    vi.advanceTimersByTime(1000);
    expect(released).toEqual([]);
  });
});

describe("six transcripts beside whatever is held", () => {
  it("does not let a pinned conversation take one of the cache's own slots", () => {
    const h = harness({ limits: { views: 6, bytes: 1 << 24, viewBytes: 1 << 24 } });
    // One held by a question, six ordinary ones.
    load(h, pathOf(0), { entries: 4 });
    h.store.dispatch({ type: "notification", method: "pi/ui/request", params: { path: pathOf(0), id: "q", method: "confirm", title: "Run?" } as never });
    for (let index = 1; index <= 6; index++) load(h, pathOf(index), { entries: 4 });

    const outcome = h.cache.maintain();

    expect(outcome.released).toEqual([]);
    expect(h.cache.counters().hydrated).toBe(7);
    expect(h.cache.counters().pinned).toBe(1);

    // A seventh candidate is one too many, and the pinned one is still not it.
    load(h, pathOf(7), { entries: 4 });
    const next = h.cache.maintain();
    expect(next.released.map((row) => row.path)).toEqual([pathOf(1)]);
    expect(isDormantView(h.store.getSnapshot().open[pathOf(0)])).toBe(false);
  });

  it("counts reading and sending as using a conversation", () => {
    const h = harness({ limits: { views: 1, bytes: 1 << 24, viewBytes: 1 << 24 } });
    load(h, pathOf(1), { entries: 4 });
    load(h, pathOf(2), { entries: 4 });
    load(h, pathOf(3), { entries: 4 });

    // The oldest conversation is read again, and the next oldest is sent to.
    load(h, pathOf(1), { entries: 6 });
    h.store.dispatch({ type: "optimisticUser", path: pathOf(2), text: "and now this", images: [], id: "sent" });

    const outcome = h.cache.maintain();

    // The one neither read nor written to is the one that goes; the one that
    // was read is newer than it, and the one sent to holds unsent words.
    expect(outcome.released.map((row) => row.path)).toEqual([pathOf(3)]);
    expect(isDormantView(h.store.getSnapshot().open[pathOf(1)])).toBe(false);
    expect(isDormantView(h.store.getSnapshot().open[pathOf(2)])).toBe(false);
  });

  it("treats a fork's new conversation as the one in use", () => {
    const h = harness({ limits: { views: 1, bytes: 1 << 24, viewBytes: 1 << 24 } });
    load(h, pathOf(1), { entries: 4 });
    load(h, pathOf(2), { entries: 4 });
    const forkedState = sessionState(pathOf(3));
    h.store.dispatch({ type: "forked", from: pathOf(1), state: forkedState });
    h.store.dispatch({ type: "historyBegin", path: pathOf(3), token: "fork" });
    h.store.dispatch({ type: "historySnapshot", path: pathOf(3), token: "fork", entries: hydrate(initialState, pathOf(3), { entries: 4 }).open[pathOf(3)]!.entries, leafId: null, window: window(4) });

    const outcome = h.cache.maintain();

    expect(outcome.released.map((row) => row.path)).toEqual([pathOf(2)]);
    expect(isDormantView(h.store.getSnapshot().open[pathOf(3)])).toBe(false);
  });
});

describe("the queue's idea of one conversation", () => {
  const realFrame = globalThis.requestAnimationFrame;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
  });
  afterEach(() => { vi.useRealTimers(); globalThis.requestAnimationFrame = realFrame; });

  const releasing = (sink: ViewTailSink) => {
    const store = createStateStore({ ...initialState, connection: "open" });
    const cache = createViewCache({
      read: () => store.getSnapshot(), dispatch: store.dispatch, environment: noDrafts,
      limits: { views: 0, bytes: 0, viewBytes: 0 }, sink,
    });
    store.observeTransactions((action, before, after) => { cache.observeTransaction(action, before, after); return false; });
    const put = (path: string, identity: { sessionId?: string; environmentKey?: string } = {}) => {
      const built = hydrate(initialState, path, { entries: 3 });
      const rows = built.open[path]!.entries;
      store.dispatch({ type: "opened", state: { ...built.open[path]!.state, ...(identity.sessionId !== undefined ? { id: identity.sessionId } : {}) } as SessionState });
      store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
      store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: rows, leafId: (rows.at(-1) as { id: string }).id,
        window: { ...window(3), ...(identity.environmentKey !== undefined ? { environmentKey: identity.environmentKey } : {}) } });
      cache.maintain();
    };
    return { store, cache, put };
  };

  it("coalesces one session that moved to another path", () => {
    const released: ViewTailDto[] = [];
    const { cache, put } = releasing({ release: (tail) => released.push(tail) });

    put(`${CWD}/before-the-move.jsonl`, { sessionId: "one-session" });
    put(`${CWD}/after-the-move.jsonl`, { sessionId: "one-session" });

    expect(cache.counters().tailsPending).toBe(1);
    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);
    expect(released).toHaveLength(1);
    // The later record wins, and its path is the one it now lives at.
    expect(released[0]!.sessionId).toBe("one-session");
    expect(released[0]!.path).toBe(`${CWD}/after-the-move.jsonl`);
  });

  it("keeps one session's records apart across environments", () => {
    const released: ViewTailDto[] = [];
    const { cache, put } = releasing({ release: (tail) => released.push(tail) });

    put(pathOf(1), { sessionId: "one-session", environmentKey: "env-a" });
    put(pathOf(2), { sessionId: "one-session", environmentKey: "env-b" });

    expect(cache.counters().tailsPending).toBe(2);
    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);
    expect(released.map((tail) => tail.environmentKey).sort()).toEqual(["env-a", "env-b"]);
  });

  it("refuses a record with no identity rather than keying it by its path", () => {
    const released: ViewTailDto[] = [];
    const { cache, put } = releasing({ release: (tail) => released.push(tail) });

    // No session id on the state: the capture is omitted, and so is the record.
    put(pathOf(1), { sessionId: "" });

    expect(cache.counters().tailsPending).toBe(0);
    expect(cache.counters().tailsDropped).toBe(1);
    vi.advanceTimersByTime(DELIVERY_FALLBACK_MS);
    expect(released).toEqual([]);
  });
});
