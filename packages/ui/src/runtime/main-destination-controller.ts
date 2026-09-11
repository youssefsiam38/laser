import { storageKey, type SessionState } from "@lasercode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Action, AppState } from "../store.js";
import type { NewSessionOptions } from "./new-session.js";
import {
  codeDestinationForSession,
  destinationSessionForTab,
  emptyCodeDestination,
  isMainReady,
  isSessionInCodeProject,
  mainCodeProject,
  mainPath,
  mainTab,
  projectReturnOf,
  rememberedCodeOf,
  type CodeDestination,
  type MainCreationTarget,
  type MainDestination,
  type MainTab,
  type MainTarget,
  type ProjectCodeDestination,
} from "./main-destination.js";
import { SESSION_TAB_MEMORY_KEY, SESSIONS_TAB_STORAGE_KEY, sessionKindTab } from "./session-tab-memory.js";
import { mergeSessions } from "./threadList.js";

export const PROJECT_STORAGE_KEY = storageKey("project");
export const SESSION_STORAGE_KEY = storageKey("session");

interface DestinationMemory {
  v: 2;
  tab: MainTab;
  chat?: string;
  code: CodeDestination;
  /** Present only while migrating the pre-controller project/session keys. */
  legacy?: boolean;
}

const readRaw = (key: string): string | undefined => {
  try { return globalThis.localStorage?.getItem(key) ?? undefined; } catch { return undefined; }
};
const writeRaw = (key: string, value: string | undefined): void => {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch { /* live state remains authoritative */ }
};
const readMap = (key: string): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(readRaw(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
};

const projectCode = (value: unknown): ProjectCodeDestination | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item["kind"] === "no-project-landing") return emptyCodeDestination;
  if (item["kind"] === "project-landing" && typeof item["project"] === "string") return { kind: "project-landing", project: item["project"] };
  if (item["kind"] === "project-session" && typeof item["project"] === "string" && typeof item["path"] === "string") {
    return { kind: "project-session", project: item["project"], path: item["path"] };
  }
  return undefined;
};

const codeDestination = (value: unknown): CodeDestination | undefined => {
  const project = projectCode(value);
  if (project) return project;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const returnTo = projectCode(item["returnTo"]);
  return item["kind"] === "beam-session" && typeof item["path"] === "string" && returnTo
    ? { kind: "beam-session", path: item["path"], returnTo }
    : undefined;
};

/** Typed memory is authoritative; old maps are read only as migration inputs. */
export function readDestinationMemory(): DestinationMemory {
  try {
    const parsed: unknown = JSON.parse(readRaw(SESSION_TAB_MEMORY_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const item = parsed as Record<string, unknown>;
      const code = item["v"] === 2 ? codeDestination(item["code"]) : undefined;
      if (code) {
        return {
          v: 2,
          tab: item["tab"] === "chat" ? "chat" : "code",
          ...(typeof item["chat"] === "string" ? { chat: item["chat"] } : {}),
          code,
        };
      }
    }
  } catch { /* migrate below */ }
  const project = readRaw(PROJECT_STORAGE_KEY);
  const remembered = project ? readMap(SESSION_STORAGE_KEY)[project] : undefined;
  const code: CodeDestination = project
    ? remembered ? { kind: "project-session", project, path: remembered } : { kind: "project-landing", project }
    : emptyCodeDestination;
  let chat: string | undefined;
  try {
    const legacy: unknown = JSON.parse(readRaw(SESSION_TAB_MEMORY_KEY) ?? "{}");
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy) && typeof (legacy as Record<string, unknown>)["chat"] === "string") {
      chat = (legacy as Record<string, string>)["chat"];
    }
  } catch { /* empty */ }
  return { v: 2, tab: readRaw(SESSIONS_TAB_STORAGE_KEY) === "chat" ? "chat" : "code", ...(chat ? { chat } : {}), code, legacy: true };
}

export function initialDestinationFromMemory(memory = readDestinationMemory()): MainDestination {
  const target: MainTarget = memory.tab === "chat"
    ? { kind: "chat-tab" }
    : memory.legacy && (memory.code.kind === "project-landing" || memory.code.kind === "project-session")
      ? { kind: "startup-project", project: memory.code.project }
      : memory.legacy && memory.code.kind === "no-project-landing"
        ? { kind: "startup-code" }
        : { kind: "code-tab", code: memory.code };
  return { phase: "resolving", intent: 0, target, rememberedCode: memory.code };
}

function writeMemory(destination: MainDestination): void {
  const previous = readDestinationMemory();
  const tab = mainTab(destination);
  const code = rememberedCodeOf(destination);
  const chat = destination.phase === "ready-chat" ? destination.path : previous.chat;
  writeRaw(SESSION_TAB_MEMORY_KEY, JSON.stringify({ v: 2, tab, ...(chat ? { chat } : {}), code } satisfies DestinationMemory));
  writeRaw(SESSIONS_TAB_STORAGE_KEY, tab);
  const project = mainCodeProject(destination);
  writeRaw(PROJECT_STORAGE_KEY, project);
  const projectTarget = projectReturnOf(code);
  if (projectTarget.kind === "project-session") {
    const sessions = readMap(SESSION_STORAGE_KEY);
    if (sessions[projectTarget.project] !== projectTarget.path) {
      writeRaw(SESSION_STORAGE_KEY, JSON.stringify({ ...sessions, [projectTarget.project]: projectTarget.path }));
    }
  }
}

export type MainInitializationToken = Readonly<{ id: number; intent: number; target: MainCreationTarget }>;

export interface MainDestinationControllerDeps {
  state: AppState;
  readState(): AppState;
  dispatch(action: Action): void;
  loadSession(path: string): Promise<void>;
  launchSession(cwd: string, options?: NewSessionOptions): Promise<string>;
  archived(path: string): boolean;
  onError(error: unknown): void;
  beforeTransition(destination: MainDestination): void;
}

export interface MainDestinationController {
  startupRestoring: boolean;
  initializing: number;
  controlledPath: string | undefined;
  goTab(tab: MainTab): Promise<void>;
  goProject(cwd: string): Promise<void>;
  openSession(path: string): Promise<void>;
  newSession(cwd: string, options?: NewSessionOptions): Promise<string>;
  retry(): Promise<void>;
  leave(): void;
  setCodeProject(cwd: string | undefined): void;
  setDefaultCodeProject(cwd: string): void;
  closeMainView(path: string): void;
  replaceMainSession(from: string, state: SessionState): void;
  creationTarget(): MainCreationTarget | undefined;
  beginInitialization(target: MainCreationTarget): MainInitializationToken;
  finishInitialization(token: MainInitializationToken, path: string): void;
  endInitialization(token: MainInitializationToken): void;
  onAssistantThreadChange(path: string | undefined): void;
}

export function parseSessionHash(hash: string): { kind: "none" } | { kind: "session"; path: string } | { kind: "invalid"; error: Error } {
  const match = /^#\/session\/(.+)$/.exec(hash);
  if (!match?.[1]) return { kind: "none" };
  try { return { kind: "session", path: decodeURIComponent(match[1]) }; }
  catch { return { kind: "invalid", error: new Error(`That session link is not valid: ${hash}`) }; }
}

export function useMainDestinationController(deps: MainDestinationControllerDeps): MainDestinationController {
  const { state, readState, dispatch } = deps;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const intentRef = useRef(state.destination.intent);
  if (state.destination.intent > intentRef.current) intentRef.current = state.destination.intent;
  const [startupRestoring, setStartupRestoring] = useState(true);
  const startupHandled = useRef(false);
  const explicitIntent = useRef(false);
  const [initializing, setInitializing] = useState(0);
  const initializationId = useRef(0);
  const initializingRef = useRef(0);
  const heldPath = useRef<string | undefined>(mainPath(state.destination));
  if (initializing === 0) heldPath.current = mainPath(state.destination);

  const transition = useCallback((destination: MainDestination): boolean => {
    if (destination.intent !== intentRef.current) return false;
    depsRef.current.dispatch({ type: "destination", destination });
    writeMemory(destination);
    return true;
  }, []);

  const begin = useCallback((target: MainTarget, automatic = false): number => {
    const current = depsRef.current.readState().destination;
    depsRef.current.beforeTransition(current);
    if (!automatic) explicitIntent.current = true;
    const intent = ++intentRef.current;
    transition({ phase: "resolving", intent, target, rememberedCode: rememberedCodeOf(current) });
    return intent;
  }, [transition]);

  const fail = useCallback((intent: number, error: unknown): void => {
    const current = depsRef.current.readState().destination;
    if (intent !== intentRef.current || current.intent !== intent || current.phase !== "resolving") return;
    transition({ phase: "unavailable", intent, target: current.target, rememberedCode: current.rememberedCode, error: error instanceof Error ? error.message : String(error) });
  }, [transition]);

  const readyCode = useCallback((intent: number, code: CodeDestination): boolean => {
    const current = depsRef.current.readState().destination;
    return current.phase === "resolving" && current.intent === intent
      ? transition({ phase: "ready-code", intent, code })
      : false;
  }, [transition]);

  const resolveSession = useCallback(async (path: string, intent: number): Promise<boolean> => {
    const beforeLoad = depsRef.current.readState();
    const pending = beforeLoad.destination;
    if (intent !== intentRef.current || pending.phase !== "resolving" || pending.intent !== intent) return false;
    const known = mergeSessions(beforeLoad.sessions, beforeLoad.open).find((item) => item.path === path);
    const visibleTab = known
      ? sessionKindTab(known, beforeLoad.agents.snapshot?.workspaces ?? {})
      : pending.target.kind === "session" ? pending.target.visibleTab : mainTab(pending);
    // Every load failure retries this identity, even when an abstract project
    // or tab restoration chose it. Pin before the await so memory/catalog
    // changes cannot make Retry select a different candidate.
    if (pending.target.kind !== "session" || pending.target.path !== path || pending.target.visibleTab !== visibleTab) {
      transition({ ...pending, target: { kind: "session", path, visibleTab } });
    }
    try { await depsRef.current.loadSession(path); }
    catch (error) {
      if (intent !== intentRef.current) return false;
      fail(intent, error);
      throw error;
    }
    if (intent !== intentRef.current) return false;
    const snapshot = depsRef.current.readState();
    const sessions = mergeSessions(snapshot.sessions, snapshot.open);
    const session = sessions.find((item) => item.path === path);
    if (!session) {
      const error = new Error("That conversation could not be loaded. Retry it or start a new one.");
      fail(intent, error);
      throw error;
    }
    if (snapshot.destination.phase !== "resolving" || snapshot.destination.intent !== intent) return false;
    const previous = rememberedCodeOf(snapshot.destination);
    if (sessionKindTab(session, snapshot.agents.snapshot?.workspaces ?? {}) === "chat") {
      return transition({ phase: "ready-chat", intent, path, rememberedCode: previous });
    }
    return readyCode(intent, codeDestinationForSession(session, sessions, snapshot.agents.runs, previous));
  }, [fail, readyCode, transition]);

  const resolveCode = useCallback(async (code: CodeDestination, intent: number): Promise<void> => {
    if (code.kind === "no-project-landing" || code.kind === "project-landing") { readyCode(intent, code); return; }
    const snapshot = depsRef.current.readState();
    const sessions = mergeSessions(snapshot.sessions, snapshot.open);
    const known = sessions.find((item) => item.path === code.path);
    if (code.kind === "project-session" && known && !isSessionInCodeProject(known, sessions, snapshot.agents.runs, code.project)) {
      readyCode(intent, { kind: "project-landing", project: code.project });
      return;
    }
    await resolveSession(code.path, intent);
  }, [readyCode, resolveSession]);

  const resolveTarget = useCallback(async (target: MainTarget, intent: number): Promise<void> => {
    if (target.kind === "session") { await resolveSession(target.path, intent); return; }
    if (target.kind === "project" || target.kind === "startup-project") {
      const snapshot = depsRef.current.readState();
      const remembered = readMap(SESSION_STORAGE_KEY)[target.project];
      const sessions = mergeSessions(snapshot.sessions, snapshot.open);
      const rememberedSession = remembered ? sessions.find((item) => item.path === remembered && isSessionInCodeProject(item, sessions, snapshot.agents.runs, target.project)) : undefined;
      const known = rememberedSession ?? (target.kind === "startup-project"
        ? sessions.filter((item) => isSessionInCodeProject(item, sessions, snapshot.agents.runs, target.project))
          .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))[0]
        : undefined);
      if (known) await resolveSession(known.path, intent);
      else readyCode(intent, { kind: "project-landing", project: target.project });
      return;
    }
    if (target.kind === "code-tab") { await resolveCode(target.code, intent); return; }
    if (target.kind === "startup-code") {
      const snapshot = depsRef.current.readState();
      const candidate = destinationSessionForTab("code", undefined, {
        sessions: snapshot.sessions,
        views: snapshot.open,
        workspaces: snapshot.agents.snapshot?.workspaces ?? {},
        archived: depsRef.current.archived,
      });
      if (candidate) await resolveSession(candidate.path, intent);
      else readyCode(intent, emptyCodeDestination);
      return;
    }
    const memory = readDestinationMemory();
    const snapshot = depsRef.current.readState();
    const source = { sessions: snapshot.sessions, views: snapshot.open, workspaces: snapshot.agents.snapshot?.workspaces ?? {}, archived: depsRef.current.archived };
    const remembered = memory.chat;
    const candidate = remembered
      ? mergeSessions(snapshot.sessions, snapshot.open).find((item) => item.path === remembered)
      : destinationSessionForTab("chat", undefined, source);
    if (remembered || candidate) { await resolveSession(remembered ?? candidate!.path, intent); return; }
    const cwd = snapshot.agents.snapshot?.workspaces.chat;
    if (!cwd) return;
    try {
      const path = await depsRef.current.launchSession(cwd, { agentName: "chat", select: false });
      if (intent !== intentRef.current) return;
      const current = depsRef.current.readState().destination;
      if (current.phase === "resolving" && current.intent === intent) transition({ ...current, target: { kind: "session", path, visibleTab: "chat" } });
      await resolveSession(path, intent);
    } catch (error) {
      if (intent !== intentRef.current) return;
      fail(intent, error);
      throw error;
    }
  }, [fail, readyCode, resolveCode, resolveSession, transition]);

  const goTab = useCallback(async (tab: MainTab): Promise<void> => {
    const current = depsRef.current.readState().destination;
    if (mainTab(current) === tab && isMainReady(current) && mainPath(current) !== undefined) return;
    const target: MainTarget = tab === "chat" ? { kind: "chat-tab" } : { kind: "code-tab", code: rememberedCodeOf(current) };
    const intent = begin(target);
    await resolveTarget(target, intent);
  }, [begin, resolveTarget]);

  const goProject = useCallback(async (cwd: string): Promise<void> => {
    const target: MainTarget = { kind: "project", project: cwd };
    const intent = begin(target);
    await resolveTarget(target, intent);
  }, [begin, resolveTarget]);

  const openSession = useCallback(async (path: string): Promise<void> => {
    const snapshot = depsRef.current.readState();
    const sessions = mergeSessions(snapshot.sessions, snapshot.open);
    const known = sessions.find((item) => item.path === path);
    const visibleTab = known ? sessionKindTab(known, snapshot.agents.snapshot?.workspaces ?? {}) : mainTab(snapshot.destination);
    const target: MainTarget = { kind: "session", path, visibleTab };
    const intent = begin(target);
    await resolveSession(path, intent);
  }, [begin, resolveSession]);

  const newSession = useCallback(async (cwd: string, options: NewSessionOptions = {}): Promise<string> => {
    if (options.select === false) return depsRef.current.launchSession(cwd, { ...options, select: false });
    const visibleTab: MainTab = options.agentName === "chat" ? "chat" : "code";
    const target: MainTarget = visibleTab === "chat" ? { kind: "chat-tab" } : { kind: "project", project: cwd };
    const intent = begin(target);
    try {
      const path = await depsRef.current.launchSession(cwd, { ...options, select: false });
      if (intent !== intentRef.current) return path;
      const current = depsRef.current.readState().destination;
      if (current.phase === "resolving" && current.intent === intent) transition({ ...current, target: { kind: "session", path, visibleTab } });
      await resolveSession(path, intent);
      return path;
    } catch (error) {
      if (intent === intentRef.current) fail(intent, error);
      throw error;
    }
  }, [begin, fail, resolveSession, transition]);

  const retry = useCallback(async (): Promise<void> => {
    const current = depsRef.current.readState().destination;
    if (current.phase !== "unavailable") return;
    const target = current.target;
    const intent = begin(target);
    await resolveTarget(target, intent);
  }, [begin, resolveTarget]);

  const leave = useCallback(() => {
    const current = depsRef.current.readState().destination;
    const code = projectReturnOf(rememberedCodeOf(current));
    const intent = begin({ kind: "code-tab", code });
    readyCode(intent, code.kind === "project-session" ? { kind: "project-landing", project: code.project } : code);
  }, [begin, readyCode]);

  const setDefaultCodeProject = useCallback((cwd: string) => {
    const current = depsRef.current.readState().destination;
    if (mainCodeProject(current) !== undefined || mainPath(current) !== undefined) return;
    if (current.intent !== 0 && (current.phase !== "ready-code" || current.code.kind !== "no-project-landing")) return;
    const target: MainTarget = { kind: "startup-project", project: cwd };
    const intent = begin(target, true);
    void resolveTarget(target, intent).catch(() => {});
  }, [begin, resolveTarget]);

  const setCodeProject = useCallback((cwd: string | undefined) => {
    const current = depsRef.current.readState().destination;
    depsRef.current.beforeTransition(current);
    const code: ProjectCodeDestination = cwd ? { kind: "project-landing", project: cwd } : emptyCodeDestination;
    const intent = ++intentRef.current;
    if (current.phase === "ready-chat") transition({ ...current, intent, rememberedCode: code });
    else transition({ phase: "ready-code", intent, code });
  }, [transition]);

  const closeMainView = useCallback((path: string) => {
    const current = depsRef.current.readState().destination;
    if (mainPath(current) !== path) return;
    const code = projectReturnOf(rememberedCodeOf(current));
    const intent = begin({ kind: "code-tab", code });
    readyCode(intent, code.kind === "project-session" ? { kind: "project-landing", project: code.project } : code);
  }, [begin, readyCode]);

  const replaceMainSession = useCallback((from: string, session: SessionState) => {
    const snapshot = depsRef.current.readState();
    const current = snapshot.destination;
    if (mainPath(current) !== from) return;
    const intent = ++intentRef.current;
    const sessions = mergeSessions(snapshot.sessions, snapshot.open);
    const replacement = sessions.find((item) => item.path === session.path);
    if (replacement && sessionKindTab(replacement, snapshot.agents.snapshot?.workspaces ?? {}) === "chat") {
      transition({ phase: "ready-chat", intent, path: session.path, rememberedCode: rememberedCodeOf(current) });
      return;
    }
    const code = replacement
      ? codeDestinationForSession(replacement, sessions, snapshot.agents.runs, rememberedCodeOf(current))
      : rememberedCodeOf(current);
    transition({ phase: "ready-code", intent, code });
  }, [transition]);

  const creationTarget = useCallback(() => {
    const current = depsRef.current.readState().destination;
    if (current.phase !== "ready-code") return undefined;
    if (current.code.kind !== "project-landing") return undefined;
    return { cwd: current.code.project, intent: current.intent };
  }, []);

  const beginInitialization = useCallback((target: MainCreationTarget): MainInitializationToken => {
    initializingRef.current += 1;
    setInitializing((value) => value + 1);
    return { id: ++initializationId.current, intent: target.intent, target };
  }, []);
  const finishInitialization = useCallback((token: MainInitializationToken, path: string) => {
    const current = depsRef.current.readState().destination;
    if (token.intent !== intentRef.current || current.intent !== token.intent) return;
    if (current.phase !== "ready-code" || current.code.kind !== "project-landing" || current.code.project !== token.target.cwd) return;
    transition({ phase: "ready-code", intent: token.intent, code: { kind: "project-session", project: token.target.cwd, path } });
  }, [transition]);
  const endInitialization = useCallback((_token: MainInitializationToken) => {
    initializingRef.current = Math.max(0, initializingRef.current - 1);
    setInitializing((value) => Math.max(0, value - 1));
  }, []);

  const onAssistantThreadChange = useCallback((path: string | undefined) => {
    const current = depsRef.current.readState().destination;
    if (!path || initializingRef.current > 0 || !isMainReady(current) || path === mainPath(current)) return;
    void openSession(path).catch(() => {});
  }, [openSession]);

  useEffect(() => {
    if (state.connection !== "open" || !state.sessionsLoaded || startupHandled.current) return;
    startupHandled.current = true;
    const parsed = parseSessionHash(globalThis.location?.hash ?? "");
    const consume = () => {
      const { pathname, search } = globalThis.location;
      globalThis.history?.replaceState(null, "", `${pathname}${search}`);
    };
    const current = depsRef.current.readState().destination;
    if (explicitIntent.current) {
      if (parsed.kind !== "none") consume();
      setStartupRestoring(false);
      return;
    }
    if (parsed.kind === "invalid") {
      consume();
      depsRef.current.onError(parsed.error);
      const remembered = projectReturnOf(readDestinationMemory().code);
      const code = remembered.kind === "project-session"
        ? { kind: "project-landing" as const, project: remembered.project }
        : remembered;
      const target: MainTarget = { kind: "code-tab", code };
      const intent = begin(target, true);
      void resolveTarget(target, intent).catch(() => {}).finally(() => setStartupRestoring(false));
      return;
    }
    if (parsed.kind === "session") {
      consume();
      void openSession(parsed.path).catch(() => {}).finally(() => setStartupRestoring(false));
      return;
    }
    if (current.intent > 0) { setStartupRestoring(false); return; }
    const initial = current;
    const target = initial.phase === "resolving" ? initial.target : { kind: "code-tab", code: rememberedCodeOf(initial) } satisfies MainTarget;
    const intent = begin(target, true);
    void resolveTarget(target, intent).catch(() => {}).finally(() => setStartupRestoring(false));
  }, [begin, openSession, resolveTarget, state.connection, state.sessionsLoaded]);

  useEffect(() => {
    const current = state.destination;
    if (state.connection !== "open" || current.phase !== "resolving" || current.target.kind !== "chat-tab") return;
    if (!state.agents.snapshot?.workspaces.chat) return;
    void resolveTarget(current.target, current.intent).catch(() => {});
  }, [resolveTarget, state.agents.snapshot?.workspaces.chat, state.connection, state.destination]);

  useEffect(() => {
    if (state.connection === "open" && (isMainReady(state.destination) || state.destination.phase === "unavailable")) setStartupRestoring(false);
  }, [state.connection, state.destination]);

  return useMemo(() => ({
    startupRestoring,
    initializing,
    controlledPath: initializing > 0 ? heldPath.current : mainPath(state.destination),
    goTab,
    goProject,
    openSession,
    newSession,
    retry,
    leave,
    setCodeProject,
    setDefaultCodeProject,
    closeMainView,
    replaceMainSession,
    creationTarget,
    beginInitialization,
    finishInitialization,
    endInitialization,
    onAssistantThreadChange,
  }), [beginInitialization, closeMainView, creationTarget, endInitialization, finishInitialization, goProject, goTab, initializing, leave, newSession, onAssistantThreadChange, openSession, replaceMainSession, retry, setCodeProject, setDefaultCodeProject, startupRestoring, state.destination]);
}
