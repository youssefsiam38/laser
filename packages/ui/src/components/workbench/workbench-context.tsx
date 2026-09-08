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
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type WorkbenchPage = "settings" | "logs" | "agents";

/**
 * Which settings tab to land on. Only ever passed by something that already
 * knows the fix — a rejected credential opening "Providers and models" — so the
 * plain `open("settings")` still lands where it always did.
 */
export type SettingsTab = "general" | "advanced" | "appearance" | "features" | "models" | "usage" | "keyboard" | "trust" | "device";

/**
 * A deep link into the Agents page: the agent to open, and the field to land
 * on (an `AgentWarning.field` or `AgentIssue.field`, e.g. `skills`,
 * `allowedAgents`, `model`). Passed by a warning badge or a run's refusal;
 * the plain `open("agents")` lands on the list.
 */
export interface AgentsTarget {
  agent: string;
  field?: string | undefined;
}

/**
 * `open` keeps its original two-argument shape for Settings and adds the
 * agents form beside it: `open("settings", tab?)`, `open("agents", target?)`,
 * `open("logs")`. A page opened without its argument clears the previous one.
 */
export interface WorkbenchOpen {
  (page: "settings", tab?: SettingsTab): void;
  (page: "agents", target?: AgentsTarget): void;
  (page: "logs"): void;
  (page: WorkbenchPage): void;
}

export interface Workbench {
  page: WorkbenchPage | null;
  /** Set only when the caller asked for a specific settings tab. */
  tab: SettingsTab | undefined;
  /**
   * Set only when the caller asked for a specific agent. A fresh object per
   * request, so asking for the same field twice re-runs the scroll and focus.
   */
  agents: AgentsTarget | undefined;
  open: WorkbenchOpen;
  close: () => void;
}

const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("useWorkbench must be used inside <WorkbenchProvider>.");
  return value;
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<WorkbenchPage | null>(null);
  const [tab, setTab] = useState<SettingsTab>();
  const [agents, setAgents] = useState<AgentsTarget>();

  const open = useCallback((next: WorkbenchPage, arg?: SettingsTab | AgentsTarget) => {
    setPage(next);
    setTab(next === "settings" && typeof arg === "string" ? arg : undefined);
    setAgents(next === "agents" && arg !== undefined && typeof arg === "object" ? { ...arg } : undefined);
  }, []) as WorkbenchOpen;
  const close = useCallback(() => setPage(null), []);

  // Escape closes the workbench, but never while a dialog, popover or a
  // focused text field is using Escape for its own purpose.
  useEffect(() => {
    if (!page) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[role='dialog'],[data-radix-popper-content-wrapper]")) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page, close]);

  const value = useMemo<Workbench>(() => ({ page, tab, agents, open, close }), [page, tab, agents, open, close]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}
