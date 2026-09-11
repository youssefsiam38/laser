// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAui, useAuiState, type Aui } from "@assistant-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "@lasercode/protocol";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import {
  LaserProvider,
  PROJECT_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  useLaserStable,
  useLaserState,
  useLaserView,
  type LaserActions,
} from "../../src/runtime/LaserProvider.js";
import { isMainReady, mainTab } from "../../src/runtime/main-destination.js";
import { SESSION_TAB_MEMORY_KEY, SESSIONS_TAB_STORAGE_KEY } from "../../src/runtime/session-tab-memory.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

const CODE = `${PROJECT_CWD}/code.jsonl`;
const CHAT = "/state/chat/chat.jsonl";
const BEAM = "/state/beam/beam.jsonl";

type Controls = {
  actions: LaserActions;
  aui: Aui;
  tab: "chat" | "code";
  path: string | undefined;
  phase: string;
  disabled: boolean;
  text: string;
  attachments: number;
  codeProject: string | undefined;
  dialogs: number;
  toasts: string[];
};
let controls: Controls;

function Probe() {
  const { actions, currentProject } = useLaserStable();
  const destination = useLaserState((state) => state.destination);
  const toasts = useLaserState((state) => state.toasts.map((toast) => toast.text));
  const view = useLaserView();
  const aui = useAui();
  const disabled = useAuiState((state) => state.thread.isDisabled);
  const text = useAuiState((state) => state.composer.text);
  const attachments = useAuiState((state) => state.composer.attachments.length);
  const tab = mainTab(destination);
  const phase = isMainReady(destination) ? "ready" : destination.phase;
  controls = { actions, aui, tab, path: view?.path, phase, disabled, text, attachments, codeProject: currentProject, dialogs: view?.dialogs.length ?? 0, toasts };
  return <output data-tab={tab} data-path={view?.path ?? ""} data-phase={phase} data-disabled={disabled} />;
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
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    const history: Record<string, ContentBlock[][]> = { [CODE]: [[{ type: "text", text: "original code history" }]] };
    persistPrompts(history);
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: CODE, phase: "ready", disabled: false });

    let switching!: Promise<void>;
    await act(async () => {
      switching = controls.actions.goTab("chat");
      await switching;
      await settle(30);
    });

    const created = calls("session/new");
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toMatchObject({ cwd: world.snapshot.workspaces.chat, agentName: "chat" });
    expect(controls).toMatchObject({ tab: "chat", phase: "ready", disabled: false, codeProject: PROJECT_CWD });
    expect(controls.path).not.toBe(CODE);

    await send("hi");
    expect(calls("session/prompt")).toHaveLength(1);
    expect(promptPath(calls("session/prompt")[0]!)).toBe(controls.path);
    expect(history[controls.path!]?.[0]).toEqual([{ type: "text", text: "hi" }]);
    expect(history[CODE]).toEqual([[{ type: "text", text: "original code history" }]]);
  });

  it("opens Beam in Code without poisoning the remembered project session", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, BEAM, world.snapshot.workspaces.beam!, { agent: { agentName: "beam", kind: "beam" } });
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ [PROJECT_CWD]: CODE }));
    await mount();
    expect(controls).toMatchObject({ tab: "code", path: CODE, codeProject: PROJECT_CWD });

    await act(async () => { await controls.actions.openSession(BEAM); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: BEAM, codeProject: PROJECT_CWD });
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!)).toEqual({ [PROJECT_CWD]: CODE });

    await act(async () => { await controls.actions.goProject(PROJECT_CWD); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, codeProject: PROJECT_CWD });
  });

  it("blocks an immediate origin send while Chat allocation is pending and restores text plus image to Code", async () => {
    addSession(world, CODE, PROJECT_CWD);
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    await mount();

    let releaseNew!: () => void;
    const held = new Promise<void>((resolve) => { releaseNew = resolve; });
    world.overrides["session/new"] = (async (params: { cwd: string; agentName?: string }) => {
      await held;
      const path = `${params.cwd}/held-chat.jsonl`;
      const state = { ...world.states[CODE]!, path, id: path, cwd: params.cwd, messageCount: 0, agent: { agentName: "chat", kind: "chat" as const } };
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
    expect(controls).toMatchObject({ tab: "chat", phase: "resolving", disabled: true });
    expect(calls("session/prompt")).toHaveLength(0);

    await act(async () => { releaseNew(); await switching; await settle(25); });
    expect(controls).toMatchObject({ tab: "chat", phase: "ready", text: "", attachments: 0 });
    await act(async () => { await controls.actions.goTab("code"); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, text: "stay with Code", attachments: 1 });
    expect(controls.aui.composer.getState().attachments[0]).toMatchObject({ name: "origin.png", status: { type: "complete" } });
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("refuses a captured old dialog answer in the same turn as a tab switch", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: { agentName: "chat", kind: "chat" } });
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
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
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, dialogs: 0 });
    expect(calls("pi/ui/response")).toHaveLength(0);

    await act(async () => { await controls.actions.goTab("code"); await settle(20); });
    expect(controls).toMatchObject({ path: CODE, dialogs: 1 });
  });

  it("latest navigation wins when opposite-kind loads settle out of order", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: { agentName: "chat", kind: "chat" } });
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
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
    addSession(world, CHAT, "/state/chat", { agent: { agentName: "chat", kind: "chat" } });
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
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
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
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

  it("does not let the previously mounted thread retake a failed destination", async () => {
    addSession(world, CHAT, "/state/chat", { agent: { agentName: "chat", kind: "chat" } });
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    await mount();
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, phase: "ready", disabled: false });
    const missing = "/state/chat/missing.jsonl";

    await act(async () => { await controls.actions.openSession(missing); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable", disabled: true });
    expect(calls("session/prompt")).toHaveLength(0);
    expect(calls("session/new")).toHaveLength(0);

    await act(async () => { await controls.actions.retryDestination(); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable", disabled: true });
    expect(calls("session/load").filter((call) => (call.params as { path: string }).path === missing)).toHaveLength(2);
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("keeps text, first-turn intent and an image with their origin thread", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: { agentName: "chat", kind: "chat" } });
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    await mount();

    await act(async () => {
      controls.aui.composer.setText("code draft");
      controls.aui.composer.setRunConfig({ custom: { agentName: "reviewer", thinkingLevel: "high" } });
      await controls.aui.composer.addAttachment(new File([new Uint8Array([1, 2, 3])], "code.png", { type: "image/png" }));
    });
    expect(controls).toMatchObject({ text: "code draft", attachments: 1 });

    await act(async () => { await controls.actions.goTab("chat"); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: CHAT, text: "", attachments: 0 });
    await act(async () => { await controls.actions.goTab("code"); await settle(20); });
    expect(controls).toMatchObject({ tab: "code", path: CODE, text: "code draft", attachments: 1 });
    expect(controls.aui.composer.getState().runConfig.custom).toMatchObject({ agentName: "reviewer", thinkingLevel: "high" });
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("keeps a stale saved Chat identity unavailable on retry instead of recreating or resending", async () => {
    addSession(world, CODE, PROJECT_CWD);
    addSession(world, CHAT, "/state/chat", { agent: { agentName: "chat", kind: "chat" } });
    delete world.states[CHAT];
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    await mount();
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable", disabled: true });
    expect(calls("session/new")).toHaveLength(0);
    expect(calls("session/prompt")).toHaveLength(0);
    expect(calls("session/load").map((call) => (call.params as { path: string }).path)).toContain(CHAT);

    await act(async () => { await controls.actions.retryDestination(); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable", disabled: true });
    expect(calls("session/new")).toHaveLength(0);
    expect(calls("session/prompt")).toHaveLength(0);
    expect(calls("session/load").filter((call) => (call.params as { path: string }).path === CHAT)).toHaveLength(2);
  });

  it("restores the saved tab and lets an explicit deep link override it", async () => {
    addSession(world, CODE, PROJECT_CWD);
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    await mount();
    expect(controls).toMatchObject({ tab: "chat", phase: "ready" });
    expect(calls("session/new")[0]?.params).toMatchObject({ cwd: world.snapshot.workspaces.chat, agentName: "chat" });

    await act(async () => root.unmount());
    root = createRoot(container);
    FakeHostClient.reset(world);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "code");
    globalThis.history.replaceState(null, "", `/#/session/${encodeURIComponent(controls.path!)}`);
    await mount();
    expect(controls).toMatchObject({ tab: "chat", phase: "ready" });
    expect(controls.path).not.toBe(CODE);
  });

  it("restores an exact pathless Code project landing across a Chat excursion and reload", async () => {
    const oldProject = "/old-project";
    const oldCode = `${oldProject}/old.jsonl`;
    addSession(world, oldCode, oldProject);
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    localStorage.setItem(SESSION_TAB_MEMORY_KEY, JSON.stringify({ code: oldCode }));
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
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
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

  it("retries the exact created Chat identity after hydration fails without recreating it", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    let failedPath: string | undefined;
    world.overrides["session/load"] = async (params: { path: string }) => {
      if (params.path.includes("/state/chat/") && failedPath === undefined) {
        failedPath = params.path;
        throw new Error("hydrate failed");
      }
      const state = world.states[params.path];
      if (!state) throw new Error("missing session");
      return { state, replayFrom: 0, seq: 0 };
    };
    await mount();
    await act(async () => { await controls.actions.goTab("chat"); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: undefined, phase: "unavailable", disabled: true });
    expect(calls("session/new")).toHaveLength(1);
    expect(failedPath).toBeTruthy();

    await act(async () => { await controls.actions.retryDestination(); await settle(20); });
    expect(controls).toMatchObject({ tab: "chat", path: failedPath, phase: "ready", disabled: false });
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/load").filter((call) => (call.params as { path: string }).path === failedPath)).toHaveLength(2);
  });

  it("settles a malformed session hash onto safe remembered Code memory", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
    localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
    globalThis.history.replaceState(null, "", "/#/session/%E0%A4%A");
    await mount();
    expect(controls).toMatchObject({ tab: "code", codeProject: PROJECT_CWD, path: undefined, phase: "ready", disabled: false });
    expect(globalThis.location.hash).toBe("");
  });
});
