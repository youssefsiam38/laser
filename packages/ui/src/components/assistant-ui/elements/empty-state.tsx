"use client";
/**
 * Empty state (`elements-empty-state`): the session's first-run moment —
 * the project in display type, one line of context, and suggested prompts
 * as hairline rows. `Thread/EmptyState.tsx` feeds it from the open session.
 *
 * Divergences from the registry copy: left-aligned (DESIGN.md: never centre
 * the transcript column), suggestions are `ThreadPrimitive.Suggestion` rows
 * rather than centred pills, `EmptyStateComposer` is gone (the real composer
 * is on screen), and arrivals use the motion tokens.
 */
import { ThreadPrimitive } from "@assistant-ui/react";
import { ChevronRight } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";

import { cn } from "@/lib/utils";

export function EmptyState({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-state" className={cn("my-auto flex w-full flex-col gap-8 py-12", className)} {...props} />;
}

export function EmptyStateEyebrow({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="empty-state-eyebrow" className={cn("typed truncate text-ink-3", className)} {...props} />;
}

export function EmptyStateGreeting({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      data-slot="empty-state-greeting"
      className={cn("text-xl font-semibold text-ink animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-(--motion-slow) motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export function EmptyStateDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="empty-state-description" className={cn("text-md text-ink-2", className)} {...props} />;
}

export function EmptyStateSuggestions({ className, ...props }: ComponentProps<"ul">) {
  return <ul data-slot="empty-state-suggestions" aria-label="Suggested prompts" className={cn("flex flex-col border-t border-line", className)} {...props} />;
}

export interface EmptyStateSuggestionProps extends Omit<ComponentProps<typeof ThreadPrimitive.Suggestion>, "children" | "prompt"> {
  title: string;
  prompt: string;
  index?: number;
}

export function EmptyStateSuggestion({ title, prompt, index = 0, className, style, disabled, ...props }: EmptyStateSuggestionProps) {
  return (
    <li className="border-b border-line">
      <ThreadPrimitive.Suggestion
        prompt={prompt}
        send
        disabled={disabled}
        style={{ animationDelay: `calc(var(--motion-fast) * ${index})`, ...style } as CSSProperties}
        className={cn(
          "group/suggestion -mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-md px-2 py-3 text-start outline-none",
          "transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-(--motion-slow) motion-reduce:animate-none",
          className,
        )}
        {...props}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-base font-medium text-ink">{title}</span>
          <span className="truncate text-sm text-ink-3" title={prompt}>
            {prompt}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="rtl:-scale-x-100 size-4 shrink-0 text-ink-3 group-hover/suggestion:text-ink" />
      </ThreadPrimitive.Suggestion>
    </li>
  );
}
