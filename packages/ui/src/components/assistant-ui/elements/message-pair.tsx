"use client";
/**
 * Message pair (`elements-message-pair`): the user bubble and the assistant
 * reply as one visual unit — the bubble right-aligned on `--surface-2`, the
 * reply as prose on the ground, actions that appear on hover.
 *
 * The registry copy is a demo that types a fixed reply word by word. Our
 * transcript renders one message at a time through `ThreadPrimitive.Messages`,
 * so the pair is composed from these pieces in `messages.tsx` rather than
 * rendered as one component: `UserBubble` for the prompt, `AssistantBody` for
 * the reply, `MessageFooter` for the row that holds actions and timing. The
 * `words` / `visibleWords` typewriter and `max-w-sm` are gone.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** The prompt: right-aligned, `--surface-2`, radius one step above the base. */
export function UserBubble({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="user-bubble"
      className={cn("flex min-w-0 flex-col gap-2 rounded-xl bg-surface-2 px-4 py-2.5 text-md text-ink", className)}
      {...props}
    />
  );
}

/** The reply: prose on the ground, with a `--live` hairline while it streams. */
export function AssistantBody({ streaming = false, className, ...props }: ComponentProps<"div"> & { streaming?: boolean }) {
  return (
    <div
      data-slot="assistant-body"
      data-streaming={streaming || undefined}
      className={cn(
        "relative flex min-w-0 flex-col",
        "before:absolute before:inset-y-0 before:-start-3 before:w-0.5 before:rounded-full before:bg-live before:opacity-0 md:before:-start-4",
        "before:transition-opacity before:duration-(--motion-fast) motion-reduce:before:transition-none",
        streaming && "before:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The row under a message: actions on the start, timing on the end. Actions
 * fade in on hover or focus and are always present on a coarse pointer.
 */
export function MessageFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn("-ms-1.5 mt-1 flex h-7 min-w-0 items-center justify-between gap-2", className)}
      {...props}
    />
  );
}

export const hoverReveal =
  "opacity-0 transition-opacity duration-(--motion-instant) group-hover/message:opacity-100 group-focus-within/message:opacity-100 focus-within:opacity-100 data-[floating]:opacity-100 [@media(pointer:coarse)]:opacity-100 motion-reduce:transition-none";
