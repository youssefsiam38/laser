import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "@lasercode/protocol";
import { parseAgentFile, serializeAgentFile } from "../../src/agents/agent-file.js";

function definition(instructions = "Read first.\n\nThen {{productName}} acts.\n"): AgentDefinition {
  return {
    name: "reviewer",
    kind: "custom",
    scope: "global",
    path: "/state/agents/reviewer.md",
    description: "Reviews a change",
    instructions,
    engineInstructions: false,
    excludeCoreInstructions: true,
    model: { provider: "anthropic", id: "claude/sonnet" },
    thinkingLevel: "high",
    supportsSubagents: true,
    allowedAgents: ["default", "reviewer"],
    scopedSkills: true,
    skills: [{ name: "review", path: "/skills/review/SKILL.md", scope: "global" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("agent definition Markdown files", () => {
  it.each(["body", "body\n", "body\n\n", "\nbody\n", "{{productName}}\n"]) (
    "round-trips the instructions body byte-exactly: %j",
    (instructions) => {
      const source = definition(instructions);
      const text = serializeAgentFile(source);
      const parsed = parseAgentFile(text, source.name);
      expect(parsed.issues).toBeUndefined();
      expect(parsed.definition).toEqual({ ...source, path: undefined });
      expect(parsed.definition?.instructions).toBe(instructions);
      expect(text).not.toContain("name: reviewer");
      expect(text).toContain("model: anthropic/claude/sonnet");
    },
  );

  it("defaults omitted booleans and lists, and absent or null model to the configured default", () => {
    const base = `---\ndescription: Minimal\nmodel: null\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\nDo it.\n`;
    expect(parseAgentFile(base, "minimal").definition).toMatchObject({
      model: null,
      supportsSubagents: false,
      allowedAgents: [],
      scopedSkills: false,
      skills: [],
      engineInstructions: false,
      excludeCoreInstructions: false,
    });
    expect(parseAgentFile(base.replace("model: null\n", ""), "minimal").definition?.model).toBeNull();
  });

  it.each([
    ["missing frontmatter", "Do it.", "Add YAML frontmatter"],
    ["broken YAML", "---\n[broken\n---\nDo it.", "Fix the YAML frontmatter"],
    ["duplicate key", "---\ndescription: one\ndescription: two\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\nDo it.", "Fix the YAML frontmatter"],
    ["wrong model", "---\ndescription: x\nmodel: provider-only\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\nDo it.", "provider/id"],
    ["wrong scalar type", "---\ndescription: 3\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\nDo it.", "description a string"],
    ["wrong list", "---\ndescription: x\nallowedAgents: nope\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\nDo it.", "allowedAgents a list"],
    ["wrong skill", "---\ndescription: x\nskills:\n  - name: one\n    path: /x\n    scope: elsewhere\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\nDo it.", "skills[0]"],
    ["unknown field", "---\ndescription: x\nsurprise: true\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\nDo it.", "unknown frontmatter field"],
    ["empty instructions", "---\ndescription: x\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\n", "Write instructions"],
    ["bad template", "---\ndescription: x\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\n{{unknownField}}", "not available"],
    ["bad dates", "---\ndescription: x\ncreatedAt: today\nupdatedAt: later\n---\nDo it.", "createdAt"],
  ])("reports %s in plain language", (_label, text, expected) => {
    expect(parseAgentFile(text, "reviewer").issues?.join(" ")).toContain(expected);
  });

  it("warns when a frontmatter name disagrees and always trusts the filename", () => {
    const text = serializeAgentFile(definition()).replace("description:", "name: other\ndescription:");
    expect(parseAgentFile(text, "reviewer").issues).toEqual([
      "Remove the name field or change it to “reviewer”; the filename is the agent name.",
    ]);
    expect(parseAgentFile(text.replace("name: other", "name: reviewer"), "reviewer").definition?.name).toBe("reviewer");
  });
});
