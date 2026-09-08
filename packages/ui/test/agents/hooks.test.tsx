// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAgentEvents,
  useAgentTree,
  useAgentWarnings,
  useNamerLabel,
  useRunsForRoot,
  useSessionAgent,
} from "../../src/agents/index.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { event, run, sessionState, snapshot, summary } from "./fixtures.js";

const ROOT = "/p/root.jsonl";
let container: HTMLDivElement;
let root: Root;
let store: StateStore;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const seeded: AppState = reduce(initialState, { type: "agents/loaded", snapshot: snapshot() });
  store = createStateStore({ ...seeded, sessions: [summary({ path: ROOT, name: "Root", attention: "working" })] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const mount = async (node: ReactNode) => act(async () => root.render(<LaserStoreProvider store={store}>{node}</LaserStoreProvider>));
const dispatch = async (...actions: Parameters<StateStore["dispatch"]>[0][]) => act(async () => { for (const action of actions) store.dispatch(action); });

describe("agent hooks", () => {
  it("keeps the tree and run list identity across unrelated updates and rebuilds on a run change", async () => {
    const seen: unknown[] = [];
    const runSeen: unknown[] = [];
    function Probe() {
      seen.push(useAgentTree(ROOT));
      runSeen.push(useRunsForRoot(ROOT));
      return null;
    }
    await mount(<Probe />);
    await dispatch({ type: "notification", method: "agents/run", params: { run: run({ runId: "r1", sessionPath: "/p/a.jsonl" }) } });
    const [first, second] = seen.slice(-2) as Array<ReturnType<typeof useAgentTree>>;
    expect(first?.nodes).toHaveLength(1);
    expect(second?.nodes.map((n) => n.id)).toEqual([ROOT, "/p/a.jsonl"]);
    // Another tree's run, a toast, a Beam prompt: nothing this tree draws
    // moved, so the probe does not render again at all.
    const renders = seen.length;
    await dispatch(
      { type: "notification", method: "agents/run", params: { run: run({ runId: "z", sessionPath: "/q/z.jsonl", rootSessionPath: "/q/root.jsonl", parent: null }) } },
      { type: "toast", level: "info", text: "hi" },
      { type: "agents/choose-beam-model", suggested: null },
    );
    expect(seen.length).toBe(renders);
    expect(seen.at(-1)).toBe(second);
    await dispatch({ type: "notification", method: "agents/run", params: { run: run({ runId: "r1", sessionPath: "/p/a.jsonl", status: "completed", updatedAt: "2026-09-08T10:09:00.000Z" }) } });
    const third = seen.at(-1) as ReturnType<typeof useAgentTree>;
    expect(seen.length).toBe(renders + 1);
    expect(third).not.toBe(second);
    expect(third?.byPath.get("/p/a.jsonl")?.ended).toBe(true);
    expect((runSeen.at(-1) as unknown[])).toHaveLength(1);
    // The run list of this tree changed too (a new run object), so it is a new array of one.
    expect(runSeen.at(-1)).not.toBe(runSeen.at(-2));
  });

  it("shows a node's events while they are younger than the ttl, then lets them go on a timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T10:00:00.000Z"));
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useAgentEvents("/p/a.jsonl", 1000));
      return null;
    }
    await mount(<Probe />);
    expect(seen.at(-1)).toEqual([]);
    await dispatch(
      { type: "notification", method: "agents/event", params: event({ id: "e1", sessionPath: "/p/a.jsonl", at: "2026-09-08T10:00:00.000Z" }) },
      { type: "notification", method: "agents/event", params: event({ id: "other", sessionPath: "/p/b.jsonl", at: "2026-09-08T10:00:00.000Z" }) },
      // A host clock slightly ahead of ours must not expire a bubble on arrival.
      { type: "notification", method: "agents/event", params: event({ id: "e2", sessionPath: "/p/a.jsonl", at: "2026-09-08T10:00:00.400Z" }) },
    );
    const live = seen.at(-1) as Array<{ id: string }>;
    expect(live.map((e) => e.id)).toEqual(["e1", "e2"]);
    // Unrelated state keeps the same array and causes no render.
    const renders = seen.length;
    await dispatch({ type: "toast", level: "info", text: "x" });
    expect(seen.length).toBe(renders);
    expect(seen.at(-1)).toBe(live);
    // One timer is armed for the soonest expiry; advancing the clock past e1 (but not e2) drops only e1.
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
    expect((seen.at(-1) as Array<{ id: string }>).map((e) => e.id)).toEqual(["e2"]);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(seen.at(-1)).toEqual([]);
    // Nothing showing, nothing ticking.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers a session's agent with the live run folded in, and only re-renders when it changes", async () => {
    const seen: unknown[] = [];
    function Probe({ path }: { path: string }) {
      seen.push(useSessionAgent(path));
      return null;
    }
    await mount(<Probe path={ROOT} />);
    expect(seen.at(-1)).toEqual({ agentName: "default", kind: "root" });
    // The catalog changed but this session's answer did not: no render.
    const renders = seen.length;
    await dispatch({ type: "sessions", sessions: [summary({ path: ROOT, name: "Root" }), summary({ path: "/p/a.jsonl", agent: { agentName: "reviewer", kind: "child", subagentName: "reviewer-1", parentPath: ROOT, rootPath: ROOT } })] });
    expect(seen.length).toBe(renders);
    await mount(<Probe path="/p/a.jsonl" />);
    expect(seen.at(-1)).toEqual({ agentName: "reviewer", kind: "child", subagentName: "reviewer-1", parentPath: ROOT, rootPath: ROOT });
    await dispatch({ type: "notification", method: "agents/run", params: { run: run({ runId: "r1", sessionPath: "/p/a.jsonl", status: "blocked" }) } });
    expect(seen.at(-1)).toMatchObject({ runId: "r1", runStatus: "blocked" });
    // A Beam session known only through its open view is placed by its directory.
    await dispatch({ type: "opened", state: sessionState({ path: "/state/beam/b.jsonl", cwd: "/state/beam" }) });
    await mount(<Probe path="/state/beam/b.jsonl" />);
    expect(seen.at(-1)).toEqual({ agentName: "default", kind: "beam" });
    await mount(<Probe path="/nowhere" />);
    expect(seen.at(-1)).toBeUndefined();
  });

  it("reads Namer labels and warnings", async () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push([useNamerLabel(ROOT, "t1"), useAgentWarnings()]);
      return null;
    }
    await dispatch({ type: "opened", state: sessionState({ path: ROOT }) });
    await mount(<Probe />);
    expect(seen.at(-1)).toEqual([undefined, []]);
    await dispatch({ type: "notification", method: "pi/extension/message", params: { path: ROOT, message: { type: "lasercode/namer/label", toolCallId: "t1", label: "Reading tests" } } });
    expect((seen.at(-1) as unknown[])[0]).toBe("Reading tests");
    const warning = { agentName: "reviewer", field: "skills" as const, message: "Skill file moved.", since: "2026-09-08T10:00:00.000Z" };
    await dispatch({ type: "notification", method: "agents/updated", params: snapshot({ revision: 2, warnings: [warning] }) });
    expect((seen.at(-1) as unknown[])[1]).toEqual([warning]);
  });
});
