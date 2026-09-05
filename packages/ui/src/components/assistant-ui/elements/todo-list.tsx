"use client";
/**
 * Todo list — "the agent's own working list, rewritten mid-run"
 * (docs/ux-elements.md "Agents": a `plan` whose steps are a checklist rather
 * than phases). Installed from `elements-todo-list`; `AgentPlan` chooses it
 * when a plan has no phases, no linked runs and no declared edges.
 *
 * Divergences from the registry copy:
 *   - `status` is the plan step vocabulary (six states), not three: failed,
 *     blocked and skipped need to read as what they are (R1, R3).
 *   - The header (title, `done/total`, revision) is drawn by the plan around
 *     it, so this is the list alone and does not repeat the count.
 *   - A step linked to a run is a button that opens it.
 *   - The arrival animation is gone; steps are replaced by index (R10), so a
 *     slide-in on every re-emit would be motion without meaning.
 */
import type { PlanStepState } from "@lasercode/protocol";
import { Check, CircleAlert, Minus } from "lucide-react";
import type { ComponentProps } from "react";

import { StatusDot } from "@/components/status";
import { cn } from "@/lib/utils";

export interface TodoItem {
  id: string;
  text: string;
  status: PlanStepState;
  /** Set when the step is a real run: the row opens it. */
  onOpen?: (() => void) | undefined;
}

export const STEP_WORDS: Record<PlanStepState, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  blocked: "blocked",
};

function Mark({ status }: { status: PlanStepState }) {
  switch (status) {
    case "done":
      return (
        <span className="flex size-3.5 items-center justify-center rounded-xs border border-ok/40 bg-[color-mix(in_oklab,var(--ok)_12%,transparent)]" role="img" aria-label="done">
          <Check className="size-2.5 text-ok" aria-hidden="true" />
        </span>
      );
    case "failed":
      return <CircleAlert className="size-3.5 text-danger" role="img" aria-label="failed" />;
    case "skipped":
      return (
        <span className="flex size-3.5 items-center justify-center rounded-xs border border-line" role="img" aria-label="skipped">
          <Minus className="size-2.5 text-ink-3" aria-hidden="true" />
        </span>
      );
    case "running":
      return <StatusDot status="working" size="sm" label="running" />;
    case "blocked":
      return <StatusDot status="waiting_for_input" size="sm" label="blocked" />;
    case "pending":
      return <span aria-hidden="true" className="size-3.5 rounded-xs border border-line" />;
  }
}

export function TodoList({ items, className, ...props }: Omit<ComponentProps<"ul">, "children"> & { items: readonly TodoItem[] }) {
  return (
    <ul data-slot="todo-list" role="list" className={cn("flex flex-col gap-0.5", className)} {...props}>
      {items.map((item) => {
        const Text = item.onOpen ? "button" : "span";
        return (
          <li key={item.id} className="flex items-start gap-2.5 py-0.5 text-sm" data-status={item.status}>
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
              <Mark status={item.status} />
            </span>
            <Text
              {...(item.onOpen ? { type: "button" as const, onClick: item.onOpen, title: `Open run · ${item.text}` } : { title: `${STEP_WORDS[item.status]} · ${item.text}` })}
              className={cn(
                "min-w-0 flex-1 text-start leading-5 break-words",
                item.status === "done" && "text-ink-3 line-through decoration-ink-3",
                item.status === "skipped" && "text-ink-3",
                item.status === "running" && "font-medium text-ink",
                item.status === "failed" && "text-danger",
                item.status === "blocked" && "text-ink",
                item.status === "pending" && "text-ink-2",
                item.onOpen && "rounded-sm outline-none hover:text-live focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              )}
            >
              {item.text}
            </Text>
          </li>
        );
      })}
    </ul>
  );
}
