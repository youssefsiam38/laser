// @vitest-environment happy-dom
/**
 * The Chat tab's "+" opens the conversation it creates. The controller's
 * late-workspace effect (a `chat-tab` destination re-resolved once the Chat
 * workspace is known) must not race a new session by re-opening the previous
 * chat under it: 0.3.9 created the session, listed it, and stayed put.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { LaserProvider, useLaserStable, useLaserState, useLaserView, type LaserActions } from "../../src/runtime/LaserProvider.js";
import { isMainReady, mainTab } from "../../src/runtime/main-destination.js";
import { SESSION_TAB_MEMORY_KEY, SESSIONS_TAB_STORAGE_KEY } from "../../src/runtime/session-tab-memory.js";
import { addSession, createWorld, FakeHostClient, settle, type World } from "../beam/fake-host.js";

const CHAT = "/state/chat/yesterday.jsonl";

let probe: { actions: LaserActions; tab: string; path: string | undefined; phase: string };
function Probe() {
  const { actions } = useLaserStable();
  const destination = useLaserState((state) => state.destination);
  const view = useLaserView();
  probe = { actions, tab: mainTab(destination), path: view?.path, phase: isMainReady(destination) ? "ready" : destination.phase };
  return null;
}

let root: Root;
let container: HTMLDivElement;
let world: World;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  globalThis.history.replaceState(null, "", "/");
  world = createWorld();
  FakeHostClient.reset(world);
  addSession(world, CHAT, world.snapshot.workspaces.chat!, { agent: { agentName: "chat", kind: "chat" }, firstMessage: "yesterday" });
  world.overrides["session/new"] = ((params: { cwd: string; agentName?: string }) => {
    const path = `${params.cwd}/fresh.jsonl`;
    const state = { ...world.states[CHAT]!, path, id: path, cwd: params.cwd, messageCount: 0, agent: { agentName: "chat", kind: "chat" as const } };
    world.states[path] = state;
    world.sessions.push({ ...world.sessions[0]!, path, messageCount: 0, agent: { agentName: "chat", kind: "chat" } });
    return { state };
  }) as never;
  localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
  localStorage.setItem(SESSION_TAB_MEMORY_KEY, JSON.stringify({ chat: CHAT }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(): Promise<void> {
  await act(async () => root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>));
  await act(async () => settle(40));
}

describe("the Chat tab's + button", () => {
  it("opens the conversation it just created instead of staying on the previous chat", async () => {
    await mount();
    expect(probe).toMatchObject({ tab: "chat", path: CHAT, phase: "ready" });

    await act(async () => {
      await probe.actions.newSession(world.snapshot.workspaces.chat!, { agentName: "chat" });
      await settle(40);
    });

    const created = world.calls.filter((call) => call.method === "session/new");
    expect(created).toHaveLength(1);
    expect(probe).toMatchObject({ tab: "chat", path: `${world.snapshot.workspaces.chat}/fresh.jsonl`, phase: "ready" });
  });

  it("still opens a Chat whose workspace the host reports only after the sessions loaded", async () => {
    // A cold start with nothing remembered and no chat yet: the tab can only
    // create one, and the host has not yet said where Chat lives because the
    // agents snapshot is still on its way. The late-workspace effect exists
    // for exactly this intent, so it must fire for it.
    localStorage.removeItem(SESSION_TAB_MEMORY_KEY);
    world.sessions.length = 0;
    const chatCwd = world.snapshot.workspaces.chat!;
    let deliverSnapshot!: () => void;
    const late = new Promise<typeof world.snapshot>((resolve) => { deliverSnapshot = () => resolve(world.snapshot); });
    world.overrides["agents/list"] = (() => late) as never;
    await mount();
    expect(probe.tab).toBe("chat");
    expect(probe.phase).toBe("resolving");
    expect(world.calls.filter((call) => call.method === "session/new")).toHaveLength(0);

    await act(async () => {
      deliverSnapshot();
      await settle(40);
    });

    expect(world.calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    expect(probe).toMatchObject({ tab: "chat", path: `${chatCwd}/fresh.jsonl`, phase: "ready" });
  });
});
