// @vitest-environment happy-dom
/**
 * MCP tool calls in the transcript (M14-T4, docs/mcp.md "In the transcript").
 *
 * Every payload here is a shortened copy of a real result from the adapter
 * driving the Playwright MCP server (direct over stdio, and through the
 * gateway), so what the rows are asserted against is what the engine sends.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";

import { toolSearchContent } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { findTextMatches } from "../../src/components/thread/use-conversation-find.js";
import { textMatches } from "../../src/components/thread/search-text.js";
import { ToolRow } from "../../src/components/thread/ToolRow.js";
import { classifyMcpTool, mcpGatewaySummary, mcpGatewayView, mcpServerLabel, mcpToolLabel } from "../../src/components/thread/mcp-tools.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";

const preferences = vi.hoisted(() => ({ path: "/test/session", mcpServers: ["playwright"] as readonly string[] }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/sessionPreferences.js"),
  ...await import("../../src/runtime/projection.js"),
  useActivityDetailLevel: () => "answers",
  useLaserState: () => preferences.path,
  useLaserStable: () => ({ actions: { answerDialog: vi.fn(), send: vi.fn(async () => {}), openSession: vi.fn() } }),
  useLaserView: () => ({ dialogs: [] }),
}));
vi.mock("@/agents/hooks", () => ({
  useNamerLabel: () => undefined,
  useSessionMcpServers: () => preferences.mcpServers,
}));
vi.mock("@assistant-ui/react", async (original) => ({
  ...await original<typeof import("@assistant-ui/react")>(),
  useToolCallElapsed: () => undefined,
}));

const SCREENSHOT_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** `browser_navigate` through the direct registration, as the adapter answers it. */
const NAVIGATE_RESULT = {
  content: [{ type: "text", text: "### Ran Playwright code\n```js\nawait page.goto('https://example.com');\n```\n### Page\n- Page Title: Example Domain" }],
  details: { server: "playwright", tool: "browser_navigate" },
};

const SCREENSHOT_RESULT = {
  content: [
    { type: "text", text: "### Result\n- Screenshot of viewport" },
    { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" },
  ],
  details: { mode: "call", server: "playwright", tool: "browser_take_screenshot" },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  preferences.path = "/test/session";
  preferences.mcpServers = ["playwright"];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Fixture(props: React.ComponentProps<typeof ToolRow>) {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <ToolRow {...props} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

const toolProps = (toolCallId: string, toolName: string, args: Record<string, unknown>, result?: unknown, isError?: boolean) => ({
  toolCallId,
  toolName,
  args,
  argsText: JSON.stringify(args),
  ...(result !== undefined ? { result } : {}),
  ...(isError !== undefined ? { isError } : {}),
  status: { type: "complete" as const },
  addResult: vi.fn(),
  resume: vi.fn(),
  respondToApproval: vi.fn(async () => {}),
});

const render = async (props: Parameters<typeof toolProps> extends never ? never : React.ComponentProps<typeof ToolRow>) => {
  await act(async () => root.render(<Fixture {...props} />));
  return container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
};

const expand = async (trigger: HTMLButtonElement) => {
  await act(async () => trigger.click());
  // The markdown renderer defers its first paint to an effect.
  await act(async () => { await Promise.resolve(); });
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("recognising an MCP call", () => {
  it("uses the session's server names, normalising - to _ and preferring the longest match", () => {
    expect(classifyMcpTool("playwright_browser_navigate", undefined, ["playwright"])).toEqual({
      kind: "direct",
      server: "playwright",
      tool: "browser_navigate",
    });
    expect(classifyMcpTool("chrome_devtools_list_pages", undefined, ["chrome-devtools"])).toEqual({
      kind: "direct",
      server: "chrome-devtools",
      tool: "list_pages",
    });
    expect(classifyMcpTool("docs_search", undefined, ["docs", "docs_search"])).toEqual({ kind: "direct", server: "docs", tool: "search" });
    expect(classifyMcpTool("bash", undefined, ["playwright"])).toBeUndefined();
    expect(classifyMcpTool("playwright_browser_navigate", undefined, [])).toBeUndefined();
  });

  it("lets the server that answered win, so a call classifies with no snapshot at all", () => {
    expect(classifyMcpTool("weird-name", { server: "playwright", tool: "browser_navigate" }, [])).toEqual({
      kind: "direct",
      server: "playwright",
      tool: "browser_navigate",
    });
  });

  it("knows the gateway, its namespaced form and the script tool", () => {
    expect(classifyMcpTool("mcp", {}, [])).toEqual({ kind: "gateway" });
    expect(classifyMcpTool("mcp__playwright", undefined, [])).toEqual({ kind: "gateway", server: "playwright" });
    expect(classifyMcpTool("mcpScript", { calls: [] }, [])).toEqual({ kind: "script" });
  });

  it("reads names and modes the way a person says them", () => {
    expect(mcpServerLabel("chrome-devtools")).toBe("Chrome Devtools");
    expect(mcpToolLabel("browser_navigate", "playwright")).toBe("browser navigate");
    expect(mcpToolLabel("playwright_browser_navigate", "playwright")).toBe("browser navigate");
    expect(mcpGatewaySummary(mcpGatewayView({ search: "navigate" }, undefined))).toBe("Search “navigate”");
    expect(mcpGatewaySummary(mcpGatewayView({}, { mode: "status" }))).toBe("Status");
    expect(mcpGatewaySummary(mcpGatewayView({ connect: "playwright" }, undefined))).toBe("Connect playwright");
    expect(mcpGatewaySummary(mcpGatewayView({ action: "auth-start", server: "linear" }, undefined))).toBe("Sign in linear");
  });
});

describe("the session's MCP servers in the store", () => {
  const PATH = "/p/s.jsonl";
  const notify = (state: AppState, names: string[], path = PATH): AppState =>
    reduce(state, {
      type: "notification",
      method: "pi/extension/message",
      params: {
        path,
        message: {
          type: "lasercode/mcp/status",
          snapshot: {
            servers: names.map((name) => ({ name, status: "connected" as const, toolCount: 24, directToolCount: 24 })),
            totalTools: 24 * names.length,
            connectedCount: names.length,
          },
        },
      },
    });

  it("keeps the names the companion reports, and the shutdown snapshot never blanks them", () => {
    const opened = reduce(initialState, { type: "opened", state: sessionState({ path: PATH }) });
    expect(opened.open[PATH]?.mcpServers).toBeUndefined();

    const named = notify(opened, ["playwright", "chrome-devtools"]);
    expect(named.open[PATH]?.mcpServers).toEqual(["playwright", "chrome-devtools"]);

    // The same list leaves the view identity alone, like the Namer labels.
    expect(notify(named, ["playwright", "chrome-devtools"]).open[PATH]).toBe(named.open[PATH]);

    // The session shutting down reports an empty snapshot; a transcript being
    // read back keeps the names its rows are drawn from.
    expect(notify(named, []).open[PATH]?.mcpServers).toEqual(["playwright", "chrome-devtools"]);

    // A snapshot for a session we do not hold is dropped, not crashed on.
    expect(notify(named, ["other"], "/p/unknown.jsonl")).toBe(named);
  });
});

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

describe("a direct MCP tool row", () => {
  it("is the server speaking, with the tool and its most telling argument", async () => {
    const trigger = await render(toolProps("c1", "playwright_browser_navigate", { url: "https://example.com" }, NAVIGATE_RESULT));
    expect(trigger.textContent).toContain("Playwright");
    expect(trigger.textContent).toContain("browser navigate · https://example.com");
    expect(trigger.getAttribute("aria-label")).toBe("Playwright browser navigate · https://example.com");

    // Collapsed: the body is really hidden, not merely transparent.
    const content = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"]')!;
    expect(content.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector('[data-slot="mcp-text"]')).toBeNull();

    await expand(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The server's markdown is markdown: a heading is a heading and a fence is a fence.
    const body = container.querySelector<HTMLElement>('[data-slot="mcp-text"]')!;
    expect(body.querySelector("h3")?.textContent).toBe("Ran Playwright code");
    expect(body.querySelector("pre code")?.textContent).toContain("await page.goto('https://example.com');");
    expect(body.hasAttribute("data-search-content")).toBe(true);
    // The exact registered name stays available, outside the search index.
    expect(container.querySelector('[data-search-exclude]')?.textContent).toBe("playwright_browser_navigate");
    // The arguments keep the disclosure every other row uses.
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).not.toBeNull();
  });

  it("classifies from the session's servers when a stored result has no details left", async () => {
    const trigger = await render(toolProps("c2", "playwright_browser_snapshot", {}, "### Page\n- Page Title: Example Domain"));
    expect(trigger.textContent).toContain("Playwright");
    expect(trigger.textContent).toContain("browser snapshot");
    await expand(trigger);
    expect(container.querySelector('[data-slot="mcp-text"]')?.textContent).toContain("Page Title: Example Domain");
  });

  it("draws an image block as an image, never as base64 text", async () => {
    const trigger = await render(toolProps("c3", "playwright_browser_take_screenshot", { fullPage: false }, SCREENSHOT_RESULT));
    await expand(trigger);

    const img = container.querySelector<HTMLImageElement>('[data-slot="mcp-image"] img')!;
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${SCREENSHOT_BASE64}`);
    expect(container.textContent).not.toContain(SCREENSHOT_BASE64.slice(0, 24));
    // Zoom is reachable by keyboard, and download/copy are there.
    const zoom = container.querySelector<HTMLElement>('[aria-label="Zoom image"]')!;
    expect(zoom.getAttribute("tabindex")).toBe("0");
    expect(container.querySelector('[aria-label="Download image"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Copy image"]')).not.toBeNull();
  });

  it("shows a failure through the error path, collapsed and expanded", async () => {
    const result = { content: [{ type: "text", text: "Error: Browser is already in use" }], details: { error: "tool_error", server: "playwright" } };
    const trigger = await render(toolProps("c4", "playwright_browser_navigate", { url: "https://example.com" }, result, true));
    expect(trigger.textContent).toContain("Playwright");
    expect(container.textContent).toContain("Browser is already in use");
    await expand(trigger);
    const error = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"] [data-slot="tool-error"]');
    expect(error?.textContent).toContain("Browser is already in use");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(container.querySelector('[data-slot="mcp-text"]')).toBeNull();
  });
});

describe("a gateway row", () => {
  it("names the mode it ran and lists what a search matched", async () => {
    const result = {
      content: [{ type: "text", text: 'Found 2 tools matching "navigate":' }],
      details: {
        mode: "search",
        query: "navigate",
        matches: [
          { server: "playwright", tool: "playwright_browser_navigate", score: 318 },
          { server: "playwright", tool: "playwright_browser_navigate_back", score: 253 },
        ],
      },
    };
    const trigger = await render(toolProps("g1", "mcp", { search: "navigate" }, result));
    expect(trigger.textContent).toContain("MCP");
    expect(trigger.textContent).toContain("Search “navigate”");

    await expand(trigger);
    const matches = [...container.querySelectorAll('[data-slot="tool-fallback-content"] li')].map((li) => li.textContent);
    expect(matches).toEqual(["playwright·playwright_browser_navigate", "playwright·playwright_browser_navigate_back"]);
    expect(container.querySelector('[data-slot="mcp-text"]')?.textContent).toContain("Found 2 tools matching");
    expect(container.textContent).not.toContain("318");
  });

  it("draws a call exactly like the direct row, images included", async () => {
    const result = {
      content: [{ type: "text", text: "outer summary" }],
      details: { mode: "call", server: "playwright", tool: "browser_take_screenshot", mcpResult: { content: SCREENSHOT_RESULT.content } },
    };
    const trigger = await render(toolProps("g2", "mcp__playwright", { tool: "playwright_browser_take_screenshot", args: {} }, result));
    expect(trigger.textContent).toContain("Call playwright · browser_take_screenshot");
    await expand(trigger);
    expect(container.querySelector<HTMLImageElement>('[data-slot="mcp-image"] img')?.getAttribute("src")).toBe(
      `data:image/png;base64,${SCREENSHOT_BASE64}`,
    );
    expect(container.querySelector('[data-slot="mcp-text"]')?.textContent).toContain("Screenshot of viewport");
    // The envelope's own summary is not drawn twice beside the called result.
    expect(container.textContent).not.toContain("outer summary");
  });

  it("draws the status of every server as a compact table", async () => {
    const result = {
      content: [{ type: "text", text: "MCP: 1/1 servers, 24 tools" }],
      details: { mode: "status", servers: [{ name: "playwright", status: "connected", toolCount: 24, listenState: "legacy" }] },
    };
    const trigger = await render(toolProps("g3", "mcp", {}, result));
    expect(trigger.textContent).toContain("Status");
    await expand(trigger);
    const row = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"] li')!;
    expect(row.textContent).toBe("playwrightconnected24 tools");
    expect(container.textContent).not.toContain("legacy");
  });
});

describe("an mcpScript row", () => {
  it("shows the code it ran, the output and the calls it made", async () => {
    const code = "const page = await playwright.browser_navigate({ url: 'https://example.com' });\nreturn page;";
    const result = {
      content: [{ type: "text", text: "Navigated to https://example.com" }],
      details: { calls: [{ server: "playwright", tool: "browser_navigate", ok: true }] },
    };
    const trigger = await render(toolProps("s1", "mcpScript", { code }, result));
    // The verb keeps its words; the first line of the code gives way instead.
    expect(trigger.textContent).toContain("MCP script");
    expect(trigger.textContent).toContain("const page = await playwright");
    expect(trigger.textContent).toContain("…");
    expect(trigger.textContent).not.toContain("https://example.com' });");

    await expand(trigger);
    const [script] = [...container.querySelectorAll('[data-slot="mcp-text"]')];
    expect(script?.querySelector("pre code")?.textContent).toContain("return page;");
    expect(container.textContent).toContain("Navigated to https://example.com");
    const calls = container.querySelector<HTMLElement>('[data-search-exclude] li')!;
    expect(calls.textContent).toBe("playwright·browser_navigate");
    // The code is the body, so it is not repeated as an argument disclosure.
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
  });
});

describe("finding text in an MCP row", () => {
  it("marks exactly the values the projection names, and never a key or a blob", async () => {
    const args = { fullPage: true, url: "https://example.com" };
    const trigger = await render(toolProps("f1", "playwright_browser_take_screenshot", args, SCREENSHOT_RESULT));
    await expand(trigger);

    const domHits = (query: string) => findTextMatches(container, query).length;
    const projected = toolSearchContent({ name: "playwright_browser_take_screenshot", args, result: SCREENSHOT_RESULT });
    const projectedHits = (query: string) => projected.reduce((total, value) => total + textMatches(value, query).length, 0);

    for (const query of ["https://example.com", "Screenshot of viewport", "true"]) {
      expect(domHits(query)).toBe(projectedHits(query));
      expect(domHits(query)).toBeGreaterThan(0);
    }
    // A key, the registered tool name and the screenshot's bytes are not content.
    for (const query of ["fullPage", "browser_take_screenshot", SCREENSHOT_BASE64.slice(0, 16)]) {
      expect(domHits(query)).toBe(0);
      expect(projectedHits(query)).toBe(0);
    }
  });
});

describe("disclosure", () => {
  it("opens and closes from the keyboard, and the same way with reduced motion", async () => {
    const trigger = await render(toolProps("k1", "playwright_browser_navigate", { url: "https://example.com" }, NAVIGATE_RESULT));
    const content = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"]')!;
    expect(content.hasAttribute("hidden")).toBe(true);

    trigger.focus();
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-slot="mcp-text"]')).not.toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"]')!.hasAttribute("hidden")).toBe(true);

    // Reduced motion changes the animation, never the outcome.
    const matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
    vi.stubGlobal("matchMedia", matchMedia);
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-slot="mcp-text"]')).not.toBeNull();
    vi.unstubAllGlobals();
  });
});
