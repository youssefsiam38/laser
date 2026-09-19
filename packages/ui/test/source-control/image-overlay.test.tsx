// @vitest-environment happy-dom
/**
 * The whole modal, opening the file the person opened (M20-T5).
 *
 * What they got was the text path's dead end — "Could not read this file ·
 * This file has no textual diff to show." — because the patch for a binary
 * file carries no hunks. The modal now routes that file to the image body
 * before the renderer is ever asked for it, and the lazy renderer chunk is
 * not loaded at all for a picture.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import {
  ChangesOverlayHost,
  openChanges,
  resetChangesAdapter,
  resetChangesUi,
  setChangesAdapter,
} from "../../src/source-control/index.js";
import { createMockAdapter } from "../../src/source-control/mock.js";

/** The renderer is mocked at the same seam `overlay.test` mocks it. */
const drawn: string[] = [];
vi.mock("../../src/source-control/diff-body.js", () => ({
  DiffBody: ({ page }: { page: { path: string } }) => {
    drawn.push(page.path);
    return <div data-slot="diff-body">{page.path}</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window.HTMLImageElement.prototype, "complete", { configurable: true, get: () => false });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:overlay-image");
  globalThis.URL.revokeObjectURL = vi.fn();
  drawn.length = 0;
  resetChangesUi();
  resetChangesAdapter();
  setChangesAdapter(createMockAdapter());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetChangesUi();
  resetChangesAdapter();
  vi.restoreAllMocks();
});

async function openImage() {
  await act(async () => root.render(
    <TooltipProvider>
      <ChangesOverlayHost />
    </TooltipProvider>,
  ));
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/logo.png" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("opens a changed picture as the picture, not as a sentence about git", async () => {
  await openImage();
  const surface = document.querySelector<HTMLElement>('[data-slot="changes-overlay"]')!;
  const body = surface.querySelector<HTMLElement>('[data-slot="changes-binary"]');
  expect(body).toBeTruthy();
  expect(body!.dataset.media).toBe("image/png");
  expect(surface.textContent).not.toContain("Could not read this file");
  expect(surface.textContent).not.toContain("no textual diff");
  // Both ends of the mock's change, each with its own size and pixel size.
  expect(surface.querySelector('img[alt="src/logo.png, before"]')).toBeTruthy();
  expect(surface.querySelector('img[alt="src/logo.png, after"]')).toBeTruthy();
  expect(surface.textContent).toContain("16 × 16");
  expect(surface.textContent).toContain("32 × 24");
  // And the text renderer was never asked to draw it.
  expect(drawn).toEqual([]);
  expect(surface.querySelector('[data-slot="diff-body"]')).toBeNull();
});

it("still draws a text file through the renderer, unchanged", async () => {
  await act(async () => root.render(
    <TooltipProvider>
      <ChangesOverlayHost />
    </TooltipProvider>,
  ));
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(drawn).toEqual(["src/body-range.ts"]);
  expect(document.querySelector('[data-slot="changes-binary"]')).toBeNull();
});
