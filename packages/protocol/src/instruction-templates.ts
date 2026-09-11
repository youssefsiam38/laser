/**
 * The public vocabulary of an agent-instructions template.
 *
 * Handlebars is deliberately restricted to simple fields. The editor inserts
 * every token, so a person never needs to learn its spelling, while the stored
 * text remains portable and readable outside the UI.
 */
import Handlebars from "handlebars";
import { PRODUCT_DISPLAY_NAME } from "./identity.js";

export type InstructionTemplateTarget = "agent" | "beam" | "chat" | "namer";

export interface InstructionTemplateField {
  key: string;
  label: string;
  description: string;
  targets: readonly InstructionTemplateTarget[] | "all";
  placement: "inline" | "block";
}

const product = PRODUCT_DISPLAY_NAME;

export const INSTRUCTION_TEMPLATE_FIELDS: readonly InstructionTemplateField[] = [
  { key: "productName", label: "Product name", description: `${product}'s current display name.`, targets: "all", placement: "inline" },
  { key: "agentName", label: "Agent name", description: "The name of the agent running this instruction.", targets: "all", placement: "inline" },
  { key: "agentDescription", label: "Agent description", description: "The saved one-line purpose of this agent.", targets: "all", placement: "inline" },
  { key: "model", label: "Current model", description: "The provider and model selected for this run.", targets: "all", placement: "inline" },
  { key: "thinkingLevel", label: "Thinking level", description: "The reasoning level selected for this run.", targets: ["agent", "beam", "chat"], placement: "inline" },
  { key: "workingDirectory", label: "Working directory", description: "The directory this session is working in.", targets: ["agent", "beam", "chat"], placement: "inline" },
  { key: "availableTools", label: "Available tools", description: "A live list of every active tool and its description.", targets: ["agent", "beam", "chat"], placement: "block" },
  { key: "toolGuidelines", label: "Tool guidance", description: "Guidance supplied by the tools active in this session.", targets: ["agent", "beam", "chat"], placement: "block" },
  { key: "projectInstructions", label: "Project instructions", description: "Trusted project instruction files loaded for this session.", targets: ["agent", "beam", "chat"], placement: "block" },
  { key: "availableSkills", label: "Available skills", description: "The user and project skills offered to this agent.", targets: ["agent", "beam", "chat"], placement: "block" },
  { key: "additionalInstructions", label: "Additional instructions", description: "Any appended system instructions loaded for this session.", targets: ["agent", "beam", "chat"], placement: "block" },
  { key: "availableAgents", label: "Agents it can start", description: "The live child-agent catalog this agent may delegate to.", targets: ["agent"], placement: "block" },
  { key: "sessionHistoryDirectory", label: "Session history folder", description: `Where ${product} keeps session transcripts on this device.`, targets: ["beam"], placement: "inline" },
  { key: "agentDefinitionsFile", label: "Agent definitions file", description: `${product}'s saved agent definitions and choices.`, targets: ["beam"], placement: "inline" },
  { key: "agentRunsFile", label: "Agent runs file", description: `${product}'s durable record of agent work.`, targets: ["beam"], placement: "inline" },
  { key: "preferencesFile", label: "Preferences file", description: `${product}'s saved device preferences.`, targets: ["beam"], placement: "inline" },
  { key: "projectsFile", label: "Projects file", description: `${product}'s saved project catalog.`, targets: ["beam"], placement: "inline" },
  { key: "logsFile", label: "Logs database", description: `${product}'s local diagnostics database.`, targets: ["beam"], placement: "inline" },
  { key: "namingTask", label: "Naming task", description: "Whether Namer is creating a session title or an activity label.", targets: ["namer"], placement: "inline" },
  { key: "sourceText", label: "Source text", description: "The message or action Namer is naming right now.", targets: ["namer"], placement: "block" },
  { key: "toolName", label: "Tool name", description: "The tool being labelled; blank for a session title.", targets: ["namer"], placement: "inline" },
  { key: "toolArguments", label: "Tool arguments", description: "The action details being labelled; blank for a session title.", targets: ["namer"], placement: "block" },
] as const;

export function instructionTemplateFields(target: InstructionTemplateTarget): readonly InstructionTemplateField[] {
  return INSTRUCTION_TEMPLATE_FIELDS.filter((field) => field.targets === "all" || field.targets.includes(target));
}

export function instructionTemplateToken(key: string): string {
  return `{{${key}}}`;
}

interface AstPosition { line: number; column: number }
type AstNode = {
  type?: string;
  path?: { original?: string };
  params?: unknown[];
  hash?: { pairs?: unknown[] };
  loc?: { start: AstPosition; end: AstPosition };
  [key: string]: unknown;
};

export interface InstructionTemplateFieldRange {
  key: string;
  start: number;
  end: number;
}

interface InstructionTemplateAnalysis {
  issue: string | null;
  ranges: InstructionTemplateFieldRange[];
}

function instructionTemplateAnalysis(template: string, target: InstructionTemplateTarget): InstructionTemplateAnalysis {
  let ast: AstNode;
  try {
    ast = Handlebars.parse(template) as unknown as AstNode;
  } catch {
    return { issue: "One inserted field is incomplete. Remove it and insert the field again.", ranges: [] };
  }
  const lineStarts = [0];
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] === "\n") lineStarts.push(index + 1);
  }
  const offset = (position: AstPosition): number | undefined => {
    const lineStart = lineStarts[position.line - 1];
    return lineStart === undefined ? undefined : lineStart + position.column;
  };
  const allowed = new Set(instructionTemplateFields(target).map((field) => field.key));
  const ranges: InstructionTemplateFieldRange[] = [];
  let issue: string | null = null;
  const visit = (value: unknown): void => {
    if (issue || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as AstNode;
    if (node.type === "MustacheStatement") {
      const key = node.path?.original;
      if (!key || (node.params?.length ?? 0) > 0 || (node.hash?.pairs?.length ?? 0) > 0) {
        issue = "Instructions support inserted fields only, not template commands.";
        return;
      }
      if (!allowed.has(key)) {
        issue = `“${key}” is not available here. Remove it and choose a field from Insert field.`;
        return;
      }
      const start = node.loc ? offset(node.loc.start) : undefined;
      const end = node.loc ? offset(node.loc.end) : undefined;
      if (start !== undefined && end !== undefined) ranges.push({ key, start, end });
    } else if (node.type === "BlockStatement" || node.type === "PartialStatement" || node.type === "SubExpression") {
      issue = "Instructions support inserted fields only, not template commands.";
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);
  return { issue, ranges: issue ? [] : ranges };
}

/** Exact source ranges for valid live fields; invalid templates expose none. */
export function instructionTemplateFieldRanges(template: string, target: InstructionTemplateTarget): readonly InstructionTemplateFieldRange[] {
  return instructionTemplateAnalysis(template, target).ranges;
}

/** One actionable validation message, or null when the template is safe. */
export function instructionTemplateIssue(template: string, target: InstructionTemplateTarget): string | null {
  return instructionTemplateAnalysis(template, target).issue;
}

export function renderInstructionTemplate(
  template: string,
  target: InstructionTemplateTarget,
  values: Readonly<Record<string, string>>,
): string {
  const issue = instructionTemplateIssue(template, target);
  if (issue) throw new Error(issue);
  const context: Record<string, string> = {};
  for (const field of instructionTemplateFields(target)) context[field.key] = values[field.key] ?? "";
  return Handlebars.compile(template, { noEscape: true, strict: true })(context).trim();
}
