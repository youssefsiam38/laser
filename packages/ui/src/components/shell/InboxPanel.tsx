import { memo, useCallback, useState } from "react";
import { ChevronRight, Inbox } from "lucide-react";

import { StatusDot } from "@/components/status";
import { STATUS_LABEL } from "@/components/status/status";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable, usePiorbitState } from "@/runtime";
import type { AppState } from "@/store";

import { inboxRows, type InboxRow } from "./model.js";

const sameRow = (a: InboxRow, b: InboxRow): boolean =>
  a.path === b.path &&
  a.status === b.status &&
  a.title === b.title &&
  a.project === b.project &&
  a.modifiedAt === b.modifiedAt &&
  a.sub.text === b.sub.text &&
  a.sub.tone === b.sub.tone;

const sameRows = (a: readonly InboxRow[], b: readonly InboxRow[]): boolean =>
  a.length === b.length && a.every((row, i) => sameRow(row, b[i]!));

/**
 * "Needs you" — every session across every project that is not idle, most
 * urgent first (waiting > error > finished-unread > working). It sits above the
 * project's own list because the whole point of running many projects at once
 * is that you stop watching any single one.
 *
 * Empty is the good state, so the section disappears entirely rather than
 * showing a cheerful empty box.
 */
export const InboxPanel = memo(function InboxPanel({ onOpen }: { onOpen(row: InboxRow): void }) {
  const rows = usePiorbitState(useCallback((s: AppState) => inboxRows(s.sessions, s.open), []), sameRows);
  const [collapsed, setCollapsed] = useState(false);
  if (rows.length === 0) return null;

  const waiting = rows.filter((row) => row.status === "waiting_for_input" || row.status === "error").length;

  return (
    <section aria-label="Needs you" className="hairline-b">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-start outline-none",
          "transition-colors duration-(--motion-instant) hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)]",
          "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
        )}
      >
        <Inbox className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        <span className="eyebrow flex-1">Needs you</span>
        {waiting > 0 ? (
          <Badge variant="attention" className="tnum">
            {waiting}
          </Badge>
        ) : (
          <span className="font-mono text-xs leading-4 text-ink-3 tnum">{rows.length}</span>
        )}
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant)", !collapsed && "rotate-90")}
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
                  "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)] active:bg-surface-2",
                  "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                )}
              >
                <StatusDot status={row.status} size="sm" className="self-center" />
                <span className="truncate text-sm leading-5 font-medium text-ink">{row.title}</span>
                <time
                  dateTime={row.modifiedAt}
                  className="font-mono text-xs leading-5 text-ink-3 tnum"
                >
                  {relativeTime(row.modifiedAt)}
                </time>
                <span aria-hidden="true" />
                <span className="col-span-2 flex min-w-0 items-baseline gap-1.5 leading-4">
                  <span className="shrink-0 font-mono text-xs text-ink-3">{row.project}</span>
                  <span
                    className={cn(
                      "min-w-0 truncate text-xs",
                      row.sub.tone === "attention" ? "font-medium text-attention" : "text-ink-2",
                    )}
                  >
                    {row.sub.text}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
