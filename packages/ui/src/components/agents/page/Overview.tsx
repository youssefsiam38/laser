"use client";
/**
 * What the editor column shows before anything is chosen: on a first run,
 * the card that explains what an agent is and offers to create one; after
 * that, a short account of the agents you have and anything that needs a
 * look, each line a way in.
 */
import type { AgentsSnapshot, AgentWarning } from "@lasercode/protocol";
import { Bot, ChevronRight, Plus, TriangleAlert } from "lucide-react";
import type { ComponentProps } from "react";

import { agentDisplayName } from "@/agents";
import { AgentCard } from "@/components/assistant-ui/elements/agent-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { isFirstRun, orderAgents, type AgentsSelection } from "./model.js";

export interface AgentsOverviewProps {
  snapshot: AgentsSnapshot;
  warnings: readonly AgentWarning[];
  onNew(): void;
  onOpen(selection: AgentsSelection, field?: string): void;
  /** Phone: drawn above the list, so it is compact. */
  compact?: boolean | undefined;
  className?: string | undefined;
}

export function AgentsOverview({ snapshot, warnings, onNew, onOpen, compact = false, className }: AgentsOverviewProps) {
  const firstRun = isFirstRun(snapshot);
  const { custom } = orderAgents(snapshot);
  const own = custom.filter((agent) => agent.name !== "default");
  return (
    <div data-slot="agents-overview" data-first-run={firstRun || undefined} className={cn("flex w-full flex-col gap-4", compact ? "" : "mx-auto max-w-180 px-4 py-5 md:px-6", className)}>
      <AgentCard
        name={firstRun ? "Make your first agent" : `${own.length} agent${own.length === 1 ? "" : "s"} of your own`}
        eyebrow="Agents"
        icon={<Bot />}
        description={
          firstRun
            ? "An agent is a reusable way of working: a name other agents start it by, instructions that shape how it works, and the model and skills it uses. Every agent has every tool. Agents that start others delegate work to them in the background, each in its own session and worktree."
            : "Every agent is a reusable way of working. Pick one on the left to change its instructions, model or skills, or make a new one."
        }
        actions={
          <Button type="button" onClick={onNew} data-slot="overview-new">
            <Plus />
            {firstRun ? "Create your first agent" : "New agent"}
          </Button>
        }
      >
        {firstRun ? (
          <ul className="flex flex-col gap-1.5 text-sm text-ink-2">
            <li className="flex gap-2">
              <span className="typed shrink-0 text-ink-3">1</span>
              Name it and say when another agent should start it.
            </li>
            <li className="flex gap-2">
              <span className="typed shrink-0 text-ink-3">2</span>
              Write its instructions, or start from the built-in ones.
            </li>
            <li className="flex gap-2">
              <span className="typed shrink-0 text-ink-3">3</span>
              Choose its model and skills, and whether it may start others.
            </li>
          </ul>
        ) : null}
      </AgentCard>

      {!compact ? (
        <div className="flex flex-col gap-1">
          <Line onClick={() => onOpen({ kind: "agent", name: snapshot.defaultAgent })}>
            <span className="flex-1 text-ink-2">
              New sessions start with <span className="font-medium text-ink">{agentDisplayName(snapshot.defaultAgent)}</span>
            </span>
          </Line>
          {warnings.map((warning) => (
            <Line
              key={`${warning.agentName}:${warning.field}:${warning.target ?? ""}`}
              tone="attention"
              onClick={() => onOpen({ kind: "agent", name: warning.agentName }, warning.field)}
              data-slot="overview-warning"
            >
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-attention" />
              <span className="min-w-0 flex-1 truncate text-ink-2">
                <span className="font-medium text-ink">{agentDisplayName(warning.agentName)}</span> · {warning.message}
              </span>
            </Line>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Line({ tone, className, children, ...props }: ComponentProps<"button"> & { tone?: "attention" | undefined }) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start text-sm outline-none pointer-coarse:min-h-11",
        "transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        tone === "attention" && "bg-[color-mix(in_oklab,var(--attention)_8%,transparent)]",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
    </button>
  );
}
