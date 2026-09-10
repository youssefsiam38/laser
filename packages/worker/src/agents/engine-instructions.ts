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
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
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
 * Laser and session facts. Project instructions, the working directory and
 * user-authored skills are appended by the resource loader at run time.
 */
export function defaultAgentInstructions(cwd: string): string {
  const snippets = defaultToolSnippets(cwd);
  const tools = ENGINE_BUILTIN_TOOLS.map((name) => `- ${name}: ${snippets[name]}`).join("\n");
  return `You are an expert coding assistant operating inside ${PRODUCT_DISPLAY_NAME}. You help people understand and change software by reading files, running commands, editing code, and writing new files.

Available tools:
${tools}

Other tools may be available in this session. Use only tools that are actually provided.

Guidelines:
- Follow the person's request and the instructions supplied by their project.
- Inspect relevant files before changing them.
- Keep responses concise and make file paths easy to find.
- Explain failures in plain language and give a concrete next step.
- Treat credentials and private data as sensitive.`;
}
