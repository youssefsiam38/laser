/**
 * The panel system (docs/ux-panels.md). Components import from here.
 *
 *   PanelsProvider          mount inside <PiorbitProvider>
 *   PanelAmbient            the panel half of the status line above the composer (its trailing slot)
 *   PanelInlineCards        the inline surface: cards in the transcript
 *   PanelInspectSheet       `inspect`: a sheet that opens on arrival
 *   PanelDecisionCards      turn-blocking decisions, above the composer
 *   PanelToolDecision       a decision that blocks one tool, inside its row
 *   PanelDecisionSheet      a decision that blocks everything
 *   MobileIslands           the phone's pills-and-sheet islands
 *   PoppedOutPanel          the page for `#/panel/<path>/<id>`
 *   Dock                    lives in components/dock
 */
export {
  PanelsProvider,
  POPOUT_CHANNEL,
  POPOUT_HASH_PREFIX,
  mediaTypeOfRef,
  parsePopoutHash,
  popoutHash,
  useDock,
  useIslandEntries,
  usePanelActions,
  usePanelEntries,
  usePanelsState,
  type PanelActions,
  type PanelsRoot,
} from "./PanelsProvider.js";
export { PanelAmbient, type PanelAmbientProps } from "./Ambient.js";
export { PanelDecisionCards, PanelDecisionSheet, PanelToolDecision } from "./DecisionSurfaces.js";
export { PanelInlineCards, PanelInspectSheet } from "./InlinePanels.js";
export { useRegisterToolRow, useToolRowIds, resetToolRows } from "./tool-rows.js";
// The one decision renderer: the tool row mounts it too, so a question asked
// inside a tool call and one asked above the composer are the same component.
export { DecisionBody, type DecisionBodyProps } from "./islands/bodies/DecisionBody.js";
export { decisionSummary, isModeChangingOption } from "./decision.js";
export { MobileIslands } from "./MobileIslands.js";
export { PoppedOutPanel } from "./PoppedOut.js";
export { Island, PanelBody, type IslandProps } from "./islands/Island.js";
export * from "./store.js";
export * from "./placement.js";
export * from "./dock-state.js";
export * from "./layout.js";
export * from "./fallback.js";
export * from "./values.js";
export { parseAnsi, stripAnsi, type AnsiSpan, type AnsiStyle } from "./ansi.js";

// The host's own log sections as `stream` panels (M4-T6 × the panel contract).
export {
  LOG_PANEL_ID_PREFIX,
  LOG_REF_PREFIX,
  MAX_LINES as LOG_MAX_LINES,
  isLogPanelId,
  logContent,
  logLine,
  logPanelId,
  logRef,
  logStreamPanel,
  recordLogRows,
  resetLogBuffer,
  sectionOfLogRef,
  subscribeLogs,
  watchedLogSections,
} from "./logs.js";
