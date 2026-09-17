/** M13-T72 · Laser owns the default prompt; the engine contributes no copy. */
import { instructionTemplateToken } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { defaultAgentInstructions, defaultToolSnippets } from "../../src/agents/engine-instructions.js";

describe("defaultAgentInstructions", () => {
  it("returns the product's neutral template with every live prompt field placed", () => {
    const text = defaultAgentInstructions("/tmp/some-project");
    expect(text).toContain(instructionTemplateToken("availableTools"));
    expect(text).toContain(instructionTemplateToken("toolGuidelines"));
    expect(text).toContain(instructionTemplateToken("projectInstructions"));
    expect(text).toContain(instructionTemplateToken("availableSkills"));
    expect(text).toContain(instructionTemplateToken("workingDirectory"));
    expect(text).toContain("expert coding assistant");
    expect(text).not.toContain(instructionTemplateToken("productName"));
    expect(text).not.toContain("Operating rules");
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
