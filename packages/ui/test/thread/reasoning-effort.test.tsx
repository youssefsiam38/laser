// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  level: "high" as string | undefined,
  session: { cwd: "/project", path: "/project/current.jsonl" } as { cwd: string; path?: string } | undefined,
  view: { path: "/project/current.jsonl" } as { path: string } | undefined,
  model: { provider: "test", id: "reasoner" } as { provider: string; id: string } | null,
  currentProject: undefined as string | undefined,
  catalogDefault: "plain",
  defaultThinkingLevel: "low" as string | undefined,
  applyThinking: vi.fn(async (_params: { path: string; level: string }) => ({ state: {} })),
  dispatch: vi.fn(),
  setThinking: vi.fn(async () => undefined),
  newSession: vi.fn(async () => "/landing/new.jsonl"),
  toast: vi.fn(),
  snapshot: {
    defaultAgent: "default",
    agents: [{
      name: "default",
      model: { provider: "test", id: "reasoner" } as { provider: string; id: string } | null,
      thinkingLevel: "low" as string | null,
    }],
  },
  composerState: { text: "", attachments: [] as unknown[] },
  sourceComposerState: { text: "" },
  setComposerText: vi.fn(),
  setSourceComposerText: vi.fn(),
  finishPreparation: vi.fn(),
  beginPreparation: vi.fn(),
}));

const client = {
  request: async (method: string, params: { cwd: string; path: string; level: string }) => method === "pi/thinking/set"
    ? mocks.applyThinking(params)
    : params.cwd === "/landing"
    ? {
        models: [
          { provider: "test", id: "reasoner", name: "Reasoner", thinkingLevels: ["off", "low", "high"], thinkingLevel: "high" },
          { provider: "test", id: "plain", name: "Plain", thinkingLevels: ["off"], thinkingLevel: "off" },
        ],
        defaultProvider: "test",
        defaultModel: mocks.catalogDefault,
        defaultThinkingLevel: mocks.defaultThinkingLevel,
      }
    : { models: [{ provider: "test", id: "reasoner", thinkingLevels: ["off", "low", "medium", "high", "xhigh"] }] },
};
const actions = { setThinking: mocks.setThinking, newSession: mocks.newSession, toast: mocks.toast };

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

vi.mock("@/components/thread/session-preparation", () => ({
  useSessionPreparation: () => ({ pending: false, begin: mocks.beginPreparation }),
}));

vi.mock("@/runtime", () => ({
  useLaserStable: () => ({ client, actions, dispatch: mocks.dispatch, currentProject: mocks.currentProject }),
  useLaserState: (selector: (state: unknown) => unknown) => selector({ agents: { snapshot: mocks.snapshot } }),
  useLaserView: () => mocks.view,
  useSessionMeta: () => ({ session: mocks.session, model: mocks.model, thinkingLevel: mocks.level }),
}));

import { ThinkingEffort, invalidateThinkingCatalog } from "../../src/components/assistant-ui/elements/reasoning-effort.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.level = "high";
  mocks.session = { cwd: "/project", path: "/project/current.jsonl" };
  mocks.view = { path: "/project/current.jsonl" };
  mocks.model = { provider: "test", id: "reasoner" };
  mocks.currentProject = undefined;
  mocks.catalogDefault = "plain";
  mocks.defaultThinkingLevel = "low";
  mocks.applyThinking.mockClear();
  mocks.dispatch.mockClear();
  mocks.snapshot.agents[0]!.model = { provider: "test", id: "reasoner" };
  mocks.snapshot.agents[0]!.thinkingLevel = "low";
  mocks.composerState = { text: "", attachments: [] };
  mocks.sourceComposerState = { text: "" };
  mocks.setThinking.mockClear();
  mocks.newSession.mockClear();
  mocks.toast.mockClear();
  mocks.setComposerText.mockReset();
  mocks.setComposerText.mockImplementation((text: string) => { mocks.composerState = { ...mocks.composerState, text }; });
  mocks.setSourceComposerText.mockReset();
  mocks.setSourceComposerText.mockImplementation((text: string) => { mocks.sourceComposerState = { text }; });
  mocks.finishPreparation.mockReset();
  mocks.beginPreparation.mockReset();
  mocks.beginPreparation.mockReturnValue(mocks.finishPreparation);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

it("shows the current compact level without opening the picker, and updates with session state", async () => {
  const render = () => root.render(<TooltipProvider><ThinkingEffort /></TooltipProvider>);
  await act(async () => render());
  expect(container.querySelector("button")?.textContent).toBe("high");
  expect(document.querySelector('[role="radiogroup"]')).toBeNull();
  mocks.level = "medium";
  await act(async () => render());
  expect(container.querySelector("button")?.textContent).toBe("med");
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Thinking: medium");
  await act(async () => container.querySelector("button")!.click());
  const high = document.querySelector<HTMLButtonElement>('[role="radio"][aria-label="high"]')!;
  await act(async () => high.click());
  expect(mocks.setThinking).toHaveBeenCalledWith("high");
});

it.each([false, true])("locks through a deferred thinking override without pasting into intervening navigation (%s)", async (navigateAway) => {
  let resolveThinking!: (value: { state: object }) => void;
  mocks.applyThinking.mockImplementationOnce(() => new Promise((resolve) => { resolveThinking = resolve; }));
  mocks.level = undefined;
  mocks.session = undefined;
  mocks.view = undefined;
  mocks.model = null;
  mocks.currentProject = "/landing";
  mocks.composerState = { text: "Keep this thought", attachments: [] };
  mocks.sourceComposerState = { text: "Keep this thought" };
  await act(async () => root.render(<TooltipProvider><ThinkingEffort /></TooltipProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.disabled).toBe(false);
  expect(trigger.textContent).toBe("low");
  await act(async () => trigger.click());
  const high = document.querySelector<HTMLButtonElement>('[role="radio"][aria-label="high"]')!;
  await act(async () => high.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  expect(mocks.newSession).toHaveBeenCalledWith("/landing");
  expect(mocks.applyThinking).toHaveBeenCalledWith({ path: "/landing/new.jsonl", level: "high" });
  expect(mocks.newSession.mock.invocationCallOrder[0]).toBeLessThan(mocks.applyThinking.mock.invocationCallOrder[0]!);
  expect(mocks.beginPreparation).toHaveBeenCalledOnce();
  expect(mocks.finishPreparation).not.toHaveBeenCalled();

  mocks.session = { cwd: "/landing", path: "/landing/new.jsonl" };
  mocks.view = { path: navigateAway ? "/other/session.jsonl" : "/landing/new.jsonl" };
  mocks.level = "high";
  mocks.model = { provider: "test", id: "reasoner" };
  mocks.composerState = { text: "", attachments: [] };
  await act(async () => root.render(<TooltipProvider><ThinkingEffort /></TooltipProvider>));
  expect(mocks.finishPreparation).not.toHaveBeenCalled();
  expect(mocks.setComposerText).not.toHaveBeenCalled();
  await act(async () => resolveThinking({ state: {} }));
  if (navigateAway) {
    expect(mocks.setComposerText).not.toHaveBeenCalled();
    expect(mocks.setSourceComposerText).not.toHaveBeenCalled();
  } else {
    expect(mocks.setComposerText).toHaveBeenCalledWith("Keep this thought");
    expect(mocks.setSourceComposerText).toHaveBeenCalledWith("");
  }
  expect(mocks.finishPreparation).toHaveBeenCalledOnce();
});

it("refreshes pre-session capabilities after the project model default changes", async () => {
  mocks.level = undefined;
  mocks.session = undefined;
  mocks.view = undefined;
  mocks.model = null;
  mocks.currentProject = "/landing";
  mocks.snapshot.agents[0]!.model = null;
  mocks.snapshot.agents[0]!.thinkingLevel = null;
  mocks.catalogDefault = "reasoner";
  invalidateThinkingCatalog("/landing");

  await act(async () => root.render(<TooltipProvider><ThinkingEffort /></TooltipProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Thinking:"]')?.textContent).toBe("high");

  mocks.catalogDefault = "plain";
  await act(async () => {
    invalidateThinkingCatalog("/landing");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.querySelector('[role="note"]')?.getAttribute("aria-label")).toContain("Plain does not reason");
});

it("stays out of an empty Chat surface even when a Code project remains selected", async () => {
  mocks.level = undefined;
  mocks.session = undefined;
  mocks.view = undefined;
  mocks.model = null;
  mocks.currentProject = "/landing";
  await act(async () => root.render(<TooltipProvider><ThinkingEffort allowProjectLanding={false} /></TooltipProvider>));
  expect(container.querySelector('[data-slot="thinking-effort"]')).toBeNull();
});
