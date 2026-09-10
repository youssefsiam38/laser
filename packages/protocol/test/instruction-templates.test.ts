import { describe, expect, it } from "vitest";
import {
  instructionTemplateFields,
  instructionTemplateIssue,
  instructionTemplateToken,
  renderInstructionTemplate,
} from "../src/instruction-templates.js";

describe("instruction templates", () => {
  it("offers only fields that can be rendered for the selected agent", () => {
    expect(instructionTemplateFields("agent").map((field) => field.key)).toContain("availableTools");
    expect(instructionTemplateFields("agent").map((field) => field.key)).not.toContain("logsFile");
    expect(instructionTemplateFields("beam").map((field) => field.key)).toContain("logsFile");
    expect(instructionTemplateFields("namer").map((field) => field.key)).toContain("sourceText");
    expect(instructionTemplateToken("workingDirectory")).toBe("{{workingDirectory}}");
  });

  it("renders prompt text without HTML escaping paths or tool syntax", () => {
    expect(
      renderInstructionTemplate("Work in {{workingDirectory}}.\n\n{{availableTools}}", "agent", {
        workingDirectory: "/work/a&b",
        availableTools: "- read: Read <path>",
      }),
    ).toBe("Work in /work/a&b.\n\n- read: Read <path>");
  });

  it("refuses unknown fields, incomplete tokens and template commands in plain language", () => {
    expect(instructionTemplateIssue("{{madeUp}}", "agent")).toContain("not available");
    expect(instructionTemplateIssue("{{workingDirectory", "agent")).toContain("incomplete");
    expect(instructionTemplateIssue("{{#if model}}x{{/if}}", "agent")).toContain("inserted fields only");
    expect(instructionTemplateIssue("{{sourceText}}", "agent")).toContain("not available");
  });
});
