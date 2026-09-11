import { expect, it } from "vitest";
import { toolSearchContent, jsonSearchValues, mcpContentBlocks, mcpDisplayText } from "../src/search-content.js";

/** The screenshot block of a real Playwright result, shortened. */
const SCREENSHOT = { type: "image", data: "iVBORw0KGgoAAAANSUhEUg", mimeType: "image/png" };

it("uses visible terminal content, never command keys, tool names or hidden parameters", () => {
  expect(toolSearchContent({ name: "bash", args: { command: "echo hello", timeout: 12345, secret: "hidden" }, result: { content: [{ type: "text", text: "world" }, { type: "image", data: "private" }], details: { secret: "hidden" } } })).toEqual(["echo hello", "world"]);
  expect(toolSearchContent({ name: "bash", args: { command: "command -v node" }, result: "command output\nCommand exited with code 1", isError: true })).toEqual(["command -v node", "command output"]);
});
it("keeps unknown tools searchable through JSON values, including nested arrays and displayed escapes", () => {
  expect(toolSearchContent({ name: "future_tool", args: { command: "hello", nested: [{ query: "Apple", enabled: true, limit: 7 }], newline: "a\nb" }, result: '{"command":"pear"}' })).toEqual(["hello", "Apple", "true", "7", String.raw`a\nb`, "pear"]);
  expect(jsonSearchValues({ Apple: "pear" })).toEqual(["pear"]);
});
it("uses exactly the bounded diff lines and excludes hidden success messages", () => {
  const text = Array.from({ length: 405 }, (_, i) => `line${i}`).join("\n");
  const values = toolSearchContent({ name: "write", args: { path: "file.ts", content: text }, result: "Hidden confirmation" });
  expect(values).toHaveLength(401);
  expect(values[0]).toBe("file.ts");
  expect(values.at(-1)).toBe("line399");
  expect(toolSearchContent({ name: "edit", args: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] }, result: "Permission denied", isError: true })).toEqual(["file.ts", "old", "new", "Permission denied"]);
});
it("treats a rendered error as literal text, while JSON fallback output searches only values", () => {
  const result = '{"error":"permission denied"}';
  expect(toolSearchContent({ name: "read", args: { path: "file" }, result, isError: true })).toEqual(["file", result]);
  expect(toolSearchContent({ name: "future_tool", args: {}, result, isError: true })).toEqual(["permission denied"]);
});
it("projects a direct MCP tool by the server that answered, never its details or image bytes", () => {
  const result = {
    content: [{ type: "text", text: "### Page\n- Page URL: https://example.com/" }, SCREENSHOT],
    details: { server: "playwright", tool: "browser_take_screenshot" },
  };
  const values = toolSearchContent({ name: "playwright_browser_take_screenshot", args: { url: "https://example.com", fullPage: true }, result });
  // The rendered text: no heading hashes, no list marker (docs/search-content.md).
  expect(values).toEqual(["https://example.com", "true", "Page\nPage URL: https://example.com/"]);
  // Keys, the server's own name in `details` and the base64 payload are not content.
  for (const miss of ["fullPage", "browser_take_screenshot", "iVBORw0KGgo", "mimeType", "image/png"]) {
    expect(values.some(value => value.includes(miss))).toBe(false);
  }
});

it("projects a resource block by the identity the card shows, then its text", () => {
  const result = {
    content: [
      { type: "resource", resource: { uri: "file:///tmp/report.md", mimeType: "text/markdown", text: "All green" } },
      { type: "resource_link", uri: "file:///tmp/run.log", name: "Run log" },
      { type: "text", text: "done" },
    ],
    details: { server: "docs" },
  };
  // The card draws `name ?? uri`, so that is the indexed value; the uri behind
  // a named resource is not on screen and is not searchable.
  expect(toolSearchContent({ name: "docs_report", args: {}, result })).toEqual([
    "file:///tmp/report.md",
    "All green",
    "Run log",
    "done",
  ]);
});

it("indexes Markdown as the renderer draws it, not as the model wrote it", () => {
  const source = [
    "### Result",
    "- [Screenshot of viewport](.playwright-mcp/page-2026.png)",
    "![](.playwright-mcp/inline.png)",
    "> quoted line",
    "```js",
    "await page.screenshot({ path: '.playwright-mcp/page-2026.png' });",
    "```",
  ].join("\n");
  expect(mcpDisplayText(source)).toBe(
    ["Result", "Screenshot of viewport", "", "quoted line", "await page.screenshot({ path: '.playwright-mcp/page-2026.png' });"].join("\n"),
  );
  // The fence's language never becomes a word of the answer.
  expect(mcpDisplayText(source)).not.toContain("js\n");
  const projected = toolSearchContent({
    name: "playwright_browser_take_screenshot",
    args: {},
    result: { content: [{ type: "text", text: source }], details: { server: "playwright" } },
  });
  expect(projected[0]).toBe(mcpDisplayText(source));
});

it("projects each gateway mode's visible values and nothing of the transport", () => {
  const search = toolSearchContent({
    name: "mcp",
    args: { search: "navigate" },
    result: {
      content: [{ type: "text", text: 'Found 2 tools matching "navigate":' }],
      details: { mode: "search", query: "navigate", count: 2, matches: [{ server: "playwright", tool: "playwright_browser_navigate", score: 318 }] },
    },
  });
  expect(search).toEqual(["navigate", "playwright", "playwright_browser_navigate", 'Found 2 tools matching "navigate":']);
  expect(search).not.toContain("318");

  // A call shows the called tool's own result; the oversized-summary fallback
  // is the envelope's own content, and neither carries the screenshot bytes.
  const call = toolSearchContent({
    name: "mcp__playwright",
    args: { tool: "playwright_browser_navigate", args: { url: "https://example.com" } },
    result: {
      content: [{ type: "text", text: "outer" }],
      details: { mode: "call", server: "playwright", tool: "browser_navigate", mcpResult: { content: [{ type: "text", text: "### Ran Playwright code" }, SCREENSHOT] } },
    },
  });
  expect(call).toEqual(["playwright_browser_navigate", "https://example.com", "Ran Playwright code"]);

  const status = toolSearchContent({
    name: "mcp",
    args: {},
    result: {
      content: [{ type: "text", text: "MCP: 1/1 servers, 24 tools" }],
      details: { mode: "status", servers: [{ name: "playwright", status: "connected", toolCount: 24, listenState: "legacy" }], directToolsFrozen: false },
    },
  });
  expect(status).toEqual(["playwright", "connected", "24", "MCP: 1/1 servers, 24 tools"]);
  expect(status).not.toContain("legacy");
});

it("projects an mcpScript's arguments and its code as both regions draw them, with the output", () => {
  const code = "await playwright.browser_navigate({ url: 'https://example.com' })";
  const values = toolSearchContent({
    name: "mcpScript",
    args: { code },
    result: { content: [{ type: "text", text: "Navigated." }], details: { calls: [{ server: "playwright", tool: "browser_navigate", ok: true }] } },
  });
  // The args disclosure and the fence are two visible regions, so two
  // occurrences; the call trace below them is chrome and is not indexed.
  expect(values).toEqual([code, code, "Navigated."]);
});

it("reads a hydrated MCP result, and refuses a block it cannot vouch for", () => {
  expect(mcpContentBlocks("### Page")).toEqual([{ kind: "text", text: "### Page" }]);
  expect(mcpContentBlocks({ content: [{ type: "image", data: "<script>", mimeType: "image/png" }, { type: "image", data: "AAAA", mimeType: "javascript:alert(1)" }, { type: "future" }] })).toEqual([]);
  expect(mcpContentBlocks({ content: [SCREENSHOT] })).toEqual([{ kind: "image", data: SCREENSHOT.data, mimeType: "image/png" }]);
});

it("projects only the final message of complete_agent_run, never its status or the harness reply", () => {
  expect(toolSearchContent({ name: "complete_agent_run", args: { status: "completed", message: "Counted the files." }, result: { content: [{ type: "text", text: "Run r1 ended with status completed." }], details: { runId: "r1", status: "completed" } } })).toEqual(["Counted the files."]);
  expect(toolSearchContent({ name: "complete_agent_run", args: { status: "blocked" }, result: "ignored" })).toEqual([]);
});
