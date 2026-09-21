import { describe, expect, it } from "vitest";
import {
  instructionTemplateFieldRanges,
  instructionTemplateFields,
  instructionTemplateIssue,
  instructionTemplateToken,
  renderInstructionTemplate,
} from "../src/instruction-templates.js";

describe("instruction templates", () => {
  it("offers one catalogue, the agent's, with nothing a removed built-in owned", () => {
    const keys = instructionTemplateFields().map((field) => field.key);
    expect(keys).toContain("availableTools");
    expect(keys).toContain("availableAgents");
    // The state-location fields and the naming source text left with the
    // built-ins that owned them (docs/plain-chat.md).
    for (const gone of ["logsFile", "agentDefinitionsFile", "agentRunsFile", "preferencesFile", "projectsFile", "sessionHistoryDirectory", "sourceText"]) {
      expect(keys).not.toContain(gone);
    }
    expect(instructionTemplateToken("workingDirectory")).toBe("{{workingDirectory}}");
  });

  it("renders prompt text without HTML escaping paths or tool syntax", () => {
    expect(
      renderInstructionTemplate("Work in {{workingDirectory}}.\n\n{{availableTools}}", {
        workingDirectory: "/work/a&b",
        availableTools: "- read: Read <path>",
      }),
    ).toBe("Work in /work/a&b.\n\n- read: Read <path>");
  });

  it("locates only fields the canonical parser will render", () => {
    const template = String.raw`😀 escaped: \{{agentName}}
{{! {{agentName}} }} {{!-- {{model}} --}}
{{ agentName }} {{{productName}}} {{~model~}}`;
    const ranges = instructionTemplateFieldRanges(template);
    expect(ranges.map(({ key, start, end }) => [key, template.slice(start, end)])).toEqual([
      ["agentName", "{{ agentName }}"],
      ["productName", "{{{productName}}}"],
      ["model", "{{~model~}}"],
    ]);
  });

  it("exposes no live ranges when nested braces or another invalid expression makes the template unsafe", () => {
    expect(instructionTemplateFieldRanges("{{{{agentName}}}}")).toEqual([]);
    expect(instructionTemplateFieldRanges("{{agentName}} {{madeUp}}")).toEqual([]);
    expect(instructionTemplateFieldRanges("{{agentName other}}")).toEqual([]);
  });

  it("refuses unknown fields, incomplete tokens and template commands in plain language", () => {
    expect(instructionTemplateIssue("{{madeUp}}")).toContain("not available");
    expect(instructionTemplateIssue("{{workingDirectory")).toContain("incomplete");
    expect(instructionTemplateIssue("{{#if model}}x{{/if}}")).toContain("inserted fields only");
    expect(instructionTemplateIssue("{{sourceText}}")).toContain("not available");
  });
});
