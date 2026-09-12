// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useFooterAnchor, type FooterAnchor } from "../src/components/mobile/use-footer-anchor.js";
import { themeStore } from "../src/theme/store.js";

it("remeasures a same-size footer after live direction changes without remounting it", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const frame = async () => act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
  const footer = document.createElement("div");
  footer.dataset.slot = "thread-footer";
  // Model the browser layout boundary, not a resize: only x changes.
  vi.spyOn(footer, "getBoundingClientRect").mockImplementation(() =>
    new DOMRect(document.documentElement.dir === "rtl" ? 674 : 368, 659, 318, 241));
  const container = document.createElement("div");
  document.body.append(footer, container);
  let anchor: FooterAnchor | undefined;
  function NoticeAnchor() { anchor = useFooterAnchor(); return null; }
  const root = createRoot(container);
  try {
    themeStore.setTextDirection("rtl");
    await act(async () => root.render(<NoticeAnchor />));
    await frame();
    expect(anchor).toMatchObject({ left: 674, width: 318 });
    const bottom = anchor!.bottom;
    await act(async () => themeStore.setTextDirection("ltr"));
    await frame();
    expect(anchor).toEqual({ left: 368, width: 318, bottom });
    await act(async () => themeStore.setTextDirection("rtl"));
    await frame();
    expect(anchor).toEqual({ left: 674, width: 318, bottom });
    expect(document.querySelector('[data-slot="thread-footer"]')).toBe(footer);
  } finally {
    await act(async () => root.unmount());
    footer.remove();
    container.remove();
    vi.restoreAllMocks();
    themeStore.reset();
  }
});
