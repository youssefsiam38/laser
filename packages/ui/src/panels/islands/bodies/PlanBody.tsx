import type { PlanPanel, PlanStep, PlanStepState } from "@piorbit/protocol";
import { Check, ChevronRight, CircleAlert, Link2 } from "lucide-react";
import { useMemo, useState } from "react";

import { StatusDot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { duration, tokens } from "@/format";
import { cn } from "@/lib/utils";
import type { PanelEntry } from "../../store.js";
import { totalTokens } from "../../values.js";
import { ActionButtons } from "../ActionButtons.js";
import { UsageRow } from "./RunBody.js";

export interface PlanBodyProps {
  entry: PanelEntry;
  panel: PlanPanel;
  /** Maximized draws phases as columns; anything smaller stacks them (D-20). */
  maximized: boolean;
  /** Decision ids still open, so "awaiting approval" is honest. */
  openDecisions: ReadonlySet<string>;
  onAct(actionId: string): Promise<unknown>;
  /** Jump to the run panel a step links to. */
  onOpenRun(runId: string): void;
}

interface Phase {
  title: string;
  steps: PlanStep[];
}

/**
 * Intended structure over several steps (docs/ux-agent-work.md "Plans"):
 * vertical collapsible phases with done/total and a row of step squares in
 * the dock; columns only when maximized. Inferred structure is dashed and
 * says so (R3). Cost sits at the top (R8).
 */
export function PlanBody({ panel, maximized, openDecisions, onAct, onOpenRun }: PlanBodyProps) {
  const phases = useMemo(() => groupPhases(panel.steps), [panel.steps]);
  const done = panel.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const awaiting = panel.approval && openDecisions.has(panel.approval.decisionId);
  const ids = useMemo(() => new Map(panel.steps.map((s) => [s.id, s.label])), [panel.steps]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="min-w-0">
          {panel.objective && <p className="text-sm leading-5 text-ink">{panel.objective}</p>}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
            <span className="typed text-ink">
              {done}/{panel.steps.length}
            </span>
            <span>steps done</span>
            {panel.inferred && (
              <Badge variant="outline" className="border-dashed" title="Rebuilt from trace timestamps; the workflow persisted no structure.">
                inferred
              </Badge>
            )}
            {awaiting && <Badge variant="attention">awaiting your approval</Badge>}
          </p>
        </div>
        <UsageRow usage={panel.usage} compact />
      </div>

      <div data-island-scroll className="min-h-0 flex-1 overflow-auto">
        {phases.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-3">No steps declared yet.</p>
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
      <ActionButtons actions={panel.actions} onAct={onAct} />
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

const STEP_SQUARE: Record<PlanStepState, string> = {
  pending: "bg-line",
  running: "bg-live motion-safe:animate-attention",
  done: "bg-ok",
  failed: "bg-danger",
  skipped: "bg-transparent shadow-[inset_0_0_0_1px_var(--ink-3)]",
  blocked: "bg-attention",
};

const STEP_WORDS: Record<PlanStepState, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  blocked: "blocked",
};

function StepSquares({ steps }: { steps: readonly PlanStep[] }) {
  const shown = steps.slice(0, 32);
  return (
    <span className="flex items-center gap-[3px]" aria-hidden="true">
      {shown.map((s) => (
        <span key={s.id} className={cn("size-2 rounded-[2px]", STEP_SQUARE[s.state])} />
      ))}
      {steps.length > shown.length && <span className="typed text-ink-3">+{steps.length - shown.length}</span>}
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
  const done = phase.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
          >
            <ChevronRight className="size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) group-aria-expanded:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{phase.title}</span>
            <span className="typed shrink-0 text-ink-2">
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
  const done = phase.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-3" aria-label={phase.title}>
      <header className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{phase.title}</h4>
        <span className="typed text-ink-2">
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
              <td className="typed max-w-32 truncate pe-2 align-middle text-ink-2" title={step.model}>
                {step.model ?? ""}
              </td>
              <td className="typed pe-2 text-end align-middle text-ink-2">{step.usage ? stepTokens(step) : ""}</td>
              <td className="typed pe-2 text-end align-middle text-ink-2">{stepTime(step)}</td>
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
          <span className="flex size-2 shrink-0 items-center justify-center rounded-full bg-ok" aria-label="done" />
        ) : step.state === "skipped" ? (
          <span className="size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--ink-3)]" aria-label="skipped" />
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
          <span className={cn("min-w-0 truncate text-ink", rich && "text-sm font-medium", step.state === "skipped" && "text-ink-3 line-through")}>{step.label}</span>
        )}
        {step.runId && <Link2 className="size-3 shrink-0 text-ink-3" aria-hidden="true" />}
      </div>
      {step.dependsOn && step.dependsOn.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 ps-4 text-xs text-ink-3">
          <span className="eyebrow">after</span>
          {step.dependsOn.map((dep) => (
            <span key={dep} className={cn("rounded border px-1 leading-4", inferred ? "border-dashed border-ink-3" : "border-line")} title={inferred ? "inferred from trace timestamps" : "declared"}>
              {ids.get(dep) ?? dep}
            </span>
          ))}
          {inferred && <span className="italic">inferred</span>}
        </p>
      )}
      {rich && (
        <p className="typed flex flex-wrap gap-x-3 ps-4 text-ink-2">
          {step.model && <span className="truncate">{step.model}</span>}
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
