"use client";
/**
 * Thinking indicator (`elements-thinking-indicator`): the header of the
 * assistant's reasoning block while it streams — it says the model is
 * reasoning before any text has arrived. Pairs with `reasoning.aui` (the
 * collapsible) and `reasoning-panel` (the body).
 *
 * Divergences from the registry copy: the dot is the app's one `working`
 * status dot (the radar sweep) rather than a pulsing blue disc, and the
 * elapsed value is `typed` (12px, tabular) rather than 11px.
 */
import type { ComponentProps } from "react";

import { StatusDot } from "@/components/status";
import { cn } from "@/lib/utils";

import { mono, ShimmerLabel } from "./surfaces.js";

export interface ThinkingIndicatorProps extends Omit<ComponentProps<"span">, "children"> {
  label: string;
  /** Already formatted: "3.2s". */
  elapsed?: string | undefined;
  /** The dot is redundant inside a row that already carries one. */
  dot?: boolean;
}

export function ThinkingIndicator({ label, elapsed, dot = true, className, ...props }: ThinkingIndicatorProps) {
  return (
    <span data-slot="thinking-indicator" className={cn("inline-flex items-center gap-2 text-sm", className)} {...props}>
      {dot ? <StatusDot status="working" size="sm" aria-hidden="true" /> : null}
      <ShimmerLabel key={label} className="relative inline-block font-medium leading-none">
        {label}
      </ShimmerLabel>
      {elapsed !== undefined ? <span className={cn(mono, "text-ink-3 tnum")}>{elapsed}</span> : null}
    </span>
  );
}
