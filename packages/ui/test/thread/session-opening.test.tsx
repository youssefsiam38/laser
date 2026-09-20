// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/client.js", async original => ({ ...await original<typeof import("../../src/client.js")>(), HostClient: (await import("../beam/fake-host.js")).FakeHostClient }));
// Unrelated transcript tools/find are covered by their own integration suites.
vi.mock("../../src/components/thread/messages.js", () => ({ ThreadMessage: () => <MessagePrimitive.Root><MessagePrimitive.Parts /></MessagePrimitive.Root> }));
const findOptions = vi.hoisted(() => ({ current: undefined as { loadAll?: () => Promise<boolean>; partial?: boolean } | undefined }));
vi.mock("../../src/components/thread/use-conversation-find.js", () => ({ useConversationFind: (options: { loadAll?: () => Promise<boolean>; partial?: boolean }) => { findOptions.current = options; return { open: false, root: undefined, bar: null }; } }));
vi.mock("../../src/components/thread/Composer.js", () => ({ Composer: () => <ComposerPrimitive.Root><ComposerPrimitive.Input /><ComposerPrimitive.Send>Send</ComposerPrimitive.Send></ComposerPrimitive.Root> }));
import { Thread } from "../../src/components/thread/Thread.js";
import type { AppState } from "../../src/store.js";
import { WorkbenchProvider } from "../../src/components/workbench/workbench-context.js";
import { LaserProvider, useLaserStable, useLaserState, type LaserActions } from "../../src/runtime/LaserProvider.js";
import { addSession, createWorld, FakeHostClient, settle as settleReal, type World } from "../beam/fake-host.js";
import { historyWindow } from "@lasercode/protocol";
import { seedProject, seedRememberedSessions } from "../../test/runtime/environment-fixture.js";

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
  seedProject("/p");
  seedRememberedSessions({ "/p": "/p/start.jsonl" });
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
  // The composer belongs to the person even while the conversation opens: the
  // draft is editable and only sending waits for the host (RP-11).
  expect(container.querySelector("textarea")?.disabled).toBe(false);
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
  expect(container.textContent).toContain("What should the agent work on?");
});

/**
 * D-341: a new chat is local until the person speaks. The landing paints
 * complete from what this window knows, and the host's answer — the created
 * session's path — changes identity underneath and not one pixel: no remount
 * of the transcript subtree, no word of the welcome, no control appearing.
 */
it("adopts the created session without remounting the transcript or changing a word of the landing", async () => {
  await visibleHistory();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  world.overrides["session/new"] = async (params) => {
    await hold;
    delete world.overrides["session/new"];
    return FakeHostClient.current.request("session/new", params);
  };
  let creation!: Promise<string>;
  await act(async () => { creation = actions.newSession("/p"); await settle(180); });

  // The first frame is the finished landing, from the destination alone: the
  // project's directory as the eyebrow, its name as the greeting, one sentence,
  // the suggestions. No blank, no skeleton, no session yet.
  expect(state.current).toBeUndefined();
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  const empty = container.querySelector('[data-slot="empty-state"]');
  expect(empty).not.toBeNull();
  expect(container.querySelector('[data-slot="empty-state-eyebrow"]')?.textContent).toBe("/p");
  expect(container.querySelector('[data-slot="empty-state-greeting"]')?.textContent).toBe("p");
  expect(container.querySelector('[data-slot="empty-state-description"]')?.textContent).toBe("What should the agent work on?");
  expect(container.querySelectorAll('[data-slot="empty-state-suggestions"] li').length).toBe(3);
  const viewport = container.querySelector('[data-slot="thread-viewport"]');
  const head = container.querySelector('[data-slot="transcript-head"]');
  expect(viewport).not.toBeNull();
  const words = container.textContent;

  await act(async () => { release(); await creation; await settle(60); });

  // The answer landed: the destination now names the session…
  expect(state.current).toBe(await creation);
  expect(state.open[await creation]?.hydrated).toBe(true);
  // …and nothing on the glass moved for it. The same DOM nodes, the same text.
  expect(container.querySelector('[data-slot="thread-viewport"]')).toBe(viewport);
  expect(container.querySelector('[data-slot="transcript-head"]')).toBe(head);
  expect(container.querySelector('[data-slot="empty-state"]')).toBe(empty);
  expect(container.textContent).toBe(words);
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  expect(container.querySelector("textarea")?.disabled).toBe(false);
});

/**
 * Cause 3 of D-341 on its own, with no words involved: the gate around the
 * transcript was keyed on the open path, which starts undefined on a landing
 * and becomes the created session's when the host answers — so React threw the
 * whole subtree away and built it again. The scroller must be the same node.
 */
it("keeps the same transcript scroller node when the created path is adopted", async () => {
  await visibleHistory();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  world.overrides["session/new"] = async (params) => {
    await hold;
    delete world.overrides["session/new"];
    return FakeHostClient.current.request("session/new", params);
  };
  let creation!: Promise<string>;
  await act(async () => { creation = actions.newSession("/p"); await settle(180); });
  const viewport = container.querySelector('[data-slot="thread-viewport"]');
  expect(viewport).not.toBeNull();
  await act(async () => { release(); await creation; await settle(60); });
  expect(state.current).toBe(await creation);
  expect(container.querySelector('[data-slot="thread-viewport"]')).toBe(viewport);
});

/**
 * The first row's own node. The transcript's rows are the list's, so identity
 * across a reopen is read from the row wrapper rather than from a container
 * the list owns and may reuse.
 */
const firstRow = () => container.querySelector('[data-window-message]')!.firstElementChild;
const history = (text: string) => ({ entries: [{ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text }] } }] });
const visibleHistory = async () => {
  world.overrides["pi/session/entries"] = () => history("Visible history");
  await act(async () => { await actions.openSession(path); await settle(30); });
  expect(container.textContent).toContain("Visible history");
  return firstRow();
};
const reopened = () => FakeHostClient.current.notify("pi/worker/status", { cwd: "/p", status: "ready", reopened: [path] });

it.each(["worker notification", "explicit reopen"])("keeps a visible transcript mounted and its composer usable during %s", async source => {
  const message = await visibleHistory();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  world.overrides["session/load"] = async () => { await hold; return { state: world.states[path], replayFrom: 0, seq: 0 }; };
  await act(async () => { if (source === "worker notification") reopened(); else void actions.openSession(path); await settle(180); });
  expect(state.sessionLoads[path]?.phase).toBe("opening");
  expect(firstRow()).toBe(message);
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
  expect(firstRow()).toBe(message);
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

it("derives default membership: switching A to B detaches A and never detaches current B", async () => {
  await visibleHistory();
  world.calls.length = 0;

  await act(async () => { await actions.openSession("/p/start.jsonl"); await settle(30); });

  expect(state.current).toBe("/p/start.jsonl");
  const detached = world.calls
    .filter(call => call.method === "pi/session/detach")
    .map(call => call.params as { path: string; owner?: string });
  expect(detached).toContainEqual({ path });
  expect(detached.some(call => call.path === "/p/start.jsonl" && call.owner === undefined)).toBe(false);
});

it.each(["worker reopen", "socket reconnect"])('detaches dormant A after a fresh %s load while B stays current', async source => {
  await visibleHistory();
  await act(async () => { await actions.openSession("/p/start.jsonl"); await settle(30); });
  expect(state.current).toBe("/p/start.jsonl");
  world.calls.length = 0;

  await act(async () => {
    if (source === "worker reopen") reopened();
    else FakeHostClient.current.reconnect();
    await settle(60);
  });

  const pathCalls = world.calls
    .filter(call => ["session/load", "pi/session/detach"].includes(call.method)
      && (call.params as { path?: string }).path === path)
    .map(call => call.method);
  expect(pathCalls).toEqual(["session/load", "pi/session/detach"]);

  await act(async () => {
    for (let seq = 1; seq <= 3; seq += 1) {
      FakeHostClient.current.notify("session/update", {
        sessionPath: "/p/start.jsonl", seq, at: new Date().toISOString(), update: { kind: "pending_update", pending: [] },
      });
    }
    await settle(10);
  });
  expect(world.calls.filter(call => call.method === "pi/session/detach"
    && (call.params as { path?: string }).path === path)).toHaveLength(1);
  expect(state.current).toBe("/p/start.jsonl");
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
  expect(firstRow()).toBe(message);
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  expect(container.querySelector("textarea")?.disabled).toBe(false);
  await act(async () => { release(history("Fresh history")); await settle(30); });
  expect(state.open[path]?.hydrated).toBe(true);
  expect(state.sessionLoads[path]).toBeUndefined();
  expect(container.textContent).toContain("Fresh history");
  expect(loading).toBe(false);
});

it("keeps an admitted New session held through the visible destination handoff", async () => {
  await visibleHistory();
  world.calls.length = 0;

  let created = "";
  await act(async () => { created = await actions.newSession("/p"); await settle(40); });

  expect(state.current).toBe(created);
  expect(world.calls.filter(call => call.method === "session/new")).toHaveLength(1);
  expect(world.calls.filter(call => call.method === "pi/session/detach"
    && (call.params as { path?: string; owner?: string }).path === created
    && (call.params as { owner?: string }).owner === undefined)).toEqual([]);
});

it("New session is a landing while session/new is held, and a worker-start failure keeps the draft", async () => {
  await visibleHistory();
  let release!: () => void;
  const hold = new Promise<void>((resolve, reject) => {
    release = () => reject(new Error("The worker could not start. Retry or choose another project."));
  });
  world.overrides["session/new"] = async () => { await hold; return { state: world.states[path] }; };
  let creation!: Promise<unknown>;
  await act(async () => { creation = actions.newSession("/p").catch(() => {}); await settle(180); });
  expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
  expect(loading).toBe(false);
  expect(state.destination.phase === "ready-code" || state.destination.phase === "ready-chat").toBe(true);
  const textarea = container.querySelector("textarea");
  expect(textarea?.disabled).toBe(false);
  await act(async () => {
    if (textarea) {
      textarea.value = "keep this draft";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle(0);
  });
  await act(async () => { release(); await creation; await settle(30); });
  expect(container.textContent).not.toContain("Couldn’t open this view.");
  expect(container.textContent).not.toContain("This session didn’t load.");
  expect(state.destination.phase === "unavailable").toBe(false);
  expect(container.querySelector("textarea")?.disabled).toBe(false);
});

/**
 * Find searches the branch on screen, so "Load all messages" pages that branch
 * to its root with the turn pager. It used to send the indivisible whole-
 * conversation read, which the producer refuses past two hundred rows — every
 * conversation partial enough to offer the button — leaving the control up and
 * the refusal in a toast nobody was looking at.
 */
it("pages the branch to its root for Find's Load all messages, never the indivisible whole read", async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null,
    message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }] } }));
  const scope = { sessionId: "s", epoch: "one", seq: 0, revision: "r1.test", environmentKey: "e1.test" };
  world.overrides["pi/session/entries"] = (params: { window?: Parameters<typeof historyWindow>[1] }) =>
    historyWindow({ entries: many, leafId: "m79" }, params.window ?? { all: true }, scope);
  await act(async () => { await actions.openSession(path); await settle(30); });
  expect(state.open[path]?.history?.complete).toBe(false);
  expect(findOptions.current?.partial).toBe(true);
  world.calls.length = 0;

  await act(async () => { await findOptions.current!.loadAll!(); await settle(30); });

  expect(state.open[path]?.history?.complete).toBe(true);
  expect(state.open[path]?.entries).toHaveLength(80);
  const windows = world.calls.filter(call => call.method === "pi/session/entries").map(call => (call.params as { window?: Record<string, unknown> }).window);
  expect(windows.length).toBeGreaterThan(1);
  expect(windows.every(window => window !== undefined && "before" in window && "turns" in window)).toBe(true);
  expect(windows.some(window => window !== undefined && "all" in window)).toBe(false);
});

/**
 * Everything above the conversation is the transcript's head item, not chrome
 * above the list (M16-T87, D-303). Chrome that appears while somebody is
 * reading changes the ground the engine measures from — `scrollMargin` — and
 * every row moves by its height with the scroll position untouched, which is
 * the reader being pushed down by exactly that much. Inside the head the same
 * appearance is an item resize the engine compensates to the pixel; the
 * geometry of that is proven over a laid-out transcript in
 * `transcript-virtualization.test.tsx > the head`.
 */
const head = () => container.querySelector('[data-slot="transcript-head"]');

it("keeps a load failure inside the transcript head, above the conversation", async () => {
  world.overrides["session/load"] = () => { throw new Error("The history file is unavailable."); };
  await act(async () => { await actions.openSession(path).catch(() => {}); await settle(20); });
  const error = [...container.querySelectorAll('[role="alert"]')]
    .find(node => node.textContent?.includes("This session didn’t load."));
  expect(error, "the load failure is not on screen").toBeDefined();
  expect(head()?.contains(error!), "the load failure is chrome above the list").toBe(true);
});

it("keeps a crashed worker inside the transcript head, above the conversation", async () => {
  await visibleHistory();
  await act(async () => {
    FakeHostClient.current.notify("pi/worker/status", {
      cwd: "/p",
      status: "crashed",
      mode: "normal",
      restarts: 0,
      since: "2026-09-16T00:00:00.000Z",
      canRestart: true,
      failure: { owner: { kind: "worker", launchId: "0123456789abcdef0123456789abcdef", cwd: "/p" }, stage: "runtime", category: "process_exit", message: "stopped" },
      repair: { state: "available", automaticAttempts: 0 },
    });
    await settle(30);
  });
  const notice = [...container.querySelectorAll('[role="alert"]')]
    .find(node => node.textContent?.includes("Worker crashed"));
  expect(notice, "the crash notice is not on screen").toBeDefined();
  expect(head()?.contains(notice!), "the crash notice is chrome above the list").toBe(true);
  // And the conversation it appeared over is still there, behind it.
  expect(container.textContent).toContain("Visible history");
});
