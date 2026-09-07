// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WEB_SEARCH_PROVIDERS, type WebSearchChange, type WebSearchStatus } from "@lasercode/protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../src/runtime/index.js", () => { const stable = { client: { request: mocks.request } }; return { useLaserStable: () => stable }; });
import { WebSearchTab } from "../../src/components/settings/WebSearchTab.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
let root: Root, container: HTMLDivElement, status: WebSearchStatus;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  status = { selectedProvider: "duckduckgo", providers: WEB_SEARCH_PROVIDERS.map((p) => ({ id: p.id, source: "none", hasKey: false, configured: p.key !== "required" && !p.endpoint })) };
  mocks.request.mockReset().mockImplementation(async (method: string, params: { change?: WebSearchChange }) => {
    if (method === "web-search/status") return status;
    if (method === "pi/providers/list") return { providers: [{ id: "openai", name: "OpenAI", configured: true }] };
    if (method === "feature/list") return { features: [{ manifest: { id: "web-search" }, globalEnabled: false, enabled: false }] };
    if (method === "feature/set") return { restartPending: false };
    if (method === "web-search/configure") {
      const change = params.change!;
      if (change.action === "configure") status = { ...status, providers: status.providers.map((entry) => entry.id === change.provider ? { ...entry, ...change.connection, configured: change.connection.source === "shared" } : entry) };
      if (change.action === "select" || (change.action === "configure" && change.activate)) status = { ...status, selectedProvider: change.provider };
      return status;
    }
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<TooltipProvider><WebSearchTab cwd="/project" /></TooltipProvider>)); }
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text || button.getAttribute("aria-label") === text)!;
  expect(button, text).toBeDefined(); await act(async () => button.click());
}
it("requires an explicit sharing action and can revoke without model logout", async () => {
  await render();
  const openai = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("OpenAI"))!;
  await act(async () => openai.click());
  expect(container.textContent).toContain("Reuse this model connection");
  expect(mocks.request.mock.calls.some(([method]) => method === "web-search/configure")).toBe(false);
  await click("Allow, test and use");
  expect(mocks.request).toHaveBeenCalledWith("web-search/configure", { cwd: "/project", change: { action: "configure", provider: "openai", connection: { source: "shared", sharedProvider: "openai" }, activate: true } });
  expect(status.selectedProvider).toBe("openai");
  expect(container.textContent).toContain("OpenAI passed the test and is the only selected search provider");
  await click("Revoke search access");
  expect(status.providers.find((p) => p.id === "openai")?.source).toBe("none");
  expect(mocks.request.mock.calls.some(([method]) => method === "pi/providers/logout")).toBe(false);
});
it("changes availability without changing any saved connection", async () => {
  await render(); await click("Enable web search");
  expect(mocks.request).toHaveBeenCalledWith("feature/set", { id: "web-search", scope: "global", enabled: true, cwd: "/project" });
  expect(mocks.request.mock.calls.some(([method]) => method === "web-search/configure")).toBe(false);
});
it("has a retryable initial failure instead of an empty screen", async () => {
  mocks.request.mockRejectedValueOnce(new Error("Connection unavailable"));
  await render(); expect(container.textContent).toContain("Could not load web search");
  expect(container.textContent).toContain("Connection unavailable");
});
it("does not switch providers while testing or after a rejected connection", async () => {
  await render();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("OpenAI"))!.click());
  let reject!: (error: Error) => void;
  mocks.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await click("Allow, test and use");
  expect(status.selectedProvider).toBe("duckduckgo");
  expect(container.textContent).toContain("Checking and saving");
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Allow, test and use")!.disabled).toBe(true);
  await act(async () => reject(new Error("OpenAI search failed (HTTP 401). Check this connection.")));
  expect(status.selectedProvider).toBe("duckduckgo");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("HTTP 401");
});
