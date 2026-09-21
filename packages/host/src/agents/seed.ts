/**
 * The one agent the product seeds.
 *
 * `default` is written once and then belongs to the person: it is an ordinary
 * agent they may edit, make non-default and eventually delete. Nothing else is
 * synthesised — Beam, Chat and Namer stopped being agents in M23 (D-347), and
 * the Agents page shows only agents a person wrote (`docs/plain-chat.md`).
 */
import { DEFAULT_AGENT_NAME, PRODUCT_DISPLAY_NAME, type AgentDefinition } from "@lasercode/protocol";

/** The editable standard agent, as it is seeded on first run. */
export function seedDefaultAgent(at: string): AgentDefinition {
  return {
    name: DEFAULT_AGENT_NAME,
    kind: "custom",
    scope: "global",
    description: `${PRODUCT_DISPLAY_NAME}'s standard coding agent with its default instructions.`,
    instructions: "",
    engineInstructions: true,
    excludeCoreInstructions: false,
    profileId: null,
    thinkingLevel: null,
    supportsSubagents: true,
    allowedAgents: [DEFAULT_AGENT_NAME],
    scopedSkills: false,
    skills: [],
    createdAt: at,
    updatedAt: at,
  };
}
