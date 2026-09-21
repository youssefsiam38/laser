/**
 * Storing a verification report, and the one move it is allowed to make
 * (M21-T19).
 *
 * The report is written the way every other piece of project evidence is: a
 * canonical blob, and an evidence record joined to the **exact revision** it
 * was produced against, with kind `verification`. It is not a side table and
 * it is not a log line, because a person reading a Task a month later has to
 * be able to see what was checked, against which revisions, and what was left
 * to them.
 *
 * The only state change a report may cause is `in_progress → needs_review`,
 * and only when everything the run could decide came out satisfied and nothing
 * blocks. Nothing here can reach `done`: "verification produces evidence but
 * does not invent approval" (leap, "Lifecycle and gates"), and `done` is the
 * person's or an explicitly approved policy's.
 */
import {
  VERIFICATION_REPORT_MEDIA_TYPE,
  verificationSummary,
  type ProjectWorkEvidence,
  type ProjectWorkOrigin,
  type VerificationCommandRun,
  type VerificationDeviation,
  type VerificationPlan,
  type VerificationReport,
} from "@lasercode/protocol";
import type { ProjectWorkStore } from "../store.js";
import type { Evaluation } from "./evaluate.js";

export interface StoreReportInput {
  store: ProjectWorkStore;
  projectId: string;
  entityId: string;
  /** The Task revision the report is fenced to. */
  expectedRevisionId: string;
  plan: VerificationPlan;
  evaluation: Evaluation;
  commands: readonly VerificationCommandRun[];
  deviations: readonly VerificationDeviation[];
  runId: string;
  startedAt: string;
  endedAt: string;
  stopped?: { reason: string };
  origin: ProjectWorkOrigin;
  idempotencyKey: string;
}

export interface StoredReport {
  report: VerificationReport;
  evidence: ProjectWorkEvidence;
  blobId: string;
  seq: number;
}

/** Build the canonical report from the plan, the runs and the evaluation. */
export function buildReport(input: {
  plan: VerificationPlan;
  evaluation: Evaluation;
  commands: readonly VerificationCommandRun[];
  deviations: readonly VerificationDeviation[];
  runId: string;
  startedAt: string;
  endedAt: string;
  stopped?: { reason: string };
}): VerificationReport {
  const withoutSummary: Omit<VerificationReport, "summary"> = {
    version: 1,
    runId: input.runId,
    task: input.plan.task,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    ...(input.stopped ? { stopped: input.stopped } : {}),
    authorities: input.plan.authorities,
    criteria: input.plan.criteria,
    commands: [...input.commands],
    findings: input.evaluation.findings,
    deviations: [...input.deviations],
    blockers: input.evaluation.blockers,
    personDecisions: input.evaluation.personDecisions,
    converged: input.evaluation.converged,
    outcome: input.evaluation.outcome,
    truncated: input.plan.truncated,
  };
  return { ...withoutSummary, summary: verificationSummary(withoutSummary) };
}

/**
 * The record a report becomes.
 *
 * `role` is `acceptance` only for a run that converged: acceptance evidence is
 * what a `done` may later rest on, and a run with a failure, a blocker or an
 * unfinished command has not earned it. Everything else is `supporting`, which
 * is still evidence and still readable — a failed run is evidence, not a
 * failed task (M21-T15).
 */
export function storeReport(input: StoreReportInput): StoredReport {
  const report = buildReport(input);
  const bytes = Buffer.from(JSON.stringify(report), "utf8");
  const blob = input.store.putBlob({
    projectId: input.projectId,
    entityId: input.entityId,
    mediaType: VERIFICATION_REPORT_MEDIA_TYPE,
    data: bytes,
  });
  const outcome = report.converged ? "passed" : report.outcome === "failed" ? "failed" : "inconclusive";
  const written = input.store.link({
    projectId: input.projectId,
    expectedRevisionId: input.expectedRevisionId,
    link: {
      type: "evidence",
      entityId: input.entityId,
      // The exact revision this run checked. A report is about one revision of
      // one Task, for ever, however the Task moves afterwards.
      revisionId: input.expectedRevisionId,
      kind: "verification",
      role: report.converged ? "acceptance" : "supporting",
      summary: `Verification: ${report.summary}`,
      detail: reportDetail(report),
      blobId: blob.blobId,
      outcome,
    },
    origin: input.origin,
    idempotencyKey: input.idempotencyKey,
  });
  if (written.link.type !== "evidence") {
    throw new Error("a verification report was stored as something other than evidence");
  }
  return { report, evidence: written.link.evidence, blobId: blob.blobId, seq: written.seq };
}

/**
 * The bounded line under the summary: which authorities, and what is left.
 *
 * Never the command output and never a criterion's prose — the whole report is
 * in the blob, and this is what a list row can afford to show.
 */
function reportDetail(report: VerificationReport): string {
  const authorities = report.authorities.map((source) => `${source.key}@${source.revisionId}`).join(", ");
  const decisions = report.personDecisions.length;
  const deviations = report.deviations.length;
  const parts = [`against ${authorities}`];
  if (decisions > 0) parts.push(`${String(decisions)} for you to decide`);
  if (deviations > 0) parts.push(`${String(deviations)} deviation${deviations === 1 ? "" : "s"} proposed`);
  if (report.stopped) parts.push(`stopped: ${report.stopped.reason}`);
  return parts.join(" · ").slice(0, 4000);
}

/**
 * The one move a report may make.
 *
 * A Task that is being worked on and has converged goes to `needs_review`,
 * carrying the report as the evidence the move rests on. Anything else stays
 * exactly where it is — a blocked or failed run leaves a Task `in_progress`
 * with a report that names what blocks it, which is the honest answer and the
 * one the leap asks for.
 */
export function convergeTask(input: {
  store: ProjectWorkStore;
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  evidenceId: string;
  report: VerificationReport;
  origin: ProjectWorkOrigin;
  idempotencyKey: string;
}): { from: string; to: string; state: string } | undefined {
  if (!input.report.converged) return undefined;
  const entity = input.store.get({ projectId: input.projectId, entityId: input.entityId, body: { mode: "none" } }).entity;
  if (entity.state !== "in_progress") return undefined;
  try {
    const moved = input.store.taskAction({
      projectId: input.projectId,
      entityId: input.entityId,
      expectedRevisionId: input.expectedRevisionId,
      action: "submit_for_review",
      evidenceId: input.evidenceId,
      note: input.report.summary,
      origin: input.origin,
      idempotencyKey: `${input.idempotencyKey}-needs-review`,
    });
    return { from: moved.transition.from, to: moved.transition.to, state: moved.entity.state };
  } catch {
    // The report is stored and is the point; a Task the engine will not move
    // right now keeps its state and its report, and the report says why.
    return undefined;
  }
}
