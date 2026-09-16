// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadListPrimitive, ThreadPrimitive, useAui, useAuiState, useExternalStoreRuntime, type AssistantRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { createThreadAdapter, type RequestClient } from "../../src/runtime/adapter.js";
import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { ThreadListItem } from "../../src/components/assistant-ui/elements/thread-list.aui.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle } from "../beam/fake-host.js";
import { seedProject, seedRememberedSessions } from "../../test/runtime/environment-fixture.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("stable external-store conversion", () => {
  it("retains all canonical identities on metadata publications and converts changed content", async () => {
    let runtime!: AssistantRuntime;
    const client: RequestClient = { request: vi.fn() };
    const messages: ThreadMessageLike[] = Array.from({ length: 240 }, (_, ordinal) => ({
      id: `entry-${ordinal}`, role: "user", content: [{ type: "text", text: `Message ${ordinal}` }],
      metadata: { custom: { ordinal } },
    }));
    function Harness({ messages, connection }: { messages: ThreadMessageLike[]; connection: "open" | "closed" }) {
      runtime = useExternalStoreRuntime(createThreadAdapter({
        client, path: "/p/history.jsonl", view: undefined, connection, dispatch: () => {}, onError: () => {},
        projection: { messages, isRunning: false, toolDialogs: new Map(), freeStandingDialogs: [] },
      }));
      return <AssistantRuntimeProvider runtime={runtime} />;
    }
    await act(async () => root.render(<Harness messages={messages} connection="open" />));
    const before = runtime.thread.getState().messages;
    await act(async () => root.render(<Harness messages={messages} connection="closed" />));
    // A dropped socket fences sending and takes nothing away: the composer
    // keeps the person's words and the conversion keeps every identity (RP-11).
    expect(runtime.thread.getState().extras).toEqual({ sendDisabled: true });
    expect(runtime.thread.getState().isDisabled).toBe(false);
    expect(runtime.thread.getState().messages).toBe(before);
    await act(async () => root.render(<Harness messages={messages} connection="open" />));
    expect(runtime.thread.getState().extras).toEqual({ sendDisabled: false });
    expect(runtime.thread.getState().messages).toBe(before);
    const changed = [...messages];
    changed[120] = { ...changed[120]!, content: [{ type: "text", text: "Updated content" }] };
    await act(async () => root.render(<Harness messages={changed} connection="open" />));
    const after = runtime.thread.getState().messages;
    expect(after.map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(after.map(message => message.metadata.custom.ordinal)).toEqual(Array.from({ length: 240 }, (_, i) => i));
    expect(after[120]!.content).toEqual([{ type: "text", text: "Updated content" }]);
    expect(after[120]).not.toBe(before[120]);
    for (let i = 0; i < after.length; i++) if (i !== 120) expect(after[i]).toBe(before[i]);
  });
});

const A = `${PROJECT_CWD}/a.jsonl`;
const B = `${PROJECT_CWD}/b.jsonl`;
const C = `${PROJECT_CWD}/.worktrees/child/c.jsonl`;
const onOpen = vi.fn();
const onEdit = () => {};
const mounts: string[] = [];
let aui: ReturnType<typeof useAui>;
let actions: ReturnType<typeof useLaserStable>["actions"];
let archive: ReturnType<typeof useLaserStable>["archive"];
function MessageWitness() {
  const id = useAuiState(state => state.message.id);
  useLayoutEffect(() => { mounts.push(id); }, [id]);
  return <span>{id}</span>;
}
function SidebarItem() { return <ThreadListItem editing={undefined} onEdit={onEdit} onOpen={onOpen} />; }
function ArchivedItem() { return <ThreadListItem editing={undefined} onEdit={onEdit} onOpen={onOpen} archived />; }
function SelectionHarness() {
  aui = useAui();
  ({ actions, archive } = useLaserStable());
  const phase = useLaserState(state => state.destination.phase);
  return <TooltipProvider>
    <output data-phase={phase} />
    <ThreadListPrimitive.Root>
      <ThreadListPrimitive.Items components={{ ThreadListItem: SidebarItem }} />
      <ThreadListPrimitive.Items archived components={{ ThreadListItem: ArchivedItem }} />
    </ThreadListPrimitive.Root>
    <ThreadPrimitive.Messages components={{ UserMessage: MessageWitness, AssistantMessage: MessageWitness }} />
  </TooltipProvider>;
}
const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="aui_thread-list-item-trigger"]')].find(button => button.textContent?.includes(name))!;

async function childOpenItem() {
  const more = row("Conversation C").closest('[data-slot="aui_thread-list-item"]')!.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => { more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); await settle(5); });
  const open = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === "Open")!;
  expect(open).toBeDefined();
  return open;
}

async function mountSelection() {
  const world = createWorld();
  addSession(world, A, PROJECT_CWD, { name: "Conversation A" });
  addSession(world, B, PROJECT_CWD, { name: "Conversation B" });
  const agent = { agentName: "worker", kind: "child" as const, subagentName: "navigation-child", parentPath: A, rootPath: A, runId: "child-run" };
  addSession(world, C, `${PROJECT_CWD}/.worktrees/child`, { name: "Conversation C", agent, parentPath: A });
  world.states[C] = { ...world.states[C]!, agent };
  world.overrides["pi/session/entries"] = (({ path }: { path: string }) => ({ entries: [
    { type: "message", id: path, parentId: null, timestamp: "2026-09-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: path }], timestamp: 0 } },
  ] })) as never;
  FakeHostClient.reset(world);
  seedProject(PROJECT_CWD);
  seedRememberedSessions({ [PROJECT_CWD]: A });
  await act(async () => root.render(<LaserProvider url="ws://test"><SelectionHarness /></LaserProvider>));
  await act(async () => settle(40));
  mounts.length = 0;
  onOpen.mockClear();
  return world;
}

describe("main sidebar accepted selection", () => {
  it("closes the sidebar without refreshing the accepted row", async () => {
    const world = await mountSelection();
    const before = world.calls.length;
    await act(async () => { row("Conversation A").click(); await settle(40); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(world.calls.slice(before).filter(call => ["session/load", "session/goal/get", "session/pending/list", "pi/session/entries"].some(method => call.method === method || call.method === `pi/${method}`))).toEqual([]);
    expect(mounts).toEqual([]);
  });

  it("opens a child through More once, fencing and restoring the outgoing draft", async () => {
    const world = await mountSelection();
    await act(async () => { await actions.openSession(C); await actions.openSession(A); await settle(20); });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    world.overrides["session/load"] = (async ({ path }: { path: string }) => {
      if (path === C) await held;
      return { state: world.states[path], replayFrom: 0, seq: 0 };
    }) as never;
    const quote = { text: "Menu quote", messageId: `entry:${A}` };
    await act(async () => { aui.composer.setText("A's menu draft"); aui.composer.setQuote(quote); });
    mounts.length = 0;
    const open = await childOpenItem();
    await act(async () => { open.click(); await settle(10); });
    expect(container.querySelector("output")?.getAttribute("data-phase")).toBe("resolving");
    expect(row("Conversation A").closest('[data-slot="aui_thread-list-item"]')?.hasAttribute("aria-current")).toBe(false);
    expect(row("Conversation A").hasAttribute("aria-current")).toBe(false);
    expect(row("Conversation C").closest('[data-slot="aui_thread-list-item"]')?.getAttribute("aria-current")).toBe("page");
    // The chosen conversation is on screen while the host is asked: this view
    // still held its transcript, so its rows mount at once — once (RP-11).
    expect(mounts.filter(id => id.includes(C))).toHaveLength(1);
    expect(aui.thread.getState().extras).toEqual({ sendDisabled: true });
    await act(async () => { release(); await settle(40); });
    expect(mounts.filter(id => id.includes(C))).toHaveLength(1);
    expect(aui.thread.getState().extras).toEqual({ sendDisabled: false });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(world.calls.filter(call => call.method === "session/prompt")).toHaveLength(0);
    expect(aui.composer.getState()).toMatchObject({ text: "", quote: undefined });
    await act(async () => { row("Conversation A").click(); await settle(40); });
    expect(aui.composer.getState()).toMatchObject({ text: "A's menu draft", quote });
  });

  it("can switch back to the outgoing runtime while another row resolves", async () => {
    const world = await mountSelection();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    world.overrides["session/load"] = (async ({ path }: { path: string }) => {
      if (path === C) await held;
      return { state: world.states[path], replayFrom: 0, seq: 0 };
    }) as never;
    await act(async () => { row("Conversation C").click(); await settle(10); });
    expect(container.querySelector("output")?.getAttribute("data-phase")).toBe("resolving");
    await act(async () => { row("Conversation A").click(); await settle(40); });
    expect(row("Conversation A").getAttribute("aria-current")).toBe("page");
    await act(async () => { release(); await settle(40); });
    expect(mounts.filter(id => id.includes(C))).toHaveLength(0);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("mounts resident B once, calls onOpen once, and preserves A's composer ownership", async () => {
    const world = await mountSelection();
    // Warm both histories through the existing guarded provider route.
    await act(async () => { await actions.openSession(B); await settle(20); });
    await act(async () => { await actions.openSession(A); await settle(20); });
    const origin = aui.composer;
    const quote = { text: "Exact quoted text", messageId: `entry:${A}` };
    await act(async () => {
      origin.setText("A's exact unsent draft\nsecond line");
      origin.setQuote(quote);
      await origin.addAttachment({ id: "draft-image", type: "image", name: "draft.png", contentType: "image/png", content: [{ type: "image", image: "data:image/png;base64,AQID" }] });
    });
    mounts.length = 0;
    onOpen.mockClear();
    const trigger = row("Conversation B");
    expect(trigger.tagName).toBe("BUTTON");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await act(async () => { trigger.click(); await settle(40); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(mounts.filter(id => id.includes(B))).toHaveLength(1);
    expect(row("Conversation B").getAttribute("aria-current")).toBe("page");
    expect(aui.composer.getState()).toMatchObject({ text: "", attachments: [], quote: undefined });
    await act(async () => { row("Conversation A").click(); await settle(40); });
    expect(aui.composer.getState().text).toBe("A's exact unsent draft\nsecond line");
    expect(aui.composer.getState().quote).toEqual(quote);
    expect(aui.composer.getState().attachments).toMatchObject([{ id: "draft-image", name: "draft.png", content: [{ type: "image", image: "data:image/png;base64,AQID" }] }]);
    mounts.length = 0;
    await act(async () => {
      row("Conversation B").click();
      row("Conversation C").click();
      await settle(40);
    });
    expect(row("Conversation C").getAttribute("aria-current")).toBe("page");
    expect(mounts.filter(id => id.includes(C))).toHaveLength(1);
    expect(mounts.filter(id => id.includes(B))).toHaveLength(0);
    expect(aui.composer.getState()).toMatchObject({ text: "", attachments: [], quote: undefined });
    expect(world.calls.filter(call => call.method === "session/prompt")).toHaveLength(0);
  });

  it("opens an archived child through its existing row without optimistic adoption", async () => {
    await mountSelection();
    await act(async () => { archive.add(C); await settle(20); });
    expect(archive.has(C)).toBe(true);
    expect(row("Conversation C").closest('[data-slot="aui_thread-list-item"]')?.getAttribute("data-child")).toBe("true");
    mounts.length = 0;
    await act(async () => { row("Conversation C").click(); await settle(40); });
    expect(row("Conversation C").getAttribute("aria-current")).toBe("page");
    expect(mounts.filter(id => id.includes(C))).toHaveLength(1);
    // Accepting an archived runtime retains assistant-ui's restore-on-open.
    expect(archive.has(C)).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it.each(["row", "child menu"])("fences a send from the outgoing composer in the same event turn as %s Open", async (route) => {
    const world = await mountSelection();
    const open = route === "row" ? row("Conversation C") : await childOpenItem();
    await act(async () => {
      aui.composer.setText("This draft belongs only to A");
      open.click();
      aui.composer.send();
      await settle(40);
    });
    expect(row("Conversation C").getAttribute("aria-current")).toBe("page");
    expect(world.calls.filter(call => call.method === "session/prompt")).toHaveLength(0);
    expect(aui.composer.getState().text).toBe("");
    await act(async () => { row("Conversation A").click(); await settle(40); });
    expect(aui.composer.getState().text).toBe("This draft belongs only to A");
  });

  it("does not mount a refused destination and accepts one mount when its row retries", async () => {
    const world = await mountSelection();
    world.overrides["session/load"] = (({ path }: { path: string }) => {
      if (path === C) throw new Error("The conversation could not be opened. Try again.");
      return { state: world.states[path], replayFrom: 0, seq: 0 };
    }) as never;
    await act(async () => { row("Conversation C").click(); await settle(40); });
    expect(container.querySelector("output")?.getAttribute("data-phase")).toBe("unavailable");
    expect(mounts.filter(id => id.includes(C))).toHaveLength(0);
    expect(aui.thread.getState().extras).toEqual({ sendDisabled: true });
    delete world.overrides["session/load"];
    await act(async () => { row("Conversation C").click(); await settle(40); });
    expect(row("Conversation C").getAttribute("aria-current")).toBe("page");
    expect(mounts.filter(id => id.includes(C))).toHaveLength(1);
    expect(aui.thread.getState().extras).toEqual({ sendDisabled: false });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
