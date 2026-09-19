// @vitest-environment happy-dom
/**
 * The overlay is a leaf surface: whatever the renderer does, it may not take
 * the window down.
 *
 * Measured in the running app: a hydrated diff whose sides disagreed with the
 * patch made `@pierre/diffs` throw *during render*, React unmounted the whole
 * tree, and the person got "Something went wrong drawing this window" with
 * the conversation, the toolbar and the file list gone. The side mapping is
 * fixed; this is the floor under it, for the throw nobody predicted.
 *
 * The renderer is mocked at the `DiffBody` seam, the same place `overlay.test`
 * mocks it: what is under test is the boundary, not Pierre.
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

/** Files whose body throws while drawing, set per test. */
const throwing = new Set<string>();

vi.mock("../../src/source-control/diff-body.js", () => ({
  DiffBody: ({ page }: { page: { path: string } }) => {
    if (throwing.has(page.path)) {
      throw new Error(`computeEstimatedDiffHeights: trailing context mismatch (additions=1, deletions=2) for ${page.path}`);
    }
    return <div data-slot="diff-body">{page.path}</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;
let errors: string[];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  throwing.clear();
  errors = [];
  // React reports a caught render error on the console; so do we, on purpose.
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
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

async function mount() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <textarea defaultValue="keep this draft" />
        <ChangesOverlayHost />
      </TooltipProvider>,
    ),
  );
}

async function open(path: string) {
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path });
    await Promise.resolve();
    await Promise.resolve();
  });
}

function overlay(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="changes-overlay"]');
  expect(node).toBeTruthy();
  return node!;
}

function failure(): HTMLElement | null {
  return overlay().querySelector<HTMLElement>('[data-slot="changes-draw-failed"]');
}

it("keeps the overlay and the conversation alive when the renderer throws on open", async () => {
  throwing.add("src/body-range.ts");
  await mount();
  await open("src/body-range.ts");

  // The body degrades to a state a person can read and act on.
  expect(failure()?.textContent).toContain("This diff could not be drawn.");
  expect(failure()?.textContent).toMatch(/Pick another file/);
  expect(overlay().querySelector('[data-slot="diff-body"]')).toBeNull();

  // And everything around it is still drawing: the toolbar with its scope,
  // the tab strip, and the file list.
  expect(overlay().querySelector('[data-slot="changes-scope"]')).toBeTruthy();
  expect(overlay().querySelectorAll('[role="tab"]').length).toBeGreaterThan(0);
  expect(overlay().textContent).toContain("body-range.ts");

  // The window itself never went anywhere: the conversation behind the
  // overlay, and the draft in it, are untouched.
  expect(container.querySelector("textarea")?.value).toBe("keep this draft");
  expect(errors.join("\n")).toContain("The diff could not be drawn.");
});

it("clears the failure when another file is selected, and fails again only for the bad one", async () => {
  throwing.add("src/body-range.ts");
  await mount();
  await open("src/body-range.ts");
  expect(failure()).toBeTruthy();

  // A file that draws: the boundary is keyed to the file, so the next one
  // starts clean instead of inheriting the last one's failure.
  await open("src/transcript-viewport.tsx");
  expect(failure()).toBeNull();
  expect(overlay().querySelector('[data-slot="diff-body"]')?.textContent).toBe("src/transcript-viewport.tsx");

  // Back to the bad file: contained again, still inside the overlay.
  await open("src/body-range.ts");
  expect(failure()).toBeTruthy();
  expect(overlay().querySelectorAll('[role="tab"]').length).toBeGreaterThan(1);
});

it("contains a throw that happens on a later selection, not only on mount", async () => {
  await mount();
  await open("src/body-range.ts");
  expect(overlay().querySelector('[data-slot="diff-body"]')?.textContent).toBe("src/body-range.ts");

  // The second file is the one that cannot be drawn. The first file's tab,
  // the rail and the toolbar all survive it.
  throwing.add("src/transcript-viewport.tsx");
  await open("src/transcript-viewport.tsx");
  expect(failure()?.textContent).toContain("This diff could not be drawn.");
  expect(overlay().querySelector('[data-slot="changes-scope"]')).toBeTruthy();
  expect(overlay().textContent).toContain("body-range.ts");
  expect(container.querySelector("textarea")?.value).toBe("keep this draft");

  // Escape still closes the overlay and returns the person to the conversation.
  await act(async () => overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[data-slot="changes-overlay"]')).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe("keep this draft");
});
