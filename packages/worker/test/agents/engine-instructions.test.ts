/**
 * M13-T3 · the engine's built-in instructions are served from the pinned
 * engine for real, without the working-directory line.
 */
import { describe, expect, it } from "vitest";
import { defaultToolSnippets, engineDefaultInstructions, stripWorkingDirectory } from "../../src/agents/engine-instructions.js";

describe("engineDefaultInstructions", () => {
  it("returns the engine's prompt for the default tools without the cwd line", async () => {
    const text = await engineDefaultInstructions("/tmp/some-project");
    expect(text).toContain("Available tools:");
    for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(text).toMatch(new RegExp(`^- ${tool}: `, "m"));
    expect(text).toContain("Guidelines:");
    expect(text).not.toContain("Current working directory");
    expect(text).not.toContain("/tmp/some-project");
    expect(text.endsWith("\n")).toBe(false);
  });

  it("collects one-line snippets for every default tool", () => {
    const snippets = defaultToolSnippets("/tmp/x");
    expect(Object.keys(snippets).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    for (const snippet of Object.values(snippets)) expect(snippet).not.toMatch(/\n/);
  });

  it("strips only the trailing working-directory line", () => {
    expect(stripWorkingDirectory("Prompt body.\n\nCurrent working directory: /a/b\n")).toBe("Prompt body.");
    expect(stripWorkingDirectory("No cwd here")).toBe("No cwd here");
  });
});
