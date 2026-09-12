import { join } from "node:path";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import { adapterRoot } from "../../src/mcp/engine.js";
import { McpPromptFreeze } from "../../src/mcp/prompt-freeze.js";

type Result = { content: Array<{ text: string }> };
const jiti = createJiti(import.meta.url, { fsCache: false });
const modes = await jiti.import<{
  executeSearch: (state: unknown, query: string, regex?: boolean, server?: string) => Result;
  executeList: (state: unknown, server: string) => Result;
}>(join(adapterRoot(), "proxy-modes.ts"));

describe("progressive gateway guidance", () => {
  it.each([
    ["not-connected", "is configured but not connected", false],
    ["needs-auth", "needs auth", false],
    ["connecting", "still connecting", false],
    ["not-connected", "no cached tools (not connected)", true],
  ] as const)("retains %s guidance (cached=%s) for search and list", (status, message, cached) => {
    const state = {
      config: { mcpServers: { fixture: {} } },
      toolMetadata: new Map(cached ? [["fixture", []]] : []),
      serverInstructions: new Map([["fixture", "Choose a workspace before reading documents."]]),
      failureTracker: new Map(),
      manager: {
        getConnection: () => ({ status }),
        isConnecting: () => status === "connecting",
      },
      discovery: new McpPromptFreeze(),
    };
    for (const result of [modes.executeSearch(state, "missing", false, "fixture"), modes.executeList(state, "fixture")]) {
      const response = JSON.parse(result.content[0]!.text);
      expect(response.total).toBe(0);
      expect(response.guidance.join("\n")).toContain(message);
      expect(response.guidance.join("\n")).toContain("Choose a workspace before reading documents.");
      expect(response.guidance.join("\n")).toContain('instructions: "fixture"');
    }
  });
});
