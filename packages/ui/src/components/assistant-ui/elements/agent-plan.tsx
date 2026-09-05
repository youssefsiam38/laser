"use client";
/**
 * Agent plan — THE `plan` panel (docs/ux-elements.md "Agents"; docs/ux-agent-work.md
 * "Plans"; D-20). Installed from `elements-agent-plan` and fed the `PlanPanel`
 * payload. It renders by island size:
 *
 *   - Expanded in the dock: vertical collapsible phases, each header with the
 *     phase title, `done/total`, and a row of step squares; a phase opens into
 *     a table — name, model, tokens, time, check.
 *   - Maximized: phases as columns. When the plan declares dependency edges
 *     (`dependsOn`, and the plan is not inferred) the declared graph is drawn
 *     with `FlowGraph` instead — a graph only where one exists (R3).
 *   - A plan with no phases, no linked runs and no edges is a checklist:
 *     `TodoList`.
 *
 * Cost and tokens for the whole plan sit at the top (R8). Inferred structure
 * is dashed and says so (R3); inferred edges are drawn as labelled chips,
 * never as a graph.
 *
 * Divergences from the registry copy, which was `steps: string[]` and an
 * `activeIndex`: everything above. Kept from it: the header with the count,
 * the thin real progress bar (done/total is the one honest progress a plan
 * has), and the `data-slot`.
 */
import type { PlanPanel, PlanStep } from "@piorbit/protocol";
import { Check, ChevronRight, CircleAlert, Link2 } from "lucide-react";
import { useMemo, useState, type ComponentProps, type ReactNode } from "react";

import { StatusDot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { duration, tokens } from "@/format";
import { cn } from "@/lib/utils";
import { totalTokens } from "@/panels/values";

import { FlowGraph, layoutFlow } from "./flow-graph.js";
import { mono } from "./surfaces.js";
import { STEP_WORDS, TodoList } from "./todo-list.js";
import { announced, pct } from "../utils/range.js";

export interface AgentPlanProps extends Omit<ComponentProps<"div">, "children"> {
  panel: PlanPanel;
  /** Maximized draws phases as columns, or the declared graph (D-20). */
  maximized: boolean;
  /** The plan's approval decision is still open, so "awaiting approval" is honest. */
  awaiting: boolean;
  /** Jump to the run panel a step links to. */
  onOpenRun(runId: string): void;
  /** Tokens and cost for the whole plan (R8); the caller draws it in its own words. */
  usage?: ReactNode;
  /** The plan's declared actions (R2). */
  footer?: ReactNode;
}

interface Phase {
  title: string;
  steps: PlanStep[];
}

const isDone = (s: PlanStep): boolean => s.state === "done" || s.state === "skipped";

export function AgentPlan({ panel, maximized, awaiting, onOpenRun, usage, footer, className, ...props }: AgentPlanProps) {
  const phases = useMemo(() => groupPhases(panel.steps), [panel.steps]);
  const ids = useMemo(() => new Map(panel.steps.map((s) => [s.id, s.label])), [panel.steps]);
  const done = panel.steps.filter(isDone).length;
  const total = panel.steps.length;
  const checklist = panel.steps.every((s) => !s.phase && !s.runId && !s.dependsOn?.length);
  const declaredGraph = panel.inferred !== true && panel.steps.some((s) => (s.dependsOn?.length ?? 0) > 0);
  const graph = useMemo(() => (maximized && declaredGraph ? layoutFlow(panel.steps, onOpenRun) : undefined), [maximized, declaredGraph, panel.steps, onOpenRun]);

  return (
    <div data-slot="agent-plan" className={cn("flex min-h-0 flex-1 flex-col gap-3", className)} {...props}>
      <div className="flex flex-col gap-1.5">
        {panel.objective && <p className="text-sm leading-sm text-ink">{panel.objective}</p>}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
          <span className={cn(mono, "text-ink")}>
            {done}/{total}
          </span>
          <span>steps done</span>
          {panel.inferred && (
            <Badge variant="outline" className="border-dashed" title="Rebuilt from trace timestamps; the workflow persisted no structure.">
              inferred
            </Badge>
          )}
          {awaiting && <Badge variant="attention">awaiting your approval</Badge>}
        </div>
        {total > 0 && (
          <span
            role="progressbar"
            aria-label="Steps done"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={`${done} of ${total}`}
            className="h-0.5 w-full overflow-hidden rounded-full bg-line"
          >
            <span
              className="block h-full rounded-full bg-live transition-[width] duration-(--motion-slow) ease-morph motion-reduce:transition-none"
              style={{ width: `${announced(pct(done, total))}%` }}
            />
          </span>
        )}
        {usage}
      </div>

      <div data-island-scroll className="min-h-0 flex-1 overflow-auto">
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-ink-3">No steps declared yet.</p>
        ) : checklist ? (
          <TodoList items={panel.steps.map((s) => ({ id: s.id, text: s.label, status: s.state }))} />
        ) : graph ? (
          <FlowGraph nodes={graph.nodes} edges={graph.edges} />
        ) : maximized ? (
          <div className="grid auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
            {phases.map((phase) => (
              <PhaseColumn key={phase.title} phase={phase} inferred={panel.inferred === true} ids={ids} onOpenRun={onOpenRun} />
            ))}
          </div>
        ) : (
          <ul role="list" className="flex flex-col gap-1">
            {phases.map((phase, i) => (
              <PhaseSection
                key={phase.title}
                phase={phase}
                defaultOpen={phases.length === 1 || phase.steps.some((s) => s.state === "running" || s.state === "failed" || s.state === "blocked") || i === 0}
                inferred={panel.inferred === true}
                ids={ids}
                onOpenRun={onOpenRun}
              />
            ))}
          </ul>
        )}
      </div>
      {footer}
    </div>
  );
}

function groupPhases(steps: readonly PlanStep[]): Phase[] {
  const phases: Phase[] = [];
  for (const step of steps) {
    const title = step.phase ?? "Steps";
    const last = phases.at(-1);
    if (last && last.title === title) last.steps.push(step);
    else phases.push({ title, steps: [step] });
  }
  return phases;
}

const STEP_SQUARE: Record<PlanStep["state"], string> = {
  pending: "bg-line",
  running: "bg-live motion-safe:animate-attention",
  done: "bg-ok",
  failed: "bg-danger",
  skipped: "bg-transparent shadow-[inset_0_0_0_1px_var(--ink-3)]",
  blocked: "bg-attention",
};

/** The most squares a phase header draws before the rest becomes a count (R13). */
const MAX_SQUARES = 32;

function StepSquares({ steps }: { steps: readonly PlanStep[] }) {
  const shown = steps.slice(0, MAX_SQUARES);
  return (
    <span className="flex items-center gap-0.5" aria-hidden="true">
      {shown.map((s) => (
        <span key={s.id} className={cn("size-2 rounded-xs", STEP_SQUARE[s.state])} />
      ))}
      {steps.length > shown.length && <span className={cn(mono, "text-ink-3")}>+{steps.length - shown.length}</span>}
    </span>
  );
}

interface PhaseProps {
  phase: Phase;
  inferred: boolean;
  ids: ReadonlyMap<string, string>;
  onOpenRun(runId: string): void;
}

function PhaseSection({ phase, defaultOpen, inferred, ids, onOpenRun }: PhaseProps & { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const done = phase.steps.filter(isDone).length;
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
          >
            <ChevronRight className="size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) group-aria-expanded:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={phase.title}>{phase.title}</span>
            <span className={cn(mono, "shrink-0 text-ink-2")}>
              {done}/{phase.steps.length}
            </span>
            <StepSquares steps={phase.steps} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <StepTable steps={phase.steps} inferred={inferred} ids={ids} onOpenRun={onOpenRun} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function PhaseColumn({ phase, inferred, ids, onOpenRun }: PhaseProps) {
  const done = phase.steps.filter(isDone).length;
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-3" aria-label={phase.title}>
      <header className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={phase.title}>{phase.title}</h4>
        <span className={cn(mono, "text-ink-2")}>
          {done}/{phase.steps.length}
        </span>
      </header>
      <ul role="list" className="flex flex-col gap-1.5">
        {phase.steps.map((step) => (
          <li key={step.id} className="rounded-lg border border-line bg-bg px-2.5 py-2">
            <StepLine step={step} inferred={inferred} ids={ids} onOpenRun={onOpenRun} rich />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** name · model · tokens · time · check */
function StepTable({ steps, inferred, ids, onOpenRun }: Omit<PhaseProps, "phase"> & { steps: readonly PlanStep[] }) {
  return (
    <div className="overflow-x-auto pb-1 ps-6">
      <table className="w-full border-collapse text-xs">
        <thead className="sr-only">
          <tr>
            <th>Step</th>
            <th>Model</th>
            <th>Tokens</th>
            <th>Time</th>
            <th>Done</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={step.id} className="h-7 border-b border-line last:border-b-0">
              <td className="min-w-0 pe-2 align-middle">
                <StepLine step={step} inferred={inferred} ids={ids} onOpenRun={onOpenRun} />
              </td>
              <td className={cn(mono, "max-w-32 truncate pe-2 align-middle text-ink-2")} title={step.model}>
                {step.model ?? ""}
              </td>
              <td className={cn(mono, "pe-2 text-end align-middle text-ink-2")}>{step.usage ? stepTokens(step) : ""}</td>
              <td className={cn(mono, "pe-2 text-end align-middle text-ink-2")}>{stepTime(step)}</td>
              <td className="w-5 align-middle">
                {step.state === "done" ? (
                  <Check className="size-3.5 text-ok" aria-label="done" />
                ) : step.state === "failed" ? (
                  <CircleAlert className="size-3.5 text-danger" aria-label="failed" />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StepLine({ step, inferred, ids, onOpenRun, rich = false }: Omit<PhaseProps, "phase"> & { step: PlanStep; rich?: boolean }) {
  const status = step.state === "running" ? "working" : step.state === "failed" ? "error" : step.state === "blocked" ? "waiting_for_input" : "idle";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        {step.state === "done" ? (
          <span className="flex size-2 shrink-0 items-center justify-center rounded-full bg-ok" role="img" aria-label="done" />
        ) : step.state === "skipped" ? (
          <span className="size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--ink-3)]" role="img" aria-label="skipped" />
        ) : (
          <StatusDot status={status} size="sm" label={STEP_WORDS[step.state]} />
        )}
        {step.runId ? (
          <button
            type="button"
            onClick={() => onOpenRun(step.runId!)}
            className={cn("min-w-0 truncate text-start text-ink outline-none hover:text-live focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live", rich && "text-sm font-medium")}
            title={`Open run ${step.runId}`}
          >
            {step.label}
          </button>
        ) : (
          <span className={cn("min-w-0 truncate text-ink", rich && "text-sm font-medium", step.state === "skipped" && "text-ink-3 line-through")} title={step.label}>
            {step.label}
          </span>
        )}
        {step.runId && <Link2 className="size-3 shrink-0 text-ink-3" aria-hidden="true" />}
      </div>
      {step.dependsOn && step.dependsOn.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 ps-4 text-xs text-ink-3">
          <span className="eyebrow">after</span>
          {step.dependsOn.map((dep) => (
            <span key={dep} className={cn("rounded-sm border px-1 leading-xs", inferred ? "border-dashed border-ink-3" : "border-line")} title={inferred ? "inferred from trace timestamps" : "declared"}>
              {ids.get(dep) ?? dep}
            </span>
          ))}
          {inferred && <span className="italic">inferred</span>}
        </p>
      )}
      {rich && (
        <p className={cn(mono, "flex flex-wrap gap-x-3 ps-4 text-ink-2")}>
          {step.model && (
            <span className="truncate" title={step.model}>
              {step.model}
            </span>
          )}
          {step.usage && <span>{stepTokens(step)}</span>}
          {stepTime(step) && <span>{stepTime(step)}</span>}
        </p>
      )}
    </div>
  );
}

function stepTokens(step: PlanStep): string {
  if (step.usage === null) return "not measured";
  if (!step.usage) return "";
  const total = totalTokens(step.usage);
  return total === undefined ? "" : tokens(total);
}

function stepTime(step: PlanStep): string {
  if (!step.startedAt) return "";
  const start = Date.parse(step.startedAt);
  const end = step.endedAt ? Date.parse(step.endedAt) : step.state === "running" ? Date.now() : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return duration(Math.max(0, end - start));
}
