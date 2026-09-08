/**
 * Per-agent session configuration: what a definition means to the engine.
 *
 * Pure helpers the driver applies when it opens a session (which built-in
 * tools to expose, which skills to keep) and the file reader the server uses
 * on `session/load` to recover which agent a stored session runs as. The
 * reader parses JSON only; it never opens an engine.
 */
import { open } from "node:fs/promises";
import { SESSION_AGENT_ENTRY_TYPE, type AgentDefinition, type SessionAgentKind, type SessionAgentRecord } from "@lasercode/protocol";
import type { HarnessSessionRole } from "./bridge.js";

/** The engine's own tools an agent definition may switch on. `web_search` is an extension tool. */
export const ENGINE_BUILTIN_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** The built-in tool names to hand the engine for this definition, in the engine's order. */
export function engineToolsFor(definition: Pick<AgentDefinition, "tools">): string[] {
  const wanted = new Set(definition.tools);
  return ENGINE_BUILTIN_TOOLS.filter((name) => wanted.has(name));
}

/** The built-in tools a definition leaves out: denied to the session outright. */
export function excludedEngineTools(definition: Pick<AgentDefinition, "tools">): string[] {
  const wanted = new Set(definition.tools);
  return ENGINE_BUILTIN_TOOLS.filter((name) => !wanted.has(name));
}

/** True when this definition asks for web search (the feature must also be on). */
export function wantsWebSearch(definition: Pick<AgentDefinition, "tools">): boolean {
  return definition.tools.includes("web_search");
}

export interface SkillLike {
  name: string;
}

/**
 * Which discovered skills this session is offered: the Beam skill only to the
 * Beam agent, and only the definition's own list when it is scoped.
 */
export function filterSkills<T extends SkillLike>(
  skills: T[],
  options: { definition: Pick<AgentDefinition, "scopedSkills" | "skills">; role: Pick<HarnessSessionRole, "kind">; beamSkillName?: string },
): T[] {
  const scoped = options.definition.scopedSkills ? new Set(options.definition.skills.map((skill) => skill.name)) : undefined;
  return skills.filter((skill) => {
    if (options.beamSkillName !== undefined && skill.name === options.beamSkillName && options.role.kind !== "beam") return false;
    if (scoped && !scoped.has(skill.name)) return false;
    return true;
  });
}

/** The role a top-level session gets from its agent name. */
export function rootRole(agentName: string): HarnessSessionRole {
  const kind: SessionAgentKind = agentName === "beam" ? "beam" : agentName === "chat" ? "chat" : "root";
  return { agentName, kind, depth: 0 };
}

/** The record a top-level session carries. */
export function rootRecord(agentName: string): SessionAgentRecord {
  return { agentName, kind: rootRole(agentName).kind };
}

/** How much of a session file is read to find its agent record (it is the first custom entry). */
export const RECORD_SCAN_BYTES = 64 * 1024;

const KINDS: readonly SessionAgentKind[] = ["root", "child", "beam", "chat"];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Validate a parsed `SESSION_AGENT_ENTRY_TYPE` payload; unknown shapes are ignored, never guessed. */
export function parseSessionAgentRecord(data: unknown): SessionAgentRecord | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  const agentName = str(raw["agentName"]);
  const kind = raw["kind"];
  if (!agentName || typeof kind !== "string" || !KINDS.includes(kind as SessionAgentKind)) return undefined;
  const record: SessionAgentRecord = { agentName, kind: kind as SessionAgentKind };
  const subagentName = str(raw["subagentName"]);
  const parentPath = str(raw["parentPath"]);
  const parentSessionId = str(raw["parentSessionId"]);
  const rootPath = str(raw["rootPath"]);
  const runId = str(raw["runId"]);
  if (subagentName) record.subagentName = subagentName;
  if (parentPath) record.parentPath = parentPath;
  if (parentSessionId) record.parentSessionId = parentSessionId;
  if (rootPath) record.rootPath = rootPath;
  if (runId) record.runId = runId;
  const worktree = raw["worktree"];
  if (worktree && typeof worktree === "object") {
    const w = worktree as Record<string, unknown>;
    const path = str(w["path"]);
    const branch = str(w["branch"]);
    const baseCommit = str(w["baseCommit"]);
    if (path && branch && baseCommit) record.worktree = { path, branch, baseCommit };
  }
  return record;
}

/**
 * The agent record stored in a session file, found in its first
 * `RECORD_SCAN_BYTES`. Undefined for a session written before agents existed
 * (the caller falls back to the default agent) or a file that cannot be read.
 */
export async function readSessionAgentRecord(path: string): Promise<SessionAgentRecord | undefined> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(RECORD_SCAN_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, RECORD_SCAN_BYTES, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  const marker = `"customType":"${SESSION_AGENT_ENTRY_TYPE}"`;
  for (const line of text.split("\n")) {
    if (!line.includes(marker) && !line.includes(SESSION_AGENT_ENTRY_TYPE)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated last line inside the scan window
    }
    const e = entry as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (e?.type !== "custom" || e.customType !== SESSION_AGENT_ENTRY_TYPE) continue;
    const record = parseSessionAgentRecord(e.data);
    if (record) return record;
  }
  return undefined;
}
