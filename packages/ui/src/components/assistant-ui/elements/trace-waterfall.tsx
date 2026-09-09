"use client";
/**
 * Trace waterfall — provider request timing in the logs screen
 * (docs/ux-elements.md "Observability"). Installed from
 * `elements-trace-waterfall` and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - `visibleCount` (the demo's row-by-row reveal) is gone; the spans are
 *     the log rows on screen and they are drawn whole.
 *   - Rows are buttons: picking one selects its log row in the detail pane.
 *   - Durations use the app's `duration` formatter; the header carries the
 *     window the spans cover.
 *   - Colours read tokens: `--live` for a request in flight, `--ink-3` for
 *     a finished one, `--danger` for a failure.
 *   - No time-to-first-token span: Pi's `after_provider_response` hook gives a
 *     host the status and headers, not the stream, so TTFT is not measured
 *     and is not drawn (docs/ux-fleet.md R5, provenance honesty).
 */
import type { ComponentProps } from "react";

import { duration } from "@/format";
import { cn } from "@/lib/utils";

import { pct } from "../utils/range.js";
import { mono } from "./surfaces.js";

export type SpanStatus = "running" | "completed" | "failed";

export interface TraceSpan {
  id: string;
  name: string;
  depth: number;
  startMs: number;
  durationMs: number;
  status: SpanStatus;
  /** What the span belongs to, for the row's title. */
  detail?: string | undefined;
}

const TONE: Record<SpanStatus, string> = {
  running: "bg-live motion-safe:animate-attention",
  completed: "bg-ink-3",
  failed: "bg-danger",
};

export interface TraceWaterfallProps extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  spans: readonly TraceSpan[];
  totalMs: number;
  selectedId?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
  title?: string | undefined;
}

export function TraceWaterfall({ spans, totalMs, selectedId, onSelect, title = "Timing", className, ...props }: TraceWaterfallProps) {
  const span = totalMs || 1;
  return (
    <div data-slot="trace-waterfall" className={cn("flex w-full min-w-0 flex-col gap-2", className)} {...props}>
      <div className="flex items-baseline justify-between px-3">
        <span className="eyebrow">{title}</span>
        <span className={cn(mono, "text-ink-3")}>{duration(totalMs)}</span>
      </div>

      <div role="list" className="flex flex-col">
        {spans.map((item) => {
          const left = pct(item.startMs, span);
          const width = Math.max(1, pct(item.durationMs, span));
          const selected = item.id === selectedId;
          return (
            <button
              key={item.id}
              type="button"
              role="listitem"
              aria-current={selected || undefined}
              onClick={() => onSelect?.(item.id)}
              title={item.detail}
              className={cn(
                "grid h-7 grid-cols-[minmax(0,7.5rem)_1fr_3.5rem] items-center gap-2 px-3 text-start outline-none",
                "transition-colors duration-(--motion-instant)",
                selected ? "bg-surface-2" : "hover:bg-[color-mix(in_oklab,var(--surface-2)_55%,transparent)]",
                "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              )}
            >
              <span className="min-w-0 truncate typed text-ink-2" style={{ paddingInlineStart: `${item.depth * 0.75}rem` }}>
                {item.name}
              </span>
              <span
                role="img"
                aria-label={`${item.status}, starts at ${duration(item.startMs)}, runs ${duration(item.durationMs)}`}
                className="relative flex h-4 min-w-0 items-center"
              >
                <span className={cn("absolute h-1.5 rounded-full", TONE[item.status])} style={{ insetInlineStart: `${left}%`, width: `${width}%` }} />
              </span>
              <span className={cn(mono, "text-end text-ink-3")}>{duration(item.durationMs)}</span>
            </button>
          );
        })}
        {spans.length === 0 && <p className="px-3 py-4 text-sm text-ink-3">Nothing timed under these filters yet. Provider requests and tool executions land here as they finish.</p>}
      </div>
    </div>
  );
}
