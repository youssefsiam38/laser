"use client";
/**
 * The live map of one top-level session (docs/agents.md §5, M13-T7).
 *
 * Measures its own body — width and height, with a ResizeObserver — and picks
 * the composition for that box (`compositionFor`): a lineage list when the box
 * is too small for a canvas, a concise canvas in the main column, a spacious
 * canvas with an inspector column when there is room. The same tree in a dock
 * island, the main column and fullscreen is three different surfaces, each
 * drawn on purpose, none a shrunken copy of another.
 */
import "@xyflow/react/dist/base.css";
import "./agent-map.css";

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import type { AgentTree } from "@/agents";
import { useIsTouch } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

import { InspectorCard, InspectorColumn, InspectorSheet } from "./Inspector.js";
import { compositionFor, CONSTRAINED_WIDTH, INSPECTOR_ROW_SHARE, INSPECTOR_WIDTH, visibleTreeOf, type MapComposition, type MapSize } from "./layout.js";
import { LineageList } from "./LineageList.js";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state.js";

const MapCanvas = lazy(() => import("./MapCanvas.js").then(module => ({ default: module.MapCanvas })));
import { MapDataProvider, useMapHost } from "./map-context.js";
import { MapHeader } from "./MapHeader.js";
import { mapUi, useMapRootState } from "./map-state.js";

export interface AgentMapProps {
  rootPath: string;
  tree: AgentTree;
  /** The session the person came from: a child is highlighted on arrival. */
  focusPath?: string | undefined;
  /** The header row. */
  chrome?: boolean;
  /** A notice above the body — the store's error, written for a person. */
  notice?: ReactNode;
  className?: string | undefined;
}

/** The measured content box of an element, live. Zero until the first measurement lands. */
function useMeasuredSize(): [RefObject<HTMLDivElement | null>, MapSize] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<MapSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number, height: number) =>
      setSize((s) => (s.width === Math.round(width) && s.height === Math.round(height) ? s : { width: Math.round(width), height: Math.round(height) }));
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) apply(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

export function AgentMap({ rootPath, tree, focusPath, chrome = true, notice, className }: AgentMapProps) {
  const host = useMapHost();
  const touch = useIsTouch();
  const [bodyRef, size] = useMeasuredSize();
  const { selected, showEnded } = useMapRootState(rootPath);
  const measured = size.width > 0 && size.height > 0;
  const fullscreen = host.frame === "fullscreen";
  const composition: MapComposition | undefined = measured ? compositionFor(size, { canvas: fullscreen }) : undefined;
  // A narrow fullscreen — the phone's "Open map" — keeps the canvas but takes
  // the sheet for details and finger-sized controls.
  const phone = fullscreen && size.width < CONSTRAINED_WIDTH;
  const visible = useMemo(() => visibleTreeOf(tree, showEnded), [tree, showEnded]);

  // Arriving from a child session highlights it, once per arrival.
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusPath || focusPath === rootPath || focused.current === focusPath) return;
    if (!tree.byPath.has(focusPath)) return;
    focused.current = focusPath;
    mapUi.select(rootPath, focusPath);
    if (tree.byPath.get(focusPath)?.ended) mapUi.setShowEnded(rootPath, true);
  }, [focusPath, rootPath, tree]);

  // A selection that folded away or left the tree is no selection.
  useEffect(() => {
    if (selected !== undefined && !visible.byPath.has(selected)) mapUi.select(rootPath, undefined);
  }, [selected, visible, rootPath]);

  const selectedNode = selected !== undefined ? visible.byPath.get(selected) : undefined;
  const inspectorColumn = composition === "full";
  const inspectorRow = composition === "panel" && !phone && selectedNode !== undefined;
  // The canvas's own room: the column takes width, the details row takes height.
  const canvasSize: MapSize = {
    width: Math.max(0, size.width - (inspectorColumn ? INSPECTOR_WIDTH : 0)),
    height: Math.max(0, inspectorRow ? Math.round(size.height * (1 - INSPECTOR_ROW_SHARE)) : size.height),
  };
  const deselect = () => mapUi.select(rootPath, undefined);

  return (
    <MapDataProvider value={{ rootPath, tree, composition: composition ?? "panel", selected }}>
      <section
        data-slot="agent-map"
        data-composition={composition}
        data-frame={host.frame}
        aria-label="Agent map"
        className={cn("agent-map flex h-full min-h-0 w-full min-w-0 flex-col bg-bg text-ink", className)}
      >
        <MapHeader
          rootPath={rootPath}
          nodes={tree.nodes}
          visible={visible}
          composition={composition}
          showEnded={showEnded}
          phone={phone}
          variant={chrome ? "full" : "slim"}
        />
        {notice}
        <div ref={bodyRef} data-slot="agent-map-body" className="relative flex min-h-0 min-w-0 flex-1">
          {composition === "constrained" && <LineageList rootPath={rootPath} visible={visible} className="flex-1" />}
          {(composition === "panel" || composition === "full") && (
            <>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="relative min-h-0 min-w-0 flex-1">
                  <Suspense fallback={<GenerationLoader label="Loading map" className="h-full" />}>
                    <MapCanvas rootPath={rootPath} visible={visible} composition={composition} size={canvasSize} touch={touch || phone} />
                  </Suspense>
                </div>
                {inspectorRow && selectedNode && <InspectorCard node={selectedNode} onClose={deselect} />}
              </div>
              {inspectorColumn && <InspectorColumn node={selectedNode} nodes={tree.nodes} />}
              {phone && <InspectorSheet node={selectedNode} onClose={deselect} />}
            </>
          )}
        </div>
      </section>
    </MapDataProvider>
  );
}
