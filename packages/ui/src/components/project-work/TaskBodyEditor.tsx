"use client";

import { Check, Plus, X } from "lucide-react";
import { useState } from "react";
import { projectWorkBodySchema, type ProjectTaskBody, type ProjectWorkListItem } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { WorkBodyContext } from "./bodies/context.js";
import { Field, LineListField, MarkdownListField } from "./bodies/editor-fields.js";
import { MarkdownAuthoringField, MarkdownEditorActivationProvider } from "./MarkdownAuthoringField.js";

export function TaskBodyEditor({
  body,
  original,
  context,
  items,
  agents,
  onChange,
  onClose,
}: {
  body: ProjectTaskBody;
  original: ProjectTaskBody;
  context: WorkBodyContext;
  items: readonly ProjectWorkListItem[];
  agents: readonly { name: string }[];
  onChange: (body: ProjectTaskBody) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(context.detail.revision.title);
  const [error, setError] = useState<string>();
  const changed = JSON.stringify(body) !== JSON.stringify(original) || title.trim() !== context.detail.revision.title;
  const tasks = items.filter((item) => item.kind === "task" && item.ref.entityId !== context.detail.entity.entityId);
  const plans = items.filter((item) => item.kind === "plan");

  const save = async (): Promise<void> => {
    if (!context.store) return;
    if (!projectWorkBodySchema.safeParse({ kind: "task", task: body }).success) {
      setError("Some task fields are incomplete. Finish or remove the incomplete row before saving.");
      return;
    }
    setSaving(true);
    setError(undefined);
    const outcome = await context.store.revise(
      { entityId: context.detail.entity.entityId, expectedRevisionId: context.detail.revision.revisionId },
      { kind: "task", task: body },
      title.trim() !== context.detail.revision.title ? { title: title.trim() } : {},
    );
    setSaving(false);
    if (!outcome.ok) {
      setError(`${outcome.failure.message} Your draft is still here.`);
      return;
    }
    onClose();
    context.onChanged();
  };

  return (
    <div data-slot="task-editor" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <Badge variant="outline">{body.acceptance.length} acceptance criteria · {body.dependencies.length} dependencies</Badge>
        <span className="text-xs leading-xs text-ink-3">Task scope, assignment and prose become one fenced child revision.</span>
        <span className="ms-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" disabled={saving} onClick={onClose}><X />Cancel</Button>
          <Button size="sm" disabled={saving || !changed || title.trim() === ""} onClick={() => void save()}><Check />{saving ? "Saving…" : "Save as a new revision"}</Button>
        </span>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-danger/40 p-3 text-sm leading-5 text-danger">{error}</p> : null}

      <Field label="Title" htmlFor="task-title">
        <Input id="task-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <MarkdownEditorActivationProvider active>
        <MarkdownAuthoringField editorKey="task-outcome" label="Outcome" value={body.outcome} onChange={(outcome) => onChange({ ...body, outcome })} placeholder="What is true when this task is done?" />
        <MarkdownListField
          editorKey="task-non-goal"
          label="Non-goals"
          values={body.nonGoals}
          onChange={(nonGoals) => onChange({ ...body, nonGoals })}
          placeholder="What this task deliberately does not do"
          addLabel="Add a non-goal"
        />

        <Field label="Dependencies" hint="Only real Tasks from this project can be selected.">
          <div className="flex flex-wrap gap-2">
            {tasks.map((task) => (
              <label key={task.key} className="flex min-h-8 items-center gap-1.5 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={body.dependencies.includes(task.key)}
                  onChange={(event) => onChange({ ...body, dependencies: event.target.checked ? [...body.dependencies, task.key] : body.dependencies.filter((key) => key !== task.key) })}
                />
                {task.key} · {task.title}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Plan and assignment">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-ink-2">
              Plan
              <select value={body.planKey ?? ""} onChange={(event) => { const planKey = event.target.value; onChange(planKey ? { ...body, planKey } : without(body, "planKey")); }} className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink">
                <option value="">No plan</option>
                {plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.key} · {plan.title}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-2">
              Assignment
              <select
                value={body.assignment.policy === "agent" ? `agent:${body.assignment.agentName}` : body.assignment.policy}
                onChange={(event) => {
                  const value = event.target.value;
                  const assignment = value === "unassigned" ? { policy: "unassigned" as const } : value === "person" ? { policy: "person" as const } : { policy: "agent" as const, agentName: value.slice("agent:".length) };
                  onChange({ ...body, assignment });
                }}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="unassigned">Nobody yet</option>
                <option value="person">You</option>
                {agents.map((agent) => <option key={agent.name} value={`agent:${agent.name}`}>{agent.name}</option>)}
              </select>
            </label>
          </div>
        </Field>

        <div className="grid gap-4 lg:grid-cols-3">
          <LineListField label="Packages" values={body.scope.packages} onChange={(packages) => onChange({ ...body, scope: { ...body.scope, packages } })} placeholder="@scope/package" addLabel="Add a package" />
          <LineListField label="Repositories" values={body.scope.repositories} onChange={(repositories) => onChange({ ...body, scope: { ...body.scope, repositories } })} placeholder="Repository id" addLabel="Add a repository" />
          <LineListField label="Paths" values={body.scope.paths} onChange={(paths) => onChange({ ...body, scope: { ...body.scope, paths } })} placeholder="packages/ui/src" addLabel="Add a path" />
        </div>

        <Field label="Acceptance" hint="Commands stay literal; criterion text is Markdown-capable prose.">
          <ul role="list" className="flex flex-col gap-3">
            {body.acceptance.map((criterion, index) => (
              <li key={criterion.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input type="checkbox" checked={criterion.machineVerifiable} onChange={(event) => onChange({ ...body, acceptance: replaceAt(body.acceptance, index, { ...criterion, machineVerifiable: event.target.checked }) })} />
                  Checkable by a command or test
                </label>
                <MarkdownAuthoringField editorKey={`task-acceptance-${criterion.id}`} label={`Criterion ${index + 1}`} value={criterion.text} onChange={(text) => onChange({ ...body, acceptance: replaceAt(body.acceptance, index, { ...criterion, text }) })} placeholder="It is accepted when…" />
                <div className="flex items-center gap-2">
                  <Input aria-label={`Criterion ${index + 1} command`} value={criterion.command ?? ""} onChange={(event) => { const command = event.target.value; onChange({ ...body, acceptance: replaceAt(body.acceptance, index, command ? { ...criterion, command } : without(criterion, "command")) }); }} placeholder="Optional verification command" className="typed" />
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove criterion ${index + 1}`} onClick={() => onChange({ ...body, acceptance: body.acceptance.filter((_, at) => at !== index) })}><X /></Button>
                </div>
              </li>
            ))}
          </ul>
          <div><Button size="xs" variant="outline" onClick={() => onChange({ ...body, acceptance: [...body.acceptance, { id: crypto.randomUUID(), text: "", machineVerifiable: false }] })}><Plus />Add a criterion</Button></div>
        </Field>

        <LineListField label="Verification commands" values={body.verificationCommands} onChange={(verificationCommands) => onChange({ ...body, verificationCommands })} placeholder="pnpm …" addLabel="Add a command" />
        <label className="flex min-h-9 items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={body.visualEvidenceRequired} onChange={(event) => onChange({ ...body, visualEvidenceRequired: event.target.checked })} />
          Visual evidence is required
        </label>
        <MarkdownAuthoringField editorKey="task-notes" label="Notes" value={body.notes ?? ""} onChange={(notes) => onChange({ ...body, notes })} placeholder="Context that should travel with the task" />
      </MarkdownEditorActivationProvider>
    </div>
  );
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((existing, at) => at === index ? value : existing);
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const next = { ...value };
  delete next[key];
  return next;
}
