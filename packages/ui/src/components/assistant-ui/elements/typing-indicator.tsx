"use client";
/**
 * Typing indicator (`elements-typing-indicator`): three dots that read as
 * presence. In piorbit this is the honest substitute for a typewriter on a
 * DETACHED run — one that is working but sends no text deltas (R4). It never
 * stands in for a live stream, which has a caret.
 *
 * Divergences from the registry copy: the dots step through the attention
 * pulse's opacity (the one pulse the app has) with a stagger derived from the
 * `--motion-slow` token, instead of Tailwind’s bounce with literal delays.
 *
 * The dots are `--ink-2` at 8px, not `--ink-3` at 6px: on `--surface` the
 * tertiary ink was a flicker nobody could see. And `showLabel` defaults to
 * *on*, so the state is always in words — under reduced motion the dots do
 * not move at all, and a state with no words is no state.
 */
import type { ComponentProps, CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { paper } from "./surfaces.js";

export interface TypingIndicatorProps extends Omit<ComponentProps<"div">, "children" | "role" | "aria-label"> {
  variant?: "bubble" | "bare";
  /** Read by assistive tech, and shown after the dots when `showLabel`. */
  label?: string;
  showLabel?: boolean;
}

export function TypingIndicator({ variant = "bare", label = "Working, no word yet", showLabel = true, className, ...props }: TypingIndicatorProps) {
  const dots = [0, 1, 2].map((i) => (
    <span
      key={i}
      aria-hidden="true"
      className="size-2 rounded-full bg-ink-2 motion-safe:animate-attention"
      style={{ animationDelay: `calc(var(--motion-slow) * ${i})` } as CSSProperties}
    />
  ));

  return (
    <div
      data-slot="typing-indicator"
      data-variant={variant}
      role="status"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-2",
        variant === "bubble" && cn(paper, "w-fit rounded-full px-3 py-2"),
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-1">{dots}</span>
      {showLabel ? <span className="text-xs text-ink-3">{label}</span> : null}
    </div>
  );
}
