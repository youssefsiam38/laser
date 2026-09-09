import { storageKey } from "@lasercode/protocol";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";

// Agent map (M13-T7): the main-column view and its fullscreen host.
import { AgentMapFullscreen, AgentMapView, useMapUi } from "@/components/agents/map";
import { FleetPanel, FleetSheet } from "@/components/fleet";
import { MobileSurfaces } from "@/components/mobile";
import { Thread } from "@/components/thread/Thread";
import { GoalBar } from "@/components/thread/GoalBar";
import { Workbench, WorkbenchProvider } from "@/components/workbench";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileLinkDirectory } from "@/components/ui/source-file-link";
import { useBreakpoint, useIsWide, useKeyboardInset } from "@/hooks";
import { closeFleetSheet, setFleetSheetOpen, useFleetReconcile, useFleetSheetOpen } from "@/fleet";
// Agents leap (Lane U2): the one "End agent?" confirmation, asked from row
// menus, run tabs and the live map through `requestEndAgent`.
import { EndAgentDialog } from "@/components/agents/EndAgentDialog";
import { RemoveWorktreeDialog } from "@/components/agents/RemoveWorktreeDialog";
// Beam: the bubble and its model choice, mounted once (docs/agents.md "Beam").
import { BeamBubble, BeamModelDialog } from "@/components/beam";
import { mergeSessions, sessionTitle, useLaserStable, useLaserState, useLaserView } from "@/runtime";

import { AddProjectDialog } from "./AddProjectDialog.js";
import { useChatNavigation } from "./chat-navigation.js";
import { HostConnectionState, HostVersionNotice } from "@/components/assistant-ui/elements/connection-state";
import { StartupRestorationGate } from "@/components/assistant-ui/elements/loading-state";
import { CommandPaletteDialog } from "./CommandPalette.js";
import { GlobalSearch } from "./GlobalSearch.js";
import { FirstRunFlow, clearSetupRequest, honourSetupRequest, useSetupPending, useSetupRequested } from "@/components/onboarding";
import { documentTitle, needYouCount } from "./model.js";
import { Rail } from "./Rail.js";
import { SessionsPanel } from "./SessionsPanel.js";
import { errorText, isEditableTarget, ShellContext, type ShellContextValue } from "./shell-context.js";
import { TelemetryPanel } from "./TelemetryPanel.js";
import { Toasts } from "./Toasts.js";
import { TrustDialog } from "./TrustDialog.js";
import { TopBar } from "./TopBar.js";

/**
 * The remembered shape of the window. The key is unchanged on purpose: it is
 * a `storageKey()` value people already have, and renaming the string would
 * silently drop everyone's saved layout. Only the fields inside it changed —
 * `fleet` joined `sessions` and `telemetry` when the fleet became a column.
 */
export const COLUMNS_STORAGE_KEY = storageKey("panels");

interface ColumnPrefs {
  sessions?: boolean;
  /** Absent = follow the viewport (open at ≥1280px). */
  fleet?: boolean;
  /** Absent = follow the viewport (open at ≥1280px). */
  telemetry?: boolean;
}

const readPrefs = (): ColumnPrefs => {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(COLUMNS_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const p = parsed as Record<string, unknown>;
    return {
      ...(typeof p.sessions === "boolean" ? { sessions: p.sessions } : {}),
      ...(typeof p.fleet === "boolean" ? { fleet: p.fleet } : {}),
      ...(typeof p.telemetry === "boolean" ? { telemetry: p.telemetry } : {}),
    };
  } catch {
    return {};
  }
};

const writePrefs = (prefs: ColumnPrefs): void => {
  try {
    globalThis.localStorage?.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
};

/**
 * The app frame. Desktop: rail | sessions | thread | fleet | monitor — three
 * independently collapsible columns around the conversation, the monitor
 * outermost and the fleet immediately inside it. Tablet: rail + thread, with
 * every column as a sheet. Mobile: thread only; the top bar's back chevron
 * opens the sessions sheet. The body never scrolls; the thread viewport does,
 * and on mobile the main column keeps its bottom edge above the on-screen
 * keyboard through `--kb`.
 */
export function Shell() {
  const view = useLaserView();
  const versionMismatch = useLaserState((state) => state.versionMismatch);
  const { startupRestoring } = useLaserStable();
  const connection = useLaserState((state) => state.connection);
  // The workbench sits above the frame so the frame's own verbs can close it:
  // the logo's "back to your chat" leaves Settings and Logs the same way it
  // leaves the map (chat-navigation.tsx).
  const content = (
    <WorkbenchProvider>
      <ShellFrame />
    </WorkbenchProvider>
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
  const { currentProject, actions, dispatch } = useLaserStable();
  const view = useLaserView();
  const connection = useLaserState((s) => s.connection);
  const sessions = useLaserState((s) => s.sessions);

  const [prefs, setPrefs] = useState<ColumnPrefs>(readPrefs);
  const [sheets, setSheets] = useState({ sessions: false, telemetry: false });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sessionsLoaded = useLaserState((s) => s.sessionsLoaded);
  const fleetSheetOpen = useFleetSheetOpen();
  // Agent map (M13-T7): the top bar's toggle swaps the main column to the map.
  const mapOpen = useMapUi().open;
  // First run (M10-T6): the host says whether setup is still pending; the
  // flow takes the conversation's place until it is finished or skipped.
  const setup = useSetupPending();

  // The fleet is primed on connect and after a reconnect; notifications alone
  // would leave a reloaded column quietly wrong.
  useFleetReconcile();

  /**
   * The fleet is a *column* only where a third column fits. There is room for
   * the sessions column and one right column at 1024; a second right column
   * there leaves the conversation about eighty pixels, which is not a narrower
   * layout but a broken one. Below 1280 the fleet is the sheet instead — the
   * same content, summoned rather than resident.
   */
  const fleetIsColumn = desktop && isWide;

  // Sheets belong to the compact layouts; a resize into them drops them.
  useEffect(() => {
    if (desktop) setSheets({ sessions: false, telemetry: false });
  }, [desktop]);
  useEffect(() => {
    if (fleetIsColumn) closeFleetSheet();
  }, [fleetIsColumn]);

  const sessionsOpen = desktop ? (prefs.sessions ?? true) : sheets.sessions;
  const fleetOpen = fleetIsColumn ? (prefs.fleet ?? true) : fleetSheetOpen;
  const telemetryOpen = desktop ? (prefs.telemetry ?? isWide) : sheets.telemetry;

  const updatePrefs = useCallback((patch: ColumnPrefs) => {
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
  const setFleetOpen = useCallback(
    (open: boolean) => {
      if (fleetIsColumn) updatePrefs({ fleet: open });
      else setFleetSheetOpen(open);
    },
    [fleetIsColumn, updatePrefs],
  );
  const setTelemetryOpen = useCallback(
    (open: boolean) => {
      if (desktop) updatePrefs({ telemetry: open });
      else setSheets((s) => ({ ...s, telemetry: open }));
    },
    [desktop, updatePrefs],
  );
  const toggleSessions = useCallback(() => setSessionsOpen(!sessionsOpen), [sessionsOpen, setSessionsOpen]);
  const toggleFleet = useCallback(() => setFleetOpen(!fleetOpen), [fleetOpen, setFleetOpen]);
  // The fleet's column state must not be remembered as "closed" just because
  // the window narrowed past the width a third column needs.
  const toggleTelemetry = useCallback(() => setTelemetryOpen(!telemetryOpen), [telemetryOpen, setTelemetryOpen]);

  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    setTelemetryOpen(true);
  }, [setTelemetryOpen]);

  // The compact layouts' sheets, closed together when a chat is shown. The
  // docked desktop columns are not sheets and stay where the person put them.
  const closeSheets = useCallback(() => {
    setSheets((s) => (s.sessions || s.telemetry ? { sessions: false, telemetry: false } : s));
  }, []);
  // M13-T50: the sidebar's selection and the logo, two ways back to the chat.
  const { showChat, returnToChat } = useChatNavigation({ closeSheets });

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
      // A new session is a navigation to its chat: nothing keeps covering it.
      showChat();
    } catch (error) {
      actions.toast("error", errorText(error));
    }
  }, [actions, connection, currentProject, showChat, view?.state.cwd]);

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
      } else if (e.key === "\\") {
        e.preventDefault();
        toggleFleet();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, toggleFleet, toggleSessions, toggleTelemetry]);

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

  /**
   * Settings → This device → Run setup again. The button cleared the host's
   * flag and left; the flow lives here, so this is where the request is
   * honoured: read the host again (this component holds its own copy of the
   * answer), then leave the open session, because setup owns the whole window
   * and only renders while nothing is open. The session is not closed — its
   * row stays in the sidebar — and the remembered destination is forgotten so
   * a reload in the middle of setup does not bring it back.
   */
  const setupRequested = useSetupRequested();
  const honoured = useRef(false);
  useEffect(() => {
    if (!setupRequested) {
      honoured.current = false;
      return;
    }
    if (honoured.current) return;
    honoured.current = true;
    honourSetupRequest({ refresh: setup.refresh, leaveSession: () => dispatch({ type: "select", path: undefined }) });
  }, [dispatch, setup, setupRequested]);
  // Spent once the flow is on screen, so a second press can ask again.
  useEffect(() => {
    if (setupRequested && firstRun) clearSetupRequest();
  }, [firstRun, setupRequested]);

  const shell = useMemo<ShellContextValue>(
    () => ({
      layout,
      sessionsOpen,
      fleetOpen,
      telemetryOpen,
      setSessionsOpen,
      setFleetOpen,
      setTelemetryOpen,
      toggleSessions,
      toggleFleet,
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
      showChat,
      returnToChat,
    }),
    [
      addProjectOpen,
      canCreate,
      fleetOpen,
      historyOpen,
      layout,
      newSession,
      openHistory,
      returnToChat,
      sessionsOpen,
      setFleetOpen,
      setSessionsOpen,
      setTelemetryOpen,
      showChat,
      telemetryOpen,
      toolsOpen,
      toggleFleet,
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
      <ShellContext.Provider value={shell}>
        <div className="flex h-full w-full overflow-hidden bg-bg text-ink">
          {layout !== "mobile" && <Rail />}
          {/* Everything right of the rail. The workbench (M4 settings and logs)
              covers this area and leaves the project rail reachable. */}
          <div className="relative flex min-h-0 min-w-0 flex-1">
            {desktop && sessionsOpen && <SessionsPanel variant="panel" />}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              <TopBar />
              <GoalBar />
              <HostConnectionState />
              {/* The thread's sticky footer owns the keyboard/safe-area inset
                  (Thread.tsx); adding it here too lifted the composer twice. */}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                {/* Agent map (M13-T7): the live map in place of the thread while toggled. */}
                {mapOpen && view ? <AgentMapView /> : <Thread />}
              </div>
            </main>
            {/* The two right columns, outermost last: the fleet, then the
                monitor (docs/ux-fleet.md "The layout"). */}
            {fleetIsColumn && fleetOpen && <FleetPanel variant="panel" onClose={() => setFleetOpen(false)} />}
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
        {!fleetIsColumn && <FleetSheet />}
        <EndAgentDialog />
        <RemoveWorktreeDialog />
        <BeamBubble />
        <BeamModelDialog />
        <Toasts />
        {/* The reconnect guard and service-worker plumbing on every width; the
            phone's notices and install sheet only under 768px. */}
        <MobileSurfaces />
      </ShellContext.Provider>
    </TooltipProvider>
  );
}
