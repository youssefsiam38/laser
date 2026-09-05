"use client";
/**
 * Message branches (`elements-message-branches`): "2 / 3" with a previous
 * and next control, shown under a prompt whose entry has siblings in Pi's
 * session tree (M1-T9). Wired to the tree — switching a branch moves the
 * session's cursor to the sibling's leaf — never to assistant-ui's own
 * branching, which Pi does not have.
 *
 * Divergences from the registry copy: the variant text is not rendered here
 * (the transcript already shows the current branch); only the picker
 * survives, and it hides itself when there is nothing to pick.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";

import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export interface MessageBranchesProps extends Omit<ComponentProps<"div">, "children"> {
  /**
   * Zero-based position of the branch on screen. Undefined when the current
   * branch is not known (Pi's session state does not expose its leaf); the
   * picker then shows the count and the controls step from either end.
   */
  index?: number | undefined;
  count: number;
  onIndexChange: (index: number) => void;
  busy?: boolean;
}

export function MessageBranches({ index, count, onIndexChange, busy = false, className, ...props }: MessageBranchesProps) {
  if (count < 2) return null;
  const goPrevious = () => onIndexChange(index === undefined || index === 0 ? count - 1 : index - 1);
  const goNext = () => onIndexChange(index === undefined || index === count - 1 ? 0 : index + 1);
  const label = index === undefined ? `${count} branches` : `Branch ${index + 1} of ${count}`;
  return (
    <div data-slot="message-branches" className={cn("flex items-center gap-0.5", className)} {...props}>
      <TooltipIconButton tooltip="Previous branch" size="icon-xs" className="text-ink-3" disabled={busy} onClick={goPrevious}>
        <ChevronLeft />
      </TooltipIconButton>
      <span className={cn(mono, "text-ink-3 tnum")} aria-label={label} title={label}>
        {index === undefined ? `${count} branches` : `${index + 1} / ${count}`}
      </span>
      <TooltipIconButton tooltip="Next branch" size="icon-xs" className="text-ink-3" disabled={busy} onClick={goNext}>
        <ChevronRight />
      </TooltipIconButton>
    </div>
  );
}
