import {
  PRODUCT_DISPLAY_NAME,
  instructionTemplateFields,
  type AgentModelChoice,
  type InstructionTemplateField,
  type InstructionTemplateTarget,
  type ThinkingLevel,
} from "@lasercode/protocol";

export interface InstructionTemplateValueContext {
  agentName: string;
  agentDescription: string;
  model: AgentModelChoice | null;
  thinkingLevel: ThinkingLevel | null;
  /** Names whether the value comes from unsaved form state or the current definition. */
  provenance: "Current draft" | "Current agent setting";
}

export type InstructionTemplateValue =
  | { status: "known"; value: string; provenance: string }
  | { status: "runtime"; reason: string };

export interface InstructionTemplateVariable {
  start: number;
  end: number;
  token: string;
  key: string;
  field: InstructionTemplateField | undefined;
}

const TOKEN = /\{\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}\}|\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/**
 * Finds only the two simple field forms accepted by the restricted protocol:
 * `{{field}}` / `{{{field}}}`, with optional inner whitespace. Commands,
 * malformed tokens and unknown names stay source text and are not interactive.
 */
export function instructionTemplateVariables(source: string, target: InstructionTemplateTarget): InstructionTemplateVariable[] {
  const fields = new Map(instructionTemplateFields(target).map((field) => [field.key, field]));
  const variables: InstructionTemplateVariable[] = [];
  for (const match of source.matchAll(TOKEN)) {
    const token = match[0];
    const key = match[1] ?? match[2];
    const start = match.index;
    if (!token || !key || start === undefined) continue;
    variables.push({ start, end: start + token.length, token, key, field: fields.get(key) });
  }
  return variables;
}

function runtimeReason(key: string): string {
  switch (key) {
    case "model":
      return "This agent follows the model selected when the session or naming request starts.";
    case "thinkingLevel":
      return "This agent follows the reasoning level selected when the session starts.";
    case "workingDirectory":
      return "The directory is chosen when the session starts. A child may run in its own worktree.";
    case "availableTools":
      return "The active tool list exists only after the session loads its enabled features and tools.";
    case "toolGuidelines":
      return "Tool guidance is assembled from the tools active in the session just before the request.";
    case "projectInstructions":
      return "Project instructions are loaded from the trusted project when the session starts.";
    case "availableSkills":
      return "The offered skills depend on the session’s project, trust and active tool set.";
    case "additionalInstructions":
      return "Extensions may add these instructions while the session prepares a request.";
    case "availableAgents":
      return "The child-agent catalog depends on this agent’s saved policy, session role and current nesting depth.";
    case "sessionHistoryDirectory":
    case "agentDefinitionsFile":
    case "agentRunsFile":
    case "preferencesFile":
    case "projectsFile":
    case "logsFile":
      return "The exact local path comes from the running app’s worker configuration.";
    case "namingTask":
      return "A value exists only while Namer is handling a specific title or activity-label request.";
    case "sourceText":
      return "A value exists only when Namer receives the message or action it must name.";
    case "toolName":
      return "A value exists only for an activity-label request; it is empty for a session title.";
    case "toolArguments":
      return "A value exists only for an activity-label request; it is empty for a session title.";
    default:
      return "This value is resolved when the agent runs.";
  }
}

/** The value the editor can establish without creating or borrowing a session. */
export function instructionTemplateValue(key: string, context: InstructionTemplateValueContext): InstructionTemplateValue {
  switch (key) {
    case "productName":
      return { status: "known", value: PRODUCT_DISPLAY_NAME, provenance: "Current product name" };
    case "agentName":
      return { status: "known", value: context.agentName, provenance: context.provenance };
    case "agentDescription":
      return { status: "known", value: context.agentDescription, provenance: context.provenance };
    case "model":
      return context.model
        ? { status: "known", value: `${context.model.provider}/${context.model.id}`, provenance: context.provenance }
        : { status: "runtime", reason: runtimeReason(key) };
    case "thinkingLevel":
      return context.thinkingLevel
        ? { status: "known", value: context.thinkingLevel, provenance: context.provenance }
        : { status: "runtime", reason: runtimeReason(key) };
    default:
      return { status: "runtime", reason: runtimeReason(key) };
  }
}
