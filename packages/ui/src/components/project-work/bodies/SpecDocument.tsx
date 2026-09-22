"use client";
/**
 * The Spec: read it, edit it, revise it (M21-T7, D-355 "Detail, by kind").
 *
 * Three rules this surface exists to keep:
 *
 * 1. **A revision is never overwritten.** Saving writes a *child* revision
 *    through `project/work/revise`, fenced by the revision the person was
 *    reading. When something landed in between, the host refuses and this
 *    shows the difference between the two and offers to keep the person's
 *    version *as a new revision* — there is no path through this file that
 *    silently replaces bytes nobody read.
 * 2. **An older revision is read as it was written.** Editing is off, and the
 *    way back to the current one is right there.
 * 3. **Brief and full are two different documents.** A brief is deliberately
 *    small (leap, "Lifecycle and gates"): nothing beyond its brief is asked
 *    of it, and the gaps a *full* spec still has are named on the full form
 *    only, as a description and never as a nag.
 */
import { AlertTriangle, Check, FileDiff, Pencil, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  PROJECT_WORK_MARKDOWN_MAX,
  PROJECT_WORK_TEXT_MAX,
  PROJECT_WORK_TITLE_MAX,
  specBodySchema,
  type ProjectWorkRef,
  type SpecBody,
  type SpecForm,
} from "@lasercode/protocol";

import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { diffLines, diffStats } from "@/components/thread/diff";
import { useLaserStable } from "@/runtime";
import {
  fullSpecGaps,
  newCriterion,
  newRequirement,
  REQUIREMENT_LEVELS,
  specBodyFrom,
  specBodyText,
  specDraft,
  specIsWritable,
  SPEC_FORM_DETAIL,
  SPEC_FORM_LABEL,
} from "@/project-work/spec";

import { MarkdownAuthoringField } from "../MarkdownAuthoringField.js";
import { WorkEditFields, WorkEditNewerNotice, useWorkEditSession } from "../edit-session.js";
import { errorAt, errorWithin, workFieldError, WORK_LINE_MAX, type WorkFieldError } from "../opened-work-validation.js";
import type { WorkBodyContext } from "./context.js";
import { Field, MarkdownField, MarkdownListField, Segmented, TextField } from "./editor-fields.js";
import { SpecBodyView } from "./index.js";

type Conflict = {
  message: string;
  /** What the host says is current now. Present unless the refusal was blind. */
  current: ProjectWorkRef | undefined;
  /** The current revision's body, once read, for the difference. */
  theirs: SpecBody | undefined;
  theirsRevisionId: string | undefined;
};

export function SpecDocument({ body, context }: { body: SpecBody; context: WorkBodyContext }) {
  const { actions } = useLaserStable();
  const [draft, setDraft] = useState<SpecBody | undefined>(undefined);
  const [title, setTitle] = useState(context.detail.revision.title);
  const [conflict, setConflict] = useState<Conflict | undefined>(undefined);
  const [difference, setDifference] = useState(false);
  const [fieldError, setFieldError] = useState<WorkFieldError | undefined>(undefined);

  const edit = useWorkEditSession<SpecBody>(context);

  const start = useCallback(() => {
    const owner = edit.begin(body);
    if (!owner) return;
    setDraft(specDraft(owner.baseBody));
    setTitle(owner.baseTitle);
    setConflict(undefined);
    setFieldError(undefined);
  }, [body, edit.begin]);

  const stop = useCallback(() => {
    if (!edit.cancel()) return;
    setDraft(undefined);
    setConflict(undefined);
    setDifference(false);
    setFieldError(undefined);
  }, [edit.cancel]);

  const write = useCallback(
    async (expectedRevisionId: string | undefined, next: SpecBody, note: string | undefined) => {
      const submitted = specBodyFrom(structuredClone(next));
      const parsed = specBodySchema.safeParse(submitted);
      if (!parsed.success) {
        setFieldError(workFieldError("spec", parsed.error.issues[0]));
        return;
      }
      setFieldError(undefined);
      const submittedTitle = title.trim();
      const settled = await edit.submit(async (base) => {
        const outcome = await base.store.revise(
          { entityId: base.entityId, expectedRevisionId: expectedRevisionId ?? base.baseRevisionId },
          { kind: "spec", spec: submitted },
          { ...(submittedTitle && submittedTitle !== base.baseTitle ? { title: submittedTitle } : {}), ...(note ? { note } : {}) },
        );
        const current = outcome.ok || outcome.failure.kind !== "conflict"
          ? undefined
          : await base.store.get({ entityId: base.entityId, body: { mode: "full" } });
        return { outcome, current };
      });
      if (settled.kind === "blocked") {
        actions.toast("error", settled.reason ?? context.readOnlyReason ?? "This draft can no longer be saved from here.");
        return;
      }
      if (settled.kind === "ignored") return;
      const { outcome, current } = settled.value;
      if (outcome.ok) {
        actions.toast("info", `${context.detail.entity.key} · revision ${outcome.value.revision.index} saved`);
        stop();
        context.onChanged();
        return;
      }
      if (outcome.failure.kind !== "conflict") {
        actions.toast("error", outcome.failure.message);
        return;
      }
      // Somebody else wrote while this was open. Read what is current now, so
      // the difference is between two real revisions and not a guess.
      const theirsBody = current?.ok ? current.value.body?.body : undefined;
      setConflict({
        message: outcome.failure.message,
        current: outcome.failure.current,
        theirs: theirsBody?.kind === "spec" ? theirsBody.spec : undefined,
        theirsRevisionId: current?.ok ? current.value.revision.revisionId : outcome.failure.current?.revisionId,
      });
    },
    [actions, context.detail.entity.key, context.onChanged, context.readOnlyReason, edit.submit, stop, title],
  );

  if (!draft || !edit.matches) {
    return (
      <div className="flex flex-col gap-4">
        <SpecToolbar body={body} editable={context.editable} reason={context.readOnlyReason} onEdit={start} />
        <SpecBodyView body={body} />
      </div>
    );
  }

  const gaps = fullSpecGaps(specBodyFrom(draft));
  const unchanged = JSON.stringify(specBodyFrom(draft)) === JSON.stringify(edit.owner?.baseBody ?? body) && title.trim() === edit.owner?.baseTitle;

  const actionButtons = (
    <>
      <Button size="sm" variant="ghost" onClick={stop} disabled={edit.pending}>
        <X />
        Cancel
      </Button>
      <Button size="sm" disabled={!edit.canSubmit || !specIsWritable(draft) || unchanged} onClick={() => void write(undefined, draft, undefined)}>
        <Check />
        {edit.pending ? "Saving…" : "Save as a new revision"}
      </Button>
    </>
  );

  return (
    <div data-slot="spec-editor" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Spec form"
          value={draft.form}
          onChange={(form: SpecForm) => setDraft({ ...draft, form })}
          options={[
            { value: "brief", label: SPEC_FORM_LABEL.brief },
            { value: "full", label: SPEC_FORM_LABEL.full },
          ]}
        />
        <span className="min-w-0 text-xs leading-xs text-ink-3">{SPEC_FORM_DETAIL[draft.form]}</span>
        {/* On a phone the acts ride in the sticky footer at the bottom of the
            screen the person is reading, not in a toolbar above the fold. */}
        {context.compact ? null : <span className="ms-auto flex items-center gap-1.5">{actionButtons}</span>}
      </div>

      <WorkEditNewerNotice show={edit.newerRevision} />

      {conflict ? (
        <ConflictBanner
          conflict={conflict}
          mine={specBodyFrom(draft)}
          pending={edit.pending}
          onViewDifference={() => setDifference(true)}
          onKeepMine={() => {
            const expected = conflict.theirsRevisionId;
            if (!expected) return;
            void write(expected, draft, "kept over a newer revision");
          }}
        />
      ) : null}

      {unchanged ? null : (
        <p className="text-xs leading-xs text-ink-3">
          Saving requests a new child revision. Revision {edit.owner?.baseRevisionIndex ?? context.detail.revision.index} stays exactly as it is.
        </p>
      )}

      <WorkEditFields locked={edit.locked}>
      <Field label="Title" htmlFor="spec-title">
        <Input id="spec-title" value={title} maxLength={PROJECT_WORK_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} className="text-sm" />
      </Field>

      <TextField
        editorKey="brief"
        label="Brief"
        hint={draft.form === "brief" ? "This is the whole of a brief. Everything below is optional until it becomes a full spec." : undefined}
        value={draft.brief}
        onChange={(brief) => setDraft({ ...draft, brief })}
        placeholder="What is this, in a few sentences?"
        maxLength={PROJECT_WORK_TEXT_MAX}
        error={errorAt(fieldError, "brief")}
      />

      {draft.form === "full" ? (
        <>
          {gaps.length > 0 ? (
            <p role="status" className="max-w-(--measure-prose) text-xs leading-xs text-ink-3">
              A full spec usually records {gaps.join(", ")}. It saves without them; this is what the form is for, not a warning.
            </p>
          ) : null}
          <TextField
            editorKey="problem"
            label="Problem"
            value={draft.problem ?? ""}
            onChange={(problem) => setDraft({ ...draft, problem })}
            placeholder="What is wrong today, for whom?"
            maxLength={PROJECT_WORK_TEXT_MAX}
            error={errorAt(fieldError, "problem")}
          />
          <MarkdownListField
            editorKey="spec-outcome"
            label="Outcomes"
            values={draft.outcomes}
            onChange={(outcomes) => setDraft({ ...draft, outcomes })}
            placeholder="What is true once this is done"
            addLabel="Add an outcome"
            maxLength={WORK_LINE_MAX}
            error={errorWithin(fieldError, "outcomes")}
          />
          <MarkdownListField
            editorKey="spec-non-goal"
            label="Non-goals"
            values={draft.nonGoals}
            onChange={(nonGoals) => setDraft({ ...draft, nonGoals })}
            placeholder="What this deliberately does not do"
            addLabel="Add a non-goal"
            maxLength={WORK_LINE_MAX}
            error={errorWithin(fieldError, "nonGoals")}
          />
          <RequirementsField draft={draft} onChange={setDraft} error={errorWithin(fieldError, "requirements")} />
          <AcceptanceField draft={draft} onChange={setDraft} error={errorWithin(fieldError, "acceptance")} />
          <MarkdownListField
            editorKey="spec-constraint"
            label="Constraints"
            values={draft.constraints}
            onChange={(constraints) => setDraft({ ...draft, constraints })}
            placeholder="A rule this has to work inside"
            addLabel="Add a constraint"
            maxLength={WORK_LINE_MAX}
            error={errorWithin(fieldError, "constraints")}
          />
        </>
      ) : null}

      <MarkdownField
        editorKey="document"
        label="Document"
        value={draft.document ?? ""}
        onChange={(document) => setDraft({ ...draft, document })}
        placeholder="The long form, in Markdown. Headings, lists, code — the same renderer the conversation uses."
        maxLength={PROJECT_WORK_MARKDOWN_MAX}
        error={errorAt(fieldError, "document")}
      />
      </WorkEditFields>

      {context.compact ? (
        <footer
          data-slot="spec-editor-footer"
          className="sticky bottom-0 z-10 -mx-3 flex items-center justify-end gap-1.5 border-t border-line bg-bg px-3 py-2 pb-[max(var(--spacing)*2,env(safe-area-inset-bottom))]"
        >
          {actionButtons}
        </footer>
      ) : null}

      <DifferenceDialog
        open={difference}
        onOpenChange={setDifference}
        entityKey={context.detail.entity.key}
        mine={specBodyFrom(draft)}
        theirs={conflict?.theirs}
      />
    </div>
  );
}

function SpecToolbar({
  body,
  editable,
  reason,
  onEdit,
}: {
  body: SpecBody;
  editable: boolean;
  reason: string | undefined;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={body.form === "full" ? "ok" : "outline"}>{SPEC_FORM_LABEL[body.form]}</Badge>
      <span className="min-w-0 text-xs leading-xs text-ink-3">{SPEC_FORM_DETAIL[body.form]}</span>
      {body.form === "full" ? (
        <span className="text-xs leading-xs text-ink-2">
          {body.requirements.length} requirements · {body.acceptance.length} acceptance criteria
        </span>
      ) : null}
      <span className="ms-auto flex items-center gap-2">
        {!editable && reason ? <span className="text-xs leading-xs text-ink-3">{reason}</span> : null}
        <Button size="sm" variant="outline" onClick={onEdit} disabled={!editable} data-slot="spec-edit">
          <Pencil />
          Edit
        </Button>
      </span>
    </div>
  );
}

function ConflictBanner({
  conflict,
  mine,
  pending,
  onViewDifference,
  onKeepMine,
}: {
  conflict: Conflict;
  mine: SpecBody;
  pending: boolean;
  onViewDifference: () => void;
  onKeepMine: () => void;
}) {
  const changed = conflict.theirs ? diffStats(diffLines(specBodyText(conflict.theirs), specBodyText(mine))) : undefined;
  return (
    <div
      role="alert"
      data-slot="revision-conflict"
      className="flex flex-col gap-2 rounded-lg border border-line bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] p-3"
    >
      <p className="flex items-start gap-2 text-sm leading-5 text-ink">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-attention" />
        <span className="min-w-0">
          This changed while you were writing, so nothing was saved over it. Your version is still here, exactly as you left it.
          {changed ? ` Yours differs by ${changed.added} added and ${changed.removed} removed lines.` : ""}
        </span>
      </p>
      <p className="text-xs leading-xs text-ink-2">{conflict.message}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={onViewDifference} disabled={!conflict.theirs}>
          <FileDiff />
          View the difference
        </Button>
        <Button size="xs" onClick={onKeepMine} disabled={pending || !conflict.theirsRevisionId}>
          Keep mine as a new revision
        </Button>
      </div>
    </div>
  );
}

function DifferenceDialog({
  open,
  onOpenChange,
  entityKey,
  mine,
  theirs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityKey: string;
  mine: SpecBody;
  theirs: SpecBody | undefined;
}) {
  const view = useMemo(
    () => (theirs ? { path: entityKey, hunks: diffLines(specBodyText(theirs), specBodyText(mine)), truncated: false } : undefined),
    [entityKey, mine, theirs],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>What changed</DialogTitle>
        <DialogDescription>
          The revision that landed while you were writing, on the left; your version on the right. Nothing has been written yet.
        </DialogDescription>
        {view ? (
          <CodeDiff view={view} />
        ) : (
          <p className="text-sm leading-5 text-ink-2">The current revision could not be read, so there is nothing honest to compare against.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RequirementsField({ draft, onChange, error }: { draft: SpecBody; onChange: (body: SpecBody) => void; error?: string | undefined }) {
  return (
    <Field label="Requirements" hint="`must` blocks a gate; `should` and `may` do not." error={error}>
      <ul role="list" className="flex flex-col gap-1.5">
        {draft.requirements.map((requirement, index) => (
          <li key={requirement.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line p-2">
            <Segmented
              label={`Requirement ${index + 1} level`}
              value={requirement.level}
              onChange={(level) =>
                onChange({
                  ...draft,
                  requirements: draft.requirements.map((existing) => (existing.id === requirement.id ? { ...existing, level } : existing)),
                })
              }
              options={REQUIREMENT_LEVELS.map((level) => ({ value: level, label: level }))}
            />
            <MarkdownAuthoringField
              editorKey={`spec-requirement-${requirement.id}`}
              label={`Requirement ${index + 1}`}
              value={requirement.text}
              placeholder="The system does…"
              maxLength={PROJECT_WORK_TEXT_MAX}
              onChange={(text) =>
                onChange({
                  ...draft,
                  requirements: draft.requirements.map((existing) =>
                    existing.id === requirement.id ? { ...existing, text } : existing,
                  ),
                })
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove requirement ${index + 1}`}
              onClick={() => onChange({ ...draft, requirements: draft.requirements.filter((existing) => existing.id !== requirement.id) })}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button size="xs" variant="outline" onClick={() => onChange({ ...draft, requirements: [...draft.requirements, newRequirement()] })}>
          Add a requirement
        </Button>
      </div>
    </Field>
  );
}

function AcceptanceField({ draft, onChange, error }: { draft: SpecBody; onChange: (body: SpecBody) => void; error?: string | undefined }) {
  return (
    <Field label="Acceptance" hint="Mark a criterion checkable when a command or a test can decide it without a person." error={error}>
      <ul role="list" className="flex flex-col gap-1.5">
        {draft.acceptance.map((criterion, index) => (
          <li key={criterion.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line p-2">
            <Segmented
              label={`Criterion ${index + 1} kind`}
              value={criterion.machineVerifiable ? "checkable" : "person"}
              onChange={(value) =>
                onChange({
                  ...draft,
                  acceptance: draft.acceptance.map((existing) =>
                    existing.id === criterion.id ? { ...existing, machineVerifiable: value === "checkable" } : existing,
                  ),
                })
              }
              options={[
                { value: "checkable", label: "checkable" },
                { value: "person", label: "by a person" },
              ]}
            />
            <MarkdownAuthoringField
              editorKey={`spec-acceptance-${criterion.id}`}
              label={`Acceptance criterion ${index + 1}`}
              value={criterion.text}
              placeholder="It is accepted when…"
              maxLength={PROJECT_WORK_TEXT_MAX}
              onChange={(text) =>
                onChange({
                  ...draft,
                  acceptance: draft.acceptance.map((existing) =>
                    existing.id === criterion.id ? { ...existing, text } : existing,
                  ),
                })
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove acceptance criterion ${index + 1}`}
              onClick={() => onChange({ ...draft, acceptance: draft.acceptance.filter((existing) => existing.id !== criterion.id) })}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button size="xs" variant="outline" onClick={() => onChange({ ...draft, acceptance: [...draft.acceptance, newCriterion()] })}>
          Add a criterion
        </Button>
      </div>
    </Field>
  );
}
