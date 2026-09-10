// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const box = {
    composerState: { text: "", attachments: [] as unknown[] },
    sourceComposerState: { text: "" },
  };
  return {
    unstarted: true,
    view: {
      path: "/project/default.jsonl",
      state: { cwd: "/project", agent: { agentName: "default", kind: "root" } },
    } as { path: string; state: { cwd: string; agent?: { agentName: string; kind: string } } } | undefined,
    snapshot: {
      defaultAgent: "default",
      workspaces: { beam: "/builtin/beam", chat: "/builtin/chat" },
      agents: [
        { name: "default", kind: "custom", description: "General coding" },
        { name: "researcher", kind: "custom", description: "Searches a large codebase" },
        { name: "beam", kind: "builtin", description: "Built in" },
        { name: "chat", kind: "builtin", description: "Built in" },
        { name: "namer", kind: "builtin", description: "Built in" },
      ],
    },
    newSession: vi.fn(async () => "/project/researcher.jsonl"),
    refresh: vi.fn(async () => undefined),
    toast: vi.fn(),
    composerState: box.composerState,
    sourceComposerState: box.sourceComposerState,
    setComposerText: vi.fn((text: string) => {
      mocks.composerState = { ...mocks.composerState, text };
    }),
    setSourceComposerText: vi.fn((text: string) => {
      mocks.sourceComposerState = { text };
    }),
    finishPreparation: vi.fn(),
    beginPreparation: vi.fn(),
  };
});

vi.mock("@assistant-ui/react", async (importActual) => ({
  ...(await importActual<typeof import("@assistant-ui/react")>()),
  useAui: () => ({
    threads: { __internal_getAssistantRuntime: () => ({ threads: {
    getState: () => ({ mainThreadId: "source" }),
    getById: () => ({ composer: { getState: () => mocks.sourceComposerState, setText: mocks.setSourceComposerText } }),
    } }) },
    composer: {
      getState: () => mocks.composerState,
      setText: mocks.setComposerText,
    },
    thread: {
      composer: () => ({
        getState: () => mocks.sourceComposerState,
        setText: mocks.setSourceComposerText,
      }),
    },
  }),
}));

vi.mock("@/agents", () => ({
  agentDisplayName: (name: string) => name === "default" ? "Default agent" : name,
  isBuiltinAgent: (agent: { kind: string }) => agent.kind === "builtin",
  isWorkspaceCwd: (cwd: string | undefined) => cwd === "/builtin/beam" ? "beam" : cwd === "/builtin/chat" ? "chat" : null,
  useAgentsSnapshot: () => mocks.snapshot,
  useAgentsStatus: () => ({ loading: false, error: null, loaded: true }),
}));

vi.mock("@/components/thread/session-preparation", () => ({
  useSessionPreparation: () => ({ pending: false, begin: mocks.beginPreparation }),
}));

vi.mock("@/runtime", () => ({
  isUnstartedSession: () => mocks.unstarted,
  useLaserStable: () => ({
    actions: { newSession: mocks.newSession, toast: mocks.toast, agents: { refresh: mocks.refresh } },
    currentProject: "/project",
  }),
  useLaserView: () => mocks.view,
  useLaserState: () => undefined,
  useSessionMeta: () => ({ session: undefined, model: null }),
}));

import { SessionAgentSelector } from "../../src/components/assistant-ui/elements/agent-selector.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.unstarted = true;
  mocks.view = {
    path: "/project/default.jsonl",
    state: { cwd: "/project", agent: { agentName: "default", kind: "root" } },
  };
  mocks.newSession.mockReset();
  mocks.newSession.mockResolvedValue("/project/researcher.jsonl");
  mocks.refresh.mockClear();
  mocks.toast.mockClear();
  mocks.setComposerText.mockClear();
  mocks.setSourceComposerText.mockClear();
  mocks.finishPreparation.mockReset();
  mocks.beginPreparation.mockReset();
  mocks.beginPreparation.mockReturnValue(mocks.finishPreparation);
  mocks.composerState = { text: "", attachments: [] };
  mocks.sourceComposerState = { text: "" };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SessionAgentSelector />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const trigger = () => container.querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]');
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it("selects the default and searches custom agents without exposing built-ins", async () => {
  expect(trigger()?.textContent).toContain("Default agent");
  await act(async () => trigger()!.click());
  await settle();

  const text = document.body.textContent ?? "";
  expect(text).toContain("researcher");
  expect(text).toContain("Searches a large codebase");
  expect(text).not.toContain("beam");
  expect(text).not.toContain("chat");
  expect(text).not.toContain("namer");

  const search = document.querySelector<HTMLInputElement>('[aria-label="Search agents"]')!;
  expect(document.activeElement).toBe(search);
  await act(async () => {
    search.value = "research";
    search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "research" }));
  });
  const researcher = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')]
    .find((item) => item.textContent?.includes("researcher"));
  expect(researcher).toBeTruthy();
  await act(async () => researcher!.click());
  await settle();
  expect(mocks.newSession).toHaveBeenCalledWith("/project", { agentName: "researcher" });
});

it("keeps session preparation locked until a deferred identity switch settles", async () => {
  let resolveSession!: (path: string) => void;
  mocks.newSession.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
  await act(async () => trigger()!.click());
  await settle();
  const researcher = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')]
    .find((item) => item.textContent?.includes("researcher"))!;
  await act(async () => researcher.click());
  expect(mocks.beginPreparation).toHaveBeenCalledOnce();
  expect(mocks.finishPreparation).not.toHaveBeenCalled();
  await act(async () => resolveSession("/project/researcher.jsonl"));
  await settle();
  expect(mocks.finishPreparation).toHaveBeenCalledOnce();
});

it("carries a typed draft to the newly selected agent and refuses to strand attachments", async () => {
  mocks.composerState = { text: "Keep this draft", attachments: [] };
  mocks.sourceComposerState = { text: "Keep this draft" };
  mocks.newSession.mockImplementationOnce(async () => {
    mocks.view = { path: "/project/researcher.jsonl", state: { cwd: "/project", agent: { agentName: "researcher", kind: "root" } } };
    mocks.composerState = { text: "Target note", attachments: [] };
    return "/project/researcher.jsonl";
  });
  await act(async () => trigger()!.click());
  await settle();
  const researcher = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')]
    .find((item) => item.textContent?.includes("researcher"))!;
  await act(async () => researcher.click());
  await settle();

  mocks.view = {
    path: "/project/researcher.jsonl",
    state: { cwd: "/project", agent: { agentName: "researcher", kind: "root" } },
  };
  mocks.composerState = { text: "Target note", attachments: [] };
  await act(async () => root.render(<SessionAgentSelector />));
  expect(mocks.setComposerText).toHaveBeenCalledWith("Keep this draft\n\nTarget note");
  expect(mocks.setSourceComposerText).toHaveBeenCalledWith("");
  expect(mocks.finishPreparation).toHaveBeenCalledOnce();

  // Moving back carries the merged target once; clearing the first source
  // prevents the round trip from multiplying the original draft.
  mocks.composerState = { text: "Keep this draft\n\nTarget note", attachments: [] };
  mocks.sourceComposerState = { text: "Keep this draft\n\nTarget note" };
  await act(async () => trigger()!.click());
  await settle();
  const defaultAgent = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')]
    .find((item) => item.textContent?.includes("Default agent"))!;
  mocks.newSession.mockImplementationOnce(async () => {
    mocks.view = { path: "/project/default.jsonl", state: { cwd: "/project", agent: { agentName: "default", kind: "root" } } };
    mocks.composerState = { text: "", attachments: [] };
    return "/project/default.jsonl";
  });
  await act(async () => defaultAgent.click());
  await settle();
  mocks.view = {
    path: "/project/default.jsonl",
    state: { cwd: "/project", agent: { agentName: "default", kind: "root" } },
  };
  mocks.composerState = { text: "", attachments: [] };
  await act(async () => root.render(<SessionAgentSelector />));
  expect(mocks.setComposerText).toHaveBeenLastCalledWith("Keep this draft\n\nTarget note");

  mocks.view = {
    path: "/project/default.jsonl",
    state: { cwd: "/project", agent: { agentName: "default", kind: "root" } },
  };
  mocks.composerState = { text: "Still here", attachments: [{}] };
  mocks.newSession.mockClear();
  await act(async () => root.render(<SessionAgentSelector />));
  await act(async () => trigger()!.click());
  await settle();
  const blockedChoice = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')]
    .find((item) => item.textContent?.includes("researcher"))!;
  await act(async () => blockedChoice.click());
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith("warning", "Remove attachments before changing the agent. Your draft is unchanged.");
  expect(mocks.composerState.text).toBe("Still here");
});

it("appears before session creation, then disappears once started or inside a built-in channel", async () => {
  mocks.view = undefined;
  await act(async () => root.render(<SessionAgentSelector />));
  expect(trigger()?.textContent).toContain("Default agent");
  await act(async () => root.render(<SessionAgentSelector allowProjectLanding={false} />));
  expect(trigger()).toBeNull();
  await act(async () => root.render(<SessionAgentSelector />));

  mocks.view = {
    path: "/project/default.jsonl",
    state: { cwd: "/project", agent: { agentName: "default", kind: "root" } },
  };
  mocks.unstarted = false;
  await act(async () => root.render(<SessionAgentSelector />));
  expect(trigger()).toBeNull();

  mocks.unstarted = true;
  mocks.view = {
    path: "/chat/chat.jsonl",
    state: { cwd: "/chat", agent: { agentName: "chat", kind: "chat" } },
  };
  await act(async () => root.render(<SessionAgentSelector />));
  expect(trigger()).toBeNull();

  mocks.view = { path: "/project/legacy.jsonl", state: { cwd: "/project" } };
  await act(async () => root.render(<SessionAgentSelector />));
  expect(trigger()?.textContent).toContain("Default agent");

  // Legacy/terminal-created built-in sessions can lack attribution; their
  // reserved workspace still keeps the ordinary custom-agent picker out.
  mocks.view = { path: "/chat/legacy.jsonl", state: { cwd: "/builtin/chat" } };
  await act(async () => root.render(<SessionAgentSelector />));
  expect(trigger()).toBeNull();
});
