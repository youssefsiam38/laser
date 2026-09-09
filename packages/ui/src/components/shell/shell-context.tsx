import { createContext, useContext } from "react";

export type ShellLayout = "mobile" | "tablet" | "desktop";

/**
 * Column state shared by the rail, the top bar and the three side columns.
 * On desktop `sessionsOpen` / `fleetOpen` / `telemetryOpen` are the docked
 * columns, each collapsing on its own; on tablet and mobile they are sheets.
 */
export interface ShellContextValue {
  layout: ShellLayout;
  sessionsOpen: boolean;
  /** The fleet: agent work, immediately left of the monitor. */
  fleetOpen: boolean;
  telemetryOpen: boolean;
  setSessionsOpen(open: boolean): void;
  setFleetOpen(open: boolean): void;
  setTelemetryOpen(open: boolean): void;
  toggleSessions(): void;
  toggleFleet(): void;
  toggleTelemetry(): void;
  /** History section inside the telemetry panel. */
  historyOpen: boolean;
  setHistoryOpen(open: boolean): void;
  /** Reveal the telemetry surface and expand the history section. */
  openHistory(): void;
  /** Tools section inside the telemetry panel (the tool timeline). */
  toolsOpen: boolean;
  setToolsOpen(open: boolean): void;
  addProjectOpen: boolean;
  setAddProjectOpen(open: boolean): void;
  /** Open an unstarted session in the current project (Cmd+N). Surfaces its own errors. */
  newSession(): Promise<void>;
  /** A project is selected and the host is reachable. */
  canCreate: boolean;
  /**
   * A session was chosen: leave everything that covers the chat — the agent
   * map, the fullscreen map, the workbench, the fleet sheet and the compact
   * layouts' sheets — so the chosen session's chat shows (M13-T50).
   */
  showChat(): void;
  /**
   * The logo: `showChat`, then the last opened session — the current one,
   * else the one remembered for the current project, else the project's
   * new-session state. Creates nothing.
   */
  returnToChat(): void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <Shell>.");
  return value;
}

/**
 * The same, for a component that also renders outside the shell — a test
 * harness, a scoped surface. It offers the shell's verbs when they are there
 * and hides them when they are not, rather than throwing.
 */
export function useShellOptional(): ShellContextValue | undefined {
  return useContext(ShellContext) ?? undefined;
}

/** True when a keyboard event originates from something that eats keystrokes. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
