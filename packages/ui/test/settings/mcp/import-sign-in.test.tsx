// @vitest-environment happy-dom
/**
 * Importing what other tools left on this machine, and signing in to a server
 * that asks for an account (docs/mcp.md "Importing", "Sign-in").
 */
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpAuthStart, McpImportSource, McpServerState } from "@lasercode/protocol";

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
import { click, clickElement, field, findButton, render, serverState, text } from "./harness.js";

let root: Root;
let servers: McpServerState[];
let sources: McpImportSource[];
let authStart: McpAuthStart;
let applied: Array<Record<string, unknown>>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.listeners.clear();
  applied = [];
  servers = [];
  sources = [
    {
      id: "claude-code",
      label: "Claude Code",
      path: "/home/a/.claude.json",
      servers: [
        {
          name: "linear",
          config: { name: "linear", transport: { kind: "http", url: "https://mcp.linear.app/mcp/full/path", headers: { Authorization: { secret: true }, "X-Team": "public-team" } } },
          conflicts: ["global"],
          inlineSecrets: ["transport.headers.Authorization"],
        },
        {
          name: "memory",
          config: { name: "memory", transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory", "--headless", "--isolated", "two words"], env: { API_KEY: { secret: true }, MODE: "test" } } },
          conflicts: [],
          inlineSecrets: ["transport.env.API_KEY"],
        },
        {
          name: "weird",
          config: { name: "weird", transport: { kind: "stdio", command: "weird" } },
          conflicts: [],
          inlineSecrets: [],
          unsupported: "it asks for a transport this app does not speak",
        },
      ],
    },
  ];
  authStart = { authorizationUrl: "https://mcp.linear.app/authorize?x=1", callbackListening: true };
  mocks.request.mockReset().mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "mcp/list") return { servers };
    if (method === "mcp/import/detect") return { sources };
    if (method === "mcp/import/apply") {
      applied.push(params);
      servers = (params["names"] as string[]).map((name) =>
        serverState({
          scope: params["scope"] as "global" | "project",
          status: "unknown",
          config: { name, transport: { kind: "http", url: "https://mcp.linear.app/mcp" }, auth: { kind: "oauth" } },
        }),
      );
      return { servers, imported: params["names"] };
    }
    if (method === "mcp/auth/start") return authStart;
    if (method === "mcp/auth/complete") return { status: "connected" };
    if (method === "mcp/auth/logout") return { status: "needs-auth" };
    if (method === "mcp/inspect") throw new Error("not needed here");
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

it("imports the servers a person chose, into the scope they chose", async () => {
  await mount();
  await click("Import");
  expect(text()).toContain("/home/a/.claude.json");
  expect(text()).toContain("https://mcp.linear.app/mcp/full/path");
  expect(text()).toContain('npx -y @modelcontextprotocol/server-memory --headless --isolated "two words"');
  expect(text()).toContain("Headers: Authorization, X-Team");
  expect(text()).toContain("Environment: API_KEY, MODE");
  expect(text()).toContain("Authorization header");
  expect(text()).toContain("the API_KEY environment variable");
  expect(text()).not.toContain("transport.headers.");
  expect(text()).not.toContain("transport.env.");
  expect(text()).toContain("already in Every project");
  expect(text()).toContain("kept in the app’s secret store");
  const unsupported = document.querySelector<HTMLElement>('[data-slot="mcp-import-row"][data-server="weird"]')!;
  expect(unsupported.textContent).toContain("it asks for a transport this app does not speak");
  expect(unsupported.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);

  // The replace switch appears only once a conflicting server is chosen.
  expect(findButton("Replace the servers of the same name")).toBeUndefined();
  await clickElement(document.querySelector<HTMLElement>('[aria-label="Import memory"]')!);
  expect(findButton("Replace the servers of the same name")).toBeUndefined();
  await clickElement(document.querySelector<HTMLElement>('[aria-label="Import linear"]')!);
  expect(findButton("Replace the servers of the same name")).toBeDefined();
  await click("Replace the servers of the same name");
  await click("This project");
  await click("Import 2 servers");

  expect(applied).toEqual([{ cwd: "/project", source: "claude-code", names: ["memory", "linear"], scope: "project", replace: true }]);
  expect(mocks.toast).toHaveBeenCalledWith("info", "Imported memory, linear.");
});

it("signs in from the row, waits for the browser, and still takes a pasted address", async () => {
  servers = [
    serverState({
      scope: "global",
      status: "needs-auth",
      config: { name: "linear", label: "Linear", transport: { kind: "http", url: "https://mcp.linear.app/mcp" }, auth: { kind: "oauth" } },
    }),
  ];
  await mount();
  await click("Sign in");
  expect(mocks.request).toHaveBeenCalledWith("mcp/auth/start", { cwd: "/project", scope: "global", name: "linear" });
  expect(text()).toContain("https://mcp.linear.app/authorize?x=1");
  expect(text()).toContain("Waiting for the browser to finish");
  const link = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.includes("Open the sign-in page"))!;
  expect(link.getAttribute("href")).toBe("https://mcp.linear.app/authorize?x=1");
  expect(link.getAttribute("target")).toBe("_blank");

  const paste = field("Paste the address it lands on, or the code") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(paste, "https://127.0.0.1:7777/callback?code=abc");
    paste.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Finish sign-in");
  expect(mocks.request).toHaveBeenCalledWith("mcp/auth/complete", {
    cwd: "/project",
    scope: "global",
    name: "linear",
    redirectUrl: "https://127.0.0.1:7777/callback?code=abc",
  });
  expect(text()).toContain("Signed in.");
});

it("takes a bare code when no callback is listening, and says where to paste it", async () => {
  authStart = { authorizationUrl: "https://mcp.linear.app/authorize", callbackListening: false, manualHint: "Copy the code the page shows you." };
  servers = [
    serverState({
      scope: "global",
      status: "needs-auth",
      config: { name: "linear", transport: { kind: "http", url: "https://mcp.linear.app/mcp" }, auth: { kind: "oauth" } },
    }),
  ];
  await mount();
  await click("Sign in");
  expect(text()).toContain("Copy the code the page shows you.");
  expect(text()).not.toContain("Waiting for the browser to finish");
  const paste = field("Paste the address it lands on, or the code") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(paste, "abc123");
    paste.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Finish sign-in");
  expect(mocks.request).toHaveBeenCalledWith("mcp/auth/complete", { cwd: "/project", scope: "global", name: "linear", code: "abc123" });
});

it("asks before signing out, and keeps the server configured", async () => {
  servers = [
    serverState({
      scope: "global",
      status: "connected",
      config: { name: "linear", transport: { kind: "http", url: "https://mcp.linear.app/mcp" }, auth: { kind: "oauth" } },
    }),
  ];
  mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "mcp/list") return { servers };
    if (method === "mcp/import/detect") return { sources: [] };
    if (method === "mcp/inspect") return { name: "linear", scope: "global", status: "connected", tools: [], resources: [], prompts: [] };
    if (method === "mcp/auth/logout") {
      applied.push({ method, ...params });
      return { status: "needs-auth" };
    }
    throw new Error(`unexpected ${method}`);
  });
  await mount();
  await clickElement(document.querySelector<HTMLButtonElement>('[data-slot="mcp-server-row"] button')!);
  await click("Sign out");
  expect(text()).toContain("The saved sign-in is forgotten.");
  expect(applied).toHaveLength(0);
  await click("Sign out", document.querySelector<HTMLElement>('[data-slot="mcp-sign-out-dialog"]')!);
  expect(applied).toEqual([{ method: "mcp/auth/logout", cwd: "/project", scope: "global", name: "linear" }]);
  expect(mocks.toast).toHaveBeenCalledWith("info", "Signed out. The server stays configured.");
});

it("notices that the browser finished, without the person pressing anything", async () => {
  servers = [
    serverState({
      scope: "global",
      status: "needs-auth",
      config: { name: "linear", transport: { kind: "http", url: "https://mcp.linear.app/mcp" }, auth: { kind: "oauth" } },
    }),
  ];
  await mount();
  await click("Sign in");
  expect(text()).toContain("Waiting for the browser to finish");
  // The worker wrote the credential and said so; the dialog must not sit on
  // "waiting" over a row that already turned connected.
  servers = servers.map((entry) => ({ ...entry, status: "connected" as const }));
  await act(async () => {
    for (const listener of mocks.listeners) listener("mcp/changed", { cwd: "/project" });
  });
  expect(document.querySelector('[data-slot="mcp-signed-in"]')?.textContent).toContain("Signed in.");
  expect(text()).not.toContain("Waiting for the browser to finish");
});
