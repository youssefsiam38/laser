// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAui, useAuiState, type Aui } from "@assistant-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "@lasercode/protocol";

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
import { isMainReady, mainTab } from "../../src/runtime/main-destination.js";
import { SESSIONS_TAB_STORAGE_KEY } from "../../src/runtime/session-tab-memory.js";
import { agentInfo } from "../agents/fixtures.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../world/fake-host.js";
import { DEVICE_KEYS } from "../../src/runtime/device-storage.js";
import { readDeviceValue, seedDeviceValue, seedProject, seedRememberedSessions } from "../../test/runtime/environment-fixture.js";

const CODE = `${PROJECT_CWD}/code.jsonl`;
const CHAT = "/state/chat/chat.jsonl";
const LEGACY_CHAT = "/state/chat/legacy-beam.jsonl";
const CHAT_FORK = "/state/chat/chat-fork.jsonl";
const CHILD = `${PROJECT_CWD}/.worktrees/child/child.jsonl`;
const CHILD_FORK = `${PROJECT_CWD}/.worktrees/child/child-fork.jsonl`;

type Controls = {
  actions: LaserActions;
  aui: Aui;
  tab: "chat" | "code";
  path: string | undefined;
  phase: string;
  /** The runtime refuses to send: a fence, not a composer taken away (RP-11). */
  sendBlocked: boolean;
  sendPending: boolean;
  canSend: boolean;
  composerPath: string | undefined;
  text: string;
  attachments: number;
  codeProject: string | undefined;
  chatPath: string | undefined;
  dialogs: number;
  toasts: string[];
};
let controls: Controls;

function Probe() {
  const { actions, currentProject, chatPath } = useLaserStable();
  const destination = useLaserState((state) => state.destination);
  const toasts = useLaserState((state) => state.toasts.map((toast) => toast.text));
  const view = useLaserView();
  const aui = useAui();
  const sendBlocked = useAuiState((state) =>
    state.thread.isDisabled || (state.thread.extras as { sendDisabled?: boolean } | undefined)?.sendDisabled === true);
  const canSend = useAuiState((state) => state.composer.canSend);
  const sendPending = useSyncExternalStore(chatSendWait.subscribe, chatSendWait.getSnapshot, chatSendWait.getSnapshot);
  const composerPath = useAuiState((state) => state.threadListItem.externalId ?? state.threadListItem.remoteId);
  const text = useAuiState((state) => state.composer.text);
  const attachments = useAuiState((state) => state.composer.attachments.length);
  const tab = mainTab(destination);
  const phase = isMainReady(destination) ? "ready" : destination.phase;
  controls = { actions, aui, tab, path: view?.path, phase, sendBlocked, sendPending, canSend, composerPath, text, attachments, codeProject: currentProject, chatPath, dialogs: view?.dialogs.length ?? 0, toasts };
  return <output data-tab={tab} data-path={view?.path ?? ""} data-phase={phase} data-send-blocked={sendBlocked} />;
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
  await act(async () => root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>));
  await act(async () => settle(40));
}

async function send(text: string): Promise<void> {
  await act(async () => {
    controls.aui.composer.setText(text);
    controls.aui.composer.send();
    await settle(30);
  });
}

const calls = (method: string) => world.calls.filter((call) => call.method === method);
const promptPath = (call: { params: unknown }) => (call.params as { path: string }).path;

function persistPrompts(history: Record<string, ContentBlock[][]>): void {
  world.overrides["session/prompt"] = ((params: { path: string; content: ContentBlock[] }) => {
    (history[params.path] ??= []).push(params.content);
    const state = world.states[params.path]!;
    world.states[params.path] = { ...state, messageCount: state.messageCount + 1 };
    return { accepted: true };
  }) as never;
}

describe("main destination isolation", () => {
  it("allocates empty Chat with the Chat agent and persists hi only there", async () => {
    addSession(world, CODE, PROJECT_CWD, { firstMessage: "original code history" });
    seedProject(PROJECT_CWD);
    const history: Record<string, ContentBlock[][]> = { [CODE]: [[{ type: "text", text: "original code history" }]] };
    persistPrompts(history);
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: CODE, phase: "ready", sendBlocked: false });

    let switching!: Promise<void>;
    await act(async () => {
      switching = controls.actions.goTab("chat");
      await switching;
      await settle(30);
    });

    expect(calls("session/new")).toHaveLength(0);
    expect(calls("session/load").filter((call) => (call.params as { path: string }).path !== CODE)).toHaveLength(0);
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "ready", sendBlocked: false, codeProject: PROJECT_CWD });

    await send("hi");
    const created = calls("session/new");
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toMatchObject({ cwd: world.snapshot.workspaces.chat, sessionKind: "chat" });
    expect(calls("session/prompt")).toHaveLength(1);
    expect(promptPath(calls("session/prompt")[0]!)).toBe(controls.path);
    expect(history[controls.path!]?.[0]).toEqual([{ type: "text", text: "hi" }]);
    expect(history[CODE]).toEqual([[{ type: "text", text: "original code history" }]]);
    expect(JSON.parse(readDeviceValue(DEVICE_KEYS.destination)!)).not.toHaveProperty("chat");
  });

  it("queues the first send until the Chat workspace arrives and delivers it once", async () => {
    addSession(world, CODE, PROJECT_CWD);
    seedProject(PROJECT_CWD);
    const readySnapshot = world.snapshot;
    const { chat: _lateChat, ...workspacesWithoutChat } = readySnapshot.workspaces;
    world.snapshot = { ...readySnapshot, workspaces: workspacesWithoutChat };
    await mount();
    await act(async () => { await controls.actions.goTab("chat"); await settle(40); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, composerPath: undefined, phase: "ready", sendBlocked: false });

    await act(async () => { controls.aui.composer.setText("wait for the workspace"); await settle(0); });
    expect(controls.canSend).toBe(true);
    await act(async () => { controls.aui.composer.send(); await settle(30); });
    expect(controls.sendPending).toBe(true);
    expect(calls("session/new")).toHaveLength(0);
    expect(calls("session/prompt")).toHaveLength(0);

    await act(async () => { FakeHostClient.current.notify("agents/updated", readySnapshot); await settle(100); });
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(1);
    expect(calls("session/prompt")[0]!.params).toMatchObject({ content: [{ type: "text", text: "wait for the workspace" }] });
  });

  it("times out Chat readiness and restores the unsent draft", async () => {
    addSession(world, CODE, PROJECT_CWD);
    seedProject(PROJECT_CWD);
    const { chat: _missing, ...workspaces } = world.snapshot.workspaces;
    world.snapshot = { ...world.snapshot, workspaces };
    const nativeSetTimeout = globalThis.setTimeout;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, delay === 15_000 ? 0 : delay, ...args)) as typeof setTimeout);
    try {
      await mount();
      await act(async () => { await controls.actions.goTab("chat"); await settle(20); });
      await send("do not lose these words");
      await act(async () => settle(30));
      expect(controls).toMatchObject({ tab: "chat", path: undefined, text: "do not lose these words", sendPending: false });
      expect(calls("session/new")).toHaveLength(0);
      expect(calls("session/prompt")).toHaveLength(0);
      expect(controls.toasts.at(-1)).toMatch(/taking longer than expected/i);
    } finally {
      timeout.mockRestore();
    }
  });

  it("returns a closed Chat conversation to the Chat landing", async () => {
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    seedProject(PROJECT_CWD);
    world.overrides["pi/session/move"] = (() => ({ path: `${PROJECT_CWD}/moved-chat.jsonl` })) as never;
    await mount();
    await act(async () => { await controls.actions.openSession(CHAT); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, chatPath: CHAT });

    await act(async () => { await controls.actions.moveSession(CHAT, PROJECT_CWD); await settle(30); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, composerPath: undefined, phase: "ready", chatPath: undefined });
  });

  it("opens a pre-M23 Beam record in the Chat tab without poisoning the remembered project session", async () => {
    // `docs/plain-chat.md` migration: the record still says `beam` and is never
    // rewritten, so the app has to read it as a Chat conversation.
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, LEGACY_CHAT, world.snapshot.workspaces.chat, { agent: agentInfo({ agentName: "beam", kind: "beam" }) });
    seedProject(PROJECT_CWD);
    seedRememberedSessions({ [PROJECT_CWD]: CODE });
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: CODE, codeProject: PROJECT_CWD });

    await act(async () => { await controls.actions.openSession(LEGACY_CHAT); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: LEGACY_CHAT, codeProject: PROJECT_CWD });
    expect(JSON.parse(readDeviceValue(DEVICE_KEYS.sessionsByProject)!)).toEqual({ [PROJECT_CWD]: CODE });

    await act(async () => { await controls.actions.goProject(PROJECT_CWD); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, codeProject: PROJECT_CWD });
  });

  it("blocks an immediate origin send while Chat allocation is pending and restores text plus image to Code", async () => {
    addSession(world, CODE, PROJECT_CWD);
    seedProject(PROJECT_CWD);
    await mount();

    let releaseNew!: () => void;
    const held = new Promise<void>((resolve) => { releaseNew = resolve; });
    world.overrides["session/new"] = (async (params: { cwd: string; agentName?: string }) => {
      await held;
      const path = `${params.cwd}/held-chat.jsonl`;
      const state = { ...world.states[CODE]!, path, id: path, cwd: params.cwd, messageCount: 0, agent: agentInfo({ kind: "chat" }) };
      world.states[path] = state;
      world.sessions.push({ path, id: path, cwd: params.cwd, messageCount: 0, createdAt: "2026-09-11T00:00:00Z", modifiedAt: "2026-09-11T00:00:00Z", agent: state.agent });
      return { state };
    }) as never;

    await act(async () => {
      controls.aui.composer.setText("stay with Code");
      await controls.aui.composer.addAttachment(new File([new Uint8Array([1, 2, 3])], "origin.png", { type: "image/png" }));
    });
    let switching!: Promise<void>;
    await act(async () => {
      switching = controls.actions.goTab("chat");
      // Same event turn: this is still the physical Code composer. The lazy
      // destination fence must win before React or assistant-ui can switch.
      controls.aui.composer.send();
      await settle(10);
    });
    expect(controls).toMatchObject({ tab: "chat", phase: "ready", sendBlocked: false });
    expect(calls("session/prompt")).toHaveLength(0);

    releaseNew();
    await act(async () => { await switching; await settle(25); });
    expect(controls).toMatchObject({ tab: "chat", phase: "ready", text: "", attachments: 0 });
    await act(async () => { await controls.actions.goTab("code"); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, text: "stay with Code", attachments: 1 });
    expect(controls.aui.composer.getState().attachments[0]).toMatchObject({ name: "origin.png", status: { type: "complete" } });
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("refuses a captured old dialog answer in the same turn as a tab switch", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    seedProject(PROJECT_CWD);
    await mount();
    await act(async () => {
      FakeHostClient.current.notify("pi/ui/request", { path: CODE, id: "old-question", method: "confirm", title: "Proceed?" });
    });
    expect(controls).toMatchObject({ path: CODE, dialogs: 1 });
    const answerOldQuestion = controls.actions.answerDialog;

    await act(async () => {
      const switching = controls.actions.goTab("chat");
      await answerOldQuestion({ id: "old-question", confirmed: true });
      await switching;
      await settle(20);
    });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, dialogs: 0 });
    expect(calls("pi/ui/response")).toHaveLength(0);

    await act(async () => { await controls.actions.goTab("code"); await settle(20); });
    expect(controls).toMatchObject({ path: CODE, dialogs: 1 });
  });

  it("latest navigation wins when opposite-kind loads settle out of order", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    seedProject(PROJECT_CWD);
    await mount();

    let releaseChat!: () => void;
    const chatHeld = new Promise<void>((resolve) => { releaseChat = resolve; });
    world.overrides["session/load"] = (async (params: { path: string }) => {
      if (params.path === CHAT) await chatHeld;
      return { state: world.states[params.path]!, replayFrom: 0, seq: 0 };
    }) as never;

    let slowChat!: Promise<void>;
    await act(async () => { slowChat = controls.actions.openSession(CHAT); await settle(0); });
    await act(async () => { await controls.actions.openSession(CODE); await settle(10); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, phase: "ready" });
    await act(async () => { releaseChat(); await slowChat; await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, phase: "ready" });

    let releaseCode!: () => void;
    const codeHeld = new Promise<void>((resolve) => { releaseCode = resolve; });
    world.overrides["session/load"] = (async (params: { path: string }) => {
      if (params.path === CODE) await codeHeld;
      return { state: world.states[params.path]!, replayFrom: 0, seq: 0 };
    }) as never;
    let slowCode!: Promise<void>;
    await act(async () => { slowCode = controls.actions.openSession(CODE); await settle(0); });
    await act(async () => { await controls.actions.openSession(CHAT); await settle(10); });
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, phase: "ready" });
    await act(async () => { releaseCode(); await slowCode; await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, phase: "ready" });
  });

  it("does not surface a stale load failure after a newer destination wins", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    seedProject(PROJECT_CWD);
    await mount();

    let releaseFailure!: () => void;
    const held = new Promise<void>((resolve) => { releaseFailure = resolve; });
    world.overrides["session/load"] = (async (params: { path: string }) => {
      if (params.path === CHAT) {
        await held;
        throw new Error("old Chat load failed");
      }
      return { state: world.states[params.path]!, replayFrom: 0, seq: 0 };
    }) as never;

    let stale!: Promise<void>;
    await act(async () => { stale = controls.actions.openSession(CHAT); await settle(0); });
    await act(async () => { await controls.actions.openSession(CODE); await settle(10); });
    await act(async () => { releaseFailure(); await stale; await settle(10); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, phase: "ready", toasts: [] });
  });

  it("keys pathless Code drafts, attachments and first-turn choices by project", async () => {
    const other = "/other-project";
    seedProject(PROJECT_CWD);
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: undefined, phase: "ready" });

    await act(async () => {
      controls.aui.composer.setText("project A draft");
      controls.aui.composer.setRunConfig({ custom: { agentName: "reviewer", thinkingLevel: "high" } });
      await controls.aui.composer.addAttachment(new File([new Uint8Array([4, 5, 6])], "project-a.png", { type: "image/png" }));
    });
    await act(async () => { await controls.actions.goProject(other); await settle(30); });
    expect(controls).toMatchObject({ tab: "code", path: undefined, text: "", attachments: 0, codeProject: other });

    await act(async () => { controls.aui.composer.setText("project B draft"); });
    await act(async () => { await controls.actions.goProject(PROJECT_CWD); await settle(40); });
    expect(controls).toMatchObject({ text: "project A draft", attachments: 1, codeProject: PROJECT_CWD });
    expect(controls.aui.composer.getState().runConfig.custom).toMatchObject({ agentName: "reviewer", thinkingLevel: "high" });
    expect(controls.aui.composer.getState().attachments[0]).toMatchObject({ name: "project-a.png", status: { type: "requires-action", reason: "composer-send" } });

    await act(async () => { await controls.actions.goProject(other); await settle(30); });
    expect(controls).toMatchObject({ text: "project B draft", attachments: 0, codeProject: other });
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("keeps an unsent landing draft through a frontend reload, and spends it when it is cleared", async () => {
    seedProject(PROJECT_CWD);
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: undefined, phase: "ready" });
    await act(async () => { controls.aui.composer.setText("unsent landing message"); });
    await act(async () => settle(400));

    // `refreshFrontend()` after a version handshake: the window is replaced and
    // every in-memory draft goes with it (AGENTS.md §5a).
    const reload = async () => {
      await act(async () => root.unmount());
      root = createRoot(container);
      FakeHostClient.reset(world);
      await mount();
    };
    await reload();
    expect(controls).toMatchObject({ tab: "code", path: undefined, text: "unsent landing message" });

    // Clearing it is deliberate: nothing comes back next time.
    await act(async () => { controls.aui.composer.setText(""); });
    await act(async () => settle(400));
    await reload();
    expect(controls).toMatchObject({ tab: "code", path: undefined, text: "" });
  });

  it("does not let the previously mounted thread retake a failed destination", async () => {
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    await mount();
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "ready", sendBlocked: false });
    await act(async () => { await controls.actions.openSession(CHAT); await settle(20); });
    expect(controls).toMatchObject({ path: CHAT, phase: "ready" });
    const missing = "/state/chat/missing.jsonl";

    await act(async () => { await controls.actions.openSession(missing); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable", sendBlocked: true });
    expect(calls("session/prompt")).toHaveLength(0);
    expect(calls("session/new")).toHaveLength(0);

    await act(async () => { await controls.actions.retryDestination(); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable", sendBlocked: true });
    expect(calls("session/load").filter((call) => (call.params as { path: string }).path === missing)).toHaveLength(2);
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("keeps text, first-turn intent and an image with their origin thread", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    seedProject(PROJECT_CWD);
    await mount();

    await act(async () => {
      controls.aui.composer.setText("code draft");
      controls.aui.composer.setRunConfig({ custom: { agentName: "reviewer", thinkingLevel: "high" } });
      await controls.aui.composer.addAttachment(new File([new Uint8Array([1, 2, 3])], "code.png", { type: "image/png" }));
    });
    expect(controls).toMatchObject({ text: "code draft", attachments: 1 });

    await act(async () => { await controls.actions.goTab("chat"); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, text: "", attachments: 0 });
    await act(async () => { await controls.actions.goTab("code"); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, text: "code draft", attachments: 1 });
    expect(controls.aui.composer.getState().runConfig.custom).toMatchObject({ agentName: "reviewer", thinkingLevel: "high" });
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("ignores a stale saved Chat identity and opens a fresh landing", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    delete world.states[CHAT];
    seedProject(PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    await mount();
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "ready", sendBlocked: false });
    expect(calls("session/new")).toHaveLength(0);
    expect(calls("session/prompt")).toHaveLength(0);
    expect(calls("session/load").map((call) => (call.params as { path: string }).path)).not.toContain(CHAT);
  });

  it("restores the saved tab and lets an explicit deep link override it", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    seedProject(PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    await mount();
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "ready" });
    expect(calls("session/new")).toHaveLength(0);

    await act(async () => root.unmount());
    root = createRoot(container);
    FakeHostClient.reset(world);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "code");
    globalThis.history.replaceState(null, "", `/#/session/${encodeURIComponent(CHAT)}`);
    await mount();
    expect(controls).toMatchObject({ tab: "chat", phase: "ready" });
    expect(controls.path).not.toBe(CODE);
  });

  it("restores an exact pathless Code project landing across a Chat excursion and reload", async () => {
    const oldProject = "/old-project";
    const oldCode = `${oldProject}/old.jsonl`;
    addSession(world, oldCode, oldProject);
    seedProject(PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    seedDeviceValue(DEVICE_KEYS.destination, JSON.stringify({ code: oldCode }));
    await mount();

    await act(async () => { await controls.actions.goProject(PROJECT_CWD); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", codeProject: PROJECT_CWD, path: undefined });
    await act(async () => { await controls.actions.goTab("chat"); await settle(20); });
    await act(async () => { await controls.actions.goTab("code"); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", codeProject: PROJECT_CWD, path: undefined });

    await act(async () => root.unmount());
    root = createRoot(container);
    FakeHostClient.reset(world);
    await mount();
    expect(controls).toMatchObject({ tab: "code", codeProject: PROJECT_CWD, path: undefined });
  });

  it("does not let a stale old-project load displace a newer pathless project landing", async () => {
    const oldProject = "/old-project";
    const oldCode = `${oldProject}/old.jsonl`;
    addSession(world, oldCode, oldProject);
    seedProject(PROJECT_CWD);
    await mount();
    await act(async () => { await controls.actions.goProject(PROJECT_CWD); await settle(20); });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = world.overrides["session/load"]!;
    world.overrides["session/load"] = async (params: { path: string }) => {
      if (params.path === oldCode) await gate;
      return original(params);
    };
    let stale!: Promise<void>;
    await act(async () => { stale = controls.actions.openSession(oldCode); await settle(5); });
    await act(async () => { await controls.actions.goProject(PROJECT_CWD); await settle(10); });
    await act(async () => { release(); await stale; await settle(20); });
    expect(controls).toMatchObject({ tab: "code", codeProject: PROJECT_CWD, path: undefined });
  });

  it("keeps a remembered Chat composer live and delivers one queued send after opening", async () => {
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    seedProject(PROJECT_CWD);
    await mount();

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    world.overrides["session/load"] = async (params: { path: string }) => {
      if (params.path === CHAT) await held;
      return { state: world.states[params.path]!, replayFrom: 0, seq: 0 };
    };
    let opening!: Promise<void>;
    await act(async () => { opening = controls.actions.openSession(CHAT); await settle(5); });
    expect(controls).toMatchObject({ tab: "chat", phase: "resolving", sendBlocked: false });
    await send("queued while opening");
    expect(calls("session/prompt")).toHaveLength(0);

    await act(async () => { release(); await opening; await settle(30); });
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, phase: "ready", sendBlocked: false });
    expect(calls("session/prompt")).toHaveLength(1);
    expect(promptPath(calls("session/prompt")[0]!)).toBe(CHAT);
  });

  it("keeps a fork of Chat in Chat and preserves its remembered Code destination", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: agentInfo({ kind: "chat" }) });
    world.states[CHAT] = { ...world.states[CHAT]!, agent: agentInfo({ kind: "chat" }) };
    seedProject(PROJECT_CWD);
    seedRememberedSessions({ [PROJECT_CWD]: CODE });
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    world.overrides["pi/session/fork"] = () => {
      const state = { ...world.states[CHAT]!, path: CHAT_FORK, id: "chat-fork" };
      world.states[CHAT_FORK] = state;
      return { state };
    };
    await mount();
    await act(async () => { await controls.actions.openSession(CHAT); await settle(20); });
    await act(async () => { await controls.actions.fork("entry"); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: CHAT_FORK, codeProject: PROJECT_CWD, phase: "ready" });
  });

  it("resolves a forked child through its canonical root project, not its worktree cwd", async () => {
    const root = `${PROJECT_CWD}/root.jsonl`;
    const agent = { agentName: "worker", kind: "child" as const, subagentName: "child", parentPath: root, rootPath: root, runId: "run-child" };
    addSession(world, root, PROJECT_CWD);
    addSession(world, CHILD, `${PROJECT_CWD}/.worktrees/child`, { agent, parentPath: root });
    world.states[CHILD] = { ...world.states[CHILD]!, agent };
    seedProject(PROJECT_CWD);
    seedRememberedSessions({ [PROJECT_CWD]: CHILD });
    world.overrides["pi/session/fork"] = () => {
      const state = { ...world.states[CHILD]!, path: CHILD_FORK, id: "child-fork" };
      world.states[CHILD_FORK] = state;
      return { state };
    };
    await mount();
    await act(async () => { await controls.actions.fork("entry"); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CHILD_FORK, codeProject: PROJECT_CWD, phase: "ready" });
  });

  it("pins a failed project restoration before loading so Retry cannot change identity", async () => {
    const other = `${PROJECT_CWD}/other.jsonl`;
    addSession(world, CODE, PROJECT_CWD, { modifiedAt: "2026-09-10T00:00:00.000Z" });
    addSession(world, other, PROJECT_CWD, { modifiedAt: "2026-09-11T00:00:00.000Z" });
    seedProject(PROJECT_CWD);
    seedRememberedSessions({ [PROJECT_CWD]: CODE });
    let failures = 0;
    world.overrides["session/load"] = (params: { path: string }) => {
      if (params.path === CODE && failures++ === 0) throw new Error("load failed");
      const state = world.states[params.path];
      if (!state) throw new Error("missing session");
      return { state, replayFrom: 0, seq: 0 };
    };
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: undefined, phase: "unavailable" });
    seedRememberedSessions({ [PROJECT_CWD]: other });
    await act(async () => { await controls.actions.retryDestination(); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, phase: "ready" });
    expect(calls("session/load").map(promptPath)).toEqual([CODE, CODE]);
    expect(calls("session/new")).toHaveLength(0);
  });

  it("pins a failed Chat candidate so a newer catalog row cannot replace it on Retry", async () => {
    const newerChat = "/state/chat/newer.jsonl";
    addSession(world, CHAT, "/state/chat", { modifiedAt: "2026-09-10T00:00:00.000Z", agent: agentInfo({ kind: "chat" }) });
    world.states[CHAT] = { ...world.states[CHAT]!, agent: agentInfo({ kind: "chat" }) };
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    let failures = 0;
    world.overrides["session/load"] = (params: { path: string }) => {
      if (params.path === CHAT && failures++ === 0) throw new Error("load failed");
      const state = world.states[params.path];
      if (!state) throw new Error("missing session");
      return { state, replayFrom: 0, seq: 0 };
    };
    await mount();
    await act(async () => { await controls.actions.openSession(CHAT); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable" });
    addSession(world, newerChat, "/state/chat", { modifiedAt: "2026-09-11T00:00:00.000Z", agent: agentInfo({ kind: "chat" }) });
    await act(async () => { await controls.actions.retryDestination(); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, phase: "ready" });
    expect(calls("session/load").map(promptPath)).toEqual([CHAT, CHAT]);
    expect(calls("session/new")).toHaveLength(0);
  });

  it("consumes a startup hash without navigating it after a newer explicit intent", async () => {
    addSession(world, CODE, PROJECT_CWD);
    globalThis.history.replaceState(null, "", `/#/session/${encodeURIComponent(CODE)}`);
    let release!: () => void;
    const catalog = new Promise<void>((resolve) => { release = resolve; });
    world.overrides["pi/session/list"] = async () => {
      await catalog;
      return { sessions: world.sessions };
    };
    world.overrides["pi/project/list"] = () => ({ projects: [{ cwd: PROJECT_CWD, name: "p", trusted: true }] });
    await act(async () => root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>));
    await act(async () => settle(10));
    await act(async () => { await controls.actions.goProject(PROJECT_CWD); await settle(5); });
    expect(controls).toMatchObject({ tab: "code", path: undefined, codeProject: PROJECT_CWD, phase: "ready" });
    await act(async () => { release(); await settle(40); });
    expect(controls).toMatchObject({ tab: "code", path: undefined, codeProject: PROJECT_CWD, phase: "ready" });
    expect(calls("session/load").filter((call) => promptPath(call) === CODE)).toHaveLength(0);
    expect(globalThis.location.hash).toBe("");
  });

  it("settles a malformed session hash onto safe remembered Code memory", async () => {
    seedProject(PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    globalThis.history.replaceState(null, "", "/#/session/%E0%A4%A");
    await mount();
    expect(controls).toMatchObject({ tab: "code", codeProject: PROJECT_CWD, path: undefined, phase: "ready", sendBlocked: false });
    expect(globalThis.location.hash).toBe("");
  });
});
