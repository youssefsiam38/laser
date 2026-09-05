"use client";
/**
 * The workbench: piorbit's full-window screens that are not a transcript —
 * Settings (M4-T2/T3/T4) and Logs (M4-T6).
 *
 * They are one overlay rather than a route because the app has no router and
 * because both are things you step into and back out of: the project rail stays
 * put, Escape returns you to the session you were reading, and the transcript
 * behind keeps streaming.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type WorkbenchPage = "settings" | "logs";

export interface Workbench {
  page: WorkbenchPage | null;
  open: (page: WorkbenchPage) => void;
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

  const open = useCallback((next: WorkbenchPage) => setPage(next), []);
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

  const value = useMemo<Workbench>(() => ({ page, open, close }), [page, open, close]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}
