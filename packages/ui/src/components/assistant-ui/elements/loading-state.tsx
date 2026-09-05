"use client";
/**
 * Loader (`elements-loading-state`): a 3×3 matrix that keeps time while
 * there is nothing to show yet, with a shimmering label beneath it. Used for
 * session hydration, the entries fetch, the model list and a panel body
 * before its first data.
 *
 * Divergences from the registry copy, each on purpose:
 *   - `tick` is optional. Left out, the loader drives itself off the
 *     `--motion-fast` token, and holds still when that token is zero
 *     (reduced motion), so no caller has to own an interval.
 *   - Left-aligned like everything else in the thread; no `items-center`.
 *   - Cells are `--ink-3`, the label is `--ink-2`; no `foreground/55` alphas.
 */
import type { ComponentProps } from "react";

import { useTick } from "@/components/thread/timing";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";

import { ShimmerLabel } from "./surfaces.js";

export type GenerationLoaderVariant = "dots" | "squares" | "rounded";

export interface GenerationLoaderProps extends Omit<ComponentProps<"div">, "children"> {
  /** What is being waited for, in words a person reads: "Loading session". */
  label: string;
  /** Drive the matrix from outside; omit to let it tick on its own. */
  tick?: number | undefined;
  variant?: GenerationLoaderVariant;
  /** `inline` fits a row (a menu, a table cell); `block` stands alone. */
  layout?: "inline" | "block";
}

const CELL_SHAPES: Record<GenerationLoaderVariant, string> = {
  dots: "rounded-full",
  squares: "rounded-[1px]",
  rounded: "rounded-xs",
};

export function GenerationLoader({ label, tick, variant = "dots", layout = "block", className, ...props }: GenerationLoaderProps) {
  const step = motionMs("--motion-fast");
  const own = useTick(tick === undefined && step > 0, Math.max(step, 50) * 2);
  const frame = tick ?? own;
  const pixelOffset = Math.floor(frame / 3);

  return (
    <div
      data-slot="generation-loader"
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn(layout === "block" ? "flex flex-col items-start gap-3" : "flex items-center gap-2.5", className)}
      {...props}
    >
      <div aria-hidden="true" className={cn("grid grid-cols-3", layout === "block" ? "gap-1" : "gap-px")}>
        {Array.from({ length: 9 }, (_, index) => {
          const active = (index * 2 + pixelOffset) % 9 < 3;
          return (
            <span
              key={index}
              className={cn(
                "bg-ink-3 transition-opacity duration-(--motion-fast) motion-reduce:transition-none",
                layout === "block" ? "size-1.5" : "size-1",
                CELL_SHAPES[variant],
                active ? "opacity-90" : "opacity-20",
              )}
            />
          );
        })}
      </div>
      <ShimmerLabel className="relative inline-block text-sm">{label}</ShimmerLabel>
    </div>
  );
}
