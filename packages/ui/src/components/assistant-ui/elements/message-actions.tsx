"use client";
/**
 * Message actions (`elements-message-actions`): copy, fork from here, jump
 * to this entry, copy the session path. Every action is present only when
 * it can work here (R2): a prompt that is not yet persisted has no entry to
 * fork at, so the menu simply does not offer it.
 *
 * Divergences from the registry copy: the thumbs are gone (Pi has no
 * feedback channel; a faked one would violate R3), "regenerate" is a slot so
 * the regenerate menu can sit in the same row, and "more" is a real menu with
 * the session-tree actions rather than a bare callback.
 */
import { Braces, Check, Copy, Ellipsis, GitFork, Link, Milestone, PencilLine } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import { iconSwap, iconSwapIn, iconSwapOut } from "./surfaces.js";

export interface MessageActionsProps extends Omit<ComponentProps<"div">, "children"> {
  copied: boolean;
  onCopy: () => void;
  /** Edit and resend from a fork. */
  onEdit?: (() => void) | undefined;
  /** Start a new session with everything up to (not including) this entry. */
  onFork?: (() => void) | undefined;
  /** Move the session's cursor to this entry. */
  onJump?: (() => void) | undefined;
  /** Copy the session file's path. */
  onCopyPath?: (() => void) | undefined;
  onViewRequest?: (() => void) | undefined;
  /** A `RegenerateMenu`, when the message can be re-run. */
  regenerate?: ReactNode;
  /** Disables the session-tree actions while a turn runs. */
  busy?: boolean;
}

export function MessageActions({ copied, onCopy, onEdit, onFork, onJump, onCopyPath, onViewRequest, regenerate, busy = false, className, ...props }: MessageActionsProps) {
  const hasMenu = onFork !== undefined || onJump !== undefined || onCopyPath !== undefined || onViewRequest !== undefined;
  return (
    <div data-slot="message-actions" className={cn("flex items-center", className)} {...props}>
      <TooltipIconButton tooltip={copied ? "Copied" : "Copy"} size="icon-xs" onClick={onCopy} className={cn("grid place-items-center text-ink-3", copied && "text-ok hover:text-ok")}>
        <Copy className={cn(iconSwap, "size-3.5", copied ? iconSwapOut : iconSwapIn)} />
        <Check className={cn(iconSwap, "size-3.5", copied ? iconSwapIn : iconSwapOut)} />
      </TooltipIconButton>
      {onEdit ? (
        <TooltipIconButton tooltip="Edit and resend from a fork" size="icon-xs" className="text-ink-3" disabled={busy} onClick={onEdit}>
          <PencilLine />
        </TooltipIconButton>
      ) : null}
      {regenerate}
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip="More" size="icon-xs" className="text-ink-3">
              <Ellipsis />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {onViewRequest && <DropdownMenuItem onSelect={onViewRequest}><Braces />View API request</DropdownMenuItem>}
            {onFork || onJump ? <DropdownMenuLabel>Session tree</DropdownMenuLabel> : null}
            {onFork ? (
              <DropdownMenuItem disabled={busy} onSelect={onFork}>
                <GitFork />
                Fork from here
              </DropdownMenuItem>
            ) : null}
            {onJump ? (
              <DropdownMenuItem disabled={busy} onSelect={onJump}>
                <Milestone />
                Jump to this entry
              </DropdownMenuItem>
            ) : null}
            {(onFork || onJump) && onCopyPath ? <DropdownMenuSeparator /> : null}
            {onCopyPath ? (
              <DropdownMenuItem onSelect={onCopyPath}>
                <Link />
                Copy session path
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
