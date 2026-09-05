"use client";
/**
 * Background runs — THE attention inbox (M2-T2; docs/ux-elements.md "Agents":
 * "this is exactly the background-inbox element"). Installed from
 * `elements-background-inbox`. "Needs you": every session across every
 * project that is not idle, most urgent first (waiting > error >
 * finished-unread > working). It sits above the project's own list because
 * the whole point of running many projects at once is that you stop watching
 * any single one. Empty is the good state, so the section disappears rather
 * than showing a cheerful empty box.
 *
 * Divergences from the registry copy:
 *   - `state` is the five-word status vocabulary drawn by `StatusDot` (R1),
 *     not running / ready / failed with a spinner and a check.
 *   - Rows are never disabled: a working session is one you can open too.
 *   - The header collapses the list, and its count is the number that needs
 *     you (waiting or errored) in the attention colour, else the row count.
 *   - Rows carry the project name and the session's own subtitle ("waiting for
 *     you", the last tool), because a row read out of project context must
 *     still make sense.
 *   - `BackgroundInbox` is the props-driven element; `InboxPanel` is the
 *     connected wrapper the sessions panel mounts.
 */
import { ChevronRight, Inbox } from "lucide-react";
import { memo, useCallback, useState, type ComponentProps } from "react";

import { inboxRows, type InboxRow } from "@/components/shell/model";
import { StatusDot } from "@/components/status";
import { STATUS_LABEL } from "@/components/status/status";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitState } from "@/runtime";
import type { AppState } from "@/store";

import { mono } from "./surfaces.js";

const HOVER = "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)]";

export function BackgroundInbox({
  rows,
  onOpen,
  collapsed,
  onToggle,
  className,
  ...props
}: Omit<ComponentProps<"section">, "children" | "onToggle"> & {
  rows: readonly InboxRow[];
  onOpen(row: InboxRow): void;
  collapsed: boolean;
  onToggle(): void;
}) {
  if (rows.length === 0) return null;
  const needsYou = rows.filter((row) => row.status === "waiting_for_input" || row.status === "error").length;
  return (
    <section data-slot="background-inbox" aria-label="Needs you" className={cn("hairline-b", className)} {...props}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-start outline-none",
          "transition-colors duration-(--motion-instant)",
          HOVER,
          "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
        )}
      >
        <Inbox className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        <span className="eyebrow flex-1">Needs you</span>
        {needsYou > 0 ? (
          <Badge variant="attention" className="tnum">
            {needsYou}
          </Badge>
        ) : (
          <span className={cn(mono, "text-ink-3")}>{rows.length}</span>
        )}
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) motion-reduce:transition-none", !collapsed && "rotate-90")}
          aria-hidden="true"
        />
      </button>

      {!collapsed && (
        <ul role="list" className="pb-1">
          {rows.map((row) => (
            <li key={row.path}>
              <button
                type="button"
                onClick={() => onOpen(row)}
                title={`${row.path}\n${STATUS_LABEL[row.status]}`}
                className={cn(
                  "grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-1.5 text-start",
                  "transition-colors duration-(--motion-instant) outline-none",
                  HOVER,
                  "active:bg-surface-2",
                  "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                )}
              >
                <StatusDot status={row.status} size="sm" className="self-center" />
                <span className="truncate text-sm leading-sm font-medium text-ink">{row.title}</span>
                <time dateTime={row.modifiedAt} className={cn(mono, "leading-sm text-ink-3")}>
                  {relativeTime(row.modifiedAt)}
                </time>
                <span aria-hidden="true" />
                <span className="col-span-2 flex min-w-0 items-baseline gap-1.5 leading-xs">
                  <span className={cn(mono, "shrink-0 text-ink-3")}>{row.project}</span>
                  <span className={cn("min-w-0 truncate text-xs", row.sub.tone === "attention" ? "font-medium text-attention" : "text-ink-2")}>{row.sub.text}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const sameRow = (a: InboxRow, b: InboxRow): boolean =>
  a.path === b.path &&
  a.status === b.status &&
  a.title === b.title &&
  a.project === b.project &&
  a.modifiedAt === b.modifiedAt &&
  a.sub.text === b.sub.text &&
  a.sub.tone === b.sub.tone;

const sameRows = (a: readonly InboxRow[], b: readonly InboxRow[]): boolean => a.length === b.length && a.every((row, i) => sameRow(row, b[i]!));

/** The inbox, fed from the app store: every summary plus the live views, derived client-side. */
export const InboxPanel = memo(function InboxPanel({ onOpen }: { onOpen(row: InboxRow): void }) {
  const rows = usePiorbitState(useCallback((s: AppState) => inboxRows(s.sessions, s.open), []), sameRows);
  const [collapsed, setCollapsed] = useState(false);
  return <BackgroundInbox rows={rows} onOpen={onOpen} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />;
});
