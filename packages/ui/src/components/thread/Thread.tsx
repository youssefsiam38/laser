import { AuiConfig, AuiIf, AuiProvider, Suggestions, ThreadPrimitive, useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ConversationMapAui } from "@/components/assistant-ui/elements/conversation-map.aui";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
import { ConversationLoadingGate } from "@/components/assistant-ui/elements/loading-state";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { SelectionToolbar } from "@/components/assistant-ui/elements/quote.aui";
import { ScrollAnchor } from "@/components/assistant-ui/elements/scroll-anchor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ThreadDialogCards, WaitingNotice } from "@/dialogs";
import { ToolRowScope } from "@/dialogs/tool-rows";
import { useLaserStable, useLaserState, useLaserView, useWholeTranscriptRefusal } from "@/runtime";
import { sessionOpenPhase, sameSessionOpenPhase, visibleSessionPath } from "@/runtime/main-destination";
import { useWorkbench } from "@/components/workbench/workbench-context";
import { WorkerRecoveryNotice } from "@/components/worker-recovery-notice";
import { useSessionSeen } from "./use-session-seen.js";
import { FileOpenerProvider } from "./FileOpener.js";
import { Composer } from "./Composer.js";
import { EmptyState } from "./EmptyState.js";
import { ThreadSlotsProvider, type ThreadSlots } from "./thread-slots.js";
import { useConversationFind } from "./use-conversation-find.js";
import { WholeTranscriptRefusalProvider, useThreadWholeTranscriptRefusal } from "./whole-transcript-refusal.js";
import { FindQueryContext, FindSelectionContext } from "./search-state.js";
import { TranscriptViewportProvider, TranscriptViewportBinding, WindowedMessages, useTranscriptViewport } from "./transcript-viewport.js";

/**
 * The assistant-ui thread column (DESIGN.md "Layout" 3): transcript at max
 * the shared thread measure, the viewport scrolls (never the body), and a sticky footer that holds
 * turn-blocking decisions, queue chips, and the floating composer.
 * The footer's bottom inset is `max(safe-area, --kb)` so the composer rides
 * above the on-screen keyboard.
 *
 * Renders inside `<LaserProvider>`; needs nothing else from the shell.
 * `statusSlot` is the trailing slot of the status line above the composer —
 * the shell mounts the fleet pill there (D-20 §5).
 */
export interface ThreadProps {
  statusSlot?: ReactNode;
  /**
   * The Beam bubble (`components/beam`) renders this same thread for a session
   * that is not about a project: it swaps the project empty state and the
   * repository follow-ups for its own. Absent, the project ones stand.
   */
  emptyState?: ReactNode;
  followUps?: ReadonlyArray<{ title: string; label: string; prompt: string }>;
}

/**
 * What a coding agent is usually asked next. Static on purpose: Pi produces
 * no suggestions of its own, and an invented per-turn set would be a guess
 * dressed as insight (R3). These are real next steps, sent as typed.
 */
const FOLLOW_UPS = AuiConfig({
  suggestions: Suggestions([
    { title: "Run the tests", label: "the test suite", prompt: "Run the test suite and fix anything that fails." },
    { title: "Show the diff", label: "git diff", prompt: "Show me the diff of everything you changed in this session, file by file." },
    { title: "Commit", label: "git commit", prompt: "Commit the changes from this session with a clear, conventional commit message." },
  ]),
});

export function Thread(props: ThreadProps = {}) {
  // The conversation on screen, which during a navigation is the row that was
  // chosen rather than the one still committed (RP-11): tool rows, file opening
  // and find keep following the transcript a person is actually looking at.
  const path = useLaserState(s => visibleSessionPath(s) ?? "");
  return <TranscriptViewportProvider><ToolRowScope scope={path}><ThreadContent {...props} /></ToolRowScope></TranscriptViewportProvider>;
}

function ThreadContent({ statusSlot, emptyState, followUps }: ThreadProps) {
  // Narrow reads only. The session's own view carries `lastSeq` and its blocks,
  // which change with every streamed token; reading it here re-rendered the
  // whole column — viewport, map, footer, composer and every mounted row — per
  // streamed batch. What this component draws changes far more rarely, and the
  // two things that do follow the stream (the seen watermark, the entries
  // refresh) subscribe for themselves below and render nothing.
  const path = useLaserState(s => { const target = visibleSessionPath(s); return target ? s.open[target]?.path : undefined; });
  const partialHistory = useLaserState(s => {
    const target = visibleSessionPath(s);
    const history = target ? s.open[target]?.history : undefined;
    return Boolean(history && !history.complete);
  });
  const suggestions = useMemo(() => (followUps ? AuiConfig({ suggestions: Suggestions([...followUps]) }) : FOLLOW_UPS), [followUps]);
  const { actions, destination } = useLaserStable();
  const open = useLaserState(s => sessionOpenPhase(s, visibleSessionPath(s)), sameSessionOpenPhase);
  const connected = useLaserState(s => s.connection === "open");
  const { page } = useWorkbench();
  // A conversation painted from this device is already on screen: a loading
  // state over it would be a lie, and a skeleton would throw it away (RP-11).
  const loading = open.phase === "opening" && !open.hasTranscript && !open.provisional && open.expectsTranscript;
  const loadError = open.phase === "failed";
  const cwd = useLaserState(s => {
    const target = visibleSessionPath(s);
    return target ? s.open[target]?.state.cwd ?? s.sessions.find((session) => session.path === target)?.cwd : undefined;
  });
  const worker = useLaserState(s => cwd ? s.workers[cwd] : undefined);
  const slots: ThreadSlots = statusSlot !== undefined ? { statusLine: statusSlot } : {};
  const aui = useAui();
  const wholeTranscript = useWholeTranscriptRefusal();
  const find = useConversationFind({ partial: partialHistory, loadAll: actions.loadAllEntries, refusal: wholeTranscript.explanation });
  return (
    <WholeTranscriptRefusalProvider value={wholeTranscript}>
    <SessionSeenBridge ready={connected && open.phase === "ready"} covered={page !== null} />
    <FindSelectionContext value={find.selectedMessage}>
    <FindQueryContext value={find.query}>
    <ThreadSlotsProvider slots={slots}>
      <TooltipProvider>
        <AuiProvider extends={aui} config={suggestions}>
          <FileOpenerProvider scope={path}>
          <ThreadPrimitive.Root ref={find.root} data-slot="thread" className="relative flex h-full min-h-0 flex-col bg-bg">
            {find.bar}
            <ThreadPrimitive.Viewport autoScroll={false} scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false} data-slot="thread-viewport" className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
              <TranscriptViewportBinding />
              {/* A long transcript gets a rail of ticks at the viewport's edge, on a wide screen only. */}
              <ConversationMapAui side="right" className="hidden lg:block" />
              <div className="mx-auto flex w-full max-w-(--measure-thread) flex-1 flex-col px-4 md:px-6">
                {cwd && (
                  <WorkerRecoveryNotice
                    className="mt-6"
                    worker={worker}
                    onRestart={(mode) => void actions.restartWorker(cwd, mode)}
                  />
                )}
                {loadError && (
                  <ErrorState className="mt-6"
                    title={open.provisional ? "Couldn’t reach the host. This is your last view of this conversation."
                      : open.hasTranscript ? "Couldn’t refresh this conversation." : open.path ? "This session didn’t load." : "Couldn’t open this view."}
                    detail={worker?.status === "crashed" ? undefined : open.reason}
                    onRetry={() => {
                      if (destination.phase === "unavailable") void actions.retryDestination();
                      else if (open.path) void actions.openSession(open.path).catch(() => {});
                    }} />
                )}
                <ConversationLoadingGate key={open.path} active={loading} hasContent={open.hasTranscript || loadError || !open.expectsTranscript}>
                  {/* The welcome is for a conversation that has nothing in it —
                      decided from the session (its view is hydrated and holds
                      no history, or no session is open at all), never from the
                      runtime's message list: for one frame after a switch the
                      new runtime has no messages yet while the store already
                      has the transcript, and that frame must not read as
                      "new session". */}
                  <AuiIf condition={(s) => s.thread.isEmpty}>
                    {(open.phase === "idle" || (open.phase === "ready" && !open.expectsTranscript)) && (emptyState ?? <EmptyState />)}
                  </AuiIf>
                  <HistoryControls key={path} />
                  <WindowedMessages />
                </ConversationLoadingGate>
                <ThreadPrimitive.ViewportFooter
                  data-slot="thread-footer"
                  className="sticky bottom-0 z-10 mt-auto flex flex-col gap-3 bg-bg pt-2 pb-[calc(var(--spacing)*4+max(env(safe-area-inset-bottom),var(--kb)))]"
                >
                  <ScrollAnchor />
                  {/* Above the composer, in the order the eye reads them:
                      what the app will not do here, the question that blocks
                      the turn, the follow-ups, then the composer itself. */}
                  <TrustGuardrail />
                  {/* A question inside a tool row can be scrolled away; the
                      one in the footer never is. */}
                  <WaitingNotice />
                  <ThreadDialogCards />
                  <ThreadFollowupSuggestions />
                  <Composer />
                </ThreadPrimitive.ViewportFooter>
              </div>
            </ThreadPrimitive.Viewport>
            {/* Select transcript text: quote it into the composer. */}
            <SelectionToolbar />
            <EntriesRefresh />
          </ThreadPrimitive.Root>
          </FileOpenerProvider>
        </AuiProvider>
      </TooltipProvider>
    </ThreadSlotsProvider>
    </FindQueryContext>
    </FindSelectionContext>
    </WholeTranscriptRefusalProvider>
  );
}

/**
 * The seen watermark follows the stream (`lastSeq` moves with every batch of
 * updates), so it subscribes here and draws nothing: the column above it does
 * not re-render for a token that only moved the watermark.
 */
function SessionSeenBridge({ ready, covered }: { ready: boolean; covered: boolean }) {
  const { actions } = useLaserStable();
  const path = useLaserState(s => (s.current ? s.open[s.current]?.path : undefined));
  const seq = useLaserState(s => (s.current ? s.open[s.current]?.lastSeq ?? 0 : 0));
  const running = useLaserState(s => (s.current ? s.open[s.current]?.running ?? false : false));
  const dialogs = useLaserState(s => (s.current ? s.open[s.current]?.dialogs.map(dialog => dialog.id).join("\0") ?? "" : ""));
  useSessionSeen({ path, seq, running, dialogs, ready, covered, markSeen: actions.markSeen });
  return null;
}

/**
 * A project whose trust was declined still opens, but Pi will not run its
 * extensions, skills or project settings. Say so once, above the composer,
 * rather than letting a missing tool look like a bug.
 */
function TrustGuardrail() {
  const { projectInfo } = useLaserStable();
  const cwd = useLaserState((s) => (s.current ? s.open[s.current]?.state.cwd : undefined));
  const trust = cwd ? projectInfo[cwd]?.trust : undefined;
  if (trust !== "declined") return null;
  return (
    <GuardrailNotice
      title="This project is not trusted"
      policy="trust"
      explanation="Its tools, instructions and project settings are not loaded, so project-specific capabilities are missing here. The built-in tools still work. To change that, remove and re-add the project and answer the trust question again."
    />
  );
}

/**
 * The message actions read Pi's persisted entries (versions, the leaf a
 * version ends at). The store reads new records when the session
 * settles; a prompt's own entry arrives on its `message_end` while the turn
 * runs, so the newest message never waits for this read.
 */
function EntriesRefresh() {
  const { actions } = useLaserStable();
  const path = useLaserState((s) => s.current);
  const running = useLaserState((s) => (s.current ? s.open[s.current]?.running ?? false : false));
  const previous = useRef({ path, running });
  useEffect(() => {
    const old = previous.current;
    previous.current = { path, running };
    if (path && old.path === path && old.running && !running) void actions.refreshEntries({ tail: true });
  }, [actions, path, running]);
  return null;
}

/** History is explicit, and upward reading fetches the next complete turn page. */
export function HistoryControls() {
  const { actions } = useLaserStable();
  const controller = useTranscriptViewport();
  // While this window is short of memory it will not start a whole-transcript
  // read (RP-8 step 7). The control says so in place rather than offering a
  // button that answers with a refusal; reading upwards is unaffected.
  const wholeTranscript = useThreadWholeTranscriptRefusal();
  const history = useLaserState(s => s.current ? s.open[s.current]?.history : undefined);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ focused?: Element | null } | undefined>(undefined);
  const busy = useRef(false);
  const requestedHistory = useRef(false);
  const interacted = useRef(false);
  const [loading, setLoading] = useState<"earlier" | "all" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const deferred = useLaserState(s => Boolean(s.current && s.open[s.current]?.trimmed));
  const load = useCallback(async (all = false) => {
    if (busy.current || (history?.complete && (!all || !history.branchesUnloaded))) return;
    busy.current = true;
    requestedHistory.current = true;
    setLoading(all ? "all" : "earlier");
    // The controller holds this surface's place across the page it is about to
    // commit; nothing else needs to remember where the person was reading.
    controller.capture();
    pending.current = { focused: root.current?.contains(document.activeElement) ? document.activeElement : null };
    try {
      const loaded = all ? await actions.loadAllEntries() : await actions.loadEarlierEntries();
      if (loaded) setAnnouncement(all ? "Other versions loaded." : "Earlier messages loaded.");
    } finally {
      busy.current = false;
      setLoading(null);
    }
  }, [actions, controller, history?.complete, history?.branchesUnloaded]);
  useLayoutEffect(() => {
    const anchor = pending.current;
    if (!anchor) return;
    pending.current = undefined;
    controller.committed();
    if (anchor.focused && !anchor.focused.isConnected && document.activeElement === document.body) root.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [controller, history?.anchor, history?.complete]);
  useEffect(() => {
    const viewport = root.current?.closest<HTMLElement>("[data-slot=thread-viewport]");
    if (!viewport || (!history?.before && !deferred)) return;
    let lastTop = viewport.scrollTop;
    const note = () => { interacted.current = true; };
    const scroll = () => {
      const top = viewport.scrollTop;
      const upwards = top < lastTop;
      lastTop = top;
      if (upwards && interacted.current && top < viewport.clientHeight / 2) void load();
    };
    // Already at the top, the viewport cannot scroll, so no scroll event
    // arrives: reading upwards there produces only the wheel (or a swipe, or
    // the keys). That is the person asking for what comes before.
    const wheel = (event: WheelEvent) => { note(); if (event.deltaY < 0 && viewport.scrollTop <= 0) void load(); };
    let touchY: number | undefined;
    const touchstart = (event: TouchEvent) => { touchY = event.touches?.[0]?.clientY; };
    const touchmove = (event: TouchEvent) => {
      note();
      const y = event.touches?.[0]?.clientY;
      if (y !== undefined && touchY !== undefined && y > touchY + 8 && viewport.scrollTop <= 0) void load();
      touchY = y;
    };
    const keydown = (event: KeyboardEvent) => {
      note();
      if ((event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") && viewport.scrollTop <= 0) void load();
    };
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("touchstart", touchstart, { passive: true });
    viewport.addEventListener("touchmove", touchmove, { passive: true });
    viewport.addEventListener("keydown", keydown);
    viewport.addEventListener("scroll", scroll, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", touchstart);
      viewport.removeEventListener("touchmove", touchmove);
      viewport.removeEventListener("keydown", keydown);
      viewport.removeEventListener("scroll", scroll);
    };
  }, [deferred, history?.before, load]);
  if (!history && !deferred) return null;
  if (!deferred && history?.complete && !requestedHistory.current) return null;
  return <div ref={root} className="flex flex-wrap items-center justify-center gap-2 py-2 text-sm text-ink-2" aria-busy={loading !== null}>
    {(deferred || history?.before) && <Button variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" aria-disabled={loading !== null} onClick={() => void load()}>
      {loading === "earlier" ? "Loading earlier messages…" : "Load earlier messages"}
    </Button>}
    {/* Earlier messages arrive by scrolling up (and through the button above,
        which is the same thing for a keyboard). Only other versions of a prompt
        need asking for: no amount of scrolling reaches a branch. */}
    {history?.branchesUnloaded && (wholeTranscript.paused
      ? <span data-slot="versions-paused">{wholeTranscript.explanation}</span>
      : <Button variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" aria-disabled={loading !== null} onClick={() => void load(true)}>
          {loading === "all" ? "Loading other versions…" : "Load other versions"}
        </Button>)}
    <span role="status" className="sr-only">{announcement}</span>
  </div>;
}
