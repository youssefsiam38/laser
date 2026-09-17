import { readFileSync } from "node:fs";
import type { AgentDefinition } from "@lasercode/protocol";

const CORE_INSTRUCTIONS = readFileSync(new URL("./core-instructions.md", import.meta.url), "utf8").trim();

/** Shared product-owned instructions prepended to custom agents by default. */
export function coreInstructions(): string {
  return CORE_INSTRUCTIONS;
}

/** The one prompt-selection rule used by resource loading and final rendering. */
export function agentPromptTemplate(definition: AgentDefinition, engineCustomPrompt: string): string {
  const ownTemplate = definition.engineInstructions ? engineCustomPrompt : definition.instructions;
  if (definition.kind !== "custom" || definition.excludeCoreInstructions) return ownTemplate;
  const prefixed = `${CORE_INSTRUCTIONS}\n\n`;
  return ownTemplate.startsWith(prefixed) ? ownTemplate : `${prefixed}${ownTemplate}`;
}

export function coreInstructionsLength(definition: AgentDefinition): number | undefined {
  return definition.kind === "custom" && !definition.excludeCoreInstructions ? CORE_INSTRUCTIONS.length : undefined;
}
