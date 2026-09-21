"use client";
/**
 * The one **Project work** control in the selected project's top bar
 * (D-355, "Opening and closing").
 *
 * It carries live counts — `18 items · 4 need you` — because the number of
 * things waiting on a person is the reason to look, and a control that says
 * only its own name makes you open it to find out. The warm mark appears only
 * when something is actually waiting.
 *
 * It exists for a project. A projectless Chat has no project work of its own,
 * and the slash commands there ask which project first rather than inventing
 * one (D-352).
 */
import { Layers } from "lucide-react";

import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import {
  closeWorkspace,
  openWorkspace,
  useProjectWork,
  useWorkspaceUi,
} from "@/project-work";

export function ProjectWorkControl({ cwd, className }: { cwd: string | undefined; className?: string }) {
  const { work } = useProjectWork(cwd);
  const ui = useWorkspaceUi();
  const open = ui.open && ui.projectId !== undefined && ui.projectId === work.projectId;
  const items = work.counts.total;
  const needsYou = work.attention.needsYou;

  if (!cwd) return null;

  return (
    <TooltipIconButton
      tooltip={open ? "Back to the conversation" : controlTooltip(items, needsYou)}
      aria-pressed={open}
      data-slot="project-work-toggle"
      className={cn("relative", className)}
      onClick={() => {
        if (open) closeWorkspace();
        else if (work.projectId) openWorkspace({ projectId: work.projectId });
      }}
      disabled={!work.projectId}
    >
      <Layers />
      {!open && needsYou > 0 ? (
        <span
          aria-hidden="true"
          className="absolute end-1 top-1 size-1.5 rounded-full border border-bg bg-attention motion-safe:animate-attention"
        />
      ) : null}
    </TooltipIconButton>
  );
}

/** `18 items · 4 need you`, and the honest thing to say before the first read. */
export function controlTooltip(items: number, needsYou: number): string {
  if (items === 0) return "Project work — nothing yet";
  const itemText = `${items} item${items === 1 ? "" : "s"}`;
  return needsYou > 0 ? `Project work — ${itemText} · ${needsYou} need${needsYou === 1 ? "s" : ""} you` : `Project work — ${itemText}`;
}
