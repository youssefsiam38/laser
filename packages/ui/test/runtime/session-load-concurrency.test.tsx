// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/client.js", async original => ({ ...await original<typeof import("../../src/client.js")>(), HostClient: (await import("../beam/fake-host.js")).FakeHostClient }));
vi.mock("../../src/runtime/projection.js", async original => {
  const source = await original<typeof import("../../src/runtime/projection.js")>();
  return { ...source, projectSessionView: vi.fn(source.projectSessionView) };
});
import { LaserProvider, PROJECT_STORAGE_KEY, SESSION_STORAGE_KEY, useLaserStable, useLaserState, type LaserActions } from "../../src/runtime/LaserProvider.js";
import { projectSessionView } from "../../src/runtime/projection.js";
import type { AppState } from "../../src/store.js";
import { addSession, createWorld, FakeHostClient, settle, type World } from "../beam/fake-host.js";
const path = "/p/target.jsonl";
let actions: LaserActions, state: AppState, root: Root, container: HTMLDivElement, world: World;
function Probe() { actions = useLaserStable().actions; state = useLaserState(s => s); return null; }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const entries = (text: string) => [{ id: "u", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text }] } }];
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear();
  world = createWorld(); addSession(world, path, "/p"); addSession(world, "/p/start.jsonl", "/p"); FakeHostClient.reset(world);
  localStorage.setItem(PROJECT_STORAGE_KEY, "/p"); localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ "/p": "/p/start.jsonl" }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>)); await act(async () => settle(40));
  vi.mocked(projectSessionView).mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("starts all independent reads together and projects the final transcript only once", async () => {
  const tree = deferred<{ entries: unknown[] }>(), goal = deferred<{ goal: null }>(), pending = deferred<{ messages: [] }>();
  world.overrides["pi/session/entries"] = () => tree.promise;
  world.overrides["session/goal/get"] = () => goal.promise;
  world.overrides["session/pending/list"] = () => pending.promise;
  let open!: Promise<void>;
  await act(async () => {
    open = actions.openSession(path);
    // An open connection starts the load in the click's turn, not after a
    // promise yield lets the old long transcript monopolize the main thread.
    expect(world.calls.some(c => c.method === "session/load" && (c.params as { path?: string }).path === path)).toBe(true);
    await settle(20);
  });
  for (const method of ["pi/session/entries", "session/goal/get", "session/pending/list"]) {
    expect(world.calls.some(c => c.method === method && (c.params as { path?: string }).path === path)).toBe(true);
  }
  await act(async () => { tree.resolve({ entries: entries("History") }); await settle(20); });
  expect(state.open[path]?.loadState).toBe("opening");
  expect(vi.mocked(projectSessionView).mock.calls.filter(([view]) => view?.path === path && view.entries.length > 0)).toHaveLength(0);
  await act(async () => { goal.resolve({ goal: null }); pending.resolve({ messages: [] }); await open; await settle(40); });
  expect(state.open[path]?.loadState).toBeUndefined();
  expect(vi.mocked(projectSessionView).mock.calls.filter(([view]) => view?.path === path && view.entries.length > 0)).toHaveLength(1);
});

it("does not let a failed batch's late history overwrite a successful Retry", async () => {
  const oldTree = deferred<{ entries: unknown[] }>();
  world.overrides["pi/session/entries"] = () => oldTree.promise;
  world.overrides["session/goal/get"] = () => { throw new Error("failed"); };
  await act(async () => { await actions.openSession(path).catch(() => {}); await settle(20); });
  expect(state.open[path]?.loadState).toBe("error");
  world.overrides["pi/session/entries"] = () => ({ entries: entries("New history") });
  delete world.overrides["session/goal/get"];
  await act(async () => { await actions.openSession(path); await settle(20); });
  const blocks = state.open[path]?.blocks;
  await act(async () => { oldTree.resolve({ entries: entries("Stale history") }); await settle(30); });
  expect(state.open[path]?.blocks).toBe(blocks);
  expect(state.open[path]?.entries).toEqual(entries("New history"));
});

it("keeps the sequence and pending watermarks when live updates overtake parallel reads", async () => {
  const tree = deferred<{ entries: unknown[] }>(), pending = deferred<{ messages: unknown[] }>();
  world.overrides["pi/session/entries"] = () => tree.promise;
  world.overrides["session/pending/list"] = () => pending.promise;
  let open!: Promise<void>;
  await act(async () => { open = actions.openSession(path); await settle(20); });
  await act(async () => {
    FakeHostClient.current.notify("session/update", { sessionPath: path, seq: 4, at: new Date().toISOString(), update: { kind: "text_delta", contentIndex: 0, delta: "Live reply" } });
    FakeHostClient.current.notify("session/update", { sessionPath: path, seq: 5, at: new Date().toISOString(), update: { kind: "pending_update", pending: [] } });
    await settle(40);
  });
  const blocks = state.open[path]?.blocks;
  await act(async () => { tree.resolve({ entries: entries("Old snapshot") }); pending.resolve({ messages: [{ id: "stale", text: "Already delivered", images: 0 }] }); await open; await settle(20); });
  expect(state.open[path]?.blocks).toBe(blocks);
  expect(state.open[path]?.lastSeq).toBe(5);
  expect(state.open[path]?.pending).toEqual([]);
});
