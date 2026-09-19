// @vitest-environment happy-dom
/**
 * `useDialogPresence` — the transcript's dialogs leave the document.
 *
 * The hook exists because Radix waits for an `animationend` that a
 * zero-duration exit never sends (`src/components/thread/dialog-presence.ts`).
 * These tests stand in that browser: computed `animation-name` follows
 * `data-state`, and no animation event is ever delivered.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../src/components/ui/dialog.js";
import { DIALOG_EXIT_FALLBACK_MS, dialogExitMs, useDialogPresence } from "../../src/components/thread/dialog-presence.js";

let container: HTMLDivElement;
let root: Root;

const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  await act(async () => settle(0));
  await act(async () => settle(0));
};
const afterExit = async () => {
  await act(async () => settle(DIALOG_EXIT_FALLBACK_MS + 80));
  await flush();
};

const zeroDurationBrowser = () => {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(((element: Element, pseudo?: string | null) => {
    const styles = real(element as HTMLElement, pseudo ?? null);
    if (!(element instanceof HTMLElement) || !element.hasAttribute("data-state")) return styles;
    return new Proxy(styles, {
      get(target, property) {
        if (property === "animationName") return element.getAttribute("data-state") === "closed" ? "exit" : "enter";
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle);
};

function Host() {
  const presence = useDialogPresence();
  const [opened, setOpened] = useState(0);
  return (
    <>
      <button type="button" data-slot="host-open" onClick={() => { setOpened((n) => n + 1); presence.show(); }}>
        Open
      </button>
      <span data-slot="host-opened">{opened}</span>
      {presence.mounted ? (
        <Dialog open={presence.open} onOpenChange={(next) => { if (!next) presence.hide(); }}>
          <DialogContent data-slot="host-dialog" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>A dialog</DialogTitle>
              <DialogDescription>It has to go away.</DialogDescription>
            </DialogHeader>
            <button type="button" data-slot="host-close" onClick={() => presence.hide()}>
              Close
            </button>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  for (const node of dialogs()) node.remove();
});

const mount = async () => {
  await act(async () => root.render(<Host />));
  await flush();
};
const open = async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="host-open"]')!.click());
  await flush();
};
const close = async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="host-close"]')!.click());
};

describe("useDialogPresence", () => {
  it("takes the dialog out even when no exit animation ever ends", async () => {
    zeroDurationBrowser();
    await mount();
    await open();
    expect(dialogs()).toHaveLength(1);
    await close();
    await afterExit();
    expect(dialogs()).toEqual([]);
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(0);
  });

  it("takes it out on Escape too, and opens again cleanly", async () => {
    zeroDurationBrowser();
    await mount();
    await open();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await afterExit();
    expect(dialogs()).toEqual([]);
    await open();
    expect(dialogs()).toHaveLength(1);
    expect(document.querySelector('[data-slot="host-opened"]')?.textContent).toBe("2");
  });

  it("leaves the browser's own exit in charge when it works", async () => {
    // No stand-in: happy-dom reports no animation, which is the path a real
    // browser takes as soon as the exit animation ends.
    await mount();
    await open();
    await close();
    await flush();
    expect(dialogs()).toEqual([]);
  });

  it("waits the motion token's own window, and a sane one when it cannot read it", () => {
    expect(dialogExitMs("75ms")).toBeGreaterThan(75);
    expect(dialogExitMs("0ms")).toBeGreaterThan(0);
    expect(dialogExitMs(undefined)).toBe(DIALOG_EXIT_FALLBACK_MS);
  });
});
