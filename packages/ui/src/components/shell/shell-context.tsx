import { createContext, useContext } from "react";

export type ShellLayout = "mobile" | "tablet" | "desktop";

/**
 * Panel state shared by the rail, top bar, sessions and telemetry panels.
 * On desktop `sessionsOpen` / `telemetryOpen` are the docked columns; on
 * tablet and mobile they are the sheets.
 */
export interface ShellContextValue {
  layout: ShellLayout;
  sessionsOpen: boolean;
  telemetryOpen: boolean;
  setSessionsOpen(open: boolean): void;
  setTelemetryOpen(open: boolean): void;
  toggleSessions(): void;
  toggleTelemetry(): void;
  /** History section inside the telemetry panel. */
  historyOpen: boolean;
  setHistoryOpen(open: boolean): void;
  /** Reveal the telemetry surface and expand the history section. */
  openHistory(): void;
  addProjectOpen: boolean;
  setAddProjectOpen(open: boolean): void;
  /** `session/new` in the current project (Cmd+N). Surfaces its own errors. */
  newSession(): Promise<void>;
  /** A project is selected and the host is reachable. */
  canCreate: boolean;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <Shell>.");
  return value;
}

/** True when a keyboard event originates from something that eats keystrokes. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
