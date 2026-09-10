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
 *
 * Since M13-T24, that nest folds, in two layers (`session-folds.ts`):
 *   - **A parent's sub-sessions fold** behind a disclosure in the row's own
 *     leading gutter — not a row of its own, so the list keeps one row per
 *     session. It opens itself while anything under it is live and stays open
 *     once opened; the person's toggle wins over that default and is
 *     remembered per device.
 *   - **The settled ones fold again**, into a second disclosure beneath the
 *     live ones, closed by default and dimmed when open. It names how many and
 *     how many failed, and a failed child keeps its normal ink and its danger
 *     dot inside it: dimming must never be the reason you cannot find the one
 *     that went wrong.
 *   - A branch is "settled" only when its whole subtree is, so a completed
 *     child that still has a working grandchild stays with the live ones —
 *     the fleet sheet's rule (docs/ux-elements.md "Subagent list"), for the
 *     same reason: moving a finished parent away from live work is tidier and
 *     structurally false. "Needs you" is live here even though the protocol
 *     calls it terminal: a question for the person is the last thing to hide.
 *   - A typed query flattens the tree (below), so **search is never folded
 *     away**: every match is a root of its group and renders unconditionally.
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
  FolderInput,
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
import { describeWorktreeContents, forgetWorktreeDisposition, setWorktreeDisposition, useWorktreeStatus } from "@/agents/worktree";
import { requestEndAgent } from "@/components/agents/end-agent";
import { requestMoveSession } from "@/components/shell/move-session";
import { collapsePanel } from "@/components/assistant-ui/elements/surfaces";
import { foldKey, sessionFolds, useFoldOpen } from "@/components/assistant-ui/elements/session-folds";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  /** What the row is called: the instance name a parent gave it, else its title. */
  label: string;
  children: ThreadListNode[];
}

export interface ThreadListGroup {
  cwd: string;
  name: string;
  kind: SessionGroupKind;
  /** Top-level rows, newest first; each carries its children. */
  roots: ThreadListNode[];
  /** Pinned top-level rows, with their children; rendered in the Pinned section. */
  pinned: ThreadListNode[];
  /** Children whose parent is not in the list any more, newest first. */
  detached: ThreadListNode[];
  /** Unpinned top-level indices, newest first (the flattened `roots`). */
  indices: number[];
  pinnedIndices: number[];
  /** Every row the group holds, nested ones included. */
  total: number;
}

/**
 * What a parent row knows about the rows beneath it: the two folds, and the
 * tally its chip shows without opening either of them.
 */
export interface BranchInfo {
  /** Direct children whose branch still has work in it, in start order. */
  live: readonly ThreadListNode[];
  /** Direct children whose whole branch has settled, in start order. */
  finished: readonly ThreadListNode[];
  /** How many rows the finished fold holds, at every depth. */
  finishedRows: number;
  /** How many finished-fold rows failed. Named on that fold. */
  finishedFailed: number;
  /** Every failed run below this row, including a live branch's parent. */
  failed: number;
  /** Every row beneath this one, at every depth. */
  total: number;
  running: number;
  /** Runs waiting on the person. Terminal to the protocol; live to a reader. */
  blocked: number;
  /** Queued, or a child whose run the registry has not named yet. */
  waiting: number;
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
  /** The row's spoken name: the instance name its parent gave it, else its title. */
  label: string;
  parentPath: string | undefined;
  child: boolean;
  workspaceKind: "beam" | "chat" | undefined;
  modifiedAt: number;
  /** When the row was born: the run's start, else the catalog's `createdAt`. */
  startedAt: number;
}

const ACTIVE_RUN: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>(["running", "queued", "needs_input"]);

/**
 * What the finished fold may swallow. The protocol calls `blocked` terminal
 * (`AGENT_RUN_TERMINAL`) because the run's own loop has stopped, but to a
 * reader it is "Needs you" — the single most attention-worthy thing the panel
 * can show (DESIGN.md "Status language"). It stays with the live children.
 */
const SETTLED_RUN: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>(["completed", "failed", "cancelled"]);

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
      const title = item.title ?? "";
      const meta: ItemMeta = {
        index,
        path,
        cwd: str(custom["cwd"]) ?? "",
        title,
        // A child answers to the instance name its parent gave it; that is
        // what its row leads with, so that is what its disclosure is called.
        label: str(custom["subagentName"]) ?? (title !== "" ? title : (path.split("/").pop() ?? path)),
        parentPath,
        child: custom["agentKind"] === "child" || parentPath !== undefined,
        workspaceKind: custom["agentKind"] === "beam" || custom["agentKind"] === "chat" ? custom["agentKind"] : undefined,
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
      if (cursor !== meta || !meta.child) {
        const workspaceKind = cursor.workspaceKind ?? workspaceKindOf(cursor.cwd, workspaces);
        return workspaceKind ? (workspaces[workspaceKind] ?? cursor.cwd) : cursor.cwd;
      }
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
      label: meta.label,
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
        // A pinned row keeps its whole branch: it moves to the Pinned section
        // with its children, rather than leaving them nowhere in the list.
        const pinnedRoots = held.roots.filter(isPinned);
        return {
          cwd,
          name: groupNameOf(cwd, kind),
          kind,
          roots: unpinned,
          pinned: pinnedRoots,
          detached: held.detached,
          indices: unpinned.map((node) => node.index),
          pinnedIndices: pinnedRoots.map((node) => node.index),
          total: countNodes(held.roots) + countNodes(held.detached),
        };
      });
  }, [threadIds, threadItems, runs, projects, filter, needle, pinned, tab, workspaces]);
}

/**
 * What sits under each parent: the two folds and the state its gutter mark shows.
 * One walk per (tree, run registry) pair — a row never recomputes this, and a
 * status change never moves a row that did not change fold.
 *
 * Only rows that actually have children get an entry, so "no children" needs
 * no empty affordance anywhere: there is simply nothing to draw.
 */
function branchInfoOf(groups: readonly ThreadListGroup[], runs: Readonly<Record<string, AgentRun>>): ReadonlyMap<string, BranchInfo> {
  const latest = latestRunsBySession(runs);
  const statusOf = (node: ThreadListNode): AgentRunStatus | undefined => latest.get(node.path)?.status;
  const info = new Map<string, BranchInfo>();

  // A branch has settled only when everything inside it has. A completed child
  // with a working grandchild stays with the live ones (docs/ux-elements.md
  // "Subagent list": lifecycle partitioning moves whole branches).
  const settled = (node: ThreadListNode): boolean => {
    const status = statusOf(node);
    return status !== undefined && SETTLED_RUN.has(status) && node.children.every(settled);
  };
  const rows = (node: ThreadListNode): number => 1 + node.children.reduce((n, child) => n + rows(child), 0);
  const failures = (node: ThreadListNode): number =>
    (statusOf(node) === "failed" ? 1 : 0) + node.children.reduce((n, child) => n + failures(child), 0);

  const walk = (node: ThreadListNode): void => {
    node.children.forEach(walk);
    if (node.children.length === 0) return;
    const live: ThreadListNode[] = [];
    const finished: ThreadListNode[] = [];
    for (const child of node.children) (settled(child) ? finished : live).push(child);
    let total = 0;
    let running = 0;
    let blocked = 0;
    let waiting = 0;
    let failed = 0;
    const tally = (child: ThreadListNode): void => {
      total += 1;
      const status = statusOf(child);
      if (status === "running") running += 1;
      // Both need someone: one ended saying so, one is live and paused on a question.
      else if (status === "blocked" || status === "needs_input") blocked += 1;
      else if (status === "queued" || status === undefined) waiting += 1;
      else if (status === "failed") failed += 1;
      child.children.forEach(tally);
    };
    node.children.forEach(tally);
    info.set(node.path, {
      live,
      finished,
      finishedRows: finished.reduce((n, child) => n + rows(child), 0),
      finishedFailed: finished.reduce((n, child) => n + failures(child), 0),
      failed,
      total,
      running,
      blocked,
      waiting,
    });
  };
  for (const group of groups) {
    group.roots.forEach(walk);
    group.pinned.forEach(walk);
    group.detached.forEach(walk);
  }
  return info;
}

/**
 * The state a parent disclosure inherits from its agents. It has to agree
 * with what the two folds hold without opening either, so it takes the most
 * attention-worthy thing at every depth. Order follows the protocol attention
 * rank: needs you, then failed, then working, then waiting, then done.
 */
export function branchTone(info: BranchInfo): AgentStatusTone | undefined {
  if (info.blocked > 0) return "attention";
  if (info.failed > 0) return "danger";
  if (info.running > 0) return "live";
  if (info.waiting > 0) return "muted";
  // Nothing live under the row: no mark. The finished fold below owns the
  // terminal count; repeating it beside the title would cost name width.
  return undefined;
}

/** The whole picture, for the disclosure and row tooltips: every count. */
export function branchSummary(info: BranchInfo): string {
  const parts: string[] = [];
  if (info.running > 0) parts.push(`${info.running} working`);
  if (info.blocked > 0) parts.push(`${info.blocked} needs you`);
  if (info.waiting > 0) parts.push(`${info.waiting} waiting`);
  const done = info.total - info.running - info.blocked - info.waiting;
  if (done > 0) parts.push(info.failed > 0 ? `${done} finished, ${info.failed} of them failed` : `${done} finished`);
  return `${info.total} agent${info.total === 1 ? "" : "s"} under this session${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * The folded branch's state without a width-taking tag. The disclosure's
 * accessible name carries the complete words and counts; this mark keeps the
 * same semantic tone and motion in the gutter when the child rows are hidden.
 */
function BranchStatusMark({ tone }: { tone: AgentStatusTone }) {
  const color = TONE_COLOR[tone === "muted" ? "neutral" : tone];
  return (
    <span
      aria-hidden="true"
      data-slot="session-fold-status"
      data-tone={tone}
      className={cn(
        "absolute end-0 top-1 inline-block size-2 rounded-full bg-(--dot)",
        tone === "attention" && "motion-safe:animate-attention",
      )}
      style={{ "--dot": color } as React.CSSProperties}
    >
      {tone === "live" ? (
        <span
          className={cn(
            "absolute -inset-0.75 rounded-full motion-safe:animate-sweep",
            "bg-[conic-gradient(from_0deg,transparent_0deg,transparent_250deg,color-mix(in_oklab,var(--dot)_55%,transparent)_360deg)]",
            "[mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-2px))]",
            "motion-reduce:hidden",
          )}
        />
      ) : null}
    </span>
  );
}

/** The rows between a group and one path, outermost first; empty when it is not here. */
function lineageTo(nodes: readonly ThreadListNode[], path: string): ThreadListNode[] {
  for (const node of nodes) {
    if (node.path === path) return [node];
    const below = lineageTo(node.children, path);
    if (below.length > 0) return [node, ...below];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Contexts the rows read (a row reads its item from scope, not from props)
// ---------------------------------------------------------------------------

const EMPTY_TREE: ReadonlyMap<string, BranchInfo> = new Map();
const TreeContext = createContext<ReadonlyMap<string, BranchInfo>>(EMPTY_TREE);

/**
 * How the rows of one list are drawn.
 *   - `nested`: under a lineage rail, one step in from its parent.
 *   - `flat`: a list with no folder indent (the Chat tab, the Pinned section).
 *   - `gutter`: this list reserves the leading disclosure column, because at
 *     least one row in it has children. Reserving it per list rather than per
 *     row keeps siblings on one text edge; leaving it out where nothing nests
 *     keeps a flat list from looking indented for no reason.
 *   - `dimmed`: inside a finished fold. The row quiets down — except a failed
 *     one, which is exactly what the reader came in here to find.
 */
interface RowLayout {
  nested: boolean;
  flat: boolean;
  gutter: boolean;
  dimmed: boolean;
}
const ROOT_LAYOUT: RowLayout = { nested: false, flat: false, gutter: false, dimmed: false };
const LayoutContext = createContext<RowLayout>(ROOT_LAYOUT);

/** Does any row of this list have children? Then the whole list keeps the gutter. */
const needsGutter = (nodes: readonly ThreadListNode[]): boolean => nodes.some((node) => node.children.length > 0);
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
  const tree = useMemo(() => branchInfoOf(groups, runs), [groups, runs]);
  const archivedCount = useAuiState((s) => s.threads.archivedThreadIds.length);
  const { currentProject } = useLaserStable();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const openPath = useAuiState((s) => {
    const item = s.threads.threadItems.find((candidate) => candidate.id === s.threads.mainThreadId);
    return item?.externalId ?? item?.remoteId ?? "";
  });
  const pinnedNodes = useMemo(() => {
    const order = new Map([...list.pinned].map((path, index) => [path, index]));
    return groups
      .flatMap((group) => group.pinned)
      .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  }, [groups, list.pinned]);

  // The rail asked for a group: bring its header to the top of the list.
  useEffect(() => {
    if (!list.jump) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(groupDomId(list.jump.cwd))?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [list.jump]);

  // Wherever the open session lives, its lineage opens: selecting a child from
  // the map, a link or a reload must never leave the person looking at a list
  // that does not contain the thing they are reading. It only ever opens, so a
  // branch they closed by hand stays closed until they open that session.
  useEffect(() => {
    if (!openPath) return;
    for (const group of groups) {
      const chain = lineageTo([...group.roots, ...group.pinned, ...group.detached], openPath);
      if (chain.length < 2) continue;
      chain.slice(0, -1).forEach((ancestor, depth) => {
        sessionFolds.reveal(foldKey("children", ancestor.path));
        if (tree.get(ancestor.path)?.finished.includes(chain[depth + 1]!)) sessionFolds.reveal(foldKey("finished", ancestor.path));
      });
      return;
    }
  }, [openPath, groups, tree]);

  const chat = tab === "chat";
  const layout = useMemo<RowLayout>(() => ({ ...ROOT_LAYOUT, flat: chat }), [chat]);
  const pinnedLayout = useMemo<RowLayout>(() => ({ ...ROOT_LAYOUT, flat: true, gutter: needsGutter(pinnedNodes) }), [pinnedNodes]);

  return (
    <WorkspacesContext value={workspaces}>
    <TreeContext value={tree}>
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
        {pinnedNodes.length > 0 && (
          <section aria-label="Pinned sessions" data-slot="pinned-sessions">
            <div className="flex h-8 items-center gap-2 px-2 text-xs text-ink-3"><Pin className="size-3.5" /> Pinned</div>
            <LayoutContext value={pinnedLayout}>
              <div role="list">
                {/* A pinned parent brings its branch with it, folds and all;
                    leaving its children behind would make them unreachable. */}
                {pinnedNodes.map((node) => (
                  <SessionBranch key={node.path} node={node} editing={editing} onEdit={setEditing} onOpen={onOpen} />
                ))}
              </div>
            </LayoutContext>
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
  // Beam's group starts a Beam chat, which opens in the window rather than in
  // the bubble; the panel decides which agent a directory means (D-143).
  const newSession = onNewSession;
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
            tooltip={beam ? `New ${group.name} chat` : `New session in ${group.name}`}
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
  const layout = useContext(LayoutContext);
  const own = useMemo<RowLayout>(() => ({ ...layout, gutter: needsGutter(group.roots) }), [layout, group.roots]);
  return (
    <section aria-label="Chats" data-cwd={group.cwd} data-kind="chat">
      <LayoutContext value={own}>
      <div role="list">
        {group.roots.map((node) => (
          <SessionBranch key={node.path} node={node} editing={editing} onEdit={onEdit} onOpen={onOpen} />
        ))}
        {group.detached.length > 0 && <DetachedRows nodes={group.detached} editing={editing} onEdit={onEdit} onOpen={onOpen} />}
      </div>
      </LayoutContext>
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
 *
 * The rail folds. Its disclosure sits in the row's own leading gutter rather
 * than on a row of its own, so the list keeps its one-row-per-session rhythm
 * and the fold reads as a property of the parent, not as another thing in the
 * list. It is a real button: name, `aria-expanded`, `aria-controls`, hover,
 * focus and pressed states, Enter and Space. It deliberately does not bind
 * ArrowRight/ArrowLeft — `ThreadListItemPrimitive.Root` already spends those
 * moving between a row and its more-menu, and one list may only have one
 * keyboard model.
 */
function SessionBranch({ node, editing, onEdit, onOpen }: BranchProps) {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const layout = useContext(LayoutContext);
  const info = useContext(TreeContext).get(node.path);
  const live = info?.live.length ?? 0;
  const childrenKey = foldKey("children", node.path);
  // The default: open while there is live work under the row. `reveal` pins
  // that the moment it is true, so the branch stays put when the work ends.
  const open = useFoldOpen(childrenKey, live > 0);
  useEffect(() => {
    if (live > 0) sessionFolds.reveal(childrenKey);
  }, [live, childrenKey]);

  const contentId = `${branchDomId(node.path)}-children`;
  const nestedLayout = useMemo<RowLayout>(
    () => ({ nested: true, flat: layout.flat, gutter: needsGutter(node.children), dimmed: layout.dimmed }),
    [layout.flat, layout.dimmed, node.children],
  );
  const count = info?.total ?? 0;
  const branchStatusTone = info ? branchTone(info) : undefined;
  return (
    <div
      data-slot="session-branch"
      data-depth={layout.nested ? undefined : 0}
      className={cn("relative min-w-0", layout.nested && "before:absolute before:-start-1.5 before:top-4 before:h-px before:w-1.5 before:bg-line before:content-['']")}
    >
      <div className="relative min-w-0">
        {info && (
          <button
            type="button"
            data-slot="session-fold"
            aria-expanded={open}
            aria-controls={contentId}
            aria-label={`${open ? "Hide" : "Show"} the ${count === 1 ? "agent" : `${count} agents`} under ${node.label}. ${branchSummary(info)}`}
            title={branchSummary(info)}
            onClick={() => sessionFolds.set(childrenKey, !open)}
            className={cn(
              // Full row height, and on a coarse pointer the full width of the
              // gutter it sits in — never a pixel past it, or it would start
              // eating taps meant for the row (DESIGN.md, touch targets).
              "absolute inset-y-0 z-10 flex w-5 cursor-pointer items-center justify-center rounded-md text-ink-3 outline-none",
              "transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink active:bg-surface-2 motion-reduce:transition-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              layout.nested || layout.flat ? "start-0.5 pointer-coarse:w-6" : "start-2 pointer-coarse:w-7",
            )}
          >
            <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", open && "rotate-90")} />
            {branchStatusTone ? <BranchStatusMark tone={branchStatusTone} /> : null}
          </button>
        )}
        <ThreadListPrimitive.ItemByIndex key={threadIds[node.index]} index={node.index} components={{ ThreadListItem: itemComponent(editing, onEdit, onOpen) }} />
      </div>
      {info && (
        <Collapsible open={open} onOpenChange={(next) => sessionFolds.set(childrenKey, next)}>
          <CollapsibleContent id={contentId} className={collapsePanel}>
            <LayoutContext value={nestedLayout}>
              <div
                role="list"
                data-slot="session-children"
                className={cn("relative flex flex-col border-s border-line ps-1.5", layout.nested ? "ms-3" : layout.flat ? "ms-3" : "ms-9")}
              >
                {info.live.map((child) => (
                  <SessionBranch key={child.path} node={child} editing={editing} onEdit={onEdit} onOpen={onOpen} />
                ))}
                {info.finished.length > 0 && <FinishedFold parent={node} info={info} editing={editing} onEdit={onEdit} onOpen={onOpen} />}
              </div>
            </LayoutContext>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/**
 * The second fold: the agents that are done, under the ones that are not.
 * Closed by default — finished work is history, and history does not get to
 * push live work off the screen — and dimmed when open, except a failure,
 * which keeps its ink and is counted on the trigger itself.
 */
function FinishedFold({ parent, info, editing, onEdit, onOpen }: { parent: ThreadListNode; info: BranchInfo } & Omit<BranchProps, "node">) {
  const layout = useContext(LayoutContext);
  const key = foldKey("finished", parent.path);
  const open = useFoldOpen(key, false);
  const dimmedLayout = useMemo<RowLayout>(() => ({ ...layout, gutter: needsGutter(info.finished), dimmed: true }), [layout, info.finished]);
  return (
    <Collapsible open={open} onOpenChange={(next) => sessionFolds.set(key, next)} data-slot="finished-sessions">
      <CollapsibleTrigger
        data-slot="finished-fold"
        // Several branches can show "3 finished" at once, so the name says
        // whose, and says out loud what the red count says in colour.
        aria-label={`${open ? "Hide" : "Show"} the ${info.finishedRows === 1 ? "finished agent" : `${info.finishedRows} finished agents`} under ${parent.label}${info.finishedFailed > 0 ? `, ${info.finishedFailed} failed` : ""}`}
        className={cn(
          "group/finished flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 text-start text-ink-3 outline-none",
          "transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink-2 active:bg-surface-2 motion-reduce:transition-none",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live pointer-coarse:h-11",
        )}
      >
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform duration-(--motion-fast) group-data-[state=open]/finished:rotate-90 motion-reduce:transition-none" />
        <span className="min-w-0 truncate text-xs leading-4">
          <span className="tnum">{info.finishedRows}</span> finished
        </span>
        {info.finishedFailed > 0 && (
          <span data-slot="finished-failed" className="shrink-0 text-xs leading-4 text-danger">
            <span className="tnum">{info.finishedFailed}</span> failed
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={collapsePanel}>
        <LayoutContext value={dimmedLayout}>
          <div role="list" data-slot="finished-children">
            {info.finished.map((child) => (
              <SessionBranch key={child.path} node={child} editing={editing} onEdit={onEdit} onOpen={onOpen} />
            ))}
          </div>
        </LayoutContext>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A stable DOM id for one branch's fold, so its button can name what it controls. */
function branchDomId(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return `session-branch-${h.toString(36)}`;
}

/** Children whose parent is gone from the list: still reachable, and labelled as such. */
function DetachedRows({ nodes, editing, onEdit, onOpen }: { nodes: readonly ThreadListNode[] } & Omit<BranchProps, "node">) {
  const layout = useContext(LayoutContext);
  const nestedLayout = useMemo<RowLayout>(() => ({ nested: true, flat: layout.flat, gutter: needsGutter(nodes), dimmed: false }), [layout.flat, nodes]);
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
  workspaceKind: "beam" | "chat" | undefined;
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
  a.workspaceKind === b.workspaceKind &&
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

const NO_ROW: RowModel = { cwd: "", status: "idle", untitled: true, sub: { text: "No messages yet", mono: false, tone: "muted" }, modifiedAt: undefined, messageCount: 0, child: false, workspaceKind: undefined, subagentName: undefined, runId: undefined, runStatus: undefined };

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
          workspaceKind: info?.kind === "beam" || info?.kind === "chat" ? info.kind : undefined,
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
  const info = useContext(TreeContext).get(path ?? "");
  const isPinned = !archived && !row.child && pinned.has(path ?? "");
  const isEditing = editing === id;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const workspaceKind = row.workspaceKind ?? workspaceKindOf(row.cwd, workspaces);
  const beam = workspaceKind === "beam";
  const workspaceLabel = workspaceKind ? groupNameOf(row.cwd, workspaceKind) : shortCwd(row.cwd);
  // A Chat conversation of its own (not one an agent started under it) can
  // move into a project (M13-T58); the same rule that put it in the Chat tab.
  const movable = workspaceKind === "chat" && !row.child && !archived;

  const shownTitle = title ?? (path ? path.split("/").pop()?.slice(0, 8) : "New session") ?? "New session";
  // A child leads with the instance name its parent gave it; the session's
  // own title follows only when it says something more.
  const childLabel = row.child ? (row.subagentName ?? shownTitle) : undefined;
  const childTitle = row.child && row.subagentName !== undefined && shownTitle !== row.subagentName ? shownTitle : undefined;
  const activeRun = row.runStatus !== undefined && ACTIVE_RUN.has(row.runStatus);
  const stateTone: AgentStatusTone | undefined = row.runStatus !== undefined ? runStatusTone(row.runStatus) : undefined;
  // Inside the finished fold the row quiets down — but a failure keeps its ink
  // and its dot, and so does the session you are reading right now.
  const dimmed = layout.dimmed && row.runStatus !== "failed" && !active;

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      data-active={active || undefined}
      data-pinned={isPinned || undefined}
      data-child={row.child || undefined}
      data-run-status={row.runStatus}
      data-beam={beam || undefined}
      data-dimmed={dimmed || undefined}
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
          title={[childLabel ? `${childLabel} · ${shownTitle}` : shownTitle, row.cwd, row.runStatus && row.child ? runStatusLabel(row.runStatus) : "", info?.total ? branchSummary(info) : "", row.sub.text, row.modifiedAt ? dateTime(row.modifiedAt) : ""].filter(Boolean).join("\n")}
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
            // A root row's folder indent already holds the disclosure; a
            // nested or flat list only widens when something in it nests, so
            // one sibling gaining a child never moves the other siblings' text.
            layout.nested || layout.flat ? (layout.gutter ? "ps-6" : "ps-3") : isPinned ? "ps-3" : "ps-9",
          )}
        >
          {row.child && row.runStatus !== undefined && stateTone ? <RunDot status={row.runStatus} tone={stateTone} /> : null}
          <span
            data-slot="aui_thread-list-item-title"
            // The row's own title, so a name the column cuts is still readable
            // and still the accessible name (DESIGN.md, legibility floor).
            title={childLabel ? `${childLabel} · ${shownTitle}` : shownTitle}
            className={cn(
              "flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-5",
              dimmed || (row.untitled && !childLabel) ? "text-ink-3" : active ? "text-ink" : "text-ink-2",
            )}
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
          {isPinned && row.cwd && <span data-slot="pinned-session-project" {...(workspaceKind ? {} : { title: row.cwd })} aria-label={workspaceKind ? `Workspace: ${workspaceLabel}` : `Project: ${row.cwd}`} className="max-w-16 shrink-0 truncate rounded-sm bg-surface-2 px-1 text-xs leading-4 text-ink-3">{workspaceLabel}</span>}
          {/* Active child runs already lead with their complete state mark.
              Once the run settles, keep the session's own trailing activity:
              it can independently be unread or in error. */}
          {row.child && row.runStatus !== undefined && (ACTIVE_RUN.has(row.runStatus) || row.runStatus === "blocked")
            ? null
            : <SessionActivity status={archived ? "idle" : row.status} />}
        </ThreadListItemPrimitive.Trigger>
      )}
      {!isEditing && (
        <ThreadListItemMore
          path={path}
          title={childLabel ?? shownTitle}
          archived={archived}
          child={row.child}
          endable={activeRun ? row.runId : undefined}
          movable={movable}
          onRename={() => onEdit(id)}
          onOpen={onOpen}
        />
      )}
    </ThreadListItemPrimitive.Root>
  );
};

/**
 * A child row's dot: its run's status in the tone `runStatusTone` names, with
 * the shared sweep while it works and the attention pulse while it needs
 * someone — blocked, or live and asking. Reduced motion keeps the colour and
 * the accessible name.
 */
function RunDot({ status, tone }: { status: AgentRunStatus; tone: AgentStatusTone }) {
  const color = TONE_COLOR[tone === "muted" ? "neutral" : tone];
  return (
    <span
      role="img"
      aria-label={runStatusLabel(status)}
      data-slot="run-dot"
      data-run-status={status}
      className={cn("relative inline-block size-2 shrink-0 rounded-full bg-(--dot)", (status === "blocked" || status === "needs_input") && "motion-safe:animate-attention")}
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
  movable = false,
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
  /** A Chat conversation: it can move into a project (M13-T58). */
  movable?: boolean | undefined;
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
          {movable && (
            <ThreadListItemMorePrimitive.Item
              data-slot="move-session-item"
              className={menuItemClass}
              disabled={!path}
              onSelect={() => path && requestMoveSession({ path, title })}
            >
              <FolderInput />
              Move to a project…
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
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open && path) forgetWorktreeDisposition(path);
        }}
      >
        {deleteOpen && <DeleteSessionBody path={path} title={title} onDone={() => setDeleteOpen(false)} />}
      </Dialog>
    </div>
  );
}

/**
 * "Delete “{title}”?" — and, when that session is a child agent with a
 * worktree, what is in that worktree and whether it goes too (M13-T42).
 *
 * The shape is `EndAgentDialog`'s, this repo's settled destructive confirm: a
 * title that names the thing, one honest sentence about what happens, and a
 * footer where the safe verb owns the first Enter. Keeping the worktree is the
 * safe answer and therefore the one selected; a session with no worktree gets
 * exactly the dialog it always had, with no empty row and no "no worktree"
 * line to read past.
 */
function DeleteSessionBody({ path, title, onDone }: { path: string | undefined; title: string; onDone(): void }) {
  const aui = useAui();
  const { actions } = useLaserStable();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [alsoDelete, setAlsoDelete] = useState(false);
  const { loading, status, error } = useWorktreeStatus(path, true, actions.agents.worktreeStatus);
  // A worktree that has already been taken away is not a decision to make.
  const worktree = status && status.exists ? status : undefined;

  const confirm = () => {
    if (!path) return;
    setWorktreeDisposition(path, worktree && alsoDelete ? "delete" : "keep");
    try {
      aui.threadListItem.delete();
      onDone();
    } catch (failure) {
      forgetWorktreeDisposition(path);
      actions.toast("error", failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <DialogContent
      className="sm:max-w-md"
      data-slot="delete-session-dialog"
      data-worktree={worktree ? "present" : undefined}
      // Radix would land on the first tabbable control, which is a choice chip;
      // Enter must not be able to delete anything.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        cancelRef.current?.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>Delete “{title}”?</DialogTitle>
        <DialogDescription>This permanently removes the saved transcript from disk. It cannot be recovered here.</DialogDescription>
      </DialogHeader>

      {loading && (
        <p className="text-sm leading-sm text-ink-3" data-slot="delete-session-worktree-loading">
          Checking whether this agent left a worktree…
        </p>
      )}
      {error && (
        <p role="alert" className="border-s-2 border-attention ps-3 text-sm leading-sm text-ink">
          <span className="font-medium">Could not check for a worktree.</span> {error} Its directory is kept either way.
        </p>
      )}
      {worktree && (
        <div className="flex flex-col gap-2" data-slot="delete-session-worktree">
          <span id={`delete-worktree-${title}`} className="eyebrow">
            Its worktree
          </span>
          <p className="text-sm leading-sm text-ink-2">
            <span className="typed break-all text-ink">{worktree.branch}</span>
            <span className="mt-0.5 block break-all text-ink-3">{worktree.path}</span>
          </p>
          <p className="text-sm leading-sm text-ink-2">{describeWorktreeContents(worktree)}</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`delete-worktree-${title}`}>
            {[
              { key: "keep", label: "Keep the worktree" },
              { key: "delete", label: "Delete it too" },
            ].map((choice) => {
              const chosen = (choice.key === "delete") === alsoDelete;
              return (
                <button
                  key={choice.key}
                  type="button"
                  data-slot="delete-session-worktree-choice"
                  data-choice={choice.key}
                  aria-pressed={chosen}
                  onClick={() => setAlsoDelete(choice.key === "delete")}
                  className={cn(
                    "h-7 rounded-full border px-2.5 text-xs font-medium outline-none pointer-coarse:min-h-11",
                    "transition-colors duration-(--motion-instant) active:translate-y-px motion-reduce:transition-none",
                    "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                    chosen
                      ? "border-transparent bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live"
                      : "border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <DialogFooter>
        <Button ref={cancelRef} variant="ghost" autoFocus onClick={onDone} className="pointer-coarse:min-h-11">
          Cancel
        </Button>
        <Button variant="destructive" disabled={!path} onClick={confirm} className="pointer-coarse:min-h-11">
          {worktree && alsoDelete ? "Delete transcript and worktree" : "Delete transcript"}
        </Button>
      </DialogFooter>
    </DialogContent>
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
