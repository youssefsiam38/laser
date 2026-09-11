// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/runtime", () => ({
  useLaserStable: () => ({ client: { request: async () => ({}) }, actions: {} }),
}));
import { SettingsScreen } from "../../src/components/settings/SettingsScreen.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { click, render } from "./mcp/harness.js";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reveals the active tab on selection and whenever its strip narrows, without motion", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { callbacks.set(element, this.callback); }
    unobserve(element: Element) { callbacks.delete(element); }
    disconnect() { for (const [element, callback] of callbacks) if (callback === this.callback) callbacks.delete(element); }
  });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  ({ root } = await render(<TooltipProvider><SettingsScreen cwd={undefined} initialTab="mcp" /></TooltipProvider>));
  const active = () => document.querySelector<HTMLElement>('[aria-current="page"]')!;
  expect(scroll.mock.instances.at(-1)).toBe(active());
  const strip = active().parentElement!;
  strip.style.width = "240px";
  await act(async () => callbacks.get(strip)!([], {} as ResizeObserver));
  expect(scroll.mock.instances.at(-1)).toBe(active());
  expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest", behavior: "auto" });
  await click("Advanced");
  expect(scroll.mock.instances.at(-1)).toBe(active());
  expect(active().textContent).toBe("Advanced");
  await act(async () => root!.unmount());
  root = undefined;
  expect(callbacks.has(strip)).toBe(false);
});
