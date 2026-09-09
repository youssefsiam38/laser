"use client";
/**
 * Job progress — "a `run` panel's `progress`, when it has one; absent when it
 * does not. Never a fake bar" (docs/ux-elements.md). Installed from
 * `elements-job-progress` and fed from `RunPanel.progress` and
 * `RunPanel.phase`.
 *
 * Divergences from the registry copy:
 *   - No ETA and no weighted stages: none of the four run producers has a
 *     percentage or a duration estimate (docs/ux-fleet.md R6, "Nobody has a
 *     progress percentage"), so the bar draws `done/total` or an
 *     indeterminate sweep, and the stage row draws the producer's `phase`
 *     (`index` is 1-based) — a stepper, not a bar.
 *   - No cancel control: a run's declared actions render with the run (R2).
 *   - Renders nothing when there is neither a progress nor a phase.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";
import { announced, pct } from "../utils/range.js";

export type JobProgressValue = { done: number; total: number } | "indeterminate";
export interface JobPhase {
  label: string;
  /** 1-based. */
  index?: number | undefined;
  total?: number | undefined;
}

/** The most phase segments drawn before the strip becomes a count (R13: drop, never squeeze). */
const MAX_SEGMENTS = 24;

export function JobProgress({
  progress,
  phase,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  progress?: JobProgressValue | undefined;
  phase?: JobPhase | undefined;
}) {
  if (!progress && !phase) return null;
  const known = phase?.index !== undefined && phase.total !== undefined && phase.total > 0;
  const current = (phase?.index ?? 1) - 1;
  return (
    <div data-slot="job-progress" className={cn("flex flex-col gap-1.5", className)} {...props}>
      {phase && (
        <div className="flex flex-col gap-1" aria-label={known ? `Phase ${phase.index} of ${phase.total}: ${phase.label}` : `Phase: ${phase.label}`}>
          <div className="flex items-baseline gap-2">
            <span className="eyebrow">Phase</span>
            {known && (
              <span className={cn(mono, "text-ink-2")}>
                {phase.index}/{phase.total}
              </span>
            )}
            <span className="min-w-0 truncate text-sm text-ink">{phase.label}</span>
          </div>
          {known && (
            <div className="flex gap-1" aria-hidden="true">
              {Array.from({ length: Math.min(phase.total!, MAX_SEGMENTS) }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-(--motion-slow) motion-reduce:transition-none",
                    i < current ? "bg-live" : i === current ? "bg-live/50 motion-safe:animate-attention" : "bg-line",
                  )}
                />
              ))}
              {phase.total! > MAX_SEGMENTS && <span className={cn(mono, "text-ink-3")}>+{phase.total! - MAX_SEGMENTS}</span>}
            </div>
          )}
        </div>
      )}
      {progress === "indeterminate" ? (
        <div className="h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Working" aria-valuetext="in progress">
          <div className="h-full w-full rounded-full bg-live/60 motion-safe:animate-attention" />
        </div>
      ) : progress ? (
        <div className="flex items-center gap-2">
          <span
            role="progressbar"
            aria-label="Progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={Math.min(progress.done, progress.total)}
            aria-valuetext={`${progress.done} of ${progress.total}`}
            className="h-1 flex-1 overflow-hidden rounded-full bg-line"
          >
            <span
              className="block h-full rounded-full bg-live transition-[width] duration-(--motion-slow) ease-morph motion-reduce:transition-none"
              style={{ width: `${announced(pct(progress.done, progress.total))}%` }}
            />
          </span>
          <span className={cn(mono, "text-ink-2")}>
            {progress.done}/{progress.total}
          </span>
        </div>
      ) : null}
    </div>
  );
}
