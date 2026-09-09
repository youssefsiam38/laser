/**
 * Public surface of the agents state layer. Screens import from here; nothing
 * below it talks to `HostClient` or the reducer directly.
 */
export {
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  agentByName,
  agentDefinitionInputOf,
  agentDisplayName,
  agentIssueRoot,
  agentIssuesByField,
  agentKindOf,
  compareRunsNewestFirst,
  compareRunsOldestFirst,
  defaultAgentDefinitionInput,
  isActiveRun,
  isBuiltinAgent,
  isWorkspaceCwd,
  latestRunForSession,
  runList,
  runStatusLabel,
  runStatusTone,
  runsForRoot,
  runsForSession,
  sessionAgentName,
  warningsFor,
  type AgentIssuesByField,
  type AgentStatusTone,
  type RunSource,
} from "./model.js";

export {
  ancestryOf,
  buildAgentTree,
  createAncestryIndex,
  rootOf,
  sameAgentTree,
  sameAgentTreeNode,
  subtreePaths,
  type AncestryIndex,
  type AgentTree,
  type AgentTreeEdge,
  type AgentTreeInput,
  type AgentTreeNode,
  type AgentTreeStatus,
} from "./run-tree.js";

export { createAgentsActions, type AgentsActions, type AgentsActionsDeps } from "./actions.js";

export {
  clearRemoveWorktreeRequest,
  describeWorktreeContents,
  forgetWorktreeDisposition,
  requestRemoveWorktree,
  setWorktreeDisposition,
  takeWorktreeDisposition,
  useRemoveWorktreeRequest,
  useWorktreeStatus,
  type RemoveWorktreeRequest,
  type WorktreeStatusState,
} from "./worktree.js";

export {
  useAgentEvents,
  useAgentRuns,
  useAgentTree,
  useAgentWarnings,
  useAgentsActions,
  useAgentsSnapshot,
  useAgentsStatus,
  useBeamChoice,
  useLatestRun,
  useNamerLabel,
  useRunsForRoot,
  useSessionAgent,
  type AgentsStatus,
} from "./hooks.js";
