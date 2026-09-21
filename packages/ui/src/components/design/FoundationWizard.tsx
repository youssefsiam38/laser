"use client";
/**
 * Foundation mode, the wizard (M21-T14; `docs/design-phase.md`, "Case A").
 *
 * Ten proposals in a fixed order, each one editable, with the canvas beside
 * them showing what they add up to. Three things this surface refuses to do:
 *
 * 1. **Pretend.** Every step says where it came from — a model, the neutral
 *    starting point, or the person — and everything stays `Proposed` until
 *    Build implements it.
 * 2. **Touch the repository.** The sentence is on the surface, not in a doc:
 *    the foundation lives in this app until a build implements it.
 * 3. **Recommend what it cannot license.** A source whose licence could not
 *    be read is shown as blocked, with the reason, and cannot be approved
 *    into the Plan.
 *
 * Approving records the Design Profile digest v1 and takes the decision on
 * the Design gate, which accepts a recorded foundation in place of an index
 * profile (M21-T8). The Plan that follows lists the foundation Task first,
 * because a feature built beside the foundation is a codebase with two design
 * languages in it.
 */
import { Check, ChevronRight, FileText, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  FOUNDATION_REPOSITORY_SENTENCE,
  FOUNDATION_STEPS,
  FOUNDATION_SUPERSEDED_SENTENCE,
  foundationBlockedSources,
  foundationIsComplete,
  foundationPlanSkeleton,
  foundationPlanWithKeys,
  foundationProgress,
  foundationStepState,
  nextFoundationStep,
  withFoundationStep,
  type DesignBody,
  type DesignFoundation,
  type DesignIndex,
  type FoundationComponentContract,
  type FoundationScaleStep,
  type FoundationStepId,
  type ApprovedRevision,
  type FoundationTypeStep,
  type GateStatusReport,
} from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { approvedFoundation, foundationApprovalState, supersededDiff } from "@/design/foundation";

import { FoundationCanvas } from "./FoundationCanvas.js";
import { FoundationTokenEditor } from "./FoundationTokenEditor.js";
import type { WorkBodyContext } from "../project-work/bodies/context.js";

/** What a person is told about approving while the draft is unsaved. */
export const FOUNDATION_UNSAVED_SENTENCE = "Save the revision first: an approval records the exact revision it covers, and this one is not stored yet.";

/** What the wizard says when a step has not been proposed at all. */
export const FOUNDATION_STEP_PENDING_SENTENCE =
  "Not proposed yet. Ask for it in the chat with this design open — each step is composed from the ones you have already accepted.";

export interface FoundationWizardProps {
  body: DesignBody;
  foundation: DesignFoundation;
  context: WorkBodyContext;
  editable: boolean;
  /** True while the detail holds edits that have not been stored. */
  dirty: boolean;
  onChange: (next: DesignFoundation) => void;
  /** Store the current draft as a revision. */
  onSave: () => Promise<void> | void;
  /** The project's index, once the built source has been indexed. */
  index?: DesignIndex | undefined;
}

export function FoundationWizard({ body, foundation, context, editable, dirty, onChange, onSave, index }: FoundationWizardProps) {
  const { actions } = useLaserStable() as { actions: { toast: (kind: "info" | "error", message: string) => void } };
  const [open, setOpen] = useState<FoundationStepId | undefined>(() => nextFoundationStep(foundation));
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState<"approve" | "plan" | undefined>(undefined);
  const progress = foundationProgress(foundation);
  const complete = foundationIsComplete(foundation);
  const blocked = foundationBlockedSources(foundation);
  const workKey = context.detail.entity.key;
  // Approved is what the host recorded, never what this body says about
  // itself: the `status`/`profile` fields are written *before* the decision
  // is asked for, because the approval covers the revision that carries the
  // digest. A refused gate, or any revision since, must not read as approved.
  const approvalState = foundationApprovalState({
    foundation,
    approvals: context.detail.approvals ?? [],
    entityId: context.detail.entity.entityId,
    digest: context.detail.revision.digest,
    dirty,
  });
  const approved = approvalState.approved;

  // The index supersedes the proposal the moment the built source is indexed:
  // the foundation stops being the authority and says so, with the names that
  // moved.
  const superseded = index?.tokensDocument !== undefined || foundation.supersededBy !== undefined;
  const diff = useMemo(() => (superseded ? supersededDiff(foundation, index?.tokensDocument) : undefined), [foundation, index?.tokensDocument, superseded]);

  const designGate = context.detail.gates?.gates.find((gate: GateStatusReport) => gate.gate === "design");

  /**
   * Record the person's approval on a design no gate covers.
   *
   * Two steps, the same two the gate card takes, because the spine has no
   * `draft → approved` edge: ask for the decision, then take it. The covers
   * are this design at the exact revision the host just answered with, so the
   * host's own digest check is what binds the decision — this window never
   * assembles a digest of its own.
   */
  const recordStandalone = useCallback(
    async (read: { entity: { entityId: string; key: string; state: string }; revision: { revisionId: string; digest: string } }): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (!context.store) return { ok: false, message: "This project has not been read yet." };
      const entityId = read.entity.entityId;
      const revisionId = read.revision.revisionId;
      if (read.entity.state === "draft") {
        const sent = await context.store.review({ entityId, expectedRevisionId: revisionId }, "request_review");
        if (!sent.ok) return { ok: false, message: sent.failure.message };
      }
      const covers: ApprovedRevision[] = [{ entityId, kind: "design", key: read.entity.key, revisionId, digest: read.revision.digest }];
      const outcome = await context.store.approve({ entityId, expectedRevisionId: revisionId }, { gate: "design", decision: "approved", covers });
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.failure.message };
    },
    [context.store],
  );

  const approve = useCallback(async () => {
    if (!context.store || !complete) return;
    if (dirty) {
      actions.toast("error", FOUNDATION_UNSAVED_SENTENCE);
      return;
    }
    setWorking("approve");
    try {
      // 1 · the digest, over the foundation's own content, and the revision
      // that carries it. The digest is what "Design Profile v1" means.
      const next = await approvedFoundation(foundation, new Date().toISOString());
      const stored = await context.store.revise(
        { entityId: context.detail.entity.entityId, expectedRevisionId: context.detail.revision.revisionId },
        { kind: "design", design: { ...body, foundation: next } },
        { note: "Foundation approved" },
      );
      if (!stored.ok) {
        actions.toast("error", stored.failure.message);
        return;
      }
      // 2 · the decision, on the Design gate, covering exactly what the host
      // says it covers — read back after the revision, never assembled here.
      const read = await context.store.get({ entityId: context.detail.entity.entityId, body: { mode: "none" } });
      if (!read.ok) {
        actions.toast("error", read.failure.message);
        return;
      }
      const gate = read.value.gates?.gates.find((candidate: GateStatusReport) => candidate.gate === "design");
      if (!gate || gate.covers.length === 0) {
        // No Spec put this design on the gated path, and that is an ordinary
        // way to work (D-352, "gates only when chosen"). The approval is still
        // the person's and still durable: the host records a decision off the
        // gated path against exact digests, so it is recorded here on this
        // design's own revision rather than dropped with a note.
        const standalone = await recordStandalone(read.value);
        if (!standalone.ok) {
          actions.toast("error", standalone.message);
          context.onChanged();
          return;
        }
        actions.toast(
          "info",
          `Foundation approved on ${workKey} · profile digest ${next.profile?.digest.slice(0, 12) ?? ""}. No spec gates this design, so the approval is recorded on the design itself.`,
        );
        context.onChanged();
        return;
      }
      if (gate.refusal) {
        actions.toast("error", gate.refusal);
        context.onChanged();
        return;
      }
      const outcome = await context.store.approve(
        { entityId: gate.subject?.entityId ?? context.detail.entity.entityId, expectedRevisionId: gate.subject?.revisionId ?? read.value.revision.revisionId },
        { gate: "design", decision: "approved", covers: gate.covers.slice() },
      );
      if (!outcome.ok) {
        actions.toast("error", outcome.failure.message);
        return;
      }
      actions.toast("info", `Foundation approved on ${workKey} · profile digest ${next.profile?.digest.slice(0, 12) ?? ""}`);
      setTyped("");
      context.onChanged();
    } finally {
      setWorking(undefined);
    }
  }, [actions, body, complete, context, dirty, foundation, recordStandalone, workKey]);

  const createPlan = useCallback(async () => {
    if (!context.store) return;
    setWorking("plan");
    try {
      const skeleton = foundationPlanSkeleton(foundation, { designKey: workKey });
      const keys: string[] = [];
      for (const task of skeleton.tasks) {
        const created = await context.store.create({ kind: "task", title: task.title, text: task.body.outcome });
        if (!created.ok) {
          actions.toast("error", created.failure.message);
          return;
        }
        keys.push(created.value.entity.key);
        const written = await context.store.revise(
          { entityId: created.value.entity.entityId, expectedRevisionId: created.value.revision.revisionId },
          { kind: "task", task: task.body },
          { note: "From the approved foundation" },
        );
        if (!written.ok) {
          actions.toast("error", written.failure.message);
          return;
        }
      }
      const plan = foundationPlanWithKeys(skeleton, keys);
      const createdPlan = await context.store.create({ kind: "plan", title: "Build on the foundation", text: plan.brief });
      if (!createdPlan.ok) {
        actions.toast("error", createdPlan.failure.message);
        return;
      }
      const writtenPlan = await context.store.revise(
        { entityId: createdPlan.value.entity.entityId, expectedRevisionId: createdPlan.value.revision.revisionId },
        { kind: "plan", plan },
        { note: "From the approved foundation" },
      );
      if (!writtenPlan.ok) {
        actions.toast("error", writtenPlan.failure.message);
        return;
      }
      actions.toast("info", `${createdPlan.value.entity.key} created · ${keys[0] ?? "the foundation task"} is built first`);
      context.onChanged();
    } finally {
      setWorking(undefined);
    }
  }, [actions, context, foundation, workKey]);

  return (
    <section data-slot="foundation-wizard" aria-label="Foundation" className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge variant={superseded ? "outline" : approved ? "ok" : "live"}>{superseded ? "Superseded" : approved ? "Approved" : "Proposed"}</Badge>
        <span className="text-xs leading-xs text-ink-3">
          {progress.accepted} of {progress.total} steps accepted
          {approved && foundation.profile ? ` · profile v${String(foundation.profile.version)} ${foundation.profile.digest.slice(0, 12)}` : ""}
        </span>
      </div>

      <p role="note" data-slot="foundation-repository-note" className="text-xs leading-xs text-ink-2">
        {FOUNDATION_REPOSITORY_SENTENCE}
      </p>

      {/* The body can carry a profile digest that no decision backs — it is
          written on the way to the approval, not by it. When nothing backs it,
          this says so instead of letting a badge imply otherwise. */}
      {approvalState.unbacked !== undefined && !superseded ? (
        <p role="status" data-slot="foundation-unbacked" className="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs leading-4 text-ink-2">
          {approvalState.unbacked}
        </p>
      ) : null}

      {superseded && diff ? (
        <div data-slot="foundation-superseded" className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2">
          <p className="text-xs leading-xs text-ink-2">{FOUNDATION_SUPERSEDED_SENTENCE}</p>
          <p className="text-xs leading-xs text-ink-3">
            {diff.kept.length} token{diff.kept.length === 1 ? "" : "s"} kept the name they were approved under
            {diff.added.length > 0 ? `; ${String(diff.added.length)} the index has and this did not propose (${diff.added.slice(0, 4).join(", ")}${diff.added.length > 4 ? "…" : ""})` : ""}
            {diff.removed.length > 0 ? `; ${String(diff.removed.length)} proposed here are not in the built source (${diff.removed.slice(0, 4).join(", ")}${diff.removed.length > 4 ? "…" : ""})` : ""}.
          </p>
        </div>
      ) : null}

      <FoundationCanvas foundation={foundation} />

      <ol className="flex min-w-0 flex-col gap-1.5">
        {FOUNDATION_STEPS.map((step, index2) => {
          const record = foundationStepState(foundation, step.id);
          const isOpen = open === step.id;
          return (
            <li key={step.id}>
              <Collapsible open={isOpen} onOpenChange={(next) => setOpen(next ? step.id : undefined)}>
                <CollapsibleTrigger
                  data-slot="foundation-step"
                  data-step={step.id}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none",
                    "hover:bg-surface focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                  )}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) rtl:-scale-x-100 motion-reduce:transition-none", isOpen && "rotate-90 rtl:-rotate-90")}
                  />
                  <span className="typed tnum shrink-0 text-ink-3">{index2 + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm leading-5 text-ink">{step.label}</span>
                  {record?.source === "fallback" ? <Badge variant="outline">Neutral</Badge> : null}
                  <Badge variant={record?.state === "accepted" ? "ok" : record ? "live" : "outline"}>
                    {record?.state === "accepted" ? "Accepted" : record ? "Proposed" : "Waiting"}
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col gap-3 px-2 py-2">
                    <p className="text-xs leading-4 text-ink-3">{step.purpose}</p>
                    {record?.summary ? <p className="text-xs leading-4 text-ink-2">{record.summary}</p> : null}
                    {record?.note ? (
                      <p role="note" data-slot="foundation-step-note" className="text-xs leading-4 text-ink-2">
                        {record.note}
                      </p>
                    ) : null}
                    {record ? (
                      <StepEditor step={step.id} foundation={foundation} editable={editable} onChange={onChange} />
                    ) : (
                      <p role="status" className="text-xs leading-4 text-ink-3">
                        {FOUNDATION_STEP_PENDING_SENTENCE}
                      </p>
                    )}
                    {record && editable ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="xs"
                          variant={record.state === "accepted" ? "ghost" : "default"}
                          onClick={() => {
                            onChange(acceptStep(foundation, step.id));
                            setOpen(nextFoundationStep(acceptStep(foundation, step.id)));
                          }}
                          disabled={record.state === "accepted"}
                        >
                          <Check />
                          {record.state === "accepted" ? "Accepted" : "Accept this step"}
                        </Button>
                        {record.state === "accepted" ? (
                          <Button size="xs" variant="ghost" onClick={() => onChange(reopenStep(foundation, step.id))}>
                            Reopen
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ol>

      {blocked.length > 0 ? (
        <div role="note" data-slot="foundation-blocked-sources" className="flex flex-col gap-1 rounded-lg border border-attention/40 bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs leading-xs font-medium text-ink">
            <ShieldAlert aria-hidden="true" className="size-3.5" />
            {blocked.length} source{blocked.length === 1 ? "" : "s"} cannot be used
          </p>
          <ul className="flex flex-col gap-0.5">
            {blocked.map((source) => (
              <li key={source.id} className="text-xs leading-4 text-ink-2">
                {source.name}: {source.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {editable && !superseded ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          {approved ? (
            <>
              <p className="text-xs leading-4 text-ink-2">
                Approved, digest {foundation.profile?.digest.slice(0, 12) ?? ""}. The build implements the foundation first: the plan below lists that task before anything composed from it.
              </p>
              <Button size="sm" variant="outline" className="self-start" disabled={working !== undefined} onClick={() => void createPlan()}>
                <FileText />
                {working === "plan" ? "Creating the plan…" : "Create the plan, foundation first"}
              </Button>
            </>
          ) : (
            <>
              <p className="text-xs leading-4 text-ink-2">
                {complete
                  ? `Approving records this exact revision as Design Profile v1 and takes the decision — on the design gate when a spec gates this design, on the design itself when none does.${dirty ? ` ${FOUNDATION_UNSAVED_SENTENCE}` : ""}`
                  : `Accept every step first: ${String(progress.total - progress.accepted)} still to go.`}
                {designGate?.refusal ? ` ${designGate.refusal}` : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="foundation-approve-key" className="text-xs leading-xs text-ink-2">
                  Type <span className="typed text-ink">{workKey}</span> to approve. Enter never approves.
                </label>
                <input
                  id="foundation-approve-key"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  disabled={!complete || working !== undefined}
                  aria-label={`Type ${workKey} to approve`}
                  autoComplete="off"
                  spellCheck={false}
                  className="typed h-7 w-32 rounded-md border border-line bg-bg px-2 text-ink outline-none focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25"
                />
                <Button size="sm" disabled={!complete || dirty || typed.trim() !== workKey || working !== undefined} onClick={() => void approve()}>
                  <Check />
                  {working === "approve" ? "Approving…" : "Approve the foundation"}
                </Button>
                {dirty ? (
                  <Button size="sm" variant="outline" onClick={() => void onSave()}>
                    Save the revision
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Accepting, reopening
// ---------------------------------------------------------------------------

function acceptStep(foundation: DesignFoundation, id: FoundationStepId): DesignFoundation {
  return withStep(foundation, id, (record) => ({ ...record, state: "accepted", at: new Date().toISOString() }));
}

function reopenStep(foundation: DesignFoundation, id: FoundationStepId): DesignFoundation {
  return withStep(foundation, id, (record) => ({ ...record, state: "proposed" }));
}

/** Mark a step edited by the person, keeping everything else it records. */
function editedStep(foundation: DesignFoundation, id: FoundationStepId): DesignFoundation {
  return withStep(foundation, id, (record) => ({ ...record, edited: true, source: "person" }));
}

/**
 * Patch the record this wizard is showing, through the protocol's own ordered
 * replacement. The window's semantics stay the window's — it changes the
 * record it already has and never invents one for a step nobody proposed —
 * and where the row lands is the contract's, the same function the worker
 * writes its proposals through.
 */
function withStep(
  foundation: DesignFoundation,
  id: FoundationStepId,
  change: (record: NonNullable<DesignFoundation["steps"]>[number]) => NonNullable<DesignFoundation["steps"]>[number],
): DesignFoundation {
  const existing = foundationStepState(foundation, id);
  if (!existing) return foundation;
  return withFoundationStep(foundation, change(existing));
}

// ---------------------------------------------------------------------------
// The per-step editors
// ---------------------------------------------------------------------------

function StepEditor({
  step,
  foundation,
  editable,
  onChange,
}: {
  step: FoundationStepId;
  foundation: DesignFoundation;
  editable: boolean;
  onChange: (next: DesignFoundation) => void;
}) {
  const write = (next: DesignFoundation): void => onChange(editedStep(next, step));
  const readOnlyReason = editable ? undefined : "This revision is read-only here.";

  switch (step) {
    case "principles":
      return <LineList values={foundation.principles} editable={editable} label="Principle" onChange={(principles) => write({ ...foundation, principles })} />;
    case "primitive_tokens":
      return <FoundationTokenEditor foundation={foundation} readOnlyReason={readOnlyReason} {...(editable ? { onChange: write } : {})} />;
    case "semantic_tokens":
      return <FoundationTokenEditor foundation={foundation} readOnlyReason={readOnlyReason} {...(editable ? { onChange: write } : {})} />;
    case "type_scale":
      return (
        <TypeScaleEditor
          scale={foundation.typeScale ?? []}
          editable={editable}
          floor={foundation.accessibility?.minFontPx ?? 12}
          onChange={(typeScale) => write({ ...foundation, typeScale })}
        />
      );
    case "space_radius_shadow_z":
      return (
        <div className="flex flex-col gap-3">
          {(["spacing", "radius", "shadow", "zIndex"] as const).map((family) => (
            <ScaleEditor
              key={family}
              label={family === "zIndex" ? "Depth" : family[0]!.toUpperCase() + family.slice(1)}
              steps={foundation.scales?.[family] ?? []}
              editable={editable}
              onChange={(steps) => write({ ...foundation, scales: { ...(foundation.scales ?? {}), [family]: steps } })}
            />
          ))}
        </div>
      );
    case "motion":
      return (
        <div className="flex flex-col gap-3">
          <ScaleEditor
            label="Durations"
            steps={foundation.motion?.durations ?? []}
            editable={editable}
            onChange={(durations) => write({ ...foundation, motion: { durations, easings: foundation.motion?.easings ?? [], reducedMotion: foundation.motion?.reducedMotion ?? "" } })}
          />
          <ScaleEditor
            label="Easings"
            steps={foundation.motion?.easings ?? []}
            editable={editable}
            onChange={(easings) => write({ ...foundation, motion: { durations: foundation.motion?.durations ?? [], easings, reducedMotion: foundation.motion?.reducedMotion ?? "" } })}
          />
          <Field
            label="Reduced motion"
            value={foundation.motion?.reducedMotion ?? ""}
            editable={editable}
            onChange={(reducedMotion) =>
              write({ ...foundation, motion: { durations: foundation.motion?.durations ?? [], easings: foundation.motion?.easings ?? [], reducedMotion } })
            }
          />
        </div>
      );
    case "icon_and_asset_sources":
      return (
        <ul className="flex flex-col gap-1.5">
          {(foundation.sources ?? []).map((source) => (
            <li key={source.id} data-slot="foundation-source" className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1.5">
              <span className="min-w-0 truncate text-xs leading-xs text-ink">{source.name}</span>
              {source.version ? <span className="typed text-ink-3">{source.version}</span> : null}
              <Badge variant={source.recommended ? "ok" : source.licence.classification === "unknown" ? "attention" : "outline"}>
                {source.licence.spdx ?? source.licence.name ?? source.licence.classification}
              </Badge>
              <span className="min-w-0 flex-1 text-xs leading-4 text-ink-3">{source.reason}</span>
              {editable ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${source.name}`}
                  onClick={() => write({ ...foundation, sources: (foundation.sources ?? []).filter((candidate) => candidate.id !== source.id) })}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
          {(foundation.sources ?? []).length === 0 ? <li className="text-xs leading-4 text-ink-3">No sources proposed.</li> : null}
          <li className="text-xs leading-4 text-ink-3">
            A source is added by asking for it in the chat: its licence is read and classified there, and one nobody declared a licence for is never recommended.
          </li>
        </ul>
      );
    case "layout_rules":
      return <LineList values={foundation.layoutRules ?? []} editable={editable} label="Rule" onChange={(layoutRules) => write({ ...foundation, layoutRules })} />;
    case "accessibility_floor":
      return (
        <div className="flex flex-col gap-2">
          <Field
            label="Minimum contrast"
            value={String(foundation.accessibility?.contrastMin ?? 4.5)}
            editable={editable}
            onChange={(value) => {
              const contrastMin = Number.parseFloat(value);
              if (!Number.isFinite(contrastMin)) return;
              write({ ...foundation, accessibility: { ...floor(foundation), contrastMin } });
            }}
          />
          <Field
            label="Smallest text (px)"
            value={String(foundation.accessibility?.minFontPx ?? 12)}
            editable={editable}
            onChange={(value) => {
              const minFontPx = Number.parseInt(value, 10);
              if (!Number.isFinite(minFontPx)) return;
              write({ ...foundation, accessibility: { ...floor(foundation), minFontPx } });
            }}
          />
          <Field label="Focus" value={foundation.accessibility?.focusVisible ?? ""} editable={editable} onChange={(focusVisible) => write({ ...foundation, accessibility: { ...floor(foundation), focusVisible } })} />
          <LineList
            values={foundation.accessibility?.rules ?? []}
            editable={editable}
            label="Rule"
            onChange={(rules) => write({ ...foundation, accessibility: { ...floor(foundation), rules } })}
          />
        </div>
      );
    case "component_contracts":
      return <ComponentList components={foundation.components ?? []} editable={editable} onChange={(components) => write({ ...foundation, components })} />;
    default:
      return null;
  }
}

function floor(foundation: DesignFoundation): NonNullable<DesignFoundation["accessibility"]> {
  return (
    foundation.accessibility ?? {
      contrastMin: 4.5,
      minFontPx: 12,
      focusVisible: "",
      rules: [],
    }
  );
}

function Field({ label, value, editable, onChange }: { label: string; value: string; editable: boolean; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2">
      <span className="w-40 shrink-0 text-xs leading-xs text-ink-2">{label}</span>
      <input
        value={value}
        disabled={!editable}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs leading-4 text-ink outline-none disabled:opacity-60 focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25"
      />
    </label>
  );
}

function LineList({ values, editable, label, onChange }: { values: readonly string[]; editable: boolean; label: string; onChange: (values: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            value={value}
            disabled={!editable}
            aria-label={`${label} ${String(index + 1)}`}
            onChange={(event) => onChange(values.map((current, at) => (at === index ? event.target.value : current)))}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs leading-4 text-ink outline-none disabled:opacity-60 focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25"
          />
          {editable ? (
            <Button size="xs" variant="ghost" aria-label={`Remove ${label.toLowerCase()} ${String(index + 1)}`} onClick={() => onChange(values.filter((_current, at) => at !== index))}>
              <Trash2 />
            </Button>
          ) : null}
        </div>
      ))}
      {editable ? (
        <Button size="xs" variant="ghost" className="self-start" onClick={() => onChange([...values, ""])}>
          <Plus />
          Add {label.toLowerCase()}
        </Button>
      ) : null}
    </div>
  );
}

function ScaleEditor({ label, steps, editable, onChange }: { label: string; steps: readonly FoundationScaleStep[]; editable: boolean; onChange: (steps: FoundationScaleStep[]) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <h5 className="typed text-ink-2">{label}</h5>
      {steps.map((step, index) => (
        <div key={`${step.name}-${String(index)}`} className="flex flex-wrap items-center gap-2">
          <span className="typed w-24 shrink-0 truncate text-ink-3">{step.name}</span>
          <input
            value={step.value}
            disabled={!editable}
            aria-label={`${label} ${step.name}`}
            onChange={(event) => onChange(steps.map((current, at) => (at === index ? { ...current, value: event.target.value } : current)))}
            className="w-40 rounded-md border border-line bg-surface px-2 py-1 text-xs leading-4 text-ink outline-none disabled:opacity-60 focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25"
          />
          {step.description ? <span className="min-w-0 flex-1 truncate text-xs leading-4 text-ink-3">{step.description}</span> : null}
        </div>
      ))}
      {steps.length === 0 ? <p className="text-xs leading-4 text-ink-3">Nothing proposed for this yet.</p> : null}
    </div>
  );
}

function TypeScaleEditor({
  scale,
  editable,
  floor: minimum,
  onChange,
}: {
  scale: readonly FoundationTypeStep[];
  editable: boolean;
  floor: number;
  onChange: (scale: FoundationTypeStep[]) => void;
}) {
  return (
    <div role="group" aria-label="Type scale" className="flex flex-col gap-1.5">
      {scale.map((step, index) => {
        const px = Number.parseFloat(step.size);
        const tooSmall = Number.isFinite(px) && step.size.trim().endsWith("px") && px < minimum;
        return (
          <div key={`${step.name}-${String(index)}`} className="flex flex-wrap items-center gap-2">
            <span className="typed w-24 shrink-0 truncate text-ink-3">{step.name}</span>
            <input
              value={step.size}
              disabled={!editable}
              aria-label={`${step.name} size`}
              onChange={(event) => onChange(scale.map((current, at) => (at === index ? { ...current, size: event.target.value } : current)))}
              className={cn(
                "w-24 rounded-md border bg-surface px-2 py-1 text-xs leading-4 text-ink outline-none disabled:opacity-60 focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
                tooSmall ? "border-danger" : "border-line",
              )}
            />
            <input
              value={step.lineHeight ?? ""}
              disabled={!editable}
              aria-label={`${step.name} line height`}
              onChange={(event) => onChange(scale.map((current, at) => (at === index ? { ...current, lineHeight: event.target.value } : current)))}
              className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-xs leading-4 text-ink outline-none disabled:opacity-60 focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25"
            />
            <span className={cn("min-w-0 flex-1 truncate text-xs leading-4", tooSmall ? "text-danger" : "text-ink-3")}>
              {tooSmall ? `below the ${String(minimum)}px floor this foundation set` : (step.usage ?? "")}
            </span>
          </div>
        );
      })}
      {scale.length === 0 ? <p className="text-xs leading-4 text-ink-3">No type scale proposed yet.</p> : null}
    </div>
  );
}

function ComponentList({
  components,
  editable,
  onChange,
}: {
  components: readonly FoundationComponentContract[];
  editable: boolean;
  onChange: (components: FoundationComponentContract[]) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {components.map((component, index) => (
        <li key={component.name} data-slot="foundation-component" className="flex flex-col gap-1 rounded-md border border-line px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs leading-xs font-medium text-ink">{component.name}</span>
            {component.variants.map((variant) => (
              <Badge key={variant} variant="outline">
                {variant}
              </Badge>
            ))}
          </div>
          <input
            value={component.purpose}
            disabled={!editable}
            aria-label={`${component.name} purpose`}
            onChange={(event) => onChange(components.map((current, at) => (at === index ? { ...current, purpose: event.target.value } : current)))}
            className="rounded-md border border-line bg-surface px-2 py-1 text-xs leading-4 text-ink outline-none disabled:opacity-60 focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25"
          />
          {component.states && component.states.length > 0 ? <span className="text-xs leading-4 text-ink-3">States: {component.states.join(", ")}</span> : null}
          {component.accessibility ? <span className="text-xs leading-4 text-ink-3">{component.accessibility}</span> : null}
        </li>
      ))}
      {components.length === 0 ? <li className="text-xs leading-4 text-ink-3">No component contracts proposed yet.</li> : null}
    </ul>
  );
}
