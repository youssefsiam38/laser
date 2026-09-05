"use client";
/**
 * Follow-up suggestions (`follow-up-suggestions`): the row of prompts that
 * appears once a turn settles, read from `thread.suggestions`. The thread
 * supplies them through an `AuiConfig` `Suggestions(...)` scope
 * (`Thread.tsx`). This is the runtime-bound sibling of `elements-suggestions`,
 * which is therefore not installed (docs/ux-elements.md).
 *
 * Divergences from the registry copy: pills on `--surface` with a hairline,
 * the mask fades read `--bg`, and the row never scrolls the page sideways —
 * it scrolls within itself.
 */
import { AuiIf, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState, type FC } from "react";

import { cn } from "@/lib/utils";

import { paper } from "./surfaces.js";

const FollowupSuggestionsRow: FC<{ className?: string | undefined }> = ({ className }) => {
  const suggestions = useAuiState((s) => s.thread.suggestions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rtlRef = useRef<boolean | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const fromStart = Math.abs(el.scrollLeft);
    const rtl = (rtlRef.current ??= getComputedStyle(el).direction === "rtl");
    const [left, right] = rtl ? [maxScroll - fromStart, fromStart] : [fromStart, maxScroll - fromStart];
    setFades((prev) => {
      const next = { left: left > 1, right: right > 1 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  useEffect(() => {
    updateFades();
    const el = scrollRef.current;
    if (!el?.firstElementChild || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateFades);
    observer.observe(el);
    observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [updateFades]);

  const maskImage = `linear-gradient(to right, ${fades.left ? "transparent, black 2rem" : "black"}, ${fades.right ? "black calc(100% - 2rem), transparent" : "black"})`;

  return (
    <div
      ref={scrollRef}
      data-slot="follow-up-suggestions"
      onScroll={updateFades}
      className={cn("scrollbar-none -my-1 w-full overflow-x-auto py-1", className)}
      // A mask's colour is its alpha channel, not something a person sees.
      style={{ maskImage, WebkitMaskImage: maskImage }}
    >
      <div className="flex min-h-8 w-max items-center gap-2 px-0.5">
        {suggestions.map((suggestion, idx) => (
          <ThreadPrimitive.Suggestion
            key={idx}
            prompt={suggestion.prompt}
            send
            className={cn(
              paper,
              "h-7 rounded-full px-3 text-xs whitespace-nowrap text-ink-2 outline-none",
              "transition-colors duration-(--motion-instant) hover:border-ink-3 hover:text-ink active:translate-y-px",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {suggestion.title ?? suggestion.prompt}
            {suggestion.label ? <span className="ms-1 text-ink-3">{suggestion.label}</span> : null}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};

/** Renders only after a turn, while idle, when the thread has suggestions. */
export const ThreadFollowupSuggestions: FC<{ className?: string | undefined }> = ({ className }) => (
  <AuiIf condition={(s) => !s.thread.isEmpty && !s.thread.isRunning && !s.thread.isDisabled && s.thread.suggestions.length > 0}>
    <FollowupSuggestionsRow className={className} />
  </AuiIf>
);
