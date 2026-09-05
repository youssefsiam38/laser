"use client";
/**
 * Cost meter — spend in the telemetry rail (docs/ux-elements.md
 * "Observability", R8). Installed from `elements-cost-meter` and restyled to
 * DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - Costs are numbers formatted here (`money`), not preformatted strings,
 *     so the same value reads the same everywhere.
 *   - Token counts use the app's `tokens` formatter (`12.3k`), tabular.
 *   - A line's `share` is derived from its cost against the total; the
 *     caller does not compute percentages.
 *   - Colours read tokens: the first model `--live`, the second a 55% mix,
 *     the rest `--ink-3`.
 *   - "Not measured" is a state: when no usage was recorded the card says
 *     so instead of drawing `$0` (docs/ux-panels.md "Usage is raw").
 */
import type { ComponentProps } from "react";

import { money, tokens as formatTokens } from "@/format";
import { cn } from "@/lib/utils";

import { announced, pct } from "../utils/range.js";
import { mono } from "./surfaces.js";

export interface CostLine {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostMeterProps extends Omit<ComponentProps<"div">, "children"> {
  /** What the last turn cost. */
  runCostUsd: number | undefined;
  /** What the whole session has cost. */
  sessionCostUsd: number;
  lines: readonly CostLine[];
  /** Turns that reported usage. */
  turns?: number | undefined;
}

const SHARE_TONE = ["bg-live", "bg-[color-mix(in_oklab,var(--live)_55%,transparent)]", "bg-ink-3"] as const;

export function CostMeter({ runCostUsd, sessionCostUsd, lines, turns, className, ...props }: CostMeterProps) {
  const total = lines.reduce((sum, line) => sum + line.costUsd, 0) || sessionCostUsd;
  return (
    <div data-slot="cost-meter" className={cn("flex w-full flex-col gap-3", className)} {...props}>
      <div className="flex items-baseline gap-2">
        <span className="text-xl leading-xl font-semibold text-ink tnum">{money(sessionCostUsd)}</span>
        <span className={cn(mono, "text-ink-3")}>session</span>
        {runCostUsd !== undefined && (
          <span className={cn(mono, "ms-auto text-ink-2")}>
            {money(runCostUsd)} <span className="text-ink-3">last turn</span>
          </span>
        )}
      </div>

      {lines.length > 0 && (
        <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-2">
          {lines.map((line, i) => {
            const width = pct(line.costUsd, total);
            if (announced(width) === 0) return null;
            return (
              <span
                key={line.model}
                role="meter"
                aria-label={`${line.model} share of cost`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={announced(width)}
                className={cn("h-full transition-[width] duration-(--motion-slow) motion-reduce:transition-none", SHARE_TONE[Math.min(i, 2)])}
                style={{ width: `${width}%` }}
              />
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {lines.map((line, i) => (
          <div key={line.model} className="flex items-baseline gap-2">
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 self-center rounded-full", SHARE_TONE[Math.min(i, 2)])} />
            <span className="min-w-0 flex-1 truncate typed text-ink" title={line.model}>
              {line.model}
            </span>
            <span className={cn(mono, "shrink-0 text-ink-3")}>
              {formatTokens(line.inputTokens)} in · {formatTokens(line.outputTokens)} out
            </span>
            <span className={cn(mono, "shrink-0 text-ink-2")}>{money(line.costUsd)}</span>
          </div>
        ))}
        {turns !== undefined && turns > 0 && (
          <div className="flex items-baseline justify-between">
            <span className="text-xs leading-5 text-ink-2">Per turn</span>
            <span className={cn(mono, "text-ink")}>{money(sessionCostUsd / turns)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
