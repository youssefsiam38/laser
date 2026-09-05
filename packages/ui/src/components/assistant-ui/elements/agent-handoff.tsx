"use client";
/**
 * Handoff — "control passing between agents, with the reason and what came
 * along" (docs/ux-elements.md "Agents": a parent spawning a child, inline in
 * the transcript). Installed from `elements-agent-handoff`; a `run` panel that
 * names a `parent` feeds it, so the same strip appears in the run's inline
 * card and in its island.
 *
 * Divergences from the registry copy:
 *   - `reason` is optional: the payload carries the relation ("spawned by",
 *     "step of") and the child's own `activity`; nothing is invented.
 *   - `carried` is what the parent asked for — the requested model and
 *     thinking level — because that is the only thing the payload says came
 *     along (R12a).
 *   - Colours are the live token and the inks; the fixed `max-w-sm` is gone.
 */
import { ArrowRight, Bot } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { field, mono } from "./surfaces.js";

export function AgentHandoff({
  from,
  to,
  relation,
  reason,
  carried = [],
  settled,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  from: string;
  to: string;
  /** "spawned by" · "step of" — the payload's word for the edge. */
  relation: string;
  reason?: string | undefined;
  carried?: readonly string[];
  /** The child has finished: the edge is history, not a live handoff. */
  settled: boolean;
}) {
  return (
    <div data-slot="agent-handoff" className={cn("flex min-w-0 flex-col gap-1.5", className)} aria-label={`${to} ${relation} ${from}`} {...props}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(field, "flex min-w-0 max-w-[45%] items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-xs text-ink-2", settled && "opacity-70")}
          title={from}
        >
          <Bot className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{from}</span>
        </span>
        <span className="flex shrink-0 flex-col items-center" aria-hidden="true">
          <ArrowRight className={cn("size-3.5", settled ? "text-ink-3" : "text-live")} />
        </span>
        <span
          className={cn(
            "flex min-w-0 max-w-[45%] items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-xs",
            settled ? cn(field, "text-ink") : "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live",
          )}
          title={to}
        >
          <Bot className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{to}</span>
        </span>
        <span className="eyebrow ms-auto shrink-0">{relation}</span>
      </div>
      {reason && <p className="line-clamp-2 text-xs leading-xs text-ink-2">{reason}</p>}
      {carried.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className={cn(mono, "text-ink-3")}>asked for</span>
          {carried.map((item) => (
            <span key={item} className="truncate border-s border-line ps-2.5 text-xs leading-xs text-ink-2" title={item}>
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
