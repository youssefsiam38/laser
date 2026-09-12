"use client";
/**
 * A background task ended (docs/agents.md §6): the `lasercode/task-event`
 * custom message, projected as {@link TASK_EVENT_DATA_PART}. One quiet line —
 * what ran, how it ended, how long it took — and the way to its output, which
 * is the task's own row in the fleet: expanded in place in the column, or in
 * the sheet where there is no column. It shares the notice row's grammar, not
 * a card's: a task exiting is bookkeeping, not a reply.
 */
import { SquareTerminal } from "lucide-react";
import { useCallback } from "react";

import { useShellOptional } from "@/components/shell/shell-context";
import { Button } from "@/components/ui/button";
import { revealInFleet } from "@/fleet";
import { duration } from "@/format";
import { cn } from "@/lib/utils";
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
  // The task is only findable while the host still holds it; the register
  // prunes finished ones eventually, and the button goes with them rather
  // than leading to a row that is not there.
  const known = useLaserState((s) => (task ? s.tasks.tasks[task.taskId] !== undefined : false));
  const shell = useShellOptional();
  const reveal = useCallback(() => {
    if (!task) return;
    // The column is already on screen: expand the row in place rather than
    // covering the conversation you are reading. Anywhere else, open the sheet.
    const inColumn = shell?.layout === "desktop" && shell.fleetOpen;
    if (shell && !inColumn && shell.layout === "desktop") shell.setFleetOpen(true);
    revealInFleet(`task:${task.taskId}`, { sheet: shell?.layout !== "desktop" });
  }, [shell, task]);
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
        <code dir="ltr" data-search-content="command" className="typed text-ink" title={task.command}>
          {oneLine(task.command, 60)}
        </code>{" "}
        {outcome.text}
        {elapsed !== undefined ? <span className="typed text-ink-3 tnum"> · {duration(elapsed)}</span> : null}
      </span>
      {known ? (
        <Button size="xs" variant="ghost" onClick={reveal} data-slot="task-event-output" className="shrink-0 text-ink-2">
          Output
        </Button>
      ) : null}
    </div>
  );
}
