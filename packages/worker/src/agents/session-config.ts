/**
 * Per-agent session configuration: what a definition means to the engine.
 *
 * Pure helpers the driver applies when it opens a session (which built-in
 * tools to expose, which skills to keep) and the file reader the server uses
 * on `session/load` to recover which agent a stored session runs as. The
 * reader parses JSON only; it never opens an engine.
 */
import { existsSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { SESSION_AGENT_ENTRY_TYPE, type AgentDefinition, type SessionAgentKind, type SessionAgentRecord } from "@lasercode/protocol";
import type { HarnessSessionRole } from "./bridge.js";

/**
 * Every engine tool, in the engine's order. Every agent gets all of them
 * (D-144): the engine's default four are on already, and the rest are
 * switched on after the session opens. Web search is an extension tool and
 * follows its feature, for every agent at once.
 */
export const ENGINE_BUILTIN_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

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

/**
 * The working directory a stored session names in its header line, or
 * undefined when the file cannot be read or has no header.
 */
export async function readSessionHeaderCwd(path: string): Promise<string | undefined> {
  let first: string;
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(8 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  try {
    const header = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A Beam or Chat session's working directory is the app's own workspace, so
 * a missing one is recreated rather than refused: the engine will not open a
 * session whose stored directory is gone, and a person who moved their state
 * directory or ran an older layout would otherwise lose every Beam chat.
 * Never applied to a project session — a project that vanished is the
 * person's to restore.
 */
export async function ensureWorkspaceSessionCwd(kind: SessionAgentKind, cwd: string, sessionPath?: string): Promise<void> {
  if (kind !== "beam" && kind !== "chat") return;
  const label = kind === "beam" ? "Beam" : "Chat";
  const wanted = new Set([cwd]);
  // A stored session may name an older workspace directory; the engine checks
  // that one, so both are ensured.
  if (sessionPath) {
    const stored = await readSessionHeaderCwd(sessionPath);
    if (stored) wanted.add(stored);
  }
  for (const dir of wanted) {
    if (existsSync(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const why = code === "EACCES" || code === "EPERM" ? "permission denied" : code === "ENOTDIR" ? "a parent of that path is a file" : code === "EROFS" ? "the file system is read-only" : error instanceof Error ? error.message : String(error);
      throw new Error(`${label}'s workspace folder ${dir} is missing and could not be recreated (${why}). Start a new ${label} chat; this one cannot be opened.`);
    }
  }
}
