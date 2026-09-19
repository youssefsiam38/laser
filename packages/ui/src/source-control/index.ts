/**
 * The full-screen changes overlay. `App` mounts `ChangesOverlayHost` once;
 * call `openChanges` from a file row. Telemetry Files and the fleet Changes
 * control are owned elsewhere — see docs/leap/l5-report.md.
 */
export { openChanges, closeChanges, useChangesUi, resetChangesUi } from "./store.js";
export { ChangesOverlayHost } from "./overlay.js";
export { setChangesAdapter, getChangesAdapter, resetChangesAdapter, type ChangesDataAdapter } from "./data.js";
export type {
  OpenChangesArgs,
  ChangesScope,
  ChangesList,
  ChangedFile,
  ChangedRepo,
  FileDiffPage,
  AgentChangesContext,
} from "./contract.js";
