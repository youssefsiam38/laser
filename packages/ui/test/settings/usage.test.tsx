// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/store.js";
const mocks = vi.hoisted(() => ({ view: undefined as SessionView | undefined, refresh: vi.fn(), request: vi.fn().mockResolvedValue({ entries: [] }) }));
vi.mock("../../src/runtime/index.js", () => ({ useLaserView: () => mocks.view, useLaserStable: () => ({ actions: { refreshAccountUsage: mocks.refresh }, client: { request: mocks.request, subscribe: () => () => {} } }) }));
import { UsageTab } from "../../src/components/settings/UsageTab.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.view = undefined; mocks.refresh.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("shows the full dynamic snapshot and credits with the existing refresh action", async () => {
  mocks.view = { state: { accountUsage: { status: "ready", provider: "openai-codex", snapshot: { fetchedAt: new Date().toISOString(), windows: [
    { kind: "primary", limitId: "base_model_inference", limitName: "gpt-reserve", usedPercent: 10 },
    { kind: "primary", limitId: "future", limitName: "Future allowance", usedPercent: 0 },
  ], credits: { hasCredits: true, unlimited: false, balance: "12.50" } } } } } as SessionView;
  await act(async () => root.render(<TooltipProvider><UsageTab /></TooltipProvider>));
  expect(container.textContent).toContain("gpt-reserve");
  expect(container.textContent).toContain("Future allowance");
  expect(container.textContent).toContain("12.50");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh account allowance"]')!.click());
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it("explains the source needed before any session exists", async () => {
  await act(async () => root.render(<TooltipProvider><UsageTab /></TooltipProvider>));
  expect(container.textContent).toContain("Open a session with a connected account provider");
  expect(container.querySelector('[aria-label="Refresh account allowance"]')).toBeNull();
});
