"use client";
/**
 * Chart — usage and spend over time in the telemetry rail
 * (docs/ux-elements.md "Structured output"). Installed from `elements-chart`
 * and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - `visibleCount` (the demo's point-by-point reveal) is gone; the series
 *     is the session's turns and it is drawn whole.
 *   - `rising`/`falling` colouring is gone: a rising spend is not good news
 *     and a falling one is not bad, so the delta is plain typed text.
 *   - The `value` and `delta` are strings the caller formats with the app's
 *     formatters (`money`, `tokens`), so the number reads like every other.
 *   - The accessible name carries the last three points, not just the total.
 *   - Colours read tokens: `--live` line and area, `--line` baseline,
 *     `--ink-3` bars.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export type ChartVariant = "area" | "line" | "bars";

const W = 300;
const H = 72;
const PAD = 4;

const scale = (points: readonly number[]) => {
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  return (value: number) => H - PAD - ((value - min) / span) * (H - PAD * 2);
};

export interface ChartProps extends Omit<ComponentProps<"div">, "children"> {
  label: string;
  value: string;
  delta?: string | undefined;
  points: readonly number[];
  /** One label per point for the accessible description, e.g. a turn number. */
  pointLabel?: ((value: number, index: number) => string) | undefined;
  variant?: ChartVariant | undefined;
}

export function Chart({ label, value, delta, points, pointLabel, variant = "area", className, ...props }: ChartProps) {
  const y = scale(points);
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const coords = points.map((p, i) => ({ x: x(i), y: y(p) }));
  const line = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const last = coords.at(-1);
  const area = last ? `M ${PAD},${H - PAD} ${coords.map((c) => `L ${c.x},${c.y}`).join(" ")} L ${last.x},${H - PAD} Z` : "";
  const lastIndex = points.length - 1;
  const described = points
    .slice(-3)
    .map((p, i) => (pointLabel ? pointLabel(p, points.length - 3 + i) : String(p)))
    .join(", ");

  return (
    <div data-slot="chart" className={cn("flex w-full flex-col gap-2", className)} {...props}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs leading-5 text-ink-2">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="typed text-ink">{value}</span>
          {delta !== undefined && <span className={cn(mono, "text-ink-3")}>{delta}</span>}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}: ${value}. Latest: ${described}`}
        className="h-18 w-full overflow-visible"
        preserveAspectRatio="none"
      >
        <line x1="0" x2={W} y1={H - PAD} y2={H - PAD} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {variant === "bars" ? (
          points.map((p, i) => {
            const top = y(p);
            const barWidth = Math.max(2, step * 0.55);
            return (
              <rect
                key={i}
                x={x(i) - barWidth / 2}
                y={top}
                width={barWidth}
                height={Math.max(1, H - PAD - top)}
                rx="1.5"
                className={i === lastIndex ? "fill-live" : "fill-ink-3"}
              />
            );
          })
        ) : (
          <>
            {variant === "area" && points.length > 1 && <path d={area} className="fill-[color-mix(in_oklab,var(--live)_14%,transparent)]" />}
            <polyline points={line} fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="stroke-live" />
            {last && <circle cx={last.x} cy={last.y} r="3" className="fill-live" />}
          </>
        )}
      </svg>
    </div>
  );
}
