"use client";
/**
 * `elements-mermaid-diagram` (assistant-ui registry), restyled: Mermaid
 * fences in the transcript (docs/ux-elements.md "Mermaid diagram").
 *
 * The registry copy injects the renderer's SVG straight into the DOM. Here it
 * goes through `sanitizeSvg` first (invariant 9: a fence is transcript text),
 * the diagram's colours are the theme tokens rather than the shadcn names,
 * and the zoom overlay is the app's sheet vocabulary — page ground, hairlines,
 * ghost buttons, motion tokens. A diagram that fails to parse shows its
 * source with one plain sentence, never an empty box.
 */
import { renderMermaidSVG } from "beautiful-mermaid";
import { Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

import { sanitizeSvg } from "../utils/svg-sanitize.js";
import { MermaidSkeleton } from "./mermaid-skeleton.js";
import { ghostButton, mono } from "./surfaces.js";

export type MermaidDiagramProps = {
  code: string;
  className?: string | undefined;
  /** Renders a skeleton instead of the diagram while `true`. */
  streaming?: boolean | undefined;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

type MermaidZoomProps = { svg: string; children: ReactNode };

function MermaidZoom({ svg, children }: MermaidZoomProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // The same SVG twice on one page needs distinct ids for its markers and gradients.
  const zoomSvg = useMemo(
    () =>
      svg
        .replace(/id="([^"]+)"/g, 'id="$1-zoom"')
        .replace(/url\(#([^)]+)\)/g, "url(#$1-zoom)")
        .replace(/(href|xlink:href)="#([^"]+)"/g, '$1="#$2-zoom"'),
    [svg],
  );

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setTransform({ x: 0, y: 0, scale: 1 });
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = overlayRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      const first = focusables?.[0];
      const last = focusables?.[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (isOpen) closeRef.current?.focus();
  }, [isOpen]);

  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    setTransform((t) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));
      const ratio = scale / t.scale;
      if (cx === undefined || cy === undefined) {
        const viewport = viewportRef.current;
        cx = (viewport?.clientWidth ?? 0) / 2;
        cy = (viewport?.clientHeight ?? 0) / 2;
      }
      return { scale, x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio };
    });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    },
    [zoomBy],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = transformRef.current;
    drag.current = { startX: e.clientX, startY: e.clientY, originX: t.x, originY: t.y };
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setTransform((t) => ({ ...t, x: d.originX + e.clientX - d.startX, y: d.originY + e.clientY - d.startY }));
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  const toolButton = cn(ghostButton, "size-8");

  return (
    <div data-slot="mermaid-zoom-wrap" className="group/mermaid relative">
      {children}
      <button
        ref={triggerRef}
        type="button"
        data-slot="mermaid-zoom-trigger"
        aria-label="Expand diagram"
        onClick={() => setIsOpen(true)}
        className={cn(
          ghostButton,
          "absolute top-2 end-2 size-7 border border-line bg-surface opacity-0 transition-opacity duration-(--motion-instant)",
          "group-hover/mermaid:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100",
        )}
      >
        <Maximize2 className="size-3.5" />
      </button>
      {isMounted &&
        isOpen &&
        createPortal(
          <div
            ref={overlayRef}
            data-slot="mermaid-zoom-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Diagram"
            className="fixed inset-0 z-50 animate-in fade-in-0 bg-bg [animation-duration:var(--motion-slow)] motion-reduce:animate-none"
          >
            <div
              ref={viewportRef}
              className="h-full w-full cursor-grab touch-none overflow-hidden active:cursor-grabbing"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div
                data-slot="mermaid-zoom-content"
                className="flex h-full w-full items-center justify-center [&_svg]:max-h-[80vh] [&_svg]:max-w-[90vw] [&_text]:font-sans!"
                style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: "0 0" }}
                // Sanitized by `sanitizeSvg` before it reached this component.
                dangerouslySetInnerHTML={{ __html: zoomSvg }}
              />
            </div>
            <div
              data-slot="mermaid-zoom-toolbar"
              className="absolute top-4 end-4 flex items-center gap-1 rounded-lg border border-line bg-surface p-1 shadow-float-sm"
            >
              <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)} className={toolButton}>
                <Plus className="size-4" />
              </button>
              <button type="button" aria-label="Zoom out" onClick={() => zoomBy(0.8)} className={toolButton}>
                <Minus className="size-4" />
              </button>
              <button type="button" aria-label="Reset zoom" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })} className={toolButton}>
                <RotateCcw className="size-4" />
              </button>
              <button ref={closeRef} type="button" aria-label="Close" onClick={handleClose} className={toolButton}>
                <X className="size-4" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

type RenderResult = { svg: string; error: null } | { svg: null; error: string };

/** Draws the source with the theme's colours, then sanitizes; pure apart from the DOM parser. */
export function renderMermaid(code: string): RenderResult {
  try {
    const raw = renderMermaidSVG(code, {
      bg: "var(--surface-2)",
      fg: "var(--ink)",
      muted: "var(--ink-2)",
      border: "var(--line)",
      accent: "var(--live)",
      transparent: true,
    });
    const svg = sanitizeSvg(raw);
    if (!svg) return { svg: null, error: "The renderer produced something that is not an SVG." };
    return { svg, error: null };
  } catch (err) {
    return { svg: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const MermaidDiagramImpl: FC<MermaidDiagramProps> = ({ code, className, streaming = false }) => {
  const result = useMemo(() => (streaming ? null : renderMermaid(code)), [streaming, code]);

  if (!result) return <MermaidSkeleton className={className} />;

  if (result.error !== null) {
    return (
      <div data-slot="mermaid-fallback" className={cn("mb-4 overflow-hidden rounded-b-lg border border-line bg-surface-2 last:mb-0", className)}>
        <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-sm text-ink">{code.trim()}</pre>
        <p className={cn(mono, "border-t border-line px-3.5 py-1.5 text-ink-2")}>
          This diagram could not be drawn, so here is its source. {result.error}
        </p>
      </div>
    );
  }

  return (
    <MermaidZoom svg={result.svg}>
      <div
        data-slot="mermaid-diagram"
        className={cn(
          "mb-4 overflow-x-auto rounded-b-lg border border-line bg-surface-2 p-3 last:mb-0 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full [&_text]:font-sans!",
          className,
        )}
        // Sanitized by `sanitizeSvg` in `renderMermaid`.
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    </MermaidZoom>
  );
};

const MermaidDiagram = memo(MermaidDiagramImpl) as unknown as FC<MermaidDiagramProps> & { Zoom: typeof MermaidZoom };
MermaidDiagram.displayName = "MermaidDiagram";
MermaidDiagram.Zoom = MermaidZoom;

export { MermaidDiagram, MermaidZoom };
