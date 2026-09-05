/**
 * Subagent tabs (M3): the run tree under the top bar and the fleet sheet
 * behind it. Everything here reads the panel store — there is no second data
 * path for agent work, and no component here talks to the host directly.
 */
export { RunTabs } from "./RunTabs.js";
export { FleetSheet } from "./FleetSheet.js";
export { closeFleet, openFleet, setFleetOpen, useFleetFocus, useFleetOpen } from "./fleet.js";
export {
  MAX_TABS,
  buildRunTree,
  byAttention,
  flatten,
  overflowAttention,
  pathTo,
  reconcileFocus,
  tabsFor,
  type RunNode,
  type RunTree,
  type TabRow,
} from "./run-tree.js";
