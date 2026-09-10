/**
 * The agents the product ships with (docs/agents-leap/references/original-request.md).
 *
 * `default` is seeded once and then belongs to the person: it is a `custom`
 * agent they may edit, make non-default and eventually delete. Beam, Chat and
 * Namer are `builtin`: rebuilt from this file on every load so a copy change
 * ships with the next release unless the person has deliberately overridden
 * its instructions. They remain undeletable, never the default and never
 * another agent's child. Their instruction and model choices persist.
 */
import {
  DEFAULT_AGENT_NAME,
  PRODUCT_DISPLAY_NAME,
  instructionTemplateToken,
  type AgentDefinition,
  type BuiltinInstructionOverrides,
  type AgentModelChoice,
} from "@lasercode/protocol";

/** The editable standard agent, as it is seeded on first run. */
export function seedDefaultAgent(at: string): AgentDefinition {
  return {
    name: DEFAULT_AGENT_NAME,
    kind: "custom",
    description: `${PRODUCT_DISPLAY_NAME}'s standard coding agent with its default instructions.`,
    instructions: "",
    engineInstructions: true,
    model: null,
    thinkingLevel: null,
    supportsSubagents: true,
    allowedAgents: [DEFAULT_AGENT_NAME],
    scopedSkills: false,
    skills: [],
    createdAt: at,
    updatedAt: at,
  };
}

export interface BuiltinContext {
  agentDir: string;
  stateDir: string;
  beamModel: AgentModelChoice | null;
  chatModel: AgentModelChoice | null;
  namerModel: AgentModelChoice | null;
  instructions: BuiltinInstructionOverrides;
  /** Stamped on every built-in as both `createdAt` and `updatedAt`. */
  at: string;
}

function beamInstructions(_context: Pick<BuiltinContext, "agentDir" | "stateDir">): string {
  return `You are Beam, the assistant built into ${instructionTemplateToken("productName")}. Help the person understand and navigate their work in the app.

Inspect the relevant data before answering instead of guessing:
- Sessions: ${instructionTemplateToken("sessionHistoryDirectory")}
- Agent definitions and choices: ${instructionTemplateToken("agentDefinitionsFile")}
- Agent runs: ${instructionTemplateToken("agentRunsFile")}
- Preferences: ${instructionTemplateToken("preferencesFile")}
- Projects: ${instructionTemplateToken("projectsFile")}
- Logs: ${instructionTemplateToken("logsFile")}

Session transcripts are JSONL. Never edit, move or delete them. Never read or reveal provider credentials. Guide the person using ${PRODUCT_DISPLAY_NAME}'s visible names: the Sessions sidebar, Chat and Code tabs, Agents, Logs, Settings, the fleet and the agent map. Give concrete next actions, quote the paths you inspected, and ask before changing any setting or file.

${instructionTemplateToken("availableTools")}
${instructionTemplateToken("toolGuidelines")}
${instructionTemplateToken("availableSkills")}`;
}

const CHAT_INSTRUCTIONS =
  `You are a general assistant for conversations that are not about a project: questions, drafts, explanations and ` +
  `research. Answer directly and concretely, say when you are unsure, and use web search when the answer depends on ` +
  `current facts.\n\n${instructionTemplateToken("availableTools")}\n\n${instructionTemplateToken("toolGuidelines")}\n${instructionTemplateToken("availableSkills")}`;

const NAMER_INSTRUCTIONS =
  "You name sessions from what the person wants done and label running actions by what they are doing. Keep every name concrete, brief and easy to scan.";

const BUILTIN_DEFAULT_INSTRUCTIONS: Readonly<Record<"chat" | "namer", string>> = {
  chat: CHAT_INSTRUCTIONS,
  namer: NAMER_INSTRUCTIONS,
};

/** Beam, Chat and Namer, in the order the catalog shows them. */
export function builtinAgents(context: BuiltinContext): AgentDefinition[] {
  const { at } = context;
  return [
    {
      name: "beam",
      kind: "builtin",
      description:
        `Your fast assistant for ${PRODUCT_DISPLAY_NAME}: it reads your sessions, logs, agents and settings and explains ` +
        `how to get things done here.`,
      instructions: context.instructions.beam ?? beamInstructions(context),
      engineInstructions: false,
      model: context.beamModel,
      thinkingLevel: null,
      supportsSubagents: false,
      allowedAgents: [],
      scopedSkills: false,
      skills: [],
      createdAt: at,
      updatedAt: at,
    },
    {
      name: "chat",
      kind: "builtin",
      description: "A general assistant for conversations that are not about a project.",
      instructions: context.instructions.chat ?? BUILTIN_DEFAULT_INSTRUCTIONS.chat,
      engineInstructions: false,
      model: context.chatModel,
      thinkingLevel: null,
      supportsSubagents: false,
      allowedAgents: [],
      scopedSkills: false,
      skills: [],
      createdAt: at,
      updatedAt: at,
    },
    {
      name: "namer",
      kind: "builtin",
      description: "Names sessions and running actions with a fast, inexpensive model.",
      instructions: context.instructions.namer ?? BUILTIN_DEFAULT_INSTRUCTIONS.namer,
      engineInstructions: false,
      model: context.namerModel,
      thinkingLevel: null,
      supportsSubagents: false,
      allowedAgents: [],
      scopedSkills: false,
      skills: [],
      createdAt: at,
      updatedAt: at,
    },
  ];
}
