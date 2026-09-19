// @vitest-environment happy-dom
/**
 * Every shared overlay leaves the document when it closes.
 *
 * The defect: Radix `Presence` keeps a closing element mounted until an
 * `animationend` arrives, and decides to wait from the computed
 * `animation-name` alone. A zero-duration animation — what
 * `duration-(--motion-instant)` compiled to with Motion reduced — still reads
 * `animation-name: exit` while the engine creates no animation for it, so no
 * event is ever delivered and the closed dialog stays painted over the page
 * with its buttons live. Measured in Chromium: `0s` → `getAnimations()` is
 * `[]` and neither `animationstart` nor `animationend` ever fires; `150ms` →
 * one running animation and both events.
 *
 * The root fix is the token (`--motion-off`, `src/globals.css` and
 * `src/theme/compile.ts`): with Motion reduced the closed state carries no
 * animation at all, so `Presence` unmounts at once. These tests stand in the
 * browser *without* that fix — `animation-name` follows `data-state` and no
 * event is ever delivered — and prove the floor underneath it,
 * `useExitPresence`, which every shared surface now carries.
 *
 * And they prove the other half: when an exit really is animating, nothing is
 * cut short. The element stays through its fade and leaves on its own event.
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
import { Popover, PopoverContent, PopoverTrigger } from "../../src/components/ui/popover.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../src/components/ui/sheet.js";
import { EXIT_FALLBACK_MS, EXIT_SLACK_MS, exitWindowMs } from "../../src/components/ui/exit-presence.js";

let container: HTMLDivElement;
let root: Root;

const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  await act(async () => settle(0));
  await act(async () => settle(0));
  await act(async () => settle(0));
};
/** Past any window the guard can be waiting on, with room to spare. */
const afterExit = async () => {
  await act(async () => settle(EXIT_FALLBACK_MS + EXIT_SLACK_MS + 80));
  await flush();
};

/** What the browser says it is animating on the closing element. */
let running: { playState: string }[] = [];

/**
 * A browser whose computed `animation-name` follows `data-state`. `duration`
 * is what the stylesheet claims; `running` above is what the engine actually
 * has. The zero-duration bug is the pair ("exit", "0s", nothing running).
 */
const standInForABrowser = (duration: string) => {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(((element: Element, pseudo?: string | null) => {
    const styles = real(element as HTMLElement, pseudo ?? null);
    if (!(element instanceof HTMLElement) || !element.hasAttribute("data-state")) return styles;
    return new Proxy(styles, {
      get(target, property) {
        if (property === "animationName") {
          return element.getAttribute("data-state") === "closed" ? "exit" : "enter";
        }
        if (property === "animationDuration") return duration;
        if (property === "animationDelay") return "0s";
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle);
  vi.spyOn(Element.prototype, "getAnimations").mockImplementation(function (this: Element) {
    return (this instanceof HTMLElement && this.getAttribute("data-state") === "closed"
      ? running
      : []) as unknown as Animation[];
  });
};

/** The real end of a real exit animation. */
const endAnimationOn = (selector: string) => {
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    node.dispatchEvent(new AnimationEvent("animationend", { animationName: "exit" }));
  }
};

function DialogHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-slot="host-open" onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-slot="host-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>A dialog</DialogTitle>
            <DialogDescription>It has to go away.</DialogDescription>
          </DialogHeader>
          <button type="button" data-slot="host-close" onClick={() => setOpen(false)}>Cancel</button>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SheetHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-slot="host-open" onClick={() => setOpen(true)}>Open</button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>A sheet</SheetTitle>
          </SheetHeader>
          <button type="button" data-slot="host-close" onClick={() => setOpen(false)}>Cancel</button>
        </SheetContent>
      </Sheet>
    </>
  );
}

function PopoverHost() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger data-slot="host-open">Open</PopoverTrigger>
      <PopoverContent>
        <button type="button" data-slot="host-close" onClick={() => setOpen(false)}>Cancel</button>
      </PopoverContent>
    </Popover>
  );
}

const overlays = () => [
  ...document.querySelectorAll(
    '[role="dialog"],[data-slot="dialog-overlay"],[data-slot="sheet-overlay"],[data-slot="popover-content"]',
  ),
];
const click = async (slot: string) => {
  await act(async () => document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!.click());
  await flush();
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  running = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  for (const node of overlays()) node.remove();
});

const mount = async (node: React.ReactElement) => {
  await act(async () => root.render(node));
  await flush();
};

describe("an exit animation that never ends (Motion reduced)", () => {
  it("still lets the dialog leave the document, on Cancel", async () => {
    standInForABrowser("0s");
    await mount(<DialogHost />);
    await click("host-open");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await click("host-close");
    await afterExit();
    expect(overlays()).toEqual([]);
  });

  it("still lets it leave on Escape, and open again cleanly", async () => {
    standInForABrowser("0s");
    await mount(<DialogHost />);
    await click("host-open");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await afterExit();
    expect(overlays()).toEqual([]);
    await click("host-open");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("leaves nothing at all behind: no dialog, no wash, no portal", async () => {
    standInForABrowser("0s");
    await mount(<DialogHost />);
    await click("host-open");
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(1);
    await click("host-close");
    await afterExit();
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="host-dialog"]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-state]")).toHaveLength(0);
  });

  // The guarantee is the shared component's, so a surface that never heard of
  // this bug inherits it.
  it("lets the sheet and its overlay leave too", async () => {
    standInForABrowser("0s");
    await mount(<SheetHost />);
    await click("host-open");
    expect(document.querySelectorAll('[data-slot="sheet-content"]')).toHaveLength(1);
    await click("host-close");
    await afterExit();
    expect(document.querySelectorAll('[data-slot="sheet-content"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="sheet-overlay"]')).toHaveLength(0);
  });

  it("lets the popover leave too", async () => {
    standInForABrowser("0s");
    await mount(<PopoverHost />);
    await click("host-open");
    expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(1);
    await click("host-close");
    await afterExit();
    expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(0);
  });
});

describe("an exit animation that really plays (Motion on)", () => {
  it("keeps the dialog through its fade and lets the animation end it", async () => {
    standInForABrowser("0.2s");
    running = [{ playState: "running" }];
    await mount(<DialogHost />);
    await click("host-open");
    await click("host-close");

    // Well past the guard's own polling window: a live animation is never
    // cut short, so the fade is still on screen.
    await act(async () => settle(EXIT_SLACK_MS * 3));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    running = [];
    await act(async () => endAnimationOn('[role="dialog"],[data-slot="dialog-overlay"]'));
    await flush();
    expect(overlays()).toEqual([]);
  });

  it("ends it anyway when the animation is over and the event never arrives", async () => {
    standInForABrowser("0.2s");
    running = [{ playState: "running" }];
    await mount(<DialogHost />);
    await click("host-open");
    await click("host-close");
    await act(async () => settle(EXIT_SLACK_MS));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    running = []; // the animation finished; the browser delivered nothing
    await afterExit();
    expect(overlays()).toEqual([]);
  });
});

describe("exitWindowMs", () => {
  it("reads the longest delay + duration a browser can report", () => {
    expect(exitWindowMs("0.2s", "0s")).toBe(200);
    expect(exitWindowMs("200ms", "40ms")).toBe(240);
    expect(exitWindowMs("100ms, 300ms", "0s")).toBe(300);
    expect(exitWindowMs("100ms", "0s, 500ms")).toBe(600);
    expect(exitWindowMs("0s", "0s")).toBe(0);
    expect(exitWindowMs(undefined, undefined)).toBe(0);
    expect(exitWindowMs("nonsense", "")).toBe(0);
  });
});
