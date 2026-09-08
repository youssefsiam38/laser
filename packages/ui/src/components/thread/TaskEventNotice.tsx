"use client";
/**
 * A background task ended (docs/agents.md §6): the `lasercode/task-event`
 * custom message, projected as {@link TASK_EVENT_DATA_PART}. One quiet line —
 * what ran, how it ended, how long it took — and the way to its output, which
 * is the task's own `run` island (`tasks:<taskId>`), expanded in the dock or
 * opened in the fleet sheet on a phone. It shares the notice row's grammar,
 * not a card's: a task exiting is bookkeeping, not a reply.
 */
import { TASK_PANEL_PREFIX } from "@lasercode/protocol";
import { SquareTerminal } from "lucide-react";
import { useCallback } from "react";

import { openFleet } from "@/components/subagents/fleet";
import { Button } from "@/components/ui/button";
import { duration } from "@/format";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { usePanelActions, usePanelEntries } from "@/panels";
import { useLaserState, type TaskEventData } from "@/runtime";
import { oneLine } from "./tool-summary.js";

const isTaskData = (value: unknown): value is TaskEventData =>
  typeof value === "object" && value !== null && typeof (value as TaskEventData).taskId === "string" && typeof (value as TaskEventData).command === "string";

/** "exited with code 0", "was stopped", "failed" — and whether that is bad news. */
export function taskOutcome(data: Pick<TaskEventData, "status" | "exitCode">): { text: string; failed: boolean } {
  if (data.status === "stopped") return { text: "was stopped", failed: false };
  if (data.status === "failed" && typeof data.exitCode !== "number") return { text: "failed", failed: true };
  const code = data.exitCode ?? 0;
  return { text: `exited with code ${code}`, failed: code !== 0 };
}

export function taskElapsed(data: Pick<TaskEventData, "startedAt" | "endedAt">): number | undefined {
  if (!data.startedAt || !data.endedAt) return undefined;
  const ms = Date.parse(data.endedAt) - Date.parse(data.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function TaskEventNotice({ data }: { data: unknown }) {
  const task = isTaskData(data) ? data : undefined;
  const path = useLaserState((s) => s.current);
  const entries = usePanelEntries(path);
  const actions = usePanelActions();
  const mobile = useIsMobile();
  const panelId = task ? `${TASK_PANEL_PREFIX}${task.taskId}` : undefined;
  const entry = panelId ? entries.find((candidate) => candidate.panel.id === panelId && !candidate.closed) : undefined;
  const reveal = useCallback(() => {
    if (!entry) return;
    actions.markSeen(entry.key);
    if (mobile) {
      openFleet(entry.panel.id);
      return;
    }
    actions.setSize(entry.path, entry.key, "expanded");
    actions.watched(entry.path, entry.key);
  }, [actions, entry, mobile]);
  if (!task) return null;
  const outcome = taskOutcome(task);
  const elapsed = taskElapsed(task);
  return (
    <div
      role="status"
      data-slot="task-event"
      data-task={task.taskId}
      data-failed={outcome.failed || undefined}
      data-search-tool
      className={cn("my-1 flex min-w-0 items-center gap-2 text-sm", outcome.failed ? "text-danger" : "text-ink-2")}
    >
      <SquareTerminal aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Background task{" "}
        <code data-search-content="command" className="typed text-ink" title={task.command}>
          {oneLine(task.command, 60)}
        </code>{" "}
        {outcome.text}
        {elapsed !== undefined ? <span className="typed text-ink-3 tnum"> · {duration(elapsed)}</span> : null}
      </span>
      {entry ? (
        <Button size="xs" variant="ghost" onClick={reveal} data-slot="task-event-output" className="shrink-0 text-ink-2">
          Output
        </Button>
      ) : null}
    </div>
  );
}
