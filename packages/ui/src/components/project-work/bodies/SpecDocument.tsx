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
import type { ProjectWorkRef, SpecBody, SpecForm } from "@lasercode/protocol";

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
  sameSpecBody,
  specBodyFrom,
  specBodyText,
  specDraft,
  specIsWritable,
  SPEC_FORM_DETAIL,
  SPEC_FORM_LABEL,
} from "@/project-work/spec";

import type { WorkBodyContext } from "./context.js";
import { Field, LineListField, MarkdownField, Segmented, TextField } from "./editor-fields.js";
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
  const [view, setView] = useState<"source" | "preview">("source");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | undefined>(undefined);
  const [difference, setDifference] = useState(false);

  const entityId = context.detail.entity.entityId;
  const revisionId = context.detail.revision.revisionId;

  const start = useCallback(() => {
    setDraft(specDraft(body));
    setTitle(context.detail.revision.title);
    setConflict(undefined);
  }, [body, context.detail.revision.title]);

  const stop = useCallback(() => {
    setDraft(undefined);
    setConflict(undefined);
    setDifference(false);
  }, []);

  const write = useCallback(
    async (expectedRevisionId: string, next: SpecBody, note: string | undefined) => {
      if (!context.store) return;
      setSaving(true);
      const outcome = await context.store.revise(
        { entityId, expectedRevisionId },
        { kind: "spec", spec: specBodyFrom(next) },
        { ...(title.trim() && title.trim() !== context.detail.revision.title ? { title: title.trim() } : {}), ...(note ? { note } : {}) },
      );
      setSaving(false);
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
      const current = await context.store.get({ entityId, body: { mode: "full" } });
      const theirsBody = current.ok ? current.value.body?.body : undefined;
      setConflict({
        message: outcome.failure.message,
        current: outcome.failure.current,
        theirs: theirsBody?.kind === "spec" ? theirsBody.spec : undefined,
        theirsRevisionId: current.ok ? current.value.revision.revisionId : outcome.failure.current?.revisionId,
      });
    },
    [actions, context, entityId, stop, title],
  );

  if (!draft) {
    return (
      <div className="flex flex-col gap-4">
        <SpecToolbar form={body.form} editable={context.editable} reason={context.readOnlyReason} onEdit={start} />
        <SpecBodyView body={body} />
      </div>
    );
  }

  const gaps = fullSpecGaps(specBodyFrom(draft));
  const unchanged = sameSpecBody(specBodyFrom(draft), body) && title.trim() === context.detail.revision.title;

  const actionButtons = (
    <>
      <Button size="sm" variant="ghost" onClick={stop} disabled={saving}>
        <X />
        Cancel
      </Button>
      <Button size="sm" disabled={saving || !specIsWritable(draft) || unchanged} onClick={() => void write(revisionId, draft, undefined)}>
        <Check />
        {saving ? "Saving…" : "Save as a new revision"}
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

      {conflict ? (
        <ConflictBanner
          conflict={conflict}
          mine={specBodyFrom(draft)}
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
          Saving writes revision {context.detail.entity.revisionCount + 1}. Revision {context.detail.revision.index} stays exactly as it is.
        </p>
      )}

      <Field label="Title" htmlFor="spec-title">
        <Input id="spec-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} className="text-sm" />
      </Field>

      <TextField
        label="Brief"
        hint={draft.form === "brief" ? "This is the whole of a brief. Everything below is optional until it becomes a full spec." : undefined}
        value={draft.brief}
        onChange={(brief) => setDraft({ ...draft, brief })}
        placeholder="What is this, in a few sentences?"
      />

      {draft.form === "full" ? (
        <>
          {gaps.length > 0 ? (
            <p role="status" className="max-w-(--measure-prose) text-xs leading-xs text-ink-3">
              A full spec usually records {gaps.join(", ")}. It saves without them; this is what the form is for, not a warning.
            </p>
          ) : null}
          <TextField
            label="Problem"
            value={draft.problem ?? ""}
            onChange={(problem) => setDraft({ ...draft, problem })}
            placeholder="What is wrong today, for whom?"
          />
          <LineListField
            label="Outcomes"
            values={draft.outcomes}
            onChange={(outcomes) => setDraft({ ...draft, outcomes })}
            placeholder="What is true once this is done"
            addLabel="Add an outcome"
          />
          <LineListField
            label="Non-goals"
            values={draft.nonGoals}
            onChange={(nonGoals) => setDraft({ ...draft, nonGoals })}
            placeholder="What this deliberately does not do"
            addLabel="Add a non-goal"
          />
          <RequirementsField draft={draft} onChange={setDraft} />
          <AcceptanceField draft={draft} onChange={setDraft} />
          <LineListField
            label="Constraints"
            values={draft.constraints}
            onChange={(constraints) => setDraft({ ...draft, constraints })}
            placeholder="A rule this has to work inside"
            addLabel="Add a constraint"
          />
        </>
      ) : null}

      <MarkdownField
        label="Document"
        value={draft.document ?? ""}
        onChange={(document) => setDraft({ ...draft, document })}
        placeholder="The long form, in Markdown. Headings, lists, code — the same renderer the conversation uses."
        view={view}
        onViewChange={setView}
      />

      {context.compact ? (
        <div
          data-slot="spec-editor-footer"
          className="sticky bottom-0 z-10 -mx-3 flex items-center justify-end gap-1.5 border-t border-line bg-bg px-3 py-2 pb-[max(var(--spacing)*2,env(safe-area-inset-bottom))]"
        >
          {actionButtons}
        </div>
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
  form,
  editable,
  reason,
  onEdit,
}: {
  form: SpecForm;
  editable: boolean;
  reason: string | undefined;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={form === "full" ? "ok" : "outline"}>{SPEC_FORM_LABEL[form]}</Badge>
      <span className="min-w-0 text-xs leading-xs text-ink-3">{SPEC_FORM_DETAIL[form]}</span>
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
  onViewDifference,
  onKeepMine,
}: {
  conflict: Conflict;
  mine: SpecBody;
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
        <Button size="xs" onClick={onKeepMine} disabled={!conflict.theirsRevisionId}>
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

function RequirementsField({ draft, onChange }: { draft: SpecBody; onChange: (body: SpecBody) => void }) {
  return (
    <Field label="Requirements" hint="`must` blocks a gate; `should` and `may` do not.">
      <ul role="list" className="flex flex-col gap-1.5">
        {draft.requirements.map((requirement, index) => (
          <li key={requirement.id} className="flex min-w-0 items-center gap-1.5">
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
            <Input
              value={requirement.text}
              aria-label={`Requirement ${index + 1}`}
              placeholder="The system does…"
              onChange={(event) =>
                onChange({
                  ...draft,
                  requirements: draft.requirements.map((existing) =>
                    existing.id === requirement.id ? { ...existing, text: event.target.value } : existing,
                  ),
                })
              }
              className="h-8 text-sm"
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

function AcceptanceField({ draft, onChange }: { draft: SpecBody; onChange: (body: SpecBody) => void }) {
  return (
    <Field label="Acceptance" hint="Mark a criterion checkable when a command or a test can decide it without a person.">
      <ul role="list" className="flex flex-col gap-1.5">
        {draft.acceptance.map((criterion, index) => (
          <li key={criterion.id} className="flex min-w-0 items-center gap-1.5">
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
            <Input
              value={criterion.text}
              aria-label={`Acceptance criterion ${index + 1}`}
              placeholder="It is accepted when…"
              onChange={(event) =>
                onChange({
                  ...draft,
                  acceptance: draft.acceptance.map((existing) =>
                    existing.id === criterion.id ? { ...existing, text: event.target.value } : existing,
                  ),
                })
              }
              className="h-8 text-sm"
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
