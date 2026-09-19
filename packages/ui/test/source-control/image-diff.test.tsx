// @vitest-environment happy-dom
/**
 * A change to a picture shows the picture (M20-T5).
 *
 * The person opened `logo.png` and got "Could not read this file · This file
 * has no textual diff to show." — a dead end for a file we read perfectly
 * well. These cases are the four change kinds, the two refusals and the
 * written state for a binary that is not an image.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FILE_BLOB_MAX_BYTES } from "@lasercode/protocol";

import { BinaryFileBody } from "../../src/source-control/image-body.js";
import {
  binaryFileView,
  byteDelta,
  fileFormatWord,
  imageAltText,
  looksBinaryPatch,
  sideLabel,
} from "../../src/source-control/image-diff.js";
import type { ChangedFile, FileBytesPage, FileDiffPage } from "../../src/source-control/contract.js";
import { resetChangesAdapter, setChangesAdapter } from "../../src/source-control/data.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A real 16×16 PNG, so nothing here is asserted against invented bytes. */
const RED_16 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4Y2NDEmIY1TCqYfhqAABhl1QQ50OvrwAAAABJRU5ErkJggg==";
/** And a 32×24 one for the other side. */
const BLUE_32 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAAJElEQVR4nGOwqbhDU8QwasGoBaMWjFowasGoBaMWjFowNCwAAKi5sD1kziExAAAAAElFTkSuQmCC";

const BINARY_PATCH = "diff --git a/src/logo.png b/src/logo.png\nindex 1111111..2222222 100644\nBinary files a/src/logo.png and b/src/logo.png differ\n";

function page(over: Partial<FileDiffPage> = {}): FileDiffPage {
  return { repo: "app", path: "src/logo.png", status: "binary", added: 0, removed: 0, patch: BINARY_PATCH, ...over };
}

function meta(over: Partial<ChangedFile> = {}): ChangedFile {
  return { path: "src/logo.png", status: "binary", added: 0, removed: 0, change: "modified", ...over };
}

/** What a base64 payload actually decodes to, padding and all. */
const rawBytes = (data: string): number => atob(data).length;

function blob(over: Partial<FileBytesPage> & { data?: string }): FileBytesPage {
  const data = over.data;
  const totalBytes = over.totalBytes ?? (data ? rawBytes(data) : 0);
  return {
    repo: "app",
    path: "src/logo.png",
    ref: "worktree",
    mediaType: "image/png",
    totalBytes,
    offset: 0,
    bytes: data ? totalBytes : 0,
    truncated: false,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // A headless DOM reports every `<img>` as already `complete` with
  // `naturalWidth === 0`, and the Image element reads that pair as a decode
  // failure. A browser reports a blob URL as *not* complete until it has
  // decoded, which is what is emulated here — without it every case below
  // would assert against a placeholder the product never actually shows.
  Object.defineProperty(window.HTMLImageElement.prototype, "complete", { configurable: true, get: () => false });
  let counter = 0;
  globalThis.URL.createObjectURL = vi.fn(() => {
    const url = `blob:image-${++counter}`;
    created.push(url);
    return url;
  });
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  created.length = 0;
  revoked.length = 0;
  resetChangesAdapter();
  vi.restoreAllMocks();
});

type SideCall = { path: string; side: "old" | "new"; offset: number };

function mount(view: ReturnType<typeof binaryFileView>, pages: Partial<Record<"old" | "new", FileBytesPage | null>>, style: "split" | "unified" = "split") {
  const calls: SideCall[] = [];
  setChangesAdapter({
    listChanges: async () => ({ scope: { kind: "uncommitted" }, repos: [] }),
    getFileDiff: async () => page(),
    async getFileBytes(_scope, _repo, path, side, options) {
      calls.push({ path, side, offset: options?.offset ?? 0 });
      return pages[side] ?? null;
    },
  });
  if (!view) throw new Error("expected a binary view");
  act(() => {
    root.render(<BinaryFileBody view={view} scope={{ kind: "uncommitted" }} diffStyle={style} />);
  });
  return calls;
}

/** Let the paging loop and its state updates run out, inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const img = (alt: string) => host.querySelector<HTMLImageElement>(`img[alt="${alt}"]`);
const text = () => host.textContent ?? "";

/* ------------------------------------------------------------------ */
/* What a file with no textual diff is                                 */
/* ------------------------------------------------------------------ */

describe("classifying a file the text path cannot draw", () => {
  it("recognises git's own two ways of saying there are no lines", () => {
    expect(looksBinaryPatch(BINARY_PATCH)).toBe(true);
    expect(looksBinaryPatch("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n")).toBe(false);
    expect(looksBinaryPatch("GIT binary patch\nliteral 12\n")).toBe(true);
  });

  it("keeps the change kind a binary row would otherwise lose", () => {
    expect(binaryFileView(page(), meta({ change: "added" }))).toMatchObject({ kind: "added", sides: ["new"] });
    expect(binaryFileView(page(), meta({ change: "deleted" }))).toMatchObject({ kind: "deleted", sides: ["old"] });
    expect(binaryFileView(page(), meta({ change: "modified" }))).toMatchObject({ kind: "modified", sides: ["old", "new"] });
    // No list row at all: the patch header still says which it is.
    expect(binaryFileView(page({ patch: `new file mode 100644\n${BINARY_PATCH}` }))?.kind).toBe("added");
    expect(binaryFileView(page({ patch: `deleted file mode 100644\n${BINARY_PATCH}` }))?.kind).toBe("deleted");
  });

  it("shows a rename that kept its bytes once, and says so", () => {
    const view = binaryFileView(
      page({ patch: "diff --git a/src/old.png b/src/logo.png\nsimilarity index 100%\nrename from src/old.png\nrename to src/logo.png\n", status: "binary" }),
      meta({ oldPath: "src/old.png" }),
    );
    expect(view).toMatchObject({ kind: "renamed", bytesUnchanged: true, sides: ["new"] });
    expect(sideLabel(view!, "new")).toBe("Moved");
  });

  it("leaves an ordinary patch alone", () => {
    expect(binaryFileView(page({ status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" }), meta({ status: "modified" }))).toBeNull();
  });

  it("writes the alt text, the labels and the delta a person can read", () => {
    const view = binaryFileView(page(), meta())!;
    expect(imageAltText(view, "new")).toBe("src/logo.png, after");
    expect(imageAltText(view, "old")).toBe("src/logo.png, before");
    expect(sideLabel(view, "old")).toBe("Before");
    expect(byteDelta(1000, 1400)).toBe("+400 B");
    expect(byteDelta(1400, 1000)).toBe("−400 B");
    expect(byteDelta(1000, 1000)).toBe("same size");
    expect(fileFormatWord("vendor/body.woff2")).toBe("WOFF2");
    expect(fileFormatWord("LICENSE")).toBe("binary");
  });
});

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

describe("the image body", () => {
  it("draws both sides of a modified image, with sizes, dimensions and the delta", async () => {
    const view = binaryFileView(page(), meta({ change: "modified" }))!;
    const calls = mount(view, {
      old: blob({ ref: "HEAD", data: RED_16, width: 16, height: 16 }),
      new: blob({ data: BLUE_32, width: 32, height: 24 }),
    });
    await settle();

    expect(img("src/logo.png, before")).not.toBeNull();
    expect(img("src/logo.png, after")).not.toBeNull();
    expect(img("src/logo.png, after")?.src).toBe(created[1] ?? created[0]);
    expect(text()).toContain("16 × 16");
    expect(text()).toContain("32 × 24");
    expect(text()).toContain("Before");
    expect(text()).toContain("After");
    // 79 B before, 93 B after: both sizes and the delta between them.
    expect(text()).toContain("79 B");
    expect(text()).toContain("93 B");
    expect(text()).toContain("+14 B");
    expect(calls.map((call) => call.side).sort()).toEqual(["new", "old"]);
    expect(host.querySelector("[data-slot='changes-binary']")?.getAttribute("data-layout")).toBe("split");
  });

  it("draws an added image once, as the after side, and never asks for a side that does not exist", async () => {
    const view = binaryFileView(page(), meta({ change: "added" }))!;
    const calls = mount(view, { new: blob({ data: RED_16, width: 16, height: 16 }) });
    await settle();

    expect(img("src/logo.png, after")).not.toBeNull();
    expect(img("src/logo.png, before")).toBeNull();
    expect(text()).toContain("Added");
    expect(text()).toContain("was added in this scope, at 79 B");
    expect(calls.every((call) => call.side === "new")).toBe(true);
  });

  it("draws a deleted image as the side that is going away", async () => {
    const view = binaryFileView(page(), meta({ change: "deleted" }))!;
    const calls = mount(view, { old: blob({ ref: "HEAD", data: RED_16, width: 16, height: 16 }) });
    await settle();

    expect(img("src/logo.png, before")).not.toBeNull();
    expect(img("src/logo.png, after")).toBeNull();
    expect(text()).toContain("Deleted");
    expect(text()).toContain("was deleted in this scope, at 79 B");
    expect(calls.every((call) => call.side === "old")).toBe(true);
  });

  it("stacks the two sides in unified view and lays them out in split", async () => {
    const view = binaryFileView(page(), meta())!;
    mount(view, { old: blob({ data: RED_16 }), new: blob({ data: BLUE_32 }) }, "unified");
    await settle();
    expect(host.querySelector("[data-slot='changes-binary']")?.getAttribute("data-layout")).toBe("unified");
    expect(host.querySelectorAll("[data-slot='changes-image-side']").length).toBe(2);
    // Stacked, the pair can be taller than the body: the scroll box is a
    // focusable, named region so a keyboard can move it.
    const scroller = host.querySelector<HTMLElement>('[role="region"]');
    expect(scroller?.tabIndex).toBe(0);
    expect(scroller?.getAttribute("aria-label")).toBe("src/logo.png, before and after");
    // Split lays them out instead, and has nothing to scroll.
    mount(binaryFileView(page(), meta())!, { old: blob({ data: RED_16 }), new: blob({ data: BLUE_32 }) }, "split");
    await settle();
    expect(host.querySelector('[role="region"]')).toBeNull();
  });

  it("states the size instead of the picture above the cap, and does not call it a failure", async () => {
    const view = binaryFileView(page(), meta({ change: "added" }))!;
    mount(view, {
      new: blob({ totalBytes: FILE_BLOB_MAX_BYTES + 1, bytes: 0, truncated: true, refused: "too-large" }),
    });
    await settle();

    expect(img("src/logo.png, after")).toBeNull();
    expect(text()).toContain("4.0 MB");
    expect(text()).toContain("over the 4.0 MB this window draws");
    expect(text()).not.toContain("Could not read this file");
  });

  it("pages a large image in and hands the renderer one blob", async () => {
    const view = binaryFileView(page(), meta({ change: "added" }))!;
    const half = RED_16.slice(0, 56);
    const rest = RED_16.slice(56);
    const total = rawBytes(RED_16);
    const firstBytes = rawBytes(half);
    const pages: FileBytesPage[] = [
      blob({ data: half, totalBytes: total, bytes: firstBytes, next: firstBytes, truncated: true }),
      blob({ data: rest, totalBytes: total, offset: firstBytes, bytes: total - firstBytes, truncated: false }),
    ];
    const calls: SideCall[] = [];
    setChangesAdapter({
      listChanges: async () => ({ scope: { kind: "uncommitted" }, repos: [] }),
      getFileDiff: async () => page(),
      async getFileBytes(_scope, _repo, path, side, options) {
        const offset = options?.offset ?? 0;
        calls.push({ path, side, offset });
        return pages[offset === 0 ? 0 : 1]!;
      },
    });
    act(() => {
      root.render(<BinaryFileBody view={view} scope={{ kind: "uncommitted" }} diffStyle="split" />);
    });
    await settle();

    expect(calls.map((call) => call.offset)).toEqual([0, firstBytes]);
    expect(img("src/logo.png, after")).not.toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("revokes the picture's object URL when the modal closes", async () => {
    const view = binaryFileView(page(), meta({ change: "added" }))!;
    mount(view, { new: blob({ data: RED_16 }) });
    await settle();
    expect(created).toHaveLength(1);
    act(() => root.unmount());
    root = createRoot(host);
    expect(revoked).toEqual(created);
  });

  it("says a side could not be read without blaming the person or claiming the file is broken", async () => {
    const view = binaryFileView(page(), meta({ change: "added" }))!;
    setChangesAdapter({
      listChanges: async () => ({ scope: { kind: "uncommitted" }, repos: [] }),
      getFileDiff: async () => page(),
      getFileBytes: async () => {
        throw new Error("boom");
      },
    });
    act(() => {
      root.render(<BinaryFileBody view={view} scope={{ kind: "uncommitted" }} diffStyle="split" />);
    });
    await settle();
    expect(text()).toContain("could not be read just now");
    expect(text()).not.toContain("Could not read this file");
  });
});

/* ------------------------------------------------------------------ */
/* A binary that is not an image                                       */
/* ------------------------------------------------------------------ */

describe("a binary that is not an image", () => {
  it("states what changed and both sizes, and never reads like a failure", async () => {
    const font = page({ path: "vendor/body.woff2", patch: BINARY_PATCH.replaceAll("src/logo.png", "vendor/body.woff2") });
    const view = binaryFileView(font, meta({ path: "vendor/body.woff2", change: "modified" }))!;
    expect(view.mediaType).toBeUndefined();
    mount(view, {
      old: blob({ path: "vendor/body.woff2", ref: "HEAD", mediaType: "application/octet-stream", totalBytes: 48_000, refused: "not-an-image" }),
      new: blob({ path: "vendor/body.woff2", mediaType: "application/octet-stream", totalBytes: 50_000, refused: "not-an-image" }),
    });
    await settle();

    expect(text()).toContain("Changed");
    expect(text()).toContain("went from 47 KB to 49 KB");
    expect(text()).toContain("A WOFF2 file has no lines to compare");
    expect(text()).not.toContain("Could not read");
    expect(host.querySelectorAll("img").length).toBe(0);
  });
});
