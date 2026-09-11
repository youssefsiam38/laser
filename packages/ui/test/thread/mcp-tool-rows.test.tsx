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
import { summarizeToolGroup } from "../../src/components/thread/tool-groups.js";
import { blocksFromEntries, initialState, reduce, type AppState, type Block } from "../../src/store.js";
import { projectMessages } from "../../src/runtime/projection.js";
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

/**
 * Activate a row from the keyboard. The trigger is a native button, so a
 * browser turns Enter into a click with `detail: 0`; happy-dom does not
 * synthesize it, so the key event and the activation it causes are both
 * dispatched here — the point of the test is that the row opens from the
 * keyboard path and keeps focus, and that nothing swallows the key.
 */
const pressEnter = async (trigger: HTMLButtonElement) => {
  await act(async () => {
    const down = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    trigger.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
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

  it("never lets a server's name swallow a tool of this app's own", () => {
    // A person may call a server `task`, `start`, `inspect`, `web` or
    // `complete`; the harness row must still be the harness row.
    const servers = ["task", "start", "inspect", "web", "complete", "send", "remove"];
    for (const name of ["task_output", "task_stop", "start_agent", "inspect_fleet", "inspect_agent", "send_agent_message", "remove_agent_worktree", "complete_agent_run", "web_search"]) {
      expect(classifyMcpTool(name, undefined, servers)).toBeUndefined();
    }
    // Those servers keep their own tools, and a result that actually came from
    // a server is an MCP row whatever it is called.
    expect(classifyMcpTool("task_create", undefined, servers)).toEqual({ kind: "direct", server: "task", tool: "create" });
    expect(classifyMcpTool("web_search", { server: "web", tool: "search" }, servers)).toEqual({ kind: "direct", server: "web", tool: "search" });
  });

  it("names a live MCP call in the aggregate the way its own row does", () => {
    const member = {
      toolCallId: "c1",
      toolName: "playwright_browser_navigate",
      args: { url: "https://example.com" },
      isError: false,
      running: true,
      awaiting: false,
      cancelled: false,
      mcp: classifyMcpTool("playwright_browser_navigate", undefined, ["playwright"])!,
    };
    const summary = summarizeToolGroup([member]);
    expect(summary.activeLabel).toBe("Using Playwright · browser navigate · https://example.com");
    expect(summary.detail).toBe("browser navigate · https://example.com");
    expect(summary.lines[0]).toBe("Playwright browser navigate · https://example.com — running");
    expect(summary.activeLabel).not.toContain("playwright_browser_navigate");
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

  it("keeps its live status while output is still arriving", async () => {
    // Partial output rides the UI-only artifact channel; `result` stays absent
    // until the call ends (AGENTS.md, live activity regression guards).
    const props = {
      ...toolProps("p1", "playwright_browser_snapshot", {}),
      status: { type: "running" as const },
      artifact: { partialOutput: "### Page\n- Page Title: Example" },
    } as unknown as React.ComponentProps<typeof ToolRow>;
    await act(async () => root.render(<Fixture {...props} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    const row = container.querySelector<HTMLElement>('[data-slot="tool-call"]')!;

    expect(row.getAttribute("data-state-row")).toBe("running");
    expect(trigger.getAttribute("aria-label")).toBe("Using Playwright · browser snapshot");

    await expand(trigger);
    // While it runs the section says output, not result — and the output is
    // there, drawn by the same renderer.
    expect(container.querySelector('[data-slot="tool-fallback-content"]')?.textContent).toContain("output");
    expect(container.querySelector('[data-slot="mcp-text"]')?.textContent).toContain("Page Title: Example");
    expect(row.getAttribute("data-state-row")).toBe("running");
  });

  it("draws an audio block as a player and a resource block as a card", async () => {
    const result = {
      content: [
        { type: "audio", data: "UklGRiQAAABXQVZF", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///tmp/report.md", mimeType: "text/markdown", text: "All green" } },
        { type: "resource_link", uri: "file:///tmp/run.log", name: "Run log" },
      ],
      details: { server: "playwright", tool: "browser_record" },
    };
    const trigger = await render(toolProps("a1", "playwright_browser_record", {}, result));
    await expand(trigger);

    const audio = container.querySelector<HTMLAudioElement>('[data-slot="mcp-audio"]')!;
    expect(audio.getAttribute("src")).toBe("data:audio/wav;base64,UklGRiQAAABXQVZF");
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.getAttribute("aria-label")).toBe("Audio returned by the server");

    const cards = [...container.querySelectorAll<HTMLElement>('[data-slot="mcp-resource"]')];
    expect(cards).toHaveLength(2);
    // The card shows one identity, and it is the one search indexes.
    expect(cards[0]?.querySelector("[data-search-content]")?.textContent).toBe("file:///tmp/report.md");
    expect(cards[0]?.textContent).toContain("All green");
    expect(cards[1]?.querySelector("[data-search-content]")?.textContent).toBe("Run log");
    expect(findTextMatches(container, "file:///tmp/run.log")).toHaveLength(0);
    expect(findTextMatches(container, "Run log")).toHaveLength(1);
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
    // The arguments keep the disclosure every other row has, and the two
    // regions are the two occurrences search counts.
    const args = container.querySelector<HTMLElement>('[data-slot="tool-fallback-args"]')!;
    expect(args.textContent).toContain("code");
    expect(findTextMatches(container, "browser_navigate")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Hydration — a reopened session draws the row the live one drew
// ---------------------------------------------------------------------------

describe("a session read back from its file", () => {
  const at = 1789152889963;
  const message = (id: string, body: Record<string, unknown>) => ({ type: "message", id, timestamp: at, message: { ...body, timestamp: at } });
  const entries = [
    message("e1", {
      role: "assistant",
      content: [
        { type: "text", text: "Taking a screenshot." },
        { type: "toolCall", id: "call_1", name: "playwright_browser_take_screenshot", arguments: { fullPage: false } },
        { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "echo hello" } },
      ],
    }),
    // The adapter's own result: text, an image, and the server that answered.
    message("e2", {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "playwright_browser_take_screenshot",
      content: [{ type: "text", text: "### Result\n- Screenshot of viewport" }, { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" }],
      details: { server: "playwright", tool: "browser_take_screenshot" },
      isError: false,
    }),
    message("e3", { role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [{ type: "text", text: "hello\n" }], isError: false }),
  ];

  it("keeps an MCP result whole and leaves an ordinary one the string it was", () => {
    const blocks = blocksFromEntries(entries);
    const tool = (id: string) => blocks.find((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool" && block.id === id)!;
    // A text-only result with no details is still the joined text: nothing
    // about the terminal, the diff or the fallback body moves.
    expect(tool("call_2").result).toBe("hello\n");
    expect(tool("call_1").result).toEqual({
      content: [{ type: "text", text: "### Result\n- Screenshot of viewport" }, { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" }],
      details: { server: "playwright", tool: "browser_take_screenshot" },
    });
  });

  it("keeps details whatever shape the stored content has", () => {
    // A result written with plain-string content still carries the server it
    // came from: the shape of the content does not decide this.
    const blocks = blocksFromEntries([
      message("s1", { role: "assistant", content: [{ type: "toolCall", id: "call_9", name: "playwright_browser_navigate", arguments: { url: "https://example.com" } }] }),
      message("s2", { role: "toolResult", toolCallId: "call_9", toolName: "playwright_browser_navigate", content: "Navigated.", details: { server: "playwright", tool: "browser_navigate" }, isError: false }),
    ]);
    const stored = blocks.find((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool")!;
    expect(stored.result).toEqual({ content: [{ type: "text", text: "Navigated." }], details: { server: "playwright", tool: "browser_navigate" } });
    expect(classifyMcpTool(stored.name, { server: "playwright", tool: "browser_navigate" }, [])).toEqual({
      kind: "direct",
      server: "playwright",
      tool: "browser_navigate",
    });
  });

  it("draws the reloaded MCP row with its image, classified by the server that answered alone", async () => {
    // No status snapshot: this is a transcript opened long after the session.
    preferences.mcpServers = [];
    const projected = projectMessages({ blocks: blocksFromEntries(entries), running: false, dialogs: [] });
    const part = projected.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => (p as { type?: string }).type === "tool-call" && (p as { toolCallId?: string }).toolCallId === "call_1")!;

    await act(async () => root.render(<Fixture {...({ ...(part as object), addResult: vi.fn(), resume: vi.fn(), respondToApproval: vi.fn(async () => {}) } as unknown as React.ComponentProps<typeof ToolRow>)} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.textContent).toContain("Playwright");
    expect(trigger.textContent).toContain("browser take screenshot");

    await expand(trigger);
    expect(container.querySelector<HTMLImageElement>('[data-slot="mcp-image"] img')?.getAttribute("src")).toBe(
      `data:image/png;base64,${SCREENSHOT_BASE64}`,
    );
    expect(container.querySelector('[data-slot="mcp-text"]')?.textContent).toContain("Screenshot of viewport");
    expect(container.textContent).not.toContain(SCREENSHOT_BASE64.slice(0, 24));
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

  it("counts the same occurrences as the row draws for a real screenshot answer", async () => {
    // The verbatim outer block of a Playwright screenshot: a heading, a link
    // whose URL is not on screen, and a js fence whose label is not a word of
    // the answer (docs/search-content.md, "Markdown bodies").
    const text = [
      "### Result",
      "- [Screenshot of viewport](.playwright-mcp/page-2026-09-11T18-41-21-880Z.png)",
      "### Ran Playwright code",
      "```js",
      "// Screenshot viewport and save it as .playwright-mcp/page-2026-09-11T18-41-21-880Z.png",
      "await page.screenshot({ path: '.playwright-mcp/page-2026-09-11T18-41-21-880Z.png', type: 'png' });",
      "```",
    ].join("\n");
    const result = { content: [{ type: "text", text }, { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" }], details: { server: "playwright", tool: "browser_take_screenshot" } };
    const trigger = await render(toolProps("f2", "playwright_browser_take_screenshot", {}, result));
    await expand(trigger);

    const projected = toolSearchContent({ name: "playwright_browser_take_screenshot", args: {}, result });
    for (const query of ["Screenshot of viewport", "Ran Playwright code", "playwright-mcp", "page.screenshot", "png"]) {
      const dom = findTextMatches(container, query).length;
      const projectedCount = projected.reduce((total, value) => total + textMatches(value, query).length, 0);
      expect({ query, dom }).toEqual({ query, dom: projectedCount });
      expect(dom).toBeGreaterThan(0);
    }
    // The fence label and the heading marks belong to the drawing, not the answer.
    for (const query of ["js", "###"]) {
      expect(findTextMatches(container, query)).toHaveLength(0);
      expect(projected.reduce((total, value) => total + textMatches(value, query).length, 0)).toBe(0);
    }
  });
});

describe("disclosure", () => {
  it("opens and closes from the keyboard, and the same way with reduced motion", async () => {
    const trigger = await render(toolProps("k1", "playwright_browser_navigate", { url: "https://example.com" }, NAVIGATE_RESULT));
    const content = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"]')!;
    expect(content.hasAttribute("hidden")).toBe(true);

    trigger.focus();
    await pressEnter(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger);
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
