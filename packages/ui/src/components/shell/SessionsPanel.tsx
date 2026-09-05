import { PRODUCT_NAME } from "@lasercode/protocol";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { FileClock, FolderPlus, Moon, Plus, Settings, Sun, X } from "lucide-react";

import { ThreadList, ThreadListSearch } from "@/components/assistant-ui/elements/thread-list.aui";
import { matchesThread, ThreadSearch, threadSearchKeys, type SearchableThread } from "@/components/assistant-ui/elements/thread-search";
import { StatusRing } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useWorkbench } from "@/components/workbench";
import { shortCwd, shortcutLabel } from "@/format";
import { useTheme } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";
import type { AppState } from "@/store";

import { InboxPanel } from "@/components/assistant-ui/elements/background-inbox";
import type { InboxRow } from "./model.js";
import { groupsFor, sameGroups, sessionsList, useSessionsList } from "./session-groups.js";
import { errorText, useShell } from "./shell-context.js";

export interface SessionsPanelProps {
  /** `panel` = docked 288px column; `sheet` = inside a Sheet (tablet / mobile). */
  variant: "panel" | "sheet";
}

/** Re-render every 30s so relative times stay honest. */
function useClock(ms = 30_000): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }, [ms]);
}

/**
 * The sessions panel (D-20 §6): every project as a collapsible group in one
 * scrolling list, attention-sorted inside each group. The list itself is the
 * `thread-list` element bound to the runtime's thread list; the search box
 * swaps it for the `thread-search` element while a query is typed
 * (docs/ux-elements.md "AUI-connected" and "Thread"). The rail filters and
 * jumps to a group rather than replacing the list. This file owns the frame:
 * header, inbox, filter strip, empty and sheet footer.
 */
export function SessionsPanel({ variant }: SessionsPanelProps) {
  const { projects } = useLaserStable();
  // `useLaserState` caches by store state, so a selector that also closes
  // over `projects` (React state, not store state) would keep answering from a
  // stale project list until the next store change. Remounting on the list
  // key gives the hook a fresh cache the moment a project is added or removed.
  return <SessionsPanelBody key={projects.join("\n")} variant={variant} />;
}

function SessionsPanelBody({ variant }: SessionsPanelProps) {
  const { projects, currentProject, setCurrentProject, actions } = useLaserStable();
  const shell = useShell();
  const list = useSessionsList();
  useClock();

  const groups = useLaserState(
    useCallback((s: AppState) => groupsFor(projects, s), [projects]),
    sameGroups,
  );
  const connection = useLaserState((s) => s.connection);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>(undefined);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const needYou = groups.reduce((n, g) => n + g.needYou, 0);
  const filteredName = list.filter ? shortCwd(list.filter) : undefined;
  const searching = query.trim() !== "";

  const open = useCallback(
    (path: string, cwd: string) => {
      if (cwd !== currentProject) setCurrentProject(cwd);
      // Never a silent failure: a click that cannot open a session says why.
      void actions.openSession(path).catch((error: unknown) => actions.toast("error", errorText(error)));
      if (variant === "sheet") shell.setSessionsOpen(false);
    },
    [actions, currentProject, setCurrentProject, shell, variant],
  );

  const openFromInbox = useCallback((row: InboxRow) => open(row.path, row.cwd), [open]);

  const newSessionIn = useCallback(
    async (cwd: string) => {
      setCurrentProject(cwd);
      if (connection !== "open") {
        actions.toast("warning", "Not connected to the host yet.");
        return;
      }
      try {
        await actions.newSession(cwd);
        if (variant === "sheet") shell.setSessionsOpen(false);
      } catch (error) {
        actions.toast("error", errorText(error));
      }
    },
    [actions, connection, setCurrentProject, shell, variant],
  );

  // Search rows: every session (the rail's filter still applies), with the
  // project as the group and the list row's subtitle as the preview.
  const searchable = useMemo<SearchableThread[]>(
    () =>
      groups
        .filter((g) => !list.filter || g.cwd === list.filter)
        .flatMap((g) =>
          g.rows.map((row) => ({
            id: row.path,
            title: row.title,
            group: g.name,
            preview: row.sub.text,
            status: row.status,
            modifiedAt: row.summary.modifiedAt,
            untitled: row.untitled,
          })),
        ),
    [groups, list.filter],
  );
  const ordered = useMemo(() => searchable.filter((t) => matchesThread(t, query)), [searchable, query]);
  useEffect(() => {
    if (!searching) return;
    if (ordered.some((t) => t.id === activeId)) return;
    setActiveId(ordered[0]?.id);
  }, [ordered, activeId, searching]);
  const cwdOf = useCallback((path: string) => groups.find((g) => g.rows.some((r) => r.path === path))?.cwd, [groups]);
  const selectSearch = useCallback(
    (id: string) => {
      const cwd = cwdOf(id);
      if (cwd) open(id, cwd);
      setQuery("");
    },
    [cwdOf, open],
  );

  return (
    <section
      aria-label="Sessions"
      className={cn("flex h-full min-h-0 flex-col bg-surface", variant === "panel" && "w-72 shrink-0 hairline-r")}
    >
      {/* 48px, one row: the sessions hairline has to land on the same y as the
          top bar's and the telemetry header's (DESIGN.md "Layout"). */}
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-3 hairline-b", variant === "sheet" && "pe-12")}>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="truncate text-sm leading-5 font-semibold text-ink">Sessions</h2>
          {total > 0 && <span className="shrink-0 typed text-ink-3">{total}</span>}
        </div>
        {needYou > 0 && (
          <Badge variant="attention" className="tnum">
            {needYou} need{needYou === 1 ? "s" : ""} you
          </Badge>
        )}
        {variant === "panel" && (
          <TooltipIconButton
            tooltip={currentProject ? `New session in ${shortCwd(currentProject)}` : "New session"}
            shortcut={shortcutLabel("N")}
            onClick={() => void shell.newSession()}
            disabled={!shell.canCreate}
          >
            <Plus />
          </TooltipIconButton>
        )}
      </header>

      {variant === "sheet" && (
        <div className="flex shrink-0 items-center px-3 py-2 hairline-b">
          <Button size="sm" variant="outline" className="w-full justify-start" onClick={() => void shell.newSession()} disabled={!shell.canCreate}>
            <Plus />
            <span className="truncate">New session{currentProject ? ` in ${shortCwd(currentProject)}` : ""}</span>
            <Kbd className="ms-auto">{shortcutLabel("N")}</Kbd>
          </Button>
        </div>
      )}

      {total > 0 && (
        <div className="shrink-0 px-3 py-2 hairline-b">
          <ThreadListSearch
            value={query}
            onValueChange={setQuery}
            onKeyDown={threadSearchKeys(ordered, activeId, setActiveId, selectSearch)}
            role="combobox"
            aria-expanded={searching}
            aria-controls="sessions-search-results"
            aria-activedescendant={searching && activeId ? `thread-search-${activeId}` : undefined}
          />
        </div>
      )}

      {filteredName !== undefined && (
        <div className="flex h-8 shrink-0 items-center gap-2 px-3 hairline-b" role="status">
          <span className="eyebrow shrink-0">Showing</span>
          <span className="min-w-0 truncate text-xs leading-4 font-medium text-ink" title={list.filter}>
            {filteredName}
          </span>
          <Button variant="ghost" size="xs" className="-me-2 ms-auto shrink-0" onClick={() => sessionsList.clearFilter(list.filter)}>
            <X />
            Show all
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          <ThreadSearch id="sessions-search-results" threads={searchable} query={query} activeId={activeId} onActiveChange={setActiveId} onSelect={selectSearch} />
        ) : (
          <>
            <InboxPanel onOpen={openFromInbox} />
            {groups.length === 0 ? (
              <EmptyState
                title="No project yet"
                body={`Point ${PRODUCT_NAME} at a directory. Sessions already saved there show up too.`}
                action={
                  <Button size="sm" variant="outline" onClick={() => shell.setAddProjectOpen(true)}>
                    <FolderPlus />
                    Add project
                  </Button>
                }
              />
            ) : (
              <ThreadList
                projects={projects}
                canCreate={connection === "open"}
                onNewSession={(cwd) => void newSessionIn(cwd)}
                onOpen={variant === "sheet" ? () => shell.setSessionsOpen(false) : undefined}
              />
            )}
          </>
        )}
      </div>

      {variant === "sheet" && shell.layout === "mobile" && <SheetFooter />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sheet footer (mobile only: what the rail would have offered)
// ---------------------------------------------------------------------------

function SheetFooter() {
  const { theme, toggle } = useTheme();
  const shell = useShell();
  const workbench = useWorkbench();
  const openWorkbench = (page: "settings" | "logs") => {
    workbench.open(page);
    shell.setSessionsOpen(false);
  };
  return (
    <footer className="flex shrink-0 items-center gap-1 px-2 py-2 hairline-t">
      <TooltipIconButton tooltip={theme === "dark" ? "Light theme" : "Dark theme"} side="top" onClick={toggle}>
        {theme === "dark" ? <Sun /> : <Moon />}
      </TooltipIconButton>
      <TooltipIconButton tooltip="Add project" side="top" onClick={() => shell.setAddProjectOpen(true)}>
        <FolderPlus />
      </TooltipIconButton>
      {/* There is no rail on mobile, so settings and logs are reachable here. */}
      <TooltipIconButton tooltip="Logs" side="top" onClick={() => openWorkbench("logs")}>
        <FileClock />
      </TooltipIconButton>
      <TooltipIconButton tooltip="Settings" side="top" onClick={() => openWorkbench("settings")}>
        <Settings />
      </TooltipIconButton>
      <span className="ms-auto pe-1 typed text-ink-3">{PRODUCT_NAME}</span>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

function EmptyState({ title, body, action }: { title: string; body: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-4 px-6 py-8 text-center">
      <StatusRing status="idle" size={40} thickness={2} aria-hidden="true">
        <Plus className="size-4 text-ink-3" />
      </StatusRing>
      <div className="max-w-56">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-xs leading-4 text-ink-2">{body}</p>
      </div>
      {action}
    </div>
  );
}
