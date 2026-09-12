import { describe, expect, it } from "vitest";
import { searchDiscovery, UNKNOWN_WINDOW_LOOKUP_BYTES, DISCOVERY_GUIDANCE_BYTES, bytes, type Match } from "../../src/mcp/discovery-policy.js";

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

it("admits the same full item page before adding separately capped guidance", () => {
  const context = { window: 200_000, render };
  const plain = searchDiscovery(matches, { query: "read" }, context).page;
  const annotated = searchDiscovery(matches, { query: "read", guidance: Array.from({ length: 6 }, (_, n) => `Server ${n}: ${"instructions ".repeat(30)}`) }, context).page;
  expect(plain.items).toHaveLength(12);
  const { guidance, guidanceTruncated, ...itemsPage } = annotated;
  expect(itemsPage).toEqual(plain);
  expect(guidanceTruncated).toBe(true);
  expect(bytes({ guidance, guidanceTruncated })).toBeLessThanOrEqual(DISCOVERY_GUIDANCE_BYTES);
});

it("bounds empty-result guidance in serialized UTF-8 bytes without splitting Unicode", () => {
  const { page } = searchDiscovery([], { query: "read", guidance: ["Sign in first. " + '\"😀\n'.repeat(2000)] }, { window: 200_000, render });
  expect(page.items).toEqual([]);
  expect((page.guidance as string[])[0]).toContain("Sign in first.");
  expect(bytes({ guidance: page.guidance, guidanceTruncated: page.guidanceTruncated })).toBeLessThanOrEqual(DISCOVERY_GUIDANCE_BYTES);
  expect(JSON.stringify(page)).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
});
