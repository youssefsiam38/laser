// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type DictationAdapter,
  type ThreadMessageLike,
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
  mention: undefined as undefined | {
    matcher: (text: string, char: string, caret: number) => { query: string; offset: number } | null;
    directive: { onInserted?: (item: { id: string; type: string; label: string }) => void };
  },
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
vi.mock("@/components/assistant-ui/elements/composer-trigger-popover.aui", () => ({ ComposerTriggerPopover: (props: { char: string; adapter: { search?: (query: string) => Array<{ label?: string }> } }) => {
  // The `@` picker's own surface has its own tests; what this fixture needs is
  // the wiring the real composer hands it.
  if (props.char === "@") { mocks.mention = props as unknown as typeof mocks.mention; return null; }
  return <div data-slot="slash-items">{props.adapter.search?.("").map((item) => item.label).join(" ")}</div>;
} }));
vi.mock("@/components/thread/StatusLine.js", () => ({ StatusLine: () => null }));
vi.mock("@/components/thread/session-preparation.js", () => ({
  SessionPreparationProvider: ({ children }: { children: ReactNode }) => children,
  useSessionPreparation: () => ({ pending: false }),
}));
vi.mock("@/components/thread/use-directory-page.js", () => ({
  useDirectoryPage: (cwd: string, query: string) => ({ entries: [], loading: false, navigation: { cwd, query, head: '', commonPrefix: '', loading: false, next: undefined, previous: undefined } }),
}));
vi.mock("@/components/shell/session-groups", () => ({ useSessionsList: () => ({ tab: "code" }) }));
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ newSession: vi.fn(), openHistory: vi.fn(), setAddProjectOpen: vi.fn() }),
}));
vi.mock("@/agents", () => ({ useRunsForRoot: () => [] }));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserView: () => mocks.view,
  // The composer reads narrow slices of app state, so the mock runs real selectors.
  useLaserState: (selector: (state: unknown) => unknown) => selector({
    current: mocks.view?.path,
    open: mocks.view ? { [mocks.view.path]: mocks.view } : {},
    sessions: [],
    connection: "open",
    workers: {},
    agents: { snapshot: undefined, runs: {}, events: [] },
  }),
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
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

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
    convertMessage: (message: ThreadMessageLike) => message,
    messages: [] as ThreadMessageLike[],
    isRunning: false,
    onNew: async () => {},
    adapters: { dictation },
  });
  return <LaserStoreProvider store={store}><AssistantRuntimeProvider runtime={runtime}><TooltipProvider><Composer /></TooltipProvider></AssistantRuntimeProvider></LaserStoreProvider>;
}

let container: HTMLDivElement;
let root: Root;
let store: StateStore;
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
  store = createStateStore({ ...initialState, environment: testDescriptor() });
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
  it("leaves prose spelling, context menu and undo to the native textarea", async () => {
    expect(input().getAttribute("spellcheck")).not.toBe("false");
    expect(input().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))).toBe(true);
    expect(input().dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }))).toBe(true);

    mocks.mobile = true;
    mocks.touch = true;
    await render();
    expect(input().getAttribute("spellcheck")).toBe("true");
    expect(input().getAttribute("autocorrect")).toBe("on");
    expect(input().getAttribute("autocapitalize")).toBe("sentences");
    expect(input().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))).toBe(true);
  });

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

  it.each([
    testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"] }),
    testDescriptor({ actor: { class: "local_browser", id: "browser" }, localOnly: ["session/prompt"] }),
  ])("replaces every composer action with one guardrail when prompt authority is denied", async (environment) => {
    store.dispatch({ type: "environment", environment });
    await render();
    expect(container.textContent).toContain("This conversation is read-only here");
    expect(input()).toBeNull();
    expect(dictate()).toBeNull();
    expect(container.querySelector('[aria-label^="Model:"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Thinking:"]')).toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(mocks.client.request.mock.calls.filter(([method]) => method === "session/prompt" || String(method).startsWith("pi/transcribe/"))).toHaveLength(0);
  });

  // M16-T86: the composer, not a fixture, is what has to hand the picker a
  // matcher and an insertion that share one record of finished mentions.
  it("finishes a mention the picker inserted and draws it as a tag", async () => {
    await setDraft("@au");
    expect(mocks.mention?.matcher("@au", "@", 3)).toMatchObject({ query: "au", offset: 0 });
    // What the primitive does on Enter: write the token, then say what it was.
    await setDraft("@audit ");
    await act(async () => mocks.mention?.directive.onInserted?.({ id: "agent:audit", type: "agent", label: "audit" }));
    await setDraft("@audit please look");
    expect(mocks.mention?.matcher("@audit please look", "@", 18)).toBeNull();
    const tag = container.querySelector<HTMLElement>('[data-slot="composer-mention-tag"]')!;
    expect(tag.dataset["mentionKind"]).toBe("agent");
    expect(tag.textContent).toBe("@audit");
    // The tag is drawn behind the person's own text and says nothing twice.
    const layer = container.querySelector<HTMLElement>('[data-slot="composer-mention-layer"]')!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.textContent).toBe("@audit please look\n");
    expect(input().value).toBe("@audit please look");
    // A file chosen from the picker reads as a file, and a fresh `@` still asks.
    await setDraft("@audit please look at @./server/index.ts ");
    await act(async () => mocks.mention?.directive.onInserted?.({ id: "file:server/index.ts", type: "file", label: "server/index.ts" }));
    expect([...container.querySelectorAll<HTMLElement>('[data-slot="composer-mention-tag"]')].map((each) => each.dataset["mentionKind"])).toEqual(["agent", "file"]);
    expect(mocks.mention?.matcher("@audit please look at @./server/index.ts now", "@", 44)).toBeNull();
    expect(mocks.mention?.matcher("@audit please look at @./server/index.ts now @ser", "@", 49)).toMatchObject({ query: "ser", offset: 45 });

    // The same draft on a phone: tags there too, inside the pill that keeps
    // its own surface.
    mocks.mobile = true; mocks.touch = true;
    await render();
    const pill = input().closest('[data-slot="composer-mention-field"]')!.parentElement!;
    expect(pill.classList).toContain("rounded-full");
    expect(pill.classList).toContain("bg-surface-2");
    expect([...pill.querySelectorAll<HTMLElement>('[data-slot="composer-mention-tag"]')].map((each) => each.dataset["mentionKind"])).toEqual(["agent", "file"]);
  });

  it("removes the /project command when project setup is local-only", async () => {
    store.dispatch({ type: "environment", environment: testDescriptor({ actor: { class: "local_browser", id: "browser" }, localOnly: ["pi/project/add"] }) });
    await render();
    expect(container.querySelector('[data-slot="slash-items"]')?.textContent).toContain("/compact");
    expect(container.querySelector('[data-slot="slash-items"]')?.textContent).not.toContain("/project");
    expect(mocks.client.request.mock.calls.filter(([method]) => method === "pi/project/add")).toHaveLength(0);
  });

  it("turns an already visible composer read-only in the same render without leaking a request", async () => {
    expect(input()).not.toBeNull();
    await act(async () => store.dispatch({ type: "environment", environment: testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read"] }) }));
    expect(input()).toBeNull();
    expect(container.textContent).toContain("This conversation is read-only here");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.client.request.mock.calls.filter(([method]) => method === "session/prompt")).toHaveLength(0);
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
