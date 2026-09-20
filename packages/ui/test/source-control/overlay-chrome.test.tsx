// @vitest-environment happy-dom
/**
 * The overlay mounted exactly the way `App.tsx` mounts it: `ChangesOverlayHost`
 * on its own, with no ambient `TooltipProvider` anywhere above it.
 *
 * The app mounts the host as a sibling of `Shell`, and `Shell` is where the
 * app's `TooltipProvider` lives — so every tooltip the overlay draws (the
 * toolbar's icon buttons, the find bar's stepper) had no provider and Radix
 * threw "`Tooltip` must be used within `TooltipProvider`", which took the whole
 * window into the error boundary. The overlay owns its own provider now; this
 * file is the test that would have caught it, so it must never mount a
 * provider of its own.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  ChangesOverlayHost,
  openChanges,
  resetChangesAdapter,
  resetChangesUi,
  setChangesAdapter,
} from "../../src/source-control/index.js";
import { createMockAdapter } from "../../src/source-control/mock.js";

vi.mock("../../src/source-control/diff-body.js", () => ({
  DiffBody: ({ page }: { page: { path: string } }) => <div data-slot="diff-body">{page.path}</div>,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

/** No provider, no wrapper: what `App.tsx` renders. */
async function mount() {
  await act(async () => root.render(<ChangesOverlayHost />));
}

async function open(args: Parameters<typeof openChanges>[0] = { scope: { kind: "session" } }) {
  await act(async () => {
    openChanges(args);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function overlay(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="changes-overlay"]');
  expect(node).toBeTruthy();
  return node!;
}

it("draws toolbar, tabs, rail and body with no ambient tooltip provider", async () => {
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args[0]);
  });

  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });

  expect(overlay().querySelector('[data-slot="changes-toolbar"]')).toBeTruthy();
  expect(overlay().querySelector('[data-slot="changes-rail"]')).toBeTruthy();
  expect(overlay().querySelector('[data-slot="changes-tabs"]')).toBeTruthy();
  expect(overlay().querySelector('[data-slot="diff-body"]')?.textContent).toBe("src/body-range.ts");
  // The close button's accessible name comes from its tooltip, so a tooltip
  // really did render inside the portal.
  expect(overlay().querySelector('[aria-label="Close"]')).toBeTruthy();
  expect(errors.map(String).join("\n")).not.toMatch(/TooltipProvider/);
  spy.mockRestore();
});

it("draws the find bar's tooltip buttons with no ambient tooltip provider", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
  await act(async () => {
    overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  });
  const find = overlay().querySelector('[data-slot="conversation-search"]');
  expect(find).toBeTruthy();
  expect(find?.querySelector('[aria-label="Next match"]')).toBeTruthy();
});

/* -------------------------------------------------------------------------
 * The tab strip
 * ---------------------------------------------------------------------- */

function tabs(): HTMLElement[] {
  return [...overlay().querySelectorAll<HTMLElement>('[role="tab"]')];
}

it("closes a tab with the pointer and from the keyboard, and keeps the name typed", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/transcript-viewport.tsx" });
    await Promise.resolve();
  });
  expect(tabs()).toHaveLength(2);
  expect(overlay().querySelector('[data-slot="changes-tabs"]')?.className).toMatch(/\boverscroll-contain\b/);

  // The name is mono and keeps its extension even when the stem ellipsizes.
  const selected = tabs().find((tab) => tab.getAttribute("aria-selected") === "true")!;
  expect(selected.textContent).toContain("transcript-viewport.tsx");
  const typed = [...selected.querySelectorAll("span")].filter((span) => span.className.includes("typed"));
  expect(typed.length).toBeGreaterThan(0);

  // Pointer: the close control is a real button, not a span pretending.
  const close = overlay().querySelector<HTMLButtonElement>('[aria-label="Close transcript-viewport.tsx"]');
  expect(close?.tagName).toBe("BUTTON");
  expect(close?.getAttribute("tabindex")).toBeNull();
  await act(async () => {
    close!.focus();
  });
  expect(document.activeElement).toBe(close);
  await act(async () => close!.click());
  expect(tabs()).toHaveLength(1);

  // Keyboard: Ctrl+W closes the active tab without touching the pointer.
  await act(async () =>
    overlay().dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true })),
  );
  expect(overlay().querySelector('[data-slot="changes-tabs"]')).toBeNull();
});

it("selects a tab with the pointer and moves the selected state with it", async () => {
  await mount();
  await open({ scope: { kind: "session" }, repo: "app", path: "src/body-range.ts" });
  await act(async () => {
    openChanges({ scope: { kind: "session" }, repo: "app", path: "src/transcript-viewport.tsx" });
    await Promise.resolve();
  });
  const first = tabs().find((tab) => tab.textContent?.includes("body-range"))!;
  expect(first.getAttribute("aria-selected")).toBe("false");
  await act(async () => (first as HTMLButtonElement).click());
  expect(first.getAttribute("aria-selected")).toBe("true");
  expect(first.getAttribute("aria-controls")).toBe("changes-diff-panel");
});

/* -------------------------------------------------------------------------
 * The rail
 * ---------------------------------------------------------------------- */

it("draws the tree with hairline rails, a quiet tick that answers pointer and keyboard", async () => {
  await mount();
  await open({ scope: { kind: "session" } });
  const rail = overlay().querySelector<HTMLElement>('[data-slot="changes-rail"]')!;
  const list = rail.querySelector<HTMLElement>('[data-slot="changes-rail-scroll"]')!;
  expect(list.tabIndex).toBe(0);
  expect(list.className).toMatch(/\boverflow-y-auto\b/);
  expect(list.className).toMatch(/\boverscroll-contain\b/);
  const tree = rail.querySelector('[role="tree"]')!;
  const items = [...tree.querySelectorAll('[role="treeitem"]')];
  expect(items.length).toBeGreaterThan(0);
  // A nested row draws one hairline rail per level of depth.
  const nested = items.find((item) => Number(item.getAttribute("aria-level")) > 1)!;
  expect(nested).toBeTruthy();
  expect(nested.querySelectorAll(".hairline-s").length).toBe(Number(nested.getAttribute("aria-level")) - 1);

  const tick = rail.querySelector<HTMLButtonElement>('[aria-label="Mark body-range.ts as viewed on this device"]')!;
  expect(tick.getAttribute("aria-pressed")).toBe("false");
  expect(tick.className).toContain("opacity-0");
  await act(async () => {
    tick.focus();
    tick.click();
  });
  const on = rail.querySelector<HTMLButtonElement>('[aria-label="Mark body-range.ts as unread"]')!;
  expect(on.getAttribute("aria-pressed")).toBe("true");
  expect(on.className).toContain("opacity-100");
});

/* -------------------------------------------------------------------------
 * The body states
 * ---------------------------------------------------------------------- */

async function noticeLines(args: Parameters<typeof openChanges>[0]): Promise<string[]> {
  await act(async () => {
    openChanges(args);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const notice = overlay().querySelector('[data-slot="changes-notice"]');
  expect(notice).toBeTruthy();
  return [...notice!.querySelectorAll("p")].map((line) => line.textContent?.trim() ?? "").filter(Boolean);
}

it("says what happened and what it means in every designed state", async () => {
  await mount();
  for (const args of [
    // A picture is drawn rather than described (M20-T5); the written state is
    // the one for a binary this app cannot draw, which is this file.
    { scope: { kind: "session" } as const, repo: "app", path: "src/bundle.wasm" },
    { scope: { kind: "session" } as const, repo: "app", path: "src/moved.ts" },
    { scope: { kind: "session" } as const, repo: "app", path: "src/script.sh" },
    { scope: { kind: "session" } as const, repo: "app", path: "src/huge.ts" },
    { scope: { kind: "range", from: "abc", to: "abc" } as const },
    { scope: { kind: "agent", runId: "run-gone" } as const },
  ]) {
    const lines = await noticeLines(args);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.endsWith(".")).toBe(true);
  }
});
