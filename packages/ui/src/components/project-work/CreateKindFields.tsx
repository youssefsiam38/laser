"use client";

import { Plus, X } from "lucide-react";
import type { ProjectWorkListItem } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createDraftId,
  emptyRow,
  type CreateDraft,
  type DesignCreateDraft,
  type DraftRow,
  type PlanCreateDraft,
  type ResearchCreateDraft,
  type SpecCreateDraft,
  type TaskCreateDraft,
} from "@/project-work/create-draft";

import { MarkdownAuthoringField } from "./MarkdownAuthoringField.js";

// Creation stays a concise first revision. Detail editors can grow to the schema limits.
const MAX_CREATE_ROWS = 8;
const selectClass = "h-9 rounded-md border border-line bg-surface-1 px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-live";

function Section({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-3">
      <div>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <p className="text-xs leading-xs text-ink-3">{detail}</p>
      </div>
      {children}
    </section>
  );
}

function Remove({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick} className="shrink-0">
      <X />
    </Button>
  );
}

function LineList({ label, rows, placeholder, onChange }: { label: string; rows: DraftRow[]; placeholder: string; onChange(rows: DraftRow[]): void }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input aria-label={`${label} ${index + 1}`} value={row.text} placeholder={placeholder} onChange={(event) => onChange(rows.map((item) => item.id === row.id ? { ...item, text: event.target.value } : item))} />
          <Remove label={`Remove ${label.toLocaleLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.id !== row.id))} />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" disabled={rows.length >= MAX_CREATE_ROWS} onClick={() => onChange([...rows, emptyRow(label.toLocaleLowerCase())])} className="self-start">
        <Plus /> Add {label.toLocaleLowerCase()}
      </Button>
    </div>
  );
}

function MarkdownList({ label, rows, placeholder, onChange, onCreateShortcut }: { label: string; rows: DraftRow[]; placeholder: string; onChange(rows: DraftRow[]): void; onCreateShortcut(): void }) {
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <div key={row.id} className="rounded-md border border-line bg-surface-2 p-2">
          <div className="mb-1 flex justify-end"><Remove label={`Remove ${label.toLocaleLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.id !== row.id))} /></div>
          <MarkdownAuthoringField
            label={`${label} ${index + 1}`}
            value={row.text}
            placeholder={placeholder}
            onCreateShortcut={onCreateShortcut}
            onChange={(value) => onChange(rows.map((item) => item.id === row.id ? { ...item, text: value } : item))}
          />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" disabled={rows.length >= MAX_CREATE_ROWS} onClick={() => onChange([...rows, emptyRow(label.toLocaleLowerCase())])} className="self-start">
        <Plus /> Add {label.toLocaleLowerCase()}
      </Button>
    </div>
  );
}

export function SpecCreateFields({ draft, onChange, onCreateShortcut }: { draft: SpecCreateDraft; onChange(draft: SpecCreateDraft): void; onCreateShortcut(): void }) {
  return (
    <div className="grid gap-3">
      <Section title="Shape the decision" detail="Name the problem, intended outcomes, and what is deliberately outside the work.">
        <div className="flex gap-2" role="group" aria-label="Spec form">
          {(["brief", "full"] as const).map((form) => <Button key={form} type="button" size="sm" variant={draft.form === form ? "default" : "outline"} onClick={() => onChange({ ...draft, form })}>{form === "brief" ? "Brief spec" : "Full spec"}</Button>)}
        </div>
        <MarkdownAuthoringField label="Problem" value={draft.problem} placeholder="What is happening now, and why is it worth changing?" onChange={(problem) => onChange({ ...draft, problem })} onCreateShortcut={onCreateShortcut} />
        <LineList label="Outcome" rows={draft.outcomes} placeholder="A result this should produce" onChange={(outcomes) => onChange({ ...draft, outcomes })} />
        <LineList label="Non-goal" rows={draft.nonGoals} placeholder="What this intentionally does not cover" onChange={(nonGoals) => onChange({ ...draft, nonGoals })} />
      </Section>
      <Section title="Requirements and acceptance" detail="Make the contract concrete now, or leave it as a purposeful brief.">
        {draft.requirements.map((row, index) => (
          <div key={row.id} className="rounded-md border border-line bg-surface-2 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <select aria-label={`Requirement ${index + 1} level`} value={row.level} onChange={(event) => onChange({ ...draft, requirements: draft.requirements.map((item) => item.id === row.id ? { ...item, level: event.target.value as typeof row.level } : item) })} className={selectClass}>
                <option value="must">Must</option><option value="should">Should</option><option value="may">May</option>
              </select>
              <Remove label={`Remove requirement ${index + 1}`} onClick={() => onChange({ ...draft, requirements: draft.requirements.filter((item) => item.id !== row.id) })} />
            </div>
            <MarkdownAuthoringField label={`Requirement ${index + 1}`} value={row.text} onChange={(text) => onChange({ ...draft, requirements: draft.requirements.map((item) => item.id === row.id ? { ...item, text } : item) })} onCreateShortcut={onCreateShortcut} />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" disabled={draft.requirements.length >= MAX_CREATE_ROWS} onClick={() => onChange({ ...draft, requirements: [...draft.requirements, { ...emptyRow("requirement"), level: "must" }] })} className="self-start"><Plus /> Add requirement</Button>
        {draft.acceptance.map((row, index) => (
          <div key={row.id} className="rounded-md border border-line bg-surface-2 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={row.machineVerifiable} onChange={(event) => onChange({ ...draft, acceptance: draft.acceptance.map((item) => item.id === row.id ? { ...item, machineVerifiable: event.target.checked } : item) })} /> Checkable automatically</label>
              <Remove label={`Remove acceptance criterion ${index + 1}`} onClick={() => onChange({ ...draft, acceptance: draft.acceptance.filter((item) => item.id !== row.id) })} />
            </div>
            <MarkdownAuthoringField label={`Acceptance criterion ${index + 1}`} value={row.text} onChange={(text) => onChange({ ...draft, acceptance: draft.acceptance.map((item) => item.id === row.id ? { ...item, text } : item) })} onCreateShortcut={onCreateShortcut} />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" disabled={draft.acceptance.length >= MAX_CREATE_ROWS} onClick={() => onChange({ ...draft, acceptance: [...draft.acceptance, { ...emptyRow("acceptance"), machineVerifiable: false }] })} className="self-start"><Plus /> Add acceptance criterion</Button>
        <LineList label="Constraint" rows={draft.constraints} placeholder="A limit the solution must respect" onChange={(constraints) => onChange({ ...draft, constraints })} />
      </Section>
      <Section title="Long-form document" detail="Optional supporting Markdown; the structured contract above remains authoritative.">
        <MarkdownAuthoringField label="Document" value={draft.document} onChange={(document) => onChange({ ...draft, document })} onCreateShortcut={onCreateShortcut} />
      </Section>
    </div>
  );
}

export function ResearchCreateFields({ draft, onChange, onCreateShortcut }: { draft: ResearchCreateDraft; onChange(draft: ResearchCreateDraft): void; onCreateShortcut(): void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Section title="Question tree" detail="Start with honest open questions. Findings and sources appear only after research.">
        <MarkdownList label="Follow-up question" rows={draft.followUps} placeholder="A smaller question that helps answer the root" onChange={(followUps) => onChange({ ...draft, followUps })} onCreateShortcut={onCreateShortcut} />
      </Section>
      <Section title="Research boundary" detail="Say where to look and what should stay outside this investigation.">
        <LineList label="In scope" rows={draft.inScope} placeholder="A source, system, or topic to investigate" onChange={(inScope) => onChange({ ...draft, inScope })} />
        <LineList label="Out of scope" rows={draft.outOfScope} placeholder="What not to spend research time on" onChange={(outOfScope) => onChange({ ...draft, outOfScope })} />
        <LineList label="Constraint" rows={draft.constraints} placeholder="A research constraint" onChange={(constraints) => onChange({ ...draft, constraints })} />
      </Section>
    </div>
  );
}

export function DesignCreateFields({ draft, onChange, onCreateShortcut }: { draft: DesignCreateDraft; onChange(draft: DesignCreateDraft): void; onCreateShortcut(): void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Section title="Visual direction" detail="Principles start a proposed foundation. Screens stay empty until a real tree or sketch exists.">
        <LineList label="Principle" rows={draft.principles} placeholder="A visual or interaction principle" onChange={(principles) => onChange({ ...draft, principles })} />
      </Section>
      <Section title="References and intent" detail="Record the direction in your own words; this does not claim repository grounding.">
        <MarkdownAuthoringField label="Direction notes" value={draft.notes} placeholder="References, constraints, or qualities to preserve" onChange={(notes) => onChange({ ...draft, notes })} onCreateShortcut={onCreateShortcut} />
      </Section>
    </div>
  );
}

function TaskChecks({ tasks, selected, onChange, label }: { tasks: ProjectWorkListItem[]; selected: string[]; onChange(keys: string[]): void; label: string }) {
  return tasks.length === 0 ? <p className="text-xs text-ink-3">No existing Tasks to select. This can stay empty.</p> : (
    <div className="grid gap-1" aria-label={label}>
      {tasks.map((task) => <label key={task.key} className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={selected.includes(task.key)} onChange={(event) => onChange(event.target.checked ? [...selected, task.key] : selected.filter((key) => key !== task.key))} /><span className="typed">{task.key}</span><span className="truncate">{task.title}</span></label>)}
    </div>
  );
}

export function PlanCreateFields({ draft, onChange, items, onCreateShortcut }: { draft: PlanCreateDraft; onChange(draft: PlanCreateDraft): void; items: readonly ProjectWorkListItem[]; onCreateShortcut(): void }) {
  const tasks = items.filter((item) => item.kind === "task" && !item.archived);
  const selected = [...new Set(draft.phases.flatMap((phase) => phase.taskKeys))];
  return (
    <div className="grid gap-3">
      <Section title="Phases" detail="Group real existing Tasks without turning the Plan into a schedule.">
        {draft.phases.map((phase, index) => <div key={phase.id} className="rounded-md border border-line bg-surface-2 p-2"><div className="mb-2 flex gap-2"><Input aria-label={`Phase ${index + 1} name`} value={phase.name} placeholder="Phase name" onChange={(event) => onChange({ ...draft, phases: draft.phases.map((item) => item.id === phase.id ? { ...item, name: event.target.value } : item) })} /><Remove label={`Remove phase ${index + 1}`} onClick={() => onChange({ ...draft, phases: draft.phases.filter((item) => item.id !== phase.id) })} /></div><MarkdownAuthoringField label={`Phase ${index + 1} summary`} value={phase.summary} onChange={(summary) => onChange({ ...draft, phases: draft.phases.map((item) => item.id === phase.id ? { ...item, summary } : item) })} onCreateShortcut={onCreateShortcut} /><div className="mt-2"><TaskChecks label={`Phase ${index + 1} Tasks`} tasks={tasks} selected={phase.taskKeys} onChange={(taskKeys) => onChange({ ...draft, phases: draft.phases.map((item) => item.id === phase.id ? { ...item, taskKeys } : item) })} /></div></div>)}
        <Button type="button" variant="outline" size="sm" disabled={draft.phases.length >= MAX_CREATE_ROWS} onClick={() => onChange({ ...draft, phases: [...draft.phases, { id: createDraftId("phase"), name: "", summary: "", taskKeys: [] }] })} className="self-start"><Plus /> Add phase</Button>
      </Section>
      <Section title="Dependency graph" detail="“Waiting Task” depends on “Prerequisite Task”. Both must belong to a phase.">
        {draft.dependencies.map((edge, index) => <div key={edge.id} className="grid gap-2 rounded-md border border-line bg-surface-2 p-2 sm:grid-cols-[1fr_1fr_auto]"><select aria-label={`Dependency ${index + 1} waiting Task`} className={selectClass} value={edge.from} onChange={(event) => onChange({ ...draft, dependencies: draft.dependencies.map((item) => item.id === edge.id ? { ...item, from: event.target.value } : item) })}><option value="">Waiting Task</option>{selected.map((key) => <option key={key} value={key}>{key}</option>)}</select><select aria-label={`Dependency ${index + 1} prerequisite Task`} className={selectClass} value={edge.to} onChange={(event) => onChange({ ...draft, dependencies: draft.dependencies.map((item) => item.id === edge.id ? { ...item, to: event.target.value } : item) })}><option value="">Prerequisite Task</option>{selected.map((key) => <option key={key} value={key}>{key}</option>)}</select><Remove label={`Remove dependency ${index + 1}`} onClick={() => onChange({ ...draft, dependencies: draft.dependencies.filter((item) => item.id !== edge.id) })} /><Input aria-label={`Dependency ${index + 1} reason`} className="sm:col-span-2" value={edge.reason} placeholder="Why it must wait (optional)" onChange={(event) => onChange({ ...draft, dependencies: draft.dependencies.map((item) => item.id === edge.id ? { ...item, reason: event.target.value } : item) })} /></div>)}
        <Button type="button" variant="outline" size="sm" disabled={draft.dependencies.length >= MAX_CREATE_ROWS || selected.length < 2} onClick={() => onChange({ ...draft, dependencies: [...draft.dependencies, { id: createDraftId("dependency"), from: "", to: "", reason: "" }] })} className="self-start"><Plus /> Add dependency</Button>
      </Section>
      <Section title="Boundaries, risks, and verification" detail="Capture the edges and proof that make this executable.">
        {draft.boundaries.map((row, index) => <div key={row.id} className="rounded-md border border-line bg-surface-2 p-2"><div className="mb-2 flex gap-2"><Input aria-label={`Boundary ${index + 1} scope`} value={row.scope} placeholder="Boundary scope" onChange={(event) => onChange({ ...draft, boundaries: draft.boundaries.map((item) => item.id === row.id ? { ...item, scope: event.target.value } : item) })} /><Remove label={`Remove boundary ${index + 1}`} onClick={() => onChange({ ...draft, boundaries: draft.boundaries.filter((item) => item.id !== row.id) })} /></div><MarkdownAuthoringField label={`Boundary ${index + 1} rule`} value={row.rule} onChange={(rule) => onChange({ ...draft, boundaries: draft.boundaries.map((item) => item.id === row.id ? { ...item, rule } : item) })} onCreateShortcut={onCreateShortcut} /></div>)}
        <Button type="button" variant="outline" size="sm" disabled={draft.boundaries.length >= MAX_CREATE_ROWS} onClick={() => onChange({ ...draft, boundaries: [...draft.boundaries, { id: createDraftId("boundary"), scope: "", rule: "" }] })} className="self-start"><Plus /> Add boundary</Button>
        {draft.risks.map((row, index) => <div key={row.id} className="rounded-md border border-line bg-surface-2 p-2"><div className="mb-2 flex gap-2"><select aria-label={`Risk ${index + 1} severity`} className={selectClass} value={row.severity} onChange={(event) => onChange({ ...draft, risks: draft.risks.map((item) => item.id === row.id ? { ...item, severity: event.target.value as typeof row.severity } : item) })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><Input aria-label={`Risk ${index + 1} summary`} value={row.summary} placeholder="Risk" onChange={(event) => onChange({ ...draft, risks: draft.risks.map((item) => item.id === row.id ? { ...item, summary: event.target.value } : item) })} /><Remove label={`Remove risk ${index + 1}`} onClick={() => onChange({ ...draft, risks: draft.risks.filter((item) => item.id !== row.id) })} /></div><MarkdownAuthoringField label={`Risk ${index + 1} control`} value={row.control} onChange={(control) => onChange({ ...draft, risks: draft.risks.map((item) => item.id === row.id ? { ...item, control } : item) })} onCreateShortcut={onCreateShortcut} /></div>)}
        <Button type="button" variant="outline" size="sm" disabled={draft.risks.length >= MAX_CREATE_ROWS} onClick={() => onChange({ ...draft, risks: [...draft.risks, { id: createDraftId("risk"), summary: "", control: "", severity: "medium" }] })} className="self-start"><Plus /> Add risk</Button>
        <LineList label="Verification check" rows={draft.verification} placeholder="How the Plan will be verified" onChange={(verification) => onChange({ ...draft, verification })} />
        <MarkdownAuthoringField label="Plan document" value={draft.document} onChange={(document) => onChange({ ...draft, document })} onCreateShortcut={onCreateShortcut} />
      </Section>
    </div>
  );
}

export function TaskCreateFields({ draft, onChange, items, agentNames, onCreateShortcut }: { draft: TaskCreateDraft; onChange(draft: TaskCreateDraft): void; items: readonly ProjectWorkListItem[]; agentNames: readonly string[]; onCreateShortcut(): void }) {
  const tasks = items.filter((item) => item.kind === "task" && !item.archived);
  const plans = items.filter((item) => item.kind === "plan" && !item.archived);
  return (
    <div className="grid gap-3">
      <Section title="Scope and dependencies" detail="Declare where this writes and any real Tasks that must finish first.">
        <TaskChecks label="Task dependencies" tasks={tasks} selected={draft.dependencies} onChange={(dependencies) => onChange({ ...draft, dependencies })} />
        {draft.scope.map((row, index) => <div key={row.id} className="flex gap-2"><select aria-label={`Affected area ${index + 1} type`} className={selectClass} value={row.type} onChange={(event) => onChange({ ...draft, scope: draft.scope.map((item) => item.id === row.id ? { ...item, type: event.target.value as typeof row.type } : item) })}><option value="package">Package</option><option value="repository">Repository</option><option value="path">Path</option></select><Input aria-label={`Affected area ${index + 1}`} value={row.text} placeholder="Where the work lands" onChange={(event) => onChange({ ...draft, scope: draft.scope.map((item) => item.id === row.id ? { ...item, text: event.target.value } : item) })} /><Remove label={`Remove affected area ${index + 1}`} onClick={() => onChange({ ...draft, scope: draft.scope.filter((item) => item.id !== row.id) })} /></div>)}
        <Button type="button" variant="outline" size="sm" disabled={draft.scope.length >= MAX_CREATE_ROWS} onClick={() => onChange({ ...draft, scope: [...draft.scope, { id: createDraftId("scope"), type: "path", text: "" }] })} className="self-start"><Plus /> Add affected area</Button>
        <LineList label="Non-goal" rows={draft.nonGoals} placeholder="What this Task will not change" onChange={(nonGoals) => onChange({ ...draft, nonGoals })} />
      </Section>
      <Section title="Acceptance and proof" detail="Say how done is judged. Commands remain literal and are never rendered as Markdown.">
        {draft.acceptance.map((row, index) => <div key={row.id} className="rounded-md border border-line bg-surface-2 p-2"><div className="mb-1 flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={row.machineVerifiable} onChange={(event) => onChange({ ...draft, acceptance: draft.acceptance.map((item) => item.id === row.id ? { ...item, machineVerifiable: event.target.checked } : item) })} /> Checkable automatically</label><Remove label={`Remove acceptance criterion ${index + 1}`} onClick={() => onChange({ ...draft, acceptance: draft.acceptance.filter((item) => item.id !== row.id) })} /></div><MarkdownAuthoringField label={`Acceptance criterion ${index + 1}`} value={row.text} onChange={(text) => onChange({ ...draft, acceptance: draft.acceptance.map((item) => item.id === row.id ? { ...item, text } : item) })} onCreateShortcut={onCreateShortcut} />{row.machineVerifiable ? <Input className="mt-2 font-mono" aria-label={`Acceptance criterion ${index + 1} command`} value={row.command} placeholder="Command (optional)" onChange={(event) => onChange({ ...draft, acceptance: draft.acceptance.map((item) => item.id === row.id ? { ...item, command: event.target.value } : item) })} /> : null}</div>)}
        <Button type="button" variant="outline" size="sm" disabled={draft.acceptance.length >= MAX_CREATE_ROWS} onClick={() => onChange({ ...draft, acceptance: [...draft.acceptance, { ...emptyRow("acceptance"), machineVerifiable: false, command: "" }] })} className="self-start"><Plus /> Add acceptance criterion</Button>
        <LineList label="Verification command" rows={draft.verificationCommands} placeholder="pnpm test" onChange={(verificationCommands) => onChange({ ...draft, verificationCommands })} />
        <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={draft.visualEvidenceRequired} onChange={(event) => onChange({ ...draft, visualEvidenceRequired: event.target.checked })} /> Visual evidence is required</label>
      </Section>
      <Section title="Ownership and context" detail="A Plan and an owner are optional; neither is a prerequisite for creating this Task.">
        <label className="flex flex-col gap-1"><span className="eyebrow">Owner</span><select className={selectClass} value={draft.assignment} onChange={(event) => onChange({ ...draft, assignment: event.target.value as TaskCreateDraft["assignment"] })}><option value="unassigned">Nobody yet</option><option value="person">You</option>{agentNames.map((name) => <option key={name} value={`agent:${name}`}>{name}</option>)}</select></label>
        <label className="flex flex-col gap-1"><span className="eyebrow">Plan</span><select className={selectClass} value={draft.planKey} onChange={(event) => onChange({ ...draft, planKey: event.target.value })}><option value="">No Plan</option>{plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.key} · {plan.title}</option>)}</select></label>
        <MarkdownAuthoringField label="Notes" value={draft.notes} onChange={(notes) => onChange({ ...draft, notes })} onCreateShortcut={onCreateShortcut} />
      </Section>
    </div>
  );
}

export function KindCreateFields({ draft, onChange, items, agentNames, onCreateShortcut }: { draft: CreateDraft; onChange(draft: CreateDraft): void; items: readonly ProjectWorkListItem[]; agentNames: readonly string[]; onCreateShortcut(): void }) {
  switch (draft.kind) {
    case "spec": return <SpecCreateFields draft={draft} onChange={onChange} onCreateShortcut={onCreateShortcut} />;
    case "research": return <ResearchCreateFields draft={draft} onChange={onChange} onCreateShortcut={onCreateShortcut} />;
    case "design": return <DesignCreateFields draft={draft} onChange={onChange} onCreateShortcut={onCreateShortcut} />;
    case "plan": return <PlanCreateFields draft={draft} onChange={onChange} items={items} onCreateShortcut={onCreateShortcut} />;
    case "task": return <TaskCreateFields draft={draft} onChange={onChange} items={items} agentNames={agentNames} onCreateShortcut={onCreateShortcut} />;
  }
}
