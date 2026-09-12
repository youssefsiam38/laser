"use client";
/**
 * Message versions (`elements-message-branches`): "2 / 3" with a previous and
 * next control, shown under a prompt that exists in more than one version in
 * Pi's session tree (M1-T9). Editing a message in place and trying a reply
 * again both add one; this is how the person gets back to what was there
 * before, and the reason neither of those actions has to be a fork.
 *
 * Wired to the tree — switching moves the session onto that version's own
 * last entry — never to assistant-ui's own branching, which Pi does not have.
 *
 * Divergences from the registry copy: the variant text is not rendered here
 * (the transcript already shows the version in play); only the picker
 * survives, and it hides itself when there is nothing to pick.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";

import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useLogicalArrowKeys } from "@/hooks/use-direction";

import { mono } from "./surfaces.js";

export interface MessageBranchesProps extends Omit<ComponentProps<"div">, "children"> {
  /**
   * Zero-based position of the version on screen. Undefined when it cannot be
   * placed (an entry the session no longer holds); the picker then shows the
   * count and the controls step from either end.
   */
  index?: number | undefined;
  count: number;
  onIndexChange: (index: number) => void;
  busy?: boolean;
}

export function MessageBranches({ index, count, onIndexChange, busy = false, className, onKeyDown, ...props }: MessageBranchesProps) {
  const logicalKey = useLogicalArrowKeys();
  if (count < 2) return null;
  const goPrevious = () => onIndexChange(index === undefined || index === 0 ? count - 1 : index - 1);
  const goNext = () => onIndexChange(index === undefined || index === count - 1 ? 0 : index + 1);
  const label = index === undefined ? `${count} versions` : `Version ${index + 1} of ${count}`;
  return (
    <div data-slot="message-branches" className={cn("flex items-center gap-0.5", className)} {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || busy) return;
        const key = logicalKey(event.key);
        if (key !== "ArrowLeft" && key !== "ArrowRight") return;
        event.preventDefault();
        if (key === "ArrowLeft") goPrevious(); else goNext();
      }}
    >
      <TooltipIconButton tooltip="Previous version" size="icon-xs" className="text-ink-3" disabled={busy} onClick={goPrevious}>
        <ChevronLeft className="rtl:-scale-x-100" />
      </TooltipIconButton>
      <span className={cn(mono, "text-ink-3 tnum")} aria-label={label} title={label}>
        {index === undefined ? `${count} versions` : `${index + 1} / ${count}`}
      </span>
      <TooltipIconButton tooltip="Next version" size="icon-xs" className="text-ink-3" disabled={busy} onClick={goNext}>
        <ChevronRight className="rtl:-scale-x-100" />
      </TooltipIconButton>
    </div>
  );
}
