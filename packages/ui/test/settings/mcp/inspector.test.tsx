// @vitest-environment happy-dom
/**
 * The inspector (docs/mcp.md "Inspecting"): it connects when it opens, every
 * per-tool choice is one whole `mcp/save` that rolls back when the write
 * fails, Run proves the server on the same connection, and leaving closes a
 * command it started.
 */
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpCallResult, McpInspection, McpServerConfigInput, McpServerState } from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));
vi.mock("../../../src/runtime/index.js", () => {
  const stable = { client: { request: mocks.request, subscribe: () => () => {} }, actions: { toast: mocks.toast } };
  return { useLaserStable: () => stable };
});

import { McpServersTab } from "../../../src/components/settings/mcp/McpServersTab.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { click, clickElement, field, findButton, inspection, render, serverState, text, tool } from "./harness.js";

let root: Root;
let servers: McpServerState[];
let inspectResult: McpInspection;
let callResult: McpCallResult;
let saved: Array<{ scope: string; server: McpServerConfigInput }>;
let calls: string[];

const TOOLS = [tool("navigate"), tool("click"), tool("screenshot")];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  saved = [];
  calls = [];
  servers = [
    serverState({
      scope: "global",
      status: "connected",
      toolCount: 3,
      directToolCount: 3,
      latencyMs: 12,
      config: {
        name: "playwright",
        label: "Playwright",
        transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
        tools: { exposure: "direct" },
      },
    }),
  ];
  inspectResult = inspection({
    name: "playwright",
    tools: TOOLS,
    instructions: "Drive the browser one step at a time.",
    resources: [{ uri: "file:///trace.zip", name: "Last trace", description: "What the browser did", mimeType: "application/zip" }],
    prompts: [{ name: "explore", description: "Walk a site", arguments: [{ name: "url", required: true, description: "Where to start" }] }],
  });
  callResult = {
    ok: true,
    durationMs: 91,
    content: [
      { type: "text", text: "Opened the page." },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ],
    structuredContent: { title: "Example" },
  };
  mocks.request.mockReset().mockImplementation(async (method: string, params: Record<string, unknown>) => {
    calls.push(method);
    if (method === "mcp/list") return { servers };
    if (method === "mcp/import/detect") return { sources: [] };
    if (method === "mcp/inspect") return inspectResult;
    if (method === "mcp/save") {
      saved.push(params as never);
      servers = servers.map((entry) =>
        entry.config.name === (params["server"] as { name: string }).name ? { ...entry, config: params["server"] as never } : entry,
      );
      return { servers };
    }
    if (method === "mcp/ping") return { status: "connected", latencyMs: 7 };
    if (method === "mcp/call") return callResult;
    if (method === "mcp/disconnect") return {};
    if (method === "mcp/remove") {
      servers = [];
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

async function open() {
  ({ root } = await render(
    <TooltipProvider>
      <McpServersTab cwd="/project" />
    </TooltipProvider>,
  ));
  const row = document.querySelector<HTMLButtonElement>('[data-slot="mcp-server-row"] button')!;
  await clickElement(row);
}

function toolRow(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-slot="mcp-tool-row"][data-tool="${name}"]`)!;
}

function toolSwitch(label: string, name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[aria-label="${label} · ${name}"]`)!;
}

it("connects on open and shows what the server is", async () => {
  await open();
  expect(mocks.request).toHaveBeenCalledWith("mcp/inspect", { cwd: "/project", scope: "global", name: "playwright" });
  const sheet = document.querySelector<HTMLElement>('[data-slot="mcp-inspector"]')!;
  expect(sheet.dataset["server"]).toBe("global:playwright");
  expect(sheet.textContent).toContain("Connected");
  expect(sheet.textContent).toContain("Playwright 1.2.3");
  expect(sheet.textContent).toContain("speaks 2026-07-28");
  expect(sheet.textContent).toContain("Drive the browser one step at a time.");

  await click("Ping");
  expect(mocks.request).toHaveBeenCalledWith("mcp/ping", { cwd: "/project", scope: "global", name: "playwright" });
  expect(sheet.textContent).toContain("7 ms");

  await click("Resources");
  expect(text()).toContain("Last trace");
  await click("Prompts");
  expect(text()).toContain("Walk a site");
  expect(text()).toContain("url");
});

it("maintains exclude, only and approve, one whole save per change", async () => {
  await open();
  await click("Tools");
  expect(document.querySelectorAll('[data-slot="mcp-tool-row"]').length).toBe(3);
  expect(toolRow("navigate").textContent).toContain("{ url: string; fullPage?: boolean }");

  await clickElement(toolSwitch("On", "click"));
  expect(saved.at(-1)!.server.tools).toEqual({ exposure: "direct", exclude: ["click"] });

  await clickElement(toolSwitch("Direct", "screenshot"));
  expect(saved.at(-1)!.server.tools).toMatchObject({ exposure: "direct", only: ["click", "navigate"] });

  await clickElement(toolSwitch("Ask first", "navigate"));
  expect(saved.at(-1)!.server.tools).toMatchObject({ approve: ["navigate"] });

  await click("All on");
  expect(saved.at(-1)!.server.tools).not.toHaveProperty("exclude");
  await click("All off");
  expect(saved.at(-1)!.server.tools).toMatchObject({ exclude: ["click", "navigate", "screenshot"] });
  await click("All direct");
  expect(saved.at(-1)!.server.tools).not.toHaveProperty("only");
});

it("rolls a failed change back and says what went wrong", async () => {
  await open();
  await click("Tools");
  mocks.request.mockImplementationOnce(async () => {
    throw new Error("The configuration file is read-only.");
  });
  await clickElement(toolSwitch("On", "click"));
  expect(mocks.toast).toHaveBeenCalledWith("error", "The configuration file is read-only.");
  expect(toolSwitch("On", "click").getAttribute("aria-checked")).toBe("true");
});

it("cannot make a tool direct while the server answers on demand, and says why", async () => {
  servers = servers.map((entry) => ({ ...entry, config: { ...entry.config, tools: { exposure: "on-demand" as const } } }));
  await open();
  await click("Tools");
  expect((toolSwitch("Direct", "navigate") as HTMLButtonElement).disabled).toBe(true);
  expect(toolRow("navigate").textContent).toContain("Reached on demand");
});

it("runs a tool with typed arguments and renders what came back", async () => {
  await open();
  await click("Run");
  const picker = field("Tool to run") as HTMLSelectElement;
  await act(async () => {
    picker.value = "navigate";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    const url = field("url") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(url, "https://example.com");
    url.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickElement(document.querySelector<HTMLElement>('[aria-label="fullPage"]')!);
  await click("Run it");
  expect(mocks.request).toHaveBeenCalledWith("mcp/call", {
    cwd: "/project",
    scope: "global",
    name: "playwright",
    tool: "navigate",
    args: { url: "https://example.com", fullPage: true },
  });
  const result = document.querySelector<HTMLElement>('[data-slot="mcp-call-result"]')!;
  expect(result.textContent).toContain("Worked");
  expect(result.textContent).toContain("91 ms");
  expect(result.textContent).toContain("Opened the page.");
  // The image goes through the `image` element, never into the page as text.
  const image = result.querySelector<HTMLElement>('[data-slot="mcp-result-image"] [data-slot="image-preview"]');
  expect(image).not.toBeNull();
  expect(result.textContent).not.toContain("aGk=");
  expect(result.textContent).toContain("Example");
});

it("says a failed call failed, with the server's own error", async () => {
  callResult = { ok: false, durationMs: 12, content: [], error: "Navigation timed out." };
  await open();
  await click("Run");
  await click("Run it");
  expect(text()).toContain("url is required.");
  await act(async () => {
    const url = field("url") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(url, "https://example.com");
    url.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Run it");
  const result = document.querySelector<HTMLElement>('[data-slot="mcp-call-result"]')!;
  expect(result.dataset["ok"]).toBe("false");
  expect(result.textContent).toContain("Navigation timed out.");
});

it("keeps a stored secret untouched when an edit saves without retyping it", async () => {
  servers = [
    serverState({
      scope: "global",
      status: "connected",
      config: {
        name: "docs",
        transport: { kind: "http", url: "https://example.com/mcp", headers: { "X-Key": { secret: true, present: true } } },
        auth: { kind: "bearer", token: { secret: true, present: true } },
        tools: { exposure: "direct" },
      },
    }),
  ];
  await open();
  await click("Edit");
  expect(text()).toContain("Saved. It is never shown again.");
  await click("Save changes");
  expect(saved.at(-1)!.server.auth).toEqual({ kind: "bearer", token: { secret: true } });
  expect(saved.at(-1)!.server.transport).toMatchObject({ headers: { "X-Key": { secret: true } } });
});

it("turns a server off, and offers the project switch-off instead of removing a shared one", async () => {
  await open();
  await click("Turn off");
  expect(saved.at(-1)!.server.disabled).toBe(true);
  await click("Remove");
  expect(findButton("Switch it off for this project instead")).toBeDefined();
  await click("Switch it off for this project instead");
  expect(saved.at(-1)).toMatchObject({ scope: "project", server: { name: "playwright", disabled: true } });
});

it("closes the connection it opened when it leaves a command server", async () => {
  await open();
  await click("Close");
  expect(mocks.request).toHaveBeenCalledWith("mcp/disconnect", { cwd: "/project", scope: "global", name: "playwright" });
});
