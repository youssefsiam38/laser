import {
  AGENT_DESCRIPTION_MAX,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_NAME_PATTERN,
  instructionTemplateIssue,
  type AgentDefinition,
  type AgentModelChoice,
  type AgentSkillRef,
} from "@lasercode/protocol";
import { parseDocument, stringify } from "yaml";

export type AgentFileParseResult = { definition: AgentDefinition; issues?: never } | { definition?: never; issues: string[] };

const FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "model",
  "thinkingLevel",
  "supportsSubagents",
  "allowedAgents",
  "scopedSkills",
  "skills",
  "engineInstructions",
  "excludeCoreInstructions",
  "createdAt",
  "updatedAt",
]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Parse one definition file. Its identity always comes from `name`, the filename stem. */
export function parseAgentFile(text: string, name: string, fallbackTimestamp = new Date().toISOString()): AgentFileParseResult {
  const issues: string[] = [];
  if (!AGENT_NAME_PATTERN.test(name)) {
    return { issues: [`Rename the file so its name is lower case, starts with a letter, and uses only letters, digits and hyphens.`] };
  }

  const split = splitFrontmatter(text);
  if (!split) return { issues: ["Add YAML frontmatter between opening and closing --- lines."] };

  const document = parseDocument(split.yaml, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    return { issues: document.errors.map((error) => `Fix the YAML frontmatter: ${oneLine(error.message)}`) };
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return { issues: [`Fix the YAML frontmatter: ${error instanceof Error ? oneLine(error.message) : "it could not be read"}.`] };
  }
  if (!isRecord(value)) return { issues: ["Make the YAML frontmatter a mapping of field names to values."] };
  for (const key of Object.keys(value)) {
    if (!FRONTMATTER_KEYS.has(key)) issues.push(`Remove the unknown frontmatter field “${key}”.`);
  }
  if (value.name !== undefined && value.name !== name) {
    issues.push(`Remove the name field or change it to “${name}”; the filename is the agent name.`);
  }

  const description = readString(value, "description", "description", issues, "");
  if (description.length > AGENT_DESCRIPTION_MAX) issues.push(`Shorten description to at most ${AGENT_DESCRIPTION_MAX} characters.`);
  const model = readModel(value.model, issues);
  const thinkingLevel = readThinkingLevel(value.thinkingLevel, issues);
  const supportsSubagents = readBoolean(value, "supportsSubagents", issues);
  const allowedAgents = readStringList(value.allowedAgents, "allowedAgents", issues);
  const scopedSkills = readBoolean(value, "scopedSkills", issues);
  const skills = readSkills(value.skills, issues);
  const engineInstructions = readBoolean(value, "engineInstructions", issues);
  const excludeCoreInstructions = readBoolean(value, "excludeCoreInstructions", issues);
  const createdAt = readTimestamp(value.createdAt, "createdAt", issues, fallbackTimestamp);
  const updatedAt = readTimestamp(value.updatedAt, "updatedAt", issues, fallbackTimestamp);

  if (split.body.length > AGENT_INSTRUCTIONS_MAX) {
    issues.push(`Shorten the instructions body to at most ${Math.round(AGENT_INSTRUCTIONS_MAX / 1024)} KB.`);
  } else if (!engineInstructions) {
    if (split.body.trim().length === 0) issues.push("Write instructions in the Markdown body, or set engineInstructions to true.");
    else {
      const templateIssue = instructionTemplateIssue(split.body, "agent");
      if (templateIssue) issues.push(templateIssue);
    }
  }
  if (!supportsSubagents && allowedAgents.length > 0) {
    issues.push("Remove allowedAgents, or set supportsSubagents to true.");
  }
  if (scopedSkills && skills.length === 0) {
    issues.push("List at least one skill, or set scopedSkills to false.");
  }
  if (issues.length > 0) return { issues };

  return {
    definition: {
      name,
      kind: "custom",
      scope: "global",
      description,
      instructions: split.body,
      engineInstructions,
      excludeCoreInstructions,
      model,
      thinkingLevel,
      supportsSubagents,
      allowedAgents,
      scopedSkills,
      skills,
      createdAt,
      updatedAt,
    },
  };
}

/** Write stable YAML frontmatter and preserve the instructions body byte-for-byte. */
export function serializeAgentFile(definition: AgentDefinition): string {
  const frontmatter = {
    description: definition.description,
    model: definition.model ? `${definition.model.provider}/${definition.model.id}` : null,
    thinkingLevel: definition.thinkingLevel,
    supportsSubagents: definition.supportsSubagents,
    allowedAgents: definition.allowedAgents,
    scopedSkills: definition.scopedSkills,
    skills: definition.skills.map((skill) => ({ name: skill.name, path: skill.path, scope: skill.scope })),
    engineInstructions: definition.engineInstructions,
    excludeCoreInstructions: definition.excludeCoreInstructions,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${definition.instructions}`;
}

function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
  let cursor: number;
  if (text.startsWith("---\n")) cursor = 4;
  else if (text.startsWith("---\r\n")) cursor = 5;
  else return undefined;

  while (cursor <= text.length) {
    const newline = text.indexOf("\n", cursor);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, end).replace(/\r$/, "");
    if (line === "---") {
      return {
        yaml: text.slice(text.startsWith("---\r\n") ? 5 : 4, cursor),
        body: newline === -1 ? "" : text.slice(newline + 1),
      };
    }
    if (newline === -1) break;
    cursor = newline + 1;
  }
  return undefined;
}

function readString(record: Record<string, unknown>, key: string, label: string, issues: string[], fallback: string): string {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  issues.push(`Make ${label} a string.`);
  return fallback;
}

function readBoolean(record: Record<string, unknown>, key: string, issues: string[]): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  issues.push(`Make ${key} true or false.`);
  return false;
}

function readModel(value: unknown, issues: string[]): AgentModelChoice | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    issues.push("Make model a provider/id string, or null to follow the default.");
    return null;
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    issues.push("Write model as provider/id, or use null to follow the default.");
    return null;
  }
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function readThinkingLevel(value: unknown, issues: string[]): AgentDefinition["thinkingLevel"] {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && THINKING_LEVELS.has(value)) return value as AgentDefinition["thinkingLevel"];
  issues.push("Choose a valid thinkingLevel, or use null to follow the default.");
  return null;
}

function readStringList(value: unknown, field: string, issues: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    issues.push(`Make ${field} a list of names.`);
    return [];
  }
  return [...value];
}

function readSkills(value: unknown, issues: string[]): AgentSkillRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("Make skills a list of { name, path, scope } entries.");
    return [];
  }
  const skills: AgentSkillRef[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(`Make skills[${index}] an entry with name, path and scope.`);
      return;
    }
    const keys = Object.keys(item);
    if (keys.some((key) => key !== "name" && key !== "path" && key !== "scope")) {
      issues.push(`Remove unknown fields from skills[${index}].`);
      return;
    }
    if (typeof item.name !== "string" || typeof item.path !== "string" || (item.scope !== "global" && item.scope !== "project")) {
      issues.push(`Give skills[${index}] a string name, string path and global or project scope.`);
      return;
    }
    skills.push({ name: item.name, path: item.path, scope: item.scope });
  });
  return skills;
}

function readTimestamp(value: unknown, field: string, issues: string[], fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  issues.push(`Make ${field} an ISO date-time string.`);
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}
