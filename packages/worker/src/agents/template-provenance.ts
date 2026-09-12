/** Diagnostic rendering alongside the real template. Sent text is never changed. */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { INSTRUCTION_TEMPLATE_FIELDS, renderInstructionTemplate, type InstructionSource, type InstructionSourceSpan, type InstructionTemplateTarget } from "@lasercode/protocol";
import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export function templateProvenance(template: string, target: InstructionTemplateTarget, values: Record<string, string>, text: string, name: string, options: BuildSystemPromptOptions): InstructionSourceSpan[] {
  const role: InstructionSource = { kind: "agent", origin: "agent", label: `Agent · ${name}`, inline: true,
    agentName: name };
  const fallback: InstructionSource = { ...role, reason: "template-ranges-unavailable" };
  const marker = `\u0000${randomUUID()}:`;
  const keys = Object.keys(values);
  const tagged = Object.fromEntries(keys.map((key, i) => [key, `${marker}${i}:start\u0000${values[key]}${marker}${i}:end\u0000`]));
  const rendered = renderInstructionTemplate(template, target, tagged);
  const pattern = new RegExp(`${marker}(\\d+):(start|end)\\u0000`, "g");
  let current: InstructionSource = role;
  let field: string | undefined;
  let cursor = 0;
  let plain = "";
  const spans: InstructionSourceSpan[] = [];
  const append = (value: string, source: InstructionSource) => { if (!value) return; spans.push({ start: plain.length, end: plain.length + value.length, source }); plain += value; };
  const sourceFor = (key: string): InstructionSource => {
    const field = INSTRUCTION_TEMPLATE_FIELDS.find(field => field.key === key);
    const label = field?.label ?? "Instruction field";
    return { kind: "variable", origin: "variable", inline: true, label: `Variable · ${label}`,
      fieldKey: key, agentName: name };
  };
  for (const match of rendered.matchAll(pattern)) {
    const value = rendered.slice(cursor, match.index);
    // Context-file bodies are known loaded inputs, not a heading heuristic.
    if (field === "projectInstructions") {
      let at = 0;
      for (const file of options.contextFiles ?? []) {
        const wrapper = `<project_instructions path="${file.path}">\n`;
        const start = value.indexOf(wrapper, at);
        const body = start + wrapper.length;
        if (start < at || value.slice(body, body + file.content.length) !== file.content) continue;
        append(value.slice(at, body), current);
        append(file.content, { kind: "file", origin: "project", label: basename(file.path), path: file.path });
        at = body + file.content.length;
      }
      append(value.slice(at), current);
    } else if (field === "availableSkills") {
      let at = 0;
      const tool = (["read", "bash"] as const).find(name => options.selectedTools?.includes(name));
      for (const skill of tool ? (options.skills ?? []).filter(skill => !skill.disableModelInvocation) : []) {
        const catalog = formatSkillsForPrompt([skill], tool!);
        const block = catalog.slice(catalog.indexOf("  <skill>"), catalog.lastIndexOf("\n</available_skills>"));
        const start = value.indexOf(block, at);
        if (!block || start < at) continue;
        append(value.slice(at, start), current);
        append(block, { kind: "skill", origin: "skill", label: `Skill · ${skill.name}`, path: skill.filePath });
        at = start + block.length;
      }
      append(value.slice(at), current);
    } else append(value, current);
    field = match[2] === "start" ? keys[Number(match[1])] : undefined;
    current = field ? sourceFor(field) : role;
    cursor = match.index + match[0].length;
  }
  append(rendered.slice(cursor), current);
  const start = plain.length - plain.trimStart().length;
  const end = plain.trimEnd().length;
  // Whitespace controls and empty fields must match the actual renderer exactly.
  if (plain.trim() !== text) return text ? [{ start: 0, end: text.length, source: fallback }] : [];
  return spans.filter(span => span.start < end && span.end > start).map(span => ({ ...span, start: Math.max(start, span.start) - start, end: Math.min(end, span.end) - start }));
}
