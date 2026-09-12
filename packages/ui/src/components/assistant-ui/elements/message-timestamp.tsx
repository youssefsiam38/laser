"use client";
/** Per-message local time. The compact clock stays visually quiet; its title
 * and accessible name carry the full local date so no separate day divider is
 * needed in the transcript. */
import { useAuiState } from "@assistant-ui/react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

const formatters = new Map<string, Intl.DateTimeFormat>();
const options = {
  clock: { hour: "numeric", minute: "2-digit" },
  day: { weekday: "short", month: "short", day: "numeric" },
  year: { year: "numeric", month: "short", day: "numeric" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

function formatter(kind: keyof typeof options, locales?: Intl.LocalesArgument): Intl.DateTimeFormat {
  const key = JSON.stringify([kind, locales === undefined ? null : Intl.getCanonicalLocales(locales)]);
  let value = formatters.get(key);
  if (!value) formatters.set(key, value = new Intl.DateTimeFormat(locales, options[kind]));
  return value;
}
// Default formatters resolve the browser locale/time zone at construction.
// Language changes invalidate them; OS time-zone changes require a reload.
if (typeof window !== "undefined") window.addEventListener("languagechange", () => formatters.clear());

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Today", "Yesterday", "Wed, Sep 3", or "Sep 3, 2025" once the year differs. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (date.getFullYear() === now.getFullYear()) return formatter("day").format(date);
  return formatter("year").format(date);
}

export function messageTimeLabel(date: Date, locales?: Intl.LocalesArgument): string {
  return formatter("clock", locales).format(date);
}

export function messageTimeDescription(date: Date, now: Date = new Date(), locales?: Intl.LocalesArgument): string {
  return `${dayLabel(date, now)} at ${messageTimeLabel(date, locales)}`;
}

export function MessageTimestamp({ className, ...props }: Omit<ComponentProps<"time">, "children" | "dateTime">) {
  const createdAt = useAuiState((state) => state.message.createdAt);
  if (!createdAt) return null;
  const label = messageTimeLabel(createdAt);
  const description = `${dayLabel(createdAt)} at ${label}`;
  return (
    <time
      data-slot="message-timestamp"
      dateTime={createdAt.toISOString()}
      title={description}
      aria-label={description}
      className={cn(mono, "shrink-0 text-ink-3 tnum", className)}
      {...props}
    >
      {label}
    </time>
  );
}
