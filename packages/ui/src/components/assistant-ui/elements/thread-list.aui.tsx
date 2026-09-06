"use client";
/**
 * Thread list — THE SESSIONS PANEL (docs/ux-elements.md "AUI-connected",
 * DESIGN.md "Layout" → Sessions, D-20 §6). Installed from `thread-list` and
 * rebuilt around what the runtime already knows: laser runs a
 * `RemoteThreadListRuntime` whose adapter lists every Pi session as a thread
 * with `custom.cwd` and `custom.attention`, so the list reads
 * `s.threads.threadIds` / `threadItems` and the row reads `s.threadListItem`.
 *
 * Divergences from the registry copy, so a reviewer can diff them:
 *   - Groups are **projects**, not Today / Yesterday / Earlier. Every project
 *     is a collapsible group in one scrolling list, attention-sorted inside
 *     (waiting > error > finished-unread > working > idle, then modified).
 *     `useThreadListGroups` does that grouping from `custom.cwd` and the
 *     adapter's order.
 *   - A row is a status dot, the title (typed id prefix when untitled), the
 *     relative time and a subtitle — the last tool or "Waiting for you" — read
 *     from the laser store for that path, because the runtime's item state
 *     has no such fields.
 *   - The more-menu offers Rename, Archive (client-local; Pi has no verb) and
 *     Copy path. Archived rows add an explicitly confirmed permanent delete;
 *     the host validates the path against Pi's session catalogue first.
 *   - Archived sessions live under a collapsible "Archived" group at the end
 *     with Unarchive and Delete; the registry copy had none.
 *   - Colours, sizes and durations read tokens; the running spinner became
 *     the status dot's sweep.
 */
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { SessionAttention } from "@lasercode/protocol";
import { Archive, ArchiveRestore, ChevronRight, Copy, EllipsisVertical, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";

import { InlineRename } from "@/components/shell/InlineRename";
import { groupDomId, sessionsList, useSessionsList } from "@/components/shell/session-groups";
import { isUntitled, sessionStatus, sessionSubtitle } from "@/components/shell/model";
import { aggregateStatus, StatusDot, type Status } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dateTime, relativeTime, shortCwd } from "@/format";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { attentionRank, mergeSessions, useLaserStable, useLaserState } from "@/runtime";
import type { AppState } from "@/store";

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface ThreadListGroup {
  cwd: string;
  name: string;
  /** Indices into `s.threads.threadIds`, attention-sorted then newest first. */
  indices: number[];
  status: Status;
  needYou: number;
}

const rank = (item: { custom?: Record<string, unknown> | undefined }): number =>
  attentionRank(item.custom?.["attention"] as SessionAttention | undefined);
const modified = (item: { custom?: Record<string, unknown> | undefined; lastMessageAt?: Date | undefined }): number => {
  const raw = item.custom?.["modifiedAt"];
  const t = typeof raw === "string" ? Date.parse(raw) : (item.lastMessageAt?.getTime() ?? NaN);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Every project as a group, in rail order, each attention-sorted; a session
 * whose cwd is not a known project still gets a group at the end, so nothing
 * on disk is unreachable. `filter` narrows to one project (the rail's
 * choice), `query` to titles containing it.
 */
export function useThreadListGroups(projects: readonly string[], filter: string | undefined, query = ""): ThreadListGroup[] {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const workers = useLaserState((s) => s.workers);
  const needle = query.trim().toLowerCase();

  return useMemo(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item]));
    const byCwd = new Map<string, number[]>();
    threadIds.forEach((id, index) => {
      const item = byId.get(id);
      const cwd = typeof item?.custom?.["cwd"] === "string" ? (item.custom["cwd"] as string) : "";
      if (filter && cwd !== filter) return;
      if (needle && !(item?.title ?? "").toLowerCase().includes(needle)) return;
      const list = byCwd.get(cwd) ?? [];
      list.push(index);
      byCwd.set(cwd, list);
    });
    const order = filter ? [filter] : [...projects];
    for (const cwd of byCwd.keys()) if (!order.includes(cwd)) order.push(cwd);
    return order
      .filter((cwd) => !filter || cwd === filter)
      .map((cwd) => {
        const indices = (byCwd.get(cwd) ?? []).sort((a, b) => {
          const ia = byId.get(threadIds[a]!);
          const ib = byId.get(threadIds[b]!);
          if (!ia || !ib) return 0;
          const r = rank(ia) - rank(ib);
          return r !== 0 ? r : modified(ib) - modified(ia);
        });
        const statuses: Status[] = indices.map((i) => (byId.get(threadIds[i]!)?.custom?.["attention"] as Status | undefined) ?? "idle");
        if (workers[cwd]?.status === "crashed") statuses.push("error");
        return {
          cwd,
          name: shortCwd(cwd),
          indices,
          status: aggregateStatus(statuses),
          needYou: statuses.filter((s) => s === "waiting_for_input").length,
        };
      });
  }, [threadIds, threadItems, projects, filter, needle, workers]);
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface ThreadListProps {
  /** Known projects, in rail order (`useLaserStable().projects`). */
  projects: readonly string[];
  /** Filters rows by title. */
  query?: string | undefined;
  /** Called after a row is chosen; the sheet closes itself with it. */
  onOpen?: (() => void) | undefined;
  /** Start a session in a project (the group header's `+`). */
  onNewSession?: ((cwd: string) => void) | undefined;
  canCreate?: boolean | undefined;
}

export const ThreadList: FC<ThreadListProps> = ({ projects, query = "", onOpen, onNewSession, canCreate = true }) => {
  const list = useSessionsList();
  const groups = useThreadListGroups(projects, list.filter, query);
  const archivedCount = useAuiState((s) => s.threads.archivedThreadIds.length);
  const { currentProject } = useLaserStable();
  const [editing, setEditing] = useState<string | undefined>(undefined);

  // The rail asked for a group: bring its header to the top of the list.
  useEffect(() => {
    if (!list.jump) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(groupDomId(list.jump.cwd))?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [list.jump]);

  return (
    <ThreadListPrimitive.Root data-slot="aui_thread-list-root" className="flex flex-col pb-2">
      <AuiIf condition={(s) => s.threads.isLoading && s.threads.threadIds.length === 0}>
        <ThreadListSkeleton names={groups.map((g) => g.name)} />
      </AuiIf>
      <AuiIf condition={(s) => !(s.threads.isLoading && s.threads.threadIds.length === 0)}>
        {groups.length === 0 && query.trim() ? (
          <p data-slot="aui_thread-list-empty" className="px-3 py-4 text-sm text-ink-3">
            No session matches “{query.trim()}”.
          </p>
        ) : null}
        {groups.map((group, index) => (
          <ProjectGroup
            key={group.cwd}
            group={group}
            first={index === 0}
            collapsed={list.collapsed.has(group.cwd) && !query.trim()}
            isCurrent={group.cwd === currentProject}
            canCreate={canCreate}
            editing={editing}
            onEdit={setEditing}
            onOpen={onOpen}
            onNewSession={onNewSession}
          />
        ))}
        {archivedCount > 0 && !query.trim() && <ArchivedGroup editing={editing} onEdit={setEditing} onOpen={onOpen} />}
      </AuiIf>
    </ThreadListPrimitive.Root>
  );
};

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

interface ProjectGroupProps {
  group: ThreadListGroup;
  first: boolean;
  collapsed: boolean;
  isCurrent: boolean;
  canCreate: boolean;
  editing: string | undefined;
  onEdit(id: string | undefined): void;
  onOpen?: (() => void) | undefined;
  onNewSession?: ((cwd: string) => void) | undefined;
}

const ProjectGroup = memo(function ProjectGroup({ group, first, collapsed, isCurrent, canCreate, editing, onEdit, onOpen, onNewSession }: ProjectGroupProps) {
  const aui = useAui();
  const { actions, archive } = useLaserStable();
  const sessions = useLaserState((state) => state.sessions);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const id = groupDomId(group.cwd);
  const listId = `${id}-list`;
  const count = group.indices.length;
  return (
    <section aria-labelledby={`${id}-name`} data-cwd={group.cwd} data-current={isCurrent || undefined} className={cn("group/project", !first && "hairline-t")}>
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
          <span id={`${id}-name`} title={group.name} className={cn("min-w-0 truncate text-sm leading-5", isCurrent ? "font-semibold text-ink" : "font-medium text-ink-2")}>
            {group.name}
          </span>
          <span className="shrink-0 typed text-ink-3">{count}</span>
          {group.needYou > 0 && collapsed ? (
            <Badge variant="attention" className="tnum">
              {group.needYou}
            </Badge>
          ) : null}
        </button>
        {onNewSession && (
          <TooltipIconButton
            tooltip={`New session in ${group.name}`}
            size="icon-xs"
            className="text-ink-3 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            disabled={!canCreate}
            onClick={() => onNewSession(group.cwd)}
          >
            <Plus />
          </TooltipIconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip={`Actions for ${group.name}`} size="icon-xs" className="text-ink-3 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100">
              <EllipsisVertical />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem
              disabled={count === 0}
              onSelect={() => {
                const paths = sessions.filter((session) => session.cwd === group.cwd).map((session) => session.path);
                paths.forEach((path) => archive.add(path));
                void aui.threads.reload();
                actions.toast("info", `${paths.length} chat${paths.length === 1 ? "" : "s"} archived in ${group.name}.`);
              }}
            >
              <Archive /> Archive chats
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void actions.removeProject(group.cwd)}>
              <EyeOff /> Remove project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
            {onNewSession && (
              <Button variant="link" size="xs" className="text-xs" disabled={!canCreate} onClick={() => onNewSession(group.cwd)}>
                Start one
              </Button>
            )}
          </div>
        ) : (
          <div id={listId} role="list" className="pb-1">
            {group.indices.map((index) => (
              <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem: itemComponent(editing, onEdit, onOpen) }} />
            ))}
          </div>
        ))}
    </section>
  );
});

function ArchivedGroup({ editing, onEdit, onOpen }: { editing: string | undefined; onEdit(id: string | undefined): void; onOpen?: (() => void) | undefined }) {
  const archivedIds = useAuiState((s) => s.threads.archivedThreadIds);
  const [open, setOpen] = useState(false);
  const listId = "session-group-archived";
  return (
    <section aria-label="Archived sessions" className="hairline-t">
      <div className="sticky top-0 z-10 flex h-9 items-center gap-1 bg-surface ps-3 pe-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-start outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
        >
          <Archive aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
          <span className="min-w-0 truncate text-sm leading-5 font-medium text-ink-2">Archived</span>
          <span className="shrink-0 typed text-ink-3">{archivedIds.length}</span>
        </button>
        <TooltipIconButton tooltip={open ? "Collapse" : "Expand"} size="icon-xs" className="text-ink-3" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
          <ChevronRight className={cn("transition-transform duration-(--motion-fast) ease-out motion-reduce:transition-none", open && "rotate-90")} />
        </TooltipIconButton>
      </div>
      {open && (
        <div id={listId} role="list" className="pb-1">
          {archivedIds.map((id, index) => (
            <ThreadListPrimitive.ItemByIndex key={id} index={index} archived components={{ ThreadListItem: itemComponent(editing, onEdit, onOpen, true) }} />
          ))}
        </div>
      )}
    </section>
  );
}

// `ItemByIndex` takes a component, not props; the component reads its item
// from scope, so the per-list callbacks reach it through a small cache keyed
// on their identity rather than a fresh closure per render.
const itemCache = new WeakMap<object, Map<string, FC>>();
function itemComponent(editing: string | undefined, onEdit: (id: string | undefined) => void, onOpen: (() => void) | undefined, archived = false): FC {
  const key = `${editing ?? ""}|${archived}`;
  const byOpen = itemCache.get(onEdit) ?? new Map<string, FC>();
  itemCache.set(onEdit, byOpen);
  let component = byOpen.get(`${key}|${onOpen ? "o" : "-"}`);
  if (!component) {
    component = () => <ThreadListItem editing={editing} onEdit={onEdit} onOpen={onOpen} archived={archived} />;
    byOpen.set(`${key}|${onOpen ? "o" : "-"}`, component);
  }
  return component;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RowModel {
  status: Status;
  untitled: boolean;
  sub: { text: string; mono: boolean; tone: "attention" | "default" | "muted" };
  modifiedAt: string | undefined;
  messageCount: number;
}

const sameRow = (a: RowModel, b: RowModel): boolean =>
  a.status === b.status &&
  a.untitled === b.untitled &&
  a.sub.text === b.sub.text &&
  a.sub.mono === b.sub.mono &&
  a.sub.tone === b.sub.tone &&
  a.modifiedAt === b.modifiedAt &&
  a.messageCount === b.messageCount;

/** What the runtime's item state lacks, from the laser store, for one path. */
function useRowModel(path: string | undefined): RowModel {
  return useLaserState(
    useCallback(
      (s: AppState): RowModel => {
        const summary = path ? mergeSessions(s.sessions, s.open).find((x) => x.path === path) : undefined;
        const view = path ? s.open[path] : undefined;
        if (!summary) return { status: "idle", untitled: true, sub: { text: "No messages yet", mono: false, tone: "muted" }, modifiedAt: undefined, messageCount: 0 };
        return {
          status: sessionStatus(view, summary),
          untitled: isUntitled(summary, view),
          sub: sessionSubtitle(summary, view),
          modifiedAt: summary.modifiedAt,
          messageCount: summary.messageCount,
        };
      },
      [path],
    ),
    sameRow,
  );
}

export const ThreadListItem: FC<{ editing: string | undefined; onEdit(id: string | undefined): void; onOpen?: (() => void) | undefined; archived?: boolean }> = ({
  editing,
  onEdit,
  onOpen,
  archived = false,
}) => {
  const id = useAuiState((s) => s.threadListItem.id);
  const path = useAuiState((s) => s.threadListItem.externalId ?? s.threadListItem.remoteId);
  const title = useAuiState((s) => s.threadListItem.title);
  const active = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const row = useRowModel(path);
  const isEditing = editing === id;
  const triggerRef = useRef<HTMLButtonElement>(null);

  const shownTitle = title ?? (path ? path.split("/").pop()?.slice(0, 8) : "New session") ?? "New session";

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      data-active={active || undefined}
      className={cn("group relative", active && "bg-surface-2")}
    >
      {isEditing ? (
        <div className="flex items-center gap-2.5 px-3 py-2">
          <StatusDot status={row.status} size="sm" />
          <RenameField onDone={() => onEdit(undefined)} />
        </div>
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          aria-current={active ? "page" : undefined}
          title={path ? (row.messageCount > 0 ? `${path}\n${row.messageCount} message${row.messageCount === 1 ? "" : "s"}` : path) : undefined}
          onClick={onOpen}
          onDoubleClick={(e) => {
            e.preventDefault();
            onEdit(id);
          }}
          className={cn(
            "grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-start",
            "transition-colors duration-(--motion-instant) outline-none",
            "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)] active:bg-surface-2",
            "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
          )}
        >
          <StatusDot status={row.status} size="sm" className="self-center" />
          <span
            data-slot="aui_thread-list-item-title"
            // The row's own title, so a name the column cuts is still readable
            // and still the accessible name (DESIGN.md, legibility floor).
            title={shownTitle}
            className={cn("truncate leading-5", row.untitled ? "text-sm text-ink-2 italic" : "text-sm font-medium text-ink", active && !row.untitled && "font-semibold")}
          >
            <ThreadListItemPrimitive.Title fallback={shownTitle} />
          </span>
          {row.modifiedAt ? (
            <time dateTime={row.modifiedAt} title={dateTime(row.modifiedAt)} className="typed leading-5 text-ink-3">
              {relativeTime(row.modifiedAt)}
            </time>
          ) : (
            <span />
          )}
          <span aria-hidden="true" />
          <span
            title={row.sub.text}
            className={cn(
              "col-span-2 truncate pe-6 text-xs leading-4",
              row.sub.mono && "font-mono",
              row.sub.tone === "attention" ? "font-medium text-attention" : row.sub.tone === "muted" ? "text-ink-3" : "text-ink-2",
            )}
          >
            {row.sub.text}
          </span>
        </ThreadListItemPrimitive.Trigger>
      )}
      {!isEditing && <ThreadListItemMore path={path} title={shownTitle} archived={archived} onRename={() => onEdit(id)} />}
    </ThreadListItemPrimitive.Root>
  );
};

function RenameField({ onDone }: { onDone(): void }) {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  return (
    <InlineRename
      initial={title}
      onCommit={(name) => {
        onDone();
        if (name.trim() && name.trim() !== title) void aui.threadListItem.rename(name.trim());
      }}
      onCancel={onDone}
    />
  );
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

function ThreadListItemMore({ path, title, archived, onRename }: { path: string | undefined; title: string; archived: boolean; onRename(): void }) {
  const aui = useAui();
  const { actions } = useLaserStable();
  const { copy } = useCopy();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const copyPath = () => {
    if (!path) return;
    void copy(path).then((ok) => actions.toast(ok ? "info" : "error", ok ? "Session path copied" : "Could not copy the path"));
  };
  return (
    <div
      className={cn(
        "absolute end-2 bottom-1.5 opacity-0 transition-opacity duration-(--motion-instant)",
        "group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
        "[@media(pointer:coarse)]:opacity-100",
      )}
    >
      <ThreadListItemMorePrimitive.Root sharedFocusGroup>
        <ThreadListItemMorePrimitive.Trigger asChild>
          <TooltipIconButton tooltip={`Actions for ${title}`} size="icon-xs" className="text-ink-3">
            <EllipsisVertical />
          </TooltipIconButton>
        </ThreadListItemMorePrimitive.Trigger>
        <ThreadListItemMorePrimitive.Content align="end" sideOffset={4} data-slot="aui_thread-list-item-more-content" className={menuContentClass}>
          {!archived && (
            <ThreadListItemMorePrimitive.Item className={menuItemClass} onSelect={onRename}>
              <Pencil />
              Rename
            </ThreadListItemMorePrimitive.Item>
          )}
          <ThreadListItemMorePrimitive.Item className={menuItemClass} onSelect={copyPath} disabled={!path}>
            <Copy />
            Copy path
          </ThreadListItemMorePrimitive.Item>
          <ThreadListItemMorePrimitive.Separator className="-mx-1 my-1 h-px bg-line" />
          {archived ? (
            <>
              <ThreadListItemPrimitive.Unarchive asChild>
                <ThreadListItemMorePrimitive.Item className={menuItemClass}>
                  <ArchiveRestore />
                  Unarchive
                </ThreadListItemMorePrimitive.Item>
              </ThreadListItemPrimitive.Unarchive>
              <ThreadListItemMorePrimitive.Item className={cn(menuItemClass, "text-danger focus:text-danger")} onSelect={() => setDeleteOpen(true)}>
                <Trash2 /> Delete permanently
              </ThreadListItemMorePrimitive.Item>
            </>
          ) : (
            <ThreadListItemPrimitive.Archive asChild>
              <ThreadListItemMorePrimitive.Item className={menuItemClass}>
                <Archive />
                Archive
              </ThreadListItemMorePrimitive.Item>
            </ThreadListItemPrimitive.Archive>
          )}
        </ThreadListItemMorePrimitive.Content>
      </ThreadListItemMorePrimitive.Root>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{title}”?</DialogTitle>
            <DialogDescription>This permanently removes the saved transcript from disk. It cannot be recovered here.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!path}
              onClick={() => {
                try {
                  aui.threadListItem.delete();
                  setDeleteOpen(false);
                } catch (error) {
                  actions.toast("error", error instanceof Error ? error.message : String(error));
                }
              }}
            >
              Delete transcript
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading and search
// ---------------------------------------------------------------------------

/** The catalog is still scanning: the groups are known, their rows are not. */
function ThreadListSkeleton({ names }: { names: readonly string[] }) {
  const shown = names.length > 0 ? names : ["", ""];
  return (
    <div aria-busy="true" aria-label="Loading sessions">
      {shown.map((name, g) => (
        <section key={`${name}-${g}`} className={cn(g > 0 && "hairline-t")}>
          <div className="flex h-9 items-center gap-2 px-3">
            <Skeleton className="size-2 rounded-full" />
            {name ? <span className="text-sm leading-5 font-medium text-ink-2">{name}</span> : <SkeletonText width="40%" />}
          </div>
          <ul role="list" className="pb-1">
            {[72, 56].map((w, i) => (
              <li key={i} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2">
                <Skeleton className="size-2 rounded-full" />
                <SkeletonText width={`${w}%`} className="my-0.75" />
                <SkeletonText width="2rem" className="my-0.75 h-3" />
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

/** The search field above the list (the registry's `ThreadListSearch`, restyled). */
export function ThreadListSearch({ value, onValueChange, className, ...props }: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & { value: string; onValueChange(value: string): void }) {
  return (
    <Input
      type="search"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      aria-label="Search sessions"
      placeholder="Search sessions"
      className={cn("h-8", className)}
      {...props}
    />
  );
}
