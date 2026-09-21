import { sessionKindOf, type AgentDefinition, type AgentEvent, type AgentRun, type AgentsSnapshot, type SessionAgentInfo, type SessionAgentKind, type SessionState, type SessionSummary } from "@lasercode/protocol";
import type { SessionView } from "../../src/store.js";

/**
 * A session's agent record as the host sends it. `sessionKind` follows the
 * stored kind unless a case states otherwise — including a legacy `"beam"`
 * record, which is a Chat conversation now (`docs/plain-chat.md`).
 */
export const agentInfo = (
  over: Partial<Omit<SessionAgentInfo, "kind">> & { kind?: SessionAgentKind | "beam" } = {},
): SessionAgentInfo => {
  const { kind = "root", sessionKind, ...rest } = over;
  return {
    kind: kind === "beam" ? "chat" : kind,
    sessionKind: sessionKind ?? sessionKindOf(kind),
    ...rest,
  };
};

export const agent = (over: Partial<AgentDefinition> & Pick<AgentDefinition, "name">): AgentDefinition => ({
  kind: "custom",
  scope: "global",
  description: "",
  instructions: "",
  engineInstructions: false,
  excludeCoreInstructions: false,
  profileId: null,
  thinkingLevel: null,
  supportsSubagents: false,
  allowedAgents: [],
  scopedSkills: false,
  skills: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

export const snapshot = (over: Partial<AgentsSnapshot> = {}): AgentsSnapshot => ({
  revision: 1,
  agents: [
    agent({ name: "default", description: "The shipped agent", engineInstructions: true, supportsSubagents: true, allowedAgents: ["default"] }),
    agent({ name: "reviewer", description: "Reviews a diff" }),
  ],
  defaultAgent: "default",
  warnings: [],
  policy: { maxDepth: 3, foregroundCommandSeconds: 120 },
  renamedAgents: {},
  workspaces: { chat: "/state/chat" },
  ...over,
});

export const run = (over: Partial<AgentRun> & Pick<AgentRun, "runId" | "sessionPath">): AgentRun => ({
  agentName: "reviewer",
  subagentName: over.runId,
  sessionId: over.sessionPath,
  projectCwd: "/p",
  rootSessionPath: "/p/root.jsonl",
  depth: 1,
  parent: { sessionPath: "/p/root.jsonl", sessionId: "root" },
  worktree: null,
  origin: "agent",
  status: "running",
  task: "Review the diff",
  startedAt: "2026-09-08T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:00.000Z",
  ...over,
});

export const event = (over: Partial<AgentEvent> & Pick<AgentEvent, "id">): AgentEvent => ({
  at: "2026-09-08T10:00:00.000Z",
  kind: "message_sent",
  sessionPath: "/p/a.jsonl",
  summary: "Sent a message",
  ...over,
});

export const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "path">): SessionSummary => ({
  id: over.path,
  cwd: "/p",
  createdAt: "2026-09-08T09:00:00.000Z",
  modifiedAt: "2026-09-08T09:00:00.000Z",
  messageCount: 1,
  ...over,
});

export const sessionState = (over: Partial<SessionState> & Pick<SessionState, "path">): SessionState => ({
  id: over.path,
  cwd: "/p",
  model: null,
  profile: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
  ...over,
});

export const view = (over: Partial<SessionView> & Pick<SessionView, "path">): SessionView => ({
  state: sessionState({ path: over.path }),
  blocks: [],
  lastSeq: 0,
  running: false,
  queue: { steering: [], followUp: [] }, pending: [],
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-08T09:00:00.000Z",
  hydrated: true,
  entries: [],
  capabilities: [],
  goal: null,
  ...over,
});
