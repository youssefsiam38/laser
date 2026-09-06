"use client";
/** Per-message local time. The compact clock stays visually quiet; its title
 * and accessible name carry the full local date so no separate day divider is
 * needed in the transcript. */
import { useAuiState } from "@assistant-ui/react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Today", "Yesterday", "Wed, Sep 3", or "Sep 3, 2025" once the year differs. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function messageTimeLabel(date: Date, locales?: Intl.LocalesArgument): string {
  return date.toLocaleTimeString(locales, { hour: "numeric", minute: "2-digit" });
}

export function messageTimeDescription(date: Date, now: Date = new Date(), locales?: Intl.LocalesArgument): string {
  return `${dayLabel(date, now)} at ${messageTimeLabel(date, locales)}`;
}

export function MessageTimestamp({ className, ...props }: Omit<ComponentProps<"time">, "children" | "dateTime">) {
  const createdAt = useAuiState((state) => state.message.createdAt);
  if (!createdAt) return null;
  const description = messageTimeDescription(createdAt);
  return (
    <time
      data-slot="message-timestamp"
      dateTime={createdAt.toISOString()}
      title={description}
      aria-label={description}
      className={cn(mono, "shrink-0 text-ink-3 tnum", className)}
      {...props}
    >
      {messageTimeLabel(createdAt)}
    </time>
  );
}
