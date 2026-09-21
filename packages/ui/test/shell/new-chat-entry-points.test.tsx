// @vitest-environment happy-dom
/**
 * The three ways into a plain Chat (`docs/plain-chat.md`, "Chat"): the
 * sidebar `+` on the Chat tab, `New chat` in the command palette, and the
 * keyboard shortcut. Every one of them starts an *empty* Chat — one
 * `session/new` for the Chat workspace, carrying the Chat kind and no agent
 * name, because a Chat session runs no definition at all.
 *
 * The real shell, the real provider and the real destination controller, over
 * the in-memory host: what is asserted is the request that reaches the host
 * and the window that comes back, not which component called what.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../world/fake-host.js")).FakeHostClient,
}));

import { LaserProvider } from "../../src/runtime/LaserProvider.js";
import { Shell } from "../../src/components/shell/Shell.js";
import { SESSIONS_TAB_STORAGE_KEY } from "../../src/runtime/session-tab-memory.js";
import { addSession, CHAT_CWD, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../world/fake-host.js";
import { seedProject } from "../runtime/environment-fixture.js";

let root: Root;
let container: HTMLDivElement;
let world: World;

const news = () => world.calls.filter((call) => call.method === "session/new");
const query = <T extends Element = HTMLElement>(selector: string): T | null =>
  container.querySelector<T>(selector) ?? document.body.querySelector<T>(selector);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  globalThis.history.replaceState(null, "", "/");
  world = createWorld();
  FakeHostClient.reset(world);
  addSession(world, `${PROJECT_CWD}/code.jsonl`, PROJECT_CWD, { firstMessage: "yesterday's work" });
  seedProject(PROJECT_CWD);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove());
  globalThis.history.replaceState(null, "", "/");
});

async function mount(tab: "chat" | "code" = "code"): Promise<void> {
  localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, tab);
  await act(async () => root.render(<LaserProvider url="ws://test"><Shell /></LaserProvider>));
  await act(async () => settle(60));
}

/** What the host was asked for, as a Chat request and nothing else. */
function expectOneEmptyChatRequest(): void {
  expect(news()).toHaveLength(1);
  const params = news()[0]!.params as { cwd: string; sessionKind?: string; agentName?: string };
  expect(params.cwd).toBe(CHAT_CWD);
  expect(params.sessionKind).toBe("chat");
  // There is no Chat agent to name any more (D-347), and the protocol refuses
  // the two together.
  expect(params.agentName).toBeUndefined();
  const created = world.sessions.find((session) => session.path.startsWith(`${CHAT_CWD}/session-`))!;
  expect(created.messageCount).toBe(0);
  expect(created.agent?.sessionKind).toBe("chat");
  expect(created.agent?.agentName).toBeUndefined();
}

describe("the three entry points into a plain Chat", () => {
  it("starts an empty Chat from the sidebar + on the Chat tab", async () => {
    await mount("chat");
    const plus = query<HTMLButtonElement>('[data-slot="new-chat"]')!;
    expect(plus).not.toBeNull();
    await act(async () => { plus.click(); await settle(60); });
    expectOneEmptyChatRequest();
  });

  it("starts an empty Chat from the command palette, from the Code tab", async () => {
    await mount("code");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      await settle(20);
    });
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"], [cmdk-item]')]
      .find((item) => item.textContent?.includes("New chat"))!;
    expect(row).toBeDefined();
    await act(async () => { row.click(); await settle(60); });
    expectOneEmptyChatRequest();
  });

  it("starts an empty Chat from the keyboard shortcut, from the Code tab", async () => {
    await mount("code");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "N", metaKey: true, shiftKey: true, bubbles: true }));
      await settle(60);
    });
    expectOneEmptyChatRequest();
    // Plain Cmd+N is still "new session in this project": the two are distinct
    // entry points, and the Chat one never takes the project's.
    const before = news().length;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true }));
      await settle(60);
    });
    const added = news().slice(before);
    expect(added.every((call) => (call.params as { cwd: string }).cwd !== CHAT_CWD)).toBe(true);
  });

  it("opens the new chat with the composer focused and no assistant named anywhere", async () => {
    await mount("chat");
    await act(async () => { query<HTMLButtonElement>('[data-slot="new-chat"]')!.click(); await settle(80); });
    expectOneEmptyChatRequest();

    const composer = query<HTMLTextAreaElement>('[data-slot="composer"] textarea')!;
    expect(composer).not.toBeNull();
    expect(document.activeElement).toBe(composer);
    // No hint that names an assistant: the top bar's agent chip is what would
    // carry one, and a Chat session has no definition to put in it.
    expect(query('[data-slot="session-agent-identity"]')).toBeNull();
    expect(container.textContent).not.toContain("Beam");
  });
});
