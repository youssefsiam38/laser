import type { AgentRun, SessionSummary } from "@lasercode/protocol";

import { latestRunForSession } from "../agents/model.js";
import type { SessionView } from "../store.js";
import { sessionKindTab, type SessionKindTab } from "./session-tab-memory.js";
import { mergeSessions, parentPathOf, projectRootOfCwd } from "./threadList.js";

export type MainTab = SessionKindTab;
export type MainDestinationPhase = "resolving" | "syncing" | "ready" | "unavailable";

/** The one navigation intent for the main window. Scoped threads do not use it. */
export interface MainDestination {
  readonly tab: MainTab;
  /** Code's remembered project. Chat and Beam never replace it. */
  readonly codeProject: string | undefined;
  /** The session currently committed to the main runtime. Undefined is a landing. */
  readonly path: string | undefined;
  /** Exact session being resolved/retried; never made actionable before commit. */
  readonly targetPath?: string | undefined;
  readonly phase: MainDestinationPhase;
  /** Monotonic latest-intent token. Async work may commit only while it matches. */
  readonly intent: number;
  /** A failed destination stays inert until the person retries or starts new. */
  readonly unavailable?: string | undefined;
}

export const initialMainDestination: MainDestination = {
  tab: "code",
  codeProject: undefined,
  path: undefined,
  targetPath: undefined,
  phase: "resolving",
  intent: 0,
};

export interface DestinationSessionSource {
  sessions: readonly SessionSummary[];
  views: Readonly<Record<string, SessionView | undefined>>;
  workspaces: { chat?: string | undefined };
  archived?(path: string): boolean;
}

/** Remembered eligible row, otherwise the newest row in the requested tab. */
export function destinationSessionForTab(
  tab: MainTab,
  remembered: string | undefined,
  source: DestinationSessionSource,
): SessionSummary | undefined {
  const eligible = mergeSessions(source.sessions, source.views)
    .filter((session) => !source.archived?.(session.path) && sessionKindTab(session, source.workspaces) === tab)
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return eligible.find((session) => session.path === remembered) ?? eligible[0];
}

/** Children climb to their listed root; detached children use the run registry. */
export function rootCwdForSession(
  session: SessionSummary,
  sessions: readonly SessionSummary[],
  runs: Readonly<Record<string, AgentRun>>,
): string {
  const byPath = new Map(sessions.map((item) => [item.path, item]));
  let cursor = session;
  const seen = new Set([cursor.path]);
  for (;;) {
    const parentPath = parentPathOf(cursor);
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    if (!parent || seen.has(parent.path)) break;
    seen.add(parent.path);
    cursor = parent;
  }
  if (cursor !== session || (session.agent?.kind !== "child" && parentPathOf(session) === undefined)) return cursor.cwd;
  return latestRunForSession(runs, session.path)?.projectCwd ?? session.cwd;
}

/** True only when this row actually belongs to the requested Code project. */
export function isSessionInCodeProject(
  session: SessionSummary,
  sessions: readonly SessionSummary[],
  runs: Readonly<Record<string, AgentRun>>,
  cwd: string,
): boolean {
  if (session.agent?.kind === "chat" || session.agent?.kind === "beam") return false;
  return projectRootOfCwd(rootCwdForSession(session, sessions, runs)) === cwd;
}

/** The Code project a row belongs to. Chat and Beam retain Code memory. */
export function codeProjectForSession(
  session: SessionSummary,
  sessions: readonly SessionSummary[],
  runs: Readonly<Record<string, AgentRun>>,
  previous: string | undefined,
): string | undefined {
  if (session.agent?.kind === "chat" || session.agent?.kind === "beam") return previous;
  return projectRootOfCwd(rootCwdForSession(session, sessions, runs));
}

export interface MainCreationTarget {
  readonly cwd: string;
  readonly agentName?: string | undefined;
  readonly intent: number;
}

/** No guessed cwd: Chat comes from its snapshot, Code from Code memory. */
export function creationTargetForDestination(
  destination: MainDestination,
  chatWorkspace: string | undefined,
): MainCreationTarget | undefined {
  if (destination.phase === "unavailable") return undefined;
  if (destination.tab === "chat") {
    return chatWorkspace ? { cwd: chatWorkspace, agentName: "chat", intent: destination.intent } : undefined;
  }
  return destination.codeProject ? { cwd: destination.codeProject, intent: destination.intent } : undefined;
}
