import type * as React from "react";
import { memo, useCallback, useEffect, useReducer, useState } from "react";
import { ChevronDown, Copy, EllipsisVertical, FolderPlus, Moon, Pencil, Plus, Sun } from "lucide-react";
import { ContextMenu } from "radix-ui";
import type { SessionSummary } from "@piorbit/protocol";

import { StatusDot, StatusRing } from "@/components/status";
import type { Status } from "@/components/status/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { dateTime, relativeTime, shortCwd, shortcutLabel } from "@/format";
import { useCopy, useTheme } from "@/hooks";
import { cn } from "@/lib/utils";
import { sessionTitle, usePiorbitStable, usePiorbitState } from "@/runtime";
import type { AppState } from "@/store";

import { InlineRename } from "./InlineRename.js";
import { isUntitled, sessionStatus, sessionSubtitle, sessionsForProject, type SessionSubtitle } from "./model.js";
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
 * Everything a row renders, flattened out of the catalog and the live view, so
 * the panel can subscribe to a value that only changes when a row does — not
 * on every streamed token.
 */
interface Row {
  path: string;
  summary: SessionSummary;
  status: Status;
  title: string;
  untitled: boolean;
  sub: SessionSubtitle;
}

const rowsFor = (cwd: string | undefined, state: AppState): Row[] =>
  sessionsForProject(cwd, state.sessions, state.open).map((summary) => {
    const view = state.open[summary.path];
    return {
      path: summary.path,
      summary,
      status: sessionStatus(view, summary),
      title: sessionTitle(summary, view),
      untitled: isUntitled(summary, view),
      sub: sessionSubtitle(summary, view),
    };
  });

const sameRow = (a: Row, b: Row): boolean =>
  a.path === b.path &&
  a.status === b.status &&
  a.title === b.title &&
  a.untitled === b.untitled &&
  a.sub.text === b.sub.text &&
  a.sub.mono === b.sub.mono &&
  a.sub.tone === b.sub.tone &&
  a.summary.modifiedAt === b.summary.modifiedAt &&
  a.summary.name === b.summary.name;

const sameRows = (a: readonly Row[], b: readonly Row[]): boolean =>
  a.length === b.length && a.every((row, i) => sameRow(row, b[i]!));

export function SessionsPanel({ variant }: SessionsPanelProps) {
  const { currentProject, actions, client } = usePiorbitStable();
  const shell = useShell();
  const { copy } = useCopy();
  useClock();

  const rows = usePiorbitState(
    useCallback((s: AppState) => rowsFor(currentProject, s), [currentProject]),
    sameRows,
  );
  const sessionsLoaded = usePiorbitState((s) => s.sessionsLoaded);
  const current = usePiorbitState((s) => s.current);
  const needYou = rows.filter((r) => r.status === "waiting_for_input").length;
  const loading = !sessionsLoaded && rows.length === 0 && currentProject !== undefined;
  const [editing, setEditing] = useState<string | undefined>();

  const open = useCallback(
    (path: string) => {
      void actions.openSession(path);
      if (variant === "sheet") shell.setSessionsOpen(false);
    },
    [actions, shell, variant],
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
      void copy(path).then((ok) =>
        actions.toast(ok ? "info" : "error", ok ? "Session path copied" : "Could not copy the path"),
      );
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

  const projectName = currentProject ? shortCwd(currentProject) : undefined;

  return (
    <section
      aria-label="Sessions"
      className={cn("flex h-full min-h-0 flex-col bg-surface", variant === "panel" && "w-72 shrink-0 hairline-r")}
    >
      {/* 48px, one row: the sessions hairline has to land on the same y as the
          top bar's and the telemetry header's (DESIGN.md "Layout"). The cwd
          lives in the title attribute and in the rail tooltip. */}
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-3 hairline-b", variant === "sheet" && "pe-12")}>
        <div className="min-w-0 flex-1">
          {variant === "sheet" ? (
            <ProjectSwitcher />
          ) : (
            <div className="flex items-baseline gap-2">
              <h2 className="truncate text-sm leading-5 font-semibold text-ink" title={currentProject}>
                {projectName ?? "No project"}
              </h2>
              {rows.length > 0 && (
                <span className="shrink-0 font-mono text-2xs leading-4 text-ink-3 tnum">{rows.length}</span>
              )}
            </div>
          )}
        </div>
        {needYou > 0 && (
          <Badge variant="attention" className="tnum">
            {needYou} need{needYou === 1 ? "s" : ""} you
          </Badge>
        )}
        {variant === "panel" && (
          <TooltipIconButton
            tooltip="New session"
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
            New session
            <Kbd className="ms-auto">{shortcutLabel("N")}</Kbd>
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!currentProject ? (
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
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            body={
              <>
                Start one in <span className="font-medium text-ink">{projectName}</span>. Sessions started from a terminal
                appear here as well.
              </>
            }
            action={
              <Button size="sm" variant="outline" onClick={() => void shell.newSession()} disabled={!shell.canCreate}>
                <Plus />
                New session
                <Kbd>{shortcutLabel("N")}</Kbd>
              </Button>
            }
          />
        ) : (
          <ul role="list" className="py-1">
            {rows.map((row) => (
              <SessionRow
                key={row.path}
                row={row}
                active={row.path === current}
                editing={editing === row.path}
                onOpen={open}
                onRename={setEditing}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onCopyPath={copyPath}
              />
            ))}
          </ul>
        )}
      </div>

      {variant === "sheet" && shell.layout === "mobile" && <SheetFooter />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface SessionRowProps {
  row: Row;
  active: boolean;
  editing: boolean;
  /** Stable callbacks, so `memo` actually holds. */
  onOpen(path: string): void;
  onRename(path: string): void;
  onCommitRename(path: string, name: string): void;
  onCancelRename(): void;
  onCopyPath(path: string): void;
}

const menuContentClass = cn(
  "z-50 min-w-[10rem] overflow-hidden p-1",
  "rounded-lg border border-line bg-surface text-ink shadow-float outline-none",
  "animate-in fade-in-0 duration-75 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
);
const menuItemClass = cn(
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm leading-4 outline-hidden select-none",
  "focus:bg-surface-2 focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3",
);

const SessionRow = memo(function SessionRow({
  row,
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
              onClick={() => onOpen(summary.path)}
              onDoubleClick={(e) => {
                e.preventDefault();
                onRename(summary.path);
              }}
              aria-current={active ? "page" : undefined}
              title={summary.path}
              className={cn(
                "grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-start",
                "transition-colors duration-75 outline-none",
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
                className="font-mono text-[11px] leading-5 text-ink-3 tnum"
              >
                {relativeTime(summary.modifiedAt)}
              </time>
              <span aria-hidden="true" />
              <span
                className={cn(
                  "col-span-2 truncate pe-6 leading-4",
                  sub.mono ? "font-mono text-[11px]" : "text-xs",
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
                "absolute end-2 bottom-1.5 opacity-0 transition-opacity duration-75",
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
// Header pieces
// ---------------------------------------------------------------------------

/** Inside the sheet there is no rail, so the project switcher lives here. */
function ProjectSwitcher() {
  const { projects, currentProject, setCurrentProject } = usePiorbitStable();
  const shell = useShell();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "-ms-1.5 flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-sm leading-5 font-semibold text-ink",
            "outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live data-[state=open]:bg-surface-2",
          )}
          aria-label="Switch project"
        >
          <span className="truncate">{currentProject ? shortCwd(currentProject) : "Choose a project"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={currentProject ?? ""} onValueChange={(cwd) => setCurrentProject(cwd)}>
          {projects.map((cwd) => (
            <DropdownMenuRadioItem key={cwd} value={cwd}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{shortCwd(cwd)}</span>
                <span className="truncate font-mono text-[11px] text-ink-3">{cwd}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {projects.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => shell.setAddProjectOpen(true)}>
          <FolderPlus />
          Add project…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Mobile only: what the rail would have offered. */
function SheetFooter() {
  const { theme, toggle } = useTheme();
  const shell = useShell();
  return (
    <footer className="flex shrink-0 items-center gap-1 px-2 py-2 hairline-t">
      <TooltipIconButton tooltip={theme === "dark" ? "Light theme" : "Dark theme"} side="top" onClick={toggle}>
        {theme === "dark" ? <Sun /> : <Moon />}
      </TooltipIconButton>
      <TooltipIconButton tooltip="Add project" side="top" onClick={() => shell.setAddProjectOpen(true)}>
        <FolderPlus />
      </TooltipIconButton>
      <span className="ms-auto pe-1 font-mono text-[11px] text-ink-3">piorbit</span>
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

function LoadingRows() {
  return (
    <ul role="list" aria-busy="true" aria-label="Loading sessions" className="py-1">
      {[72, 56, 64, 48].map((w, i) => (
        <li key={i} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2">
          <Skeleton className="size-2 rounded-full" />
          <SkeletonText width={`${w}%`} className="my-[3px]" />
          <SkeletonText width={28} className="my-[3px] h-3" />
          <span />
          <SkeletonText width={`${Math.min(92, w + 24)}%`} className="col-span-2 my-0.5 h-3" />
        </li>
      ))}
    </ul>
  );
}
