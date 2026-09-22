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
import { Check, FileText, Network, Pencil, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  PROJECT_WORK_MARKDOWN_MAX,
  PROJECT_WORK_TEXT_MAX,
  PROJECT_WORK_TITLE_MAX,
  planBodySchema,
  validatePlanGraph,
  type ClientRequests,
  type PlanBody,
  type ProjectTaskState,
  type ProjectWorkListItem,
} from "@lasercode/protocol";

import { AgentPlan, type AgentPlanPhase } from "@/components/assistant-ui/elements/agent-plan";
import { type TodoItem } from "@/components/assistant-ui/elements/todo-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { selectWork } from "@/project-work";
import { stateLabel, taskMark } from "@/project-work/vocabulary";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { MarkdownAuthoringField } from "./MarkdownAuthoringField.js";
import { PlanGraph } from "./PlanGraph.js";
import { WorkEditFields, WorkEditFooter, WorkEditNewerNotice, useWorkEditSession } from "./edit-session.js";
import { errorAt, errorWithin, workFieldError, WORK_LINE_MAX, WORK_SHORT_NAME_MAX, type WorkFieldError } from "./opened-work-validation.js";
import type { WorkBodyContext } from "./bodies/context.js";
import { Field, LineListField } from "./bodies/editor-fields.js";
import { Document, EmptyBody, ListSection, Prose, Section } from "./bodies/fields.js";

type Detail = ClientRequests["project/work/get"]["result"];

const VIEWS = [
  { id: "document", label: "Document", icon: FileText },
  { id: "dependencies", label: "Dependencies", icon: Network },
] as const;

type PlanView = (typeof VIEWS)[number]["id"];

export function PlanDetail({ detail, body, items, context }: { detail: Detail; body: PlanBody; items: readonly ProjectWorkListItem[]; context?: WorkBodyContext }) {
  const [view, setView] = useState<PlanView>("document");
  const [draft, setDraft] = useState<PlanBody>();
  const bodyContext: WorkBodyContext = context ?? { store: undefined, detail, editable: false, onChanged: () => {}, items };
  const edit = useWorkEditSession<PlanBody>(bodyContext);

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

  if (draft && context && edit.matches && edit.owner) {
    return <PlanEditor body={draft} context={context} items={items} edit={edit} onChange={setDraft} onClose={() => { if (edit.cancel()) setDraft(undefined); }} />;
  }

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
          {body.phases.length} phase{body.phases.length === 1 ? "" : "s"} · {new Set(body.phases.flatMap((phase) => phase.taskKeys)).size} tasks
        </Badge>
        {detail.planGraph && !detail.planGraph.ok ? <Badge variant="danger">the graph has a problem</Badge> : null}
        {detail.planGraph && detail.planGraph.orphans.length > 0 ? (
          <Badge variant="attention">
            {detail.planGraph.orphans.length} task{detail.planGraph.orphans.length === 1 ? "" : "s"} no longer listed
          </Badge>
        ) : null}

        {detail.planGraph?.ok && detail.planGraph.order.length > 0 ? (
          <span className="text-xs leading-xs text-ink-3">Order: {detail.planGraph.order.join(" → ")}</span>
        ) : null}
        {context?.editable ? (
          <Button size="sm" variant="outline" className="ms-auto" onClick={() => { const owner = edit.begin(body); if (owner) setDraft(structuredClone(owner.baseBody)); }}>
            <Pencil />
            Edit plan
          </Button>
        ) : null}
        <div role="tablist" aria-label="How to read this plan" className={cn("flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5", !context?.editable && "ms-auto")}>
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
                    <Prose text={boundary.rule} />
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
                    <span className="min-w-0 flex-1">
                      <Prose text={migration.summary} />
                      {migration.note ? <Prose text={migration.note} className="text-xs leading-xs text-ink-3" /> : null}
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
                    <span className="min-w-0 flex-1">
                      <Prose text={risk.summary} />
                      <Prose text={risk.control} className="text-xs leading-xs text-ink-3" />
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

function PlanEditor({
  body,
  context,
  items,
  edit,
  onChange,
  onClose,
}: {
  body: PlanBody;
  context: WorkBodyContext;
  items: readonly ProjectWorkListItem[];
  edit: ReturnType<typeof useWorkEditSession<PlanBody>>;
  onChange: (body: PlanBody) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(edit.owner?.baseTitle ?? context.detail.revision.title);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<WorkFieldError>();
  const taskKeys = items.filter((item) => item.kind === "task").map((item) => item.key);
  const original = edit.owner?.baseBody ?? body;
  const changed = JSON.stringify(body) !== JSON.stringify(original) || title.trim() !== edit.owner?.baseTitle;

  const save = async (): Promise<void> => {
    const submitted = structuredClone(body);
    const submittedTitle = title.trim();
    const parsed = planBodySchema.safeParse(submitted);
    if (!parsed.success) {
      setError(undefined);
      setFieldError(workFieldError("plan", parsed.error.issues[0]));
      return;
    }
    setFieldError(undefined);
    const known = new Map(items.map((item) => [item.key, { kind: item.kind, state: item.state, entityId: item.ref.entityId, title: item.title }]));
    const report = validatePlanGraph({ phases: submitted.phases, dependencies: submitted.dependencies, known });
    if (!report.ok) {
      setError(report.problems[0]?.message ?? "The dependency graph has a problem that must be fixed before saving.");
      return;
    }
    setError(undefined);
    const settled = await edit.submit((base) => base.store.revise(
      { entityId: base.entityId, expectedRevisionId: base.baseRevisionId },
      { kind: "plan", plan: submitted },
      submittedTitle !== base.baseTitle ? { title: submittedTitle } : {},
    ));
    if (settled.kind === "blocked") {
      setError(`${settled.reason ?? context.readOnlyReason ?? "This draft can no longer be saved from here."} Your draft is still here.`);
      return;
    }
    if (settled.kind === "ignored") return;
    if (!settled.value.ok) {
      setError(`${settled.value.failure.message} Your draft is still here.`);
      return;
    }
    onClose();
    context.onChanged();
  };

  return (
    <div data-slot="plan-editor" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <Badge variant="outline">{body.phases.length} phases · {taskKeys.length} available tasks</Badge>
        <span className="text-xs leading-xs text-ink-3">Plan structure and prose become one fenced child revision.</span>
        {!context.compact ? (
          <span className="ms-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={edit.pending} onClick={onClose}><X />Cancel</Button>
            <Button size="sm" disabled={!edit.canSubmit || !changed || title.trim() === ""} onClick={() => void save()}><Check />{edit.pending ? "Saving…" : "Save as a new revision"}</Button>
          </span>
        ) : null}
      </div>
      <WorkEditNewerNotice show={edit.newerRevision} />
      {error ? <p role="alert" className="rounded-lg border border-danger/40 p-3 text-sm leading-5 text-danger">{error}</p> : null}
      <WorkEditFields locked={edit.locked}>
      <Field label="Title" htmlFor="plan-title">
        <Input id="plan-title" value={title} maxLength={PROJECT_WORK_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} />
      </Field>
        <MarkdownAuthoringField editorKey="plan-brief" label="Brief" value={body.brief} onChange={(brief) => onChange({ ...body, brief })} placeholder="What does this plan deliver?" maxLength={PROJECT_WORK_TEXT_MAX} error={errorAt(fieldError, "brief")} />

        <Field label="Phases" hint="A task can appear in one phase. Dependency order remains a separate fact." error={errorWithin(fieldError, "phases")}>
          <ul role="list" className="flex flex-col gap-3">
            {body.phases.map((phase, index) => (
              <li key={phase.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <Input aria-label={`Phase ${index + 1} name`} value={phase.name} maxLength={WORK_SHORT_NAME_MAX} onChange={(event) => onChange({ ...body, phases: replaceAt(body.phases, index, { ...phase, name: event.target.value }) })} placeholder="Phase name" />
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove phase ${index + 1}`} onClick={() => onChange({ ...body, phases: body.phases.filter((_, at) => at !== index) })}><X /></Button>
                </div>
                <MarkdownAuthoringField editorKey={`plan-phase-${phase.id}`} label={`Phase ${index + 1} summary`} value={phase.summary ?? ""} onChange={(summary) => onChange({ ...body, phases: replaceAt(body.phases, index, { ...phase, summary }) })} placeholder="What changes in this phase?" maxLength={PROJECT_WORK_TEXT_MAX} />
                <div className="flex flex-wrap gap-2">
                  {taskKeys.map((key) => (
                    <label key={key} className="flex min-h-8 items-center gap-1.5 text-xs text-ink-2">
                      <input type="checkbox" checked={phase.taskKeys.includes(key)} onChange={(event) => onChange({ ...body, phases: replaceAt(body.phases, index, { ...phase, taskKeys: event.target.checked ? [...phase.taskKeys, key] : phase.taskKeys.filter((existing) => existing !== key) }) })} />
                      {key}
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div><Button size="xs" variant="outline" onClick={() => onChange({ ...body, phases: [...body.phases, { id: crypto.randomUUID(), name: "", taskKeys: [] }] })}><Plus />Add a phase</Button></div>
        </Field>

        <Field label="Dependencies" hint="Each arrow reads: from waits on to." error={errorWithin(fieldError, "dependencies")}>
          <ul role="list" className="flex flex-col gap-2">
            {body.dependencies.map((dependency, index) => (
              <li key={`${dependency.from}-${dependency.to}-${index}`} className="grid min-w-0 grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
                <select aria-label={`Dependency ${index + 1} from`} value={dependency.from} onChange={(event) => onChange({ ...body, dependencies: replaceAt(body.dependencies, index, { ...dependency, from: event.target.value }) })} className="h-8 min-w-0 rounded-md border border-line bg-surface px-2 text-sm text-ink">{taskKeys.map((key) => <option key={key}>{key}</option>)}</select>
                <span className="text-xs text-ink-3">waits on</span>
                <select aria-label={`Dependency ${index + 1} to`} value={dependency.to} onChange={(event) => onChange({ ...body, dependencies: replaceAt(body.dependencies, index, { ...dependency, to: event.target.value }) })} className="h-8 min-w-0 rounded-md border border-line bg-surface px-2 text-sm text-ink">{taskKeys.map((key) => <option key={key}>{key}</option>)}</select>
                <Button size="icon-sm" variant="ghost" aria-label={`Remove dependency ${index + 1}`} onClick={() => onChange({ ...body, dependencies: body.dependencies.filter((_, at) => at !== index) })}><X /></Button>
                <div className="col-span-full"><MarkdownAuthoringField editorKey={`plan-dependency-${index}`} label={`Dependency ${index + 1} reason`} value={dependency.reason ?? ""} onChange={(reason) => onChange({ ...body, dependencies: replaceAt(body.dependencies, index, { ...dependency, reason }) })} placeholder="Why must this wait?" maxLength={WORK_LINE_MAX} /></div>
              </li>
            ))}
          </ul>
          <div><Button size="xs" variant="outline" disabled={taskKeys.length < 2} onClick={() => onChange({ ...body, dependencies: [...body.dependencies, { from: taskKeys[1]!, to: taskKeys[0]! }] })}><Plus />Add a dependency</Button></div>
        </Field>

        <Field label="Boundaries" error={errorWithin(fieldError, "boundaries")}>
          <ul role="list" className="flex flex-col gap-2">{body.boundaries.map((boundary, index) => <li key={index} className="flex flex-col gap-2 rounded-lg border border-line p-3"><div className="flex gap-2"><Input aria-label={`Boundary ${index + 1} scope`} value={boundary.scope} maxLength={WORK_LINE_MAX} onChange={(event) => onChange({ ...body, boundaries: replaceAt(body.boundaries, index, { ...boundary, scope: event.target.value }) })} placeholder="Package, path or responsibility"/><Button size="icon-sm" variant="ghost" aria-label={`Remove boundary ${index + 1}`} onClick={() => onChange({ ...body, boundaries: body.boundaries.filter((_, at) => at !== index) })}><X /></Button></div><MarkdownAuthoringField editorKey={`plan-boundary-${index}`} label={`Boundary ${index + 1} rule`} value={boundary.rule} maxLength={PROJECT_WORK_TEXT_MAX} onChange={(rule) => onChange({ ...body, boundaries: replaceAt(body.boundaries, index, { ...boundary, rule }) })} placeholder="What stays inside or outside?" /></li>)}</ul>
          <div><Button size="xs" variant="outline" onClick={() => onChange({ ...body, boundaries: [...body.boundaries, { scope: "", rule: "" }] })}><Plus />Add a boundary</Button></div>
        </Field>

        <Field label="Migrations" error={errorWithin(fieldError, "migrations")}>
          <ul role="list" className="flex flex-col gap-2">{body.migrations.map((migration, index) => <li key={index} className="flex flex-col gap-2 rounded-lg border border-line p-3"><label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={migration.reversible} onChange={(event) => onChange({ ...body, migrations: replaceAt(body.migrations, index, { ...migration, reversible: event.target.checked }) })}/>Reversible</label><MarkdownAuthoringField editorKey={`plan-migration-${index}`} label={`Migration ${index + 1}`} value={migration.summary} maxLength={WORK_LINE_MAX} onChange={(summary) => onChange({ ...body, migrations: replaceAt(body.migrations, index, { ...migration, summary }) })} placeholder="What moves?"/><MarkdownAuthoringField editorKey={`plan-migration-note-${index}`} label={`Migration ${index + 1} note`} value={migration.note ?? ""} maxLength={PROJECT_WORK_TEXT_MAX} onChange={(note) => onChange({ ...body, migrations: replaceAt(body.migrations, index, { ...migration, note }) })} placeholder="Important migration detail"/><Button size="xs" variant="ghost" onClick={() => onChange({ ...body, migrations: body.migrations.filter((_, at) => at !== index) })}><X />Remove migration</Button></li>)}</ul>
          <div><Button size="xs" variant="outline" onClick={() => onChange({ ...body, migrations: [...body.migrations, { summary: "", reversible: false }] })}><Plus />Add a migration</Button></div>
        </Field>

        <Field label="Risks" error={errorWithin(fieldError, "risks")}>
          <ul role="list" className="flex flex-col gap-2">{body.risks.map((risk, index) => <li key={index} className="flex flex-col gap-2 rounded-lg border border-line p-3"><select aria-label={`Risk ${index + 1} severity`} value={risk.severity} onChange={(event) => onChange({ ...body, risks: replaceAt(body.risks, index, { ...risk, severity: event.target.value as "low" | "medium" | "high" }) })} className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><MarkdownAuthoringField editorKey={`plan-risk-${index}`} label={`Risk ${index + 1}`} value={risk.summary} maxLength={WORK_LINE_MAX} onChange={(summary) => onChange({ ...body, risks: replaceAt(body.risks, index, { ...risk, summary }) })} placeholder="What may go wrong?"/><MarkdownAuthoringField editorKey={`plan-risk-control-${index}`} label={`Risk ${index + 1} control`} value={risk.control} maxLength={PROJECT_WORK_TEXT_MAX} onChange={(control) => onChange({ ...body, risks: replaceAt(body.risks, index, { ...risk, control }) })} placeholder="How is it controlled?"/><Button size="xs" variant="ghost" onClick={() => onChange({ ...body, risks: body.risks.filter((_, at) => at !== index) })}><X />Remove risk</Button></li>)}</ul>
          <div><Button size="xs" variant="outline" onClick={() => onChange({ ...body, risks: [...body.risks, { severity: "medium", summary: "", control: "" }] })}><Plus />Add a risk</Button></div>
        </Field>

        <LineListField label="Verification commands" values={body.verification} onChange={(verification) => onChange({ ...body, verification })} placeholder="pnpm …" addLabel="Add a command" maxLength={WORK_LINE_MAX} error={errorWithin(fieldError, "verification")} />
        <MarkdownAuthoringField editorKey="plan-rollback" label="Rollback" value={body.rollback ?? ""} onChange={(rollback) => onChange({ ...body, rollback })} placeholder="How can this be undone?" maxLength={PROJECT_WORK_TEXT_MAX} error={errorAt(fieldError, "rollback")} />
        <MarkdownAuthoringField editorKey="plan-document" label="Document" value={body.document ?? ""} onChange={(document) => onChange({ ...body, document })} placeholder="The full plan in Markdown" maxLength={PROJECT_WORK_MARKDOWN_MAX} error={errorAt(fieldError, "document")} />
      </WorkEditFields>
      <WorkEditFooter
        compact={context.compact}
        pending={edit.pending}
        canSave={edit.canSubmit && changed && title.trim() !== ""}
        saveLabel="Save as a new revision"
        onCancel={onClose}
        onSave={() => void save()}
      />
    </div>
  );
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((existing, at) => at === index ? value : existing);
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
