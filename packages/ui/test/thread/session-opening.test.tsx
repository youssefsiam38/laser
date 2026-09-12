// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/client.js", async original => ({ ...await original<typeof import("../../src/client.js")>(), HostClient: (await import("../beam/fake-host.js")).FakeHostClient }));
// Unrelated transcript tools/find are covered by their own integration suites.
vi.mock("../../src/components/thread/messages.js", () => ({ ThreadMessage: () => <MessagePrimitive.Root><MessagePrimitive.Parts /></MessagePrimitive.Root> }));
vi.mock("../../src/components/thread/use-conversation-find.js", () => ({ useConversationFind: () => ({ open: false, root: undefined, bar: null }) }));
vi.mock("../../src/components/thread/Composer.js", () => ({ Composer: () => <ComposerPrimitive.Root><ComposerPrimitive.Input /><ComposerPrimitive.Send>Send</ComposerPrimitive.Send></ComposerPrimitive.Root> }));
import { Thread } from "../../src/components/thread/Thread.js";
import type { AppState } from "../../src/store.js";
import { WorkbenchProvider } from "../../src/components/workbench/workbench-context.js";
import { LaserProvider, PROJECT_STORAGE_KEY, SESSION_STORAGE_KEY, useLaserStable, useLaserState, type LaserActions } from "../../src/runtime/LaserProvider.js";
import { addSession, createWorld, FakeHostClient, settle as settleReal, type World } from "../beam/fake-host.js";

const path = "/p/history.jsonl";
const settle = (ms: number) => vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : settleReal(ms);
let actions: LaserActions;
let state: AppState;
let loading: boolean;
let loadToasts: number;
function Probe() { state = useLaserState(s => s); actions = useLaserStable().actions; loading = useAuiState(s => s.thread.isLoading); loadToasts = useLaserState(s => s.toasts.filter(toast => toast.text.includes("This session didn’t load")).length); return null; }
let root: Root, container: HTMLDivElement, world: World;
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld(); addSession(world, path, "/p"); addSession(world, "/p/start.jsonl", "/p"); FakeHostClient.reset(world);
  localStorage.setItem(PROJECT_STORAGE_KEY, "/p");
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ "/p": "/p/start.jsonl" }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<LaserProvider url="ws://test"><WorkbenchProvider><Probe /><Thread /></WorkbenchProvider></LaserProvider>));
  await act(async () => settle(30));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

it("shows skeleton, not welcome; arriving history wins immediately over optional reads and the hold", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  world.overrides["session/load"] = async () => { await held; return { state: world.states[path], replayFrom: 0, seq: 0 }; };
  world.overrides["pi/session/entries"] = () => ({ entries: [{ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: "Existing conversation" }] } }] });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  world.overrides["session/pending/list"] = async () => { await pending; return { messages: [] }; };
  vi.useFakeTimers();
  let open!: Promise<void>;
  await act(async () => { open = actions.openSession(path); await settle(10); });
  expect(loading).toBe(true);
  expect(container.textContent).not.toContain("New session.");
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  await act(async () => { vi.advanceTimersByTime(150); });
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).not.toBeNull();
  expect(container.querySelector("textarea")?.disabled).toBe(true);
  await act(async () => { release(); await settle(30); });
  expect(loading).toBe(false);
  expect(container.textContent).toContain("Existing conversation");
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  await act(async () => { finish(); await open; await settle(30); });
  expect(loading).toBe(false);
  expect(container.textContent).toContain("Existing conversation");
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  expect(container.querySelector("textarea")?.disabled).toBe(false);
});

it("failed load offers keyboard-focusable Retry, and successful empty hydration alone shows welcome", async () => {
  world.overrides["session/load"] = () => { throw new Error("The history file is unavailable. Retry or choose another conversation."); };
  await act(async () => { await actions.openSession(path).catch(() => {}); await settle(20); });
  expect(container.textContent).toContain("This session didn’t load.");
  expect(loadToasts).toBe(0);
  expect(container.textContent).toContain("The history file is unavailable. Retry or choose another conversation.");
  expect(container.textContent).not.toContain("New session.");
  const retry = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Retry"))!;
  retry.focus(); expect(document.activeElement).toBe(retry);
  delete world.overrides["session/load"];
  await act(async () => { retry.click(); await settle(40); });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("New session. What should the agent work on?");
});

const history = (text: string) => ({ entries: [{ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text }] } }] });
const visibleHistory = async () => {
  world.overrides["pi/session/entries"] = () => history("Visible history");
  await act(async () => { await actions.openSession(path); await settle(30); });
  expect(container.textContent).toContain("Visible history");
  return container.querySelector('[data-slot="thread-messages"]')!.firstChild;
};
const reopened = () => FakeHostClient.current.notify("pi/worker/status", { cwd: "/p", status: "ready", reopened: [path] });

it.each(["worker notification", "explicit reopen"])("keeps a visible transcript mounted and its composer usable during %s", async source => {
  const message = await visibleHistory();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  world.overrides["session/load"] = async () => { await hold; return { state: world.states[path], replayFrom: 0, seq: 0 }; };
  await act(async () => { if (source === "worker notification") reopened(); else void actions.openSession(path); await settle(180); });
  expect(state.sessionLoads[path]?.phase).toBe("opening");
  expect(container.querySelector('[data-slot="thread-messages"]')!.firstChild).toBe(message);
  expect(container.textContent).toContain("Visible history");
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  expect(container.querySelector("textarea")?.disabled).toBe(false);
  await act(async () => { release(); await settle(30); });
  expect(state.sessionLoads[path]).toBeUndefined();
});

it("a background goal failure does not hide history, disable input, or skip tracking", async () => {
  const message = await visibleHistory();
  const track = vi.spyOn(FakeHostClient.current, "track");
  world.overrides["session/goal/get"] = () => { throw new Error("Goal unavailable"); };
  await act(async () => { reopened(); await settle(180); });
  expect(container.querySelector('[data-slot="thread-messages"]')!.firstChild).toBe(message);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("textarea")?.disabled).toBe(false);
  expect(track).toHaveBeenCalledWith(path, 0);
});

it("a worker reopen refreshes the tree even when both epochs have the same zero watermark", async () => {
  await visibleHistory();
  world.overrides["pi/session/entries"] = () => history("Fresh history from disk");
  await act(async () => { reopened(); await settle(30); });
  expect(state.current).toBe(path);
  expect(container.textContent).toContain("Fresh history from disk");
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
});

it("resumes a restarted worker epoch by re-hydrating while retaining visible history", async () => {
  const message = await visibleHistory();
  let release!: (value: ReturnType<typeof history>) => void;
  world.overrides["pi/session/entries"] = () => new Promise(resolve => { release = resolve; });
  await act(async () => {
    FakeHostClient.current.notify("session/update", { sessionPath: path, seq: 9, at: new Date().toISOString(), update: { kind: "pending_update", pending: [] } });
    FakeHostClient.current.options.onResume?.(path, 0, 9);
    await settle(180);
  });
  expect(state.open[path]?.hydrated).toBe(false);
  expect(state.sessionLoads[path]?.phase).toBe("opening");
  expect(container.querySelector('[data-slot="thread-messages"]')!.firstChild).toBe(message);
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  expect(container.querySelector("textarea")?.disabled).toBe(false);
  await act(async () => { release(history("Fresh history")); await settle(30); });
  expect(state.open[path]?.hydrated).toBe(true);
  expect(state.sessionLoads[path]).toBeUndefined();
  expect(container.textContent).toContain("Fresh history");
  expect(loading).toBe(false);
});

it("New session waits quietly and a worker-start failure keeps its real reason", async () => {
  await visibleHistory();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  world.overrides["session/new"] = async () => { await hold; throw new Error("The worker could not start. Retry or choose another project."); };
  let creation!: Promise<unknown>;
  await act(async () => { creation = actions.newSession("/p").catch(() => {}); await settle(180); });
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  expect(loading).toBe(false);
  await act(async () => { release(); await creation; await settle(30); });
  expect(container.textContent).toContain("Couldn’t open this view.");
  expect(container.textContent).toContain("The worker could not start. Retry or choose another project.");
  expect(container.textContent).not.toContain("This session didn’t load.");
  expect(state.toasts.some(toast => toast.text.includes("worker could not start"))).toBe(false);
});
