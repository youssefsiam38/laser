// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/store.js";
import { view as makeView } from "../agents/fixtures.js";

/**
 * Beam's bubble puts a second composer on screen over the session's own, and
 * both offer the microphone. Two things used to be global and would have made
 * the second one speak for the first: the scope the transcription is filed
 * under, and the textarea a finished phrase is typed into.
 */
const mocks = vi.hoisted(() => ({ view: undefined as SessionView | undefined, dictating: false }));
// A browser with a microphone and a supported capture path; what this file is
// about is which composer a recording belongs to, not the hardware.
vi.mock("@/pwa", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pwa/index.js")>();
  return {
    ...actual,
    useEnvironment: () => ({ ...actual.useEnvironment(), microphone: true }),
    PhraseDictationAdapter: Object.assign(actual.PhraseDictationAdapter, { isSupported: () => true }),
  };
});
vi.mock("../../src/runtime/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserView: () => mocks.view,
  useLaserStable: () => ({ actions: { toast: vi.fn() } }),
}));
vi.mock("@assistant-ui/react", async (importActual) => {
  const actual = await importActual<typeof import("@assistant-ui/react")>();
  return {
    ...actual,
    useAui: () => ({ composer: { getState: () => ({ text: "" }), setText: vi.fn() } }),
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
import { readDictationScope } from "../../src/pwa/mobile-dictation.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.dictating = false;
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
  it("is offered wherever the session can transcribe, and hidden where it cannot", async () => {
    mocks.view = sessionView("/state/beam/b1.jsonl", "/state/beam");
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    expect(container.querySelector('[data-slot="dictate"]')).not.toBeNull();

    mocks.view = sessionView("/p/s.jsonl", "/p", []);
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    expect(container.querySelector('[data-slot="dictate"]')).toBeNull();
  });

  it("files a recording under the session it was spoken into, not the one that mounted last", async () => {
    mocks.view = sessionView("/state/beam/b1.jsonl", "/state/beam");
    await act(async () => root.render(<TooltipProvider><DictateButton /></TooltipProvider>));
    // Mounting claims nothing: the composer that is not recording must not
    // take the scope from the one that is.
    expect(readDictationScope()).toBeUndefined();

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!.click());
    expect(readDictationScope()).toEqual({ cwd: "/state/beam", path: "/state/beam/b1.jsonl" });
  });

  it("types a finished phrase into its own composer, not the first one on the page", async () => {
    const other = document.createElement("div");
    other.innerHTML = '<div data-slot="composer"><textarea id="main"></textarea></div>';
    document.body.prepend(other);
    try {
      mocks.view = sessionView("/state/beam/b1.jsonl", "/state/beam");
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
      // Recording claims the scope for the session this composer shows.
      expect(readDictationScope()).toEqual({ cwd: "/state/beam", path: "/state/beam/b1.jsonl" });
    } finally {
      other.remove();
    }
  });
});
