// @vitest-environment happy-dom
import { historyWindow } from "@lasercode/protocol";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { buildFleet, createFleetSelector, type FleetInput } from "../../src/fleet/model.js";
import { createStateStore, LaserStoreProvider, useSessionMeta } from "../../src/runtime/LaserProvider.js";
import { createShellSnapshot, samePresentationViews } from "../../src/runtime/presentation-state.js";
import { useFleet } from "../../src/fleet/hooks.js";
import { initialState, type AppState } from "../../src/store.js";
import { view, summary, run } from "../agents/fixtures.js";

describe("presentation subscriptions", () => {
  it.each([1, 8, 32])("does not render shell, fleet or session metadata for %i irrelevant streams", async (streams) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const open: AppState["open"] = {};
    for (let i = 0; i < streams; i++) open[`/p/${i}`] = view({ path: `/p/${i}`, blocks: [{ kind: "user", id: "u", text: "First prompt" }] });
    const store = createStateStore({ ...initialState, current: "/p/0", open });
    const snapshot = createShellSnapshot(store.getSnapshot);
    const counts = { shell: 0, fleet: 0, meta: 0, broad: 0 };
    function Shell() { useSyncExternalStore(store.subscribe, snapshot); counts.shell++; return null; }
    function Broad() { useSyncExternalStore(store.subscribe, store.getSnapshot); counts.broad++; return null; }
    function Fleet() { useFleet(); counts.fleet++; return null; }
    function Meta() { useSessionMeta(); counts.meta++; return null; }
    const container = document.createElement("div"), root = createRoot(container);
    try {
      await act(async () => root.render(<LaserStoreProvider store={store}><Shell /><Fleet /><Meta /><Broad /></LaserStoreProvider>));
      Object.assign(counts, { shell: 0, fleet: 0, meta: 0, broad: 0 });
      for (let seq = 1; seq <= 10; seq++) for (let i = 0; i < streams; i++) {
        await act(async () => store.dispatch({ type: "notification", method: "session/update", params: {
          sessionPath: `/p/${i}`, seq, at: "", update: { kind: "text_delta", delta: "word", contentIndex: 0 },
        } }));
      }
      expect(counts).toEqual({ shell: 0, fleet: 0, meta: 0, broad: streams * 10 });
    } finally { await act(async () => root.unmount()); }
  });

  it("shares fleet structure across consumers and advances clocks without rebuilding it", () => {
    const build = vi.fn(buildFleet), select = createFleetSelector(build);
    const child = run({ runId: "r", status: "running" });
    const input: FleetInput = { sessions: [summary({ path: child.rootSessionPath })],
      runs: { r: child }, tasks: {}, views: {}, now: Date.parse(child.startedAt!) + 1000 };
    expect(select(input)).toEqual(buildFleet(input));
    expect(select(input)).toBe(select(input));
    for (let i = 1; i <= 5; i++) {
      const later = { ...input, now: input.now + i * 1000 };
      expect(select(later)).toEqual(buildFleet(later));
    }
    expect(build).toHaveBeenCalledTimes(1);
    const asking = { ...input, runs: { r: { ...child, status: "needs_input" as const } } };
    expect(select(asking)).toEqual(buildFleet(asking));
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("invalidates fleet deletion state when a catalog presence probe changes", () => {
    const select = createFleetSelector();
    const child = run({ runId: "r", status: "running" });
    const input: FleetInput = { sessions: [], runs: { r: child }, tasks: {}, views: {}, now: Date.now(), sessionsLoaded: true, sessionPresence: {} };
    expect(select(input)[0]?.deleted).toBe(false);
    expect(select({ ...input, sessionPresence: { [child.rootSessionPath]: false } })[0]?.deleted).toBe(true);
  });

  it("tracks only history scope needed for titles and reusable-session decisions", () => {
    const history = historyWindow({ entries: [], leafId: null }, { tail: 40 }, { path: "/p", epoch: "e", seq: 0 }).window;
    const original = view({ path: "/p", history });
    const before = { "/p": original };
    expect(samePresentationViews(before, { "/p": { ...original, history: { ...history, seq: 10 } } })).toBe(true);
    expect(samePresentationViews(before, { "/p": { ...original, history: { ...history, userOffset: 20 } } })).toBe(false);
    expect(samePresentationViews(before, { "/p": { ...original, history: { ...history, hasHistory: true } } })).toBe(false);
  });

  it("keeps titles, questions, status, membership and run activity live", () => {
    const original = view({ path: "/p/root", blocks: [{ kind: "user", id: "u", text: "First prompt" }] });
    const a = { ...initialState, open: { "/p/root": original } };
    expect(samePresentationViews(a.open, { "/p/root": { ...original, lastSeq: 1 } })).toBe(true);
    for (const next of [
      { ...original, running: !original.running },
      { ...original, title: "Renamed" },
      { ...original, state: { ...original.state, cwd: "/new-project" } },
      { ...original, dialogs: [...original.dialogs] },
      { ...original, blocks: [{ kind: "user" as const, id: "new", text: "New branch prompt" }] },
    ]) expect(samePresentationViews(a.open, { "/p/root": next })).toBe(false);
    expect(samePresentationViews(a.open, {})).toBe(false);
    let current: AppState = a;
    const read = createShellSnapshot(() => current);
    expect(read()).toBe(a);
    current = { ...a, sessions: [summary({ path: "/new" })] };
    expect(read()).toBe(current);
    current = { ...a, agents: { ...a.agents, runs: { r: run({ runId: "r", status: "needs_input" }) } } };
    expect(read()).toBe(current);
  });
});
