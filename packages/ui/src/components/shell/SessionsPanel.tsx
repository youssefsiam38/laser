import type * as React from "react";
import { memo, useCallback, useEffect, useReducer, useState } from "react";
import { ChevronRight, Copy, EllipsisVertical, FileClock, FolderPlus, Moon, Pencil, Plus, Settings, Sun, X } from "lucide-react";
import { ContextMenu } from "radix-ui";

import { StatusDot, StatusRing } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useWorkbench } from "@/components/workbench";
import { dateTime, relativeTime, shortCwd, shortcutLabel } from "@/format";
import { useCopy, useTheme } from "@/hooks";
import { cn } from "@/lib/utils";
import { usePiorbitStable, usePiorbitState } from "@/runtime";
import type { AppState } from "@/store";

import { InboxPanel } from "./InboxPanel.js";
import { InlineRename } from "./InlineRename.js";
import type { InboxRow } from "./model.js";
import {
  groupDomId,
  groupsFor,
  sameGroups,
  sessionsList,
  useSessionsList,
  type SessionGroupModel,
  type SessionRowModel,
} from "./session-groups.js";
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

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Every project as a collapsible group in one scrolling list, attention-sorted
 * inside each group (D-20 §6). The rail filters and jumps to a group rather
 * than replacing the list, so moving between projects never means switching
 * first. `+` on a group header starts a session there.
 */
export function SessionsPanel({ variant }: SessionsPanelProps) {
  const { projects } = usePiorbitStable();
  // `usePiorbitState` caches by store state, so a selector that also closes
  // over `projects` (React state, not store state) would keep answering from a
  // stale project list until the next store change. Remounting on the list
  // key gives the hook a fresh cache the moment a project is added or removed.
  return <SessionsPanelBody key={projects.join("\n")} variant={variant} />;
}

function SessionsPanelBody({ variant }: SessionsPanelProps) {
  const { projects, currentProject, setCurrentProject, actions, client } = usePiorbitStable();
  const shell = useShell();
  const { copy } = useCopy();
  const list = useSessionsList();
  useClock();

  const groups = usePiorbitState(
    useCallback((s: AppState) => groupsFor(projects, s), [projects]),
    sameGroups,
  );
  const sessionsLoaded = usePiorbitState((s) => s.sessionsLoaded);
  const connection = usePiorbitState((s) => s.connection);
  const current = usePiorbitState((s) => s.current);
  const [editing, setEditing] = useState<string | undefined>();

  const visible = list.filter ? groups.filter((g) => g.cwd === list.filter) : groups;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const needYou = groups.reduce((n, g) => n + g.needYou, 0);
  const loading = !sessionsLoaded && total === 0 && groups.length > 0;
  const filteredName = list.filter ? shortCwd(list.filter) : undefined;

  // The rail asked for a group: bring its header to the top of the list.
  useEffect(() => {
    if (!list.jump) return;
    const el = document.getElementById(groupDomId(list.jump.cwd));
    el?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [list.jump]);

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

  const rename = useCallback(
    async (path: string, name: string) => {
      try {
        await client.request("pi/session/rename", { path, name });
        await actions.refreshSessions();
      } catch (error) {
        actions.toast("error", errorText(error));
      }
    },
    [actions, client],
  );

  const copyPath = useCallback(
    (path: string) => {
      void copy(path).then((ok) => actions.toast(ok ? "info" : "error", ok ? "Session path copied" : "Could not copy the path"));
    },
    [actions, copy],
  );

  const commitRename = useCallback(
    (path: string, name: string) => {
      setEditing(undefined);
      void rename(path, name);
    },
    [rename],
  );
  const cancelRename = useCallback(() => setEditing(undefined), []);

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
          {total > 0 && <span className="shrink-0 font-mono text-xs leading-4 text-ink-3 tnum">{total}</span>}
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
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start"
            onClick={() => void shell.newSession()}
            disabled={!shell.canCreate}
          >
            <Plus />
            <span className="truncate">New session{currentProject ? ` in ${shortCwd(currentProject)}` : ""}</span>
            <Kbd className="ms-auto">{shortcutLabel("N")}</Kbd>
          </Button>
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
        <InboxPanel onOpen={openFromInbox} />
        {groups.length === 0 ? (
          <EmptyState
            title="No project yet"
            body="Point piorbit at a directory. Sessions Pi already has there show up too."
            action={
              <Button size="sm" variant="outline" onClick={() => shell.setAddProjectOpen(true)}>
                <FolderPlus />
                Add project
              </Button>
            }
          />
        ) : loading ? (
          <LoadingGroups names={visible.map((g) => g.name)} />
        ) : (
          <div className="pb-2">
            {visible.map((group, index) => (
              <SessionGroup
                key={group.cwd}
                group={group}
                first={index === 0}
                collapsed={list.collapsed.has(group.cwd)}
                isCurrent={group.cwd === currentProject}
                canCreate={connection === "open"}
                current={current}
                editing={editing}
                onOpen={open}
                onNewSession={newSessionIn}
                onRename={setEditing}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onCopyPath={copyPath}
              />
            ))}
          </div>
        )}
      </div>

      {variant === "sheet" && shell.layout === "mobile" && <SheetFooter />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

interface SessionGroupProps {
  group: SessionGroupModel;
  /** The first group needs no rule above it. */
  first: boolean;
  collapsed: boolean;
  /** New sessions from the header's `+` start here; also the target of Cmd+N. */
  isCurrent: boolean;
  canCreate: boolean;
  current: string | undefined;
  editing: string | undefined;
  onOpen(path: string, cwd: string): void;
  onNewSession(cwd: string): Promise<void>;
  onRename(path: string): void;
  onCommitRename(path: string, name: string): void;
  onCancelRename(): void;
  onCopyPath(path: string): void;
}

const SessionGroup = memo(function SessionGroup({
  group,
  first,
  collapsed,
  isCurrent,
  canCreate,
  current,
  editing,
  onOpen,
  onNewSession,
  onRename,
  onCommitRename,
  onCancelRename,
  onCopyPath,
}: SessionGroupProps) {
  const id = groupDomId(group.cwd);
  const listId = `${id}-list`;
  const count = group.rows.length;
  return (
    <section
      aria-labelledby={`${id}-name`}
      data-cwd={group.cwd}
      data-current={isCurrent || undefined}
      className={cn("group/project", !first && "hairline-t")}
    >
      <div id={id} className="sticky top-0 z-10 flex h-9 items-center gap-1 bg-surface ps-3 pe-1.5">
        <button
          type="button"
          onClick={() => sessionsList.toggleCollapsed(group.cwd)}
          aria-expanded={!collapsed}
          aria-controls={listId}
          title={`${group.cwd}${isCurrent ? "\nCurrent project: new sessions start here" : ""}`}
          className={cn(
            "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-start outline-none",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          )}
        >
          <StatusDot status={group.status} size="sm" label={`${group.name}: ${group.status.replace(/_/g, " ")}`} />
          <span
            id={`${id}-name`}
            className={cn("min-w-0 truncate text-sm leading-5", isCurrent ? "font-semibold text-ink" : "font-medium text-ink-2")}
          >
            {group.name}
          </span>
          <span className="shrink-0 font-mono text-xs leading-4 text-ink-3 tnum">{count}</span>
          {group.needYou > 0 && collapsed ? (
            <Badge variant="attention" className="tnum">
              {group.needYou}
            </Badge>
          ) : null}
        </button>
        <TooltipIconButton
          tooltip={`New session in ${group.name}`}
          size="icon-xs"
          className="text-ink-3 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
          disabled={!canCreate}
          onClick={() => void onNewSession(group.cwd)}
        >
          <Plus />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip={collapsed ? "Expand" : "Collapse"}
          size="icon-xs"
          className="text-ink-3"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => sessionsList.toggleCollapsed(group.cwd)}
        >
          <ChevronRight className={cn("transition-transform duration-(--motion-fast) ease-out motion-reduce:transition-none", !collapsed && "rotate-90")} />
        </TooltipIconButton>
      </div>

      {!collapsed &&
        (count === 0 ? (
          <div className="flex items-center gap-2 px-3 pt-1 pb-3 text-xs leading-4 text-ink-3">
            <span>No sessions yet.</span>
            <Button variant="link" size="xs" className="text-xs" disabled={!canCreate} onClick={() => void onNewSession(group.cwd)}>
              Start one
            </Button>
          </div>
        ) : (
          <ul id={listId} role="list" className="pb-1">
            {group.rows.map((row) => (
              <SessionRow
                key={row.path}
                row={row}
                cwd={group.cwd}
                active={row.path === current}
                editing={editing === row.path}
                onOpen={onOpen}
                onRename={onRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
                onCopyPath={onCopyPath}
              />
            ))}
          </ul>
        ))}
    </section>
  );
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface SessionRowProps {
  row: SessionRowModel;
  cwd: string;
  active: boolean;
  editing: boolean;
  /** Stable callbacks, so `memo` actually holds. */
  onOpen(path: string, cwd: string): void;
  onRename(path: string): void;
  onCommitRename(path: string, name: string): void;
  onCancelRename(): void;
  onCopyPath(path: string): void;
}

const menuContentClass = cn(
  "z-50 min-w-[10rem] overflow-hidden p-1",
  "rounded-lg border border-line bg-surface text-ink shadow-float outline-none",
  "animate-in fade-in-0 duration-(--motion-instant) data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
);
const menuItemClass = cn(
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm leading-4 outline-hidden select-none",
  "focus:bg-surface-2 focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3",
);

const SessionRow = memo(function SessionRow({
  row,
  cwd,
  active,
  editing,
  onOpen,
  onRename,
  onCommitRename,
  onCancelRename,
  onCopyPath,
}: SessionRowProps) {
  const { summary, status, title, untitled, sub } = row;

  const items: Array<{ label: string; icon: React.ReactNode; onSelect(): void }> = [
    { label: "Rename", icon: <Pencil />, onSelect: () => onRename(summary.path) },
    { label: "Copy path", icon: <Copy />, onSelect: () => onCopyPath(summary.path) },
  ];

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li className={cn("group relative", active && "bg-surface-2")}>
          {editing ? (
            <div className="flex items-center gap-2.5 px-3 py-2">
              <StatusDot status={status} size="sm" />
              <InlineRename
                initial={summary.name ?? ""}
                onCommit={(name) => onCommitRename(summary.path, name)}
                onCancel={onCancelRename}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(summary.path, cwd)}
              onDoubleClick={(e) => {
                e.preventDefault();
                onRename(summary.path);
              }}
              aria-current={active ? "page" : undefined}
              title={
                summary.messageCount > 0
                  ? `${summary.path}\n${summary.messageCount} message${summary.messageCount === 1 ? "" : "s"}`
                  : summary.path
              }
              className={cn(
                "grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-start",
                "transition-colors duration-(--motion-instant) outline-none",
                "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)] active:bg-surface-2",
                "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              )}
            >
              <StatusDot status={status} size="sm" className="self-center" />
              <span
                className={cn(
                  "truncate leading-5",
                  untitled ? "font-mono text-xs tracking-[0.01em] text-ink-2" : "text-sm font-medium text-ink",
                  active && !untitled && "font-semibold",
                )}
              >
                {title}
              </span>
              <time
                dateTime={summary.modifiedAt}
                title={dateTime(summary.modifiedAt)}
                className="font-mono text-xs leading-5 text-ink-3 tnum"
              >
                {relativeTime(summary.modifiedAt)}
              </time>
              <span aria-hidden="true" />
              <span
                className={cn(
                  "col-span-2 truncate pe-6 text-xs leading-4",
                  sub.mono && "font-mono",
                  sub.tone === "attention" ? "font-medium text-attention" : sub.tone === "muted" ? "text-ink-3" : "text-ink-2",
                )}
              >
                {sub.text}
              </span>
            </button>
          )}

          {!editing && (
            <div
              className={cn(
                "absolute end-2 bottom-1.5 opacity-0 transition-opacity duration-(--motion-instant)",
                "group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
                "[@media(pointer:coarse)]:opacity-100",
              )}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${title}`} className="text-ink-3">
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {items.map((item) => (
                    <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
                      {item.icon}
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass}>
          {items.map((item) => (
            <ContextMenu.Item key={item.label} className={menuItemClass} onSelect={item.onSelect}>
              {item.icon}
              {item.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

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
      <span className="ms-auto pe-1 font-mono text-xs text-ink-3">piorbit</span>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Empty / loading
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

/** The catalog is still scanning: the groups are known, their rows are not. */
function LoadingGroups({ names }: { names: readonly string[] }) {
  return (
    <div aria-busy="true" aria-label="Loading sessions">
      {names.map((name, g) => (
        <section key={name} className={cn(g > 0 && "hairline-t")}>
          <div className="flex h-9 items-center gap-2 px-3">
            <Skeleton className="size-2 rounded-full" />
            <span className="text-sm leading-5 font-medium text-ink-2">{name}</span>
          </div>
          <ul role="list" className="pb-1">
            {[72, 56].map((w, i) => (
              <li key={i} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2">
                <Skeleton className="size-2 rounded-full" />
                <SkeletonText width={`${w}%`} className="my-[3px]" />
                <SkeletonText width={28} className="my-[3px] h-3" />
                <span />
                <SkeletonText width={`${Math.min(92, w + 24)}%`} className="col-span-2 my-0.5 h-3" />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
