/**
 * The agent tree of one top-level session: the root, every child session an
 * agent started under it, and the edges between them. Pure: catalog rows, runs
 * and (optionally) open views in, nodes and edges out. Tested in
 * test/agents/run-tree.test.ts.
 *
 * Node ids are session paths, so a node keeps its identity across rebuilds and
 * a map can animate it rather than replace it. Children are in creation order
 * — the order their first run started — never attention order: a map that
 * reshuffles is a map you cannot learn (mirrors components/subagents/run-tree).
 */
import {
  DEFAULT_AGENT_NAME,
  isTerminalRunStatus,
  type AgentRun,
  type AgentRunStatus,
  type SessionAttention,
  type SessionSummary,
} from "@lasercode/protocol";
import { sessionAttention, sessionTitle } from "../runtime/threadList.js";
import type { SessionView } from "../store.js";
import { agentDisplayName, compareRunsOldestFirst, runList, runStatusTone, type AgentStatusTone, type RunSource } from "./model.js";

/** A run's status, or what a session without a run of its own is doing. */
export type AgentTreeStatus = AgentRunStatus | "idle" | "working";

export interface AgentTreeNode {
  /** Stable identity: the session path. */
  id: string;
  sessionPath: string;
  sessionId?: string;
  agentName: string;
  subagentName?: string;
  title: string;
  status: AgentTreeStatus;
  tone: AgentStatusTone;
  /** 0 for the root. */
  depth: number;
  parentPath?: string;
  /** The newest run in this session. */
  run?: AgentRun;
  /** Every run in this session, oldest first. */
  runs: AgentRun[];
  /** Reached an end state; a map may fold these away. */
  ended: boolean;
  /** Child node ids, in creation order. */
  children: string[];
}

export interface AgentTreeEdge {
  from: string;
  to: string;
}

export interface AgentTree {
  rootPath: string;
  root: AgentTreeNode;
  /** Every node, root first, depth-first in child order. */
  nodes: AgentTreeNode[];
  edges: AgentTreeEdge[];
  byPath: ReadonlyMap<string, AgentTreeNode>;
  /** Nodes still going. */
  active: number;
}

export interface AgentTreeInput {
  rootPath: string;
  sessions: readonly SessionSummary[];
  runs: RunSource;
  views?: Readonly<Record<string, SessionView | undefined>> | undefined;
  /** The snapshot's default agent, for a root with no attribution. */
  defaultAgent?: string | undefined;
}

const time = (value: string | undefined): number => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** What a session with no run of its own is doing, in the shared vocabulary. */
function statusOfAttention(attention: SessionAttention): AgentTreeStatus {
  switch (attention) {
    case "working":
      return "working";
    case "waiting_for_input":
      return "blocked";
    case "error":
      return "failed";
    case "finished_unread":
    case "idle":
      return "idle";
  }
}

function toneOf(status: AgentTreeStatus): AgentStatusTone {
  if (status === "idle") return "muted";
  if (status === "working") return "live";
  return runStatusTone(status);
}

export interface AncestryIndex {
  /**
   * Root-first chain of session paths from the tree's root down to `path`
   * (length 1 when `path` is itself a root). Runs know their root outright;
   * a catalog row knows its parent; a session nobody attributes is its own root.
   */
  ancestryOf(path: string): string[];
  /** The top-level session `path` belongs to. */
  rootOf(path: string): string;
}

/** One pass over runs and rows, then every lookup is memoized: build once per tree, not once per run. */
export function createAncestryIndex(runs: RunSource, sessions: readonly SessionSummary[]): AncestryIndex {
  const byPath = new Map<string, SessionSummary>();
  for (const summary of sessions) byPath.set(summary.path, summary);
  const runsBySession = new Map<string, AgentRun>();
  for (const run of runList(runs)) {
    const held = runsBySession.get(run.sessionPath);
    if (!held || time(run.startedAt) >= time(held.startedAt)) runsBySession.set(run.sessionPath, run);
  }
  const chains = new Map<string, string[]>();
  const ancestryOf = (path: string): string[] => {
    const cached = chains.get(path);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = path;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      chain.unshift(cursor);
      const run = runsBySession.get(cursor);
      const summary = byPath.get(cursor);
      const parent: string | undefined = run?.parent?.sessionPath ?? summary?.agent?.parentPath ?? summary?.parentPath;
      if (parent === undefined) {
        // A run names its root directly; trust it when the parent chain is cut
        // (the parent's row may not be in the catalog yet).
        const root = run?.rootSessionPath ?? summary?.agent?.rootPath;
        if (root !== undefined && root !== cursor && !seen.has(root)) chain.unshift(root);
        break;
      }
      cursor = parent;
    }
    chains.set(path, chain);
    return chain;
  };
  return { ancestryOf, rootOf: (path) => ancestryOf(path)[0] ?? path };
}

/** See {@link AncestryIndex.ancestryOf}; for one lookup. Many lookups should share an index. */
export function ancestryOf(runs: RunSource, sessions: readonly SessionSummary[], path: string): string[] {
  return createAncestryIndex(runs, sessions).ancestryOf(path);
}

/** See {@link AncestryIndex.rootOf}; for one lookup. Many lookups should share an index. */
export function rootOf(runs: RunSource, sessions: readonly SessionSummary[], path: string): string {
  return createAncestryIndex(runs, sessions).rootOf(path);
}

/** Every session path in the tree, root first, depth-first in child order. */
export function subtreePaths(tree: AgentTree): string[] {
  return tree.nodes.map((node) => node.id);
}

export function buildAgentTree(input: AgentTreeInput): AgentTree {
  const { rootPath } = input;
  const views = input.views ?? {};
  const summaries = new Map<string, SessionSummary>();
  for (const summary of input.sessions) summaries.set(summary.path, summary);
  const allRuns = runList(input.runs);
  const index = createAncestryIndex(allRuns, input.sessions);

  // Every session in the tree, and the runs that executed in each. A run
  // names its root outright; the index only answers for the rest.
  const runsBySession = new Map<string, AgentRun[]>();
  for (const run of allRuns) {
    if (run.rootSessionPath !== rootPath && index.rootOf(run.sessionPath) !== rootPath) continue;
    const list = runsBySession.get(run.sessionPath);
    if (list) list.push(run);
    else runsBySession.set(run.sessionPath, [run]);
  }
  for (const list of runsBySession.values()) list.sort(compareRunsOldestFirst);

  const members = new Set<string>([rootPath, ...runsBySession.keys()]);
  // Catalog-attributed children whose run the registry no longer holds still
  // belong on the map: nothing vanishes silently.
  for (const summary of input.sessions) {
    if (summary.path === rootPath || members.has(summary.path)) continue;
    const attributed = summary.agent?.kind === "child" || summary.parentPath !== undefined;
    if (attributed && index.rootOf(summary.path) === rootPath) members.add(summary.path);
  }

  const parentOf = (path: string): string | undefined => {
    if (path === rootPath) return undefined;
    const runs = runsBySession.get(path);
    const latest = runs?.at(-1);
    const summary = summaries.get(path);
    const parent = latest?.parent?.sessionPath ?? summary?.agent?.parentPath ?? summary?.parentPath;
    // A parent outside the tree (or missing) attaches the child to the root
    // rather than dropping it.
    return parent !== undefined && members.has(parent) ? parent : rootPath;
  };

  const startedAt = (path: string): number => {
    const first = runsBySession.get(path)?.[0];
    return time(first?.startedAt ?? summaries.get(path)?.createdAt);
  };

  const childrenOf = new Map<string, string[]>();
  for (const path of members) {
    const parent = parentOf(path);
    if (parent === undefined) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(path);
    else childrenOf.set(parent, [path]);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => startedAt(a) - startedAt(b) || a.localeCompare(b));

  const nodes: AgentTreeNode[] = [];
  const edges: AgentTreeEdge[] = [];
  const byPath = new Map<string, AgentTreeNode>();
  let active = 0;

  const makeNode = (path: string, depth: number, parentPath: string | undefined): AgentTreeNode => {
    const summary = summaries.get(path);
    const view = views[path];
    const runs = runsBySession.get(path) ?? [];
    const run = runs.at(-1);
    const info = summary?.agent ?? view?.state.agent;
    let status: AgentTreeStatus;
    let ended: boolean;
    if (run) {
      status = run.status;
      ended = isTerminalRunStatus(run.status);
    } else if (info?.runStatus) {
      status = info.runStatus;
      ended = isTerminalRunStatus(info.runStatus);
    } else {
      const attention: SessionAttention = summary ? sessionAttention(summary, view) : view ? sessionAttention(summaryOfView(view), view) : "idle";
      status = statusOfAttention(attention);
      // The root is never "ended": it is the conversation the person is in.
      ended = depth > 0 && status === "idle";
    }
    if (!ended) active += 1;
    const agentName = info?.agentName ?? run?.agentName ?? input.defaultAgent ?? DEFAULT_AGENT_NAME;
    const subagentName = info?.subagentName ?? run?.subagentName;
    const title = summary ? sessionTitle(summary, view) : view ? sessionTitle(summaryOfView(view), view) : subagentName ?? agentDisplayName(agentName);
    const sessionId = summary?.id ?? view?.state.id ?? run?.sessionId;
    return {
      id: path,
      sessionPath: path,
      ...(sessionId !== undefined ? { sessionId } : {}),
      agentName,
      ...(subagentName !== undefined ? { subagentName } : {}),
      title,
      status,
      tone: toneOf(status),
      depth,
      ...(parentPath !== undefined ? { parentPath } : {}),
      ...(run !== undefined ? { run } : {}),
      runs,
      ended,
      children: childrenOf.get(path) ?? [],
    };
  };

  const seen = new Set<string>();
  const walk = (path: string, depth: number, parentPath: string | undefined): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const node = makeNode(path, depth, parentPath);
    nodes.push(node);
    byPath.set(path, node);
    if (parentPath !== undefined) edges.push({ from: parentPath, to: path });
    for (const child of node.children) walk(child, depth + 1, path);
  };
  walk(rootPath, 0, undefined);

  return { rootPath, root: nodes[0]!, nodes, edges, byPath, active };
}

/** A catalog-shaped row for a session the catalog has not scanned yet. */
function summaryOfView(view: SessionView): SessionSummary {
  return {
    path: view.path,
    id: view.state.id,
    cwd: view.state.cwd,
    ...(view.state.name !== undefined ? { name: view.state.name } : {}),
    createdAt: view.openedAt,
    modifiedAt: view.openedAt,
    messageCount: view.state.messageCount,
    ...(view.state.agent !== undefined ? { agent: view.state.agent } : {}),
  };
}

/** Structural equality, so a selector can keep the previous tree when nothing a map draws has changed. */
export function sameAgentTree(a: AgentTree, b: AgentTree): boolean {
  if (a === b) return true;
  if (a.rootPath !== b.rootPath || a.nodes.length !== b.nodes.length || a.active !== b.active) return false;
  return a.nodes.every((node, i) => sameAgentTreeNode(node, b.nodes[i]!));
}

export function sameAgentTreeNode(a: AgentTreeNode, b: AgentTreeNode): boolean {
  return (
    a.id === b.id &&
    a.sessionId === b.sessionId &&
    a.agentName === b.agentName &&
    a.subagentName === b.subagentName &&
    a.title === b.title &&
    a.status === b.status &&
    a.depth === b.depth &&
    a.parentPath === b.parentPath &&
    a.ended === b.ended &&
    a.run === b.run &&
    a.runs.length === b.runs.length &&
    a.runs.every((run, i) => run === b.runs[i]) &&
    a.children.length === b.children.length &&
    a.children.every((child, i) => child === b.children[i])
  );
}
