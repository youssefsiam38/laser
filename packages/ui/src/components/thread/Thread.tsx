import { AuiConfig, AuiIf, AuiProvider, Suggestions, ThreadPrimitive, useAui, unstable_useThreadMessageIds } from "@assistant-ui/react";
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
import { useLaserStable, useLaserState, useLaserView } from "@/runtime";
import { sessionOpenPhase, sameSessionOpenPhase } from "@/runtime/main-destination";
import { useWorkbench } from "@/components/workbench/workbench-context";
import { useSessionSeen } from "./use-session-seen.js";
import { FileOpenerProvider } from "./FileOpener.js";
import { Composer } from "./Composer.js";
import { EmptyState } from "./EmptyState.js";
import { ThreadMessage } from "./messages.js";
import { ThreadSlotsProvider, type ThreadSlots } from "./thread-slots.js";
import { useConversationFind } from "./use-conversation-find.js";
import { FindSelectionContext } from "./search-state.js";
import { captureReadingPosition, preserveReadingPosition, type ReadingPosition } from "./preserve-reading-position.js";

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

export function Thread({ statusSlot, emptyState, followUps }: ThreadProps = {}) {
  const view = useLaserView();
  const suggestions = useMemo(() => (followUps ? AuiConfig({ suggestions: Suggestions([...followUps]) }) : FOLLOW_UPS), [followUps]);
  const { actions, destination } = useLaserStable();
  const open = useLaserState(s => sessionOpenPhase(s, s.current), sameSessionOpenPhase);
  const connected = useLaserState(s => s.connection === "open");
  const { page } = useWorkbench();
  useSessionSeen({ path: view?.path, seq: view?.lastSeq ?? 0, running: view?.running ?? false,
    dialogs: view?.dialogs.map(dialog => dialog.id).join("\0") ?? "",
    ready: connected && open.phase === "ready", covered: page !== null, markSeen: actions.markSeen });
  const loading = open.phase === "opening" && !open.hasTranscript && open.expectsTranscript;
  const loadError = open.phase === "failed";
  const slots: ThreadSlots = statusSlot !== undefined ? { statusLine: statusSlot } : {};
  const aui = useAui();
  const find = useConversationFind({ partial: Boolean(view?.history && !view.history.complete), loadAll: actions.loadAllEntries });
  return (
    <FindSelectionContext value={find.selectedMessage}>
    <ThreadSlotsProvider slots={slots}>
      <TooltipProvider>
        <AuiProvider extends={aui} config={suggestions}>
          <FileOpenerProvider scope={view?.path}>
          <ThreadPrimitive.Root ref={find.root} data-slot="thread" className="relative flex h-full min-h-0 flex-col bg-bg">
            {find.bar}
            <ThreadPrimitive.Viewport autoScroll={!find.open} scrollToBottomOnRunStart={!find.open} data-slot="thread-viewport" className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
              {/* A long transcript gets a rail of ticks at the viewport's edge, on a wide screen only. */}
              <ConversationMapAui side="right" className="hidden lg:block" />
              <div className="mx-auto flex w-full max-w-(--measure-thread) flex-1 flex-col px-4 md:px-6">
                {loadError && (
                  <ErrorState className="mt-6"
                    title={open.hasTranscript ? "Couldn’t refresh this conversation." : open.path ? "This session didn’t load." : "Couldn’t open this view."}
                    detail={open.reason}
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
                  <HistoryControls key={view?.path} />
                  <div data-slot="thread-messages" className="flex flex-col gap-5 pt-5 pb-5 empty:hidden">
                    <HistoryMessages />
                  </div>
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
    </FindSelectionContext>
  );
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

const MESSAGE_COMPONENTS = { Message: ThreadMessage };

/** Index providers rebind existing rows on prepend; identity providers keep their state. */
export function HistoryMessages() {
  const ids = unstable_useThreadMessageIds();
  return ids.map(messageId => <ThreadPrimitive.Unstable_MessageById key={messageId} messageId={messageId} components={MESSAGE_COMPONENTS} />);
}

/** History is explicit, and upward reading fetches the next complete turn page. */
function HistoryControls() {
  const { actions } = useLaserStable();
  const history = useLaserState(s => s.current ? s.open[s.current]?.history : undefined);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ viewport: HTMLElement; position: ReadingPosition; focused?: Element | null } | undefined>(undefined);
  const stopAnchor = useRef<(() => void) | undefined>(undefined);
  const busy = useRef(false);
  const requestedHistory = useRef(false);
  const interacted = useRef(false);
  const [loading, setLoading] = useState<"earlier" | "all" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const load = useCallback(async (all = false) => {
    if (busy.current || (history?.complete && (!all || !history.branchesUnloaded))) return;
    busy.current = true;
    requestedHistory.current = true;
    setLoading(all ? "all" : "earlier");
    const viewport = root.current?.closest<HTMLElement>("[data-slot=thread-viewport]");
    if (viewport) pending.current = { viewport, position: captureReadingPosition(viewport), focused: root.current?.contains(document.activeElement) ? document.activeElement : null };
    try {
      const loaded = all ? await actions.loadAllEntries() : await actions.loadEarlierEntries();
      if (loaded) setAnnouncement(all ? "Complete history loaded." : "Earlier messages loaded.");
    } finally {
      busy.current = false;
      setLoading(null);
    }
  }, [actions, history?.complete, history?.branchesUnloaded]);
  useLayoutEffect(() => {
    const anchor = pending.current;
    if (!anchor) return;
    pending.current = undefined;
    stopAnchor.current?.();
    stopAnchor.current = preserveReadingPosition(anchor.viewport, anchor.position);
    if (anchor.focused && !anchor.focused.isConnected && document.activeElement === document.body) root.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [history?.anchor, history?.complete]);
  useEffect(() => () => { stopAnchor.current?.(); }, []);
  useEffect(() => {
    const viewport = root.current?.closest<HTMLElement>("[data-slot=thread-viewport]");
    if (!viewport || !history?.before) return;
    let lastTop = viewport.scrollTop;
    const note = () => { interacted.current = true; };
    const scroll = () => {
      const top = viewport.scrollTop;
      const upwards = top < lastTop;
      lastTop = top;
      if (upwards && interacted.current && top < viewport.clientHeight / 2) void load();
    };
    viewport.addEventListener("wheel", note, { passive: true });
    viewport.addEventListener("touchmove", note, { passive: true });
    viewport.addEventListener("keydown", note);
    viewport.addEventListener("scroll", scroll, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", note);
      viewport.removeEventListener("touchmove", note);
      viewport.removeEventListener("keydown", note);
      viewport.removeEventListener("scroll", scroll);
    };
  }, [history?.before, load]);
  if (!history || (history.complete && !requestedHistory.current)) return null;
  return <div ref={root} className="flex flex-wrap items-center justify-center gap-2 py-2 text-sm text-ink-2" aria-busy={loading !== null}>
    {history.before && <Button variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" aria-disabled={loading !== null} onClick={() => void load()}>
      {loading === "earlier" ? "Loading earlier messages…" : "Load earlier messages"}
    </Button>}
    <Button variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" aria-disabled={loading !== null || (history.complete && !history.branchesUnloaded)} onClick={() => void load(true)}>
      {history.complete && !history.branchesUnloaded ? "Complete history loaded" : loading === "all" ? "Loading history…" : history.complete ? "Load other versions" : "Load complete history"}
    </Button>
    <span role="status" className="sr-only">{announcement}</span>
  </div>;
}
