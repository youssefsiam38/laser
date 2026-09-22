"use client";
/**
 * The body of each kind, read-only and complete.
 *
 * Every field the closed schema carries is shown, in that kind's own
 * vocabulary; nothing is summarised into a shape the data does not have and
 * nothing is invented to fill a section. The editors that write these bodies
 * are M21-T7 (Spec, Research), M21-T13 (Design canvas and index) and M21-T16
 * (Plan document/graph, Task attempts and evidence) — each replaces or wraps
 * the component for its kind, and keeps this one as the reading form.
 *
 * M21-T7 has landed for two of them: a Spec is wrapped by `SpecDocument`,
 * which keeps `SpecBodyView` as its reading half and adds editing, the
 * revision flow and its conflict banner; a Research is replaced by
 * `ResearchDetail`, the tree ↔ findings pair. A body rendered without a
 * context (a preview, a test) still gets the reading form.
 */
import type {
  DesignBody,
  PlanBody,
  ProjectTaskBody,
  ProjectTaskState,
  ProjectWorkBody,
  ProjectWorkListItem,
  ResearchBody,
  SpecBody,
} from "@lasercode/protocol";

import { TodoList, type TodoItem } from "@/components/assistant-ui/elements/todo-list";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { selectWork } from "@/project-work";
import { fullSpecGaps } from "@/project-work/spec";
import { KIND_TEXT, stateLabel, taskMark } from "@/project-work/vocabulary";

import { KeyTag } from "../KindBadge.js";
import type { WorkBodyContext } from "./context.js";
import { Document, EmptyBody, Labelled, ListSection, Prose, Section, Tags } from "./fields.js";
import { ResearchDetail } from "./ResearchDetail.js";
import { SpecDocument } from "./SpecDocument.js";

export function WorkBody({
  body,
  items = [],
  context,
}: {
  body: ProjectWorkBody;
  items?: readonly ProjectWorkListItem[];
  context?: WorkBodyContext | undefined;
}) {
  switch (body.kind) {
    case "spec":
      return context ? <SpecDocument body={body.spec} context={context} /> : <SpecBodyView body={body.spec} />;
    case "research":
      return context ? <ResearchDetail body={body.research} context={context} /> : <ResearchBodyView body={body.research} />;
    case "design":
      return <DesignBodyView body={body.design} />;
    case "plan":
      return <PlanBodyView body={body.plan} items={items} />;
    case "task":
      return <TaskBodyView body={body.task} />;
  }
}

/**
 * The tasks a plan names, as the rows this window already holds.
 *
 * A key the backlog has no row for is still shown — it exists, this window
 * simply has not read it — and says so rather than being dropped.
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

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export function SpecBodyView({ body }: { body: SpecBody }) {
  const gaps = fullSpecGaps(body);
  const bare =
    body.outcomes.length === 0 &&
    body.nonGoals.length === 0 &&
    body.requirements.length === 0 &&
    body.acceptance.length === 0 &&
    body.constraints.length === 0 &&
    !body.problem &&
    !body.document;
  return (
    <div className="flex flex-col gap-5">
      <Section title={body.form === "brief" ? "Brief" : "Brief · full spec"}>
        <Prose text={body.brief} />
      </Section>
      {gaps.length > 0 ? (
        <p role="status" className="max-w-(--measure-prose) rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-xs text-ink-2">
          Still missing from this Full spec: {gaps.join(", ")}. Edit this revision to add them; the current revision remains readable as written.
        </p>
      ) : null}
      {body.problem ? (
        <Section title="Problem">
          <Prose text={body.problem} />
        </Section>
      ) : null}
      <ListSection title="Outcomes" items={body.outcomes} />
      <ListSection title="Non-goals" items={body.nonGoals} />
      {body.requirements.length > 0 ? (
        <Section title="Requirements">
          <ul role="list" className="flex flex-col gap-1.5">
            {body.requirements.map((requirement) => (
              <li key={requirement.id} className="flex min-w-0 items-start gap-2">
                <Badge variant={requirement.level === "must" ? "attention" : "outline"}>{requirement.level}</Badge>
                <span className="min-w-0 flex-1"><Prose text={requirement.text} /></span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {body.acceptance.length > 0 ? (
        <Section title="Acceptance">
          <ul role="list" className="flex flex-col gap-1.5">
            {body.acceptance.map((criterion) => (
              <li key={criterion.id} className="flex min-w-0 items-start gap-2">
                <Badge variant={criterion.machineVerifiable ? "live" : "outline"}>
                  {criterion.machineVerifiable ? "checkable" : "by a person"}
                </Badge>
                <span className="min-w-0 flex-1"><Prose text={criterion.text} /></span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <ListSection title="Constraints" items={body.constraints} />
      {body.document ? <Document text={body.document} /> : null}
      {bare ? (
        <EmptyBody
          what={body.form === "brief" ? "This spec is deliberately just its brief." : "This Full spec currently contains only its brief."}
          next={body.form === "brief" ? "Edit when the idea needs to become a Full spec." : "Edit to add the missing decision and acceptance detail named above."}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

const CONFIDENCE_TONE = { declared: "ok", observed: "live", inferred: "attention", proposed: "outline" } as const;

export function ResearchBodyView({ body }: { body: ResearchBody }) {
  const findingsById = new Map(body.findings.map((finding) => [finding.id, finding]));
  return (
    <div className="flex flex-col gap-5">
      <Section title="Question">
        <Prose text={body.question} className="text-ink" />
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={body.status === "answered" ? "ok" : body.status === "unanswerable" ? "danger" : "outline"}>{body.status}</Badge>
          <span className="text-xs leading-xs text-ink-3">
            {body.findings.length} finding{body.findings.length === 1 ? "" : "s"} · {body.sources.length} source
            {body.sources.length === 1 ? "" : "s"}
          </span>
        </span>
      </Section>
      <ListSection title="In scope" items={body.scope.in} />
      <ListSection title="Out of scope" items={body.scope.out} />
      <ListSection title="Constraints" items={body.scope.constraints} />

      {body.questions.length > 0 ? (
        <Section title="Questions">
          <ul role="list" className="flex flex-col gap-2">
            {body.questions.map((node) => (
              <li key={node.id} className={cn("flex flex-col gap-1", node.parent && "ms-4 border-s border-line ps-3")}>
                <span className="flex min-w-0 items-center gap-2">
                  <Badge variant={node.state === "answered" ? "ok" : node.state === "handed_to_person" ? "attention" : "outline"}>{node.state}</Badge>
                  <span className="min-w-0 text-sm leading-5 text-ink">{node.text}</span>
                </span>
                {node.answer ? <Prose text={node.answer} /> : null}
                {node.inferredOnly ? <span className="text-xs leading-xs text-attention">This answer rests only on inferred findings.</span> : null}
                {node.findings.length > 0 ? (
                  <ul role="list" className="flex flex-col gap-0.5">
                    {node.findings.map((id) => (
                      <li key={id} className="text-xs leading-xs text-ink-3">
                        {findingsById.get(id)?.claim ?? "A finding this revision no longer carries."}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {body.findings.length > 0 ? (
        <Section title="Findings">
          <ul role="list" className="flex flex-col gap-3">
            {body.findings.map((finding) => (
              <li key={finding.id} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-2.5">
                <p className="text-sm leading-5 text-ink">{finding.claim}</p>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={CONFIDENCE_TONE[finding.confidence]}>{finding.confidence}</Badge>
                  <Badge variant="outline">{finding.licence}</Badge>
                  <Badge variant="mono">{finding.source.kind}</Badge>
                  <span className="min-w-0 truncate text-xs leading-xs text-ink-3" title={finding.source.id}>
                    {finding.source.title || finding.source.id}
                  </span>
                </span>
                {finding.excerpt ? (
                  <blockquote className="border-s-2 border-line ps-2 text-sm leading-5 text-ink-2">{finding.excerpt}</blockquote>
                ) : null}
                {finding.location ? (
                  <span className="typed break-all text-ink-3">
                    {finding.location.path}
                    {finding.location.from !== undefined ? `:${finding.location.from}` : ""}
                    {finding.location.to !== undefined ? `-${finding.location.to}` : ""}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {body.options && body.options.length > 0 ? (
        <Section title="Options">
          <ul role="list" className="flex flex-col gap-2">
            {body.options.map((option) => (
              <li key={option.name} className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">{option.name}</span>
                  {option.recommended ? <Badge variant="ok">recommended</Badge> : null}
                </span>
                <Prose text={option.summary} />
                <Tags values={option.tradeoffs} />
                {option.reason ? <span className="text-xs leading-xs text-ink-3">{option.reason}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {body.unresolved.length > 0 ? (
        <Section title="Still unresolved">
          <ul role="list" className="flex flex-col gap-1.5">
            {body.unresolved.map((unresolved) => (
              <li key={unresolved.fact} className="flex flex-col">
                <span className="text-sm leading-5 text-ink-2">{unresolved.fact}</span>
                <span className="text-xs leading-xs text-ink-3">Would settle it: {unresolved.wouldSettleIt}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {body.findings.length === 0 ? (
        <EmptyBody what="Nothing has been found yet." next="Findings arrive as the research runs; each one keeps its source and its licence." />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

export function DesignBodyView({ body }: { body: DesignBody }) {
  return (
    <div className="flex flex-col gap-5">
      <Section title="Brief">
        <Prose text={body.brief} />
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{body.fidelity}</Badge>
          {body.strategy ? <Badge variant="outline">{body.strategy.kind}</Badge> : null}
          {body.hostPage ? <Badge variant="mono">{body.hostPage.routeOrPath}</Badge> : null}
        </span>
      </Section>
      {body.foundation ? (
        <>
          <ListSection title="Foundation principles" items={body.foundation.principles} />
          {body.foundation.notes ? <Prose text={body.foundation.notes} /> : null}
        </>
      ) : null}
      {body.screens.length > 0 ? (
        <Section title="Screens">
          <ul role="list" className="flex flex-col gap-2">
            {body.screens.map((screen) => (
              <li key={screen.id} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-2.5">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">{screen.name}</span>
                  <Badge variant="outline">{screen.fidelity}</Badge>
                  {"sketchId" in screen.content ? <Badge variant="attention">sketch</Badge> : null}
                  {screen.viewport ? <Badge variant="mono">{screen.viewport}</Badge> : null}
                </span>
                {screen.states.length > 0 ? (
                  <ul role="list" className="flex flex-wrap gap-1">
                    {screen.states.map((state) => (
                      <li key={state.name}>
                        <Badge variant={state.included ? "default" : "outline"} title={state.skipReason ?? undefined}>
                          {state.name}
                          {state.included ? "" : " · skipped"}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {body.flows.length > 0 ? (
        <Section title="Flows">
          <ul role="list" className="flex flex-col gap-1">
            {body.flows.map((flow) => (
              <li key={flow.id} className="typed text-ink-2">
                {flow.fromScreenId} · {flow.trigger} → {"screenId" in flow.action ? flow.action.screenId : flow.action.type}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {body.sketches.length > 0 ? (
        <Section title="Sketches">
          <ul role="list" className="flex flex-col gap-1">
            {body.sketches.map((sketch) => (
              <li key={sketch.id} className="flex items-center gap-2 text-sm leading-5 text-ink-2">
                <span className="min-w-0 truncate">{sketch.title}</span>
                <span className="typed text-ink-3">
                  {sketch.bounds.width}×{sketch.bounds.height}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-xs text-ink-3">
            A sketch renders only inside its sandboxed frame, and the design canvas that draws it lands with the design workspace.
          </p>
        </Section>
      ) : null}
      {body.screens.length === 0 && body.sketches.length === 0 ? (
        <EmptyBody what="This design has a brief and nothing drawn yet." next="Screens, flows and the canvas arrive with the design workspace." />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function PlanBodyView({ body, items = [] }: { body: PlanBody; items?: readonly ProjectWorkListItem[] }) {
  return (
    <div className="flex flex-col gap-5">
      <Section title="Brief">
        <Prose text={body.brief} />
      </Section>
      {body.phases.length > 0 ? (
        <Section title="Phases">
          <ol className="flex flex-col gap-4">
            {body.phases.map((phase) => (
              <li key={phase.id} className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-ink">{phase.name}</span>
                {phase.summary ? <Prose text={phase.summary} /> : null}
                {/* The adopted `todo-list`, on this phase's real tasks: each
                    row says the state the board says, and opens it. */}
                {phase.taskKeys.length > 0 ? <TodoList title="Tasks" items={planTasks(phase.taskKeys, items)} /> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      {body.dependencies.length > 0 ? (
        <Section title="Dependencies">
          <ul role="list" className="flex flex-col gap-1">
            {body.dependencies.map((edge) => (
              <li key={`${edge.from}-${edge.to}`} className="flex min-w-0 items-center gap-2 text-sm leading-5 text-ink-2">
                <KeyTag workKey={edge.from} />
                <span aria-label="depends on" className={cn("text-ink-3", KIND_TEXT.plan)}>
                  →
                </span>
                <KeyTag workKey={edge.to} />
                {edge.reason ? <span className="min-w-0 truncate text-xs leading-xs text-ink-3">{edge.reason}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
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
                <span className="min-w-0 text-sm leading-5 text-ink-2">{migration.summary}</span>
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
      {body.document ? <Document text={body.document} /> : null}
      {body.phases.length === 0 && body.dependencies.length === 0 ? (
        <EmptyBody what="This plan is its brief so far." next="Phases, the dependency graph and its tasks arrive with the plan workspace." />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export function TaskBodyView({ body }: { body: ProjectTaskBody }) {
  const scope = [
    ...body.scope.packages.map((value) => `package ${value}`),
    ...body.scope.repositories.map((value) => `repository ${value}`),
    ...body.scope.paths,
  ];
  return (
    <div className="flex flex-col gap-5">
      <Section title="Outcome">
        <Prose text={body.outcome} />
      </Section>
      <div className="flex flex-wrap gap-4">
        <Labelled label="Assignment">
          {body.assignment.policy === "agent" ? `agent · ${body.assignment.agentName}` : body.assignment.policy}
        </Labelled>
        {body.planKey ? (
          <Labelled label="Belongs to">
            <KeyTag workKey={body.planKey} />
          </Labelled>
        ) : null}
        <Labelled label="Visual evidence">{body.visualEvidenceRequired ? "required" : "not required"}</Labelled>
      </div>
      {body.dependencies.length > 0 ? (
        <Section title="Depends on">
          <span className="flex flex-wrap items-center gap-1.5">
            {body.dependencies.map((key) => (
              <KeyTag key={key} workKey={key} />
            ))}
          </span>
        </Section>
      ) : null}
      <ListSection title="Non-goals" items={body.nonGoals} />
      {scope.length > 0 ? <ListSection title="Scope" items={scope} mono /> : null}
      <Tags values={body.scope.capabilities} />
      {body.acceptance.length > 0 ? (
        <Section title="Acceptance">
          <ul role="list" className="flex flex-col gap-1.5">
            {body.acceptance.map((criterion) => (
              <li key={criterion.id} className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-start gap-2">
                  <Badge variant={criterion.machineVerifiable ? "live" : "outline"}>
                    {criterion.machineVerifiable ? "checkable" : "by a person"}
                  </Badge>
                  <span className="min-w-0 text-sm leading-5 text-ink-2">{criterion.text}</span>
                </span>
                {criterion.command ? <span className="typed break-all text-ink-3">{criterion.command}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <ListSection title="Verification" items={body.verificationCommands} mono />
      {body.notes ? (
        <Section title="Notes">
          <Prose text={body.notes} />
        </Section>
      ) : null}
    </div>
  );
}
