"use client";
/**
 * Scroll anchor (`elements-scroll-anchor`): the floating "Jump to latest"
 * pill that appears when the transcript has scrolled away from its end.
 * Bound to `ThreadPrimitive.ScrollToBottom`, which knows when the viewport is
 * pinned and disables itself (and so hides) at the bottom.
 *
 * Divergences from the registry copy: the registry ships a demo viewport
 * with a fake message feed; only the pill survives, and it is a real
 * `ScrollToBottom`. No new-message count: the runtime does not expose one,
 * and a guessed number would violate R3.
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

import { cn } from "@/lib/utils";
import { useTranscriptViewport } from "@/components/thread/transcript-viewport";

import { floating } from "./surfaces.js";

export interface ScrollAnchorProps extends Omit<ComponentProps<"button">, "children"> {
  label?: string;
}

export function ScrollAnchor({ label = "Jump to latest", className, ...props }: ScrollAnchorProps) {
  const viewport = useTranscriptViewport();
  return (
    <ThreadPrimitive.ScrollToBottom asChild onClick={event => { event.preventDefault(); viewport.latest(); }}>
      <button
        type="button"
        data-slot="scroll-anchor"
        aria-label={label}
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
        <ArrowDown aria-hidden="true" className="size-3.5 text-ink-3" />
        {label}
      </button>
    </ThreadPrimitive.ScrollToBottom>
  );
}
