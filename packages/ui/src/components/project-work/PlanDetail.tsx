"use client";
/**
 * The Plan detail (M21-T16; D-355 "Detail, by kind" → Plan).
 *
 * The contract is short and exact: a compact bar that says where the Plan came
 * from — `from SPEC-n`, or standalone, where *the prompt was the brief*
 * (D-352) — and two views of the same revision, **Document** and
 * **Dependencies**. No inspector: a Plan's context is its graph and its tasks,
 * both of which are in the middle column.
 *
 * What is deliberately absent: a percentage, a burndown, an ETA, a phase
 * "progress" ring. A Plan is a dependency graph, not a schedule (leap, "Plan
 * and Project Task contract"). The only count on screen is how many of its
 * real Tasks are done, which is a fact the board would say the same way.
 */
import { FileText, Network } from "lucide-react";
import { useMemo, useState } from "react";
import type { ClientRequests, PlanBody, ProjectTaskState, ProjectWorkListItem } from "@lasercode/protocol";

import { AgentPlan, type AgentPlanPhase } from "@/components/assistant-ui/elements/agent-plan";
import { type TodoItem } from "@/components/assistant-ui/elements/todo-list";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { selectWork } from "@/project-work";
import { stateLabel, taskMark } from "@/project-work/vocabulary";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { PlanGraph } from "./PlanGraph.js";
import { Document, EmptyBody, ListSection, Prose, Section } from "./bodies/fields.js";

type Detail = ClientRequests["project/work/get"]["result"];

const VIEWS = [
  { id: "document", label: "Document", icon: FileText },
  { id: "dependencies", label: "Dependencies", icon: Network },
] as const;

type PlanView = (typeof VIEWS)[number]["id"];

export function PlanDetail({ detail, body, items }: { detail: Detail; body: PlanBody; items: readonly ProjectWorkListItem[] }) {
  const [view, setView] = useState<PlanView>("document");

  // Where the Plan came from, if anywhere. A Plan is usable alone (D-352), so
  // "standalone" is a first-class answer and not a missing link.
  const from = useMemo(() => {
    const edge = detail.edges.find(
      (candidate) =>
        candidate.subject.entityId === detail.entity.entityId &&
        (candidate.relation === "implements" || candidate.relation === "derived_from"),
    );
    return edge?.object;
  }, [detail.edges, detail.entity.entityId]);

  const phases: AgentPlanPhase[] = useMemo(
    () =>
      body.phases.map((phase) => ({
        id: phase.id,
        name: phase.name,
        summary: phase.summary,
        items: planTasks(phase.taskKeys, items),
      })),
    [body.phases, items],
  );

  const unphased = useMemo(() => {
    const listed = new Set(body.phases.flatMap((phase) => phase.taskKeys));
    const keys = [...new Set(body.dependencies.flatMap((edge) => [edge.from, edge.to]))].filter((key) => !listed.has(key));
    return planTasks(keys, items);
  }, [body.dependencies, body.phases, items]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {from ? (
          <button
            type="button"
            onClick={() => selectWork({ entityId: from.entityId, kind: from.kind })}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none",
              "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
            )}
          >
            <span className="text-xs leading-xs text-ink-3">from</span>
            <TypeBadge kind={from.kind} />
            <KeyTag workKey={from.key} />
          </button>
        ) : (
          <span className="text-xs leading-xs text-ink-3">
            Standalone — the prompt was the brief.
          </span>
        )}
        <Badge variant="outline">
          {body.phases.length} phase{body.phases.length === 1 ? "" : "s"}
        </Badge>
        {detail.planGraph && !detail.planGraph.ok ? <Badge variant="danger">the graph has a problem</Badge> : null}
        {detail.planGraph && detail.planGraph.orphans.length > 0 ? (
          <Badge variant="attention">
            {detail.planGraph.orphans.length} task{detail.planGraph.orphans.length === 1 ? "" : "s"} no longer listed
          </Badge>
        ) : null}

        <div role="tablist" aria-label="How to read this plan" className="ms-auto flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
          {VIEWS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              id={`plan-view-${candidate.id}`}
              aria-selected={view === candidate.id}
              aria-controls={`plan-panel-${candidate.id}`}
              onClick={() => setView(candidate.id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded px-2 text-xs leading-xs outline-none",
                "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                view === candidate.id ? "bg-bg text-ink" : "text-ink-2 hover:text-ink",
              )}
            >
              <candidate.icon aria-hidden="true" className="size-3.5" />
              {candidate.label}
            </button>
          ))}
        </div>
      </div>

      {view === "document" ? (
        <div role="tabpanel" id="plan-panel-document" aria-labelledby="plan-view-document" className="flex flex-col gap-5">
          <Section title="Brief">
            <Prose text={body.brief} />
          </Section>

          <Section title="Phases">
            {/* The adopted `agent-plan`, over this Plan's real phases and the
                rows the board would show for each of their tasks. */}
            <AgentPlan
              phases={phases}
              empty="No phases yet. A plan names its tasks in phases, and a dependency joins two of them."
              footer={
                unphased.length > 0 ? (
                  <p className="text-xs leading-xs text-attention">
                    {unphased.length} task{unphased.length === 1 ? " is" : "s are"} named by a dependency but listed in no phase.
                  </p>
                ) : null
              }
            />
          </Section>

          {body.boundaries.length > 0 ? (
            <Section title="Boundaries">
              <ul role="list" className="flex flex-col gap-1">
                {body.boundaries.map((boundary) => (
                  <li key={boundary.scope} className="flex flex-col">
                    <span className="typed text-ink-2">{boundary.scope}</span>
                    <span className="text-sm leading-5 text-ink-2">{boundary.rule}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {body.migrations.length > 0 ? (
            <Section title="Migrations">
              <ul role="list" className="flex flex-col gap-1">
                {body.migrations.map((migration) => (
                  <li key={migration.summary} className="flex items-start gap-2">
                    <Badge variant={migration.reversible ? "outline" : "attention"}>{migration.reversible ? "reversible" : "one way"}</Badge>
                    <span className="min-w-0 text-sm leading-5 text-ink-2">
                      {migration.summary}
                      {migration.note ? <span className="block text-xs leading-xs text-ink-3">{migration.note}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {body.risks.length > 0 ? (
            <Section title="Risks">
              <ul role="list" className="flex flex-col gap-1.5">
                {body.risks.map((risk) => (
                  <li key={risk.summary} className="flex items-start gap-2">
                    <Badge variant={risk.severity === "high" ? "danger" : risk.severity === "medium" ? "attention" : "outline"}>{risk.severity}</Badge>
                    <span className="min-w-0 text-sm leading-5 text-ink-2">
                      {risk.summary}
                      <span className="block text-xs leading-xs text-ink-3">{risk.control}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <ListSection title="Verification" items={body.verification} mono />
          {body.rollback ? (
            <Section title="Rollback">
              <Prose text={body.rollback} />
            </Section>
          ) : null}

          {/* Markdown through the shared renderer; never raw HTML (invariant 9). */}
          {body.document ? (
            <Document text={body.document} />
          ) : (
            <EmptyBody
              what="This plan has no written document."
              next="The brief, the phases and the graph above are the plan; a document is added by revising it."
            />
          )}
        </div>
      ) : (
        <div role="tabpanel" id="plan-panel-dependencies" aria-labelledby="plan-view-dependencies">
          <PlanGraph body={body} items={items} report={detail.planGraph} />
        </div>
      )}
    </div>
  );
}

/**
 * A phase's task keys as the rows this window already holds.
 *
 * A key with no row is kept and says so: it exists — this window has simply not
 * read it — and dropping it would make a phase look shorter than it is.
 */
function planTasks(keys: readonly string[], items: readonly ProjectWorkListItem[]): TodoItem[] {
  return keys.map((key) => {
    const row = items.find((item) => item.key === key);
    if (!row) return { id: key, text: "Not in what this window has read", status: "unread", mark: "idle" as const, tag: key };
    const state = row.state as ProjectTaskState;
    return {
      id: key,
      text: row.title,
      status: stateLabel("task", row.state),
      mark: taskMark(state),
      done: state === "done",
      tag: key,
      ...(row.unmetDependencies && row.unmetDependencies.length > 0 ? { detail: `waiting on ${row.unmetDependencies.join(", ")}` } : {}),
      onOpen: () => selectWork({ entityId: row.ref.entityId, kind: row.kind }),
    };
  });
}
