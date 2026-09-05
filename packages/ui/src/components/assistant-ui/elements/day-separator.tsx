"use client";
/**
 * Day separator (`elements-day-separator`): a hairline with the day in the
 * middle, between two messages that fall on different days. Long transcripts
 * span days; the separator is how you find yesterday.
 *
 * Divergences from the registry copy: the registry renders a whole demo
 * transcript with per-message times; here the separator is the component and
 * the transcript decides where it goes (`dayChanged`). The label is `typed`,
 * 12px, and reads "Today" / "Yesterday" before it reads a date.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** True when `a` and `b` fall on different local calendar days. */
export function dayChanged(a: Date | undefined, b: Date | undefined): boolean {
  if (!a || !b) return false;
  return startOfDay(a) !== startOfDay(b);
}

/** "Today", "Yesterday", "Wed, Sep 3", or "Sep 3, 2025" once the year differs. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export interface DaySeparatorProps extends Omit<ComponentProps<"div">, "children"> {
  date: Date;
}

export function DaySeparator({ date, className, ...props }: DaySeparatorProps) {
  return (
    <div data-slot="day-separator" role="separator" aria-label={dayLabel(date)} className={cn("flex items-center gap-3 py-1", className)} {...props}>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      <time dateTime={date.toISOString()} title={date.toLocaleString()} className={cn(mono, "shrink-0 text-ink-3")}>
        {dayLabel(date)}
      </time>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}
