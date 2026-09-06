import { Clock3, LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { useSessionSearch } from "./use-session-search.js";

export function SessionSearchProgress({ search }: { search: ReturnType<typeof useSessionSearch> }) {
  return <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3 py-3 text-xs text-ink-3">
    <span role="status" className="flex items-center gap-2">
      {search.busy ? <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-sweep" /> : <Clock3 className="size-3.5 shrink-0" />}
      {search.busy ? "Searching saved conversations…" : search.error ? "Search interrupted" : search.cursor !== undefined ? "More conversations remain in this period" : search.period === 3 ? "All history searched" : search.period === 0 ? "Searched the last 30 days" : `Searched back to ${search.after ? new Date(search.after).toLocaleDateString() : "the beginning"}`}
    </span>
    {search.error ? <><p role="alert">Could not search history. Check the host connection and retry.</p><Button variant="outline" size="sm" onClick={search.retry}>Retry search</Button></> : null}
    {search.unreadable > 0 && <p>{search.unreadable} session files could not be read.</p>}
    {search.moreLabel && !search.error && <Button variant="outline" size="sm" disabled={search.busy} onClick={search.more} className="h-auto min-h-8 justify-start py-2 text-start whitespace-normal"><Search className="shrink-0" />{search.moreLabel}</Button>}
  </div>;
}
