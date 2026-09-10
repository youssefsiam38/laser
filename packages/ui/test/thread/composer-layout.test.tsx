// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type DictationAdapter,
} from "@assistant-ui/react";

import { view as makeView } from "../agents/fixtures.js";

const mocks = vi.hoisted(() => ({
  mobile: false,
  touch: false,
  microphone: true,
  model: true,
  phase: "idle" as "idle" | "starting" | "listening" | "transcribing",
  error: undefined as unknown,
  view: undefined as ReturnType<typeof makeView> | undefined,
  currentProject: "/project" as string | undefined,
  toast: vi.fn(),
  clearError: vi.fn(),
  client: { request: vi.fn() },
  compact: vi.fn(),
  refreshEntries: vi.fn(),
  clearQueue: vi.fn(),
  takeEditorText: vi.fn(),
  fork: vi.fn(),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mocks.mobile,
  useIsTouch: () => mocks.touch,
}));
vi.mock("@/components/assistant-ui/elements/agent-selector", () => ({
  SessionAgentSelector: () => <button aria-label="Agent: Default agent">Agent</button>,
}));
vi.mock("@/components/assistant-ui/elements/model-selector", () => ({
  SessionModelSelector: () => mocks.model ? <button aria-label="Model: Test model">Model</button> : null,
}));
vi.mock("@/components/assistant-ui/elements/reasoning-effort", () => ({
  ThinkingEffort: () => <button aria-label="Thinking: off">Thinking</button>,
}));
vi.mock("@/components/assistant-ui/elements/context-display", () => ({
  ContextRingButton: () => <button aria-label="Context: empty">Context</button>,
}));
vi.mock("@/components/assistant-ui/elements/draft-restore", () => ({ ComposerDraftRestore: () => null }));
vi.mock("@/components/assistant-ui/elements/message-queue", () => ({ ComposerQueue: () => null }));
vi.mock("@/components/assistant-ui/elements/quote.aui", () => ({ ComposerQuotePreview: () => null, quoteAsMarkdown: (text: string) => text }));
vi.mock("@/components/assistant-ui/elements/composer-trigger-popover.aui", () => ({ ComposerTriggerPopover: () => null }));
vi.mock("@/components/thread/StatusLine.js", () => ({ StatusLine: () => null }));
vi.mock("@/components/thread/session-preparation.js", () => ({
  SessionPreparationProvider: ({ children }: { children: ReactNode }) => children,
  useSessionPreparation: () => ({ pending: false }),
}));
vi.mock("@/components/thread/use-project-file-search.js", () => ({
  useProjectFileSearch: () => ({ files: [], loading: false, failed: false, truncated: false, retry: vi.fn() }),
}));
vi.mock("@/components/shell/session-groups", () => ({ useSessionsList: () => ({ tab: "code" }) }));
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ newSession: vi.fn(), openHistory: vi.fn(), setAddProjectOpen: vi.fn() }),
}));
vi.mock("@/agents", () => ({ useRunsForRoot: () => [] }));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserView: () => mocks.view,
  useLaserStable: () => ({
    currentProject: mocks.currentProject,
    client: mocks.client,
    actions: {
      toast: mocks.toast,
      compact: mocks.compact,
      refreshEntries: mocks.refreshEntries,
      clearQueue: mocks.clearQueue,
      takeEditorText: mocks.takeEditorText,
      fork: mocks.fork,
    },
  }),
  useSessionMeta: () => ({ running: false, compacting: false }),
}));

let activeSession: DictationAdapter.Session | undefined;
vi.mock("@/pwa", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pwa/index.js")>();
  return {
    ...actual,
    useEnvironment: () => ({ microphone: mocks.microphone }),
    PhraseDictationAdapter: Object.assign(actual.PhraseDictationAdapter, { isSupported: () => true }),
    useDictationPhase: () => mocks.phase,
    useDictationLevel: () => 0.4,
    useDictationPending: () => mocks.phase === "transcribing" ? 1 : 0,
    useDictationError: () => mocks.error,
    clearDictationError: mocks.clearError,
    cancelActiveDictation: () => activeSession?.cancel(),
    activeDictationCancellation: () => activeSession?.cancel,
  };
});

import { Composer } from "../../src/components/thread/Composer.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const speechStarts = new Set<() => void>();
const speech = new Set<(result: DictationAdapter.Result) => void>();
const speechEnds = new Set<(result: DictationAdapter.Result) => void>();
const subscribe = <T,>(set: Set<T>, callback: T) => { set.add(callback); return () => set.delete(callback); };
const dictation: DictationAdapter = {
  disableInputDuringDictation: false,
  listen: () => {
    speechStarts.clear(); speech.clear(); speechEnds.clear();
    const session: DictationAdapter.Session = {
      status: { type: "starting" },
      stop: async () => {
        const result = { transcript: "dictated", isFinal: true };
        speech.forEach((callback) => callback(result));
        session.status = { type: "ended", reason: "stopped" };
        speechEnds.forEach((callback) => callback(result));
      },
      cancel: () => {
        session.status = { type: "ended", reason: "cancelled" };
        speechEnds.forEach((callback) => callback({ transcript: "", isFinal: true }));
      },
      onSpeechStart: (callback) => subscribe(speechStarts, callback),
      onSpeech: (callback) => subscribe(speech, callback),
      onSpeechEnd: (callback) => subscribe(speechEnds, callback),
    };
    activeSession = session;
    return session;
  },
};

function Fixture() {
  const runtime = useExternalStoreRuntime({
    messages: [],
    isRunning: false,
    onNew: async () => {},
    adapters: { dictation },
  });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><Composer /></TooltipProvider></AssistantRuntimeProvider>;
}

let container: HTMLDivElement;
let root: Root;
const render = async () => act(async () => root.render(<Fixture />));
const input = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const dictate = () => container.querySelector<HTMLElement>('[data-slot="dictate"]');
const labels = () => [...container.querySelectorAll<HTMLElement>("textarea,button")]
  .filter((element) => !(element instanceof HTMLButtonElement && element.disabled))
  .map((element) => element.getAttribute("aria-label"));
const setDraft = async (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.mobile = false; mocks.touch = false; mocks.microphone = true; mocks.model = true;
  mocks.phase = "idle"; mocks.error = undefined; mocks.currentProject = "/project";
  mocks.toast.mockReset(); mocks.clearError.mockReset(); mocks.client.request.mockReset().mockResolvedValue({ commands: [] });
  mocks.clearQueue.mockReset().mockResolvedValue(""); activeSession = undefined;
  const view = makeView({ path: "/state/session.jsonl" });
  mocks.view = { ...view, capabilities: ["transcribe"] };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the production composer layout", () => {
  it("keeps DOM, focus, recording ownership and draft order aligned through every phase", async () => {
    expect(labels()).toEqual(["Message", "Attachments unavailable", "Dictate a message", "Agent: Default agent", "Model: Test model", "Thinking: off", "Context: empty", "Send"]);
    const toolbar = container.querySelector<HTMLElement>('[data-slot="composer-toolbar"]')!;
    const actions = container.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    expect(toolbar.classList).toContain("flex-wrap");
    expect(actions.classList).toContain("flex-1");
    expect(actions.classList).toContain("justify-end");
    expect([...actions.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
      .toEqual(["Agent: Default agent", "Model: Test model", "Thinking: off", "Context: empty", "Send"]);
    await setDraft("Keep editing");
    const owner = dictate()!;

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!.click());
    mocks.phase = "starting"; await render();
    expect(dictate()).toBe(owner);
    expect(owner.dataset["phase"]).toBe("starting");
    expect(input().value).toBe("Keep editing");
    expect(owner.classList).toContain("basis-full");
    expect(owner.classList).not.toContain("order-first");
    expect(labels()).toEqual(["Message", "Attachments unavailable", "Stop dictation and transcribe", "Discard recording", "Agent: Default agent", "Model: Test model", "Thinking: off", "Context: empty", "Send"]);

    await act(async () => {
      activeSession!.status = { type: "running" };
      speechStarts.forEach((callback) => callback());
    });
    mocks.phase = "listening"; await render();
    expect(dictate()).toBe(owner);
    expect(labels()[2]).toBe("Stop dictation and transcribe");

    mocks.phase = "transcribing"; await render();
    expect(dictate()).toBe(owner);
    expect(labels()).toEqual(["Message", "Attachments unavailable", "Discard recording", "Agent: Default agent", "Model: Test model", "Thinking: off", "Context: empty", "Send"]);
    expect(input().disabled).toBe(false);

    mocks.phase = "listening"; await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation and transcribe"]')!.click());
    mocks.phase = "idle"; await render();
    expect(dictate()).toBe(owner);
    expect(input().value).toBe("Keep editing dictated");
    expect(labels()).toEqual(["Message", "Attachments unavailable", "Dictate a message", "Agent: Default agent", "Model: Test model", "Thinking: off", "Context: empty", "Send"]);

    mocks.phase = "starting"; await render();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!.disabled).toBe(true);
    expect(input().value).toBe("Keep editing dictated");
  });

  it("uses the actual blocked, no-model and no-microphone branches", async () => {
    mocks.view = undefined; mocks.currentProject = undefined; await render();
    expect(input().disabled).toBe(true);
    expect(dictate()).toBeNull();
    expect(container.querySelector('[aria-label^="Agent:"]')).toBeNull();

    mocks.view = { ...makeView({ path: "/state/session.jsonl" }), capabilities: ["transcribe"] };
    mocks.currentProject = "/project"; mocks.model = false; await render();
    expect(container.querySelector('[aria-label^="Agent:"]')).not.toBeNull();
    expect(container.querySelector('[aria-label^="Model:"]')).toBeNull();

    mocks.microphone = false; await render();
    expect(dictate()).toBeNull();
  });

  it("uses the mobile branch's explicit 44px classes for idle, stop and discard", async () => {
    mocks.mobile = true; mocks.touch = true; await render();
    const mic = container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!;
    expect(mic.classList).toContain("size-11");
    expect(labels()).toEqual(["Dictate a message", "Agent: Default agent", "Model: Test model", "Thinking: off", "Context: empty", "Attachments unavailable", "Message", "Send"]);

    const owner = dictate()!;
    await act(async () => mic.click());
    expect(dictate()).toBe(owner);
    expect(container.querySelector('[aria-label="Stop dictation and transcribe"]')?.classList).toContain("size-11");
    expect(container.querySelector('[aria-label="Discard recording"]')?.classList).toContain("size-11");
    expect(labels()).toEqual(["Stop dictation and transcribe", "Discard recording", "Attachments unavailable", "Message", "Send"]);

    mocks.error = new Error("provider refused"); await render();
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.clearError).toHaveBeenCalledOnce();
  });
});
