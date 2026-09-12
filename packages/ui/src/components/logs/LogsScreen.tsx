"use client";
/**
 * Logs (M4-T6) — the transparency screen.
 *
 * Everything the host recorded, in one ordered stream: provider round-trips
 * with their complete request payload, tool executions with arguments and
 * results, session lifecycle, subagent events, and worker stderr. Rows are
 * virtualized (a busy hour is tens of thousands of them), paged backwards on
 * demand, and appended live while Follow is on.
 *
 * The ceiling is stated, not hidden: Pi 0.85 gives an extension the full
 * provider REQUEST but only the status and headers of the response. There is
 * no raw-response hook, so the model's actual output is the transcript, which
 * is a parsed view of the same bytes. `ProviderCeilingNote` says exactly that
 * on every provider response row.
 *
 * This screen is the whole record with a query over it, which is strictly
 * more than a live tail — so a live tail of a log section is not a second
 * surface any more (docs/ux-fleet.md, "The two kinds of work").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartGantt, ChevronUp, Loader2, Pause, Play, Trash2 } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { TraceWaterfall } from "@/components/assistant-ui/elements/trace-waterfall";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { clockTime } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserView } from "@/runtime";
import type { LogEntry, LogLevel, LogSection, LogStats } from "@lasercode/protocol";

import { LogDetail } from "./LogDetail.js";
import { appendRows, LOG_LEVELS, LOG_SECTIONS, matchesFilters, rowMetric, SECTION_TONE, spansFromEntries, toQuery, type LogFilters } from "./model.js";

/** Rows kept in memory. Beyond this the oldest are dropped; paging refetches. */
const ROW_CAP = 5000;
const PAGE = 200;
const ROW_HEIGHT = 26;
/** Rows rendered outside the viewport, so a fast scroll does not show gaps. */
const OVERSCAN = 12;
/** Debounce for the toolbar's counts while following. */
const STATS_REFRESH_MS = 1500;
/** Typing pause before a search reaches the host. One query per keystroke is two RPCs. */
const SEARCH_DEBOUNCE_MS = 200;

export function LogsScreen({ cwd }: { cwd: string | undefined }) {
  const { client, actions } = useLaserStable();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats>();
  const [selected, setSelected] = useState<LogEntry>();
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string>();

  const [section, setSection] = useState<LogSection | "all">("all");
  /** What is in the box, and what has actually reached the host. */
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [levels, setLevels] = useState<LogLevel[] | null>(null);
  const [scoped, setScoped] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  /** Timing view: the loaded rows paired into spans on one axis. */
  const [timing, setTiming] = useState(false);

  // A query per keystroke is two round-trips per character against SQLite.
  useEffect(() => {
    if (searchInput === search) return undefined;
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const filters: LogFilters = useMemo(
    () => ({ section, search, levels, ...(scoped && cwd ? { cwd } : {}) }),
    [section, search, levels, scoped, cwd],
  );

  const refreshStats = useCallback(() => {
    client
      .request("pi/logs/stats", {})
      .then((result) => setStats(result.stats))
      .catch(() => {
        /* the counts are a nicety; the rows are the screen */
      });
  }, [client]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const page = await client.request("pi/logs/query", toQuery(filters, { limit: PAGE }));
      setEntries(page.entries);
      setHasOlder(page.hasMore);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [client, filters]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The counts describe the whole store, so they do not move with a search.
  useEffect(() => refreshStats(), [refreshStats]);

  // Live tail. Appended rows are unfiltered, so the same predicate the store
  // uses runs here; a row the current filter excludes is dropped. The counts in
  // the toolbar are refreshed on a lazy debounce so they do not go stale while
  // someone watches a long run — but one query per batch would be wasteful.
  useEffect(() => {
    if (!follow) return undefined;
    let statsTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.subscribe((method, params) => {
      if (method !== "pi/logs/append") return;
      const { entries: incoming } = params as { entries: LogEntry[] };
      if (!statsTimer) {
        statsTimer = setTimeout(() => {
          statsTimer = undefined;
          refreshStats();
        }, STATS_REFRESH_MS);
      }
      const kept = incoming.filter((entry) => matchesFilters(entry, filters));
      if (kept.length === 0) return;
      setEntries((current) => appendRows(current, kept, ROW_CAP));
    });
    return () => {
      if (statsTimer) clearTimeout(statsTimer);
      unsubscribe();
    };
  }, [client, follow, filters, refreshStats]);

  const loadOlder = useCallback(async () => {
    const oldest = entries[0]?.id;
    if (oldest === undefined || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await client.request("pi/logs/query", toQuery(filters, { limit: PAGE, beforeId: oldest }));
      setEntries((current) => [...page.entries, ...current].slice(0, ROW_CAP));
      setHasOlder(page.hasMore);
    } catch (pageError) {
      actions.toast("error", pageError instanceof Error ? pageError.message : String(pageError));
    } finally {
      setLoadingOlder(false);
    }
  }, [client, entries, filters, loadingOlder, actions]);

  const clear = useCallback(async () => {
    setConfirmClear(false);
    try {
      const { deleted } = await client.request("pi/logs/clear", section === "all" ? {} : { sections: [section] });
      actions.toast("info", `Deleted ${deleted} log row${deleted === 1 ? "" : "s"}.`);
      setSelected(undefined);
      refreshStats();
      await reload();
    } catch (clearError) {
      actions.toast("error", clearError instanceof Error ? clearError.message : String(clearError));
    }
  }, [client, section, actions, reload, refreshStats]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        section={section}
        onSection={setSection}
        search={searchInput}
        onSearch={setSearchInput}
        levels={levels}
        onLevels={setLevels}
        follow={follow}
        onFollow={setFollow}
        scoped={scoped}
        onScoped={setScoped}
        cwd={cwd}
        stats={stats}
        loading={loading}
        onClear={() => setConfirmClear(true)}
        timing={timing}
        onTiming={setTiming}
      />

      <ClearDialog
        open={confirmClear}
        section={section}
        stats={stats}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clear()}
      />

      {error && (
        <p className="m-3 rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-xs leading-5 text-danger">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {timing ? (
            <TimingView entries={entries} selectedId={selected?.id} onSelect={(id) => setSelected(entries.find((e) => e.id === id))} />
          ) : (
          <LogList
            entries={entries}
            selectedId={selected?.id}
            onSelect={setSelected}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={() => void loadOlder()}
            follow={follow}
            loading={loading}
            failed={error !== undefined}
          />
          )}
        </div>
        {/* `min-w-0` matters: the payload block is `whitespace-pre`, and without
            it the pane's intrinsic width is the longest line — which pushed the
            list to zero width the first time this ran in a browser. */}
        <aside
          aria-label="Log entry detail"
          className="min-h-0 min-w-0 shrink-0 basis-1/2 hairline-t lg:basis-[440px] lg:hairline-s xl:basis-[520px]"
        >
          <LogDetail entry={selected} />
        </aside>
      </div>
    </div>
  );
}

function Toolbar({
  section,
  onSection,
  search,
  onSearch,
  levels,
  onLevels,
  follow,
  onFollow,
  scoped,
  onScoped,
  cwd,
  stats,
  loading,
  onClear,
  timing,
  onTiming,
}: {
  section: LogSection | "all";
  onSection: (section: LogSection | "all") => void;
  search: string;
  onSearch: (value: string) => void;
  levels: LogLevel[] | null;
  onLevels: (levels: LogLevel[] | null) => void;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  scoped: boolean;
  onScoped: (scoped: boolean) => void;
  cwd: string | undefined;
  stats: LogStats | undefined;
  loading: boolean;
  onClear: () => void;
  timing: boolean;
  onTiming: (timing: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 px-3 py-2 hairline-b">
      <div className="flex flex-wrap items-center gap-1">
        {LOG_SECTIONS.map((entry) => (
          <Tooltip key={entry.id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSection(entry.id)}
                aria-current={section === entry.id ? "true" : undefined}
                className={cn("gap-1.5", section === entry.id && "bg-surface-2 text-ink")}
              >
                {entry.id !== "all" && (
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full"
                    style={{ background: SECTION_TONE[entry.id] }}
                  />
                )}
                {entry.label}
                {stats && entry.id !== "all" && stats.bySection[entry.id] > 0 && (
                  <span className="font-mono text-xs text-ink-3 tnum">{stats.bySection[entry.id]}</span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-72">
              {entry.hint}
            </TooltipContent>
          </Tooltip>
        ))}
        {loading && <GenerationLoader label="Loading log pages" layout="inline" />}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" aria-pressed={timing} className={cn("gap-1.5", timing && "bg-surface-2 text-ink")} onClick={() => onTiming(!timing)}>
              <ChartGantt />
              Timing
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-72">
            The loaded rows on one time axis: each provider request from send to response, each tool from start to end.
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search logs"
          value={search}
          placeholder="Search summaries, kinds and payload previews"
          onChange={(event) => onSearch(event.target.value)}
          className={cn(
            "h-8 min-w-56 flex-1 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink",
            "placeholder:text-ink-3 outline-none focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
          )}
        />
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {LOG_LEVELS.map((level) => {
            const on = levels === null || levels.includes(level);
            return (
              <button
                key={level}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const current = levels ?? LOG_LEVELS;
                  const next = on ? current.filter((l) => l !== level) : [...current, level];
                  onLevels(next.length === LOG_LEVELS.length || next.length === 0 ? null : next);
                }}
                className={cn(
                  "rounded-md px-1.5 py-1 font-mono text-xs outline-none transition-colors duration-(--motion-instant)",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
                  on ? "bg-surface text-ink" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {level}
              </button>
            );
          })}
        </div>
        {cwd && (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={scoped}
            className={cn(scoped && "bg-surface-2 text-ink")}
            onClick={() => onScoped(!scoped)}
          >
            This project only
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={follow}
          className={cn("gap-1.5", follow && "bg-surface-2 text-ink")}
          onClick={() => onFollow(!follow)}
        >
          {follow ? <Pause /> : <Play />} {follow ? "Following" : "Follow"}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="destructive-ghost" size="sm" className="gap-1.5" onClick={onClear}>
              <Trash2 /> Clear
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Deletes {section === "all" ? "every log row" : `the ${section} rows`} from the host's store. Sessions are
            untouched.
          </TooltipContent>
        </Tooltip>
      </div>

      {stats && <StatsLine stats={stats} />}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatsLine({ stats }: { stats: LogStats }) {
  return (
    <p className="font-mono text-xs leading-4 text-ink-3">
      {stats.total.toLocaleString()} rows · {formatSize(stats.bytes)} · keeps{" "}
      {stats.retention.maxRows.toLocaleString()} rows or {stats.retention.maxAgeDays} days, whichever comes first
      {stats.oldestAt ? ` · oldest ${new Date(stats.oldestAt).toLocaleString()}` : ""}
    </p>
  );
}

/**
 * Windowed list. Rows are one fixed line so the window is arithmetic rather
 * than measurement; the detail pane is where a row expands.
 */
function LogList({
  entries,
  selectedId,
  onSelect,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  follow,
  loading,
  failed,
}: {
  entries: LogEntry[];
  selectedId: number | undefined;
  onSelect: (entry: LogEntry) => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  follow: boolean;
  loading: boolean;
  /** The last query errored; the banner above says so, so say nothing here. */
  failed: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  /** True while the viewport is at the bottom, so following does not fight a scroll up. */
  const pinned = useRef(true);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !follow || !pinned.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries, follow]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(entries.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const window = entries.slice(start, end);

  // Nothing loaded because the query failed is not "nothing recorded"; the
  // banner above already says what went wrong.
  if (!loading && entries.length === 0) {
    if (failed) return <div className="min-h-0 flex-1" />;
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="max-w-100 text-center text-sm leading-6 text-ink-2">
          Nothing recorded yet under these filters. The host writes a row for every provider request and response,
          every tool execution, session lifecycle events and worker output — send a prompt and they will appear here.
        </p>
      </div>
    );
  }

  /**
   * One tab stop for the whole list, with the arrows moving the selection —
   * the listbox pattern. Tabbing through five thousand rows is not a keyboard
   * path, it is a punishment.
   */
  const move = (delta: number | "home" | "end") => {
    if (entries.length === 0) return;
    const current = entries.findIndex((entry) => entry.id === selectedId);
    const next =
      delta === "home"
        ? 0
        : delta === "end"
          ? entries.length - 1
          : Math.min(entries.length - 1, Math.max(0, (current < 0 ? (delta > 0 ? -1 : entries.length) : current) + delta));
    const entry = entries[next];
    if (!entry) return;
    onSelect(entry);
    const element = viewport.current;
    if (!element) return;
    const top = next * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  };

  return (
    <div
      ref={viewport}
      role="listbox"
      tabIndex={0}
      aria-label="Log rows"
      aria-activedescendant={selectedId === undefined ? undefined : `log-row-${selectedId}`}
      onKeyDown={(event) => {
        const key = event.key;
        if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
        event.preventDefault();
        move(key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : key === "Home" ? "home" : "end");
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        setScrollTop(element.scrollTop);
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
      )}
    >
      {hasOlder && (
        <div className="flex justify-center p-2">
          <Button variant="secondary" size="sm" disabled={loadingOlder} onClick={onLoadOlder} className="gap-1.5">
            {loadingOlder ? <Loader2 className="motion-safe:animate-busy" /> : <ChevronUp />} Load older
          </Button>
        </div>
      )}
      <div style={{ height: entries.length * ROW_HEIGHT }} className="relative">
        <ul
          role="list"
          className="absolute inset-x-0"
          style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}
        >
          {window.map((entry) => (
            <LogRow key={entry.id} entry={entry} selected={entry.id === selectedId} onSelect={onSelect} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function LogRow({
  entry,
  selected,
  onSelect,
}: {
  entry: LogEntry;
  selected: boolean;
  onSelect: (entry: LogEntry) => void;
}) {
  const metric = rowMetric(entry);
  return (
    <li style={{ height: ROW_HEIGHT }}>
      {/* An option inside the listbox above, not its own tab stop. */}
      <div
        id={`log-row-${entry.id}`}
        role="option"
        aria-selected={selected}
        onClick={() => onSelect(entry)}
        className={cn(
          "flex h-full w-full cursor-default items-center gap-2 px-3 text-start",
          "transition-colors duration-(--motion-instant)",
          selected ? "bg-surface-2" : "hover:bg-[color-mix(in_oklab,var(--surface-2)_55%,transparent)]",
        )}
      >
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: SECTION_TONE[entry.section] }}
        />
        <span className="w-16 shrink-0 font-mono text-xs whitespace-nowrap text-ink-3 tnum">
          {clockTime(entry.at)}
        </span>
        <span
          className={cn(
            "w-36 shrink-0 truncate font-mono text-xs",
            entry.level === "error" ? "text-danger" : entry.level === "warn" ? "text-attention" : "text-ink-3",
          )}
        >
          {entry.kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{entry.summary}</span>
        {entry.detailRef && (
          <Badge variant="outline" className="shrink-0">
            {(entry.detailRef.bytes / 1024).toFixed(0)} kB
          </Badge>
        )}
        {metric && (
          <span
            className={cn(
              "w-14 shrink-0 text-end font-mono text-xs tnum",
              entry.status !== undefined && entry.status >= 400 ? "text-danger" : "text-ink-3",
            )}
          >
            {metric}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Clearing the store is permanent and sits one click from Follow, in a toolbar
 * people use during live runs. It says what will go, and Cancel is the default.
 */
function ClearDialog({
  open,
  section,
  stats,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  section: LogSection | "all";
  stats: LogStats | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = stats === undefined ? undefined : section === "all" ? stats.total : (stats.bySection[section] ?? 0);
  const scope = section === "all" ? "every section" : `the ${section} section`;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clear the log store?</DialogTitle>
          <DialogDescription>
            {count === undefined ? `Every row in ${scope}` : `${count.toLocaleString()} row${count === 1 ? "" : "s"} in ${scope}`}{" "}
            will be deleted from the host&rsquo;s store. Sessions and transcripts are untouched, and this cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} className="gap-1.5">
            <Trash2 /> Delete rows
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The trace waterfall (docs/ux-elements.md "Observability") over the rows on
 * screen. Spans come from `spansFromEntries`; picking one selects its log row.
 */
function TimingView({ entries, selectedId, onSelect }: { entries: LogEntry[]; selectedId: number | undefined; onSelect: (id: number) => void }) {
  const { spans, totalMs } = useMemo(() => spansFromEntries(entries), [entries]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-3">
      <TraceWaterfall
        spans={spans}
        totalMs={totalMs}
        selectedId={selectedId === undefined ? undefined : String(selectedId)}
        onSelect={(id) => onSelect(Number(id))}
        title={`${spans.length} span${spans.length === 1 ? "" : "s"}`}
      />
    </div>
  );
}
