import type { AgentRun, SessionSummary } from "@lasercode/protocol";

import { latestRunForSession } from "../agents/model.js";
import type { SessionView } from "../store.js";
import { sessionKindTab, type SessionKindTab } from "./session-tab-memory.js";
import { mergeSessions, parentPathOf, projectRootOfCwd } from "./threadList.js";

export type MainTab = SessionKindTab;

export type ProjectCodeDestination =
  | { readonly kind: "no-project-landing" }
  | { readonly kind: "project-landing"; readonly project: string }
  | { readonly kind: "project-session"; readonly project: string; readonly path: string };

export type CodeDestination = ProjectCodeDestination | {
  readonly kind: "beam-session";
  readonly path: string;
  /** Project destination preserved while Beam is explicitly in the main window. */
  readonly returnTo: ProjectCodeDestination;
};

export type MainTarget =
  | { readonly kind: "chat-tab" }
  | { readonly kind: "code-tab"; readonly code: CodeDestination }
  | { readonly kind: "project"; readonly project: string }
  | { readonly kind: "startup-project"; readonly project: string }
  | { readonly kind: "startup-code" }
  | { readonly kind: "session"; readonly path: string; readonly visibleTab: MainTab };

/** One legal state per lifecycle phase; AppState owns the only live instance. */
export type MainDestination =
  | { readonly phase: "resolving"; readonly intent: number; readonly target: MainTarget; readonly rememberedCode: CodeDestination }
  | { readonly phase: "ready-code"; readonly intent: number; readonly code: CodeDestination }
  | { readonly phase: "ready-chat"; readonly intent: number; readonly path: string; readonly rememberedCode: CodeDestination }
  | { readonly phase: "unavailable"; readonly intent: number; readonly target: MainTarget; readonly rememberedCode: CodeDestination; readonly error: string };

export const emptyCodeDestination: ProjectCodeDestination = { kind: "no-project-landing" };

export const initialMainDestination: MainDestination = {
  phase: "resolving",
  intent: 0,
  target: { kind: "code-tab", code: emptyCodeDestination },
  rememberedCode: emptyCodeDestination,
};

export function rememberedCodeOf(destination: MainDestination): CodeDestination {
  return destination.phase === "ready-code" ? destination.code : destination.rememberedCode;
}

export function projectReturnOf(code: CodeDestination): ProjectCodeDestination {
  return code.kind === "beam-session" ? code.returnTo : code;
}

export function mainTab(destination: MainDestination): MainTab {
  if (destination.phase === "ready-code") return "code";
  if (destination.phase === "ready-chat") return "chat";
  if (destination.target.kind === "chat-tab") return "chat";
  if (destination.target.kind === "session") return destination.target.visibleTab;
  return "code";
}

export function mainPath(destination: MainDestination): string | undefined {
  if (destination.phase === "ready-chat") return destination.path;
  if (destination.phase !== "ready-code") return undefined;
  return destination.code.kind === "project-session" || destination.code.kind === "beam-session" ? destination.code.path : undefined;
}

export function mainCodeProject(destination: MainDestination): string | undefined {
  const project = projectReturnOf(rememberedCodeOf(destination));
  return project.kind === "project-session" || project.kind === "project-landing" ? project.project : undefined;
}

export function mainError(destination: MainDestination): string | undefined {
  return destination.phase === "unavailable" ? destination.error : undefined;
}

export function isMainReady(destination: MainDestination): boolean {
  return destination.phase === "ready-code" || destination.phase === "ready-chat";
}

export function codeLandingKey(destination: MainDestination): string | undefined {
  if (destination.phase !== "ready-code") return undefined;
  if (destination.code.kind === "no-project-landing") return "code:";
  return destination.code.kind === "project-landing" ? `code:${destination.code.project}` : undefined;
}

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

export function codeDestinationForSession(
  session: SessionSummary,
  sessions: readonly SessionSummary[],
  runs: Readonly<Record<string, AgentRun>>,
  previous: CodeDestination,
): CodeDestination {
  if (session.agent?.kind === "beam") return { kind: "beam-session", path: session.path, returnTo: projectReturnOf(previous) };
  const project = codeProjectForSession(session, sessions, runs, mainCodeProject({ phase: "ready-code", intent: 0, code: previous }));
  return project ? { kind: "project-session", project, path: session.path } : previous;
}

export interface MainCreationTarget {
  readonly cwd: string;
  readonly agentName?: string | undefined;
  readonly intent: number;
}

/** Creation is possible only from a ready landing, never while resolving/retrying. */
export function creationTargetForDestination(
  destination: MainDestination,
  chatWorkspace: string | undefined,
): MainCreationTarget | undefined {
  if (destination.phase === "ready-chat") return undefined;
  if (destination.phase !== "ready-code") return undefined;
  if (destination.code.kind === "no-project-landing") return undefined;
  return destination.code.kind === "project-landing"
    ? { cwd: destination.code.project, intent: destination.intent }
    : undefined;
}
