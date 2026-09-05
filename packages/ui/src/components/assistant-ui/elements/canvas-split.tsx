"use client";
/**
 * Canvas split — THE dock (docs/ux-elements.md "Thread": "thread beside
 * panels is exactly this split"). Installed from `elements-canvas-split` and
 * rebuilt as the frame the dock lives in: the row that holds the thread and
 * the pane, the pane itself, and the divider between them.
 *
 * Divergences from the registry copy, which was a fixed 15rem thread beside a
 * document with a title/version/saved header:
 *   - The pane is resizable — a divider with pointer capture and arrow keys,
 *     44px of grab on a coarse pointer — and grows past ~640px into two
 *     columns (D-20). Its width is state the dock owns.
 *   - No document header, body or message parts: what sits in the pane is an
 *     island, and an island draws its own header (agent-status) and body.
 *     The registry's `CanvasSplitHeader` is a single-document canvas; the
 *     dock holds many, each with its own identity (R6).
 *   - No fixed `max-w-3xl` or `md:h-80`; it fills the shell.
 *
 * `Dock.tsx` keeps the layout engine — four island sizes, two expanded per
 * column, LRU shrink, dividers, maximize — and renders through these parts.
 */
import type { ComponentProps, KeyboardEvent, PointerEvent } from "react";

import { cn } from "@/lib/utils";

/*
 * The registry's `CanvasSplit` row and `CanvasSplitThread` column are not
 * exported, and deliberately. In laser the split's row is the shell's own
 * layout row, and it holds four things, not two: the sessions panel, the
 * thread's `<main>`, this pane and the telemetry panel, with the workbench
 * covering all of them. A two-child wrapper would have to be given
 * `flex-1`/`min-w-0` to survive among those siblings, at which point it is
 * the `<div>` Shell.tsx already has — and `<main>` already carries the
 * thread column's classes. What is worth adopting here is the behaviour:
 * the resizable pane and the divider below.
 */

/** The pane the islands live in. `width` is owned by the caller. */
export function CanvasSplitPane({ width, className, ...props }: ComponentProps<"aside"> & { width: number }) {
  return (
    <aside
      data-slot="canvas-split-pane"
      style={{ width }}
      className={cn("relative flex h-full min-h-0 shrink-0 flex-col bg-bg hairline-l", className)}
      {...props}
    />
  );
}

export interface CanvasSplitDividerProps extends Omit<ComponentProps<"div">, "children" | "onChange"> {
  /** Current pane width in px. */
  width: number;
  min: number;
  max: number;
  /** Called with the new width while dragging, and on each arrow key. */
  onChange(width: number): void;
  /** Reads the pane's actual width when a drag starts, so a clamped state never jumps. */
  measure?: (() => number) | undefined;
}

/**
 * The pane's left edge. Dragging left widens the pane; arrows nudge it 16px,
 * Shift-arrows 64px. The hit area is 8px with a mouse and 16px with a finger,
 * around a hairline that shows on hover and focus.
 */
export function CanvasSplitDivider({ width, min, max, onChange, measure, className, ...props }: CanvasSplitDividerProps) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const startWidth = measure?.() ?? width;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => onChange(startWidth + (startX - ev.clientX));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") onChange(width + step);
    else if (e.key === "ArrowRight") onChange(width - step);
    else if (e.key === "Home") onChange(min);
    else return;
    e.preventDefault();
  };
  return (
    <div
      data-slot="canvas-split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the dock"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-y-0 -start-1 z-10 w-2 cursor-col-resize touch-none outline-none",
        "transition-colors duration-(--motion-instant) hover:bg-live/30 focus-visible:bg-live/40",
        // 44px of grab on a coarse pointer — the hit area, not the paint,
        // the same way the dock's horizontal divider does it.
        "[@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-x-5 [@media(pointer:coarse)]:before:inset-y-0 [@media(pointer:coarse)]:before:content-['']",
        className,
      )}
      {...props}
    />
  );
}
