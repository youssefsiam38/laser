// @vitest-environment happy-dom
/**
 * M16-T95 / D-334: main-window New Session is the existing project/Chat
 * landing on the next render. Worker start, reuse and session/new run in the
 * background; first Send joins that same in-flight allocation.
 */
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAui, useAuiState, type Aui } from "@assistant-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, SessionState } from "@lasercode/protocol";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../world/fake-host.js")).FakeHostClient,
}));

import {
  LaserProvider,
  useLaserStable,
  useLaserState,
  useLaserView,
  type LaserActions,
} from "../../src/runtime/LaserProvider.js";
import { chatSendWait } from "../../src/runtime/adapter.js";
import { isMainReady, mainError, mainTab } from "../../src/runtime/main-destination.js";
import { StatusLine } from "../../src/components/thread/StatusLine.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../world/fake-host.js";
import { agentInfo, sessionState, summary } from "../agents/fixtures.js";
import { seedProject } from "../../test/runtime/environment-fixture.js";

const CODE = `${PROJECT_CWD}/code.jsonl`;
const OTHER = `${PROJECT_CWD}/other.jsonl`;
const CHAT = "/state/chat/yesterday.jsonl";

type Controls = {
  actions: LaserActions;
  aui: Aui;
  tab: "chat" | "code";
  path: string | undefined;
  phase: string;
  error: string | undefined;
  sendBlocked: boolean;
  canSend: boolean;
  sendPending: boolean;
  composerPath: string | undefined;
  text: string;
};
let controls: Controls;

function Probe() {
  const { actions } = useLaserStable();
  const destination = useLaserState((state) => state.destination);
  const view = useLaserView();
  const aui = useAui();
  const sendBlocked = useAuiState((state) =>
    state.thread.isDisabled || (state.thread.extras as { sendDisabled?: boolean } | undefined)?.sendDisabled === true);
  const canSend = useAuiState((state) => state.composer.canSend);
  const sendPending = useSyncExternalStore(chatSendWait.subscribe, chatSendWait.getSnapshot, chatSendWait.getSnapshot);
  const composerPath = useAuiState((state) => state.threadListItem.externalId ?? state.threadListItem.remoteId);
  const text = useAuiState((state) => state.composer.text);
  controls = {
    actions,
    aui,
    tab: mainTab(destination),
    path: view?.path,
    phase: isMainReady(destination) ? "ready" : destination.phase,
    error: mainError(destination),
    sendBlocked,
    canSend,
    sendPending,
    composerPath,
    text,
  };
  return <output data-phase={controls.phase} data-path={view?.path ?? ""} />;
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
  addSession(world, CODE, PROJECT_CWD, { firstMessage: "existing history" });
  seedProject(PROJECT_CWD);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.history.replaceState(null, "", "/");
});

async function mount(): Promise<void> {
  await act(async () => root.render(
    <LaserProvider url="ws://test">
      <Probe />
      <StatusLine />
    </LaserProvider>,
  ));
  await act(async () => settle(40));
}

const calls = (method: string) => world.calls.filter((call) => call.method === method);
const statusWords = () => container.querySelector('[role="status"]')?.textContent?.trim() ?? "";

function persistPrompts(): Record<string, ContentBlock[][]> {
  const history: Record<string, ContentBlock[][]> = {};
  world.overrides["session/prompt"] = ((params: { path: string; content: ContentBlock[] }) => {
    (history[params.path] ??= []).push(params.content);
    const state = world.states[params.path];
    if (state) world.states[params.path] = { ...state, messageCount: state.messageCount + 1 };
    return { accepted: true };
  }) as never;
  return history;
}

function createdState(params: { cwd: string; agentName?: string; sessionKind?: string }, path = `${params.cwd}/fresh.jsonl`): SessionState {
  // As the worker records it: a Chat by its kind and no definition, anything
  // else by the agent it runs (`docs/plain-chat.md`).
  const agent = params.sessionKind === "chat"
    ? agentInfo({ kind: "chat" })
    : params.agentName ? agentInfo({ kind: "root", agentName: params.agentName }) : undefined;
  const state = sessionState({ path, cwd: params.cwd, messageCount: 0, ...(agent ? { agent } : {}) });
  world.states[path] = state;
  world.sessions.push(summary({ path, cwd: params.cwd, messageCount: 0, ...(agent ? { agent } : {}) }));
  return state;
}

function holdSessionNew(): { release: () => void; fail: (error: Error) => void } {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const held = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  world.overrides["session/new"] = (async (params: { cwd: string; agentName?: string }) => {
    await held;
    return { state: createdState(params) };
  }) as never;
  return { release, fail };
}

async function typeDraft(text: string): Promise<void> {
  await act(async () => {
    controls.aui.composer.setText(text);
    await settle(0);
  });
}

async function send(text: string): Promise<void> {
  await act(async () => {
    controls.aui.composer.setText(text);
    controls.aui.composer.send();
    await settle(30);
  });
}

describe("New Session is immediately usable", () => {
  it("shows an enabled blank composer on the next render while session/new is held", async () => {
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: CODE, phase: "ready" });
    const held = holdSessionNew();
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(PROJECT_CWD);
      await settle(20);
    });
    expect(controls).toMatchObject({ tab: "code", path: undefined, phase: "ready", sendBlocked: false, error: undefined });
    expect(statusWords()).not.toMatch(/preparing the workspace|loading the conversation|opening the conversation/i);
    expect(container.textContent).not.toContain("Preparing workspace");
    expect(container.textContent).not.toContain("Opening conversation");
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/load").some((call) => (call.params as { path?: string }).path !== CODE)).toBe(false);

    await typeDraft("typed while the worker starts");
    expect(controls.text).toBe("typed while the worker starts");
    expect(controls.sendBlocked).toBe(false);
    expect(controls.canSend).toBe(true);

    held.release();
    await act(async () => { await creation; await settle(40); });
    expect(controls.text).toBe("typed while the worker starts");
    expect(calls("session/load").filter((call) => (call.params as { path?: string }).path !== CODE)).toHaveLength(0);
  });

  it("delivers one prompt on Send before preparation settles, without a second allocation or session/load", async () => {
    await mount();
    persistPrompts();
    const held = holdSessionNew();
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(PROJECT_CWD);
      await settle(20);
    });
    expect(calls("session/new")).toHaveLength(1);

    await send("first message");
    expect(calls("session/prompt")).toHaveLength(0);
    expect(calls("session/new")).toHaveLength(1);

    held.release();
    await act(async () => { await creation; await settle(40); });
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(1);
    expect((calls("session/prompt")[0]!.params as { content: ContentBlock[] }).content)
      .toEqual([{ type: "text", text: "first message" }]);
    expect(calls("session/load").filter((call) => (call.params as { path?: string }).path !== CODE)).toHaveLength(0);
    expect(controls.path).toBe(`${PROJECT_CWD}/fresh.jsonl`);
    expect(controls.phase).toBe("ready");
  });

  it("keeps the landing and draft when session/new fails, and Send retries", async () => {
    await mount();
    persistPrompts();
    const held = holdSessionNew();
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(PROJECT_CWD);
      await settle(20);
    });
    await typeDraft("retry this");
    await act(async () => {
      held.fail(new Error("The worker could not start. Retry or choose another project."));
      await creation.catch(() => {});
      await settle(30);
    });
    expect(controls).toMatchObject({ phase: "ready", path: undefined, error: undefined, sendBlocked: false, text: "retry this" });
    expect(container.textContent).not.toContain("Couldn’t open this view.");
    expect(statusWords()).not.toMatch(/preparing the workspace|loading the conversation/i);

    delete world.overrides["session/new"];
    await send("retry this");
    await act(async () => settle(40));
    expect(calls("session/new").length).toBeGreaterThanOrEqual(2);
    expect(calls("session/prompt")).toHaveLength(1);
    expect(controls.phase).toBe("ready");
    expect(controls.path).toBeDefined();
  });

  it("does not steal the destination or focus after the person navigates away", async () => {
    addSession(world, OTHER, PROJECT_CWD, { firstMessage: "the other conversation" });
    await mount();
    const held = holdSessionNew();
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(PROJECT_CWD);
      await settle(20);
    });
    await typeDraft("left behind");
    await act(async () => {
      await controls.actions.openSession(OTHER);
      await settle(20);
    });
    expect(controls.path).toBe(OTHER);
    held.release();
    await act(async () => { await creation; await settle(40); });
    expect(controls.path).toBe(OTHER);
    expect(controls.phase).toBe("ready");
    expect(controls.text).not.toBe("left behind");
  });

  it("opens Chat New on the Chat landing without waiting, then binds the Chat agent", async () => {
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }), firstMessage: "yesterday" });
    await mount();
    persistPrompts();
    const held = holdSessionNew();
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(world.snapshot.workspaces.chat!, { sessionKind: "chat" });
      await settle(20);
    });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "ready", sendBlocked: false });
    expect(statusWords()).not.toMatch(/opening the conversation|preparing the workspace|loading the conversation/i);
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/new")[0]!.params).toMatchObject({ cwd: "/state/chat", sessionKind: "chat" });

    await send("hi from chat");
    held.release();
    await act(async () => { await creation; await settle(40); });
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(1);
    expect(calls("session/load").filter((call) => {
      const path = (call.params as { path?: string }).path;
      return path !== CODE && path !== CHAT;
    })).toHaveLength(0);
    expect(controls).toMatchObject({ tab: "chat", phase: "ready" });
    expect(controls.path).toBe("/state/chat/fresh.jsonl");
  });

  it("binds a chosen agent on the one session New creates, without a second default empty session", async () => {
    await mount();
    persistPrompts();
    const held = holdSessionNew();
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(PROJECT_CWD, { agentName: "reviewer" });
      await settle(20);
    });
    expect(controls).toMatchObject({ tab: "code", path: undefined, phase: "ready", sendBlocked: false });
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/new")[0]!.params).toMatchObject({ cwd: PROJECT_CWD, agentName: "reviewer" });

    await send("review this");
    held.release();
    await act(async () => { await creation; await settle(40); });
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/new").some((call) => (call.params as { agentName?: string }).agentName === undefined)).toBe(false);
    expect(calls("session/prompt")).toHaveLength(1);
    expect(world.sessions.filter((session) => session.messageCount === 0 && session.path !== CODE)).toHaveLength(1);
  });

  it("reuses the current empty session and its draft instead of replacing it (D-127)", async () => {
    await mount();
    const empty = createdState({ cwd: PROJECT_CWD }, `${PROJECT_CWD}/empty.jsonl`);
    world.states[empty.path] = { ...empty, model: { provider: "stub", id: "kept-model" } };
    await act(async () => {
      await controls.actions.openSession(empty.path);
      await settle(30);
    });
    await typeDraft("keep this composition");
    world.calls.length = 0;
    await act(async () => {
      const reused = await controls.actions.newSession(PROJECT_CWD);
      expect(reused).toBe(empty.path);
      await settle(20);
    });
    expect(calls("session/new")).toHaveLength(0);
    expect(controls.path).toBe(empty.path);
    expect(controls.text).toBe("keep this composition");
  });

  it("reuses a current empty default-agent session when New omits agentName (D-127)", async () => {
    await mount();
    const empty = createdState({ cwd: PROJECT_CWD, agentName: "default" }, `${PROJECT_CWD}/empty.jsonl`);
    await act(async () => {
      await controls.actions.openSession(empty.path);
      await settle(30);
    });
    await typeDraft("keep the default draft");
    world.calls.length = 0;
    await act(async () => {
      const reused = await controls.actions.newSession(PROJECT_CWD);
      expect(reused).toBe(empty.path);
      await settle(20);
    });
    expect(calls("session/new")).toHaveLength(0);
    expect(controls.path).toBe(empty.path);
    expect(controls.phase).toBe("ready");
    expect(controls.text).toBe("keep the default draft");
  });

  it("Send on a reused empty session delivers one prompt without allocating another", async () => {
    await mount();
    persistPrompts();
    const empty = createdState({ cwd: PROJECT_CWD, agentName: "default" }, `${PROJECT_CWD}/empty.jsonl`);
    await act(async () => {
      await controls.actions.openSession(empty.path);
      await settle(30);
    });
    world.calls.length = 0;
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(PROJECT_CWD);
      await settle(20);
    });
    expect(calls("session/new")).toHaveLength(0);
    await send("first message");
    await act(async () => { await creation; await settle(40); });
    expect(calls("session/new")).toHaveLength(0);
    expect(calls("session/prompt")).toHaveLength(1);
    expect(controls.path).toBe(empty.path);
  });

  it("does not resurrect an adopted landing draft on the next New Session", async () => {
    await mount();
    const held = holdSessionNew();
    let creation!: Promise<string>;
    await act(async () => {
      creation = controls.actions.newSession(PROJECT_CWD);
      await settle(20);
    });
    await typeDraft("typed while the worker starts");
    held.release();
    await act(async () => { await creation; await settle(40); });
    expect(controls.text).toBe("typed while the worker starts");
    world.calls.length = 0;
    const next = holdSessionNew();
    await act(async () => {
      void controls.actions.newSession(PROJECT_CWD, { agentName: "reviewer" });
      await settle(20);
    });
    expect(controls.path).toBeUndefined();
    expect(controls.phase).toBe("ready");
    expect(controls.text).not.toBe("typed while the worker starts");
    await act(async () => { next.release(); await settle(20); });
  });
});
