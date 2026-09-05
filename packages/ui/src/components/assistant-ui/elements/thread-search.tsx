"use client";
/**
 * Thread search — session search across every project (docs/ux-elements.md
 * "Thread"). Installed from `elements-thread-search` and restyled to DESIGN.md
 * tokens. The sessions panel swaps its grouped list for this while a query
 * is typed; the input itself is the panel's, so the two share one box.
 *
 * Divergences from the registry copy:
 *   - No `pinned` section: piorbit has no pin. Sessions that need you sort
 *     first inside each project instead, the same order as the list.
 *   - Rows carry a status dot and a relative time, the same anatomy as a
 *     list row, so a search result and a list row are recognisably the same
 *     thing.
 *   - Matching covers title, project and preview; every term must match.
 */
import type { ComponentProps, KeyboardEvent } from "react";

import { StatusDot, type Status } from "@/components/status";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";

export interface SearchableThread {
  id: string;
  title: string;
  /** The project's name. */
  group: string;
  preview: string;
  status: Status;
  /** ISO time. */
  modifiedAt?: string | undefined;
  /** Typed face for the title (an id prefix). */
  untitled?: boolean | undefined;
}

export interface ThreadSearchProps extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  threads: readonly SearchableThread[];
  query: string;
  activeId: string | undefined;
  onActiveChange?: ((id: string) => void) | undefined;
  onSelect?: ((id: string) => void) | undefined;
}

export function matchesThread(thread: SearchableThread, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${thread.title} ${thread.group} ${thread.preview}`.toLowerCase();
  return needle.split(/\s+/).every((term) => hay.includes(term));
}

/** Keyboard handler for the owning input: arrows move, Enter opens. */
export function threadSearchKeys(
  ordered: readonly SearchableThread[],
  activeId: string | undefined,
  onActiveChange: ((id: string) => void) | undefined,
  onSelect: ((id: string) => void) | undefined,
) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || ordered.length === 0) return;
    const at = ordered.findIndex((t) => t.id === activeId);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
      const next = ordered[(from + delta + ordered.length) % ordered.length];
      if (next) onActiveChange?.(next.id);
    } else if (event.key === "Enter" && at !== -1) {
      event.preventDefault();
      onSelect?.(ordered[at]!.id);
    }
  };
}

export function ThreadSearch({ threads, query, activeId, onActiveChange, onSelect, className, ...props }: ThreadSearchProps) {
  const matches = threads.filter((thread) => matchesThread(thread, query));
  const groups = [...new Set(matches.map((t) => t.group))];

  return (
    <div data-slot="thread-search" role="listbox" aria-label="Matching sessions" className={cn("flex flex-col pb-2", className)} {...props}>
      {groups.map((group) => (
        <div key={group} role="group" aria-label={group} className="flex flex-col">
          <span aria-hidden="true" className="eyebrow sticky top-0 z-10 bg-surface px-3 pt-2 pb-1">
            {group}
          </span>
          {matches
            .filter((thread) => thread.group === group)
            .map((thread) => {
              const active = thread.id === activeId;
              return (
                <button
                  key={thread.id}
                  id={`thread-search-${thread.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseMove={() => !active && onActiveChange?.(thread.id)}
                  onClick={() => onSelect?.(thread.id)}
                  className={cn(
                    "grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-start outline-none",
                    "transition-colors duration-(--motion-instant)",
                    active ? "bg-surface-2" : "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)]",
                    "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                  )}
                >
                  <StatusDot status={thread.status} size="sm" />
                  <span className={cn("truncate leading-5", thread.untitled ? "typed text-ink-2" : "text-sm font-medium text-ink")} title={thread.title}>
                    {thread.title}
                  </span>
                  {thread.modifiedAt ? <span className="typed leading-5 text-ink-3">{relativeTime(thread.modifiedAt)}</span> : <span />}
                  <span aria-hidden="true" />
                  <span className="col-span-2 truncate text-xs leading-4 text-ink-2" title={thread.preview}>
                    {thread.preview}
                  </span>
                </button>
              );
            })}
        </div>
      ))}
      {matches.length === 0 && (
        <p className="px-3 py-4 text-center text-sm text-ink-3 break-words">No session matches “{query.trim()}”.</p>
      )}
    </div>
  );
}
