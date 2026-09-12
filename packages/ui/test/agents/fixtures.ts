import type { AgentDefinition, AgentEvent, AgentRun, AgentsSnapshot, SessionState, SessionSummary } from "@lasercode/protocol";
import type { SessionView } from "../../src/store.js";

export const agent = (over: Partial<AgentDefinition> & Pick<AgentDefinition, "name">): AgentDefinition => ({
  kind: "custom",
  description: "",
  instructions: "",
  engineInstructions: false,
  model: null,
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
    agent({ name: "beam", kind: "builtin", instructions: "Read the app state before answering." }),
    agent({ name: "chat", kind: "builtin", instructions: "Answer general questions directly." }),
    agent({ name: "namer", kind: "builtin", instructions: "Name sessions and running actions clearly." }),
    agent({ name: "reviewer", description: "Reviews a diff" }),
  ],
  defaultAgent: "default",
  warnings: [],
  policy: { maxDepth: 3, foregroundCommandSeconds: 120 },
  namer: { status: "unqualified", model: null, candidates: [] },
  beam: { model: null, suggested: null, needsChoice: false },
  chat: { model: null },
  builtinInstructions: { beam: null, chat: null, namer: null },
  renamedAgents: {},
  workspaces: { beam: "/state/beam", chat: "/state/chat" },
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
  namerLabels: {},
  ...over,
});
