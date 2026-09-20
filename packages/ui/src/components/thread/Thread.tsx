import { AuiConfig, AuiIf, AuiProvider, Suggestions, ThreadPrimitive, useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ConversationMapAui } from "@/components/assistant-ui/elements/conversation-map.aui";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
import { ConversationLoadingGate } from "@/components/assistant-ui/elements/loading-state";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { TranscriptQuoteShortcut } from "@/components/assistant-ui/elements/quote.aui";
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
import {
  HISTORY_PREFETCH_BYTE_BUDGET,
  HISTORY_PREFETCH_PAGE_BUDGET,
  TranscriptViewportProvider,
  TranscriptViewportBinding,
  WindowedMessages,
  useTranscriptViewport,
} from "./transcript-viewport.js";
import type { EarlierPage } from "@/runtime/history-loader.js";

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

/**
 * The most turn pages one press of Find's "Load all messages" walks before
 * giving the branch back as it stands: at twenty turns a page this is eight
 * thousand turns, far past any conversation that has been seen, and a bound
 * rather than a loop that only the producer's root can end.
 */
const FIND_LOAD_ALL_PAGE_CAP = 400;

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
  const toolLabelParams = useLaserState(s => {
    const target = visibleSessionPath(s);
    return target ? s.open[target]?.state.toolLabelParams : undefined;
  });
  // Find searches the branch on screen, so "Load all messages" is that branch
  // paged back to its root with the ordinary turn pager. The whole-conversation
  // read (`{ all: true }`) is indivisible and the producer refuses it past
  // HISTORY_PAGE_ENTRY_LIMIT rows — which is every conversation partial enough
  // to offer the button — with a toast nobody is looking at while the control
  // stayed up. Paging cannot be refused for size, terminates at the root, and
  // the pressure policy that pauses whole reads explicitly allows it.
  const loadWholeBranch = useCallback(async () => {
    for (let pages = 0; pages < FIND_LOAD_ALL_PAGE_CAP; pages += 1) {
      if (!(await actions.loadEarlierEntries()).accepted) break;
    }
    return true;
  }, [actions]);
  const find = useConversationFind({
    partial: partialHistory,
    loadAll: loadWholeBranch,
    refusal: wholeTranscript.explanation,
    toolLabelParams,
  });
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
            {/* The transcript is the thread's viewport: the list owns the
                scroller, so there is no scrolling box around it to compete for
                the same pixels (D-306). This column only stacks the map, the
                list and the floating composer over each other. */}
            <div data-slot="thread-column" className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <TranscriptViewportBinding />
              {/* A long transcript gets a rail of ticks at the viewport's edge, on a wide screen only. */}
              <ConversationMapAui side="right" className="hidden lg:block" />
                {/* The list is full width so its scrollbar rides the window's
                    edge; the conversation column lives inside each row. The
                    loading skeleton that stands in for the list while it is
                    empty takes that column here instead. */}
                <div className="flex min-h-0 flex-1 flex-col [&>[data-slot=conversation-skeleton]]:mx-auto [&>[data-slot=conversation-skeleton]]:w-full [&>[data-slot=conversation-skeleton]]:max-w-(--measure-thread) [&>[data-slot=conversation-skeleton]]:px-4 md:[&>[data-slot=conversation-skeleton]]:px-6">
                {/* A crashed worker is content: it is the answer to “why is
                    nothing arriving”, and it now lives in the transcript's
                    header, so the loader must not stand in front of it. */}
                {/* Not keyed on the path. A landing starts with no path and
                    adopts the created session's when the host answers; a key
                    there unmounted and remounted the whole transcript subtree
                    on that answer, which is the "it reloads the page" flicker
                    (D-341). Identity changes underneath; the pixels do not. The
                    gate's own anti-flash timer follows `active`, not the path. */}
                <ConversationLoadingGate active={loading} hasContent={open.hasTranscript || loadError || !open.expectsTranscript || worker?.status === "crashed"}>
                  {/* Everything above the conversation is the list's header, so
                      a notice appearing or going is a size change the list
                      restores the reading position through, rather than a push
                      nobody accounted for (M16-T91, D-306). Nothing that can
                      change height renders above the list. */}
                  <WindowedMessages
                    /* The welcome is for a conversation that has nothing in it
                       — decided from the session (its view is hydrated and
                       holds no history, or no session is open at all), never
                       from the runtime's message list: for one frame after a
                       switch the new runtime has no messages yet while the
                       store already has the transcript, and that frame must
                       not read as "new session". */
                    empty={<AuiIf condition={(s) => s.thread.isEmpty}>
                      {(open.phase === "idle" || (open.phase !== "failed" && !open.expectsTranscript)) && (emptyState ?? <EmptyState />)}
                    </AuiIf>}
                    head={<>
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
                    <HistoryControls key={path} />
                  </>} />
                </ConversationLoadingGate>
                </div>
                <ThreadPrimitive.ViewportFooter
                  data-slot="thread-footer"
                  className="absolute inset-x-0 bottom-0 z-10 mx-auto flex w-full max-w-(--measure-thread) flex-col gap-3 bg-bg px-4 pt-2 pb-[calc(var(--spacing)*4+max(env(safe-area-inset-bottom),var(--kb)))] md:px-6"
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
            {/* Native selection stays untouched. Quoting is the deliberate
                Ctrl/Cmd+Shift+Q action scoped to this thread. */}
            <TranscriptQuoteShortcut thread={find.root} />
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
  // The conversation moved on past the page this window was holding (a
  // compaction, a branch): the producer will not serve earlier pages from that
  // base any more. The rows on screen stay, and the way forward is to read the
  // recent messages again — said in the producer's own sentence, with the one
  // action that answers it.
  const refusal = history?.refusal;
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ focused?: Element | null; page: boolean } | undefined>(undefined);
  const busy = useRef(false);
  const requestedHistory = useRef(false);
  /**
   * What automatic paging has spent since the person last moved. The budget
   * is cumulative per reading position, not per burst: an accepted page
   * re-runs the layout effect below, so a per-burst count would only be a
   * yield between bursts, and a chain of tiny split-turn pages could walk the
   * whole of an 8 MB conversation on landing. Exhausted, the transcript stops
   * and does not re-arm until the person actually moves — a scroll, a wheel, a
   * swipe, a key, a resize, or the explicit control — which is `rearm()`.
   */
  const budget = useRef({ pages: 0, bytes: 0, exhausted: false });
  const rearm = useCallback(() => { budget.current = { pages: 0, bytes: 0, exhausted: false }; }, []);
  const spend = useCallback((page: EarlierPage) => {
    const spent = budget.current;
    spent.pages += 1;
    spent.bytes += page.bytes;
    if (spent.pages >= HISTORY_PREFETCH_PAGE_BUDGET || spent.bytes >= HISTORY_PREFETCH_BYTE_BUDGET) spent.exhausted = true;
  }, []);
  // A scroll event is not the person: the list's own position keeping after a
  // prepend raises them too, and a page taking the place of a taller reserve
  // can even make one read as upward. The controller counts the movements that
  // are the person's, and the scroll handler re-arms on that count alone.
  const armedAt = useRef(controller.gestureCount);
  const rearmIfMoved = useCallback(() => {
    if (controller.gestureCount === armedAt.current) return false;
    armedAt.current = controller.gestureCount;
    rearm();
    return true;
  }, [controller, rearm]);
  const [loading, setLoading] = useState<"earlier" | "all" | null>(null);
  const [rereading, setRereading] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const deferred = useLaserState(s => Boolean(s.current && s.open[s.current]?.trimmed));
  const load = useCallback(async (all = false, continuous = false) => {
    // A refused base serves no page, upwards or in recovery: reading on would
    // ask the producer the same impossible question over and over. The one way
    // forward is the explicit re-read beside the sentence below.
    if (busy.current || (!all && refusal) || (!all && !deferred && !history?.before) || (all && !history?.branchesUnloaded)) return;
    busy.current = true;
    requestedHistory.current = true;
    setLoading(all ? "all" : "earlier");
    // One earlier-history request more in flight. The controller counts them
    // for one reason: a page that is late while the person is inside the
    // placeholder says so. The place they are reading is the engine's.
    if (!all) controller.beginEarlierPage();
    pending.current = { focused: root.current?.contains(document.activeElement) ? document.activeElement : null, page: !all };
    let loaded = false;
    try {
      if (all) loaded = await actions.loadAllEntries();
      else {
        const page = await actions.loadEarlierEntries();
        loaded = page.accepted;
        if (continuous) spend(page);
      }
      if (loaded) setAnnouncement(all ? "Other versions loaded." : "Earlier messages loaded.");
      // Fill the screen, then two screens above the reader. One page of a long
      // conversation rarely does that — and a page that returns two rows is a
      // normal split turn, not a reason to stop. The explicit control stays one
      // page. Continuous paging stops at two screens of real rows above the
      // reader, at the root, or when the budget for this reading position is
      // spent: HISTORY_PREFETCH_PAGE_BUDGET pages or HISTORY_PREFETCH_BYTE_BUDGET
      // bytes in total since the person last moved, across every burst the
      // layout effect chains. Awaited sequence, never parallel. D-302's
      // estimate ahead of a reader still holds: the reading position never
      // moves backwards, no row arrives under the eye.
      if (loaded && !all && continuous) {
        while (!budget.current.exhausted && controller.needsPrefetch()) {
          controller.finishEarlierPage();
          controller.beginEarlierPage();
          const page = await actions.loadEarlierEntries();
          spend(page);
          if (!page.accepted) break;
        }
      }
    } catch {
      // The action already owns the person-facing transport error. Locally this
      // request is a cancellation: stop counting it as in flight, stay retryable.
      loaded = false;
    } finally {
      busy.current = false;
      setLoading(null);
      if (!all) {
        if (loaded) controller.finishEarlierPage();
        else {
          pending.current = undefined;
          controller.cancelEarlierPage();
        }
      }
    }
  }, [actions, controller, deferred, history?.before, history?.branchesUnloaded, refusal, spend]);
  useLayoutEffect(() => {
    const anchor = pending.current;
    if (anchor) {
      pending.current = undefined;
      controller.committed();
      if (anchor.focused && !anchor.focused.isConnected && document.activeElement === document.body) root.current?.querySelector("button")?.focus({ preventScroll: true });
    }
    // On landing, and after every accepted page, keep paging while the reserve
    // is within two screens of the reader and this reading position's budget
    // is not spent: a person should not see estimated space they did not
    // scroll into. Each page is awaited. No gesture is required to start; only
    // one re-arms a spent budget.
    const frame = requestAnimationFrame(() => { if (!budget.current.exhausted && controller.needsPrefetch()) void load(false, true); });
    return () => cancelAnimationFrame(frame);
  }, [controller, history?.anchor, history?.before, history?.complete, history?.revision, history?.userOffset, load]);
  useEffect(() => {
    const viewport = root.current?.closest<HTMLElement>("[data-slot=thread-viewport]");
    if (!viewport || (!history?.before && !deferred)) return;
    let lastTop = viewport.scrollTop;
    // Everything below is the person moving, and each one re-arms the budget.
    const prefetch = () => { rearm(); if (controller.needsPrefetch()) void load(false, true); };
    const scroll = () => {
      const top = viewport.scrollTop;
      const upwards = top < lastTop;
      lastTop = top;
      rearmIfMoved();
      if (upwards && (controller.needsPrefetch() || (deferred && top < viewport.clientHeight / 2))) void load(false, true);
    };
    // Already at the top, the viewport cannot scroll, so no scroll event
    // arrives: reading upwards there produces only the wheel (or a swipe, or
    // the keys). That is the person asking for what comes before.
    const wheel = (event: WheelEvent) => { rearm(); if (event.deltaY < 0 && (controller.needsPrefetch() || viewport.scrollTop <= 0)) void load(false, true); };
    let touchY: number | undefined;
    const touchstart = (event: TouchEvent) => { touchY = event.touches?.[0]?.clientY; };
    const touchmove = (event: TouchEvent) => {
      const y = event.touches?.[0]?.clientY;
      rearm();
      if (y !== undefined && touchY !== undefined && y > touchY + 8 && (controller.needsPrefetch() || viewport.scrollTop <= 0)) void load(false, true);
      touchY = y;
    };
    const keydown = (event: KeyboardEvent) => {
      rearm();
      if ((event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") && (controller.needsPrefetch() || viewport.scrollTop <= 0)) void load(false, true);
    };
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("touchstart", touchstart, { passive: true });
    viewport.addEventListener("touchmove", touchmove, { passive: true });
    viewport.addEventListener("keydown", keydown);
    viewport.addEventListener("scroll", scroll, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(prefetch) : undefined;
    observer?.observe(viewport);
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", touchstart);
      viewport.removeEventListener("touchmove", touchmove);
      viewport.removeEventListener("keydown", keydown);
      viewport.removeEventListener("scroll", scroll);
    };
  }, [controller, deferred, history?.before, load, rearm, rearmIfMoved]);
  const reread = useCallback(async () => {
    if (rereading) return;
    setRereading(true);
    try {
      await actions.rereadHistory();
      setAnnouncement("Recent messages reloaded.");
    } catch {
      // The action already puts the transport failure in front of the person;
      // this control stays exactly as it was, and stays usable.
    } finally {
      setRereading(false);
    }
  }, [actions, rereading]);
  useEffect(() => () => controller.cancelEarlierPage(), [controller]);
  if (!history && !deferred) return null;
  if (!deferred && !history?.before && !history?.branchesUnloaded && !requestedHistory.current && !refusal) return null;
  return <div ref={root} className="flex flex-wrap items-center justify-center gap-2 py-2 text-sm text-ink-2" aria-busy={loading !== null || rereading}>
    {refusal
      ? <span data-slot="history-refusal" className="flex max-w-(--measure-prose) flex-wrap items-center justify-center gap-2 text-center">
          <span>{refusal.message}</span>
          <Button variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" aria-disabled={rereading} onClick={() => void reread()}>
            {rereading ? "Reloading recent messages…" : "Reload recent messages"}
          </Button>
        </span>
      : (deferred || history?.before) && <Button variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" aria-disabled={loading !== null} onClick={() => { rearm(); void load(); }}>
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
    {/* The one thing a screen reader hears about paging; sighted readers see
        the rows arrive where the placeholder was, and nothing else. */}
    <span role="status" className="sr-only">{loading === "earlier" ? "Loading earlier messages" : rereading ? "Reloading recent messages" : announcement}</span>
  </div>;
}
