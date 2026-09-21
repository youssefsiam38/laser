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
  instructionTemplateToken,
  renderInstructionTemplate,
} from "@lasercode/protocol";
import type { DriverAgentOptions } from "../driver.js";
import { recordInstructionWrite } from "@lasercode/pi-extension";
import { agentPrompt } from "./core-instructions.js";
import { templateProvenance } from "./template-provenance.js";

interface TemplateExtensionOptions {
  agent: DriverAgentOptions;
  agentDir: string;
  session: () => AgentSession | undefined;
}

/**
 * The whole system prompt of a plain Chat conversation (`docs/plain-chat.md`):
 * the live tool catalogue, the guidance those tools supply, and the skills
 * that were discovered. Nothing else — no identity paragraph, no product
 * name, no project instructions, no role or goal block — because a Chat is
 * not an agent and has nobody's persona to wear.
 *
 * It is a constant, not a definition: there is no editor for it and no stored
 * override behind it.
 */
export const CHAT_INSTRUCTION_TEMPLATE = [
  instructionTemplateToken("availableTools"),
  instructionTemplateToken("toolGuidelines"),
  instructionTemplateToken("availableSkills"),
].join("\n\n");

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

export const ACTIVITY_LABEL_GUIDANCE =
  'Write every activity_label as a short human-readable present-progressive phrase in sentence case with spaces—never a slug, dash- or underscore-separated words, or camelCase. Example: "Reading build config".';

function toolGuidelinesBlock(options: BuildSystemPromptOptions): string {
  const guidelines = [...new Set([ACTIVITY_LABEL_GUIDANCE, ...(options.promptGuidelines ?? []).map((line) => line.trim()).filter(Boolean)])];
  return `Tool guidance:\n${guidelines.map((line) => `- ${line}`).join("\n")}`;
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
  const { agent } = extension;
  const definition = agent.definition;
  const model = context.model ? `${context.model.provider}/${context.model.id}` : "Following the session default";
  return {
    productName: PRODUCT_DISPLAY_NAME,
    agentName: definition?.name ?? "",
    agentDescription: definition?.description ?? "",
    model,
    thinkingLevel: context.thinkingLevel ?? definition?.thinkingLevel ?? "Following the model default",
    workingDirectory: options.cwd.replace(/\\/g, "/"),
    availableTools: toolsBlock(options, extension.session()),
    toolGuidelines: toolGuidelinesBlock(options),
    projectInstructions: projectInstructionsBlock(options),
    availableSkills: skillsBlock(options),
    additionalInstructions: options.appendSystemPrompt?.trim() ?? "",
    availableAgents: availableAgentsBlock(agent),
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
        const definition = options.agent.definition;
        // A Chat has no definition at all, so there is no core-instructions
        // block, no saved template and nothing to fall back to: the prompt is
        // the three fields and only the three fields.
        const prompt = definition
          ? agentPrompt(definition, event.systemPromptOptions.customPrompt ?? "")
          : { template: CHAT_INSTRUCTION_TEMPLATE, core: undefined };
        const template = prompt.template;
        const values = instructionTemplateValues(event.systemPromptOptions, context, options);
        const systemPrompt = renderInstructionTemplate(template, values);
        const label = definition ? `Agent · ${definition.name}` : "Chat";
        try {
          return recordInstructionWrite({ systemPrompt }, templateProvenance(
            template,
            values,
            systemPrompt,
            definition?.name,
            event.systemPromptOptions,
            prompt.core?.length,
            definition?.path,
          ));
        } catch {
          return recordInstructionWrite({ systemPrompt }, {
            kind: "agent",
            origin: "agent",
            label,
            ...(definition ? { agentName: definition.name } : {}),
            reason: "template-ranges-unavailable",
            ...(definition?.path ? { path: definition.path } : { inline: true as const }),
          });
        }
      });
    },
  };
}
