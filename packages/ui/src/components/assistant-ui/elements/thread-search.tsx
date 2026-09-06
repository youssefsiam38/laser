"use client";
/**
 * Thread search — session search across every project (docs/ux-elements.md
 * "Thread"). Installed from `elements-thread-search` and restyled to DESIGN.md
 * tokens. The sessions panel swaps its grouped list for this while a query
 * is typed; the input itself is the panel's, so the two share one box.
 *
 * Divergences from the registry copy:
 *   - Each session appears once; grouped navigation or flat relevance order.
 *   - Highlighted excerpts stay inside each row, never overlay other results.
 *   - Literal phrase matches rank user messages, replies, then activity;
 *     timestamps break ties within each relevance tier.
 */
import { useEffect, type ComponentProps, type KeyboardEvent } from "react";

import { FolderOpen } from "lucide-react";
import type { Status } from "@/components/status";
import { SessionActivity } from "@/components/shell/SessionActivity";
import { dateTime } from "@/format";
import { cn } from "@/lib/utils";
import { SearchHighlight } from "@/components/thread/SearchHighlight";

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
  matchCount?: number | undefined;
  excerpt?: string | undefined;
  matchSource?: "user" | "assistant" | "reasoning" | "tool" | undefined;
}

export interface ThreadSearchProps extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  threads: readonly SearchableThread[];
  query: string;
  activeId: string | undefined;
  onActiveChange?: ((id: string) => void) | undefined;
  onSelect?: ((id: string) => void) | undefined;
  grouped?: boolean;
  loading?: boolean;
}

export function matchesThread(thread: SearchableThread, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${thread.title} ${thread.group} ${thread.preview}`.toLowerCase();
  return Boolean(thread.matchCount) || hay.includes(needle);
}

export function rankSearchThreads(a: SearchableThread, b: SearchableThread): number {
  const rank = (t: SearchableThread) => t.matchSource === "user" ? 0 : t.matchSource === "assistant" ? 1 : t.matchSource ? 2 : 3;
  return rank(a) - rank(b) || (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "");
}
const sourceLabels = { user: "Your message", assistant: "Assistant reply", reasoning: "Reasoning", tool: "Tool activity" };

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

export function ThreadSearch({ threads, query, activeId, onActiveChange, onSelect, grouped = true, loading = false, className, ...props }: ThreadSearchProps) {
  const matches = threads.filter((thread) => matchesThread(thread, query));
  const groups = grouped ? [...new Set(matches.map((t) => t.group))] : ["Results"];
  const prefix = props.id ?? "thread-search";
  useEffect(() => {
    if (activeId) document.getElementById(`${prefix}-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, prefix]);

  return (
    <div data-slot="thread-search" role="listbox" aria-label="Matching sessions" className={cn("flex flex-col gap-3 px-2 pt-1 pb-3", className)} {...props}>
      {groups.map((group) => (
        <div key={group} role="group" aria-label={group} className="flex flex-col">
          {grouped && <span aria-hidden="true" className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-surface px-2 text-sm text-ink-3">
            <FolderOpen className="size-3.5 shrink-0" /> <span className="truncate">{group}</span>
          </span>}
          {matches
            .filter((thread) => !grouped || thread.group === group)
            .map((thread) => {
              const active = thread.id === activeId;
              return (
                <button
                  key={thread.id}
                  id={`${prefix}-${thread.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  title={[thread.title, thread.group, thread.preview, thread.modifiedAt ? dateTime(thread.modifiedAt) : ""].filter(Boolean).join("\n")}
                  onMouseMove={() => !active && onActiveChange?.(thread.id)}
                  onClick={() => onSelect?.(thread.id)}
                  className={cn(
                    "flex min-h-8 min-w-0 w-full cursor-pointer flex-col items-stretch gap-1 rounded-lg px-3 py-2 text-start outline-none [@media(pointer:coarse)]:min-h-11",
                    "transition-colors duration-(--motion-instant)",
                    active ? "bg-surface-2" : "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)]",
                    "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn("min-w-0 flex-1 truncate text-sm leading-5", thread.untitled ? "text-ink-3" : active ? "text-ink" : "text-ink-2")} title={thread.title}>
                      <SearchHighlight text={thread.title} query={query} />
                    </span>
                    {thread.matchCount ? <span className="shrink-0 text-xs tabular-nums text-ink-3">{thread.matchCount} {thread.matchCount === 1 ? "hit" : "hits"}</span> : null}
                    <SessionActivity status={thread.status} />
                  </span>
                  {!grouped && <span className="flex min-w-0 gap-2 text-xs text-ink-3"><FolderOpen className="size-3.5 shrink-0" /><span className="truncate">{thread.group}</span>{thread.modifiedAt && <span className="ms-auto shrink-0">{new Date(thread.modifiedAt).toLocaleDateString()}</span>}</span>}
                  {thread.excerpt && <span data-slot="session-search-excerpt" className="ms-2 block min-w-0 rounded-lg rounded-ss-sm border-s-2 border-line bg-surface-2 px-3 py-2 text-xs leading-5 text-ink-2 [overflow-wrap:anywhere]">
                    {thread.matchSource && <span className="mb-1 block font-medium text-ink-3">{sourceLabels[thread.matchSource]}</span>}
                    <span className="line-clamp-3"><SearchHighlight text={thread.excerpt} query={query} /></span>
                  </span>}
                </button>
              );
            })}
        </div>
      ))}
      {matches.length === 0 && !loading && (
        <p className="px-3 py-4 text-center text-sm text-ink-3 break-words">No session matches “{query.trim()}”.</p>
      )}
    </div>
  );
}
