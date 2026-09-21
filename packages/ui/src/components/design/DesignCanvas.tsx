"use client";
/**
 * The DOM infinite canvas (M21-T11, `docs/design-phase.md`).
 *
 * One transformed layer holding every frame, with the flow edges drawn as SVG
 * underneath. Pan and zoom come from pointers, the wheel, a pinch **and the
 * keyboard** — arrows pan, `+`/`-` zoom, `0` fits, `1` returns to actual size
 * — because a canvas only a mouse can move is a canvas half the people who
 * use this app cannot move. Under `rtl` the horizontal arrows swap, so the
 * canvas travels the way the page reads.
 *
 * Motion: the layer transitions only for a deliberate step (a key, a fit, a
 * frame that was brought into view), never while a pointer is dragging it, and
 * not at all under `prefers-reduced-motion` — the position still changes, the
 * movement does not.
 */
import { Maximize2, Minus, Plus, Scan } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesignBody, DesignFlowEdge } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  applyCanvasKey,
  canvasExtent,
  canvasKeyAction,
  DEFAULT_VIEWPORT,
  edgeGeometry,
  fitViewport,
  frameLayout,
  layerTransform,
  panBy,
  pinchToViewport,
  wheelToViewport,
  zoomAt,
  CANVAS_ZOOM_STEP,
  type CanvasViewport,
} from "@/design/canvas";
import { prefersReducedMotion } from "@/motion";

import { ScreenFrame, type SketchBytes } from "./ScreenFrame.js";
import type { KitRenderContext } from "./kit/KitNode.js";

export interface DesignCanvasProps {
  body: DesignBody;
  tokenProperties: Readonly<Record<string, string>>;
  /** One render context per screen, built by the detail. */
  contextFor: (screenId: string) => KitRenderContext;
  sketchBytes?: Readonly<Record<string, SketchBytes>> | undefined;
  selectedScreenId?: string | undefined;
  onSelectScreen?: ((screenId: string) => void) | undefined;
  onFlipScreen?: ((screenId: string) => void) | undefined;
  onOpenFullScreen?: (() => void) | undefined;
  theme?: string | undefined;
  /** Read-only on a phone and on an older revision; no drag, no edit. */
  interactive?: boolean;
  className?: string;
}

export function DesignCanvas({
  body,
  tokenProperties,
  contextFor,
  sketchBytes,
  selectedScreenId,
  onSelectScreen,
  onFlipScreen,
  onOpenFullScreen,
  theme,
  interactive = true,
  className,
}: DesignCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(DEFAULT_VIEWPORT);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | undefined>(undefined);
  const fitted = useRef(false);

  const boxes = useMemo(() => frameLayout(body.screens), [body.screens]);
  const extent = useMemo(() => canvasExtent(boxes), [boxes]);
  const edges = useMemo(
    () => body.flows.map((flow: DesignFlowEdge) => edgeGeometry(flow, boxes)).filter((edge): edge is NonNullable<typeof edge> => edge !== undefined),
    [body.flows, boxes],
  );

  const containerBounds = useCallback(() => {
    const element = containerRef.current;
    const rect = element?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, []);

  const fit = useCallback(() => {
    setViewport(fitViewport(boxes, containerBounds()));
  }, [boxes, containerBounds]);

  // The first paint frames everything; after that the person's own view is
  // theirs to keep, and a new screen does not yank it away.
  useLayoutEffect(() => {
    if (fitted.current || boxes.length === 0) return;
    const bounds = containerBounds();
    if (bounds.width === 0) return;
    fitted.current = true;
    setViewport(fitViewport(boxes, bounds));
  }, [boxes, containerBounds]);

  // The wheel needs a non-passive listener to keep the page from scrolling
  // while the canvas is being panned or pinched.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setViewport((current) =>
        wheelToViewport(current, { deltaX: event.deltaX, deltaY: event.deltaY, ctrlKey: event.ctrlKey }, { x: event.clientX - rect.left, y: event.clientY - rect.top }),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const centre = useCallback(() => {
    const bounds = containerBounds();
    return { x: bounds.width / 2, y: bounds.height / 2 };
  }, [containerBounds]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const element = containerRef.current;
      const direction = element && getComputedStyle(element).direction === "rtl" ? "rtl" : "ltr";
      const action = canvasKeyAction(event, direction);
      if (!action) return;
      event.preventDefault();
      if (action.type === "fit") {
        fit();
        return;
      }
      setViewport((current) => applyCanvasKey(current, action, centre()));
    },
    [centre, fit],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    // Only the ground pans: a pointer that went down on a frame belongs to the
    // frame, so a person can select and drag inside a design.
    if (event.target !== event.currentTarget) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length >= 2) {
      const [first, second] = points as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const rect = event.currentTarget.getBoundingClientRect();
      const middle = { x: (first.x + second.x) / 2 - rect.left, y: (first.y + second.y) / 2 - rect.top };
      const from = pinch.current;
      pinch.current = distance;
      if (from !== undefined) setViewport((current) => pinchToViewport(current, from, distance, middle));
      return;
    }
    setViewport((current) => panBy(current, event.clientX - previous.x, event.clientY - previous.y));
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = undefined;
    if (pointers.current.size === 0) setDragging(false);
  };

  const reduced = prefersReducedMotion();
  const zoomPercent = Math.round(viewport.scale * 100);

  return (
    <div data-slot="design-canvas" className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg", className)}>
      <div
        ref={containerRef}
        role="group"
        aria-label="Design canvas"
        aria-describedby="design-canvas-help"
        tabIndex={0}
        data-dragging={dragging ? "true" : undefined}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          interactive && (dragging ? "cursor-grabbing" : "cursor-grab"),
        )}
      >
        <div
          data-slot="design-canvas-layer"
          data-transform={layerTransform(viewport)}
          style={{
            transform: layerTransform(viewport),
            transformOrigin: "0 0",
            width: `${String(extent.width)}px`,
            height: `${String(extent.height)}px`,
            transition: dragging || reduced ? undefined : "transform var(--motion-fast) var(--motion-ease)",
          }}
          className="absolute start-0 top-0 origin-top-left"
        >
          <svg
            aria-hidden="true"
            width={extent.width}
            height={extent.height}
            viewBox={`0 0 ${String(extent.width)} ${String(extent.height)}`}
            className="pointer-events-none absolute start-0 top-0 overflow-visible"
          >
            <defs>
              <marker id="design-edge-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--line)" />
              </marker>
            </defs>
            {edges.map((edge) => (
              <g key={edge.id} data-slot="design-flow-edge" data-edge-id={edge.id} data-from={edge.from} data-to={edge.to} data-kind={edge.kind}>
                <path
                  d={edge.path}
                  fill="none"
                  stroke="var(--line)"
                  strokeWidth={2}
                  strokeDasharray={edge.kind === "overlay" ? "6 6" : undefined}
                  markerEnd="url(#design-edge-arrow)"
                />
                <text x={edge.label.x} y={edge.label.y} textAnchor="middle" fill="var(--ink-3)" fontSize="var(--text-xs)" fontFamily="var(--font-mono)">
                  {edge.trigger}
                </text>
              </g>
            ))}
          </svg>

          {boxes.map((box) => {
            const screen = body.screens.find((candidate) => candidate.id === box.screenId);
            if (!screen) return null;
            return (
              <div key={box.screenId} className="absolute" style={{ insetInlineStart: `${String(box.x)}px`, top: `${String(box.y)}px` }}>
                <ScreenFrame
                  body={body}
                  screen={screen}
                  context={contextFor(screen.id)}
                  tokenProperties={tokenProperties}
                  sketchBytes={sketchBytes?.[screen.id]}
                  selected={selectedScreenId === screen.id}
                  onSelectScreen={onSelectScreen}
                  onFlip={onFlipScreen}
                  theme={theme}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-t border-line bg-surface px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="Zoom out" onClick={() => setViewport((current) => zoomAt(current, 1 / CANVAS_ZOOM_STEP, centre()))}>
              <Minus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out · minus</TooltipContent>
        </Tooltip>
        <span className="typed tnum w-12 text-center text-ink-2">{zoomPercent}%</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="Zoom in" onClick={() => setViewport((current) => zoomAt(current, CANVAS_ZOOM_STEP, centre()))}>
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in · plus</TooltipContent>
        </Tooltip>
        <Button size="xs" variant="ghost" onClick={fit}>
          <Scan />
          Fit
        </Button>
        {onOpenFullScreen ? (
          <Button size="xs" variant="ghost" className="ms-auto" onClick={onOpenFullScreen}>
            <Maximize2 />
            Full screen
          </Button>
        ) : null}
        <p id="design-canvas-help" className={cn("text-xs leading-xs text-ink-3", onOpenFullScreen ? "" : "ms-auto")}>
          Drag to move · arrows pan · plus and minus zoom · 0 fits
        </p>
      </div>
    </div>
  );
}
