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
 *     so instead of drawing `$0`: absent is not zero.
 *   - A model id **middle-truncates and keeps its tail** rather than ending in
 *     a CSS ellipsis: `anthropic/claude-…-4` still identifies the model,
 *     `anthropic/claude-sonn…` does not. Its line carries the cost; the token
 *     split sits under it, so a 288px column never has to choose between the
 *     id and the numbers.
 */
import type { ComponentProps } from "react";

import { money, tokens as formatTokens } from "@/format";
import { middleTruncate } from "@/fleet/truncate.js";
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

/** A model id at 12px mono in a 288px column, beside its cost. */
const MODEL_BUDGET = 22;

export function CostMeter({ runCostUsd, sessionCostUsd, lines, turns, className, ...props }: CostMeterProps) {
  const total = lines.reduce((sum, line) => sum + line.costUsd, 0) || sessionCostUsd;
  return (
    <div data-slot="cost-meter" className={cn("flex w-full flex-col gap-3", className)} {...props}>
      <div className="flex items-baseline gap-2">
        <span className="text-lg leading-lg font-semibold text-ink tnum">{money(sessionCostUsd)}</span>
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

      <div className="flex flex-col gap-2">
        {lines.map((line, i) => (
          <div key={line.model} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <span aria-hidden="true" className={cn("size-1.5 shrink-0 self-center rounded-full", SHARE_TONE[Math.min(i, 2)])} />
              <span className="min-w-0 flex-1 typed text-ink" title={line.model}>
                {middleTruncate(line.model, MODEL_BUDGET)}
              </span>
              <span className={cn(mono, "shrink-0 text-ink")}>{money(line.costUsd)}</span>
            </div>
            <span className={cn(mono, "ps-3.5 text-ink-3")}>
              {formatTokens(line.inputTokens)} in · {formatTokens(line.outputTokens)} out
            </span>
          </div>
        ))}
        {turns !== undefined && turns > 0 && sessionCostUsd > 0 && (
          <div className="flex items-baseline justify-between">
            <span className="text-xs leading-xs text-ink-2">Per turn</span>
            <span className={cn(mono, "text-ink")}>{money(sessionCostUsd / turns)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
