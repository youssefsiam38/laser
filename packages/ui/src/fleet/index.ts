/**
 * The fleet's state layer: the work model, the store selector, the sheet's
 * open state and the background-task actions. Components import from here;
 * nothing below it talks to `HostClient` or the reducer directly.
 */
export {
  FLEET_STATE_LABEL,
  branchIsActive,
  buildFleet,
  flattenFleet,
  fleetSummary,
  partitionItems,
  scopeFleet,
  type FleetGroup,
  type FleetInput,
  type FleetItem,
  type FleetItemKind,
  type FleetScope,
  type FleetState,
} from "./model.js";
export { useFleet, useFleetReconcile, type FleetView } from "./hooks.js";
export {
  clearFleetReveal,
  closeFleetSheet,
  openFleetSheet,
  resetFleetState,
  revealInFleet,
  setFleetSheetOpen,
  useFleetReveal,
  useFleetSheetOpen,
} from "./fleet-state.js";
export { useTaskOutput, TAIL_BYTES, type TaskOutput } from "./output.js";
export { createTasksActions, type TasksActions, type TasksActionsDeps } from "./actions.js";
