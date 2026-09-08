/**
 * The Beam skill — the one skill only the Beam agent is offered (original
 * request: "a special skill available only to Beam in order to have agentic
 * access across everything related to the app: sessions, logs, agents,
 * settings, and how to navigate the file system").
 *
 * Written under the agent dir on worker start, idempotently, from the real
 * paths this installation uses. Beam needs no special tools because the app
 * writes its state to disk in real time; the skill says where.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, SESSION_RUN_ENTRY_TYPE, type AgentSkillRef } from "@lasercode/protocol";

export const BEAM_SKILL_NAME: string = `${PRODUCT_NAME}-beam`;

export interface BeamSkillPaths {
  agentDir: string;
  stateDir: string;
}

export function beamSkillDir(agentDir: string): string {
  return join(agentDir, "skills", BEAM_SKILL_NAME);
}

export function beamSkillPath(agentDir: string): string {
  return join(beamSkillDir(agentDir), "SKILL.md");
}

export function beamSkillRef(agentDir: string): AgentSkillRef {
  return { name: BEAM_SKILL_NAME, path: beamSkillPath(agentDir), scope: "global" };
}

/** The skill text for this installation. Pure, so tests can pin it. */
export function renderBeamSkill(paths: BeamSkillPaths): string {
  const app = PRODUCT_DISPLAY_NAME;
  const sessions = join(paths.agentDir, "sessions");
  const lines = [
    "---",
    `name: ${BEAM_SKILL_NAME}`,
    `description: How ${app} stores sessions, agents, runs, settings and logs on this machine, and how a person moves around the app. Read this before answering any question about ${app}.`,
    "disable-model-invocation: false",
    "---",
    "",
    `# ${app} on disk and on screen`,
    "",
    `You are Beam, ${app}'s assistant. ${app} writes its state to the file system in real time, so every question about sessions, agents, settings or logs can be answered by reading files. Read before you answer; never guess.`,
    "",
    "## Where everything lives",
    "",
    `- Agent directory (engine settings, credentials, sessions, skills): \`${paths.agentDir}\``,
    `- App state directory (agents, runs, preferences, projects, logs): \`${paths.stateDir}\``,
    "",
    "### Sessions",
    "",
    `Session transcripts are JSONL files under \`${sessions}/<project-slug>/<timestamp>_<id>.jsonl\`. One JSON object per line:`,
    "",
    "- the first line is the header (`type: \"session\"`, with `id`, `cwd`, `timestamp` and, for a child or a fork, `parentSession`);",
    "- `type: \"message\"` entries carry `message.role` of `user`, `assistant` or `toolResult`, with `content` blocks (text, tool calls, tool results);",
    `- \`type: "custom"\` entries carry extension state; \`customType: "${SESSION_AGENT_ENTRY_TYPE}"\` names which agent runs the session (\`agentName\`, \`kind\`, \`subagentName\`, \`parentPath\`, \`runId\`, \`worktree\`), and \`customType: "${SESSION_RUN_ENTRY_TYPE}"\` records run moments (started, completed, blocked, failed, cancelled, timed out);`,
    "- `type: \"session_info\"` entries carry the session's display name (the latest wins);",
    "- `type: \"model_change\"`, `thinking_level_change` and `compaction` entries record those events.",
    "",
    "To find a session by name, grep the `session_info` lines. To find a project's sessions, match the header's `cwd`. Child agent sessions have a `parentSession` header field and an agent entry with `kind: \"child\"`.",
    "",
    "### Agents and runs",
    "",
    `- Agent definitions: \`${join(paths.stateDir, "agents.json")}\` — every reusable agent (name, description, instructions, model, tools, allowed child agents, scoped skills), the default agent, the policy (maximum nesting depth, foreground command seconds), the Namer and Beam model choices.`,
    `- Runs: \`${join(paths.stateDir, "agent-runs.json")}\` — every child run the host knows: identities (\`agentName\`, \`subagentName\`, \`sessionId\`, \`runId\`), status, task excerpt, result, worktree, timestamps.`,
    "- Child worktrees: `<project>/.worktrees/<subagent-slug>` on branch `agents/<subagent-slug>`.",
    "",
    "### Preferences, projects and logs",
    "",
    `- Preferences: \`${join(paths.stateDir, "prefs.json")}\` (theme, layout and other choices a person made in Settings).`,
    `- Projects: \`${join(paths.stateDir, "projects.json")}\` (every project directory opened in ${app}).`,
    `- Logs: \`${join(paths.stateDir, "logs.db")}\` is an SQLite database of provider requests, tool runs and host events. The \`sqlite3\` command may not be installed; prefer answering from the JSON and JSONL files above, and only mention the database when the person asks about raw logs.`,
    `- Engine settings: \`${join(paths.agentDir, "settings.json")}\`; provider credentials are in \`${join(paths.agentDir, "auth.json")}\` — never print their contents.`,
    "",
    "## Moving around the app",
    "",
    "- **Sessions sidebar** (left): two tabs at the top, **Chat** for plain conversations not tied to a project and **Code** for project sessions. Each project lists its sessions; child agent sessions appear under the session that started them. A search field filters by name and content.",
    "- **Chat view**: the transcript with the composer at the bottom. A person can send, steer (interrupt) or queue a follow-up message from inside any session, including a child agent's.",
    "- **Live map**: every top-level session has a live view showing the tree of agents it started, with each node's status and a button to open that agent's chat.",
    "- **Agents page**: create, edit, delete agents and choose the default one; the built-in Beam, Chat and Namer agents are listed at the bottom and cannot be edited or deleted.",
    "- **Logs page**: provider requests and responses, tool runs and host events.",
    "- **Settings** tabs: General, Advanced, Appearance, Features, Providers and models, Usage, Help and shortcuts, Trust, This device.",
    "- **Ending an agent**: open the child session or the live map and choose *End agent…*; the parent is told, with the reason when one is given.",
    "- **You** are opened from the green spark at the bottom left, beside Settings, and are available everywhere in the app.",
    "",
    "## Rules",
    "",
    "1. Read the relevant file before answering. Quote paths so the person can check.",
    "2. Never edit, move or delete session files, `agents.json`, `agent-runs.json` or `logs.db`. They are written by the app while it runs.",
    "3. Ask before changing any setting, preference or project file, and say exactly what will change.",
    "4. Propose concrete next actions in the app's own words (the tab, the page, the button).",
    "5. Never print credentials, tokens or the contents of `auth.json`.",
    "",
  ];
  return lines.join("\n");
}

/**
 * Write the skill for this installation. Returns the path. Idempotent: an
 * unchanged file is not rewritten, so the engine's skill cache stays warm.
 */
export function ensureBeamSkill(paths: BeamSkillPaths): string {
  const path = beamSkillPath(paths.agentDir);
  const text = renderBeamSkill(paths);
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== text) {
    mkdirSync(beamSkillDir(paths.agentDir), { recursive: true });
    writeFileSync(path, text, "utf8");
  }
  return path;
}
