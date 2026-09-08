import { PRODUCT_NAME } from "@lasercode/protocol";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { FileClock, FolderPlus, MessageSquarePlus, Moon, Plus, Search, Settings, Sun, X } from "lucide-react";

// Agents page (M13-T5): the phone's way in, from the sessions sheet footer.
import { AgentsButton } from "@/components/agents/page/AgentsButton";
import { ThreadList, ThreadListSearch } from "@/components/assistant-ui/elements/thread-list.aui";
// Beam: its one entry point, in the sheet footer on a phone (docs/agents.md "Beam").
import { BeamSpark } from "@/components/beam/BeamSpark";
import { matchesThread, rankSearchThreads, ThreadSearch, threadSearchKeys, type SearchableThread } from "@/components/assistant-ui/elements/thread-search";
import { StatusRing } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useWorkbench } from "@/components/workbench";
import { shortCwd, shortcutLabel } from "@/format";
import { useTheme } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";
import type { AppState } from "@/store";

import { SESSIONS_TABS, groupsFor, sameGroups, sessionsList, useSessionsList, workspacesOf, type SessionsTab } from "./session-groups.js";
import { errorText, useShell } from "./shell-context.js";
import { useSessionSearch } from "./use-session-search.js";
import { SessionSearchProgress } from "./SessionSearchProgress.js";
import { openGlobalSearch } from "./GlobalSearch.js";
import { openConversationFind } from "@/components/thread/search-state";

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
 * scrolling list, newest first inside each group. The list itself is the
 * `thread-list` element bound to the runtime's thread list; the search box
 * swaps it for the `thread-search` element while a query is typed
 * (docs/ux-elements.md "AUI-connected" and "Thread"). The rail filters and
 * jumps to a group rather than replacing the list. This file owns the frame:
 * header, tabs, filter strip, empty and sheet footer. Attention stays on the
 * chat row.
 *
 * Two tabs since the agents leap (docs/agents.md §7): **Chat**, the
 * projectless conversations of the built-in Chat agent, and **Code**, the
 * projects. The choice persists per browser; search searches the tab it is on.
 */
export function SessionsPanel({ variant }: SessionsPanelProps) {
  const { projects } = useLaserStable();
  // `useLaserState` caches by store state, so a selector that also closes
  // over `projects` (React state, not store state) would keep answering from a
  // stale project list until the next store change. Remounting on the list
  // key gives the hook a fresh cache the moment a project is added or removed.
  return <SessionsPanelBody key={projects.join("\n")} variant={variant} />;
}

const TAB_LABEL: Record<SessionsTab, string> = { chat: "Chat", code: "Code" };

function SessionsPanelBody({ variant }: SessionsPanelProps) {
  const { projects, currentProject, setCurrentProject, actions } = useLaserStable();
  const shell = useShell();
  const list = useSessionsList();
  const tab = list.tab;
  useClock();

  const groups = useLaserState(
    useCallback((s: AppState) => groupsFor(projects, s, tab), [projects, tab]),
    sameGroups,
  );
  const connection = useLaserState((s) => s.connection);
  const chatCwd = useLaserState((s) => workspacesOf(s).chat);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const search = useSessionSearch(query, tab === "code" ? list.filter : chatCwd);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const filteredName = tab === "code" && list.filter ? shortCwd(list.filter) : undefined;
  const searching = query.trim() !== "";
  const chat = tab === "chat";

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

  // A chat is a conversation that is not about a project: it runs the
  // built-in Chat agent in its own workspace, never in the current project.
  const canChat = connection === "open" && chatCwd !== undefined;
  const newChat = useCallback(async () => {
    if (connection !== "open") {
      actions.toast("warning", "Not connected to the host yet.");
      return;
    }
    if (chatCwd === undefined) {
      actions.toast("warning", "Chat is not ready yet. Try again in a moment.");
      return;
    }
    try {
      await actions.newSession(chatCwd, { agentName: "chat" });
      if (variant === "sheet") shell.setSessionsOpen(false);
    } catch (error) {
      actions.toast("error", errorText(error));
    }
  }, [actions, chatCwd, connection, shell, variant]);

  // Search rows: every session of the tab (the rail's filter still applies),
  // with the project as the group and the list row's subtitle as the preview.
  const searchable = useMemo<SearchableThread[]>(
    () =>
      groups
        .filter((g) => chat || !list.filter || g.cwd === list.filter)
        .flatMap((g) =>
          g.rows.map((row) => ({
            id: row.path,
            title: row.title,
            group: g.name,
            preview: row.sub.text,
            status: row.status,
            modifiedAt: row.summary.modifiedAt,
            untitled: row.untitled,
            matchCount: search.hits.find(h => h.path === row.path)?.count,
            excerpt: search.hits.find(h => h.path === row.path)?.excerpt,
            matchSource: search.hits.find(h => h.path === row.path)?.source,
          })),
        ).filter(row => !search.after || !row.modifiedAt || row.modifiedAt >= search.after).sort(rankSearchThreads),
    [groups, chat, list.filter, search.hits, search.after],
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
      if (cwd) {
        if (!chat) setCurrentProject(cwd);
        void actions.openSession(id).then(() => {
          if (variant === "sheet") shell.setSessionsOpen(false);
          requestAnimationFrame(() => requestAnimationFrame(() => openConversationFind(query, searchable.find(row => row.id === id)?.matchSource)));
        }).catch(error => actions.toast("error", errorText(error)));
      }
      setQuery("");
    },
    [cwdOf, chat, actions, setCurrentProject, variant, shell, query, searchable],
  );

  const newLabel = chat ? "New chat" : `New session${currentProject ? ` in ${shortCwd(currentProject)}` : ""}`;
  const onNew = chat ? () => void newChat() : () => void shell.newSession();
  const canNew = chat ? canChat : shell.canCreate;

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
        <TooltipIconButton tooltip="Search all sessions" shortcut="Ctrl+Shift+F" onClick={() => { if (variant === "sheet") shell.setSessionsOpen(false); openGlobalSearch(); }}><Search /></TooltipIconButton>
        {variant === "panel" && (
          <TooltipIconButton
            tooltip={newLabel}
            {...(chat ? {} : { shortcut: shortcutLabel("N") })}
            onClick={onNew}
            disabled={!canNew}
            data-slot={chat ? "new-chat" : "new-session"}
          >
            {chat ? <MessageSquarePlus /> : <Plus />}
          </TooltipIconButton>
        )}
      </header>

      <SessionsTabs tab={tab} onChange={(next) => { sessionsList.setTab(next); setQuery(""); }} />

      {variant === "sheet" && (
        <div className="flex shrink-0 items-center px-3 py-2 hairline-b">
          <Button size="sm" variant="outline" className="w-full justify-start" onClick={onNew} disabled={!canNew} data-slot={chat ? "new-chat" : "new-session"}>
            {chat ? <MessageSquarePlus /> : <Plus />}
            <span className="truncate">{newLabel}</span>
            {!chat && <Kbd className="ms-auto">{shortcutLabel("N")}</Kbd>}
          </Button>
        </div>
      )}

      {total > 0 && (
        <div className="shrink-0 px-3 py-2">
          <ThreadListSearch
            value={query}
            maxLength={200}
            onValueChange={setQuery}
            onKeyDown={threadSearchKeys(ordered, activeId, setActiveId, selectSearch)}
            role="combobox"
            aria-expanded={searching}
            aria-controls="sessions-search-results"
            aria-activedescendant={searching && activeId ? `sessions-search-results-${activeId}` : undefined}
            placeholder={chat ? "Search chats" : "Search sessions"}
            aria-label={chat ? "Search chats" : "Search sessions"}
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

      <div id="sessions-tabpanel" role="tabpanel" aria-labelledby={`sessions-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          <ThreadSearch id="sessions-search-results" grouped={false} loading={search.busy} threads={searchable} query={query} activeId={activeId} onActiveChange={setActiveId} onSelect={selectSearch} />
        ) : chat ? (
          groups.length === 0 ? (
            <EmptyState
              icon={<MessageSquarePlus className="size-4 text-ink-3" />}
              title="No chats yet"
              body="Chats are conversations that are not about a project. Ask anything; nothing here touches your code."
              action={
                <Button size="sm" variant="outline" onClick={() => void newChat()} disabled={!canChat} data-slot="new-chat">
                  <MessageSquarePlus />
                  New chat
                </Button>
              }
            />
          ) : (
            <ThreadList projects={projects} tab="chat" onOpen={variant === "sheet" ? () => shell.setSessionsOpen(false) : undefined} />
          )
        ) : (
          <>
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
                tab="code"
                canCreate={connection === "open"}
                onNewSession={(cwd) => void newSessionIn(cwd)}
                onOpen={variant === "sheet" ? () => shell.setSessionsOpen(false) : undefined}
              />
            )}
          </>
        )}
      </div>

      {searching && <SessionSearchProgress search={search} />}

      {variant === "sheet" && shell.layout === "mobile" && <SheetFooter />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tabs: Chat | Code
// ---------------------------------------------------------------------------

/**
 * A two-segment control, a real tablist: arrows move between the segments,
 * the active one is `aria-selected`, and the panel below is what it controls.
 */
function SessionsTabs({ tab, onChange }: { tab: SessionsTab; onChange(tab: SessionsTab): void }) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = SESSIONS_TABS.indexOf(tab);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? SESSIONS_TABS.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : SESSIONS_TABS.length - 1)) % SESSIONS_TABS.length;
    const target = SESSIONS_TABS[next]!;
    onChange(target);
    (event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${target}"]`))?.focus();
  };
  return (
    <div className="shrink-0 px-3 pt-2 pb-1">
      <div
        role="tablist"
        aria-label="Kind of session"
        data-slot="sessions-tabs"
        onKeyDown={onKeyDown}
        className="grid grid-cols-2 gap-0.5 rounded-lg bg-surface-2 p-0.5"
      >
        {SESSIONS_TABS.map((kind) => {
          const selected = kind === tab;
          return (
            <button
              key={kind}
              type="button"
              role="tab"
              id={`sessions-tab-${kind}`}
              data-tab={kind}
              aria-selected={selected}
              aria-controls="sessions-tabpanel"
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(kind)}
              className={cn(
                "h-7 rounded-md text-xs font-medium outline-none transition-[background-color,color,box-shadow] duration-(--motion-fast) motion-reduce:transition-none pointer-coarse:h-9",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                selected ? "bg-surface text-ink shadow-float-sm" : "text-ink-2 hover:text-ink active:bg-[color-mix(in_oklab,var(--surface)_60%,transparent)]",
              )}
            >
              {TAB_LABEL[kind]}
            </button>
          );
        })}
      </div>
    </div>
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
      {/* There is no rail on mobile, so agents, settings and logs are reachable here. */}
      <AgentsButton side="top" afterOpen={() => shell.setSessionsOpen(false)} className="text-ink-2" />
      <TooltipIconButton tooltip="Logs" side="top" onClick={() => openWorkbench("logs")}>
        <FileClock />
      </TooltipIconButton>
      <TooltipIconButton tooltip="Settings" side="top" onClick={() => openWorkbench("settings")}>
        <Settings />
      </TooltipIconButton>
      {/* Beam's spark, beside Settings: the rail's affordance, rendered where a phone has room for it. */}
      <BeamSpark side="top" onOpen={() => shell.setSessionsOpen(false)} />
      <span className="ms-auto pe-1 typed text-ink-3">{PRODUCT_NAME}</span>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

function EmptyState({ icon, title, body, action }: { icon?: React.ReactNode; title: string; body: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-4 px-6 py-8 text-center">
      <StatusRing status="idle" size={40} thickness={2} aria-hidden="true">
        {icon ?? <Plus className="size-4 text-ink-3" />}
      </StatusRing>
      <div className="max-w-56">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-xs leading-4 text-ink-2">{body}</p>
      </div>
      {action}
    </div>
  );
}
