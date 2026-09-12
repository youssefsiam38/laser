import { describe, expect, it } from "vitest";
import { searchDiscovery, UNKNOWN_WINDOW_LOOKUP_BYTES, bytes, type Match } from "../../src/mcp/discovery-policy.js";

const matches: Match[] = Array.from({ length: 60 }, (_, index) => ({
  server: index % 2 ? "first" : "second", score: 100 - index,
  tool: {
    name: `tool_${index}`, originalName: `read_${index}`, description: "Read one document",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    outputSchema: { type: "string" },
  },
}));
const render = () => null;

describe("pure discovery policy", () => {
  it.each(["names", "summary", "full"])("keeps unknown-window %s discovery useful without claiming a share", detail => {
    const result = searchDiscovery(matches, { query: "read", detail }, { window: null, render });
    expect(result.page.items).toHaveLength(12);
    expect(result.detail).toBe(detail === "names" ? "names" : "summary");
    expect(result.page.message).toContain("share unavailable");
    expect(bytes(result.page)).toBeLessThanOrEqual(UNKNOWN_WINDOW_LOOKUP_BYTES);
    for (const item of result.page.items as Record<string, unknown>[]) expect(item).not.toHaveProperty("inputSchema");
    const next = searchDiscovery(matches, { query: "read", detail, offset: 12 }, {
      window: null, render, previousRevision: result.catalogRevision,
    });
    expect((next.page.items as Record<string, unknown>[])[0]?.path).toBe("tool_12");
  });

  it("retains empty-result connection guidance in the measured response", () => {
    const result = searchDiscovery([], { query: "read", guidance: ["Connect to the configured server first."] }, {
      window: 1_000_000, render,
    });
    expect(result.page).toMatchObject({ total: 0, guidance: ["Connect to the configured server first."] });
  });
});
