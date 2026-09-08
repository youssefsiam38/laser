/**
 * The live agent map (docs/agents.md §5, M13-T7): a React Flow view of one
 * top-level session's agent tree, in three hosts — the main column, a
 * fullscreen overlay and a dock island — with a composition chosen by the
 * measured size of whichever box holds it.
 */
export { AgentMap, type AgentMapProps } from "./AgentMap.js";
export { AgentMapConnected, AgentMapView, useMapRoot, type AgentMapConnectedProps } from "./AgentMapView.js";
export { AgentMapFullscreen } from "./AgentMapFullscreen.js";
export { MapDockIsland, MAP_ISLAND_MIN_HEIGHT, useMapDockRoot } from "./MapDockIsland.js";
export { MapHostProvider, useMapHost, type MapHost } from "./map-context.js";
export { mapUi, useMapDocked, useMapRootState, useMapUi, type MapRootState, type MapUiState } from "./map-state.js";
export {
  CONSTRAINED_HEIGHT,
  CONSTRAINED_WIDTH,
  FULL_WIDTH,
  NODE_BOX,
  ZOOM_COMPACT,
  compositionFor,
  directionFor,
  layoutTree,
  structureKey,
  visibleTreeOf,
  type MapComposition,
  type MapDirection,
  type MapLayout,
  type MapSize,
  type VisibleTree,
} from "./layout.js";
export { EVENT_TTL_MS } from "./EventBubbles.js";
