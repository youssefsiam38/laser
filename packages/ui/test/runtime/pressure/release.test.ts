/**
 * What a pass actually releases, against the real cache and the real store
 * (RP-8 milestone F, D-265).
 *
 * The controller owns no transcript state of its own: step 2 is T5's
 * `ViewCache.releaseUnder`, at this window's real limits, over views the
 * reducer built. So the things worth proving are the ones a person would
 * notice: the conversation on screen and the one holding their words survive
 * every level, the bounds hold, and the row says exactly what the cache's own
 * counters say it released.
 */
import { describe, expect, it } from "vitest";
import type { SessionState } from "@lasercode/protocol";

import { createStateStore } from "../../../src/runtime/LaserProvider.js";
import { createRendererPressureController } from "../../../src/runtime/pressure/controller.js";
import { createViewCache, VIEW_CACHE_LIMITS, type ViewCacheEnvironment } from "../../../src/runtime/view-cache.js";
import { initialState, isDormantView, type AppState } from "../../../src/store.js";

const CWD = "/p";
const pathOf = (index: number): string => `${CWD}/s${index}.jsonl`;
const MiB = 1024 * 1024;

const sessionState = (path: string): SessionState => ({
  path, id: `id-${path}`, cwd: CWD, messageCount: 4, pendingMessageCount: 0, isStreaming: false, isCompacting: false,
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

function harness(options: { drafts?: string[] } = {}) {
  const store = createStateStore({ ...initialState, connection: "open" });
  const environment: ViewCacheEnvironment = { scoped: () => [], hasDraft: (path) => (options.drafts ?? []).includes(path) };
  const cache = createViewCache({
    read: () => store.getSnapshot(),
    dispatch: store.dispatch,
    environment,
    // Deferred passes are run by hand: this test is about what one pressure
    // pass does, not about when maintenance would have happened anyway.
    defer: () => () => {},
    deliver: () => () => {},
  });
  store.observeTransactions((action, before, after) => { cache.observeTransaction(action, before, after); return false; });
  let physical = 100 * MiB;
  const controller = createRendererPressureController({
    sample: async () => ({
      atMs: 500_000,
      physical: { status: "available", value: physical },
      heapUsed: { status: "unavailable", reason: "unsupported_platform" },
      heapLimit: { status: "unavailable", reason: "unsupported_platform" },
    }),
    cache,
    ephemeral: () => ({ count: 0, bytes: 0, failures: 0 }),
    now: () => 500_000,
    schedule: () => () => {},
  });
  const load = (path: string, entries = 6, size = 30_000): void => {
    const rows = Array.from({ length: entries }, (_, index) => entryOf(path, index, size));
    store.dispatch({ type: "opened", state: sessionState(path) });
    store.dispatch({ type: "historyBegin", path, token: `${path}:t` });
    store.dispatch({ type: "historySnapshot", path, token: `${path}:t`, entries: rows, leafId: rows.at(-1)!.id, window: window(entries) });
    cache.touch(path);
  };
  return {
    store, cache, controller, load,
    pressure: (mib: number) => { physical = mib * MiB; },
    state: (): AppState => store.getSnapshot(),
    hydrated: (): string[] => Object.keys(store.getSnapshot().open).filter((path) => !isDormantView(store.getSnapshot().open[path]!)).sort(),
  };
}

/** Two agreeing samples: the level moves and the pass runs. */
const press = async (h: ReturnType<typeof harness>, mib: number): Promise<void> => {
  h.pressure(mib);
  await h.controller.probeNow();
  await h.controller.probeNow();
};

describe("a pass over the real cache", () => {
  it("keeps the conversation on screen and the one holding a draft, and releases the rest", async () => {
    const h = harness({ drafts: [pathOf(2)] });
    for (let index = 1; index <= 8; index++) h.load(pathOf(index));
    h.store.dispatch({ type: "destination", destination: { phase: "ready-chat", intent: 1, chat: { kind: "session", path: pathOf(1) }, rememberedCode: { kind: "no-project-landing" } } as AppState["destination"] });
    expect(h.state().current).toBe(pathOf(1));
    await press(h, 1300);

    const hydrated = h.hydrated();
    expect(hydrated).toContain(pathOf(1)); // the conversation on screen
    expect(hydrated).toContain(pathOf(2)); // the draft
    // Pins sit beside the unpinned slots, and warning halves those: three.
    expect(hydrated.filter((path) => path !== pathOf(1) && path !== pathOf(2))).toHaveLength(3);
    // Nothing canonical was lost: every session still has its light record.
    expect(Object.keys(h.state().open)).toHaveLength(8);
    for (const path of Object.keys(h.state().open)) {
      const view = h.state().open[path]!;
      if (isDormantView(view)) expect(view.dormant?.reason).toBe("pressure");
    }
  });

  it("holds every hydrated view inside its share and the window inside its total", async () => {
    const h = harness();
    for (let index = 1; index <= 8; index++) h.load(pathOf(index));
    await press(h, 1300);
    const counters = h.cache.counters();
    expect(counters.bytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.bytes);
    expect(counters.largestViewBytes).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.viewBytes);
  });

  it("reports the cache's own measured delta, and gives nothing the second time", async () => {
    const h = harness();
    for (let index = 1; index <= 8; index++) h.load(pathOf(index));
    const before = h.cache.counters().bytes;
    await press(h, 1300);
    const after = h.cache.counters().bytes;
    const row = h.controller.getSnapshot().rows.find((entry) => entry.action === "renderer_views")!;
    expect(row.outcome).toBe("released");
    expect(row.released?.bytes).toBe(before - after);
    expect(row.released?.count).toBeGreaterThan(0);

    // A second pass at the same level with nothing newly hydrated is not a
    // ratchet: it releases nothing and says so.
    const rowsBefore = h.controller.getSnapshot().rows.length;
    await h.controller.probeNow();
    await h.controller.probeNow();
    const rows = h.controller.getSnapshot().rows.slice(0, h.controller.getSnapshot().rows.length - rowsBefore);
    for (const entry of rows.filter((candidate) => candidate.action === "renderer_views")) {
      expect(entry.outcome).toBe("nothing_to_give");
    }
    expect(h.cache.counters().bytes).toBe(after);
  });

  it("goes further at critical than at warning", async () => {
    const warning = harness();
    for (let index = 1; index <= 8; index++) warning.load(pathOf(index));
    await press(warning, 1300);
    const afterWarning = warning.hydrated().length;

    const critical = harness();
    for (let index = 1; index <= 8; index++) critical.load(pathOf(index));
    await press(critical, 2000);
    expect(critical.hydrated().length).toBeLessThan(afterWarning);
  });
});
