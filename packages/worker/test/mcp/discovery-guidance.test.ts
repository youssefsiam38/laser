import { join } from "node:path";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import { adapterRoot } from "../../src/mcp/engine.js";
import { searchDiscovery } from "../../src/mcp/discovery-policy.js";
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

it.each([100, 230])("does not decorate a successful six-server search with instructions (description=%s)", length => {
  const servers = Array.from({ length: 6 }, (_, index) => `server${index}`);
  const state = {
    config: { mcpServers: Object.fromEntries(servers.map(server => [server, {}])) },
    toolMetadata: new Map(servers.map((server, index) => [server, Array.from({ length: 5 }, (_, n) => ({
      name: `tool_${index}_${n}`, originalName: `read_${n}`, description: "read " + "x".repeat(length - 5), inputSchema: { type: "object" },
    }))])),
    serverInstructions: new Map(servers.map(server => [server, "Instructions ".repeat(30)])),
    failureTracker: new Map(),
    manager: { getConnection: (_name?: string) => ({ status: "connected" }), isConnecting: () => false },
    discovery: { search: (matches: Parameters<McpPromptFreeze["search"]>[0], input: Parameters<McpPromptFreeze["search"]>[1]) =>
      searchDiscovery(matches, input, { window: 200_000, render: () => null }).page },
  };
  const search = (query: string) => JSON.parse(modes.executeSearch(state, query).content[0]!.text);
  const withInstructions = search("read");
  expect(withInstructions).not.toHaveProperty("guidance");
  expect(withInstructions.items.length).toBeGreaterThanOrEqual(8);
  if (length === 100) expect(withInstructions.items).toHaveLength(12);
  expect(search("nonexistent").guidance.join("\n")).toContain("Instructions");
  state.serverInstructions.clear();
  expect(search("read")).toEqual(withInstructions);
  state.config.mcpServers.unrelated = {};
  state.manager.getConnection = name => ({ status: name === "unrelated" ? "needs-auth" : "connected" });
  expect(search("read")).toEqual(withInstructions);
  state.serverInstructions = new Map(servers.map(server => [server, "Instructions ".repeat(30)]));
  state.manager.getConnection = () => ({ status: "needs-auth" });
  const needsAuth = search("read");
  expect(needsAuth.items).toEqual(withInstructions.items);
  expect(needsAuth.guidance.join("\n")).toContain("needs auth");
  expect(needsAuth.guidance.join("\n")).not.toContain("Instructions");
  expect(needsAuth.guidance.join("\n")).not.toContain("unrelated");
});
