"use client";
/**
 * Timeline — "events on a time axis, with what already happened and what is
 * still coming" (docs/ux-elements.md "Structured output": the run timeline).
 * Installed from `elements-timeline`; the run body feeds it the moments a run
 * panel actually records — started, the current phase, ended with its reason.
 *
 * Divergences from the registry copy:
 *   - No `visibleCount`: that was the demo's reveal. Every event given is drawn.
 *   - No card chrome (`paper`, padding): it sits inside an island body that
 *     already is the card.
 *   - The "now" marker is the live colour and pulses under motion-safe, so a
 *     running phase reads as working (R1) rather than as a fixed blue.
 *   - Times are typed values at 12px, not 11px (R13).
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export type TimelineWhen = "past" | "now" | "future";

export interface TimelineEvent {
  id: string;
  when: TimelineWhen;
  /** Clock time, or empty when the moment has no timestamp yet. */
  time: string;
  title: string;
  detail?: string | undefined;
  /** `attention` is a "now" that is stuck — paused on someone — and pulses warm instead of live. */
  tone?: "danger" | "muted" | "attention" | undefined;
}

export function Timeline({ events, className, ...props }: Omit<ComponentProps<"ol">, "children"> & { events: readonly TimelineEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ol data-slot="timeline" className={cn("flex flex-col", className)} {...props}>
      {events.map((event, i) => {
        const last = i === events.length - 1;
        return (
          <li key={event.id} className="grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] gap-x-2">
            <time className={cn(mono, "pt-px text-end", event.when === "future" ? "text-ink-3" : "text-ink-2")}>{event.time}</time>

            <span className="flex flex-col items-center" aria-hidden="true">
              <span
                className={cn(
                  "mt-1 size-2 shrink-0 rounded-full",
                  event.when === "now" && (event.tone === "attention" ? "bg-attention ring-4 ring-attention/15 motion-safe:animate-attention" : "bg-live ring-4 ring-live/15 motion-safe:animate-attention"),
                  event.when === "past" && (event.tone === "danger" ? "bg-danger" : "bg-ink-3"),
                  event.when === "future" && "border border-line bg-transparent",
                )}
              />
              {!last && <span className={cn("w-px flex-1", event.when === "future" ? "bg-line/60" : "bg-line")} />}
            </span>

            <div className={cn("flex min-w-0 flex-col gap-0.5", !last && "pb-2.5")}>
              <span
                className={cn(
                  "truncate text-sm",
                  event.when === "future" ? "text-ink-3" : "text-ink",
                  event.when === "now" && "font-medium",
                  event.tone === "danger" && "text-danger",
                  event.tone === "attention" && "text-attention",
                )}
                title={event.title}
              >
                {event.title}
              </span>
              {event.detail && <span className="text-xs leading-xs break-words text-ink-2">{event.detail}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
