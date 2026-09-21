// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/store.js";
import { view as makeView } from "../agents/fixtures.js";

/**
 * More than one composer can be on screen at once, and each offers the
 * microphone. Two things used to be global and would have made the second one
 * speak for the first: the scope the transcription is filed under, and the
 * textarea a finished phrase is typed into.
 */
const mocks = vi.hoisted(() => ({ view: undefined as SessionView | undefined, dictating: false, currentProject: undefined as string | undefined,
  cancel: vi.fn(), sink: vi.fn(), text: "", setText: vi.fn(), toast: vi.fn() }));
const composer = { getState: () => ({ text: mocks.text }), setText: mocks.setText };
const aui = { composer };
const actions = { toast: mocks.toast };
let client = { request: vi.fn().mockResolvedValue({ available: true }) }; 
// A browser with a microphone and a supported capture path; what this file is
// about is which composer a recording belongs to, not the hardware.
vi.mock("@/pwa", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pwa/index.js")>();
  return {
    ...actual,
    useEnvironment: () => ({ ...actual.useEnvironment(), microphone: true }),
    cancelActiveDictation: mocks.cancel,
    setDictationPhraseSink: mocks.sink,
    PhraseDictationAdapter: Object.assign(actual.PhraseDictationAdapter, { isSupported: () => true }),
  };
});
vi.mock("../../src/runtime/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserView: () => mocks.view,
  useLaserState: (selector: (state: unknown) => unknown) => selector({
    current: mocks.view?.path,
    open: mocks.view ? { [mocks.view.path]: mocks.view } : {},
    agents: { snapshot: undefined, runs: {}, events: [] },
    sessions: [], workers: {}, connection: "open",
  }),
  useLaserStable: () => ({ actions, client, currentProject: mocks.currentProject, destination: { phase: "ready-code", code: mocks.currentProject ? { kind: "project-landing", project: mocks.currentProject } : { kind: "no-project-landing" } } }),
}));
vi.mock("@assistant-ui/react", async (importActual) => {
  const actual = await importActual<typeof import("@assistant-ui/react")>();
  return {
    ...actual,
    useAui: () => aui,
    useAuiState: () => mocks.dictating,
    AuiIf: ({ condition, children }: { condition: (s: unknown) => boolean; children: unknown }) =>
      condition({ composer: { dictation: mocks.dictating ? {} : null } }) ? children : null,
    ComposerPrimitive: {
      ...actual.ComposerPrimitive,
      Dictate: ({ children }: { children: unknown }) => children,
      StopDictation: ({ children }: { children: unknown }) => children,
    },
  };
});

import { DictateButton } from "../../src/components/mobile/DictateButton.js";
import { readDictationScope, setDictationScope } from "../../src/pwa/mobile-dictation.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.dictating = false;
  client = { request: vi.fn().mockResolvedValue({ available: true }) };
  mocks.toast.mockReset();
  mocks.currentProject = undefined;
  mocks.text = ""; mocks.setText.mockReset(); mocks.sink.mockReset(); mocks.cancel.mockReset();
  setDictationScope(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const sessionView = (path: string, cwd: string, capabilities: string[] = ["transcribe"]): SessionView => {
  const v = makeView({ path });
  return { ...v, capabilities: capabilities as SessionView["capabilities"], state: { ...v.state, cwd } };
};

describe("the microphone in a second composer", () => {
  it("offers a fresh project microphone on the first frame, asks the host nothing, and claims only on click", async () => {
    // D-341: the control is present before any probe could answer. Provider,
    // credential and permission are checked on the press, by the transport.
    mocks.view = undefined; mocks.currentProject = "/fresh";
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    expect(container.querySelector('[aria-label="Dictate a message"]')).not.toBeNull();
    expect(client.request).not.toHaveBeenCalled();
    expect(readDictationScope()).toBeUndefined();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!.click());
    expect(readDictationScope()).toEqual({ cwd: "/fresh", path: undefined });
  });

  it("keeps the landing microphone whatever a status probe would have said, and stays quiet until a press", async () => {
    mocks.view = undefined; mocks.currentProject = "/unavailable";
    client.request.mockResolvedValue({ available: false });
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    expect(container.querySelector('[data-slot="dictate"]')).not.toBeNull();
    expect(client.request).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("is the same control before the session exists and after it arrives", async () => {
    mocks.view = undefined; mocks.currentProject = "/fresh";
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    const before = container.querySelector('[data-slot="dictate"]');
    expect(before).not.toBeNull();
    // The host answers: the landing's session now exists, without "transcribe"
    // among its capabilities. Nothing on screen may change for that.
    mocks.view = sessionView("/fresh/new.jsonl", "/fresh", []);
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    expect(container.querySelector('[data-slot="dictate"]')).toBe(before);
    expect(client.request).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!.click());
    expect(readDictationScope()).toEqual({ cwd: "/fresh", path: "/fresh/new.jsonl" });
  });

  it("discards through a neutral, named button beside stop without modifying text", async () => {
    mocks.view = sessionView("/state/chat/c1.jsonl", "/state/chat"); mocks.dictating = true;
    mocks.text = "Keep my typed draft";
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    const discard = container.querySelector<HTMLButtonElement>('[aria-label="Discard recording"]')!;
    expect(discard).not.toBeNull(); expect(discard.className).toContain("text-ink-3");
    expect(discard.previousElementSibling?.getAttribute("aria-label")).toBe("Stop dictation and transcribe");
    await act(async () => discard.click());
    expect(mocks.cancel).toHaveBeenCalledOnce(); expect(mocks.setText).not.toHaveBeenCalled();
  });

  it("is offered in every session this browser can record in; whether the host can transcribe is the press's question", async () => {
    mocks.view = sessionView("/state/chat/c1.jsonl", "/state/chat");
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    expect(container.querySelector('[data-slot="dictate"]')).not.toBeNull();

    mocks.view = sessionView("/p/s.jsonl", "/p", []);
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    expect(container.querySelector('[data-slot="dictate"]')).not.toBeNull();
  });

  it("files a recording under the session it was spoken into, not the one that mounted last", async () => {
    mocks.view = sessionView("/state/chat/c1.jsonl", "/state/chat");
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    // Mounting claims nothing: the composer that is not recording must not
    // take the scope from the one that is.
    expect(readDictationScope()).toBeUndefined();

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!.click());
    expect(readDictationScope()).toEqual({ cwd: "/state/chat", path: "/state/chat/c1.jsonl" });
  });

  it("types a finished phrase into its own composer, not the first one on the page", async () => {
    const other = document.createElement("div");
    other.innerHTML = '<div data-slot="composer"><textarea id="main"></textarea></div>';
    document.body.prepend(other);
    try {
      mocks.view = sessionView("/state/chat/c1.jsonl", "/state/chat");
      mocks.dictating = true;
      await act(async () =>
        root.render(
          <TooltipProvider>
            <div data-slot="composer">
              <textarea id="bubble" />
              <DictateButton />
            </div>
          </TooltipProvider>,
        ),
      );
      // The document's first composer textarea is the other one; the control
      // must reach the box it lives in.
      expect(document.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea')!.id).toBe("main");
      const owned = container.querySelector('[data-slot="dictate"]')!.closest('[data-slot="composer"]')!.querySelector("textarea")!;
      expect(owned.id).toBe("bubble");
      owned.setSelectionRange(0, 0);
      mocks.text = "typed words spoken"; // the runtime's just-appended phrase
      const sink = mocks.sink.mock.calls.at(-1)?.[0] as (phrase: string) => void;
      await act(async () => sink("spoken"));
      expect(mocks.setText).toHaveBeenCalledWith("spoken typed words");
      // Recording claims the scope for the session this composer shows.
      expect(readDictationScope()).toEqual({ cwd: "/state/chat", path: "/state/chat/c1.jsonl" });
    } finally {
      other.remove();
    }
  });

  /**
   * M16-T48 / review #50: the insert flash was timed by hand-parsing
   * `--motion-morph` off the card (`parseFloat`, so `0.4s` read as 0.4ms, and
   * an uninherited value as none at all). It reads the token through
   * `motionMs()` now, like every other motion in the app.
   */
  it("clears the insert flash after the motion token's own duration", async () => {
    document.documentElement.style.setProperty("--motion-morph", "0.4s");
    vi.useFakeTimers();
    try {
      mocks.view = sessionView("/state/chat/c1.jsonl", "/state/chat");
      mocks.dictating = true;
      await act(async () =>
        root.render(
          <TooltipProvider>
            <div data-slot="composer-card">
              <div data-slot="composer">
                <textarea id="bubble" />
                <DictateButton />
              </div>
            </div>
          </TooltipProvider>,
        ),
      );
      const card = container.querySelector<HTMLElement>('[data-slot="composer-card"]')!;
      const sink = mocks.sink.mock.calls.at(-1)?.[0] as (phrase: string) => void;
      mocks.text = "spoken";
      await act(async () => sink("spoken"));
      // The flash is written in the frame after the phrase lands.
      await act(async () => { vi.advanceTimersByTime(20); });
      expect(card.dataset["dictationInsert"]).toBe("true");

      await act(async () => { vi.advanceTimersByTime(380); });
      expect(card.dataset["dictationInsert"]).toBe("true");
      await act(async () => { vi.advanceTimersByTime(40); });
      expect(card.dataset["dictationInsert"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
      document.documentElement.style.removeProperty("--motion-morph");
    }
  });
});
