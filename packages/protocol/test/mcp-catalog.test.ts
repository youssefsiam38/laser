import { describe, expect, it } from "vitest";
import { mcpToolCatalogStateSchema } from "../src/schemas.js";
import type { McpInspection, McpRuntimeSnapshot, McpServerState } from "../src/mcp.js";

describe("MCP catalogue observation data", () => {
  it("round-trips through inspection, saved-server and runtime payloads without treating zero lifetime as fresh", () => {
    const toolCatalog = { checkedAt: 1000, expiresAt: 1000 };
    const inspection: McpInspection = { name: "fixture", scope: "project", status: "connected", tools: [], resources: [], prompts: [], toolCatalog };
    const server: McpServerState = { scope: "project", config: { name: "fixture" }, status: "unknown", toolCatalog };
    const runtime: McpRuntimeSnapshot = { servers: [{ name: "fixture", status: "unknown", toolCount: 0, directToolCount: 0, authorizationRevision: "a".repeat(64), toolCatalog }], totalTools: 0, connectedCount: 0 };
    for (const payload of [inspection, server, runtime.servers[0]!]) {
      const decoded = JSON.parse(JSON.stringify(payload));
      expect(mcpToolCatalogStateSchema.parse(decoded.toolCatalog)).toEqual(toolCatalog);
      expect(decoded.toolCatalog.expiresAt > decoded.toolCatalog.checkedAt).toBe(false);
    }
  });

  it.each([{ checkedAt: -1, expiresAt: 0 }, { checkedAt: 10, expiresAt: 9 }, { checkedAt: 1, expiresAt: Infinity }, { checkedAt: 1.5, expiresAt: 2 }, { checkedAt: 1, expiresAt: 2, credential: "not-allowed" }])("rejects malformed freshness (%j)", value => {
    expect(mcpToolCatalogStateSchema.safeParse(value).success).toBe(false);
  });
});
