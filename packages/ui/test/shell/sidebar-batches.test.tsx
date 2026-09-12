// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAui } from "@assistant-ui/react";
vi.mock("../../src/client.js", async original => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));
import { ThreadList } from "../../src/components/assistant-ui/elements/thread-list.aui.js";
import { sessionFolds } from "../../src/components/assistant-ui/elements/session-folds.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

let aui: ReturnType<typeof useAui>;
let stable: ReturnType<typeof useLaserStable>;
function Probe() { aui = useAui(); stable = useLaserStable(); return null; }
let container: HTMLDivElement, root: Root, world: World;
const path = (n: number) => `${PROJECT_CWD}/history-${n}.jsonl`;
const row = (name: string) => [...container.querySelectorAll<HTMLElement>('[data-slot="aui_thread-list-item"]')].find(el => el.textContent?.includes(name));
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === name)!;
const render = async (query = "", tab: "code" | "chat" = "code") => {
  await act(async () => root.render(<LaserProvider url="ws://test"><TooltipProvider><Probe /><ThreadList projects={[PROJECT_CWD]} query={query} tab={tab} /></TooltipProvider></LaserProvider>));
  await act(async () => settle(60));
};
const item = (remote: string) => aui.threads.item({ id: aui.threads.getState().threadItems.find(item => item.remoteId === remote)!.id });
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionsList.reset(); sessionFolds.reset();
  world = createWorld();
  for (let n = 1; n <= 8; n++) {
    addSession(world, path(n), PROJECT_CWD);
    const session = world.sessions.find(session => session.path === path(n))!;
    Object.assign(session, { name: `Conversation ${n}`, attention: "idle", modifiedAt: `2026-09-08T00:00:0${8 - n}Z` });
  }
  FakeHostClient.reset(world);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("fetches the next host page on Load more and keeps focus across the delayed reply", async () => {
  let deliver!: (value: unknown) => void;
  const calls: Array<{ page?: { cursor?: string } }> = [];
  world.overrides["pi/session/list"] = ((params: { page?: { cursor?: string } }) => {
    calls.push(params);
    if (params.page?.cursor) return new Promise(resolve => { deliver = resolve; });
    return { sessions: world.sessions.slice(0, 7), groups: [{ cwd: PROJECT_CWD, total: 8, cursor: "older" }] };
  }) as never;
  await render();
  expect(row("Conversation 8")).toBeUndefined();
  const more = button("Load more"); more.focus();
  await act(async () => more.click());
  expect(calls.filter(call => call.page?.cursor === "older")).toHaveLength(1);
  expect(row("Conversation 8")).toBeUndefined();
  expect(button("Loading chats…").getAttribute("aria-disabled")).toBe("true");
  await act(async () => { deliver({ sessions: [world.sessions[7]!], groups: [{ cwd: PROJECT_CWD, total: 8 }] }); await settle(60); });
  expect(row("Conversation 8")).toBeDefined();
  expect(document.activeElement).toBe(button("Show fewer"));
  await act(async () => button("Show fewer").click());
  expect(row("Conversation 8")).toBeUndefined();
});

it("keeps Chat pagination focused through its final page and Show fewer", async () => {
  const cwd = "/state/chat";
  const chats = Array.from({ length: 8 }, (_, index) => ({ ...world.sessions[index]!, cwd, path: `${cwd}/${index}.jsonl`, name: `Chat ${index}`, agent: { kind: "chat" as const, agentName: "chat" } }));
  let deliver!: (value: unknown) => void;
  world.overrides["pi/session/list"] = ((params: { page?: { cursor?: string } }) => params.page?.cursor
    ? new Promise(resolve => { deliver = resolve; })
    : { sessions: chats.slice(0, 7), groups: [{ cwd, total: 8, cursor: "older-chat" }] }) as never;
  await render("", "chat");
  expect(row("Chat 7")).toBeUndefined();
  const more = button("Load more"); more.focus();
  await act(async () => more.click());
  expect(button("Loading chats…").getAttribute("aria-disabled")).toBe("true");
  await act(async () => { deliver({ sessions: [chats[7]!], groups: [{ cwd, total: 8 }] }); await settle(60); });
  expect(row("Chat 7")).toBeDefined();
  expect(document.activeElement).toBe(button("Show fewer"));
  await act(async () => button("Show fewer").click());
  expect(row("Chat 7")).toBeUndefined();
  expect(document.activeElement).toBe(button("Load more"));
});

it("shows seven, expands in place, retains focus and remembers the batch across remounts without persistence", async () => {
  await render();
  expect(container.querySelectorAll('[data-slot="aui_thread-list-item"]')).toHaveLength(7);
  expect(row("Conversation 8")).toBeUndefined();
  const more = button("Load more");
  expect(more.getAttribute("aria-expanded")).toBe("false");
  more.focus(); expect(document.activeElement).toBe(more);
  await act(async () => more.click());
  expect(row("Conversation 8")).toBeDefined();
  expect(button("Show fewer").getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(button("Show fewer"));
  expect(sessionsList.get().revealed.get(PROJECT_CWD)).toBe(14);
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(row("Conversation 8")).toBeDefined();
  await act(async () => button("Show fewer").click());
  expect(row("Conversation 8")).toBeUndefined();
  expect([...Array(localStorage.length)].map((_, n) => localStorage.getItem(localStorage.key(n)!)).join()).not.toContain("revealed");
});

it("reveals the selected old row and never changes the selected session when folding", async () => {
  await render();
  await act(async () => stable.actions.openSession(path(8)));
  await act(async () => settle(60));
  expect(row("Conversation 8")).toBeDefined();
  const selected = aui.threads.getState().mainThreadId;
  await act(async () => sessionsList.reveal(PROJECT_CWD, 14));
  await act(async () => button("Show fewer").click());
  expect(aui.threads.getState().mainThreadId).toBe(selected);
  expect(row("Conversation 8")).toBeDefined();
});

it("surfaces an old row as soon as it needs attention, and does not fold search results", async () => {
  await render(); expect(row("Conversation 8")).toBeUndefined();
  await act(async () => FakeHostClient.current.notify("pi/session/attention", { path: path(8), cwd: PROJECT_CWD, attention: "waiting_for_input", at: "2026-09-08T01:00:00Z" }));
  expect(row("Conversation 8")).toBeDefined();
  await render("Conversation");
  expect(container.querySelectorAll('[data-slot="aui_thread-list-item"]')).toHaveLength(8);
  expect(button("Load more")).toBeUndefined();
});

it("keeps a newly created empty session first while older chats are used, then returns it to recency after its first send", async () => {
  await render();
  let fresh = "";
  await act(async () => { fresh = await stable.actions.newSession(PROJECT_CWD); });
  Object.assign(world.sessions.find(session => session.path === fresh)!, { name: "Fresh draft", modifiedAt: "2026-09-08T01:00:00Z" });
  await act(async () => stable.actions.refreshSessions());
  await act(async () => settle(30));
  const names = () => [...container.querySelectorAll('[data-slot="aui_thread-list-item"]')].map(el => el.textContent);
  expect(names()[0]).toContain("Fresh draft");
  let minute = 2;
  world.overrides["session/prompt"] = ((params: { path: string }) => {
    world.sessions = world.sessions.map(session => session.path === params.path ? { ...session, messageCount: 1, modifiedAt: `2026-09-08T01:0${minute++}:00Z` } : session);
    return { accepted: true };
  }) as never;
  const send = async (target: string) => {
    await act(async () => stable.actions.openSession(target));
    await act(async () => stable.actions.send([{ type: "text", text: "Continue" }], "prompt"));
    await act(async () => stable.actions.refreshSessions());
    await act(async () => settle(30));
  };
  await send(path(8));
  expect(names()[0]).toContain("Fresh draft");
  await send(fresh);
  expect(item(fresh).getState().custom?.["empty"]).toBe(false);
  await send(path(8));
  expect(names()[0]).toContain("Conversation 8");
  expect(names()[1]).toContain("Fresh draft");
});

it("never hides an empty root even when more than seven sessions are empty", async () => {
  world.sessions = world.sessions.map(session => ({ ...session, messageCount: 0 }));
  await render();
  expect(container.querySelectorAll('[data-slot="aui_thread-list-item"]')).toHaveLength(8);
  expect(button("Load more")).toBeUndefined();
});

it("reveals successive batches of seven without losing the remaining rows", async () => {
  for (let n = 9; n <= 16; n++) {
    addSession(world, path(n), PROJECT_CWD, { name: `Conversation ${n}`, attention: "idle", modifiedAt: `2026-09-07T00:00:${String(60 - n).padStart(2, "0")}Z` });
  }
  await render();
  const count = () => container.querySelectorAll('[data-slot="aui_thread-list-item"]').length;
  expect(count()).toBe(7);
  await act(async () => button("Load more").click()); expect(count()).toBe(14);
  expect(button("Load more").getAttribute("aria-expanded")).toBe("true");
  await act(async () => button("Load more").click()); expect(count()).toBe(16);
  await act(async () => button("Show fewer").click()); expect(count()).toBe(7);
});

it("keeps an older working root and a quiet root with a child's question outside the fold", async () => {
  Object.assign(world.sessions.find(session => session.path === path(8))!, { attention: "working" });
  const old = path(9), child = `${PROJECT_CWD}/asking.jsonl`;
  addSession(world, old, PROJECT_CWD, { name: "Older parent", attention: "idle", modifiedAt: "2026-09-01T00:00:00Z" });
  addSession(world, child, PROJECT_CWD, { name: "Asking child", attention: "waiting_for_input", agent: { kind: "child", agentName: "default", parentPath: old } });
  await render();
  expect(row("Conversation 8")).toBeDefined();
  expect(row("Older parent")).toBeDefined();
  expect(row("Asking child")).toBeDefined();
});

it.each(["archived", "deleted", "search"] as const)("places a child with a %s parent among ordinary project rows", async (reason) => {
  const child = `${PROJECT_CWD}/child.jsonl`;
  addSession(world, child, PROJECT_CWD);
  Object.assign(world.sessions.find(session => session.path === child)!, {
    name: "Conversation child", attention: "idle", modifiedAt: "2026-09-08T00:00:06.500Z",
    agent: { kind: "child", agentName: "default", subagentName: "explorer", parentPath: path(1) },
  });
  if (reason === "deleted") world.sessions = world.sessions.filter(session => session.path !== path(1));
  if (reason === "search") world.sessions.find(session => session.path === path(1))!.name = "Parent objective";
  await render();
  if (reason === "archived") {
    // A persisted archive from before tree-wide archiving can contain only the parent.
    await act(async () => { stable.archive.add(path(1)); await aui.threads.reload(); });
    await act(async () => settle(60));
  }
  if (reason === "search") await render("Conversation");
  const visible = () => [...container.querySelectorAll<HTMLElement>('[data-slot="aui_thread-list-item"]')];
  expect(visible()[0]?.textContent).toContain("Conversation child");
  expect(visible()[1]?.textContent).toBe("Conversation 2");
  expect(visible().filter(el => el.textContent?.includes("Conversation child"))).toHaveLength(1);
  expect(row("Conversation child")?.closest("section")?.getAttribute("data-cwd")).toBe(PROJECT_CWD);
  expect(row("Conversation child")?.querySelector('[data-slot="subagent-name"]')?.textContent).toBe("explorer");
  expect(visible()).toHaveLength(reason === "search" ? 8 : 7);
  if (reason !== "search") {
    await act(async () => button("Load more").click());
    expect(visible()).toHaveLength(8);
    expect(row("Conversation 8")).toBeDefined();
  }
});

it("the archive action moves a parent and its descendants into a folded archived tree and unarchive restores them", async () => {
  const child = `${PROJECT_CWD}/child.jsonl`, grandchild = `${PROJECT_CWD}/grandchild.jsonl`;
  for (const [childPath, parentPath, name] of [[child, path(1), "Child agent"], [grandchild, child, "Grandchild agent"]]) {
    addSession(world, childPath!, PROJECT_CWD);
    Object.assign(world.sessions.find(session => session.path === childPath)!, { name, agent: { kind: "child", agentName: "default", parentPath } });
  }
  await render();
  await act(async () => item(path(1)).archive());
  await act(async () => settle(80));
  expect(aui.threads.getState().archivedThreadIds).toHaveLength(3);
  const archived = container.querySelector<HTMLElement>('section[aria-label="Archived sessions"]')!;
  await act(async () => archived.querySelector("button")!.click());
  expect(archived.querySelectorAll('[data-slot="aui_thread-list-item"]')).toHaveLength(1);
  const fold = archived.querySelector<HTMLButtonElement>('[data-slot="session-fold"]')!;
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  await act(async () => fold.click());
  expect(archived.textContent).toContain("Child agent");
  expect(archived.textContent).not.toContain("Grandchild agent");
  await act(async () => item(path(1)).unarchive());
  await act(async () => settle(80));
  expect(aui.threads.getState().archivedThreadIds).toHaveLength(0);
  expect(stable.archive.has(child)).toBe(false); expect(stable.archive.has(grandchild)).toBe(false);
  await act(async () => item(child).archive());
  await act(async () => settle(80));
  expect(stable.archive.has(path(1))).toBe(false);
  expect(aui.threads.getState().archivedThreadIds).toHaveLength(2);
});
