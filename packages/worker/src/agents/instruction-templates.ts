/** Render one saved instruction template from the live session resources. */
import {
  formatSkillsForPrompt,
  type AgentSession,
  type BuildSystemPromptOptions,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  PRODUCT_DISPLAY_NAME,
  WIRE_NAMESPACE,
  renderInstructionTemplate,
  type InstructionTemplateTarget,
} from "@lasercode/protocol";
import { join, resolve } from "node:path";
import type { DriverAgentOptions } from "../driver.js";

interface TemplateExtensionOptions {
  agent: DriverAgentOptions;
  agentDir: string;
  stateDir?: string;
  session: () => AgentSession | undefined;
}

function targetOf(agent: DriverAgentOptions): InstructionTemplateTarget {
  const name = agent.definition.name;
  return name === "beam" || name === "chat" ? name : "agent";
}

function toolsBlock(options: BuildSystemPromptOptions, session: AgentSession | undefined): string {
  const names = options.selectedTools ?? session?.getActiveToolNames() ?? [];
  if (names.length === 0) return "Available tools:\n(none)";
  const lines = names.map((name) => {
    const definition = session?.getToolDefinition(name) as { promptSnippet?: string; description?: string } | undefined;
    const description = definition?.promptSnippet?.trim() || definition?.description?.replace(/\s+/g, " ").trim() || options.toolSnippets?.[name]?.trim();
    return description ? `- ${name}: ${description}` : `- ${name}`;
  });
  return `Available tools:\n${lines.join("\n")}`;
}

function toolGuidelinesBlock(options: BuildSystemPromptOptions): string {
  const guidelines = [...new Set((options.promptGuidelines ?? []).map((line) => line.trim()).filter(Boolean))];
  return guidelines.length > 0 ? `Tool guidance:\n${guidelines.map((line) => `- ${line}`).join("\n")}` : "";
}

function projectInstructionsBlock(options: BuildSystemPromptOptions): string {
  const files = options.contextFiles ?? [];
  if (files.length === 0) return "";
  return [
    "<project_context>",
    "Project-specific instructions and guidelines:",
    ...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
    "</project_context>",
  ].join("\n\n");
}

function skillsBlock(options: BuildSystemPromptOptions): string {
  const readTool = (["read", "bash"] as const).find((name) => options.selectedTools?.includes(name));
  return readTool && (options.skills?.length ?? 0) > 0 ? formatSkillsForPrompt(options.skills ?? [], readTool).trim() : "";
}

function availableAgentsBlock(agent: DriverAgentOptions): string {
  const catalog = agent.bridge?.catalog() ?? [];
  return catalog.length > 0
    ? `Agents this agent can start:\n${catalog.map((entry) => `- ${entry.agentName}: ${entry.description}`).join("\n")}`
    : "";
}

export function instructionTemplateValues(
  options: BuildSystemPromptOptions,
  context: { model?: { provider: string; id: string } | undefined; thinkingLevel?: string | undefined },
  extension: TemplateExtensionOptions,
): Record<string, string> {
  const { agent, agentDir } = extension;
  const stateDir = resolve(extension.stateDir ?? join(agentDir, "..", "state"));
  const model = context.model ? `${context.model.provider}/${context.model.id}` : "Following the session default";
  return {
    productName: PRODUCT_DISPLAY_NAME,
    agentName: agent.definition.name,
    agentDescription: agent.definition.description,
    model,
    thinkingLevel: context.thinkingLevel ?? agent.definition.thinkingLevel ?? "Following the model default",
    workingDirectory: options.cwd.replace(/\\/g, "/"),
    availableTools: toolsBlock(options, extension.session()),
    toolGuidelines: toolGuidelinesBlock(options),
    projectInstructions: projectInstructionsBlock(options),
    availableSkills: skillsBlock(options),
    additionalInstructions: options.appendSystemPrompt?.trim() ?? "",
    availableAgents: availableAgentsBlock(agent),
    sessionHistoryDirectory: join(agentDir, "sessions"),
    agentDefinitionsFile: join(stateDir, "agents.json"),
    agentRunsFile: join(stateDir, "agent-runs.json"),
    preferencesFile: join(stateDir, "prefs.json"),
    projectsFile: join(stateDir, "projects.json"),
    logsFile: join(stateDir, "logs.db"),
  };
}

/**
 * This is registered before the companion extension. It replaces the engine's
 * auto-appended prompt with the person's rendered template; later compulsory
 * role/goal blocks can still append themselves in the normal event chain.
 */
export function createInstructionTemplateExtension(options: TemplateExtensionOptions): InlineExtension {
  return {
    name: `${WIRE_NAMESPACE}/instruction-template`,
    factory: (pi) => {
      pi.on("before_agent_start", (event, context) => {
        const template = options.agent.definition.engineInstructions ? event.systemPromptOptions.customPrompt ?? "" : options.agent.definition.instructions;
        const target = targetOf(options.agent);
        const values = instructionTemplateValues(event.systemPromptOptions, context, options);
        return { systemPrompt: renderInstructionTemplate(template, target, values) };
      });
    },
  };
}
