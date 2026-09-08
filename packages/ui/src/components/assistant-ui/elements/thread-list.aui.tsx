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
 *   - Groups are quiet project folders, newest first inside. Client-local
 *     pins move into a top section with project labels, never duplicate rows.
 *   - Rounded single-line rows carry a title and trailing activity indicator.
 *     Full path, preview and time remain in the tooltip. No idle dots and no
 *     separate inbox/project activity highlights (D-103).
 *   - The more-menu offers Rename, Archive (client-local; Pi has no verb) and
 *     Copy path. Archived rows add an explicitly confirmed permanent delete;
 *     the host validates the path against Pi's session catalogue first.
 *   - Archived sessions live under a collapsible "Archived" group at the end
 *     with Unarchive and Delete; the registry copy had none.
 *   - Colours, sizes and durations read tokens; the running session uses a
 *     small spinner with the shared sweep and a reduced-motion fallback.
 *
 * Since the agents leap (docs/agents.md, Lane U2):
 *   - Two tabs. **Code** is the project list; **Chat** is the projectless
 *     conversations of the built-in Chat workspace, one flat list, newest
 *     first. The Beam workspace is a group of its own after the projects, with
 *     a spark instead of a folder, and its rows carry a small spark too.
 *     Neither built-in group offers a `+`: Beam is started from its bubble and
 *     Chat from the tab's own button.
 *   - A child session an agent started nests under its parent, one step per
 *     depth, on a continuous lineage rail (the grammar of
 *     `elements/subagent-list.tsx`). Its row leads with the instance name and
 *     its run's status; a parent shows how many agents it has. A child whose
 *     parent is no longer listed sits under a "Detached" mini-header rather
 *     than vanishing. Selecting a child opens it like any session.
 */
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { AgentRun, AgentRunStatus, SessionSummary } from "@lasercode/protocol";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CircleStop,
  Copy,
  Ellipsis,
  EyeOff,
  Folder,
  FolderOpen,
  Info,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Trash2,
  Unlink,
} from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type FC } from "react";

import { latestRunForSession, runStatusLabel, runStatusTone, type AgentStatusTone } from "@/agents/model";
import { requestEndAgent } from "@/components/agents/end-agent";
import { InlineRename } from "@/components/shell/InlineRename";
import { SessionActivity } from "@/components/shell/SessionActivity";
import {
  groupDomId,
  groupNameOf,
  isWorktreeCwd,
  sessionsList,
  useSessionsList,
  workspaceKindOf,
  type SessionGroupKind,
  type SessionsTab,
  type Workspaces,
} from "@/components/shell/session-groups";
import { isUntitled, sessionStatus, sessionSubtitle } from "@/components/shell/model";
import { TONE_COLOR, type Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dateTime, shortCwd } from "@/format";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { mergeSessions, useLaserStable, useLaserState } from "@/runtime";
import type { AppState } from "@/store";

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** One row and the rows nested under it, in creation order. */
export interface ThreadListNode {
  /** Index into `s.threads.threadIds`. */
  index: number;
  path: string;
  children: ThreadListNode[];
}

export interface ThreadListGroup {
  cwd: string;
  name: string;
  kind: SessionGroupKind;
  /** Top-level rows, newest first; each carries its children. */
  roots: ThreadListNode[];
  /** Children whose parent is not in the list any more, newest first. */
  detached: ThreadListNode[];
  /** Unpinned top-level indices, newest first (the flattened `roots`). */
  indices: number[];
  pinnedIndices: number[];
  /** Every row the group holds, nested ones included. */
  total: number;
}

/** What a parent row shows about the rows beneath it. */
export interface ChildStats {
  count: number;
  running: number;
}

const modified = (item: { custom?: Record<string, unknown> | undefined; lastMessageAt?: Date | undefined }): number => {
  const raw = item.custom?.["modifiedAt"];
  const t = typeof raw === "string" ? Date.parse(raw) : (item.lastMessageAt?.getTime() ?? NaN);
  return Number.isNaN(t) ? 0 : t;
};

const time = (value: unknown): number => {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

interface ItemMeta {
  index: number;
  path: string;
  cwd: string;
  title: string;
  parentPath: string | undefined;
  child: boolean;
  modifiedAt: number;
  /** When the row was born: the run's start, else the catalog's `createdAt`. */
  startedAt: number;
}

const ACTIVE_RUN: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>(["running", "queued"]);

// One `latestRunForSession` pass per run registry, not one per row per render:
// the registry object only changes when a run does.
const latestRunsCache = new WeakMap<object, ReadonlyMap<string, AgentRun>>();
function latestRunsBySession(runs: Readonly<Record<string, AgentRun>>): ReadonlyMap<string, AgentRun> {
  const cached = latestRunsCache.get(runs);
  if (cached) return cached;
  const map = new Map<string, AgentRun>();
  for (const run of Object.values(runs)) {
    if (!map.has(run.sessionPath)) map.set(run.sessionPath, latestRunForSession(runs, run.sessionPath)!);
  }
  latestRunsCache.set(runs, map);
  return map;
}

/**
 * Every project as a group, in rail order, newest first inside; a session
 * whose cwd is not a known project still gets a group at the end, so nothing
 * on disk is unreachable. `filter` narrows to one project (the rail's
 * choice), `query` to titles containing it. Children nest under their parent
 * in the parent's group, whatever directory their worktree lives in.
 */
export function useThreadListGroups(
  projects: readonly string[],
  filter: string | undefined,
  query = "",
  tab: SessionsTab = "code",
  workspaces: Workspaces = {},
): ThreadListGroup[] {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const runs = useLaserState((s) => s.agents.runs);
  const { pinned } = useSessionsList();
  const needle = query.trim().toLowerCase();

  return useMemo(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item]));
    const latest = latestRunsBySession(runs);
    const metas: ItemMeta[] = [];
    const byPath = new Map<string, ItemMeta>();
    threadIds.forEach((id, index) => {
      const item = byId.get(id);
      if (!item) return;
      const path = item.externalId ?? item.remoteId ?? id;
      const custom = item.custom ?? {};
      const run = latest.get(path);
      const parentPath = str(custom["parentPath"]);
      const meta: ItemMeta = {
        index,
        path,
        cwd: str(custom["cwd"]) ?? "",
        title: item.title ?? "",
        parentPath,
        child: custom["agentKind"] === "child" || parentPath !== undefined,
        modifiedAt: modified(item),
        startedAt: time(run?.startedAt) || time(custom["createdAt"]),
      };
      metas.push(meta);
      byPath.set(path, meta);
    });

    // The group a row lists under: the top-most listed ancestor's directory,
    // else the run's project, else its own directory.
    const groupCwdOf = (meta: ItemMeta): string => {
      let cursor = meta;
      const seen = new Set<string>([meta.path]);
      for (;;) {
        const parent = cursor.child && cursor.parentPath !== undefined ? byPath.get(cursor.parentPath) : undefined;
        if (!parent || seen.has(parent.path)) break;
        seen.add(parent.path);
        cursor = parent;
      }
      if (cursor !== meta || !meta.child) return cursor.cwd;
      return latest.get(meta.path)?.projectCwd ?? meta.cwd;
    };

    const shown = metas.filter((meta) => {
      const groupCwd = groupCwdOf(meta);
      const kind = workspaceKindOf(groupCwd, workspaces);
      if ((tab === "chat") !== (kind === "chat")) return false;
      if (tab === "code" && filter && groupCwd !== filter) return false;
      if (needle && !meta.title.toLowerCase().includes(needle)) return false;
      return true;
    });
    const shownPaths = new Set(shown.map((meta) => meta.path));

    // Parentage is structural; a typed query flattens it, because a match
    // that hides under a non-matching parent is a match you cannot see.
    const childrenOf = new Map<string, ItemMeta[]>();
    const roots: ItemMeta[] = [];
    const detached: ItemMeta[] = [];
    for (const meta of shown) {
      const parent = !needle && meta.child && meta.parentPath !== undefined && shownPaths.has(meta.parentPath) ? meta.parentPath : undefined;
      if (parent !== undefined) {
        const list = childrenOf.get(parent) ?? [];
        list.push(meta);
        childrenOf.set(parent, list);
      } else if (meta.child && !needle) detached.push(meta);
      else roots.push(meta);
    }
    // Children in creation order — the order their runs started — never
    // attention order: a list that reshuffles is a list you cannot learn.
    for (const list of childrenOf.values()) list.sort((a, b) => a.startedAt - b.startedAt || a.path.localeCompare(b.path));
    const newestFirst = (a: ItemMeta, b: ItemMeta) => b.modifiedAt - a.modifiedAt;
    roots.sort(newestFirst);
    detached.sort(newestFirst);

    const nodeOf = (meta: ItemMeta, trail: Set<string>): ThreadListNode => ({
      index: meta.index,
      path: meta.path,
      children: (childrenOf.get(meta.path) ?? [])
        .filter((child) => !trail.has(child.path))
        .map((child) => nodeOf(child, new Set([...trail, child.path]))),
    });
    const countNodes = (nodes: readonly ThreadListNode[]): number => nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);

    const byCwd = new Map<string, { roots: ThreadListNode[]; detached: ThreadListNode[] }>();
    const bucket = (cwd: string) => {
      const held = byCwd.get(cwd);
      if (held) return held;
      const made = { roots: [], detached: [] };
      byCwd.set(cwd, made);
      return made;
    };
    for (const meta of roots) bucket(groupCwdOf(meta)).roots.push(nodeOf(meta, new Set([meta.path])));
    for (const meta of detached) bucket(groupCwdOf(meta)).detached.push(nodeOf(meta, new Set([meta.path])));

    let order: string[];
    if (tab === "chat") order = workspaces.chat !== undefined ? [workspaces.chat] : [...byCwd.keys()];
    else {
      // A child's worktree is listed by the rail while the child is open; it
      // is the child's directory, not a project, so it gets no group of its own.
      order = filter ? [filter] : projects.filter((cwd) => workspaceKindOf(cwd, workspaces) === undefined && !isWorktreeCwd(cwd));
      for (const cwd of byCwd.keys()) if (!order.includes(cwd) && workspaceKindOf(cwd, workspaces) === undefined) order.push(cwd);
      // Beam after the projects: a built-in feature, not a directory someone added.
      if (!filter && workspaces.beam !== undefined && byCwd.has(workspaces.beam)) order.push(workspaces.beam);
    }

    return order
      .filter((cwd) => !filter || tab === "chat" || cwd === filter)
      .map((cwd): ThreadListGroup => {
        const kind: SessionGroupKind = workspaceKindOf(cwd, workspaces) ?? "project";
        const held = byCwd.get(cwd) ?? { roots: [], detached: [] };
        const isPinned = (node: ThreadListNode) => pinned.has(node.path);
        const unpinned = held.roots.filter((node) => !isPinned(node));
        return {
          cwd,
          name: groupNameOf(cwd, kind),
          kind,
          roots: unpinned,
          detached: held.detached,
          indices: unpinned.map((node) => node.index),
          pinnedIndices: held.roots.filter(isPinned).map((node) => node.index),
          total: countNodes(held.roots) + countNodes(held.detached),
        };
      });
  }, [threadIds, threadItems, runs, projects, filter, needle, pinned, tab, workspaces]);
}

/** How many rows sit under each parent, and how many of them are still working. */
function childStatsOf(groups: readonly ThreadListGroup[], runs: Readonly<Record<string, AgentRun>>): ReadonlyMap<string, ChildStats> {
  const latest = latestRunsBySession(runs);
  const stats = new Map<string, ChildStats>();
  const walk = (node: ThreadListNode): void => {
    if (node.children.length > 0) {
      stats.set(node.path, {
        count: node.children.length,
        running: node.children.filter((child) => {
          const status = latest.get(child.path)?.status;
          return status !== undefined && ACTIVE_RUN.has(status);
        }).length,
      });
    }
    node.children.forEach(walk);
  };
  for (const group of groups) {
    group.roots.forEach(walk);
    group.detached.forEach(walk);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Contexts the rows read (a row reads its item from scope, not from props)
// ---------------------------------------------------------------------------

const EMPTY_STATS: ReadonlyMap<string, ChildStats> = new Map();
const TreeContext = createContext<ReadonlyMap<string, ChildStats>>(EMPTY_STATS);
/** `nested`: under a lineage rail; `flat`: the Chat tab's ungrouped list. */
const LayoutContext = createContext<{ nested: boolean; flat: boolean }>({ nested: false, flat: false });
const WorkspacesContext = createContext<Workspaces>({});

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
  /** Which tab's rows to draw. Defaults to Code, which is the whole list before the agents leap. */
  tab?: SessionsTab | undefined;
}

export const ThreadList: FC<ThreadListProps> = ({ projects, query = "", onOpen, onNewSession, canCreate = true, tab = "code" }) => {
  const list = useSessionsList();
  const workspaces = useLaserState((s) => s.agents.snapshot?.workspaces, sameWorkspaces) ?? EMPTY_WORKSPACES;
  const runs = useLaserState((s) => s.agents.runs);
  const groups = useThreadListGroups(projects, tab === "code" ? list.filter : undefined, query, tab, workspaces);
  const stats = useMemo(() => childStatsOf(groups, runs), [groups, runs]);
  const archivedCount = useAuiState((s) => s.threads.archivedThreadIds.length);
  const { currentProject } = useLaserStable();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const pinnedIndices = useMemo(() => {
    const order = new Map([...list.pinned].map((path, index) => [path, index]));
    const byId = new Map(threadItems.map((item) => [item.id, item]));
    const position = (index: number) => {
      const item = byId.get(threadIds[index]!);
      return order.get(item?.externalId ?? item?.remoteId ?? "") ?? 0;
    };
    return groups.flatMap((group) => group.pinnedIndices).sort((a, b) => position(a) - position(b));
  }, [groups, list.pinned, threadIds, threadItems]);

  // The rail asked for a group: bring its header to the top of the list.
  useEffect(() => {
    if (!list.jump) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(groupDomId(list.jump.cwd))?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [list.jump]);

  const chat = tab === "chat";
  const layout = useMemo(() => ({ nested: false, flat: chat }), [chat]);

  return (
    <WorkspacesContext value={workspaces}>
    <TreeContext value={stats}>
    <LayoutContext value={layout}>
    <ThreadListPrimitive.Root data-slot="aui_thread-list-root" data-tab={tab} className="flex flex-col gap-3 px-2 pt-1 pb-3">
      <AuiIf condition={(s) => s.threads.isLoading && s.threads.threadIds.length === 0}>
        <ThreadListSkeleton names={groups.map((g) => g.name)} />
      </AuiIf>
      <AuiIf condition={(s) => !(s.threads.isLoading && s.threads.threadIds.length === 0)}>
        {groups.length === 0 && query.trim() ? (
          <p data-slot="aui_thread-list-empty" className="px-3 py-4 text-sm text-ink-3">
            No session matches “{query.trim()}”.
          </p>
        ) : null}
        {pinnedIndices.length > 0 && (
          <section aria-label="Pinned sessions" data-slot="pinned-sessions">
            <div className="flex h-8 items-center gap-2 px-2 text-xs text-ink-3"><Pin className="size-3.5" /> Pinned</div>
            <div role="list">
              {pinnedIndices.map((index) => <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem: itemComponent(editing, setEditing, onOpen) }} />)}
            </div>
          </section>
        )}
        {chat
          ? groups.map((group) => (
              <ChatGroup key={group.cwd} group={group} editing={editing} onEdit={setEditing} onOpen={onOpen} />
            ))
          : groups.map((group) => (
              <ProjectGroup
                key={group.cwd}
                group={group}
                collapsed={list.collapsed.has(group.cwd) && !query.trim()}
                isCurrent={group.cwd === currentProject}
                canCreate={canCreate}
                editing={editing}
                onEdit={setEditing}
                onOpen={onOpen}
                onNewSession={onNewSession}
              />
            ))}
        {archivedCount > 0 && !query.trim() && !chat && <ArchivedGroup editing={editing} onEdit={setEditing} onOpen={onOpen} />}
      </AuiIf>
    </ThreadListPrimitive.Root>
    </LayoutContext>
    </TreeContext>
    </WorkspacesContext>
  );
};

const EMPTY_WORKSPACES: Workspaces = {};
const sameWorkspaces = (a: Workspaces | undefined, b: Workspaces | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.beam === b.beam && a.chat === b.chat);

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

interface ProjectGroupProps {
  group: ThreadListGroup;
  collapsed: boolean;
  isCurrent: boolean;
  canCreate: boolean;
  editing: string | undefined;
  onEdit(id: string | undefined): void;
  onOpen?: (() => void) | undefined;
  onNewSession?: ((cwd: string) => void) | undefined;
}

const ProjectGroup = memo(function ProjectGroup({ group, collapsed, isCurrent, canCreate, editing, onEdit, onOpen, onNewSession }: ProjectGroupProps) {
  const aui = useAui();
  const { actions, archive } = useLaserStable();
  const sessions = useLaserState((state) => state.sessions);
  const id = groupDomId(group.cwd);
  const listId = `${id}-list`;
  const beam = group.kind === "beam";
  const count = group.roots.length + group.detached.length;
  const total = group.total;
  // Beam sessions start from the Beam bubble and nowhere else (docs/agents.md §7).
  const newSession = beam ? undefined : onNewSession;
  return (
    <section aria-labelledby={`${id}-name`} data-cwd={group.cwd} data-kind={group.kind} data-current={isCurrent || undefined} className="group/project">
      <div id={id} className="sticky top-0 z-10 flex h-8 items-center gap-0.5 rounded-lg bg-surface px-1">
        <button
          type="button"
          onClick={() => sessionsList.toggleCollapsed(group.cwd)}
          aria-expanded={!collapsed}
          aria-controls={listId}
          title={beam ? "Beam: your assistant for the app. Its conversations live here." : `${group.cwd}${isCurrent ? "\nCurrent project: new sessions start here" : ""}`}
          className={cn(
            "flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-start text-ink-3 outline-none hover:bg-surface-2 hover:text-ink-2",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          )}
        >
          <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 transition-transform duration-(--motion-fast) motion-reduce:transition-none", !collapsed && "rotate-90")} />
          {beam ? (
            <Sparkles aria-hidden="true" data-slot="beam-mark" className="size-3.5 shrink-0 text-live" />
          ) : collapsed ? (
            <Folder aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          <span id={`${id}-name`} title={group.name} className="min-w-0 truncate text-sm leading-5 text-ink-2">
            {group.name}
          </span>
          <span className="shrink-0 text-xs text-ink-3 tnum">{total}</span>
        </button>
        {newSession && (
          <TooltipIconButton
            tooltip={`New session in ${group.name}`}
            size="icon-xs"
            className="text-ink-3 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            disabled={!canCreate}
            onClick={() => newSession(group.cwd)}
          >
            <Plus />
          </TooltipIconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip={`Actions for ${group.name}`} size="icon-xs" className="text-ink-3 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100">
              <Ellipsis />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem
              disabled={total === 0}
              onSelect={() => {
                const paths = sessions.filter((session) => session.cwd === group.cwd).map((session) => session.path);
                paths.forEach((path) => archive.add(path));
                void aui.threads.reload();
                actions.toast("info", `${paths.length} chat${paths.length === 1 ? "" : "s"} archived in ${group.name}.`);
              }}
            >
              <Archive /> Archive chats
            </DropdownMenuItem>
            {!beam && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void actions.removeProject(group.cwd)}>
                  <EyeOff /> Remove project
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!collapsed &&
        (count === 0 ? (
          <div id={listId} className="flex items-center gap-2 ps-9 pe-2 py-1 text-xs leading-4 text-ink-3">
            <span>{total > 0 ? "All chats are pinned" : "No chats yet"}</span>
            {total === 0 && newSession && (
              <Button variant="link" size="xs" className="text-xs" disabled={!canCreate} onClick={() => newSession(group.cwd)}>
                Start one
              </Button>
            )}
          </div>
        ) : (
          <div id={listId} role="list">
            {group.roots.map((node) => (
              <SessionBranch key={node.path} node={node} editing={editing} onEdit={onEdit} onOpen={onOpen} />
            ))}
            {group.detached.length > 0 && <DetachedRows nodes={group.detached} editing={editing} onEdit={onEdit} onOpen={onOpen} />}
          </div>
        ))}
    </section>
  );
});

/** The Chat tab: no folder, no header — the conversations themselves, newest first. */
function ChatGroup({ group, editing, onEdit, onOpen }: { group: ThreadListGroup; editing: string | undefined; onEdit(id: string | undefined): void; onOpen?: (() => void) | undefined }) {
  return (
    <section aria-label="Chats" data-cwd={group.cwd} data-kind="chat">
      <div role="list">
        {group.roots.map((node) => (
          <SessionBranch key={node.path} node={node} editing={editing} onEdit={onEdit} onOpen={onOpen} />
        ))}
        {group.detached.length > 0 && <DetachedRows nodes={group.detached} editing={editing} onEdit={onEdit} onOpen={onOpen} />}
      </div>
    </section>
  );
}

interface BranchProps {
  node: ThreadListNode;
  editing: string | undefined;
  onEdit(id: string | undefined): void;
  onOpen?: (() => void) | undefined;
}

/**
 * One row and, beneath it, the rows an agent started from it. Nesting is
 * structural — a child's list lives inside its parent's branch — and drawn
 * as a continuous rail, so lineage survives scrolling, hovering and reflow.
 */
function SessionBranch({ node, editing, onEdit, onOpen }: BranchProps) {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const layout = useContext(LayoutContext);
  const nestedLayout = useMemo(() => ({ nested: true, flat: layout.flat }), [layout.flat]);
  return (
    <div
      data-slot="session-branch"
      data-depth={layout.nested ? undefined : 0}
      className={cn("relative min-w-0", layout.nested && "before:absolute before:-start-1.5 before:top-4 before:h-px before:w-1.5 before:bg-line before:content-['']")}
    >
      <ThreadListPrimitive.ItemByIndex key={threadIds[node.index]} index={node.index} components={{ ThreadListItem: itemComponent(editing, onEdit, onOpen) }} />
      {node.children.length > 0 && (
        <LayoutContext value={nestedLayout}>
          <div
            role="list"
            data-slot="session-children"
            className={cn("relative flex flex-col border-s border-line ps-1.5", layout.nested ? "ms-3" : layout.flat ? "ms-3" : "ms-9")}
          >
            {node.children.map((child) => (
              <SessionBranch key={child.path} node={child} editing={editing} onEdit={onEdit} onOpen={onOpen} />
            ))}
          </div>
        </LayoutContext>
      )}
    </div>
  );
}

/** Children whose parent is gone from the list: still reachable, and labelled as such. */
function DetachedRows({ nodes, editing, onEdit, onOpen }: { nodes: readonly ThreadListNode[] } & Omit<BranchProps, "node">) {
  const layout = useContext(LayoutContext);
  const nestedLayout = useMemo(() => ({ nested: true, flat: layout.flat }), [layout.flat]);
  return (
    <div data-slot="detached-sessions" className={cn("mt-1", layout.flat ? "ps-1" : "ps-7")}>
      <div className="flex h-7 items-center gap-1.5 px-2 text-xs text-ink-3">
        <Unlink aria-hidden="true" className="size-3 shrink-0" />
        <span className="text-xs font-medium">Detached</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Why detached?" className="flex size-5 items-center justify-center rounded-md text-ink-3 outline-none hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:size-6">
              <Info className="size-3" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-56 whitespace-normal">
            An agent started these, but the session that started them is archived or deleted. They still open like any session.
          </TooltipContent>
        </Tooltip>
      </div>
      <LayoutContext value={nestedLayout}>
        <div role="list" className="relative ms-2 flex flex-col border-s border-line ps-1.5">
          {nodes.map((node) => (
            <SessionBranch key={node.path} node={node} editing={editing} onEdit={onEdit} onOpen={onOpen} />
          ))}
        </div>
      </LayoutContext>
    </div>
  );
}

function ArchivedGroup({ editing, onEdit, onOpen }: { editing: string | undefined; onEdit(id: string | undefined): void; onOpen?: (() => void) | undefined }) {
  const archivedIds = useAuiState((s) => s.threads.archivedThreadIds);
  const [open, setOpen] = useState(false);
  const listId = "session-group-archived";
  return (
    <section aria-label="Archived sessions">
      <div className="sticky top-0 z-10 flex h-8 items-center gap-1 rounded-lg bg-surface px-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
        >
          <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", open && "rotate-90")} />
          <Archive aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
          <span className="min-w-0 truncate text-sm leading-5 font-medium text-ink-2">Archived</span>
          <span className="shrink-0 text-xs text-ink-3 tnum">{archivedIds.length}</span>
        </button>
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
  cwd: string;
  status: Status;
  untitled: boolean;
  sub: { text: string; mono: boolean; tone: "attention" | "default" | "muted" };
  modifiedAt: string | undefined;
  messageCount: number;
  /** An agent started this session under another one. */
  child: boolean;
  /** The instance name its parent gave it. */
  subagentName: string | undefined;
  /** The newest run in this session, when the registry knows one. */
  runId: string | undefined;
  runStatus: AgentRunStatus | undefined;
}

const sameRow = (a: RowModel, b: RowModel): boolean =>
  a.cwd === b.cwd &&
  a.status === b.status &&
  a.untitled === b.untitled &&
  a.sub.text === b.sub.text &&
  a.sub.mono === b.sub.mono &&
  a.sub.tone === b.sub.tone &&
  a.modifiedAt === b.modifiedAt &&
  a.messageCount === b.messageCount &&
  a.child === b.child &&
  a.subagentName === b.subagentName &&
  a.runId === b.runId &&
  a.runStatus === b.runStatus;

// `mergeSessions` per row per store change is O(rows × sessions); one merge
// per (catalog, views) pair is O(sessions), and both only change on a catalog
// refresh or a view opening.
const mergedCache = new WeakMap<readonly SessionSummary[], { open: object; byPath: ReadonlyMap<string, SessionSummary> }>();
function mergedByPath(s: AppState): ReadonlyMap<string, SessionSummary> {
  const cached = mergedCache.get(s.sessions);
  if (cached && cached.open === s.open) return cached.byPath;
  const byPath = new Map(mergeSessions(s.sessions, s.open).map((summary) => [summary.path, summary]));
  mergedCache.set(s.sessions, { open: s.open, byPath });
  return byPath;
}

const NO_ROW: RowModel = { cwd: "", status: "idle", untitled: true, sub: { text: "No messages yet", mono: false, tone: "muted" }, modifiedAt: undefined, messageCount: 0, child: false, subagentName: undefined, runId: undefined, runStatus: undefined };

/** What the runtime's item state lacks, from the laser store, for one path. */
function useRowModel(path: string | undefined): RowModel {
  return useLaserState(
    useCallback(
      (s: AppState): RowModel => {
        const summary = path ? mergedByPath(s).get(path) : undefined;
        const view = path ? s.open[path] : undefined;
        if (!summary || !path) return NO_ROW;
        const info = summary.agent ?? view?.state.agent;
        const run = latestRunsBySession(s.agents.runs).get(path);
        return {
          cwd: summary.cwd,
          status: sessionStatus(view, summary),
          untitled: isUntitled(summary, view),
          sub: sessionSubtitle(summary, view),
          modifiedAt: summary.modifiedAt,
          messageCount: summary.messageCount,
          child: info?.kind === "child" || summary.parentPath !== undefined,
          subagentName: info?.subagentName,
          runId: run?.runId ?? info?.runId,
          runStatus: run?.status ?? info?.runStatus,
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
  const { pinned } = useSessionsList();
  const workspaces = useContext(WorkspacesContext);
  const layout = useContext(LayoutContext);
  const stats = useContext(TreeContext).get(path ?? "");
  const isPinned = !archived && !row.child && pinned.has(path ?? "");
  const isEditing = editing === id;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const beam = workspaceKindOf(row.cwd, workspaces) === "beam";

  const shownTitle = title ?? (path ? path.split("/").pop()?.slice(0, 8) : "New session") ?? "New session";
  // A child leads with the instance name its parent gave it; the session's
  // own title follows only when it says something more.
  const childLabel = row.child ? (row.subagentName ?? shownTitle) : undefined;
  const childTitle = row.child && row.subagentName !== undefined && shownTitle !== row.subagentName ? shownTitle : undefined;
  const activeRun = row.runStatus !== undefined && ACTIVE_RUN.has(row.runStatus);
  const stateWord = row.child && row.runStatus !== undefined && (activeRun || row.runStatus === "blocked") ? runStatusLabel(row.runStatus) : undefined;
  const stateTone: AgentStatusTone | undefined = row.runStatus !== undefined ? runStatusTone(row.runStatus) : undefined;

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      data-active={active || undefined}
      data-pinned={isPinned || undefined}
      data-child={row.child || undefined}
      data-run-status={row.runStatus}
      data-beam={beam || undefined}
      className={cn("group relative rounded-lg", active && "bg-surface-2")}
    >
      {isEditing ? (
        <div className="flex items-center gap-2.5 px-3 py-2">
          <SessionActivity status={row.status} />
          <RenameField onDone={() => onEdit(undefined)} />
        </div>
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          aria-current={active ? "page" : undefined}
          title={[childLabel ? `${childLabel} · ${shownTitle}` : shownTitle, row.cwd, row.runStatus && row.child ? runStatusLabel(row.runStatus) : "", row.sub.text, row.modifiedAt ? dateTime(row.modifiedAt) : ""].filter(Boolean).join("\n")}
          onClick={onOpen}
          onDoubleClick={(e) => {
            e.preventDefault();
            onEdit(id);
          }}
          className={cn(
            "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg pe-9 py-1 text-start [@media(pointer:coarse)]:min-h-11",
            "transition-colors duration-(--motion-instant) outline-none",
            "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)] active:bg-surface-2",
            "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
            isPinned || layout.nested || layout.flat ? "ps-3" : "ps-9",
          )}
        >
          {row.child && row.runStatus !== undefined && stateTone ? <RunDot status={row.runStatus} tone={stateTone} /> : null}
          {beam ? <Sparkles aria-hidden="true" data-slot="beam-row-mark" className="size-3 shrink-0 text-live" /> : null}
          <span
            data-slot="aui_thread-list-item-title"
            // The row's own title, so a name the column cuts is still readable
            // and still the accessible name (DESIGN.md, legibility floor).
            title={childLabel ? `${childLabel} · ${shownTitle}` : shownTitle}
            className={cn("flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-5", row.untitled && !childLabel ? "text-ink-3" : active ? "text-ink" : "text-ink-2")}
          >
            {childLabel ? (
              <>
                <span data-slot="subagent-name" className="min-w-0 shrink truncate font-medium">{childLabel}</span>
                {childTitle ? <span className="min-w-0 shrink-[2] truncate text-xs text-ink-3">{childTitle}</span> : null}
              </>
            ) : (
              <span className="min-w-0 truncate"><ThreadListItemPrimitive.Title fallback={shownTitle} /></span>
            )}
          </span>
          {isPinned && row.cwd && <span data-slot="pinned-session-project" title={row.cwd} aria-label={`Project: ${row.cwd}`} className="max-w-16 shrink-0 truncate rounded-sm bg-surface-2 px-1 text-xs leading-4 text-ink-3">{shortCwd(row.cwd)}</span>}
          {stats && !archived && (
            <span
              data-slot="session-children-chip"
              className={cn("shrink-0 rounded-sm px-1 text-xs leading-4 tnum", stats.running > 0 ? "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live" : "bg-surface-2 text-ink-3")}
              title={`${stats.count} agent${stats.count === 1 ? "" : "s"} started here${stats.running > 0 ? `, ${stats.running} still working` : ""}`}
            >
              {stats.running > 0 ? `${stats.running} running` : `${stats.count} agent${stats.count === 1 ? "" : "s"}`}
            </span>
          )}
          {stateWord ? (
            <span data-slot="run-state" className={cn("shrink-0 text-xs leading-4", stateTone === "live" ? "text-live" : stateTone === "attention" ? "text-attention" : "text-ink-3")}>
              {stateWord}
            </span>
          ) : (
            <SessionActivity status={archived ? "idle" : row.status} />
          )}
        </ThreadListItemPrimitive.Trigger>
      )}
      {!isEditing && (
        <ThreadListItemMore
          path={path}
          title={childLabel ?? shownTitle}
          archived={archived}
          child={row.child}
          endable={activeRun ? row.runId : undefined}
          onRename={() => onEdit(id)}
          onOpen={onOpen}
        />
      )}
    </ThreadListItemPrimitive.Root>
  );
};

/**
 * A child row's dot: its run's status in the tone `runStatusTone` names, with
 * the shared sweep while it works and the attention pulse while it is blocked.
 * Reduced motion keeps the colour and the accessible name.
 */
function RunDot({ status, tone }: { status: AgentRunStatus; tone: AgentStatusTone }) {
  const color = TONE_COLOR[tone === "muted" ? "neutral" : tone];
  return (
    <span
      role="img"
      aria-label={runStatusLabel(status)}
      data-slot="run-dot"
      data-run-status={status}
      className={cn("relative inline-block size-2 shrink-0 rounded-full bg-(--dot)", status === "blocked" && "motion-safe:animate-attention")}
      style={{ "--dot": color } as React.CSSProperties}
    >
      {status === "running" && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -inset-0.75 rounded-full motion-safe:animate-sweep",
            "bg-[conic-gradient(from_0deg,transparent_0deg,transparent_250deg,color-mix(in_oklab,var(--dot)_55%,transparent)_360deg)]",
            "[mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-2px))]",
            "motion-reduce:hidden",
          )}
        />
      )}
    </span>
  );
}

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

function ThreadListItemMore({
  path,
  title,
  archived,
  child,
  endable,
  onRename,
  onOpen,
}: {
  path: string | undefined;
  title: string;
  archived: boolean;
  /** A child session: its menu leads with Open and offers to end its run while it works. */
  child: boolean;
  /** The run id to end, present only while the child's run is queued or running. */
  endable: string | undefined;
  onRename(): void;
  onOpen?: (() => void) | undefined;
}) {
  const aui = useAui();
  const { actions } = useLaserStable();
  const { copy } = useCopy();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { pinned } = useSessionsList();
  const isPinned = pinned.has(path ?? "");
  const copyPath = () => {
    if (!path) return;
    void copy(path).then((ok) => actions.toast(ok ? "info" : "error", ok ? "Session path copied" : "Could not copy the path"));
  };
  return (
    <div
      className={cn(
        "absolute end-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-(--motion-instant)",
        "group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
        "[@media(pointer:coarse)]:opacity-100",
      )}
    >
      <ThreadListItemMorePrimitive.Root sharedFocusGroup>
        <ThreadListItemMorePrimitive.Trigger asChild>
          <TooltipIconButton tooltip={`Actions for ${title}`} size="icon-xs" className="text-ink-3">
            <Ellipsis />
          </TooltipIconButton>
        </ThreadListItemMorePrimitive.Trigger>
        <ThreadListItemMorePrimitive.Content align="end" sideOffset={4} data-slot="aui_thread-list-item-more-content" className={menuContentClass}>
          {child && !archived && (
            <ThreadListItemMorePrimitive.Item
              className={menuItemClass}
              onSelect={() => {
                aui.threadListItem.switchTo();
                onOpen?.();
              }}
            >
              <MessageSquare />
              Open
            </ThreadListItemMorePrimitive.Item>
          )}
          {!archived && !child && (
            <ThreadListItemMorePrimitive.Item className={menuItemClass} disabled={!path} onSelect={() => path && sessionsList.togglePinned(path)}>
              {isPinned ? <PinOff /> : <Pin />}
              {isPinned ? "Unpin chat" : "Pin chat"}
            </ThreadListItemMorePrimitive.Item>
          )}
          {!archived && (
            <ThreadListItemMorePrimitive.Item className={menuItemClass} onSelect={onRename}>
              <Pencil />
              Rename
            </ThreadListItemMorePrimitive.Item>
          )}
          {endable !== undefined && !archived && (
            <ThreadListItemMorePrimitive.Item data-slot="end-agent-item" className={cn(menuItemClass, "text-danger focus:text-danger [&_svg]:text-danger")} onSelect={() => requestEndAgent(endable)}>
              <CircleStop />
              End agent…
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
        <section key={`${name}-${g}`} className="mb-3">
          <div className="flex h-8 items-center gap-2 px-2">
            <Skeleton className="size-3.5 rounded-sm" />
            {name ? <span className="text-sm leading-5 font-medium text-ink-2">{name}</span> : <SkeletonText width="40%" />}
          </div>
          <ul role="list" className="pb-1">
            {[72, 56].map((w, i) => (
              <li key={i} className="flex h-8 items-center ps-9 pe-3">
                <SkeletonText width={`${w}%`} className="my-0.75" />
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
