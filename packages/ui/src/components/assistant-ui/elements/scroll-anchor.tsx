"use client";
/**
 * Scroll anchor (`elements-scroll-anchor`): the floating "Jump to latest"
 * pill that appears when the transcript has scrolled away from its end.
 * Bound to `ThreadPrimitive.ScrollToBottom`, which knows when the viewport is
 * pinned and disables itself (and so hides) at the bottom.
 *
 * Divergences from the registry copy: the registry ships a demo viewport
 * with a fake message feed; only the pill survives, and it is a real
 * `ScrollToBottom`. No new-message count — a guessed number would violate R3
 * — but a quiet mark when the conversation has grown since the person left
 * the live edge to read: a new row arrived below them (a command, a reasoning
 * block, a reply), and the transcript did not move them to it. The mark is
 * the whole of the notification. It is drawn in the pill's own muted ink,
 * never the accent, because it is information and not a request.
 *
 * The primitive decides whether this button exists — it knows when the
 * viewport is pinned to the end and hides itself there. It does not decide
 * where the transcript goes: `preventDefault` stops its own
 * `scrollToBottom`, which writes `scrollTop` directly on the scroller and
 * then keeps re-writing it on every content resize until the element reports
 * bottom. That is a second authority over the pixels the transcript's
 * virtualizer owns, during the measurement storm a jump sets off (D-303).
 * `composeEventHandlers` runs the primitive's callback after this one and
 * honours a default-prevented event, so the click reaches exactly one writer.
 */
import { ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import type { ComponentProps } from "react";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import { useTranscriptViewport } from "@/components/thread/transcript-viewport";
import { useLaserState } from "@/runtime";
import { visibleSessionPath } from "@/runtime/main-destination";

import { floating } from "./surfaces.js";

export interface ScrollAnchorProps extends Omit<ComponentProps<"button">, "children"> {
  label?: string;
}

/**
 * Whether the conversation has grown below a reader who left the live edge.
 * Counted in rows of the session's own view — a new tool call, a new reply,
 * a new reasoning block each add one — against the count at the moment the
 * person left, so a paragraph streaming into a row they can already see is
 * not "new" and the mark does not flicker with every token.
 */
function useGrownSinceLeaving(): boolean {
  const controller = useTranscriptViewport();
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const following = controller.atLiveEdge;
  const rows = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.blocks.length ?? 0 : 0; });
  const path = useLaserState(visibleSessionPath);
  const left = useRef<{ path: string | undefined; rows: number } | undefined>(undefined);
  useEffect(() => {
    if (following) { left.current = undefined; return; }
    if (!left.current || left.current.path !== path) left.current = { path, rows };
  }, [following, path, rows]);
  const departed = left.current;
  return !following && departed !== undefined && departed.path === path && rows > departed.rows;
}

export function ScrollAnchor({ label = "Jump to latest", className, ...props }: ScrollAnchorProps) {
  const viewport = useTranscriptViewport();
  const grown = useGrownSinceLeaving();
  return (
    <ThreadPrimitive.ScrollToBottom asChild onClick={event => { event.preventDefault(); viewport.latest(); }}>
      <button
        type="button"
        data-slot="scroll-anchor"
        data-grown={grown || undefined}
        aria-label={grown ? `${label} — new activity below` : label}
        className={cn(
          floating,
          "absolute -top-10 end-0 z-10 inline-flex h-8 items-center gap-1.5 rounded-full pe-3 ps-2.5 text-xs font-medium text-ink outline-none",
          "transition-[background-color,transform,opacity] duration-(--motion-fast) ease-morph hover:bg-surface-2 active:translate-y-px",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
          "disabled:pointer-events-none disabled:invisible motion-reduce:transition-none",
          "animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none",
          className,
        )}
        {...props}
      >
        {/* The mark: the pill's own tertiary ink, a dot the size of the type's
            x-height, in the arrow's place so the pill does not change width. */}
        {grown
          ? <span aria-hidden="true" data-slot="scroll-anchor-mark" className="inline-flex size-3.5 items-center justify-center"><span className="size-1.5 rounded-full bg-ink-3" /></span>
          : <ArrowDown aria-hidden="true" className="size-3.5 text-ink-3" />}
        {label}
      </button>
    </ThreadPrimitive.ScrollToBottom>
  );
}
