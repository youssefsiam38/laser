"use client";
/**
 * A selected node's details (docs/agents.md §5): title, the run's timeline
 * (Timeline element: started · what it is doing now · how it ended, with the
 * reason), the task, where the agent is working — its worktree's branch, or
 * the checkout it shares with its parent — and the two things a person can do
 * from here: open the chat, or end a running agent.
 *
 * One body, three hosts: a column beside the canvas when there is room, a
 * row under the canvas in the panel composition, a bottom sheet on a phone.
 * Every host draws {@link InspectorBody}; none of them invents a fourth.
 */
import { FolderOpen, GitBranch, OctagonX, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { AgentTreeNode } from "@/agents";
import { Timeline, type TimelineEvent } from "@/components/assistant-ui/elements/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import { useMapHost } from "./map-context.js";
import { AgentMarkBadge, ChatButton, Elapsed } from "./NodeParts.js";
import { clockTime, endedByLabel, nodeAction, nodeAgentLabel, nodeIsActive, nodeName, nodeStatusLabel, runModelLabel, treeSummary } from "./node-model.js";

const BADGE_VARIANT = { live: "live", attention: "attention", danger: "danger", ok: "ok", muted: "outline" } as const;

/** The run's moments on a time axis, in the order they happened or will. */
export function timelineOf(node: AgentTreeNode): TimelineEvent[] {
  const run = node.run;
  if (!run) return [];
  const events: TimelineEvent[] = [
    {
      id: "started",
      when: "past",
      time: clockTime(run.startedAt),
      title: run.status === "queued" ? "Queued" : "Started",
      detail: run.origin === "user" ? "Started by you" : node.parentPath ? "Started by its parent" : undefined,
    },
  ];
  if (nodeIsActive(node)) {
    const action = nodeAction(node);
    const activity = run.activity;
    const counts = activity ? [activity.turns > 0 ? `${activity.turns} turn${activity.turns === 1 ? "" : "s"}` : "", activity.tools > 0 ? `${activity.tools} tool call${activity.tools === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") : "";
    events.push({
      id: "now",
      when: "now",
      time: "",
      title: run.status === "queued" ? "Waiting to start" : action ? `Working · ${action}` : "Working",
      detail: counts || undefined,
    });
  } else {
    const failed = run.status === "failed";
    events.push({
      id: "ended",
      when: "past",
      time: clockTime(run.endedAt ?? run.updatedAt),
      title: nodeStatusLabel(run.status),
      detail: endedByLabel(run) ?? run.result?.message ?? run.error,
      tone: failed ? "danger" : run.status === "cancelled" ? "muted" : undefined,
    });
  }
  return events;
}

export function InspectorBody({ node, header = true, className }: { node: AgentTreeNode; /** The name row; off where the host already shows it. */ header?: boolean; className?: string | undefined }) {
  const host = useMapHost();
  const run = node.run;
  const root = node.depth === 0;
  const model = runModelLabel(run);
  const task = run?.task?.trim();
  const active = nodeIsActive(node) && run !== undefined;
  return (
    <div data-slot="agent-map-inspector" data-path={node.id} className={cn("flex min-w-0 flex-col gap-4", className)}>
      {header && (
      <div className="flex min-w-0 items-start gap-2.5">
        <AgentMarkBadge node={node} size="md" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base leading-5 font-semibold tracking-title text-ink" title={nodeName(node)}>
            {nodeName(node)}
          </span>
          <span className="truncate text-xs leading-xs text-ink-3">{root ? "The conversation this map belongs to" : nodeAgentLabel(node)}</span>
        </div>
      </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={BADGE_VARIANT[node.tone]} data-slot="agent-map-inspector-status">
          {nodeStatusLabel(node.status)}
        </Badge>
        <Elapsed node={node} />
        {model && (
          <Badge variant="mono" className="max-w-40 truncate" title={model}>
            {model}
          </Badge>
        )}
      </div>

      {run && <Timeline events={timelineOf(node)} data-slot="agent-map-inspector-timeline" />}

      {task && (
        <section className="flex min-w-0 flex-col gap-1.5">
          <h4 className="eyebrow">Task</h4>
          <p className="nowheel max-h-40 overflow-y-auto rounded-md bg-surface-2 px-2.5 py-2 text-sm leading-sm whitespace-pre-wrap text-ink-2">{task}</p>
        </section>
      )}

      {run?.result && !active && run.result.message.trim() && (
        <section className="flex min-w-0 flex-col gap-1.5">
          <h4 className="eyebrow">{run.result.status === "blocked" ? "Where it stopped" : "Result"}</h4>
          <p className="nowheel max-h-40 overflow-y-auto text-sm leading-sm whitespace-pre-wrap text-ink-2">{run.result.message}</p>
        </section>
      )}

      {run?.error && !active && (
        <section className="flex min-w-0 flex-col gap-1.5">
          <h4 className="eyebrow text-danger">What went wrong</h4>
          <p className="text-sm leading-sm whitespace-pre-wrap text-ink-2">{run.error}</p>
        </section>
      )}

      {run?.worktree ? (
        <section className="flex min-w-0 flex-col gap-1.5">
          <h4 className="eyebrow">Worktree</h4>
          <span className="flex min-w-0 items-center gap-1.5 text-ink-2" title={run.worktree.path}>
            <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
            <span className="typed truncate">{run.worktree.branch}</span>
          </span>
        </section>
      ) : run?.cwd ? (
        // No worktree: this agent was started to work in its parent's own
        // checkout, so the directory is the fact and there is no branch.
        <section className="flex min-w-0 flex-col gap-1.5">
          <h4 className="eyebrow">Working in</h4>
          <span className="flex min-w-0 items-center gap-1.5 text-ink-2" title={run.cwd}>
            <FolderOpen aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
            <span className="typed truncate">{run.cwd}</span>
          </span>
          <p className="text-sm leading-sm text-ink-3">Shares its parent’s checkout; it has no worktree of its own.</p>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <ChatButton path={node.id} variant="button" label={root ? "Back to chat" : "Open chat"} className="h-8 px-3 text-sm" />
        {active && host.requestEndAgent && (
          <Button variant="destructive-ghost" size="sm" data-slot="agent-map-end" onClick={() => host.requestEndAgent?.(run.runId)}>
            <OctagonX />
            End agent…
          </Button>
        )}
      </div>
    </div>
  );
}

/** The right column in the full composition. */
export function InspectorColumn({ node, nodes, className }: { node: AgentTreeNode | undefined; nodes: readonly AgentTreeNode[]; className?: string | undefined }) {
  return (
    <aside data-slot="agent-map-inspector-column" aria-label="Agent details" className={cn("flex w-80 shrink-0 flex-col overflow-y-auto bg-bg hairline-l", className)}>
      {node ? (
        <InspectorBody node={node} className="p-4" />
      ) : (
        <div className="flex flex-col gap-1.5 p-4">
          <p className="text-sm leading-sm font-medium text-ink">{treeSummary(nodes)}</p>
          <p className="text-sm leading-sm text-ink-3">Select an agent to see its task, timeline and worktree. Everything here is read-only; talk to an agent from its chat.</p>
        </div>
      )}
    </aside>
  );
}

/**
 * The details row under the canvas, for the panel composition. A row rather
 * than a card over the graph: the canvas above shrinks and re-fits, so the
 * tree and the details are both in view — a card wide enough to read hid the
 * very node it described.
 */
export function InspectorCard({ node, onClose, className }: { node: AgentTreeNode; onClose(): void; className?: string | undefined }) {
  return (
    <div
      data-slot="agent-map-inspector-card"
      role="region"
      aria-label="Agent details"
      className={cn(
        "nowheel relative max-h-[48%] shrink-0 overflow-y-auto bg-surface p-4 hairline-t",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-(--motion-slow) motion-reduce:animate-none",
        className,
      )}
    >
      <TooltipIconButton tooltip="Close details" size="icon-xs" onClick={onClose} className="absolute end-2 top-2 text-ink-3">
        <X />
      </TooltipIconButton>
      <InspectorBody node={node} className="pe-6" />
    </div>
  );
}

/** A bottom sheet, for the phone's fullscreen graph. */
export function InspectorSheet({ node, onClose }: { node: AgentTreeNode | undefined; onClose(): void }) {
  // Keep the last node while the sheet slides away, so it does not go blank mid-motion.
  const held = useRef<AgentTreeNode | undefined>(node);
  useEffect(() => {
    if (node) held.current = node;
  }, [node]);
  const shown = node ?? held.current;
  return (
    <Sheet open={node !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" data-slot="agent-map-inspector-sheet" className="max-h-[85dvh] overflow-y-auto px-4 pb-4">
        <SheetTitle className="sr-only">{shown ? nodeName(shown) : "Agent details"}</SheetTitle>
        <SheetDescription className="sr-only">Status, timeline, task and worktree of the selected agent.</SheetDescription>
        {shown && <InspectorBody node={shown} className="pt-2" />}
      </SheetContent>
    </Sheet>
  );
}
