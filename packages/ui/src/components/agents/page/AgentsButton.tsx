"use client";
/**
 * The way into the Agents page from the rail and the phone's sessions
 * sheet: one icon button, with an attention mark when periodic validation
 * found something a person should look at.
 */
import { Bot } from "lucide-react";

import { useAgentWarnings } from "@/agents";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useWorkbench } from "@/components/workbench";
import { cn } from "@/lib/utils";

export function AgentsButton({ side, afterOpen, className }: { side: "right" | "top"; afterOpen?: (() => void) | undefined; className?: string | undefined }) {
  const workbench = useWorkbench();
  const warnings = useAgentWarnings();
  const active = workbench.page === "agents";
  const count = warnings.length;
  const tooltip = count === 0 ? "Agents" : `Agents · ${count} warning${count === 1 ? "" : "s"}`;
  return (
    <TooltipIconButton
      tooltip={tooltip}
      side={side}
      size="icon"
      aria-current={active ? "page" : undefined}
      data-slot="agents-button"
      data-warnings={count > 0 ? count : undefined}
      className={cn("relative text-ink-3 hover:text-ink", active && "bg-surface text-ink", className)}
      onClick={() => {
        workbench.open("agents");
        afterOpen?.();
      }}
    >
      <Bot />
      {count > 0 ? (
        <span
          aria-hidden="true"
          data-slot="agents-warning-mark"
          className="absolute end-1.5 top-1.5 size-2 rounded-full bg-attention shadow-[0_0_0_2px_var(--surface-2)]"
        />
      ) : null}
    </TooltipIconButton>
  );
}
