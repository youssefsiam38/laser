"use client";
/**
 * A verification report, as a person reads it (M21-T19).
 *
 * The leap fixes what it has to say: "the final report lists satisfied
 * criteria, deviations with reasons, evidence links and remaining person
 * decisions". So that is the order, and each part is a real heading over a
 * real list — headings a screen reader can jump between, lists it can count,
 * and no table of shorthand that only makes sense next to the code.
 *
 * Two things are deliberately plain rather than clever:
 *
 * - **What failed comes first**, then what is waiting on the person, then what
 *   nothing here can decide, then what passed. A report is read to find out
 *   what is left.
 * - **A browser-matrix item shows its steps**, because an agent never walked
 *   it and never will (D-342). The steps are the whole of the answer.
 */
import { CheckCircle2, CircleDashed, TriangleAlert, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import type { VerificationDeviation, VerificationOutcome, VerificationReport } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateTime, relativeTime } from "@/format";
import { selectWork } from "@/project-work";

import { KeyTag } from "./KindBadge.js";
import { Section } from "./bodies/fields.js";
import {
  VERIFICATION_AUTHORITY_LABEL,
  VERIFICATION_OUTCOME_LABEL,
  rowsByOutcome,
  type VerificationRow,
} from "./verification-model.js";

export function VerificationReportView({
  report,
  onAcceptDeviation,
  busy = false,
}: {
  report: VerificationReport;
  onAcceptDeviation?: (deviation: VerificationDeviation) => void;
  busy?: boolean;
}) {
  const groups = rowsByOutcome(report);
  return (
    <div data-slot="verification-report" className="flex flex-col gap-4">
      <p className="flex flex-wrap items-center gap-1.5 text-sm leading-5 text-ink-2">
        <Badge variant={report.converged ? "ok" : report.outcome === "failed" ? "danger" : "attention"}>
          {report.converged ? "converged" : report.outcome}
        </Badge>
        <span className="min-w-0">{report.summary}</span>
        <span className="ms-auto text-xs leading-xs text-ink-3" title={dateTime(report.endedAt)}>
          {relativeTime(report.endedAt)}
        </span>
      </p>

      {report.stopped ? (
        <p role="status" className="text-sm leading-5 text-ink-2">
          This run was stopped: {report.stopped.reason}. What it had already checked is below.
        </p>
      ) : null}

      <Section title="Checked against">
        <ul role="list" className="flex flex-col gap-1">
          {report.authorities.map((source) => (
            <li key={`${source.entityId}-${source.revisionId}`} className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm leading-5 text-ink-2">
              <Badge variant="outline">{VERIFICATION_AUTHORITY_LABEL[source.authority]}</Badge>
              <button
                type="button"
                onClick={() => selectWork({ entityId: source.entityId, kind: source.kind })}
                className="rounded px-1 outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              >
                <KeyTag workKey={source.key} />
              </button>
              <span className="min-w-0 truncate">{source.title}</span>
              <span className="typed text-ink-3">at {source.revisionId}</span>
            </li>
          ))}
        </ul>
      </Section>

      {report.blockers.length > 0 ? (
        <Section title="What blocks it">
          <ul role="list" data-slot="verification-blockers" className="flex flex-col gap-1.5">
            {report.blockers.map((blocker, index) => (
              <li key={`${blocker.kind}-${String(index)}`} className="flex min-w-0 items-start gap-2 text-sm leading-5 text-ink-2">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-attention" />
                <span className="min-w-0">{blocker.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {groups.map((group) => (
        <Section key={group.outcome} title={VERIFICATION_OUTCOME_LABEL[group.outcome]}>
          <ul role="list" data-slot={`verification-${group.outcome}`} className="flex flex-col gap-2">
            {group.rows.map((row) => (
              <FindingRow key={row.criterion.id} row={row} outcome={group.outcome} />
            ))}
          </ul>
        </Section>
      ))}

      {report.commands.length > 0 ? (
        <Section title="Commands">
          <ul role="list" data-slot="verification-commands" className="flex flex-col gap-1">
            {report.commands.map((command) => (
              <li key={command.command} className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant={command.status === "passed" ? "ok" : command.status === "failed" ? "danger" : "outline"}>
                  {command.status}
                </Badge>
                <span className="typed min-w-0 break-all text-ink-2">{command.command}</span>
                <span className="text-xs leading-xs text-ink-3">
                  {command.exitCode === undefined ? "no exit code" : `exit ${String(command.exitCode)}`} ·{" "}
                  {String(command.outputBytes)} bytes{command.truncated ? " (tail kept)" : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {report.deviations.length > 0 ? (
        <Section title="Deviations">
          <ul role="list" data-slot="verification-deviations" className="flex flex-col gap-2">
            {report.deviations.map((deviation) => (
              <li key={deviation.id} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <KeyTag workKey={deviation.upstream.key} />
                  <Badge variant={deviation.state === "accepted" ? "ok" : "attention"}>{deviation.state}</Badge>
                </span>
                <span className="text-sm leading-5 text-ink-2">{deviation.reason}</span>
                <span className="text-sm leading-5 text-ink">{deviation.proposal}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => selectWork({ entityId: deviation.upstream.entityId, kind: deviation.upstream.kind })}
                  >
                    Open {deviation.upstream.key}
                  </Button>
                  {deviation.proposedBody && deviation.state === "proposed" && onAcceptDeviation ? (
                    <Button size="xs" disabled={busy} onClick={() => onAcceptDeviation(deviation)}>
                      Accept and revise {deviation.upstream.key}
                    </Button>
                  ) : null}
                </span>
                <span className="text-xs leading-xs text-ink-3">
                  {deviation.proposedBody
                    ? `Accepting writes a new revision of ${deviation.upstream.key} under your name, and marks only the work that depends on it stale.`
                    : `This is a proposal in words. Open ${deviation.upstream.key} to make the change yourself.`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {report.personDecisions.length > 0 ? (
        <Section title="Left to you">
          <ul role="list" data-slot="verification-decisions" className="flex flex-col gap-2">
            {report.personDecisions.map((decision) => (
              <li key={decision.criterionId} className="flex min-w-0 flex-col gap-1">
                <span className="text-sm leading-5 text-ink">{decision.question}</span>
                <ol role="list" className="flex flex-col gap-0.5 ps-4">
                  {decision.steps.map((step, index) => (
                    <li key={`${decision.criterionId}-${String(index)}`} className="list-decimal text-sm leading-5 text-ink-2">
                      {step}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function FindingRow({ row, outcome }: { row: VerificationRow; outcome: VerificationOutcome }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <OutcomeIcon outcome={outcome} />
        <Badge variant="outline">{VERIFICATION_AUTHORITY_LABEL[row.criterion.authority]}</Badge>
        <KeyTag workKey={row.criterion.source.key} />
        <span className="min-w-0 text-sm leading-5 text-ink">{row.criterion.text}</span>
      </span>
      <span className="text-sm leading-5 text-ink-2">{row.finding.detail}</span>
      {row.criterion.command ? <span className="typed break-all text-ink-3">{row.criterion.command}</span> : null}
      {row.finding.steps && row.finding.steps.length > 0 ? (
        <ol role="list" className="mt-0.5 flex flex-col gap-0.5 ps-4">
          {row.finding.steps.map((step, index) => (
            <li key={`${row.criterion.id}-${String(index)}`} className="list-decimal text-sm leading-5 text-ink-2">
              {step}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function OutcomeIcon({ outcome }: { outcome: VerificationOutcome }): ReactNode {
  if (outcome === "satisfied") return <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-ok" />;
  if (outcome === "failed") return <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-danger" />;
  if (outcome === "needs_person") return <UserRound aria-hidden="true" className="size-3.5 shrink-0 text-attention" />;
  return <CircleDashed aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />;
}
