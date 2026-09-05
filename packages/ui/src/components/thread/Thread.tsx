import { AuiConfig, AuiIf, AuiProvider, Suggestions, ThreadPrimitive, useAui } from "@assistant-ui/react";
import { useEffect, type ReactNode } from "react";

import { ConversationMapAui } from "@/components/assistant-ui/elements/conversation-map.aui";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { SelectionToolbar } from "@/components/assistant-ui/elements/quote.aui";
import { ScrollAnchor } from "@/components/assistant-ui/elements/scroll-anchor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MobileIslands, PanelDecisionCards, PanelInlineCards, PanelInspectSheet } from "@/panels";
import { usePiorbitStable, usePiorbitState } from "@/runtime";
import { Composer } from "./Composer.js";
import { EmptyState } from "./EmptyState.js";
import { ThreadMessage } from "./messages.js";
import { ThreadSlotsProvider, type ThreadSlots } from "./thread-slots.js";

/**
 * The assistant-ui thread column (DESIGN.md "Layout" 3): transcript at max
 * 76ch, the viewport scrolls (never the body), and a sticky footer that holds
 * turn-blocking decisions, queue chips, and the floating composer.
 * The footer's bottom inset is `max(safe-area, --kb)` so the composer rides
 * above the on-screen keyboard.
 *
 * Renders inside `<PiorbitProvider>`; needs nothing else from the shell.
 * `statusSlot` is the trailing slot of the status line above the composer —
 * the shell mounts the fleet pill there (D-20 §5).
 */
export interface ThreadProps {
  statusSlot?: ReactNode;
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

export function Thread({ statusSlot }: ThreadProps = {}) {
  const slots: ThreadSlots = statusSlot !== undefined ? { statusLine: statusSlot } : {};
  const aui = useAui();
  return (
    <ThreadSlotsProvider slots={slots}>
      <TooltipProvider>
        <AuiProvider extends={aui} config={FOLLOW_UPS}>
          <ThreadPrimitive.Root data-slot="thread" className="relative flex h-full min-h-0 flex-col bg-bg">
            <ThreadPrimitive.Viewport data-slot="thread-viewport" className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
              {/* A long transcript gets a rail of ticks at the viewport's edge, on a wide screen only. */}
              <ConversationMapAui side="right" className="hidden lg:block" />
              <div className="mx-auto flex w-full max-w-[76ch] flex-1 flex-col px-4 md:px-6">
                <AuiIf condition={(s) => s.thread.isLoading}>
                  <ThreadLoading />
                </AuiIf>
                <AuiIf condition={(s) => s.thread.isEmpty && !s.thread.isLoading}>
                  <EmptyState />
                </AuiIf>
                <div data-slot="thread-messages" className="flex flex-col gap-7 pt-6 pb-6 empty:hidden">
                  <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
                </div>
                {/* The inline surface (docs/ux-panels.md): panels arrive during a
                    turn, so the tail of the transcript is the point they happened.
                    They scroll with it rather than sitting in the footer. */}
                <PanelInlineCards className="pb-6" />
                <ThreadPrimitive.ViewportFooter
                  data-slot="thread-footer"
                  className="sticky bottom-0 z-10 mt-auto flex flex-col gap-3 bg-bg pt-2 pb-[calc(var(--spacing)*4+max(env(safe-area-inset-bottom),var(--kb)))]"
                >
                  <ScrollAnchor />
                  {/* Above the composer, in the order the eye reads them
                      (docs/ux-panels.md): what the app will not do here, the
                      question that blocks the turn, then on a phone the island
                      pills, the follow-ups, then the composer itself. */}
                  <TrustGuardrail />
                  <PanelDecisionCards />
                  <MobileIslands />
                  <ThreadFollowupSuggestions />
                  <Composer />
                </ThreadPrimitive.ViewportFooter>
              </div>
            </ThreadPrimitive.Viewport>
            {/* Select transcript text: quote it into the composer. */}
            <SelectionToolbar />
            {/* `inspect` means "now": it opens over the thread on every width. */}
            <PanelInspectSheet />
            <EntriesRefresh />
          </ThreadPrimitive.Root>
        </AuiProvider>
      </TooltipProvider>
    </ThreadSlotsProvider>
  );
}

/** Thread switch in flight: the loader, left-aligned where the first message will land. */
function ThreadLoading() {
  return (
    <div className="flex flex-col pt-6">
      <GenerationLoader label="Loading session" />
    </div>
  );
}

/**
 * A project whose trust was declined still opens, but Pi will not run its
 * extensions, skills or project settings. Say so once, above the composer,
 * rather than letting a missing tool look like a bug.
 */
function TrustGuardrail() {
  const { projectInfo } = usePiorbitStable();
  const cwd = usePiorbitState((s) => (s.current ? s.open[s.current]?.state.cwd : undefined));
  const trust = cwd ? projectInfo[cwd]?.trust : undefined;
  if (trust !== "declined") return null;
  return (
    <GuardrailNotice
      title="This project is not trusted"
      policy="trust"
      explanation="Its extensions, skills and project settings are not loaded, so tools they would add are missing here. The built-in tools still work. To change that, remove and re-add the project and answer the trust question again."
    />
  );
}

/**
 * The message actions read Pi's persisted entries (fork here, branches). The
 * store refreshes them when the session settles, so a prompt that just
 * landed gets its entry id without a manual refresh.
 */
function EntriesRefresh() {
  const { actions } = usePiorbitStable();
  const path = usePiorbitState((s) => s.current);
  const running = usePiorbitState((s) => (s.current ? s.open[s.current]?.running ?? false : false));
  useEffect(() => {
    if (path && !running) void actions.refreshEntries();
  }, [actions, path, running]);
  return null;
}
