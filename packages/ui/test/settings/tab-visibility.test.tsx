// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const request = vi.fn(async () => ({}));
  return {
    request,
    denied: new Set<string>(),
    stable: { client: { request }, actions: {}, projects: [], projectInfo: {} },
  };
});
vi.mock("@/runtime", () => ({
  useCapability: (method: string) => runtime.denied.has(method) ? { state: "hidden" } : { state: "available" },
  useLaserStable: () => runtime.stable,
}));
vi.mock("../../src/components/settings/resources/ResourceDiagnostics.js", () => ({
  ResourceDiagnostics: () => <div>Resource diagnostics</div>,
}));
import { SettingsScreen } from "../../src/components/settings/SettingsScreen.js";
import { WorkbenchProvider } from "../../src/components/workbench/index.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { click, render } from "./mcp/harness.js";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = "";
  runtime.denied.clear();
  runtime.request.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reveals a selected tab without moving a manually browsed strip or an active pointer gesture", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { callbacks.set(element, this.callback); }
    unobserve(element: Element) { callbacks.delete(element); }
    disconnect() { for (const [element, callback] of callbacks) if (callback === this.callback) callbacks.delete(element); }
  });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  ({ root } = await render(<TooltipProvider><WorkbenchProvider><SettingsScreen initialTab="mcp" /></WorkbenchProvider></TooltipProvider>));
  const active = () => document.querySelector<HTMLElement>('[aria-current="page"]')!;
  expect(scroll.mock.instances.at(-1)).toBe(active());
  const strip = active().parentElement!;
  let selectedVisible = true;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this === strip) return { left: 0, right: 240 } as DOMRect;
    if (this === active()) return selectedVisible ? { left: 40, right: 130 } as DOMRect : { left: -90, right: 0 } as DOMRect;
    return { left: 0, right: 0 } as DOMRect;
  });

  strip.dispatchEvent(new Event("scroll"));
  const beforeResize = scroll.mock.calls.length;
  await act(async () => callbacks.get(strip)!([], {} as ResizeObserver));
  expect(scroll.mock.calls.length).toBe(beforeResize + 1);
  expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest", behavior: "auto" });

  selectedVisible = false;
  strip.dispatchEvent(new Event("scroll"));
  const beforeBrowsedResize = scroll.mock.calls.length;
  await act(async () => callbacks.get(strip)!([], {} as ResizeObserver));
  expect(scroll.mock.calls.length).toBe(beforeBrowsedResize);

  selectedVisible = true;
  strip.dispatchEvent(new Event("scroll"));
  strip.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const beforeGestureResize = scroll.mock.calls.length;
  await act(async () => callbacks.get(strip)!([], {} as ResizeObserver));
  expect(scroll.mock.calls.length).toBe(beforeGestureResize);
  strip.dispatchEvent(new Event("click", { bubbles: true }));

  await click("Advanced");
  expect(scroll.mock.instances.at(-1)).toBe(active());
  expect(active().textContent).toBe("Advanced");
  await act(async () => root!.unmount());
  root = undefined;
  expect(callbacks.has(strip)).toBe(false);
});

it("hides host-backed settings sections before they can issue a denied request", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  runtime.denied = new Set([
    "pi/settings/get", "feature/list", "mcp/list", "pi/providers/list",
    "pi/account-usage/refresh", "pi/project/list", "resource/snapshot",
  ]);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  ({ root } = await render(<TooltipProvider><WorkbenchProvider><SettingsScreen initialTab="general" /></WorkbenchProvider></TooltipProvider>));
  await act(async () => { await Promise.resolve(); });
  const tabs = [...document.querySelectorAll('[aria-current], button')].map((node) => node.textContent?.trim()).filter(Boolean);
  expect(tabs).toContain("Appearance");
  expect(tabs).toContain("Help and shortcuts");
  expect(tabs).toContain("This device");
  expect(tabs).not.toContain("General");
  expect(tabs).not.toContain("Advanced");
  expect(tabs).not.toContain("Features");
  expect(tabs).not.toContain("MCP servers");
  expect(tabs).not.toContain("Providers and models");
  expect(runtime.request).not.toHaveBeenCalled();
});
