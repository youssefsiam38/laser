import type { SessionState } from "@lasercode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Action, AppState } from "../store.js";
import { isUnstartedSession, type NewSessionOptions, type SessionLaunchOptions } from "./new-session.js";
import {
  codeDestinationForSession,
  creationTargetForDestination,
  destinationSessionForTab,
  emptyCodeDestination,
  isMainReady,
  isSessionInCodeProject,
  mainCodeProject,
  mainLandingKey,
  mainPath,
  mainTab,
  pendingSessionPath,
  projectReturnOf,
  rememberedCodeOf,
  type CodeDestination,
  type MainCreationTarget,
  type MainDestination,
  type MainTab,
  type MainTarget,
  type ProjectCodeDestination,
} from "./main-destination.js";
import { DEVICE_KEYS, deviceStore } from "./device-storage.js";
import { rememberSessionsTab, rememberedSessionsTab, sessionKindTab } from "./session-tab-memory.js";
import { mergeSessions } from "./threadList.js";

/**
 * The remembered destination names a project directory and a session path, so
 * it belongs to one environment and is read through `deviceStore` (RP-13).
 * Before the environment is known there is nothing to read, which is why the
 * app starts with no memory and adopts it at `restoreDestination`.
 */
interface DestinationMemory {
  v: 3;
  tab: MainTab;
  code: CodeDestination;
  /** Derived from this namespace's older project/session pair, not from `destination`. */
  legacy?: boolean;
}

const readMap = (key: typeof DEVICE_KEYS.sessionsByProject): Record<string, string> => {
  const value = deviceStore.readJson(key, (parsed) =>
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined);
  return Object.fromEntries(Object.entries(value ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

/** The last session opened per project, for this environment. */
export function rememberedSessions(): Record<string, string> {
  return readMap(DEVICE_KEYS.sessionsByProject);
}

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

/**
 * What this environment remembers, or nothing.
 *
 * There is no migration path from the pre-environment keys: they recorded
 * projects and sessions without recording which environment they came from,
 * so adopting them here would be guessing (docs/environment-policy.md §7).
 * They are purged instead, and a person's first visit to an environment opens
 * where a first visit opens.
 */
export function readDestinationMemory(): DestinationMemory {
  const stored = deviceStore.readJson(DEVICE_KEYS.destination, (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  // v2 carried a Chat path. Keep its Code/tab memory while deliberately
  // ignoring that path: Chat identity is process-local from v3 onward.
  const code = stored?.["v"] === 3 || stored?.["v"] === 2 ? codeDestination(stored["code"]) : undefined;
  if (stored && code) {
    return {
      v: 3,
      tab: stored["tab"] === "chat" ? "chat" : "code",
      code,
    };
  }
  // An older build of this same environment wrote a project and a per-project
  // session instead of a destination. Those are inside this namespace, so they
  // are this environment's own history and are read as migration inputs.
  const project = deviceStore.read(DEVICE_KEYS.project);
  const remembered = project ? rememberedSessions()[project] : undefined;
  const older: CodeDestination = project
    ? remembered ? { kind: "project-session", project, path: remembered } : { kind: "project-landing", project }
    : emptyCodeDestination;
  return { v: 3, tab: rememberedSessionsTab(), code: older, legacy: true };
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
  const tab = mainTab(destination);
  const code = rememberedCodeOf(destination);
  deviceStore.writeJson(DEVICE_KEYS.destination, { v: 3, tab, code } satisfies DestinationMemory);
  // Which tab was last shown is an enum, not a place: it stays unscoped, so a
  // person who prefers Chat gets Chat in every environment.
  rememberSessionsTab(tab);
  deviceStore.write(DEVICE_KEYS.project, mainCodeProject(destination));
  const projectTarget = projectReturnOf(code);
  if (projectTarget.kind === "project-session") {
    const sessions = rememberedSessions();
    if (sessions[projectTarget.project] !== projectTarget.path) {
      deviceStore.writeJson(DEVICE_KEYS.sessionsByProject, { ...sessions, [projectTarget.project]: projectTarget.path });
    }
  }
}

export type MainInitializationToken = Readonly<{ id: number; intent: number; target: MainCreationTarget }>;

export interface MainDestinationControllerDeps {
  state: AppState;
  readState(): AppState;
  dispatch(action: Action): void;
  loadSession(path: string): Promise<void>;
  /**
   * Put this device's last view of the chosen conversation on screen, now
   * (RP-11). Synchronous by contract: it runs in the same turn as the person's
   * click, before anything is asked of the host, so the rows are committed in
   * the same frame as the selection. It paints nothing when there is no valid
   * cached tail, and what it paints is never authority.
   */
  paintProvisional(path: string, intent: number): void;
  launchSession(cwd: string, options?: SessionLaunchOptions): Promise<string>;
  releaseLanding(path: string): void;
  archived(path: string): boolean;
  onError(error: unknown): void;
  beforeTransition(destination: MainDestination): void;
  /** The landing at `key` is becoming this session; restore the draft onto it. */
  onLandingAdopted?(key: string, path: string): void;
  /** True while this landing already has a Send in flight. */
  sendInFlight?(): boolean;
}

export interface MainDestinationController {
  startupRestoring: boolean;
  initializing: number;
  /** The Chat conversation selected during this renderer process, never device storage. */
  chatPath: string | undefined;
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
  const [chatPath, setChatPath] = useState<string | undefined>(undefined);
  const chatPathRef = useRef<string | undefined>(undefined);
  chatPathRef.current = chatPath;
  const environmentKey = state.environment?.environmentKey;
  const previousEnvironmentKey = useRef<string | undefined>(environmentKey);
  const initializingRef = useRef(0);
  const landingLaunch = useRef<{
    intent: number;
    cwd: string;
    agentName: string | undefined;
    returnTo: CodeDestination;
  } | undefined>(undefined);
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
    // The row is chosen and pinned: this is the moment this device can show
    // what it last saw, before a single byte is asked of the host (RP-11).
    depsRef.current.paintProvisional(path, intent);
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
      chatPathRef.current = path;
      setChatPath(path);
      return transition({ phase: "ready-chat", intent, chat: { kind: "session", path }, rememberedCode: previous });
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
      const remembered = rememberedSessions()[target.project];
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
    const remembered = chatPathRef.current;
    if (remembered) { await resolveSession(remembered, intent); return; }
    const current = depsRef.current.readState().destination;
    if (current.phase === "resolving" && current.intent === intent) {
      transition({ phase: "ready-chat", chat: { kind: "landing" }, intent, rememberedCode: current.rememberedCode });
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
    if (chatPathRef.current === path) {
      chatPathRef.current = undefined;
      setChatPath(undefined);
      const intent = begin({ kind: "chat-tab" });
      transition({ phase: "ready-chat", chat: { kind: "landing" }, intent, rememberedCode: rememberedCodeOf(current) });
      return;
    }
    const code = projectReturnOf(rememberedCodeOf(current));
    const intent = begin({ kind: "code-tab", code });
    readyCode(intent, code.kind === "project-session" ? { kind: "project-landing", project: code.project } : code);
  }, [begin, readyCode, transition]);

  const replaceMainSession = useCallback((from: string, session: SessionState) => {
    const snapshot = depsRef.current.readState();
    const current = snapshot.destination;
    if (mainPath(current) !== from) return;
    const intent = ++intentRef.current;
    const sessions = mergeSessions(snapshot.sessions, snapshot.open);
    const replacement = sessions.find((item) => item.path === session.path);
    if (replacement && sessionKindTab(replacement, snapshot.agents.snapshot?.workspaces ?? {}) === "chat") {
      chatPathRef.current = session.path;
      setChatPath(session.path);
      transition({ phase: "ready-chat", intent, chat: { kind: "session", path: session.path }, rememberedCode: rememberedCodeOf(current) });
      return;
    }
    if (chatPathRef.current === from) {
      chatPathRef.current = undefined;
      setChatPath(undefined);
    }
    const code = replacement
      ? codeDestinationForSession(replacement, sessions, snapshot.agents.runs, rememberedCodeOf(current))
      : rememberedCodeOf(current);
    transition({ phase: "ready-code", intent, code });
  }, [transition]);

  const creationTarget = useCallback(() => {
    const snapshot = depsRef.current.readState();
    const target = creationTargetForDestination(snapshot.destination, snapshot.agents.snapshot?.workspaces.chat);
    if (!target) return undefined;
    const pending = landingLaunch.current;
    if (pending && pending.intent === target.intent && pending.cwd === target.cwd && pending.agentName !== undefined) {
      return { ...target, agentName: pending.agentName };
    }
    return target;
  }, []);

  const beginInitialization = useCallback((target: MainCreationTarget): MainInitializationToken => {
    initializingRef.current += 1;
    setInitializing((value) => value + 1);
    return { id: ++initializationId.current, intent: target.intent, target };
  }, []);
  const finishInitialization = useCallback((token: MainInitializationToken, path: string) => {
    const snapshot = depsRef.current.readState();
    const current = snapshot.destination;
    if (token.intent !== intentRef.current || current.intent !== token.intent) return;
    if (token.target.agentName === "chat") {
      if (current.phase !== "ready-chat" || current.chat.kind !== "landing") return;
      chatPathRef.current = path;
      setChatPath(path);
      transition({ phase: "ready-chat", intent: token.intent, chat: { kind: "session", path }, rememberedCode: current.rememberedCode });
      return;
    }
    if (current.phase !== "ready-code" || current.code.kind !== "project-landing" || current.code.project !== token.target.cwd) return;
    const sessions = mergeSessions(snapshot.sessions, snapshot.open);
    const session = sessions.find((item) => item.path === path);
    const previous = landingLaunch.current?.intent === token.intent
      ? landingLaunch.current.returnTo
      : current.code;
    const code = session
      ? codeDestinationForSession(session, sessions, snapshot.agents.runs, previous)
      : { kind: "project-session" as const, project: token.target.cwd, path };
    transition({ phase: "ready-code", intent: token.intent, code });
  }, [transition]);
  const endInitialization = useCallback((_token: MainInitializationToken) => {
    initializingRef.current = Math.max(0, initializingRef.current - 1);
    setInitializing((value) => Math.max(0, value - 1));
  }, []);

  const newSession = useCallback(async (cwd: string, options: NewSessionOptions = {}): Promise<string> => {
    if (options.select === false) return depsRef.current.launchSession(cwd, { ...options, select: false });
    const visibleTab: MainTab = options.agentName === "chat" ? "chat" : "code";
    const snapshot = depsRef.current.readState();
    const current = snapshot.destination;
    const currentPath = mainPath(current);
    const currentView = currentPath ? snapshot.open[currentPath] : undefined;
    const currentSession = currentPath
      ? mergeSessions(snapshot.sessions, snapshot.open).find((item) => item.path === currentPath)
      : undefined;
    const resolveAgent = (name: string | undefined) => name ?? snapshot.agents.snapshot?.defaultAgent;
    const onUnstarted = !!(currentPath && currentView && currentSession
      && isUnstartedSession(currentView)
      && !depsRef.current.archived(currentPath)
      && currentSession.cwd === cwd
      && resolveAgent(currentSession.agent?.agentName) === resolveAgent(options.agentName)
      && mainTab(current) === visibleTab);
    const pending = landingLaunch.current;
    const onMatchingLanding = visibleTab === "chat"
      ? current.phase === "ready-chat" && current.chat.kind === "landing"
      : current.phase === "ready-code" && current.code.kind === "project-landing" && current.code.project === cwd
        && resolveAgent(pending?.agentName) === resolveAgent(options.agentName);
    let intent = current.intent;
    if (!onUnstarted && !onMatchingLanding) {
      depsRef.current.beforeTransition(current);
      explicitIntent.current = true;
      intent = ++intentRef.current;
      if (visibleTab === "chat") {
        transition({
          phase: "ready-chat",
          intent,
          chat: { kind: "landing" },
          rememberedCode: rememberedCodeOf(current),
        });
      } else {
        transition({
          phase: "ready-code",
          intent,
          code: { kind: "project-landing", project: cwd },
        });
      }
    } else {
      explicitIntent.current = true;
    }
    landingLaunch.current = { intent, cwd, agentName: options.agentName, returnTo: rememberedCodeOf(current) };
    if (onUnstarted) {
      return depsRef.current.launchSession(cwd, { ...options, select: false, landing: true });
    }
    let path: string | undefined;
    try {
      path = await depsRef.current.launchSession(cwd, { ...options, select: false, landing: true });
      if (intent !== intentRef.current) return path;
      // First Send already joined this launch: its initialize() adopts the path
      // onto the landing composer. Adopting here would reset that composer.
      // The initialize bracket increments after an await, so also skip when a
      // send is already waiting on this landing.
      if (initializingRef.current > 0 || depsRef.current.sendInFlight?.()) return path;
      const after = depsRef.current.readState().destination;
      const landingKey = mainLandingKey(after);
      if (!landingKey) return path;
      depsRef.current.beforeTransition(after);
      finishInitialization({
        id: 0,
        intent,
        target: { cwd, intent, ...(options.agentName !== undefined ? { agentName: options.agentName } : {}) },
      }, path);
      depsRef.current.onLandingAdopted?.(landingKey, path);
      return path;
    } finally {
      if (path !== undefined) depsRef.current.releaseLanding(path);
      if (landingLaunch.current?.intent === intent && intent !== intentRef.current) landingLaunch.current = undefined;
    }
  }, [finishInitialization, transition]);

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
    if (environmentKey === undefined) return;
    const previous = previousEnvironmentKey.current;
    previousEnvironmentKey.current = environmentKey;
    if (previous === undefined || previous === environmentKey) return;
    chatPathRef.current = undefined;
    setChatPath(undefined);
  }, [environmentKey]);

  useEffect(() => {
    if (state.connection === "open" && (isMainReady(state.destination) || state.destination.phase === "unavailable")) setStartupRestoring(false);
  }, [state.connection, state.destination]);

  return useMemo(() => ({
    startupRestoring,
    initializing,
    chatPath,
    // While a navigation resolves, the thread stays bound to the row that was
    // chosen: letting it fall to an unbound thread is what used to put an empty
    // new-session frame between two conversations (RP-11).
    controlledPath: initializing > 0 ? heldPath.current : mainPath(state.destination) ?? pendingSessionPath(state.destination),
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
  }), [beginInitialization, chatPath, closeMainView, creationTarget, endInitialization, finishInitialization, goProject, goTab, initializing, leave, newSession, onAssistantThreadChange, openSession, replaceMainSession, retry, setCodeProject, setDefaultCodeProject, startupRestoring, state.destination]);
}
