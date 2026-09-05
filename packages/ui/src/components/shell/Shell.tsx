import { useCallback, useEffect, useMemo, useState } from "react";

import { Thread } from "@/components/thread/Thread";
import { Workbench, WorkbenchProvider } from "@/components/workbench";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useBreakpoint, useIsWide, useKeyboardInset } from "@/hooks";
import { mergeSessions, sessionTitle, usePiorbitStable, usePiorbitState, usePiorbitView } from "@/runtime";

import { AddProjectDialog } from "./AddProjectDialog.js";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { documentTitle, needYouCount } from "./model.js";
import { Rail } from "./Rail.js";
import { SessionsPanel } from "./SessionsPanel.js";
import { errorText, isEditableTarget, ShellContext, type ShellContextValue } from "./shell-context.js";
import { TelemetryPanel } from "./TelemetryPanel.js";
import { Toasts } from "./Toasts.js";
import { TrustDialog } from "./TrustDialog.js";
import { TopBar } from "./TopBar.js";

export const PANELS_STORAGE_KEY = "piorbit-panels";

interface PanelPrefs {
  sessions?: boolean;
  /** Absent = follow the viewport (open at ≥1280px). */
  telemetry?: boolean;
}

const readPrefs = (): PanelPrefs => {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(PANELS_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const p = parsed as Record<string, unknown>;
    return {
      ...(typeof p.sessions === "boolean" ? { sessions: p.sessions } : {}),
      ...(typeof p.telemetry === "boolean" ? { telemetry: p.telemetry } : {}),
    };
  } catch {
    return {};
  }
};

const writePrefs = (prefs: PanelPrefs): void => {
  try {
    globalThis.localStorage?.setItem(PANELS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
};

/**
 * The app frame. Desktop: rail | sessions | thread | telemetry. Tablet: rail
 * + thread with sessions/telemetry as sheets. Mobile: thread only; the top
 * bar's back chevron opens the sessions sheet. The body never scrolls; the
 * thread viewport does, and on mobile the main column keeps its bottom edge
 * above the on-screen keyboard through `--kb`.
 */
export function Shell() {
  useKeyboardInset();
  const layout = useBreakpoint();
  const isWide = useIsWide();
  const desktop = layout === "desktop";
  const { currentProject, actions } = usePiorbitStable();
  const view = usePiorbitView();
  const connection = usePiorbitState((s) => s.connection);
  const sessions = usePiorbitState((s) => s.sessions);

  const [prefs, setPrefs] = useState<PanelPrefs>(readPrefs);
  const [sheets, setSheets] = useState({ sessions: false, telemetry: false });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  // Sheets belong to the compact layouts; a resize to desktop drops them.
  useEffect(() => {
    if (desktop) setSheets({ sessions: false, telemetry: false });
  }, [desktop]);

  const sessionsOpen = desktop ? (prefs.sessions ?? true) : sheets.sessions;
  const telemetryOpen = desktop ? (prefs.telemetry ?? isWide) : sheets.telemetry;

  const updatePrefs = useCallback((patch: PanelPrefs) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);

  const setSessionsOpen = useCallback(
    (open: boolean) => {
      if (desktop) updatePrefs({ sessions: open });
      else setSheets((s) => ({ ...s, sessions: open }));
    },
    [desktop, updatePrefs],
  );
  const setTelemetryOpen = useCallback(
    (open: boolean) => {
      if (desktop) updatePrefs({ telemetry: open });
      else setSheets((s) => ({ ...s, telemetry: open }));
    },
    [desktop, updatePrefs],
  );
  const toggleSessions = useCallback(() => setSessionsOpen(!sessionsOpen), [sessionsOpen, setSessionsOpen]);
  const toggleTelemetry = useCallback(() => setTelemetryOpen(!telemetryOpen), [telemetryOpen, setTelemetryOpen]);

  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    setTelemetryOpen(true);
  }, [setTelemetryOpen]);

  const canCreate = connection === "open" && (currentProject !== undefined || view !== undefined);

  const newSession = useCallback(async () => {
    const cwd = currentProject ?? view?.state.cwd;
    if (!cwd) {
      setAddProjectOpen(true);
      return;
    }
    if (connection !== "open") {
      actions.toast("warning", "Not connected to the host yet.");
      return;
    }
    try {
      await actions.newSession(cwd);
      setSheets((s) => ({ ...s, sessions: false }));
    } catch (error) {
      actions.toast("error", errorText(error));
    }
  }, [actions, connection, currentProject, view?.state.cwd]);

  // Keyboard: [ ] toggle rails, Cmd/Ctrl+N new session. Esc is handled by the
  // overlays themselves (Radix) and by the inline rename fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        void newSession();
        return;
      }
      if (mod || e.altKey || isEditableTarget(e.target)) return;
      if (e.key === "[") {
        e.preventDefault();
        toggleSessions();
      } else if (e.key === "]") {
        e.preventDefault();
        toggleTelemetry();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, toggleSessions, toggleTelemetry]);

  // Tab title carries the same vocabulary as the dots: "(2) name · piorbit".
  // Derived in the selector: a streamed token that changes no session's
  // attention must not re-render the whole shell.
  const needYou = usePiorbitState((s) => needYouCount(mergeSessions(s.sessions, s.open), s.open));
  useEffect(() => {
    const summary = view ? sessions.find((s) => s.path === view.path) : undefined;
    const title = view ? (summary ? sessionTitle(summary, view) : (view.state.name ?? view.title ?? view.state.id.slice(0, 8))) : undefined;
    document.title = documentTitle(title, needYou);
  }, [needYou, sessions, view]);

  const shell = useMemo<ShellContextValue>(
    () => ({
      layout,
      sessionsOpen,
      telemetryOpen,
      setSessionsOpen,
      setTelemetryOpen,
      toggleSessions,
      toggleTelemetry,
      historyOpen,
      setHistoryOpen,
      openHistory,
      addProjectOpen,
      setAddProjectOpen,
      newSession,
      canCreate,
    }),
    [
      addProjectOpen,
      canCreate,
      historyOpen,
      layout,
      newSession,
      openHistory,
      sessionsOpen,
      setSessionsOpen,
      setTelemetryOpen,
      telemetryOpen,
      toggleSessions,
      toggleTelemetry,
    ],
  );

  return (
    <TooltipProvider>
      <WorkbenchProvider>
      <ShellContext.Provider value={shell}>
        <div className="flex h-full w-full overflow-hidden bg-bg text-ink">
          {layout !== "mobile" && <Rail />}
          {/* Everything right of the rail. The workbench (M4 settings and logs)
              covers this area and leaves the project rail reachable. */}
          <div className="relative flex min-h-0 min-w-0 flex-1">
            {desktop && sessionsOpen && <SessionsPanel variant="panel" />}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              <TopBar />
              <ConnectionBanner />
              {/* The thread's sticky footer owns the keyboard/safe-area inset
                  (Thread.tsx); adding it here too lifted the composer twice. */}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <Thread />
              </div>
            </main>
            {desktop && telemetryOpen && <TelemetryPanel variant="panel" />}
            <Workbench />
          </div>
        </div>

        {!desktop && (
          <>
            <Sheet open={sheets.sessions} onOpenChange={(open) => setSheets((s) => ({ ...s, sessions: open }))}>
              <SheetContent side="left" className="w-[min(88vw,288px)]">
                <SheetTitle className="sr-only">Sessions</SheetTitle>
                <SheetDescription className="sr-only">Sessions in the selected project.</SheetDescription>
                <SessionsPanel variant="sheet" />
              </SheetContent>
            </Sheet>
            <Sheet open={sheets.telemetry} onOpenChange={(open) => setSheets((s) => ({ ...s, telemetry: open }))}>
              <SheetContent side="right" className="w-[min(88vw,320px)]">
                <SheetTitle className="sr-only">Telemetry</SheetTitle>
                <SheetDescription className="sr-only">Context, spend, worker state and history for the open session.</SheetDescription>
                <TelemetryPanel variant="sheet" />
              </SheetContent>
            </Sheet>
          </>
        )}

        <AddProjectDialog />
        <TrustDialog />
        <Toasts />
      </ShellContext.Provider>
      </WorkbenchProvider>
    </TooltipProvider>
  );
}
