"use client";
/**
 * Focused hooks over `state.agents` and the per-view Namer labels. Every one
 * subscribes to a slice through {@link useLaserState} with a structural
 * equality, so a streamed token in an unrelated session never re-renders an
 * agent card, a map node or a label.
 */
import type { AgentEvent, AgentRun, AgentWarning, AgentsSnapshot, SessionAgentInfo } from "@lasercode/protocol";
import { useEffect, useMemo, useState } from "react";
import { useLaserStable, useLaserState } from "../runtime/LaserProvider.js";
import type { AgentsSlice, AppState } from "../store.js";
import type { AgentsActions } from "./actions.js";
import { agentKindOf, latestRunForSession, runsForRoot, sessionAgentName } from "./model.js";
import { buildAgentTree, sameAgentTree, type AgentTree } from "./run-tree.js";

const EMPTY_RUNS: readonly AgentRun[] = Object.freeze([]);
const EMPTY_EVENTS: readonly AgentEvent[] = Object.freeze([]);
const EMPTY_WARNINGS: readonly AgentWarning[] = Object.freeze([]);

const sameList = <T,>(a: readonly T[], b: readonly T[]): boolean => a === b || (a.length === b.length && a.every((item, i) => item === b[i]));

/** `actions.agents`, stable for the life of the connection. */
export function useAgentsActions(): AgentsActions {
  return useLaserStable().actions.agents;
}

export function useAgentsSnapshot(): AgentsSnapshot | null {
  return useLaserState((s) => s.agents.snapshot);
}

export interface AgentsStatus {
  loading: boolean;
  error: string | null;
  /** True once `agents/list` has answered at least once. */
  loaded: boolean;
}

const sameStatus = (a: AgentsStatus, b: AgentsStatus): boolean => a.loading === b.loading && a.error === b.error && a.loaded === b.loaded;

/** Loading and error state of the definitions, for the Agents page's empty and error states. */
export function useAgentsStatus(): AgentsStatus {
  return useLaserState((s) => ({ loading: s.agents.loading, error: s.agents.error, loaded: s.agents.snapshot !== null }), sameStatus);
}

/** Every run the host has told us about, by `runId`. */
export function useAgentRuns(): AgentsSlice["runs"] {
  return useLaserState((s) => s.agents.runs);
}

/** Runs in the tree under `rootPath`, oldest first; identity survives unrelated updates. */
export function useRunsForRoot(rootPath: string | undefined): readonly AgentRun[] {
  return useLaserState((s) => (rootPath === undefined ? EMPTY_RUNS : runsForRoot(s.agents.runs, rootPath)), sameList);
}

/** The newest run executing inside `sessionPath`, if any. */
export function useLatestRun(sessionPath: string | undefined): AgentRun | undefined {
  return useLaserState((s) => (sessionPath === undefined ? undefined : latestRunForSession(s.agents.runs, sessionPath)));
}

const treeOf = (rootPath: string) => (s: AppState): AgentTree =>
  buildAgentTree({
    rootPath,
    sessions: s.sessions,
    runs: s.agents.runs,
    views: s.open,
    defaultAgent: s.agents.snapshot?.defaultAgent,
  });

/**
 * The agent tree of the top-level session `rootPath`. Rebuilt when runs, the
 * catalog or an open view change, but the previous tree is handed back
 * whenever nothing a map draws has moved, so nodes keep their identity.
 */
export function useAgentTree(rootPath: string | undefined): AgentTree | undefined {
  const selector = useMemo(() => (rootPath === undefined ? () => undefined : treeOf(rootPath)), [rootPath]);
  return useLaserState(selector, (a, b) => (a === undefined || b === undefined ? a === b : sameAgentTree(a, b)));
}

const eventAge = (event: AgentEvent, now: number): number => {
  const at = Date.parse(event.at);
  // A clock ahead of the host's would expire every bubble on arrival; treat a
  // future stamp as "just now" rather than as already gone.
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : Math.max(0, now - at);
};

/**
 * The transient inter-agent moments of one node, younger than `ttlMs`, oldest
 * first. Re-evaluated on a timer only while something is showing, so an idle
 * map costs nothing.
 */
export function useAgentEvents(sessionPath: string | undefined, ttlMs = 6000): readonly AgentEvent[] {
  const mine = useLaserState(
    (s) => (sessionPath === undefined ? EMPTY_EVENTS : s.agents.events.filter((event) => event.sessionPath === sessionPath)),
    sameList,
  );
  // Bumped by the expiry timer; the clock itself is read when the list is cut.
  const [tick, setTick] = useState(0);
  const live = useMemo(() => {
    const now = Date.now();
    return mine.filter((event) => eventAge(event, now) < ttlMs);
  }, [mine, tick, ttlMs]);
  const stable = useStableList(live);
  useEffect(() => {
    if (stable.length === 0) return;
    const now = Date.now();
    const soonest = Math.min(...stable.map((event) => ttlMs - eventAge(event, now)));
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(16, soonest + 1));
    return () => clearTimeout(timer);
  }, [stable, tick, ttlMs]);
  return stable;
}

/** Keep the previous array when its members did not change. */
function useStableList<T>(next: readonly T[]): readonly T[] {
  const [held, setHeld] = useState(next);
  if (sameList(held, next)) return held;
  setHeld(next);
  return next;
}

/**
 * How `path` relates to the agents feature, with the live run's status folded
 * in. A session without attribution is placed by its directory and gets the
 * snapshot's default agent, so every session answers.
 */
export function useSessionAgent(path: string | undefined): SessionAgentInfo | undefined {
  return useLaserState(
    (s) => {
      if (path === undefined) return undefined;
      const view = s.open[path];
      const summary = s.sessions.find((session) => session.path === path);
      if (!view && !summary) return undefined;
      const info = view?.state.agent ?? summary?.agent;
      const shape = summary ?? { cwd: view!.state.cwd, ...(info !== undefined ? { agent: info } : {}) };
      const run = latestRunForSession(s.agents.runs, path);
      return {
        agentName: info?.agentName ?? sessionAgentName(shape, s.agents.snapshot),
        kind: info?.kind ?? agentKindOf(shape, s.agents.snapshot),
        ...(info?.subagentName !== undefined ? { subagentName: info.subagentName } : {}),
        ...(info?.parentPath !== undefined ? { parentPath: info.parentPath } : {}),
        ...(info?.rootPath !== undefined ? { rootPath: info.rootPath } : {}),
        ...((run?.runId ?? info?.runId) !== undefined ? { runId: (run?.runId ?? info?.runId)! } : {}),
        ...((run?.status ?? info?.runStatus) !== undefined ? { runStatus: (run?.status ?? info?.runStatus)! } : {}),
      };
    },
    sameAgentInfo,
  );
}

function sameAgentInfo(a: SessionAgentInfo | undefined, b: SessionAgentInfo | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.agentName === b.agentName &&
    a.kind === b.kind &&
    a.subagentName === b.subagentName &&
    a.parentPath === b.parentPath &&
    a.rootPath === b.rootPath &&
    a.runId === b.runId &&
    a.runStatus === b.runStatus
  );
}

/** Namer's early label for a tool call still running, or `undefined` until it lands. */
export function useNamerLabel(path: string | undefined, toolCallId: string | undefined): string | undefined {
  return useLaserState((s) => (path === undefined || toolCallId === undefined ? undefined : s.open[path]?.namerLabels[toolCallId]));
}

/** Every periodic-validation warning, as the snapshot orders them. */
export function useAgentWarnings(): readonly AgentWarning[] {
  return useLaserState((s) => s.agents.snapshot?.warnings ?? EMPTY_WARNINGS, sameList);
}

/** The pending Beam model choice, or `null` when none is open. */
export function useBeamChoice(): AgentsSlice["chooseBeamModel"] {
  return useLaserState((s) => s.agents.chooseBeamModel);
}
