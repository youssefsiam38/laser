/**
 * The pi-subagents layer: everything the host knows about agent work that is
 * not the conversation itself (M3). Parses files, emits panels, writes the
 * control inbox. Imports nothing from Pi or pi-subagents.
 */
export * from "./file-layer.js";
export * from "./status.js";
export * from "./panels.js";
export * from "./control.js";
export * from "./missions.js";
export {
  SubagentsLayer,
  FOREGROUND_STALE_MS,
  MAX_RUNS_PER_SESSION,
  RECENT_MS,
  type PanelSink,
  type SessionRef,
  type SubagentsLayerOptions,
} from "./layer.js";
