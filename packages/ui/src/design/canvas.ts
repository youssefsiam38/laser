/**
 * The infinite canvas, as maths (M21-T11, `docs/design-phase.md`,
 * "How a design is displayed").
 *
 * One transformed layer, screens laid out as frames, flow edges drawn as SVG
 * between them. No WebGL and no raster canvas: the nodes stay real DOM so
 * comments anchor to node ids, text is selectable, accessibility works and the
 * phone gets the same bundle.
 *
 * Everything here is pure so the behaviour is testable without a browser: the
 * component owns pointers and elements, this owns where things are. Nothing
 * adopted, nothing imported — the whole surface is a transform, a layout and a
 * path, and a node-graph library would bring a virtualiser that remounts the
 * Shadow DOM frames it is asked to move.
 */
import type { DesignFlowEdge, DesignScreen } from "@lasercode/protocol";

export interface CanvasViewport {
  /** Translation of the layer, in canvas pixels. */
  x: number;
  y: number;
  scale: number;
}

export const CANVAS_MIN_SCALE = 0.2;
export const CANVAS_MAX_SCALE = 3;
export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, scale: 1 };

/** How far one arrow key moves the canvas, and one `+` press zooms it. */
export const CANVAS_PAN_STEP = 80;
export const CANVAS_ZOOM_STEP = 1.2;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, scale));
}

export function panBy(viewport: CanvasViewport, dx: number, dy: number): CanvasViewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/**
 * Zoom about a point in *client* space, so what is under the pointer (or in
 * the middle of the frame, for the keyboard) stays where it is.
 */
export function zoomAt(viewport: CanvasViewport, factor: number, point: { x: number; y: number }): CanvasViewport {
  const scale = clampScale(viewport.scale * factor);
  if (scale === viewport.scale) return viewport;
  const ratio = scale / viewport.scale;
  return { scale, x: point.x - (point.x - viewport.x) * ratio, y: point.y - (point.y - viewport.y) * ratio };
}

/** A wheel event: pinch and ctrl-wheel zoom, everything else pans. */
export function wheelToViewport(
  viewport: CanvasViewport,
  event: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey?: boolean },
  point: { x: number; y: number },
): CanvasViewport {
  if (event.ctrlKey || event.metaKey === true) {
    // A trackpad pinch arrives as ctrl+wheel; the exponent keeps it smooth.
    return zoomAt(viewport, Math.exp(-event.deltaY / 200), point);
  }
  return panBy(viewport, -event.deltaX, -event.deltaY);
}

/** Two fingers: the distance between them is the scale, their middle is the anchor. */
export function pinchToViewport(viewport: CanvasViewport, from: number, to: number, centre: { x: number; y: number }): CanvasViewport {
  if (from <= 0 || to <= 0) return viewport;
  return zoomAt(viewport, to / from, centre);
}

export type CanvasKeyAction =
  | { type: "pan"; dx: number; dy: number }
  | { type: "zoom"; factor: number }
  | { type: "fit" }
  | { type: "reset" };

/**
 * Keyboard panning and zooming.
 *
 * Arrows pan, `+`/`-` zoom, `0` fits everything, `1` returns to actual size.
 * Under `rtl` the horizontal arrows swap, so "forward" is the direction the
 * person reads in and the canvas moves the way the page does.
 */
export function canvasKeyAction(
  event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  direction: "ltr" | "rtl" = "ltr",
): CanvasKeyAction | undefined {
  if (event.altKey === true || event.metaKey === true) return undefined;
  const step = event.shiftKey === true ? CANVAS_PAN_STEP * 3 : CANVAS_PAN_STEP;
  const inline = direction === "rtl" ? -1 : 1;
  switch (event.key) {
    case "ArrowLeft":
      return { type: "pan", dx: step * inline, dy: 0 };
    case "ArrowRight":
      return { type: "pan", dx: -step * inline, dy: 0 };
    case "ArrowUp":
      return { type: "pan", dx: 0, dy: step };
    case "ArrowDown":
      return { type: "pan", dx: 0, dy: -step };
    case "+":
    case "=":
      return { type: "zoom", factor: CANVAS_ZOOM_STEP };
    case "-":
    case "_":
      return { type: "zoom", factor: 1 / CANVAS_ZOOM_STEP };
    case "0":
      return { type: "fit" };
    case "1":
      return { type: "reset" };
    default:
      return undefined;
  }
}

export function applyCanvasKey(viewport: CanvasViewport, action: CanvasKeyAction, centre: { x: number; y: number }): CanvasViewport {
  switch (action.type) {
    case "pan":
      return panBy(viewport, action.dx, action.dy);
    case "zoom":
      return zoomAt(viewport, action.factor, centre);
    case "reset":
      return { ...viewport, scale: 1 };
    case "fit":
      return viewport; // the caller knows the frames; `fitViewport` decides.
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface FrameBox {
  screenId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The viewport sizes a screen may name, and what they mean in pixels. */
export const CANVAS_VIEWPORTS: Readonly<Record<string, { width: number; height: number; label: string }>> = {
  phone: { width: 390, height: 844, label: "Phone" },
  tablet: { width: 834, height: 1112, label: "Tablet" },
  laptop: { width: 1280, height: 800, label: "Laptop" },
  desktop: { width: 1440, height: 900, label: "Desktop" },
};

const DEFAULT_FRAME = CANVAS_VIEWPORTS["laptop"] ?? { width: 1280, height: 800, label: "Laptop" };
/** The gutter between frames, in canvas pixels. */
export const FRAME_GAP = 96;
/** How many frames sit in one row before the layout wraps. */
export const FRAMES_PER_ROW = 3;

export function frameSize(viewport: string | undefined): { width: number; height: number } {
  const known = viewport ? CANVAS_VIEWPORTS[viewport] : undefined;
  return { width: (known ?? DEFAULT_FRAME).width, height: (known ?? DEFAULT_FRAME).height };
}

/**
 * Where each screen sits on the canvas.
 *
 * A simple wrapped row: frames keep the order the design lists them in, so a
 * revision that adds a screen does not move the ones a person already knows
 * where to find. Rows are as tall as their tallest frame.
 */
export function frameLayout(screens: readonly DesignScreen[], perRow: number = FRAMES_PER_ROW): FrameBox[] {
  const boxes: FrameBox[] = [];
  let rowTop = 0;
  for (let index = 0; index < screens.length; index += perRow) {
    const row = screens.slice(index, index + perRow);
    let left = 0;
    let tallest = 0;
    for (const screen of row) {
      const size = frameSize(screen.viewport);
      boxes.push({ screenId: screen.id, x: left, y: rowTop, width: size.width, height: size.height });
      left += size.width + FRAME_GAP;
      tallest = Math.max(tallest, size.height);
    }
    rowTop += tallest + FRAME_GAP;
  }
  return boxes;
}

export interface CanvasBounds {
  width: number;
  height: number;
}

/** The viewport that shows every frame inside `container`, with a margin. */
export function fitViewport(boxes: readonly FrameBox[], container: CanvasBounds, margin = FRAME_GAP): CanvasViewport {
  if (boxes.length === 0 || container.width <= 0 || container.height <= 0) return DEFAULT_VIEWPORT;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const width = right - left + margin * 2;
  const height = bottom - top + margin * 2;
  const scale = clampScale(Math.min(container.width / width, container.height / height));
  return {
    scale,
    x: (container.width - (right - left) * scale) / 2 - left * scale,
    y: (container.height - (bottom - top) * scale) / 2 - top * scale,
  };
}

/** The CSS transform for the one layer everything rides on. */
export function layerTransform(viewport: CanvasViewport): string {
  return `translate(${String(round(viewport.x))}px, ${String(round(viewport.y))}px) scale(${String(round(viewport.scale, 4))})`;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface EdgeGeometry {
  id: string;
  path: string;
  /** Where the edge's label sits, in canvas coordinates. */
  label: { x: number; y: number };
  from: string;
  to: string;
  kind: "navigate" | "overlay";
  trigger: DesignFlowEdge["trigger"];
}

/**
 * A flow edge between two frames, as a cubic curve from the right edge of the
 * source to the left edge of the target (mirrored when the target is behind).
 * An edge to the frame it starts from loops out and back, so a self-flow —
 * "this dialog closes onto itself" — is still readable.
 */
export function edgeGeometry(flow: DesignFlowEdge, boxes: readonly FrameBox[]): EdgeGeometry | undefined {
  const action = flow.action;
  if (action.type !== "navigate" && action.type !== "overlay") return undefined;
  const from = boxes.find((box) => box.screenId === flow.fromScreenId);
  const to = boxes.find((box) => box.screenId === action.screenId);
  if (!from || !to) return undefined;

  const startY = from.y + from.height / 2;
  const endY = to.y + to.height / 2;
  if (from.screenId === to.screenId) {
    const x = from.x + from.width;
    const loop = FRAME_GAP / 2;
    return {
      id: flow.id,
      path: `M ${n(x)} ${n(startY - loop)} C ${n(x + loop * 2)} ${n(startY - loop)}, ${n(x + loop * 2)} ${n(startY + loop)}, ${n(x)} ${n(startY + loop)}`,
      label: { x: x + loop * 1.5, y: startY },
      from: from.screenId,
      to: to.screenId,
      kind: action.type,
      trigger: flow.trigger,
    };
  }
  const forward = to.x >= from.x + from.width || to.x > from.x;
  const startX = forward ? from.x + from.width : from.x;
  const endX = forward ? to.x : to.x + to.width;
  const bend = Math.max(FRAME_GAP, Math.abs(endX - startX) / 2);
  const c1 = forward ? startX + bend : startX - bend;
  const c2 = forward ? endX - bend : endX + bend;
  return {
    id: flow.id,
    path: `M ${n(startX)} ${n(startY)} C ${n(c1)} ${n(startY)}, ${n(c2)} ${n(endY)}, ${n(endX)} ${n(endY)}`,
    label: { x: (startX + endX) / 2, y: (startY + endY) / 2 },
    from: from.screenId,
    to: to.screenId,
    kind: action.type,
    trigger: flow.trigger,
  };
}

function n(value: number): string {
  return String(round(value));
}

/** The box every frame and edge fits inside, for the SVG's own size. */
export function canvasExtent(boxes: readonly FrameBox[]): { width: number; height: number } {
  if (boxes.length === 0) return { width: 0, height: 0 };
  return {
    width: Math.max(...boxes.map((box) => box.x + box.width)) + FRAME_GAP * 2,
    height: Math.max(...boxes.map((box) => box.y + box.height)) + FRAME_GAP * 2,
  };
}
