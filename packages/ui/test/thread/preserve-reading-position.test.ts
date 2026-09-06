// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { preserveReadingPosition } from "../../src/components/thread/preserve-reading-position.js";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("keeps the visible message at the same screen position after content above changes", () => {
  const viewport = document.createElement("div");
  const message = document.createElement("div");
  message.dataset.messageId = "visible";
  viewport.append(message); document.body.append(viewport);
  Object.defineProperties(viewport, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  viewport.scrollTop = 400;
  let messageTop = 420;
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => ({ top: 0 } as DOMRect));
  vi.spyOn(message, "getBoundingClientRect").mockImplementation(() => ({ top: messageTop - viewport.scrollTop, bottom: messageTop - viewport.scrollTop + 100, height: 100 } as DOMRect));
  const stop = preserveReadingPosition(viewport);
  messageTop += 300;
  viewport.dispatchEvent(new Event("scroll"));
  expect(viewport.scrollTop).toBe(700);
  expect(message.getBoundingClientRect().top).toBe(20);
  // Real user scrolling immediately takes control again.
  viewport.dispatchEvent(new Event("wheel"));
  viewport.scrollTop = 600;
  viewport.dispatchEvent(new Event("scroll"));
  expect(viewport.scrollTop).toBe(600);
  expect(viewport.style.overflowAnchor).toBe("");
  stop();
});

it("starts the animation window after a slow React commit, not at the menu click", () => {
  const viewport = document.createElement("div");
  document.body.append(viewport);
  document.documentElement.style.setProperty("--motion-fast", "150ms");
  let nextFrame: FrameRequestCallback = () => {};
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { nextFrame = callback; return 1; });
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const stop = preserveReadingPosition(viewport);
  // React commits 500ms later; the CSS transition only begins now.
  for (const time of [500, 516, 532]) {
    now.mockReturnValue(time);
    nextFrame(time);
  }
  expect(viewport.style.overflowAnchor).toBe("none");
  for (const time of [660, 676, 692]) {
    now.mockReturnValue(time);
    nextFrame(time);
  }
  expect(viewport.style.overflowAnchor).toBe("");
  stop();
  document.documentElement.style.removeProperty("--motion-fast");
});
