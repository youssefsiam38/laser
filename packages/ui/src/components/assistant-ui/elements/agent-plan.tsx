"use client";
/**
 * Agent plan — reinstalled from `elements-agent-plan` for the project
 * lifecycle leap (D-355, M21-T16). Its producer is back: a **Plan** is a
 * project-owned artifact with phases, declared dependencies and Tasks
 * (`docs/ux-elements.md` "Reasoning" → Agent plan).
 *
 * Divergences from the registry copy, which is `steps: string[]` plus an
 * `activeIndex`, a percentage bar and a `max-w-sm`:
 *
 *   - **No percentage and no bar.** A Plan is a dependency graph, not a
 *     schedule, and it "contains no model-invented scheduling metadata or
 *     progress percentages" (leap, "Plan and Project Task contract"). The only
 *     count here is `done/total` over the Plan's *real* Tasks, which is a fact
 *     the board would say the same way.
 *   - **No cursor.** There is no "current step": several Tasks in several
 *     phases can be running at once, and which one is next is the graph's
 *     answer, not a list index.
 *   - **Phases are real.** Each phase is its own collapsible section over that
 *     phase's Tasks, drawn with the adopted `todo-list` so a row reads
 *     identically here and on the board.
 *   - Every size, colour and duration is a token; the demo width is gone.
 */
import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { MarkdownDocument } from "@/components/assistant-ui/elements/markdown-document";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";
import { TodoList, type TodoItem } from "./todo-list.js";

export interface AgentPlanPhase {
  id: string;
  name: string;
  summary?: string | undefined;
  items: readonly TodoItem[];
}

export interface AgentPlanProps extends Omit<ComponentProps<"div">, "children"> {
  phases: readonly AgentPlanPhase[];
  /** What to say when the plan declares no phase at all. */
  empty?: ReactNode;
  /** Rows the plan owns outside any phase — orphans, unread keys, a footnote. */
  footer?: ReactNode;
}

export function AgentPlan({ phases, empty, footer, className, ...props }: AgentPlanProps) {
  const items = phases.flatMap((phase) => phase.items);
  const done = items.filter((item) => item.done).length;

  return (
    <div data-slot="agent-plan" className={cn("flex w-full min-w-0 flex-col gap-2", className)} {...props}>
      {phases.length === 0 ? (
        <p className="text-sm leading-5 text-ink-3">{empty}</p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="eyebrow">
              {phases.length} phase{phases.length === 1 ? "" : "s"}
            </span>
            {items.length > 0 ? (
              <span className={cn(mono, "tnum text-ink-3")}>
                {done}/{items.length} done
              </span>
            ) : null}
          </div>
          <ol role="list" className="flex flex-col gap-1.5">
            {phases.map((phase) => (
              <li key={phase.id}>
                <Phase phase={phase} />
              </li>
            ))}
          </ol>
        </>
      )}
      {footer}
    </div>
  );
}

function Phase({ phase }: { phase: AgentPlanPhase }) {
  const done = phase.items.filter((item) => item.done).length;
  return (
    <Collapsible defaultOpen className="rounded-lg border border-line bg-surface">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-start outline-none",
          "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
          "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          "pointer-coarse:min-h-11",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-ink-3 rtl:-scale-x-100",
            "transition-transform duration-(--motion-instant) group-data-[state=open]:rotate-90 motion-reduce:transition-none",
            "rtl:group-data-[state=open]:-rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm leading-5 font-medium text-ink">{phase.name}</span>
        {phase.items.length > 0 ? (
          <span className={cn(mono, "shrink-0 tnum text-ink-3")}>
            {done}/{phase.items.length}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="flex flex-col gap-1.5 border-t border-line px-2 py-2">
          {phase.summary ? <MarkdownDocument text={phase.summary} measure="prose" className="px-1.5 text-sm leading-5 text-ink-2" /> : null}
          <TodoList
            items={phase.items}
            header={false}
            empty="This phase lists no tasks yet."
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
