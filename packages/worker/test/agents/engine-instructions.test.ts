/** M13-T72 · Laser owns the default prompt; the engine contributes no copy. */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { defaultAgentInstructions, defaultToolSnippets } from "../../src/agents/engine-instructions.js";

describe("defaultAgentInstructions", () => {
  it("returns the product's neutral prompt for the actual default tools", () => {
    const text = defaultAgentInstructions("/tmp/some-project");
    expect(text).toContain("Available tools:");
    for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(text).toMatch(new RegExp(`^- ${tool}: `, "m"));
    expect(text).toContain("Guidelines:");
    expect(text).toContain(`operating inside ${PRODUCT_DISPLAY_NAME}`);
    expect(text).not.toMatch(/\bpi\b/i);
    expect(text).not.toContain("documentation");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("/tmp/some-project");
    expect(text.endsWith("\n")).toBe(false);
  });

  it("collects one-line snippets for every default tool", () => {
    const snippets = defaultToolSnippets("/tmp/x");
    expect(Object.keys(snippets).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    for (const snippet of Object.values(snippets)) expect(snippet).not.toMatch(/\n/);
  });
});
