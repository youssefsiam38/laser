// @vitest-environment happy-dom
/**
 * Coming back from a hidden window (M16-T30).
 *
 * The desktop window is hidden, not closed, when a person puts the app away,
 * and Chromium throttles a hidden page's timers to one a second — then to one
 * a minute after five minutes hidden. The renderer no longer opts out of that,
 * so anything driven by a timer has to be correct at the first paint after the
 * window comes back rather than at the next tick.
 *
 * Elapsed durations are read from the clock, so the only thing that can be
 * wrong is when the row re-renders. These fail without the `visibilitychange`
 * catch-up in `timing.ts`: the label stays at the value it had when the window
 * was hidden.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resetTiming, useElapsed, useTick } from "../../src/components/thread/timing.js";

let container: HTMLDivElement;
let root: Root;
let visible: DocumentVisibilityState = "visible";

function Elapsed({ phase }: { phase: "running" | "done" }) {
  const ms = useElapsed("tool-1", phase);
  return <span data-testid="elapsed">{ms === undefined ? "—" : String(ms)}</span>;
}

const show = (next: DocumentVisibilityState): void => {
  visible = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  visible = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
  resetTiming();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shows the real elapsed time the moment a hidden window is shown again", () => {
  act(() => root.render(<Elapsed phase="running" />));
  const label = () => container.querySelector('[data-testid="elapsed"]')?.textContent;
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(label()).toBe("100");

  // The window goes into the tray: six minutes of wall clock pass with no tick
  // delivered, which is what throttling to one wake-up a minute looks like
  // from inside the row. The label is now six minutes out of date.
  show("hidden");
  vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
  expect(label()).toBe("100");

  show("visible");
  expect(label()).toBe("360000");
});

it("does not tick a row that is not running", () => {
  const ticks: number[] = [];
  function Idle() {
    const tick = useTick(false);
    ticks.push(tick);
    return <span>{tick}</span>;
  }
  act(() => root.render(<Idle />));
  show("hidden");
  show("visible");
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(new Set(ticks).size).toBe(1);
});

it("stops listening when the row goes away", () => {
  function Host() {
    const [mounted, setMounted] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setMounted(false)}>
          drop
        </button>
        {mounted ? <Elapsed phase="running" /> : null}
      </>
    );
  }
  act(() => root.render(<Host />));
  act(() => {
    container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.querySelector('[data-testid="elapsed"]')).toBeNull();
  // No listener left to fire into an unmounted tree.
  show("hidden");
  show("visible");
  expect(vi.getTimerCount()).toBe(0);
});
