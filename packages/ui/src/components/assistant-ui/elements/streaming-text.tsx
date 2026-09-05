"use client";
/**
 * Streaming text (`elements-streaming-text`): the assistant text part while
 * it streams, with the caret riding on the last block.
 *
 * The registry copy splits a string into words and lands each one in blue.
 * Our text part is markdown rendered by `MarkdownTextPrimitive`, which owns
 * its own DOM, so word-level landing is not available without re-parsing the
 * markdown. What survives, and what this file is: the caret element, and the
 * wrapper that puts it on the last block of a running part. The "fresh words
 * settle from live to ink" effect is deliberately not emulated (R3: nothing
 * fake). `StreamingCaret` on its own is what a turn shows before its first
 * token.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** The blinking caret: 2px of `--live`, one text line tall. Still under reduced motion. */
export function StreamingCaret({ className, ...props }: Omit<ComponentProps<"span">, "children">) {
  return (
    <span
      data-slot="streaming-caret"
      role="status"
      aria-label="Working"
      className={cn("inline-block h-[1.05em] w-0.5 shrink-0 rounded-[1px] bg-live align-[-0.15em] motion-safe:animate-caret", className)}
      {...props}
    />
  );
}

export interface StreamingTextProps extends ComponentProps<"div"> {
  /** While true the last block of a running part carries the caret. */
  streaming: boolean;
}

/**
 * Wraps a rendered text part. The caret is drawn by the `caret` utility on
 * the last child of the part's root once that root reports `data-status=running`,
 * so the caret is always at the end of the newest block and never in a
 * separate line of its own.
 */
export function StreamingText({ streaming, className, children, ...props }: StreamingTextProps) {
  return (
    <div
      data-slot="streaming-text"
      data-streaming={streaming || undefined}
      className={cn("min-w-0", streaming && "[&_[data-status=running]>*:last-child]:caret", className)}
      {...props}
    >
      {children}
    </div>
  );
}
