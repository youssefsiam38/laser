"use client";
/** Installed elements-conversation-search: real transcript hits, token styling,
 * keyboard navigation and dismiss. The demo scrollbar was removed: its positions
 * cannot represent folded message geometry. The exact excerpt survives folding. */
import type { ComponentProps, Ref, ReactNode } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { paper } from "./surfaces.js";
import type { SearchSource } from "@/components/thread/search-state";

export interface SearchHit { id: string; messageId: string; before: string; match: string; after: string; occurrence: number; source?: SearchSource }

export function ConversationSearch({ query, hits, activeIndex, onQueryChange, onStep, onClose, inputRef, className, label = "Find in conversation", toolbar, status, ...props }: Omit<ComponentProps<"div">, "children"> & {
  query: string; hits: readonly SearchHit[]; activeIndex: number;
  onQueryChange: (query: string) => void; onStep: (delta: number) => void;
  onClose: () => void; inputRef?: Ref<HTMLInputElement>;
  label?: string; toolbar?: ReactNode; status?: string | undefined;
}) {
  const active = hits[activeIndex];
  return <div data-slot="conversation-search" role="search" aria-label={label} className={cn("z-20 shrink-0 px-3 py-2", className)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }} {...props}>
    <div className={cn(paper, "mx-auto flex max-w-(--measure-thread) flex-col overflow-hidden rounded-xl")}>
      {toolbar}
      <div className="flex min-w-0 items-center gap-1 px-2 py-1">
        <Search className="mx-1 size-4 shrink-0 text-ink-3" aria-hidden />
        <input ref={inputRef} value={query} onChange={e => onQueryChange(e.target.value)}
          aria-label={label} placeholder={label} maxLength={200}
          className="min-w-0 flex-1 bg-transparent py-1 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:underline [@media(pointer:coarse)]:text-base"
          onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); onStep(e.shiftKey ? -1 : 1); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }} />
        <span role="status" aria-live="polite" aria-atomic="true" className="shrink-0 px-1 text-xs tabular-nums text-ink-3">{status ?? (hits.length ? `${activeIndex + 1} / ${hits.length}` : query.trim() ? "No matches" : "0 / 0")}</span>
        <TooltipIconButton tooltip="Previous match" shortcut="Shift+Enter" disabled={!hits.length} onClick={() => onStep(-1)}><ChevronUp /></TooltipIconButton>
        <TooltipIconButton tooltip="Next match" shortcut="Enter" disabled={!hits.length} onClick={() => onStep(1)}><ChevronDown /></TooltipIconButton>
        <TooltipIconButton tooltip="Close search" shortcut="Esc" onClick={onClose}><X /></TooltipIconButton>
      </div>
      {active && <div className="border-t border-line bg-surface-2 px-3 py-2 text-xs leading-5 text-ink-2 [overflow-wrap:anywhere]">
        <p className="line-clamp-2">{active.before}<mark className="rounded-sm bg-attention/20 text-ink">{active.match}</mark>{active.after}</p>
      </div>}
    </div>
  </div>;
}
