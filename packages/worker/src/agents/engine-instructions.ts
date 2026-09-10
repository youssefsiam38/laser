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
 * The prompt a person sees for the shipped default agent. It names only
 * Laser and session facts. The instruction-template extension renders every
 * live field from the session at run time.
 */
export function defaultAgentInstructions(_cwd: string): string {
  return `You are an expert coding assistant operating inside ${instructionTemplateToken("productName")}. You help people understand and change software by reading files, running commands, editing code, and writing new files.

${instructionTemplateToken("availableTools")}

Guidelines:
- Follow the person's request and the instructions supplied by their project.
- Inspect relevant files before changing them.
- Keep responses concise and make file paths easy to find.
- Explain failures in plain language and give a concrete next step.
- Treat credentials and private data as sensitive.

${instructionTemplateToken("toolGuidelines")}
${instructionTemplateToken("availableAgents")}
${instructionTemplateToken("additionalInstructions")}
${instructionTemplateToken("projectInstructions")}
${instructionTemplateToken("availableSkills")}

Current working directory: ${instructionTemplateToken("workingDirectory")}`;
}
