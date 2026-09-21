"use client";
/**
 * The gate card (M21-T8, D-332, leap "Lifecycle and gates").
 *
 * One card per Spec lifecycle, drawn wherever the person is: on the Spec, on
 * the Design its design gate is decided on, on the Plan its build gate is
 * decided on. It answers four questions and nothing else:
 *
 *   which gate is next · what it still needs · exactly what a decision would
 *   cover · and what each outcome means.
 *
 * Two rules are structural rather than decorative:
 *
 * - **Approve is disabled while anything is outstanding**, with the host's own
 *   sentence underneath saying which blocking comment or which missing input.
 *   The card never invents a reason and never hides the button.
 * - **Enter never approves.** The decision needs an outcome chosen *and* the
 *   key typed into a field that swallows Enter, and the control that takes
 *   focus is never the one that acts.
 *
 * A Spec that never opted into the gated path shows the one line that says so
 * and the way in — nothing here is pending because a gate exists (D-352).
 */
import { ShieldCheck, ShieldQuestionMark, CircleCheck, CircleDashed, CircleAlert, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalGate, ApprovalMode, ClientRequests, GateOutcome, GateReport, GateStatusReport } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { dateTime } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { selectWork, type ProjectWorkStore } from "@/project-work";
import { GATE_LABEL, GATE_PURPOSE, GATE_ROLE_LABEL, MODE_DETAIL, MODE_LABEL, approvalPhrase, focusedGate, gateOf, isDecidable } from "@/project-work/review";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { Section } from "./bodies/fields.js";
import { WorkRefusal } from "./states.js";

type Detail = ClientRequests["project/work/get"]["result"];

const STATE_LABEL: Readonly<Record<GateStatusReport["state"], string>> = {
  not_applicable: "Not used",
  waiting: "Waiting on the work",
  ready: "Waiting on you",
  approved: "Approved",
  changes_requested: "Changes requested",
  invalidated: "Needs deciding again",
  archived: "Archived",
};

export function GateCard({ store, detail, onChanged }: { store: ProjectWorkStore | undefined; detail: Detail; onChanged: () => void }) {
  const report = detail.gates;
  const [chosen, setChosen] = useState<ApprovalGate | undefined>(undefined);
  const gate = useMemo(() => (chosen ? gateOf(report, chosen) : focusedGate(report)) ?? focusedGate(report), [chosen, report]);

  if (!report) {
    return (
      <Section title="Gate">
        <p className="text-sm leading-5 text-ink-3">
          Nothing here is on a gated path. Gates belong to a spec that was put through them; work with no gate waits on no one.
        </p>
      </Section>
    );
  }

  return (
    <Section title="Gate">
      {!report.gated ? (
        <UngatedNotice store={store} detail={detail} report={report} onChanged={onChanged} />
      ) : (
        <>
          <div role="tablist" aria-label="The three gates" className="flex flex-wrap gap-1">
            {report.gates.map((candidate) => (
              <button
                key={candidate.gate}
                type="button"
                role="tab"
                aria-selected={candidate.gate === gate?.gate}
                data-gate={candidate.gate}
                data-state={candidate.state}
                onClick={() => setChosen(candidate.gate)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs leading-xs outline-none",
                  "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                  candidate.gate === gate?.gate ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
                )}
              >
                <GateIcon state={candidate.state} />
                {GATE_LABEL[candidate.gate]}
              </button>
            ))}
          </div>
          {gate ? <GateBody store={store} detail={detail} report={report} gate={gate} onChanged={onChanged} /> : null}
        </>
      )}
    </Section>
  );
}

function GateIcon({ state }: { state: GateStatusReport["state"] }) {
  if (state === "approved") return <CircleCheck aria-hidden="true" className="size-3.5 text-ok" />;
  if (state === "ready" || state === "invalidated") return <CircleAlert aria-hidden="true" className="size-3.5 text-attention" />;
  return <CircleDashed aria-hidden="true" className="size-3.5 text-ink-3" />;
}

/** The one line an ungated spec gets, and the deliberate way onto the path. */
function UngatedNotice({
  store,
  detail,
  report,
  onChanged,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  report: GateReport;
  onChanged: () => void;
}) {
  const { actions } = useLaserStable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const isSpec = detail.entity.kind === "spec";
  const body = detail.body?.body;

  const enterGatedPath = async (): Promise<void> => {
    if (!store || !body || body.kind !== "spec") return;
    setBusy(true);
    setError(undefined);
    const outcome = await store.revise(
      { entityId: detail.entity.entityId, expectedRevisionId: detail.entity.currentRevisionId },
      { kind: "spec", spec: { ...body.spec, gated: true } },
      { note: "Put on the gated path: brief, design and build approvals." },
    );
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    actions.toast("info", `${detail.entity.key} is on the gated path`);
    onChanged();
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
      <span className="flex items-center gap-2 text-sm leading-5 text-ink">
        <ShieldQuestionMark aria-hidden="true" className="size-3.5 text-ink-3" />
        {report.specKey} is not on the gated path
      </span>
      <p className="text-xs leading-xs text-ink-2">
        Gates are only used when a spec is run through them. Put it on the gated path and it gains three approvals — brief, design and build — each
        binding the exact revisions it covers.
      </p>
      {error ? <WorkRefusal message={error} /> : null}
      {isSpec ? (
        <div>
          <Button size="xs" variant="outline" data-slot="enter-gated-path" disabled={busy || !store || body?.kind !== "spec"} onClick={() => void enterGatedPath()}>
            <ShieldCheck />
            Run it through the gates
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="self-start text-xs leading-xs text-ink-2 underline underline-offset-2 hover:text-ink"
          onClick={() => selectWork({ entityId: report.specEntityId, kind: "spec" })}
        >
          Open {report.specKey}
        </button>
      )}
    </div>
  );
}

function GateBody({
  store,
  detail,
  report,
  gate,
  onChanged,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  report: GateReport;
  gate: GateStatusReport;
  onChanged: () => void;
}) {
  const { actions } = useLaserStable();
  const [outcomeId, setOutcomeId] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const askRef = useRef<HTMLButtonElement>(null);
  const subject = gate.subject;
  const phrase = approvalPhrase(gate);
  const outcome = gate.outcomes.find((candidate) => candidate.id === outcomeId);
  const onSubject = subject !== undefined && subject.entityId === detail.entity.entityId;

  // A different gate, a different decision: never carry a typed confirmation
  // from one gate to the next.
  useEffect(() => {
    setOutcomeId(undefined);
    setTyped("");
    setNote("");
    setError(undefined);
  }, [gate.gate, subject?.revisionId]);

  const decide = async (): Promise<void> => {
    if (!store || !subject || !outcome) return;
    if (outcome.approves && typed.trim() !== phrase) return;
    setBusy(true);
    setError(undefined);
    const result = await store.approve(
      { entityId: subject.entityId, expectedRevisionId: subject.revisionId },
      {
        gate: gate.gate,
        decision: outcome.decision,
        covers: outcome.approves ? gate.covers.slice() : [{ entityId: subject.entityId, kind: subject.kind, key: subject.key, revisionId: subject.revisionId, digest: subject.digest }],
        ...(outcome.mode ? { mode: outcome.mode as ApprovalMode } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.failure.message);
      return;
    }
    actions.toast("info", `${GATE_LABEL[gate.gate]} gate · ${outcome.label.toLowerCase()} on ${subject.key}`);
    setOutcomeId(undefined);
    setTyped("");
    setNote("");
    onChanged();
  };

  const askForDecision = async (): Promise<void> => {
    if (!store || !subject) return;
    setBusy(true);
    setError(undefined);
    const result = await store.review({ entityId: subject.entityId, expectedRevisionId: subject.revisionId }, "request_review");
    setBusy(false);
    if (!result.ok) {
      setError(result.failure.message);
      return;
    }
    onChanged();
  };

  const draftSubject = subject !== undefined && subject.state === "draft";

  return (
    <div data-slot="gate-card" data-gate={gate.gate} data-state={gate.state} className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm leading-5 font-medium text-ink">
          {GATE_LABEL[gate.gate]} gate
        </span>
        <Badge variant={gate.state === "approved" ? "ok" : gate.state === "ready" || gate.state === "invalidated" ? "attention" : "outline"}>
          {STATE_LABEL[gate.state]}
        </Badge>
        {report.next === gate.gate ? <span className="text-xs leading-xs text-ink-3">next</span> : null}
      </div>
      <p className="text-xs leading-xs text-ink-2">{GATE_PURPOSE[gate.gate]}</p>

      {subject ? (
        <button
          type="button"
          data-slot="gate-subject"
          onClick={() => selectWork({ entityId: subject.entityId, kind: subject.kind, revisionId: subject.revisionId })}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start outline-none",
            "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
          )}
        >
          <TypeBadge kind={subject.kind} />
          <KeyTag workKey={subject.key} />
          <span className="min-w-0 truncate text-sm leading-5 text-ink-2">{subject.title}</span>
        </button>
      ) : null}

      <ul role="list" data-slot="gate-requirements" className="flex flex-col gap-1">
        {gate.requirements.map((requirement, index) => (
          <li key={`${requirement.role}-${index}`} className="flex min-w-0 items-start gap-2">
            {requirement.satisfied ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ok" />
            ) : (
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-attention" />
            )}
            <span className="min-w-0 text-xs leading-xs text-ink-2">
              <span className="font-medium text-ink">{GATE_ROLE_LABEL[requirement.role]}</span> · {requirement.detail}
            </span>
          </li>
        ))}
      </ul>

      {gate.covers.length > 0 ? (
        <details data-slot="gate-covers" className="text-xs leading-xs text-ink-2">
          <summary className="cursor-pointer text-ink-3">
            What this decision records: {gate.covers.length} revision{gate.covers.length === 1 ? "" : "s"}, by digest
          </summary>
          <ul role="list" className="mt-1 flex flex-col gap-0.5">
            {gate.covers.map((covered) => (
              <li key={covered.revisionId} className="flex min-w-0 items-center gap-2">
                <KeyTag workKey={covered.key} />
                <span className="typed min-w-0 truncate text-ink-3">{covered.digest.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {gate.blockingComments.length > 0 ? (
        <div data-slot="gate-blocked" role="status" className="flex flex-col gap-1 rounded-md border border-attention/40 bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] p-2">
          <span className="text-xs leading-xs font-medium text-attention">
            {gate.blockingComments.length} blocking comment{gate.blockingComments.length === 1 ? "" : "s"} to resolve first
          </span>
          <ul role="list" className="flex flex-col gap-0.5">
            {gate.blockingComments.map((comment) => (
              <li key={comment.commentId} className="flex min-w-0 items-center gap-1.5 text-xs leading-xs text-ink-2">
                <KeyTag workKey={comment.key} />
                <span className="min-w-0 truncate">{comment.excerpt}</span>
                {comment.orphaned ? <Badge variant="outline">anchor gone</Badge> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {gate.approval ? (
        <p className="text-xs leading-xs text-ink-3">
          {gate.approval.decision === "approved" ? "Approved" : gate.approval.decision === "archived" ? "Archived" : "Changes requested"} by{" "}
          {gate.approval.origin.actor.label} · {dateTime(gate.approval.at)}
          {gate.approval.mode ? ` · ${MODE_LABEL[gate.approval.mode]}` : ""}
          {gate.approval.invalidatedAt ? " · something it covered has changed since" : ""}
        </p>
      ) : null}

      {error ? <WorkRefusal message={error} /> : null}

      {!onSubject && subject ? (
        <p className="text-xs leading-xs text-ink-3">This gate is decided on {subject.key}. Open it to take the decision.</p>
      ) : draftSubject ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs leading-xs text-ink-2">{gate.refusal}</p>
          <div>
            <Button ref={askRef} size="xs" variant="outline" data-slot="ask-for-decision" disabled={busy || !store} onClick={() => void askForDecision()}>
              <Send />
              Ask for a decision
            </Button>
          </div>
        </div>
      ) : gate.state === "approved" ? (
        <p className="text-xs leading-xs text-ink-3">Nothing to do here. A change to anything it covers brings this gate back.</p>
      ) : subject ? (
        <Decision
          gate={gate}
          phrase={phrase}
          typed={typed}
          note={note}
          busy={busy}
          store={store !== undefined}
          outcome={outcome}
          onOutcome={setOutcomeId}
          onTyped={setTyped}
          onNote={setNote}
          onDecide={() => void decide()}
        />
      ) : (
        <p className="text-xs leading-xs text-ink-2">{gate.refusal}</p>
      )}
    </div>
  );
}

/** Pick an outcome, say why if it is a change request, type the key to approve. */
function Decision({
  gate,
  phrase,
  typed,
  note,
  busy,
  store,
  outcome,
  onOutcome,
  onTyped,
  onNote,
  onDecide,
}: {
  gate: GateStatusReport;
  phrase: string;
  typed: string;
  note: string;
  busy: boolean;
  store: boolean;
  outcome: GateOutcome | undefined;
  onOutcome: (id: string) => void;
  onTyped: (value: string) => void;
  onNote: (value: string) => void;
  onDecide: () => void;
}) {
  const blocked = !isDecidable(gate);
  const approving = outcome?.approves === true;
  const ready = outcome !== undefined && (!approving || typed.trim() === phrase) && (!blocked || !approving);
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={`What to do about the ${gate.gate} gate`} className="flex flex-col gap-1">
        {gate.outcomes.map((candidate) => {
          const disabled = candidate.approves && blocked;
          return (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={outcome?.id === candidate.id}
              aria-disabled={disabled}
              disabled={disabled}
              data-outcome={candidate.id}
              onClick={() => onOutcome(candidate.id)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-start outline-none",
                "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                outcome?.id === candidate.id ? "border-transparent bg-surface-2" : "border-line hover:bg-surface-2",
                disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
              )}
            >
              <span className="text-sm leading-5 text-ink">{candidate.label}</span>
              {candidate.mode ? <span className="text-xs leading-xs text-ink-3">{MODE_DETAIL[candidate.mode]}</span> : null}
            </button>
          );
        })}
      </div>

      {blocked ? (
        <p data-slot="gate-refusal" role="status" className="text-xs leading-xs text-attention">
          {gate.refusal}
        </p>
      ) : null}

      {outcome && !outcome.approves ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs leading-xs text-ink-2">What should change? This is recorded as the request, and never edits the approved bytes.</span>
          <Textarea value={note} rows={2} aria-label="What should change" onChange={(event) => onNote(event.target.value)} />
        </label>
      ) : null}

      {approving ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs leading-xs text-ink-2">
            Type <span className="typed text-ink">{phrase}</span> to approve. Enter never approves.
          </span>
          <Input
            value={typed}
            onChange={(event) => onTyped(event.target.value)}
            // Enter is not a decision: the field swallows it, here as in every
            // other confirmation in the workspace.
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={phrase}
            aria-label={`Type ${phrase} to approve`}
            autoComplete="off"
            disabled={blocked}
          />
        </label>
      ) : null}

      <div>
        <Button size="xs" data-slot="record-decision" disabled={busy || !store || !ready} onClick={onDecide}>
          <ShieldCheck />
          {outcome ? outcome.label : "Record a decision"}
        </Button>
      </div>
    </div>
  );
}
