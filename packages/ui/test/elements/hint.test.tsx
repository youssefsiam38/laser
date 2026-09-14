// @vitest-environment happy-dom
/**
 * M16-T48 / review #49: the native `title` attribute has no keyboard path and
 * no touch path, and where it repeated an `aria-label` it gave one thing two
 * names. Every hint in the transcript, the project line, the goal and the
 * fleet now goes through the app's tooltip. These are interaction tests: the
 * information must actually arrive by focus and by tap.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlHint, Hint } from "../../src/components/ui/hint.js";
import { Button } from "../../src/components/ui/button.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode) => act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
const tooltipText = () =>
  [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((node) => node.textContent).join(" ");

describe("a hint on something that is not a control", () => {
  it("opens for the keyboard and for a tap, and leaves no browser tooltip behind", async () => {
    await render(
      <Hint hint="3 ahead, 1 behind origin/main">
        <span>3</span>
      </Hint>,
    );
    const hint = container.querySelector<HTMLElement>('[data-slot="hint"]')!;
    expect(hint.getAttribute("title")).toBeNull();
    // Reachable by keyboard at all: a hint nobody can focus is a hint nobody
    // who does not use a mouse ever sees.
    expect(hint.tabIndex).toBe(0);
    expect(tooltipText()).not.toContain("3 ahead");

    await act(async () => hint.focus());
    expect(tooltipText()).toContain("3 ahead, 1 behind origin/main");

    await act(async () => hint.blur());
    expect(tooltipText()).not.toContain("3 ahead");

    // Touch: Radix dismisses on the pointer press, so the tap itself has to be
    // what opens it. This is the phone path for every one of these hints.
    await act(async () => {
      hint.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
      hint.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch" }));
      hint.click();
    });
    expect(tooltipText()).toContain("3 ahead, 1 behind origin/main");
  });

  it("describes, and never renames: the hint is not repeated as an accessible name", async () => {
    await render(
      <Hint hint="Lines changed since this session opened">
        <span>+12</span>
      </Hint>,
    );
    const hint = container.querySelector<HTMLElement>('[data-slot="hint"]')!;
    expect(hint.getAttribute("aria-label")).toBeNull();
    await act(async () => hint.focus());
    expect(hint.getAttribute("aria-describedby")).not.toBeNull();
  });
});

describe("a hint on a control", () => {
  it("keeps the control's own focus and adds no second tab stop", async () => {
    await render(
      <ControlHint hint="The session whose agent ran this command">
        <Button>Open its session</Button>
      </ControlHint>,
    );
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("title")).toBeNull();
    expect(container.querySelector('[data-slot="hint"]')).toBeNull();

    await act(async () => button.focus());
    expect(tooltipText()).toContain("The session whose agent ran this command");
  });

  it("renders the control alone when there is nothing more to say", async () => {
    await render(
      <ControlHint hint={undefined}>
        <Button>Open chat</Button>
      </ControlHint>,
    );
    const button = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.focus());
    expect(tooltipText()).toBe("");
    expect(button.textContent).toBe("Open chat");
  });
});
