"use client";
/**
 * Chart — usage/spend in the telemetry rail and bounded physical memory in
 * Advanced resource diagnostics (docs/ux-elements.md "Structured output"). Installed from `elements-chart`
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
 *   - A nullish resource sample breaks the geometry and is described as
 *     unavailable; it is never plotted at zero or connected across.
 *   - `density="sparkline"` is a 32px plot with hairline bars and the label
 *     and value on one line: in the telemetry column the figure is a shape
 *     beside a number, not a chart with a legend. The full plot stays for
 *     Advanced resource diagnostics, which has the room.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export type ChartVariant = "area" | "line" | "bars";

const W = 300;
const H = 72;
const PAD = 4;

const scale = (points: readonly ChartPoint[]) => {
  const available = points.filter((point): point is number => typeof point === "number" && Number.isFinite(point));
  const max = Math.max(...available, 1);
  const min = Math.min(...available, 0);
  const span = max - min || 1;
  return (value: number) => H - PAD - ((value - min) / span) * (H - PAD * 2);
};

export type ChartPoint = number | null | undefined;

export interface ChartProps extends Omit<ComponentProps<"div">, "children"> {
  label: string;
  value: string;
  delta?: string | undefined;
  /** `null`/`undefined` is an unavailable sample. Lines and areas break rather than inventing zero or continuity. */
  points: readonly ChartPoint[];
  /** One label per available point for the accessible description, e.g. a turn number. */
  pointLabel?: ((value: number, index: number) => string) | undefined;
  /** Accessible wording for a missing point. */
  unavailableLabel?: ((index: number) => string) | undefined;
  variant?: ChartVariant | undefined;
  /** `sparkline` is the 32px form for a narrow column. */
  density?: "full" | "sparkline" | undefined;
}

export function Chart({ label, value, delta, points, pointLabel, unavailableLabel, variant = "area", density = "full", className, ...props }: ChartProps) {
  const dense = density === "sparkline";
  const y = scale(points);
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const segments: Array<Array<{ x: number; y: number }>> = [];
  for (const [index, point] of points.entries()) {
    if (typeof point !== "number" || !Number.isFinite(point)) continue;
    const previous = index > 0 ? points[index - 1] : undefined;
    if (segments.length === 0 || typeof previous !== "number" || !Number.isFinite(previous)) segments.push([]);
    segments.at(-1)!.push({ x: x(index), y: y(point) });
  }
  const latest = [...points.entries()].reverse().find(([, point]) => typeof point === "number" && Number.isFinite(point));
  const last = latest ? { x: x(latest[0]), y: y(latest[1] as number) } : undefined;
  const lastIndex = latest?.[0] ?? -1;
  const described = points
    .slice(-3)
    .map((point, offset) => {
      const index = Math.max(0, points.length - 3) + offset;
      return typeof point === "number" && Number.isFinite(point)
        ? (pointLabel ? pointLabel(point, index) : String(point))
        : (unavailableLabel?.(index) ?? `sample ${index + 1} unavailable`);
    })
    .join(", ");

  return (
    <div data-slot="chart" className={cn("flex w-full flex-col", dense ? "gap-1" : "gap-2", className)} {...props}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("min-w-0 truncate text-ink-2", dense ? "text-xs leading-xs" : "text-xs leading-5")}>{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="typed text-ink">{value}</span>
          {delta !== undefined && <span className={cn(mono, "text-ink-3")}>{delta}</span>}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}: ${value}. Latest: ${described}`}
        className={cn("w-full overflow-visible", dense ? "h-8" : "h-18")}
        preserveAspectRatio="none"
      >
        <line x1="0" x2={W} y1={H - PAD} y2={H - PAD} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {variant === "bars" ? (
          points.map((point, i) => {
            if (typeof point !== "number" || !Number.isFinite(point)) return null;
            const top = y(point);
            const barWidth = dense ? Math.max(1.5, Math.min(8, step * 0.5)) : Math.max(2, step * 0.55);
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
            {segments.map((segment, index) => {
              const line = segment.map((point) => `${point.x},${point.y}`).join(" ");
              const first = segment[0];
              const end = segment.at(-1);
              const area = first && end && segment.length > 1
                ? `M ${first.x},${H - PAD} ${segment.map((point) => `L ${point.x},${point.y}`).join(" ")} L ${end.x},${H - PAD} Z`
                : "";
              return (
                <g key={index} data-chart-segment>
                  {variant === "area" && area && <path d={area} className="fill-[color-mix(in_oklab,var(--live)_14%,transparent)]" />}
                  <polyline points={line} fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="stroke-live" />
                </g>
              );
            })}
            {last && <circle cx={last.x} cy={last.y} r="3" className="fill-live" />}
          </>
        )}
      </svg>
    </div>
  );
}
