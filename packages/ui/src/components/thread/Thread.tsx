import { AuiIf, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import type { ReactNode } from "react";

import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Composer } from "./Composer.js";
import { EmptyState } from "./EmptyState.js";
import { MobileIslands, PanelDecisionCards, PanelInlineCards, PanelInspectSheet } from "@/panels";
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

export function Thread({ statusSlot }: ThreadProps = {}) {
  const slots: ThreadSlots = statusSlot !== undefined ? { statusLine: statusSlot } : {};
  return (
    <ThreadSlotsProvider slots={slots}>
    <TooltipProvider>
      <ThreadPrimitive.Root data-slot="thread" className="relative flex h-full min-h-0 flex-col bg-bg">
        <ThreadPrimitive.Viewport
          data-slot="thread-viewport"
          className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain"
        >
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
              className="sticky bottom-0 z-10 mt-auto flex flex-col gap-3 bg-bg pt-2 pb-[calc(16px+max(env(safe-area-inset-bottom),var(--kb)))]"
            >
              <ScrollToBottom />
              {/* Above the composer, in the order the eye reads them
                  (docs/ux-panels.md): the question that blocks the turn, then
                  on a phone the island pills, then the composer itself. */}
              <PanelDecisionCards />
              <MobileIslands />
              <Composer />
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
        {/* `inspect` means "now": it opens over the thread on every width. */}
        <PanelInspectSheet />
      </ThreadPrimitive.Root>
    </TooltipProvider>
    </ThreadSlotsProvider>
  );
}

function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        side="left"
        className="absolute -top-10 end-0 rounded-full shadow-float-sm disabled:invisible"
      >
        <ArrowDown />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}

/** Thread switch in flight: the shape of a short exchange, nothing more. */
function ThreadLoading() {
  return (
    <div aria-busy="true" aria-label="Loading session" className="flex flex-col gap-7 pt-6">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-56 rounded-[10px]" />
      </div>
      <div className="flex flex-col gap-2">
        <SkeletonText width="92%" />
        <SkeletonText width="78%" />
        <SkeletonText width="60%" />
      </div>
      <div className="flex flex-col gap-1.5">
        <SkeletonText width="40%" />
        <SkeletonText width="36%" />
      </div>
    </div>
  );
}
