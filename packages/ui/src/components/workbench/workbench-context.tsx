"use client";
/**
 * The workbench: laser's full-window screens that are not a transcript —
 * Settings (M4-T2/T3/T4), Logs (M4-T6) and Agents (M13-T5).
 *
 * They are one overlay rather than a route because the app has no router and
 * because all of them are things you step into and back out of: the project rail
 * stays put, Escape returns you to the session you were reading, and the
 * transcript behind keeps streaming.
 */
import type { AgentLocation } from "@lasercode/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { deviceStore } from "@/runtime/device-storage";
import {
  normalizeSettingsScope,
  sameSettingsScope,
  settingsScopeStore,
  type SettingsScopeState,
} from "@/runtime/settings-scope";

export type WorkbenchPage = "settings" | "logs" | "agents";

/** Which settings tab to land on when a caller knows the useful destination. */
export type SettingsTab = "general" | "advanced" | "appearance" | "features" | "models" | "usage" | "keyboard" | "trust" | "device";

/**
 * A Settings deep link may carry an explicit target. Omitting `scope` is
 * deliberately scope-neutral: no caller gets to infer one from app navigation.
 */
export interface SettingsTarget {
  tab?: SettingsTab | undefined;
  scope?: SettingsScopeState | undefined;
}

/**
 * A deep link into the Agents page: the agent to open, and the field to land
 * on (an `AgentWarning.field` or `AgentIssue.field`, e.g. `skills`,
 * `allowedAgents`, `model`).
 */
export interface AgentsTarget {
  agent: string;
  /** Exact source when a source-aware surface knows it. Name-only links resolve Global only. */
  location?: AgentLocation | undefined;
  field?: string | undefined;
}

export type SettingsScopeChangeReason = "control" | "deep-link";

export interface SettingsScopeChangeRequest {
  current: SettingsScopeState;
  next: SettingsScopeState;
  reason: SettingsScopeChangeReason;
}

/**
 * The one guarded scope editor currently mounted in Settings/Agents.
 *
 * Callers must memoize this callback. If it accepts after a newer navigation,
 * its save/discard still belongs to the original editor target, while the
 * sequence fence keeps that older destination from replacing the newer one.
 * Same-scope page/tab navigation is intentionally outside this scope seam;
 * the future Agent editor owns that separate protection.
 */
export type SettingsScopeNavigationGuard = (
  request: SettingsScopeChangeRequest,
) => boolean | Promise<boolean>;

/**
 * Structured scope-changing Settings links return their acceptance. All plain
 * navigation keeps the original synchronous behavior.
 */
export interface WorkbenchOpen {
  (page: "settings", target: SettingsTarget & { scope: SettingsScopeState }): Promise<boolean>;
  (page: "settings", target?: SettingsTab | SettingsTarget): void | Promise<boolean>;
  (page: "agents", target: AgentsTarget & { location: AgentLocation }): Promise<boolean>;
  (page: "agents", target?: AgentsTarget): void | Promise<boolean>;
  (page: "logs"): void | Promise<boolean>;
  (page: WorkbenchPage): void | Promise<boolean>;
}

export interface Workbench {
  page: WorkbenchPage | null;
  /** Set only when the caller asked for a specific settings tab. */
  tab: SettingsTab | undefined;
  /** A fresh object for every explicit Settings target. */
  settings: SettingsTarget | undefined;
  /** A fresh object for every explicit Agents target. */
  agents: AgentsTarget | undefined;
  settingsScope: SettingsScopeState;
  requestSettingsScope: (
    next: SettingsScopeState,
    reason?: SettingsScopeChangeReason,
  ) => Promise<boolean>;
  registerSettingsScopeGuard: (guard: SettingsScopeNavigationGuard) => () => void;
  open: WorkbenchOpen;
  close: () => void;
}

const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("useWorkbench must be used inside <WorkbenchProvider>.");
  return value;
}

/** Register the one memoized Settings-scope guard, and nothing broader. */
export function useSettingsScopeNavigationGuard(
  guard: SettingsScopeNavigationGuard | undefined,
): void {
  const { registerSettingsScopeGuard } = useWorkbench();
  useEffect(() => {
    if (!guard) return undefined;
    return registerSettingsScopeGuard(guard);
  }, [guard, registerSettingsScopeGuard]);
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<WorkbenchPage | null>(null);
  const [tab, setTab] = useState<SettingsTab>();
  const [settings, setSettings] = useState<SettingsTarget>();
  const [agents, setAgents] = useState<AgentsTarget>();
  const settingsScope = useSyncExternalStore(settingsScopeStore.subscribe, settingsScopeStore.getSnapshot);
  const requestSequence = useRef(0);
  const guardRef = useRef<{
    guard: SettingsScopeNavigationGuard;
    environmentKey: string | undefined;
  } | undefined>(undefined);

  // Same-environment reconnects preserve the mounted editor and its guard.
  // Every real namespace/lifecycle transition fences pending navigation and
  // discards a guard whose anchored draft cannot belong to the next namespace.
  useEffect(() => deviceStore.subscribe((event) => {
    if (event.kind === "activated" && event.transition === "same") return;
    requestSequence.current += 1;
    guardRef.current = undefined;
  }), []);

  const registerSettingsScopeGuard = useCallback((guard: SettingsScopeNavigationGuard) => {
    const registration = { guard, environmentKey: deviceStore.status().environmentKey };
    guardRef.current = registration;
    return () => {
      if (guardRef.current === registration) guardRef.current = undefined;
    };
  }, []);

  const requestSettingsScope = useCallback(async (
    requested: SettingsScopeState,
    reason: SettingsScopeChangeReason = "control",
  ): Promise<boolean> => {
    const next = normalizeSettingsScope(requested);
    if (!next) return false;
    // Even a no-op scope request is newer navigation and fences an older guard
    // that is still waiting for a decision.
    const sequence = ++requestSequence.current;
    const current = settingsScopeStore.getSnapshot();
    if (sameSettingsScope(current, next)) return true;

    const environmentKey = deviceStore.status().environmentKey;
    const registration = guardRef.current;
    let accepted = true;
    if (registration && registration.environmentKey === environmentKey) {
      try {
        accepted = await registration.guard({ current, next, reason });
      } catch {
        accepted = false;
      }
    }

    if (
      !accepted
      || sequence !== requestSequence.current
      || environmentKey !== deviceStore.status().environmentKey
    ) return false;
    return settingsScopeStore.set(next);
  }, []);

  const commitOpen = useCallback((next: WorkbenchPage, arg?: SettingsTab | SettingsTarget | AgentsTarget) => {
    setPage(next);
    const settingsTarget = next === "settings"
      ? typeof arg === "string"
        ? { tab: arg }
        : arg && typeof arg === "object"
          ? { ...arg } as SettingsTarget
          : undefined
      : undefined;
    setSettings(settingsTarget);
    setTab(settingsTarget?.tab);
    setAgents(next === "agents" && arg !== undefined && typeof arg === "object" ? { ...arg } as AgentsTarget : undefined);
  }, []);

  const guardSameScopeNavigation = useCallback(async (): Promise<boolean> => {
    const sequence = ++requestSequence.current;
    const current = settingsScopeStore.getSnapshot();
    const environmentKey = deviceStore.status().environmentKey;
    const registration = guardRef.current;
    let accepted = true;
    if (registration && registration.environmentKey === environmentKey) {
      try {
        accepted = await registration.guard({ current, next: current, reason: "deep-link" });
      } catch {
        accepted = false;
      }
    }
    // Even an unguarded same-scope link commits in a microtask. Recheck there
    // so a same-tick close or newer destination fences it.
    await Promise.resolve();
    return accepted
      && sequence === requestSequence.current
      && environmentKey === deviceStore.status().environmentKey;
  }, []);

  const open = useCallback((next: WorkbenchPage, arg?: SettingsTab | SettingsTarget | AgentsTarget) => {
    const agentLocation = next === "agents" && typeof arg === "object" && arg !== null
      ? (arg as AgentsTarget).location
      : undefined;
    const explicitScope = next === "settings" && typeof arg === "object" && arg !== null
      ? (arg as SettingsTarget).scope
      : agentLocation?.scope === "global"
        ? { view: "global" as const }
        : agentLocation?.scope === "project"
          ? { view: "project" as const, projectCwd: agentLocation.projectCwd }
          : undefined;
    if (explicitScope !== undefined) {
      // An exact same-scope link can still replace the editor, so it passes
      // through the same owning-screen guard without rewriting the scope.
      if (sameSettingsScope(settingsScopeStore.getSnapshot(), explicitScope)) {
        return guardSameScopeNavigation().then((accepted) => {
          if (!accepted) return false;
          commitOpen(next, arg);
          return true;
        });
      }
      // Nothing about the destination changes before the guard settles. This
      // keeps a dirty source editor mounted when the person chooses Keep editing.
      const request = requestSettingsScope(explicitScope, "deep-link");
      const sequence = requestSequence.current;
      const environmentKey = deviceStore.status().environmentKey;
      return request.then((accepted) => {
        if (
          !accepted
          || sequence !== requestSequence.current
          || environmentKey !== deviceStore.status().environmentKey
        ) return false;
        commitOpen(next, arg);
        return true;
      });
    }

    const registration = guardRef.current;
    if (page !== null && registration && registration.environmentKey === deviceStore.status().environmentKey) {
      return guardSameScopeNavigation().then((accepted) => {
        if (!accepted) return false;
        commitOpen(next, arg);
        return true;
      });
    }

    // Any immediate navigation supersedes an older pending guarded link.
    requestSequence.current += 1;
    commitOpen(next, arg);
  }, [commitOpen, guardSameScopeNavigation, page, requestSettingsScope]) as WorkbenchOpen;

  const close = useCallback(() => {
    const registration = guardRef.current;
    if (!registration || registration.environmentKey !== deviceStore.status().environmentKey) {
      requestSequence.current += 1;
      setPage(null);
      return;
    }
    void guardSameScopeNavigation().then((accepted) => {
      if (accepted) setPage(null);
    });
  }, [guardSameScopeNavigation]);

  // Escape closes the workbench, but never while a dialog, popover or a
  // focused text field is using Escape for its own purpose.
  useEffect(() => {
    if (!page) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[role='dialog'],[data-radix-popper-content-wrapper],input,textarea,[contenteditable='true']")) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page, close]);

  const value = useMemo<Workbench>(() => ({
    page,
    tab,
    settings,
    agents,
    settingsScope,
    requestSettingsScope,
    registerSettingsScopeGuard,
    open,
    close,
  }), [page, tab, settings, agents, settingsScope, requestSettingsScope, registerSettingsScopeGuard, open, close]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}
