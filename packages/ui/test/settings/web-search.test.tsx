// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WEB_SEARCH_PROVIDERS, type WebSearchChange, type WebSearchStatus } from "@lasercode/protocol";
import type { ScopeDraft } from "../../src/components/settings/ScopeDraftGuard.js";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../src/runtime/index.js", () => { const stable = { client: { request: mocks.request } }; return { useLaserStable: () => stable }; });
import { WebSearchTab } from "../../src/components/settings/WebSearchTab.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { deviceStore } from "../../src/runtime/device-storage.js";
import { testDescriptor } from "../runtime/environment-fixture.js";
let root: Root, container: HTMLDivElement, status: WebSearchStatus;
let featureState: Record<string, unknown>;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!deviceStore.status().active) deviceStore.activate(testDescriptor());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  status = { selectedProvider: "duckduckgo", providers: WEB_SEARCH_PROVIDERS.map((p) => ({ id: p.id, source: "none", hasKey: false, configured: p.key !== "required" && !p.endpoint })) };
  featureState = { manifest: { id: "web-search" }, globalEnabled: false, enabled: false };
  mocks.request.mockReset().mockImplementation(async (method: string, params: { change?: WebSearchChange }) => {
    if (method === "web-search/status") return status;
    if (method === "pi/providers/list") return { providers: [{ id: "openai", name: "OpenAI", configured: true }] };
    if (method === "feature/list") return { features: [featureState] };
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
async function render(view: "global" | "project" | "effective" = "global", onDraftChange?: (providerId: string, draft: ScopeDraft | undefined) => void) {
  await act(async () => root.render(
    <TooltipProvider>
      <WebSearchTab
        neutralRouteCwd="/neutral"
        view={view}
        {...(view === "global" ? {} : { projectCwd: "/selected-project" })}
        onDraftChange={onDraftChange}
      />
    </TooltipProvider>,
  ));
}
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
  expect(mocks.request).toHaveBeenCalledWith("web-search/configure", { cwd: "/neutral", change: { action: "configure", provider: "openai", connection: { source: "shared", sharedProvider: "openai" }, activate: true } });
  expect(status.selectedProvider).toBe("openai");
  expect(container.textContent).toContain("OpenAI passed the test and is the only selected search provider");
  await click("Revoke search access");
  expect(status.providers.find((p) => p.id === "openai")?.source).toBe("none");
  expect(mocks.request.mock.calls.some(([method]) => method === "pi/providers/logout")).toBe(false);
});
it("changes Global availability through the neutral route without changing a connection", async () => {
  await render();
  expect(mocks.request).toHaveBeenCalledWith("feature/list", {});
  expect(mocks.request).toHaveBeenCalledWith("web-search/status", { cwd: "/neutral" });
  expect(mocks.request).toHaveBeenCalledWith("pi/providers/list", { cwd: "/neutral" });
  await click("Enable web search");
  expect(mocks.request).toHaveBeenCalledWith("feature/set", { id: "web-search", scope: "global", enabled: true, cwd: "/neutral" });
  expect(mocks.request.mock.calls.some(([method]) => method === "web-search/configure")).toBe(false);
});
it("keeps connections neutral while Project feature state and writes use the selected project", async () => {
  await render("project");
  expect(mocks.request).toHaveBeenCalledWith("web-search/status", { cwd: "/neutral" });
  expect(mocks.request).toHaveBeenCalledWith("pi/providers/list", { cwd: "/neutral" });
  expect(mocks.request).toHaveBeenCalledWith("feature/list", { cwd: "/selected-project" });
  await click("Enable web search");
  expect(mocks.request).toHaveBeenCalledWith("feature/set", {
    id: "web-search",
    scope: "project",
    enabled: true,
    cwd: "/selected-project",
  });
});
it("reads Effective feature state from the selected project and exposes no write", async () => {
  await render("effective");
  expect(mocks.request).toHaveBeenCalledWith("feature/list", { cwd: "/selected-project" });
  expect(mocks.request).toHaveBeenCalledWith("web-search/status", { cwd: "/neutral" });
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.getAttribute("aria-label") === "Enable web search");
  expect(toggle?.disabled).toBe(true);
  await act(async () => toggle?.click());
  expect(mocks.request.mock.calls.some(([method]) => method === "feature/set")).toBe(false);
  expect(container.textContent).toContain("Effective settings are a read-only preview");
});

it("reports and discards a typed connection draft", async () => {
  let draft: ScopeDraft | undefined;
  await render("global", (_providerId, next) => { draft = next; });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.startsWith("SearXNG"))!.click());
  const address = container.querySelector<HTMLInputElement>('input[placeholder="https://search.example.com"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(address, "https://search.local");
    address.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(draft?.label).toContain("SearXNG");
  await act(async () => { await draft?.discard(); });
  expect(address.value).toBe("");
});

it("keeps provider drafts registered and their secret values alive across collapse and filtering", async () => {
  const active = new Map<string, ScopeDraft>();
  await render("global", (providerId, draft) => {
    if (draft) active.set(providerId, draft);
    else active.delete(providerId);
  });
  const open = async (name: string) => {
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.startsWith(name))!.click());
  };
  const type = async (selector: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(selector)!;
    expect(input, selector).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  await open("SearXNG");
  await type('input[placeholder="https://search.example.com"]', "https://search.local");
  await open("Bright Data");
  await type('input[placeholder="Your SERP zone name"]', "search-zone");

  expect(active.size).toBe(2);
  expect([...active.values()].map((draft) => draft.label)).toEqual([
    "SearXNG search connection",
    "Bright Data search connection",
  ]);

  await open("SearXNG");
  expect(active.has("searxng")).toBe(true);
  await open("SearXNG");
  expect(container.querySelector<HTMLInputElement>('input[placeholder="https://search.example.com"]')?.value).toBe("https://search.local");

  const filter = container.querySelector<HTMLInputElement>('input[aria-label="Find a search provider"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "Bright");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(active.has("searxng")).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector<HTMLInputElement>('input[placeholder="https://search.example.com"]')?.value).toBe("https://search.local");
  expect(container.querySelector<HTMLInputElement>('input[placeholder="Your SERP zone name"]')?.value).toBe("search-zone");
});

it("shows Project feature provenance and clears only the Project override", async () => {
  featureState = {
    manifest: { id: "web-search" },
    globalEnabled: true,
    projectEnabled: false,
    enabled: false,
    source: "project",
  };
  await render("project");
  expect(container.textContent).toContain("Overridden for this project");
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.getAttribute("aria-label") === "Enable web search");
  expect(toggle?.getAttribute("aria-pressed")).toBe("false");
  await click("Use Global choice");
  expect(mocks.request).toHaveBeenCalledWith("feature/set", {
    id: "web-search",
    scope: "project",
    enabled: null,
    cwd: "/selected-project",
  });
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
  expect(container.querySelector('[data-slot="generation-loader"]')?.textContent).toContain("Testing OpenAI connection");
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Allow, test and use")!.disabled).toBe(true);
  await act(async () => reject(new Error("OpenAI search failed (HTTP 401). Check this connection.")));
  expect(status.selectedProvider).toBe("duckduckgo");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("HTTP 401");
  expect(container.querySelector('[data-slot="generation-loader"]')).toBeNull();
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Allow, test and use")!.disabled).toBe(false);
});
it("shows testing beside availability until enabling finishes", async () => {
  await render();
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await click("Enable web search");
  expect(container.querySelector('[aria-label="Search availability"] [data-slot="generation-loader"]')?.textContent).toContain("Testing DuckDuckGo");
  await act(async () => resolve({ restartPending: false }));
  expect(container.querySelector('[data-slot="generation-loader"]')).toBeNull();
});
