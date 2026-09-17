import { readFileSync } from "node:fs";
import type { AgentDefinition } from "@lasercode/protocol";

/** Editor notes at the top of the file (`<!-- … -->`) are for the person, never for the model. */
function stripLeadingComments(text: string): string {
  return text.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, "").trim();
}

const CORE_INSTRUCTIONS = stripLeadingComments(readFileSync(new URL("./core-instructions.md", import.meta.url), "utf8"));

/** Shared product-owned instructions prepended to custom agents by default. */
export function coreInstructions(): string {
  return CORE_INSTRUCTIONS;
}

/**
 * The system-prompt template of one agent, in its two parts. `core` is
 * present only for a custom agent that has not opted out; built-ins never
 * carry it. `template` is what is rendered, and `core.length` is where the
 * agent's own text begins inside it — provenance reads the boundary from
 * this same object, so the two can never disagree.
 */
export interface AgentPrompt {
  core?: string;
  own: string;
  template: string;
}

export function agentPrompt(definition: AgentDefinition, engineDefault: string): AgentPrompt {
  const own = definition.engineInstructions ? engineDefault : definition.instructions;
  if (definition.kind !== "custom" || definition.excludeCoreInstructions) return { own, template: own };
  const core = `${CORE_INSTRUCTIONS}\n\n`;
  return { core, own, template: `${core}${own}` };
}
