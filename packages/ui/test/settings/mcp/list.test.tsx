// @vitest-environment happy-dom
/**
 * The list, the empty state and what the page does when the host answers
 * badly or changes underneath it (docs/mcp.md "The list").
 */
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpImportSource, McpServerState } from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn(), listeners: new Set<(method: string, params: unknown) => void>() }));
vi.mock("../../../src/runtime/index.js", () => {
  const stable = {
    client: {
      request: mocks.request,
      subscribe: (handler: (method: string, params: unknown) => void) => {
        mocks.listeners.add(handler);
        return () => mocks.listeners.delete(handler);
      },
    },
    actions: { toast: mocks.toast },
  };
  return { useLaserStable: () => stable };
});

import { McpServersTab } from "../../../src/components/settings/mcp/McpServersTab.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { click, render, serverState, text } from "./harness.js";

let root: Root;
let servers: McpServerState[];
let sources: McpImportSource[];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.listeners.clear();
  servers = [
    serverState({
      scope: "global",
      status: "connected",
      toolCount: 24,
      directToolCount: 24,
      config: { name: "playwright", label: "Playwright", transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
    }),
    serverState({
      scope: "global",
      status: "needs-auth",
      config: { name: "github", transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" }, auth: { kind: "oauth" } },
    }),
    serverState({ scope: "global", status: "failed", detail: "It quit straight away.", config: { name: "broken", transport: { kind: "stdio", command: "broken" } } }),
    serverState({ scope: "global", status: "off", config: { name: "sleepy", disabled: true, transport: { kind: "stdio", command: "sleepy" } } }),
    serverState({ scope: "global", status: "starting", config: { name: "waking", transport: { kind: "stdio", command: "waking" } } }),
    serverState({
      scope: "project",
      status: "ready",
      toolCount: 3,
      directToolCount: 0,
      shadowed: false,
      config: { name: "memory", transport: { kind: "socket", path: "/run/user/1000/memory.sock" } },
    }),
    serverState({
      scope: "project",
      status: "unknown",
      overridesGlobal: true,
      config: { name: "playwright", transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] }, disabled: true },
    }),
  ];
  sources = [];
  mocks.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "mcp/list") return { servers };
    if (method === "mcp/import/detect") return { sources };
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

it("shows both scopes, the project's first, with every status in a person's words", async () => {
  await mount();
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="mcp-server-row"]')];
  expect(rows.map((row) => row.dataset["server"])).toEqual([
    "project:memory",
    "project:playwright",
    "global:playwright",
    "global:github",
    "global:broken",
    "global:sleepy",
    "global:waking",
  ]);
  expect(rows.map((row) => row.dataset["status"])).toEqual([
    "Ready",
    "Not seen yet",
    "Connected",
    "Needs sign-in",
    "Failed",
    "Off",
    "Starting",
  ]);
  const playwright = rows.find((row) => row.dataset["server"] === "global:playwright")!;
  expect(playwright.textContent).toContain("npx @playwright/mcp");
  expect(playwright.textContent).toContain("Command");
  expect(playwright.textContent).toContain("24 tools · 24 direct");
  expect(playwright.textContent).toContain("Every project");
  const override = rows.find((row) => row.dataset["server"] === "project:playwright")!;
  expect(override.textContent).toContain("switches the every-project server");
  expect(rows.find((row) => row.dataset["server"] === "global:broken")!.textContent).toContain("It quit straight away.");
  expect(rows.find((row) => row.dataset["server"] === "project:memory")!.textContent).toContain("…/memory.sock");
  expect(text()).toContain("reaches conversations you start afterwards");
});

it("filters by scope without hiding the other one behind a guess", async () => {
  await mount();
  await click("This project");
  expect([...document.querySelectorAll<HTMLElement>('[data-slot="mcp-server-row"]')].map((row) => row.dataset["server"])).toEqual([
    "project:memory",
    "project:playwright",
  ]);
  await click("Every project");
  expect(document.querySelectorAll('[data-slot="mcp-server-row"]').length).toBe(5);
});

it("offers the gallery and the import banner instead of an empty page", async () => {
  servers = [];
  sources = [
    {
      id: "claude-code",
      label: "Claude Code",
      path: "/home/a/.claude.json",
      servers: [{ name: "linear", config: { name: "linear", transport: { kind: "http", url: "https://mcp.linear.app/mcp" } }, conflicts: [], inlineSecrets: [] }],
    },
    {
      id: "project-mcp-json",
      label: "Project .mcp.json",
      path: "/project/.mcp.json",
      servers: [{ name: "docs", config: { name: "docs", transport: { kind: "stdio", command: "docs-server" } }, conflicts: [], inlineSecrets: [] }],
    },
  ];
  await mount();
  expect(document.querySelectorAll('[data-slot="mcp-gallery-card"]').length).toBe(8);
  expect(document.querySelector('[data-slot="mcp-gallery-card"]')?.getAttribute("data-entry")).toBe("playwright");
  const banner = document.querySelector('[data-slot="mcp-import-banner"]')!;
  expect(banner.textContent).toContain("Found 2 servers configured for Claude Code and Project .mcp.json");
});

it("reloads when the worker says the configuration changed", async () => {
  await mount();
  expect(mocks.request.mock.calls.filter(([method]) => method === "mcp/list").length).toBe(1);
  servers = servers.map((entry) => (entry.config.name === "github" && entry.scope === "global" ? { ...entry, status: "connected" as const } : entry));
  await act(async () => {
    for (const listener of mocks.listeners) listener("mcp/changed", { cwd: "/project" });
  });
  expect(mocks.request.mock.calls.filter(([method]) => method === "mcp/list").length).toBe(2);
  const github = document.querySelector<HTMLElement>('[data-slot="mcp-server-row"][data-server="global:github"]')!;
  expect(github.dataset["status"]).toBe("Connected");
});

it("ignores a change in another project", async () => {
  await mount();
  await act(async () => {
    for (const listener of mocks.listeners) listener("mcp/changed", { cwd: "/elsewhere" });
  });
  expect(mocks.request.mock.calls.filter(([method]) => method === "mcp/list").length).toBe(1);
});

it("has a retryable initial failure rather than a blank page", async () => {
  mocks.request.mockImplementationOnce(async () => {
    throw new Error("The worker is not running.");
  });
  await mount();
  expect(text()).toContain("Could not read this project’s servers");
  expect(text()).toContain("The worker is not running.");
  await click("Retry");
  expect(document.querySelectorAll('[data-slot="mcp-server-row"]').length).toBe(7);
});
