import { storageKey } from "@lasercode/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

// Agent map (M13-T7): the main-column view and its fullscreen host.
import { AgentMapFullscreen, AgentMapView, useMapUi } from "@/components/agents/map";
import { Dock } from "@/components/dock";
import { MobileSurfaces } from "@/components/mobile";
import { Thread } from "@/components/thread/Thread";
import { GoalBar } from "@/components/thread/GoalBar";
import { Workbench, WorkbenchProvider } from "@/components/workbench";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileLinkDirectory } from "@/components/ui/source-file-link";
import { useBreakpoint, useIsWide, useKeyboardInset } from "@/hooks";
import { PanelAmbient, PanelDecisionSheet, PanelsProvider, POPOUT_HASH_PREFIX, PoppedOutPanel } from "@/panels";
import { FleetSheet, RunTabs } from "@/components/subagents";
// Agents leap (Lane U2): the one "End agent?" confirmation, asked from row
// menus, run tabs and the live map through `requestEndAgent`.
import { EndAgentDialog } from "@/components/agents/EndAgentDialog";
// Beam: the bubble and its model choice, mounted once (docs/agents.md "Beam").
import { BeamBubble, BeamModelDialog } from "@/components/beam";
import { mergeSessions, sessionTitle, useLaserStable, useLaserState, useLaserView } from "@/runtime";

import { AddProjectDialog } from "./AddProjectDialog.js";
import { HostConnectionState, HostVersionNotice } from "@/components/assistant-ui/elements/connection-state";
import { StartupRestorationGate } from "@/components/assistant-ui/elements/loading-state";
import { CommandPaletteDialog } from "./CommandPalette.js";
import { GlobalSearch } from "./GlobalSearch.js";
import { FirstRunFlow, useSetupPending } from "@/components/onboarding";
import { documentTitle, needYouCount } from "./model.js";
import { Rail } from "./Rail.js";
import { SessionsPanel } from "./SessionsPanel.js";
import { errorText, isEditableTarget, ShellContext, type ShellContextValue } from "./shell-context.js";
import { TelemetryPanel } from "./TelemetryPanel.js";
import { Toasts } from "./Toasts.js";
import { TrustDialog } from "./TrustDialog.js";
import { TopBar } from "./TopBar.js";

export const PANELS_STORAGE_KEY = storageKey("panels");

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
/** The location hash, live. A popped-out panel is a whole page of its own. */
function useHash(): string {
  const [hash, setHash] = useState(() => globalThis.location?.hash ?? "");
  useEffect(() => {
    const onChange = () => setHash(globalThis.location?.hash ?? "");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function Shell() {
  const view = useLaserView();
  const versionMismatch = useLaserState((state) => state.versionMismatch);
  const hash = useHash();
  const { startupRestoring } = useLaserStable();
  const connection = useLaserState((state) => state.connection);
  const content = hash.startsWith(POPOUT_HASH_PREFIX) ? (
    <TooltipProvider>
      <PanelsProvider>
        <PoppedOutPanel hash={hash} />
      </PanelsProvider>
    </TooltipProvider>
  ) : (
    <ShellFrame />
  );

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <HostVersionNotice />
      <div className="relative min-h-0 flex-1" inert={!!versionMismatch}>
    <StartupRestorationGate
      active={startupRestoring}
      label={versionMismatch ? "Waiting for the update before reconnecting" : connection === "open" ? "Returning to your last session" : "Connecting to your workspace"}
      notice={<HostConnectionState className="absolute inset-x-0 top-0 z-20" />}
    >
      <FileLinkDirectory.Provider value={view?.state.cwd}>{content}</FileLinkDirectory.Provider>
    </StartupRestorationGate>
      </div>
    </div>
  );
}

function ShellFrame() {
  useKeyboardInset();
  const layout = useBreakpoint();
  const isWide = useIsWide();
  const desktop = layout === "desktop";
  const { currentProject, actions } = useLaserStable();
  const view = useLaserView();
  const connection = useLaserState((s) => s.connection);
  const sessions = useLaserState((s) => s.sessions);

  const [prefs, setPrefs] = useState<PanelPrefs>(readPrefs);
  const [sheets, setSheets] = useState({ sessions: false, telemetry: false });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sessionsLoaded = useLaserState((s) => s.sessionsLoaded);
  // Agent map (M13-T7): the top bar's toggle swaps the main column to the map.
  const mapOpen = useMapUi().open;
  // First run (M10-T6): the host says whether setup is still pending; the
  // flow takes the conversation's place until it is finished or skipped.
  const setup = useSetupPending();

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

  // Keyboard: [ ] toggle rails, Cmd/Ctrl+N new session, Cmd/Ctrl+K the
  // palette. Esc is handled by the overlays themselves (Radix) and by the
  // inline rename fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
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

  // Tab title carries the same vocabulary as the dots: "(2) name · laser".
  // Derived in the selector: a streamed token that changes no session's
  // attention must not re-render the whole shell.
  const needYou = useLaserState((s) => needYouCount(mergeSessions(s.sessions, s.open), s.open));
  useEffect(() => {
    const summary = view ? sessions.find((s) => s.path === view.path) : undefined;
    const title = view ? (summary ? sessionTitle(summary, view) : (view.state.name ?? view.title ?? "New session")) : undefined;
    document.title = documentTitle(title, needYou);
  }, [needYou, sessions, view]);

  /**
   * Nothing has been set up yet and there is no session to look at. Hooks all
   * run above this line, so the branch below is a render decision only.
   */
  const firstRun = sessionsLoaded && !view && setup.pending === true;

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
      toolsOpen,
      setToolsOpen,
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
      toolsOpen,
      toggleSessions,
      toggleTelemetry,
    ],
  );

  // First run (M10-T6) owns the whole window.
  //
  // It used to render *inside* the shell, and the result argued with itself:
  // the card said "step 4 of 5: open a project" while the left panel said "No
  // project yet — [Add project]", the right panel said "Nothing to measure",
  // the top bar offered "New session", and on a phone a back chevron led
  // nowhere. Four empty states, four vocabularies, and two of them bypassed
  // the flow entirely. A person setting up for the first time should have one
  // thing on screen and one next step.
  //
  // `HostConnectionState` stays: if the host goes away mid-setup, that is the
  // only thing worth saying, and the flow cannot continue without it.
  if (firstRun) {
    return (
      <TooltipProvider>
        <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-ink">
          <HostConnectionState />
          <FirstRunFlow setup={setup} />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <PanelsProvider>
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
              {/* The run tree: one level of children of whatever is focused
                  (docs/ux-agent-work.md). Renders nothing when the session has
                  no agent work. */}
              <RunTabs />
              <GoalBar />
              <HostConnectionState />
              {/* The thread's sticky footer owns the keyboard/safe-area inset
                  (Thread.tsx); adding it here too lifted the composer twice. */}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                {/* Agent map (M13-T7): the live map in place of the thread while toggled. */}
                {mapOpen && view ? <AgentMapView /> : <Thread statusSlot={<PanelAmbient />} />}
              </div>
            </main>
            {layout !== "mobile" && <Dock path={view?.path} />}
            {desktop && telemetryOpen && <TelemetryPanel variant="panel" />}
            {/* Agent map (M13-T7): the fullscreen host, under the workbench so Settings still wins. */}
            <AgentMapFullscreen />
            <Workbench />
          </div>
        </div>

        {!desktop && (
          <>
            <Sheet open={sheets.sessions} onOpenChange={(open) => setSheets((s) => ({ ...s, sessions: open }))}>
              <SheetContent side="left" className="w-[min(88vw,288px)]">
                <SheetTitle className="sr-only">Sessions</SheetTitle>
                <SheetDescription className="sr-only">Every project’s sessions, attention first.</SheetDescription>
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
        <CommandPaletteDialog open={paletteOpen} onOpenChange={setPaletteOpen} />
        <GlobalSearch />
        <TrustDialog />
        <PanelDecisionSheet />
        <FleetSheet />
        <EndAgentDialog />
        <BeamBubble />
        <BeamModelDialog />
        <Toasts />
        {/* The reconnect guard and service-worker plumbing on every width; the
            phone's notices and install sheet only under 768px. */}
        <MobileSurfaces />
      </ShellContext.Provider>
      </WorkbenchProvider>
      </PanelsProvider>
    </TooltipProvider>
  );
}
