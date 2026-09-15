// @vitest-environment happy-dom
/**
 * RP-5b: what the clipboard is told, and what a viewer holds.
 *
 * A message shown in part must never be copied as if it were whole, whatever
 * the reason the whole could not be read — a reference still live, a path not
 * to hand, a window with no blob clipboard. And a picture shown from the image
 * pool is a hold, given back exactly once however the viewer goes away.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import { useFileOpener, type FileViewerSource } from "@/lib/file-opener";
import { LaserStoreProvider, createStateStore } from "../../src/runtime/LaserProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { initialState } from "../../src/store.js";
import { useHonestCopy } from "../../src/components/thread/prompt-actions.js";

const stable = vi.hoisted(() => ({
  client: { request: vi.fn(async () => ({})) },
  actions: { listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn() },
}));
vi.mock("@/runtime", async original => ({
  ...await original<typeof import("../../src/runtime/index.js")>(),
  useLaserStable: () => stable,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function Opener({ onReady }: { onReady: (open: (source: FileViewerSource) => void) => void }) {
  const opener = useFileOpener();
  const trigger = document.createElement("button");
  if (opener) onReady(source => opener.openFile(source, trigger));
  return null;
}

function mount(scope: string, onReady: (open: (source: FileViewerSource) => void) => void) {
  const store = createStateStore(initialState);
  act(() => root.render(
    <LaserStoreProvider store={store}>
      <TooltipProvider>
        <FileOpenerProvider scope={scope}>
          <Opener onReady={onReady} />
        </FileOpenerProvider>
      </TooltipProvider>
    </LaserStoreProvider>,
  ));
}

const picture = (release: () => void): FileViewerSource => ({
  picture: { url: "blob:one", blob: new Blob(["x"]), name: "Image 1", mediaType: "image/png", bytes: 3 },
  release,
});

describe("copying a message that is only shown in part", () => {
  const total = 400_000;
  const shown = "答".repeat(2_000);
  const excerpt = { offset: 0, bytes: new TextEncoder().encode(shown).byteLength };

  /** What the clipboard was told, for one reference and one window. */
  async function copiedFor(body: unknown, path: string | undefined, blobClipboard: boolean): Promise<string> {
    const written: string[] = [];
    const clipboard = { writeText: async (text: string) => { written.push(text); }, ...(blobClipboard ? { write: async () => {} } : {}) };
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    if (!blobClipboard) vi.stubGlobal("ClipboardItem", undefined);
    let run: (() => Promise<void>) | undefined;
    function Row() {
      const copier = useHonestCopy(path, shown, body as never);
      run = copier.copy;
      return null;
    }
    const store = createStateStore(initialState);
    act(() => root.render(<LaserStoreProvider store={store}><TooltipProvider><Row /></TooltipProvider></LaserStoreProvider>));
    await act(async () => { await run!(); });
    vi.unstubAllGlobals();
    return written.at(-1) ?? "";
  }

  it("marks the bytes whenever the whole body was not read, and only copies plain when it holds the whole", async () => {
    const marker = "more of this message is not included";
    // A body this window holds whole: plain, no marker.
    expect(await copiedFor(undefined, "/p/s.jsonl", true)).toBe(shown);
    expect(await copiedFor({ component: { kind: "assistant_text" }, totalBytes: excerpt.bytes, excerpt }, "/p/s.jsonl", true)).toBe(shown);

    // Still streaming: the reference is live, there is nothing to read yet —
    // and that is exactly when a plain copy would lie.
    const live = { component: { kind: "assistant_text" }, totalBytes: total, excerpt, live: true as const };
    expect(await copiedFor(live, "/p/s.jsonl", true)).toContain(marker);

    // An excerpt whose reference names no entry.
    const unreadable = { component: { kind: "assistant_text" }, totalBytes: total, excerpt };
    expect(await copiedFor(unreadable, "/p/s.jsonl", true)).toContain(marker);

    // Readable, but this surface has no session path to read from.
    const readable = { entryId: "e1", component: { kind: "assistant_text" }, totalBytes: total, excerpt };
    expect(await copiedFor(readable, undefined, true)).toContain(marker);

    // Readable, but this window cannot take a whole body as a blob.
    expect(await copiedFor(readable, "/p/s.jsonl", false)).toContain(marker);

    // Every marked copy still carries what was on screen.
    expect(await copiedFor(live, "/p/s.jsonl", true)).toContain(shown);
  });
});

describe("a picture a viewer is holding", () => {
  it("gives its hold back exactly once, whichever way the viewer goes away", async () => {
    for (const how of ["close", "replace", "scope", "unmount"] as const) {
      const released = vi.fn();
      const second = vi.fn();
      let open: ((source: FileViewerSource) => void) | undefined;
      mount("thread-a", handle => { open = handle; });
      act(() => open!(picture(released)));
      expect(released).not.toHaveBeenCalled();

      if (how === "close") {
        // The way a person closes it: Escape, through the dialog itself.
        act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      } else if (how === "replace") {
        act(() => open!(picture(second)));
      } else if (how === "scope") {
        mount("thread-b", handle => { open = handle; });
      } else {
        act(() => root.unmount());
        root = createRoot(container);
      }

      expect(released, how).toHaveBeenCalledTimes(1);
      // A late close callback for something already released does nothing more.
      act(() => { /* settle */ });
      expect(released, how).toHaveBeenCalledTimes(1);
    }
  });
});
