"use client";
/**
 * Edit a sent message (`elements-edit-message`). The session file is a tree,
 * so this is a real edit of the open session: sending moves the session back
 * to just before this prompt and the new text lands there as another version
 * of it. The old wording — and everything that followed it — stays in the
 * file, one click away in the version picker under the bubble.
 *
 * The second choice sends the edit into a **new session** and leaves this one
 * exactly as it is. It sits beside Cancel, not in the primary position: the
 * default is that the person's own history changes.
 *
 * Divergences from the registry copy: only the editing card survives (the
 * at-rest bubble is `UserBubble` in `message-pair`), the copy says which
 * session is about to change, the field is our `Textarea`, and the buttons
 * are `Button`.
 */
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

export interface EditMessageProps extends Omit<ComponentProps<"div">, "children" | "onSubmit"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Send the edit into this session, beside the version being replaced. */
  onSend: () => void;
  /** Send the edit into a new session, leaving this one untouched. */
  onSendInNewSession?: (() => void) | undefined;
  onCancel: () => void;
  /** Messages after this one; they stay on the version being replaced. */
  laterMessages: number;
  busy?: boolean;
}

export function EditMessage({ value, onValueChange, onSend, onSendInNewSession, onCancel, laterMessages, busy = false, className, ...props }: EditMessageProps) {
  const canSend = value.trim().length > 0 && !busy;
  return (
    <div data-slot="edit-message" className={cn(paper, "flex w-full flex-col gap-3 rounded-2xl p-3", className)} {...props}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">Edit message</span>
        <span className={cn(mono, "text-ink-3")}>{busy ? "waiting for the reply" : "the old version is kept"}</span>
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
          {busy ? (
            "Finish or stop the current reply first."
          ) : laterMessages > 0 ? (
            <>
              Replaces this message here.{" "}
              <span className="tnum">{laterMessages}</span> later {laterMessages === 1 ? "message stays" : "messages stay"} on the old version.
            </>
          ) : (
            "Replaces this message here. The old version is kept."
          )}
        </p>
        <span className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {onSendInNewSession ? (
            <Button variant="ghost" size="sm" disabled={!canSend} onClick={onSendInNewSession}>
              In a new session
            </Button>
          ) : null}
          <Button size="sm" disabled={!canSend} onClick={onSend}>
            Send
          </Button>
        </span>
      </div>
    </div>
  );
}
