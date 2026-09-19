import { describe, expect, it } from "vitest";

import {
  agentInitials,
  firstSentence,
  isPathShaped,
  middleTruncate,
  shortModelName,
  suffixTruncate,
} from "../../src/fleet/truncate.js";

describe("middleTruncate", () => {
  it("keeps a short value whole", () => {
    expect(middleTruncate("src/a.ts", 24)).toBe("src/a.ts");
  });
  it("keeps the tail of a path", () => {
    const path = "packages/ui/src/components/fleet/FleetPanel.tsx";
    const cut = middleTruncate(path, 24);
    expect(cut.startsWith("pack") || cut.startsWith("p")).toBe(true);
    expect(cut.endsWith("FleetPanel.tsx")).toBe(true);
    expect(cut).toContain("…");
    expect(cut).not.toBe(path);
    expect(cut.length).toBeLessThanOrEqual(24);
  });
});

describe("suffixTruncate", () => {
  it("keeps the branch suffix", () => {
    const cut = suffixTruncate("agents/explorer-1-6a5fb144", 14);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("6a5fb144")).toBe(true);
    expect(cut.length).toBe(14);
  });
});

describe("firstSentence", () => {
  it("takes the first sentence and leaves the rest", () => {
    expect(firstSentence("Served images as references. Then it packed the cache.")).toBe("Served images as references.");
  });
});

describe("isPathShaped", () => {
  it("detects paths and leaves ordinary tool names", () => {
    expect(isPathShaped("packages/ui/src/a.ts")).toBe(true);
    expect(isPathShaped("vitest")).toBe(false);
  });
});

describe("shortModelName", () => {
  it("drops the provider prefix", () => {
    expect(shortModelName("anthropic/claude-opus-4")).toBe("claude-opus-4");
  });
});

describe("agentInitials", () => {
  it("takes two letters from a single agent name", () => {
    expect(agentInitials("worker")).toBe("WO");
    expect(agentInitials("reviewer")).toBe("RE");
  });
  it("takes one letter from each word", () => {
    expect(agentInitials("code-reviewer")).toBe("CR");
  });
});
