"use client";
/**
 * Message actions (`elements-message-actions`): copy, edit, try again, and a
 * menu with the session-tree actions — fork from here, jump to this entry,
 * copy the session path. Every action is present only when it can work here
 * (R2): a prompt that is not yet persisted has no entry to edit at, so the
 * row simply does not offer it.
 *
 * Editing and trying again change the session that is open; each keeps the
 * same thing in a new session as a second, clearly named choice, one row down
 * in the menu. Nothing is lost either way: the previous version stays in the
 * file and the version picker under the prompt goes back to it.
 *
 * Divergences from the registry copy: the thumbs are gone (Pi has no
 * feedback channel; a faked one would violate R3), "regenerate" is a slot so
 * the model-and-thinking menu can sit in the same row, and "more" is a real
 * menu with the session-tree actions rather than a bare callback.
 */
import { Braces, Check, Copy, Ellipsis, GitFork, Link, Milestone, PencilLine, RefreshCw } from "lucide-react";
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
  /** Edit this message in this session. */
  onEdit?: (() => void) | undefined;
  /** Run the prompt behind this reply again, in this session. */
  onRegenerate?: (() => void) | undefined;
  /** The same re-run, into a new session. */
  onRegenerateFork?: (() => void) | undefined;
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

export function MessageActions({ copied, onCopy, onEdit, onRegenerate, onRegenerateFork, onFork, onJump, onCopyPath, onViewRequest, regenerate, busy = false, className, ...props }: MessageActionsProps) {
  const hasMenu =
    onFork !== undefined || onJump !== undefined || onCopyPath !== undefined || onViewRequest !== undefined || onRegenerateFork !== undefined;
  return (
    <div data-slot="message-actions" className={cn("flex items-center", className)} {...props}>
      <TooltipIconButton tooltip={copied ? "Copied" : "Copy"} size="icon-xs" onClick={onCopy} className={cn("grid place-items-center text-ink-3", copied && "text-ok hover:text-ok")}>
        <Copy className={cn(iconSwap, "size-3.5", copied ? iconSwapOut : iconSwapIn)} />
        <Check className={cn(iconSwap, "size-3.5", copied ? iconSwapIn : iconSwapOut)} />
      </TooltipIconButton>
      {onEdit ? (
        <TooltipIconButton tooltip="Edit" size="icon-xs" className="text-ink-3" disabled={busy} onClick={onEdit}>
          <PencilLine />
        </TooltipIconButton>
      ) : null}
      {onRegenerate ? (
        <TooltipIconButton tooltip="Try again" size="icon-xs" className="text-ink-3" disabled={busy} onClick={onRegenerate}>
          <RefreshCw />
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
            {onRegenerateFork ? (
              <DropdownMenuItem disabled={busy} onSelect={onRegenerateFork}>
                <RefreshCw />
                Try again in a new session
              </DropdownMenuItem>
            ) : null}
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
