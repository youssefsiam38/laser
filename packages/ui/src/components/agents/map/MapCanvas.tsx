"use client";
import { useDirection } from "@/hooks/use-direction";
/**
 * The React Flow canvas (docs/agents.md §5). Read-only on purpose: nothing
 * drags, connects or deletes; panning, zooming and selecting are the whole
 * interaction, and selection only highlights and reveals a node's details.
 *
 * Node objects carry ids, positions and the selection flag; everything a node
 * draws comes through `MapData`, so a status update re-renders the node that
 * changed and moves nothing. Positions come from `layoutTree`, memoised on the
 * structure key, and the camera re-fits on a structure change only until the
 * person has moved it themselves — "Fit" hands it back.
 */
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange,
  type OnMoveEnd,
} from "@xyflow/react";
import { Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { AgentStatusTone } from "@/agents";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";

import { emptyCaption } from "./map-caption.js";
import { AgentEdge, type AgentFlowEdge } from "./AgentEdge.js";
import { AgentNode, type AgentFlowNode } from "./AgentNode.js";
import { directionFor, layoutTree, MINIMAP_FROM, NODE_BOX, structureKey, type MapComposition, type MapDirection, type MapSize, type VisibleTree } from "./layout.js";
import { useMapHost } from "./map-context.js";
import { mapUi, useMapRootState } from "./map-state.js";
import { nodeAriaLabel, nodeName, TONE_VAR } from "./node-model.js";

// Module scope, as the React Flow skill insists: a new object per render would
// remount every node.
const nodeTypes = { agent: AgentNode };
const edgeTypes = { agent: AgentEdge };
// A straight interpolation: a fit after a spawn should settle, not fly out and back in.
const FIT = { padding: 0.18, maxZoom: 1, interpolate: "linear" } as const;
const LEGEND: ReadonlyArray<{ tone: AgentStatusTone; word: string }> = [
  { tone: "live", word: "Working" },
  // The one attention state left after D-189: a live run paused on a question.
  // A terminal `blocked` run is neutral finished work and reads muted below.
  { tone: "attention", word: "Asking" },
  { tone: "danger", word: "Failed" },
  // One muted row, because finished and ended now share a colour (D-154).
  // Each node still says which it was in its own word.
  { tone: "muted", word: "Done or ended" },
];

export interface MapCanvasProps {
  rootPath: string;
  visible: VisibleTree;
  composition: Exclude<MapComposition, "constrained">;
  size: MapSize;
  /** Touch-sized controls and no minimap: the phone's fullscreen graph. */
  touch?: boolean;
  className?: string | undefined;
}

export function MapCanvas(props: MapCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ rootPath, visible, composition, size, touch = false, className }: MapCanvasProps) {
  const rtl = useDirection() === "rtl";
  const { selected } = useMapRootState(rootPath);
  const host = useMapHost();
  const flow = useReactFlow<AgentFlowNode, AgentFlowEdge>();
  const box = NODE_BOX[composition];
  const key = structureKey(visible);
  // The direction remembers itself so a small resize does not flip the map.
  const heldDirection = useRef<MapDirection | undefined>(undefined);
  const direction = useMemo(() => {
    const next = directionFor(visible, box, size, composition, heldDirection.current);
    heldDirection.current = next;
    return next;
  }, [key, box, size.width, size.height, composition]);
  const layout = useMemo(() => layoutTree(visible, box, direction), [key, box, direction]);

  // Spawn: a node that was not on the map last time arrives from its parent.
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlyMap<string, { dx: number; dy: number }>>(() => new Map());
  useEffect(() => {
    const ids = new Set(visible.nodes.map((n) => n.id));
    if (known.current === null) {
      known.current = ids;
      return;
    }
    const arrived = new Map<string, { dx: number; dy: number }>();
    for (const node of visible.nodes) {
      if (known.current.has(node.id) || !node.parentPath) continue;
      const own = layout.positions.get(node.id);
      const parent = layout.positions.get(node.parentPath);
      if (own && parent) arrived.set(node.id, { dx: parent.x - own.x, dy: parent.y - own.y });
    }
    known.current = ids;
    if (arrived.size === 0) return;
    setFresh(arrived);
    const timer = setTimeout(() => setFresh(new Map()), motionMs("--motion-morph") + motionMs("--motion-slow"));
    return () => clearTimeout(timer);
  }, [key]);

  const now = Date.now();
  const nodes = useMemo<AgentFlowNode[]>(
    () =>
      visible.nodes.map((node) => ({
        id: node.id,
        type: "agent",
        position: layout.positions.get(node.id) ?? { x: 0, y: 0 },
        data: { path: node.id, fresh: fresh.get(node.id) },
        width: box.width,
        height: box.height,
        selected: node.id === selected,
        ariaLabel: nodeAriaLabel(node, now),
        sourcePosition: direction === "TB" ? Position.Bottom : Position.Right,
        targetPosition: direction === "TB" ? Position.Top : Position.Left,
        draggable: false,
        connectable: false,
        deletable: false,
      })),
    // `now` is read for the accessible name; it moves with the tree, not a clock.
    [visible, layout, box, selected, fresh, direction],
  );
  const edges = useMemo<AgentFlowEdge[]>(
    () =>
      visible.edges.map((edge) => {
        const from = visible.byPath.get(edge.from);
        const to = visible.byPath.get(edge.to);
        return {
          id: `${edge.from}>${edge.to}`,
          source: edge.from,
          target: edge.to,
          type: "agent",
          focusable: false,
          selectable: false,
          deletable: false,
          ariaLabel: `${from ? nodeName(from) : "Its parent"} started ${to ? nodeName(to) : "an agent"}`,
        };
      }),
    [visible],
  );

  // Selection is the one change React Flow may make to the nodes.
  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      for (const change of changes) {
        if (change.type !== "select") continue;
        if (change.selected) mapUi.select(rootPath, change.id);
        else if (mapUi.get().roots[rootPath]?.selected === change.id) mapUi.select(rootPath, undefined);
      }
    },
    [rootPath],
  );
  const onPaneClick = useCallback(() => mapUi.select(rootPath, undefined), [rootPath]);
  // A move with an event behind it is the person's; a fit passes none.
  const onMoveEnd = useCallback<OnMoveEnd>((event, next) => mapUi.setViewport(rootPath, next, event !== null && event !== undefined), [rootPath]);

  const fit = useCallback(
    (animated: boolean) => {
      void flow.fitView({ ...FIT, duration: animated ? motionMs("--motion-slow") : 0 });
    },
    [flow],
  );
  const refit = useCallback(() => {
    mapUi.resetViewport(rootPath);
    fit(true);
  }, [fit, rootPath]);

  // First paint: the person's camera if they had one, else a fit. Afterwards
  // a structure or room change re-fits until they have panned themselves.
  const mounted = useRef(false);
  const onInit = useCallback(() => {
    const held = mapUi.get().roots[rootPath];
    if (held?.userPanned && held.viewport) void flow.setViewport(held.viewport);
    else fit(false);
    mounted.current = true;
  }, [fit, flow, rootPath]);
  useEffect(() => {
    if (!mounted.current || mapUi.get().roots[rootPath]?.userPanned) return;
    const frame = requestAnimationFrame(() => fit(true));
    return () => cancelAnimationFrame(frame);
    // Re-fit on structure and room, never on a camera move of its own.
  }, [key, composition, size.width, size.height, fit, rootPath]);

  // React Flow unselects a focused node on Escape. In the fullscreen host
  // Escape means "back to the session", and the selection comes along (it is
  // the thing the person was looking at), so the key is taken before the node
  // sees it.
  const onKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || host.frame !== "fullscreen") return;
      event.preventDefault();
      event.stopPropagation();
      host.closeFullscreen();
    },
    [host],
  );

  const empty = visible.nodes.length === 1;
  const minimap = composition === "full" && !touch && visible.nodes.length >= MINIMAP_FROM;
  const minimapColor = useCallback((node: AgentFlowNode) => TONE_VAR[visible.byPath.get(node.id)?.tone ?? "muted"], [visible]);

  return (
    <div className="h-full w-full" onKeyDownCapture={onKeyDownCapture}>
    <ReactFlow<AgentFlowNode, AgentFlowEdge>
      className={cn("agent-map-flow", className)}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onInit={onInit}
      onNodesChange={onNodesChange}
      onPaneClick={onPaneClick}
      onMoveEnd={onMoveEnd}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      elementsSelectable
      selectNodesOnDrag={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      panActivationKeyCode={null}
      zoomOnDoubleClick={false}
      minZoom={0.25}
      maxZoom={1.5}
      proOptions={{ hideAttribution: false }}
      attributionPosition="bottom-left"
      ariaLabelConfig={{
        "node.a11yDescription.default": "Press Enter or Space to inspect this agent. Escape leaves the map.",
        "node.a11yDescription.keyboardDisabled": "",
        "node.a11yDescription.ariaLiveMessage": ({ direction: d, x, y }) => `Moved ${d} to ${Math.round(x)}, ${Math.round(y)}.`,
        "edge.a11yDescription.default": "An agent started by its parent.",
        "controls.ariaLabel": "Map controls",
        "controls.zoomIn.ariaLabel": "Zoom in",
        "controls.zoomOut.ariaLabel": "Zoom out",
        "controls.fitView.ariaLabel": "Fit the map",
        "controls.interactive.ariaLabel": "Toggle interactivity",
        "minimap.ariaLabel": "Map overview",
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.25} />
      <Panel position={rtl ? "top-right" : "top-left"}>
        <Legend />
      </Panel>
      {minimap && <MiniMap position={rtl ? "top-left" : "top-right"} pannable zoomable={false} nodeColor={minimapColor} nodeBorderRadius={6} />}
      {empty && (
        <Panel position="bottom-center" className="pointer-events-none">
          <p data-slot="agent-map-empty" className="max-w-72 text-center text-sm leading-sm text-ink-3">
            {emptyCaption(visible.hidden)}
          </p>
        </Panel>
      )}
      <Panel position={rtl ? "bottom-left" : "bottom-right"}>
        <MapControls touch={touch} onFit={refit} />
      </Panel>
    </ReactFlow>
    </div>
  );
}

function Legend() {
  return (
    <ul data-slot="agent-map-legend" aria-label="Status legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-bg/80 px-1.5 py-1">
      {LEGEND.map(({ tone, word }) => (
        <li key={tone} className="inline-flex items-center gap-1.5 text-xs leading-xs text-ink-3">
          <span aria-hidden="true" className="size-2 rounded-full" style={{ background: TONE_VAR[tone] }} />
          {word}
        </li>
      ))}
    </ul>
  );
}

/**
 * Fit, zoom in, zoom out. Ours rather than React Flow's `Controls`, so the
 * buttons are the app's buttons: tokens, tooltips, 44px targets under a
 * finger, and a Fit that also hands the camera back to the layout.
 */
function MapControls({ touch, onFit }: { touch: boolean; onFit(): void }) {
  const flow = useReactFlow();
  const step = motionMs("--motion-fast");
  const size = touch ? "icon-lg" : "icon-sm";
  return (
    <div data-slot="agent-map-controls" role="group" aria-label="Map controls" className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-float-sm">
      <TooltipIconButton tooltip="Zoom in" side="left" size={size} onClick={() => void flow.zoomIn({ duration: step, interpolate: "linear" })} className={cn(touch && "size-11")}>
        <ZoomIn />
      </TooltipIconButton>
      <TooltipIconButton tooltip="Zoom out" side="left" size={size} onClick={() => void flow.zoomOut({ duration: step, interpolate: "linear" })} className={cn(touch && "size-11")}>
        <ZoomOut />
      </TooltipIconButton>
      <TooltipIconButton tooltip="Fit the map" side="left" size={size} onClick={onFit} className={cn(touch && "size-11")} data-slot="agent-map-fit">
        <Scan />
      </TooltipIconButton>
    </div>
  );
}
