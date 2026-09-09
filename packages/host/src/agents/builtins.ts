/**
 * The agents the product ships with (docs/agents-leap/references/original-request.md).
 *
 * `default` is seeded once and then belongs to the person: it is a `custom`
 * agent they may edit, make non-default and eventually delete. Beam, Chat and
 * Namer are `builtin`: rebuilt from this file on every load so a copy change
 * ships with the next release, never editable, never deletable, never the
 * default and never another agent's child. Only their model choices persist.
 */
import { join } from "node:path";
import {
  DEFAULT_AGENT_NAME,
  PRODUCT_DISPLAY_NAME,
  PRODUCT_NAME,
  type AgentDefinition,
  type AgentModelChoice,
} from "@lasercode/protocol";

/** The bundled skill Beam reads the product's data layout through. The worker writes it. */
export function beamSkillName(): string {
  return `${PRODUCT_NAME}-beam`;
}

export function beamSkillPath(agentDir: string): string {
  return join(agentDir, "skills", beamSkillName(), "SKILL.md");
}

/** The editable standard agent, as it is seeded on first run. */
export function seedDefaultAgent(at: string): AgentDefinition {
  return {
    name: DEFAULT_AGENT_NAME,
    kind: "custom",
    description: `${PRODUCT_DISPLAY_NAME}'s standard coding agent with the engine's built-in instructions.`,
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
  beamModel: AgentModelChoice | null;
  chatModel: AgentModelChoice | null;
  namerModel: AgentModelChoice | null;
  /** Stamped on every built-in as both `createdAt` and `updatedAt`. */
  at: string;
}

const BEAM_INSTRUCTIONS =
  `You are Beam, the assistant built into ${PRODUCT_DISPLAY_NAME}. You answer questions about the person's work in this app ` +
  `by reading its data directory: sessions, logs, agent definitions, settings and projects are all files there, and your ` +
  `bundled skill describes the layout. Guide them to the right screen when they ask where something is, propose concrete ` +
  `next actions when they ask what to do, and quote what you found rather than guessing. Ask before changing any file or ` +
  `setting, and never modify a session transcript.`;

const CHAT_INSTRUCTIONS =
  `You are a general assistant for conversations that are not about a project: questions, drafts, explanations and ` +
  `research. Answer directly and concretely, say when you are unsure, and use web search when the answer depends on ` +
  `current facts.`;

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
      instructions: BEAM_INSTRUCTIONS,
      engineInstructions: false,
      model: context.beamModel,
      thinkingLevel: null,
      supportsSubagents: false,
      allowedAgents: [],
      scopedSkills: true,
      skills: [{ name: beamSkillName(), path: beamSkillPath(context.agentDir), scope: "bundled" }],
      createdAt: at,
      updatedAt: at,
    },
    {
      name: "chat",
      kind: "builtin",
      description: "A general assistant for conversations that are not about a project.",
      instructions: CHAT_INSTRUCTIONS,
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
      instructions: "",
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
