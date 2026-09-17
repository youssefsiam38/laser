/**
 * Laser's default system prompt. The runtime beneath this file supplies tool
 * implementations, project context and discovered skills, but does not own
 * the product's identity or operating instructions.
 */
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { instructionTemplateToken } from "@lasercode/protocol";
import { ENGINE_BUILTIN_TOOLS } from "./session-config.js";

/** One-line snippets for the default tools, exactly as the engine registers them. */
export function defaultToolSnippets(cwd: string): Record<string, string> {
  const definitions = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
  const snippets: Record<string, string> = {};
  for (const definition of definitions) {
    const snippet = (definition as { promptSnippet?: string }).promptSnippet;
    if (snippet) snippets[definition.name] = snippet.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }
  return snippets;
}

/**
 * The agent-specific prompt a person sees for the shipped default agent.
 * Shared product identity and operating rules come from core-instructions.md;
 * the instruction-template extension renders every live field at run time.
 */
export function defaultAgentInstructions(_cwd: string): string {
  return `You are an expert coding assistant. You help people understand and change software by reading files, running commands, editing code, and writing new files.

${instructionTemplateToken("availableTools")}

${instructionTemplateToken("toolGuidelines")}
${instructionTemplateToken("availableAgents")}
${instructionTemplateToken("additionalInstructions")}
${instructionTemplateToken("projectInstructions")}
${instructionTemplateToken("availableSkills")}

Current working directory: ${instructionTemplateToken("workingDirectory")}`;
}
