// @vitest-environment happy-dom
/**
 * The two doors into a server (docs/mcp.md "Adding"): the gallery composes a
 * tested definition from the options a person chose, the custom door refuses
 * a name the protocol would refuse, and both end in Test before Add.
 */
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpInspection, McpServerConfigInput, McpServerState } from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));
vi.mock("../../../src/runtime/index.js", () => {
  const stable = { client: { request: mocks.request, subscribe: () => () => {} }, actions: { toast: mocks.toast } };
  return { useLaserStable: () => stable };
});

import { McpServersTab } from "../../../src/components/settings/mcp/McpServersTab.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { click, field, findButton, inspection, manyTools, render, text, tool, type as typeInto } from "./harness.js";

let root: Root;
let servers: McpServerState[];
let inspectResult: McpInspection;
let saved: Array<{ scope: string; server: McpServerConfigInput; originalName?: string }>;
let inspected: Array<{ scope: string; server?: McpServerConfigInput; name?: string }>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  servers = [];
  saved = [];
  inspected = [];
  inspectResult = inspection({ name: "playwright", tools: [tool("navigate"), ...manyTools(23)] });
  mocks.request.mockReset().mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "mcp/list") return { servers };
    if (method === "mcp/import/detect") return { sources: [] };
    if (method === "mcp/inspect") {
      inspected.push(params as never);
      return inspectResult;
    }
    if (method === "mcp/save") {
      saved.push(params as never);
      return { servers };
    }
    throw new Error(`unexpected ${method}`);
  });
  mocks.toast.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function mount() {
  ({ root } = await render(
    <TooltipProvider>
      <McpServersTab cwd="/project" />
    </TooltipProvider>,
  ));
}

it("tests the gallery definition it composed, then saves it direct for 24 tools", async () => {
  await mount();
  await click("Add Playwright");
  expect(text()).toContain("Where the browser runs");
  // The catalog's own defaults: isolated on, headless off.
  expect(document.querySelector<HTMLElement>('[aria-label="A window of its own"]')?.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector<HTMLElement>('[aria-label="Hide the browser window"]')?.getAttribute("aria-checked")).toBe("false");

  await click("Test");
  expect(inspected).toEqual([
    {
      cwd: "/project",
      scope: "global",
      server: {
        name: "playwright",
        label: "Playwright",
        catalogId: "playwright",
        startup: "on-demand",
        transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--isolated"] },
        tools: { exposure: "direct" },
      },
    },
  ]);
  expect(text()).toContain("Playwright");
  expect(text()).toContain("24 tools");
  expect(text()).toContain("navigate something");
  expect(text()).toContain("in the model’s list from the start");
  const viewport = document.querySelector<HTMLElement>('[data-slot="mcp-add-dialog"] [data-slot="scroll-area-viewport"]')!;
  expect(getComputedStyle(viewport).overflowY).toBe("auto");
  expect(getComputedStyle(viewport).height).not.toContain("%");

  await click("Add");
  expect(saved).toHaveLength(1);
  expect(saved[0]!.server.tools).toEqual({ exposure: "direct" });
  expect(mocks.toast).toHaveBeenCalledWith("info", expect.stringContaining("playwright is saved"));
});

it("chooses each own-Chrome mode, omits headless, and keeps unrelated form edits", async () => {
  await mount();
  await click("Add Playwright");
  await click("Hide the browser window");
  await click("All settings");
  await typeInto("Run it in", "/my/project");
  await click("Your Chrome, through the Playwright extension");
  expect(findButton("Hide the browser window")).toBeUndefined();
  expect(text()).toContain("Hiding the window is only available with a window of its own.");
  expect(document.querySelector('a[href^="https://chromewebstore.google.com/"]')).not.toBeNull();
  await click("Test");
  expect(inspected[0]?.server?.transport).toMatchObject({ args: ["-y", "@playwright/mcp@latest", "--extension"], cwd: "/my/project" });
  await click("Your Chrome, through remote debugging");
  await click("Test");
  expect(inspected[1]?.server?.transport).toMatchObject({ args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint=chrome"] });
  await click("A window of its own");
  await click("Test");
  expect(inspected[2]?.server?.transport).toMatchObject({ args: ["-y", "@playwright/mcp@latest", "--isolated", "--headless"] });
});

it("shows a distinct failed browser test without offering a successful tool exposure", async () => {
  inspectResult = inspection({ name: "playwright", status: "failed", detail: "Connected, but the browser could not open a page: Extension unavailable. Check the extension token." });
  await mount();
  await click("Add Playwright");
  await click("Test");
  expect(text()).toContain("The browser test failed");
  expect(text()).toContain("Check the extension token.");
  expect(document.querySelector('[data-slot="mcp-exposure"]')).toBeNull();
});

it("chooses on demand above the threshold and says why", async () => {
  inspectResult = inspection({ name: "big", tools: manyTools(60) });
  await mount();
  await click("Add Playwright");
  await click("Test");
  expect(text()).toContain("60 tools would be a long list");
  await click("Add");
  expect(saved[0]!.server.tools).toEqual({ exposure: "on-demand" });
});

it("keeps a rejected name out of the host and only offers sign-in for a URL", async () => {
  await mount();
  await click("Add a server");
  await typeInto("Name it", "My Server!");
  expect((field("Short name") as HTMLInputElement).value).toBe("my-server");
  await typeInto("Short name", "my server");
  await click("Test");
  expect(inspected).toHaveLength(0);
  expect(text()).toContain("Start with a letter or a digit, then letters, digits, hyphens and underscores only.");

  // A command has no sign-in; a URL does.
  expect(document.querySelector('[data-slot="mcp-sign-in-options"]')).toBeNull();
  await click("URL");
  expect(document.querySelector('[data-slot="mcp-sign-in-options"]')).not.toBeNull();
  await click("Command");
  expect(document.querySelector('[data-slot="mcp-sign-in-options"]')).toBeNull();
});

it("sends a typed secret as a value, and a header marked secret with it", async () => {
  await mount();
  await click("Add a server");
  await typeInto("Name it", "Docs");
  await click("URL");
  await typeInto("Address", "https://example.com/mcp");
  const signIn = field("Sign-in") as HTMLSelectElement;
  await act(async () => {
    signIn.value = "bearer";
    signIn.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await typeInto("Token", "s3cret");
  await click("Add a header");
  await typeInto("Header name", "X-Team");
  const secretToggle = findButton("Secret")!;
  await act(async () => secretToggle.click());
  await typeInto("X-Team value", "team-token");
  await click("Add");

  expect(saved).toHaveLength(1);
  expect(saved[0]!.server.auth).toEqual({ kind: "bearer", token: { secret: true, value: "s3cret" } });
  expect(saved[0]!.server.transport).toMatchObject({
    kind: "http",
    url: "https://example.com/mcp",
    headers: { "X-Team": { secret: true, value: "team-token" } },
  });
});

it("shows a failure with its own words and the tail of what it printed", async () => {
  inspectResult = inspection({
    name: "broken",
    status: "failed",
    tools: [],
    detail: "The command was not found on this machine.",
    stderr: ["sh: broken-server: not found"],
  });
  await mount();
  await click("Add a server");
  await typeInto("Name it", "Broken");
  await typeInto("Command", "broken-server");
  await click("Test");
  const result = document.querySelector<HTMLElement>('[data-slot="mcp-test-result"]')!;
  expect(result.dataset["status"]).toBe("failed");
  expect(result.textContent).toContain("The command was not found on this machine.");
  expect(result.textContent).toContain("sh: broken-server: not found");
  expect(document.querySelector('[data-slot="mcp-exposure"]')).toBeNull();
});

it("offers to add and sign in when the server asks for it", async () => {
  inspectResult = inspection({ name: "linear", status: "needs-auth", tools: [], detail: "This server needs you to sign in." });
  await mount();
  await click("Add a server");
  await typeInto("Name it", "Linear");
  await click("URL");
  await typeInto("Address", "https://mcp.linear.app/mcp");
  await click("Test");
  expect(text()).toContain("Needs sign-in");
  expect(findButton("Add and sign in")).toBeDefined();
});

it("refuses to save a token sign-in with nothing in it", async () => {
  await mount();
  await click("Add a server");
  await typeInto("Name it", "Docs");
  await click("URL");
  await typeInto("Address", "https://example.com/mcp");
  const signIn = field("Sign-in") as HTMLSelectElement;
  await act(async () => {
    signIn.value = "bearer";
    signIn.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Add");
  expect(saved).toHaveLength(0);
  expect(text()).toContain("Enter the token, or choose None.");
});
