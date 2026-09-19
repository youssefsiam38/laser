/**
 * The fleet's state layer: the work model, the store selector, the sheet's
 * open state and the background-task actions. Components import from here;
 * nothing below it talks to `HostClient` or the reducer directly.
 */
export {
  FLEET_STATE_LABEL,
  buildFleet,
  flattenFleet,
  fleetSummary,
  projectFleetSections,
  scopeFleet,
  type FleetGroup,
  type FleetInput,
  type FleetItem,
  type FleetItemKind,
  type FleetProjectedGroup,
  type FleetProjectedItem,
  type FleetScope,
  type FleetSectionProjection,
  type FleetSections,
  type FleetState,
} from "./model.js";
export {
  DEFAULT_FLEET_FILTER,
  filterFleetSections,
  filterRevealing,
  fleetFilterCounts,
  fleetFilterIsRestricting,
  itemMatchesFilter,
  sameFleetFilter,
  type FleetFilter,
  type FleetFilterCounts,
  type FleetKindFilter,
  type FleetLifecycleFilter,
} from "./filter.js";
export {
  agentHeadline,
  agentInitials,
  agentStrip,
  agentTintIndex,
  headlineText,
  stripText,
  taskHeadline,
  taskStrip,
  worktreeLabel,
  FLEET_AGENT_TINT_COUNT,
  type FleetAgentStrip,
  type FleetHeadline,
  type FleetStrip,
  type FleetTaskStrip,
  type FleetWorktreeChip,
} from "./row.js";
export {
  BRANCH_BUDGET,
  PATH_BUDGET,
  firstSentence,
  isPathShaped,
  middleTruncate,
  shortModelName,
  suffixTruncate,
} from "./truncate.js";
export { useFleet, useFleetReconcile, type FleetView } from "./hooks.js";
export {
  clearFleetReveal,
  closeFleetSheet,
  openFleetSheet,
  resetFleetState,
  revealInFleet,
  setFleetFilter,
  setFleetSheetOpen,
  useFleetFilter,
  useFleetReveal,
  useFleetSheetOpen,
} from "./fleet-state.js";
export { useTaskOutput, TAIL_BYTES, type TaskOutput } from "./output.js";
export { createTasksActions, type TasksActions, type TasksActionsDeps } from "./actions.js";
