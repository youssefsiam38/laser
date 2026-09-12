import { expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { INSTRUCTION_APP_ORIGIN, renderInstructionTemplate } from "@lasercode/protocol";
import { templateProvenance } from "../../src/agents/template-provenance.js";
it("attributes the actual rendered agent definition, tools, loaded project files and skill entries", () => {
  const template = "You are orchestrator.\n\n{{availableTools}}\n\n{{projectInstructions}}\n\n{{availableSkills}}";
  const skills = [{ name: "testing", description: "Use tests <always>", filePath: "/skills/testing/SKILL.md", disableModelInvocation: false }] as Skill[];
  const values = { availableTools: "Read and edit files.", projectInstructions: '<project_instructions path="/project/AGENTS.md">\nExact rule.\n</project_instructions>', availableSkills: formatSkillsForPrompt(skills, "read").trim() };
  const text = renderInstructionTemplate(template, "agent", values);
  const spans = templateProvenance(template, "agent", values, text, "orchestrator", { cwd: "/project", selectedTools: ["read"], contextFiles: [{ path: "/project/AGENTS.md", content: "Exact rule." }], skills });
  expect(spans.map(span => text.slice(span.start, span.end)).join("")).toBe(text);
  expect(spans[0]?.source).toMatchObject({ origin: "agent", label: "Agent · orchestrator", inline: true });
  expect(spans.find(span => span.source.path === "/project/AGENTS.md")).toMatchObject({ source: { origin: "project" } });
  expect(spans.find(span => span.source.path === "/skills/testing/SKILL.md")).toMatchObject({ source: { origin: "skill" } });
  expect(spans.find(span => text.slice(span.start, span.end) === values.availableTools)?.source).toMatchObject({ kind: "variable", origin: "variable", label: "Variable · Available tools", inline: true });
  expect(spans[0]?.source.agentName).toBe("orchestrator");
  expect(spans.find(span => span.source.origin === "variable")?.source).toMatchObject({
    agentName: "orchestrator", fieldKey: "availableTools",
  });
  expect(spans.every(span => !("detail" in span.source))).toBe(true);
  expect(spans.some(span => span.source.origin === INSTRUCTION_APP_ORIGIN)).toBe(false);
  expect(spans.some(span => span.source.kind === "unrecorded")).toBe(false);
});
it.each(["  {{agentName}}  ", "prefix {{~agentName~}} suffix", "{{agentName}}{{agentName}}", "{{availableTools}}\n{{agentName}}"])("does not change trim, whitespace controls or repeated substitutions: %s", template => {
  const values = { agentName: "reader", availableTools: "" };
  const text = renderInstructionTemplate(template, "agent", values);
  const spans = templateProvenance(template, "agent", values, text, "reader", { cwd: "/project" });
  expect(spans.map(span => text.slice(span.start, span.end)).join("")).toBe(text);
  expect(spans[0]?.start).toBe(0);
  expect(spans.at(-1)?.end).toBe(text.length);
});
