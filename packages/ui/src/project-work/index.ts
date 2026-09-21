/**
 * The project-work client (M21-T5): one cache per project, the sequence rules
 * that keep it honest, the links that land on an exact revision, and the view
 * state of the embedded workspace.
 *
 * Nothing here draws anything; `components/project-work/` does that.
 */
export {
  consumeWorkLink,
  formatWorkLinkHash,
  parseWorkLink,
  readWorkLink,
  sameWorkLink,
  workLinkUrl,
  type WorkLinkTarget,
} from "./deep-link.js";
export { attentionQueue, attentionReasonOf, byRecency, compareKeys, kindsPresent } from "./model.js";
export {
  bindProjectWork,
  knownProjectWork,
  observeProjectWork,
  projectWorkFor,
  projectWorkGeneration,
  projectWorkStores,
  reconnectProjectWork,
  resetProjectWork,
  resolveProjectWork,
  resolvedProjectPaths,
  subscribeProjectWork,
} from "./registry.js";
export {
  applyChange,
  describeProjectWorkError,
  firstBody,
  merge,
  ProjectWorkStore,
  type CreateWorkInput,
  type ProjectWorkFailure,
  type ProjectWorkOutcome,
  type ProjectWorkRequest,
  type ProjectWorkSnapshot,
} from "./store.js";
export { useProjectWork, useProjectWorkById, useProjectWorkSnapshot, useProjectWorkStore } from "./hooks.js";
export {
  closeWorkspace,
  honourWorkLinkFromLocation,
  landWorkLink,
  openWorkCreate,
  openWorkspace,
  resetWorkspaceUi,
  selectWork,
  setWorkspaceLinkError,
  setWorkspaceTab,
  useWorkspaceUi,
  workspaceUi,
  WORKSPACE_TABS,
  type WorkspaceSelection,
  type WorkspaceTab,
  type WorkspaceUiState,
} from "./workspace-state.js";
