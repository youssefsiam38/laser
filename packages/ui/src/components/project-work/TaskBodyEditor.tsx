"use client";

import { Check, Plus, X } from "lucide-react";
import { useState } from "react";
import {
  PROJECT_WORK_TEXT_MAX,
  PROJECT_WORK_TITLE_MAX,
  projectTaskBodySchema,
  type ProjectTaskBody,
  type ProjectWorkListItem,
} from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { WorkBodyContext } from "./bodies/context.js";
import { Field, LineListField, MarkdownListField } from "./bodies/editor-fields.js";
import { MarkdownAuthoringField } from "./MarkdownAuthoringField.js";
import { WorkEditFields, WorkEditFooter, WorkEditNewerNotice, useWorkEditSession } from "./edit-session.js";
import {
  errorAt,
  errorWithin,
  workFieldError,
  WORK_COMMAND_MAX,
  WORK_LINE_MAX,
  WORK_PATH_MAX,
  WORK_SHORT_NAME_MAX,
  type WorkFieldError,
} from "./opened-work-validation.js";

export function TaskBodyEditor({
  body,
  context,
  edit,
  items,
  agents,
  onChange,
  onClose,
}: {
  body: ProjectTaskBody;
  context: WorkBodyContext;
  edit: ReturnType<typeof useWorkEditSession<ProjectTaskBody>>;
  items: readonly ProjectWorkListItem[];
  agents: readonly { name: string }[];
  onChange: (body: ProjectTaskBody) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(edit.owner?.baseTitle ?? context.detail.revision.title);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<WorkFieldError>();
  const original = edit.owner?.baseBody ?? body;
  const changed = JSON.stringify(body) !== JSON.stringify(original) || title.trim() !== edit.owner?.baseTitle;
  const tasks = items.filter((item) => item.kind === "task" && item.ref.entityId !== context.detail.entity.entityId);
  const plans = items.filter((item) => item.kind === "plan");

  const save = async (): Promise<void> => {
    const submitted = structuredClone(body);
    const submittedTitle = title.trim();
    const parsed = projectTaskBodySchema.safeParse(submitted);
    if (!parsed.success) {
      setError(undefined);
      setFieldError(workFieldError("task", parsed.error.issues[0]));
      return;
    }
    setError(undefined);
    setFieldError(undefined);
    const settled = await edit.submit((base) => base.store.revise(
      { entityId: base.entityId, expectedRevisionId: base.baseRevisionId },
      { kind: "task", task: submitted },
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
    <div data-slot="task-editor" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <Badge variant="outline">{body.acceptance.length} acceptance criteria · {body.dependencies.length} dependencies</Badge>
        <span className="text-xs leading-xs text-ink-3">Task scope, assignment and prose become one fenced child revision.</span>
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
      <Field label="Title" htmlFor="task-title">
        <Input id="task-title" value={title} maxLength={PROJECT_WORK_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} />
      </Field>
        <MarkdownAuthoringField editorKey="task-outcome" label="Outcome" value={body.outcome} onChange={(outcome) => onChange({ ...body, outcome })} placeholder="What is true when this task is done?" maxLength={PROJECT_WORK_TEXT_MAX} error={errorAt(fieldError, "outcome")} />
        <MarkdownListField
          editorKey="task-non-goal"
          label="Non-goals"
          values={body.nonGoals}
          onChange={(nonGoals) => onChange({ ...body, nonGoals })}
          placeholder="What this task deliberately does not do"
          addLabel="Add a non-goal"
          maxLength={WORK_LINE_MAX}
          error={errorWithin(fieldError, "nonGoals")}
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
          <LineListField label="Packages" values={body.scope.packages} onChange={(packages) => onChange({ ...body, scope: { ...body.scope, packages } })} placeholder="@scope/package" addLabel="Add a package" maxLength={WORK_SHORT_NAME_MAX} error={fieldError?.path[0] === "scope" && fieldError.path[1] === "packages" ? fieldError.message : undefined} />
          <LineListField label="Repositories" values={body.scope.repositories} onChange={(repositories) => onChange({ ...body, scope: { ...body.scope, repositories } })} placeholder="Repository id" addLabel="Add a repository" maxLength={WORK_SHORT_NAME_MAX} error={fieldError?.path[0] === "scope" && fieldError.path[1] === "repositories" ? fieldError.message : undefined} />
          <LineListField label="Paths" values={body.scope.paths} onChange={(paths) => onChange({ ...body, scope: { ...body.scope, paths } })} placeholder="packages/ui/src" addLabel="Add a path" maxLength={WORK_PATH_MAX} error={fieldError?.path[0] === "scope" && fieldError.path[1] === "paths" ? fieldError.message : undefined} />
        </div>

        <Field label="Acceptance" hint="Commands stay literal; criterion text is Markdown-capable prose." error={errorWithin(fieldError, "acceptance")}>
          <ul role="list" className="flex flex-col gap-3">
            {body.acceptance.map((criterion, index) => (
              <li key={criterion.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input type="checkbox" checked={criterion.machineVerifiable} onChange={(event) => onChange({ ...body, acceptance: replaceAt(body.acceptance, index, { ...criterion, machineVerifiable: event.target.checked }) })} />
                  Checkable by a command or test
                </label>
                <MarkdownAuthoringField editorKey={`task-acceptance-${criterion.id}`} label={`Criterion ${index + 1}`} value={criterion.text} maxLength={PROJECT_WORK_TEXT_MAX} onChange={(text) => onChange({ ...body, acceptance: replaceAt(body.acceptance, index, { ...criterion, text }) })} placeholder="It is accepted when…" />
                <div className="flex items-center gap-2">
                  <Input aria-label={`Criterion ${index + 1} command`} value={criterion.command ?? ""} maxLength={WORK_COMMAND_MAX} onChange={(event) => { const command = event.target.value; onChange({ ...body, acceptance: replaceAt(body.acceptance, index, command ? { ...criterion, command } : without(criterion, "command")) }); }} placeholder="Optional verification command" className="typed" />
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove criterion ${index + 1}`} onClick={() => onChange({ ...body, acceptance: body.acceptance.filter((_, at) => at !== index) })}><X /></Button>
                </div>
              </li>
            ))}
          </ul>
          <div><Button size="xs" variant="outline" onClick={() => onChange({ ...body, acceptance: [...body.acceptance, { id: crypto.randomUUID(), text: "", machineVerifiable: false }] })}><Plus />Add a criterion</Button></div>
        </Field>

        <LineListField label="Verification commands" values={body.verificationCommands} onChange={(verificationCommands) => onChange({ ...body, verificationCommands })} placeholder="pnpm …" addLabel="Add a command" maxLength={WORK_COMMAND_MAX} error={errorWithin(fieldError, "verificationCommands")} />
        <label className="flex min-h-9 items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={body.visualEvidenceRequired} onChange={(event) => onChange({ ...body, visualEvidenceRequired: event.target.checked })} />
          Visual evidence is required
        </label>
        <MarkdownAuthoringField editorKey="task-notes" label="Notes" value={body.notes ?? ""} onChange={(notes) => onChange({ ...body, notes })} placeholder="Context that should travel with the task" maxLength={PROJECT_WORK_TEXT_MAX} error={errorAt(fieldError, "notes")} />
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

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const next = { ...value };
  delete next[key];
  return next;
}
