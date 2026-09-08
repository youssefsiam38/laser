/**
 * Pure validation of an agent definition, shared by `agents/validate` (the
 * form's live feedback) and `agents/save` (the gate). Every issue names the
 * field it belongs to (`skills[2]`, `allowedAgents`, `name`) so the UI can put
 * the message next to the control instead of at the top of the page.
 */
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_NAME_MAX,
  AGENT_NAME_PATTERN,
  AGENT_RUN_TIMEOUT_MAX_MINUTES,
  AGENT_TOOL_NAMES,
  DEFAULT_AGENT_NAME,
  isBuiltinAgentName,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentIssue,
} from "@lasercode/protocol";

export interface ValidationContext {
  /** Every agent the store knows, custom and built-in. */
  existing: readonly AgentDefinition[];
}

/** The agents another agent may start: custom ones, never Beam, Chat or Namer. */
export function isStartableChild(agent: AgentDefinition): boolean {
  return agent.kind === "custom";
}

export function validateAgentInput(input: AgentDefinitionInput, context: ValidationContext): AgentIssue[] {
  const issues: AgentIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  // ---- name
  if (typeof input.name !== "string" || input.name.length === 0) {
    push("name", "Give this agent a name.");
  } else if (!AGENT_NAME_PATTERN.test(input.name)) {
    push(
      "name",
      `Names are lower case, start with a letter and use only letters, digits and hyphens (at most ${AGENT_NAME_MAX} characters).`,
    );
  } else if (isBuiltinAgentName(input.name)) {
    push("name", `"${input.name}" is a built-in agent. Choose another name.`);
  }

  // ---- description
  if (input.description.length > AGENT_DESCRIPTION_MAX) {
    push("description", `Keep the description to ${AGENT_DESCRIPTION_MAX} characters; other agents read it to decide when to start this one.`);
  }

  // ---- instructions
  if (input.instructions.length > AGENT_INSTRUCTIONS_MAX) {
    push("instructions", `Instructions are limited to ${Math.round(AGENT_INSTRUCTIONS_MAX / 1024)} KB.`);
  } else if (!input.engineInstructions && input.instructions.trim().length === 0) {
    push("instructions", "Write instructions, or use the engine's built-in instructions.");
  }

  // ---- tools
  const seenTools = new Set<string>();
  input.tools.forEach((tool, index) => {
    if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) {
      push(`tools[${index}]`, `"${tool}" is not a tool an agent can use.`);
    } else if (seenTools.has(tool)) {
      push(`tools[${index}]`, `"${tool}" is listed twice.`);
    }
    seenTools.add(tool);
  });

  // ---- allowedAgents
  if (!input.supportsSubagents) {
    if (input.allowedAgents.length > 0) {
      push("allowedAgents", "This agent does not start other agents, so it cannot list any.");
    }
  } else {
    const startable = new Set(context.existing.filter(isStartableChild).map((agent) => agent.name));
    // A definition may start more instances of itself, so the name being saved
    // counts as existing even before its first save.
    if (input.name && !isBuiltinAgentName(input.name)) startable.add(input.name);
    const seenAgents = new Set<string>();
    input.allowedAgents.forEach((name, index) => {
      if (isBuiltinAgentName(name)) {
        push(`allowedAgents[${index}]`, `"${name}" is a built-in agent and cannot be started by another agent.`);
      } else if (!startable.has(name)) {
        push(`allowedAgents[${index}]`, `There is no agent named "${name}".`);
      } else if (seenAgents.has(name)) {
        push(`allowedAgents[${index}]`, `"${name}" is listed twice.`);
      }
      seenAgents.add(name);
    });
  }

  // ---- skills
  if (input.scopedSkills) {
    if (input.skills.length === 0) {
      push("skills", "Choose at least one skill, or turn off scoped skills to offer every discovered skill.");
    }
    const seenSkills = new Set<string>();
    input.skills.forEach((skill, index) => {
      if (!skill.name || !skill.path) {
        push(`skills[${index}]`, "Choose this skill again; its name or file is missing.");
      } else if (seenSkills.has(skill.name)) {
        push(`skills[${index}]`, `"${skill.name}" is listed twice.`);
      }
      seenSkills.add(skill.name);
    });
  }

  // ---- run timeout
  if (input.runTimeoutMinutes !== null) {
    const minutes = input.runTimeoutMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > AGENT_RUN_TIMEOUT_MAX_MINUTES) {
      push("runTimeoutMinutes", `Use a whole number of minutes between 1 and ${AGENT_RUN_TIMEOUT_MAX_MINUTES}, or leave it empty for the default.`);
    }
  }

  // ---- model
  if (input.model !== null) {
    if (!input.model.provider || !input.model.id) {
      push("model", "Choose a model, or leave it empty to follow the default model.");
    }
  }

  return issues;
}

/** True for the one seeded agent that may be edited but never created twice. */
export function isSeededDefault(name: string): boolean {
  return name === DEFAULT_AGENT_NAME;
}
