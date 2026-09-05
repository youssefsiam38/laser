"use client";
/**
 * Edit a sent message (`elements-edit-message`). Pi cannot rewrite history,
 * so this is **fork-with-edit**, and it says so: sending starts a new session
 * forked before this prompt and sends the edited text there. The original
 * session, and everything after this prompt in it, is untouched.
 *
 * Divergences from the registry copy: only the editing card survives (the
 * at-rest bubble is `UserBubble` in `message-pair`), the copy is honest about
 * the fork, the field is our `Textarea`, and the buttons are `Button`.
 */
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

export interface EditMessageProps extends Omit<ComponentProps<"div">, "children" | "onSubmit"> {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  /** Messages after this one in the current session; they stay where they are. */
  laterMessages: number;
  busy?: boolean;
}

export function EditMessage({ value, onValueChange, onSend, onCancel, laterMessages, busy = false, className, ...props }: EditMessageProps) {
  const canSend = value.trim().length > 0 && !busy;
  return (
    <div data-slot="edit-message" className={cn(paper, "flex w-full flex-col gap-3 rounded-2xl p-3", className)} {...props}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">Edit and resend from a fork</span>
        <span className={cn(mono, "text-ink-3")}>the agent cannot rewrite history</span>
      </div>
      <Textarea
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        rows={2}
        autoFocus
        aria-label="Edited message"
        className="max-h-60 min-h-20"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-3">
          Sends in a new session forked here.{" "}
          {laterMessages > 0 ? (
            <>
              <span className="tnum">{laterMessages}</span> later {laterMessages === 1 ? "message stays" : "messages stay"} in this one.
            </>
          ) : (
            "This session is left as it is."
          )}
        </p>
        <span className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSend} onClick={onSend}>
            Fork and send
          </Button>
        </span>
      </div>
    </div>
  );
}
