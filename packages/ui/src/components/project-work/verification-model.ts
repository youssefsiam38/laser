/**
 * Reading a verification report in this window (M21-T19).
 *
 * The report is a stored document, not a derived view: it is written once, at
 * exact revisions, and read back exactly as it was written. Everything here is
 * pure — finding the record, decoding the blob, grouping the findings — so the
 * component stays about what a person sees.
 */
import {
  VERIFICATION_REPORT_MEDIA_TYPE,
  verificationReportSchema,
  type ClientRequests,
  type ProjectWorkEvidence,
  type VerificationAuthority,
  type VerificationCriterion,
  type VerificationFinding,
  type VerificationOutcome,
  type VerificationReport,
} from "@lasercode/protocol";

type Detail = ClientRequests["project/work/get"]["result"];
type BlobPage = ClientRequests["project/work/blob/read"]["result"];

/** The newest verification report recorded on this entity, if there is one. */
export function latestVerification(detail: Detail): ProjectWorkEvidence | undefined {
  return [...detail.evidence]
    .filter((record) => record.kind === "verification" && record.blobId !== undefined)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
}

/**
 * The report a blob page holds.
 *
 * A page that was released, cut short or is not a report at all returns
 * nothing: a partial report shown as a whole one would be the one thing this
 * surface must never do.
 */
export function reportFrom(page: BlobPage): VerificationReport | undefined {
  if (page.data === undefined || page.released) return undefined;
  if (page.mediaType !== VERIFICATION_REPORT_MEDIA_TYPE) return undefined;
  if (page.nextOffset !== undefined) return undefined;
  try {
    const parsed = verificationReportSchema.safeParse(JSON.parse(decode(page.data)));
    return parsed.success ? (parsed.data as VerificationReport) : undefined;
  } catch {
    return undefined;
  }
}

function decode(base64: string): string {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

export const VERIFICATION_OUTCOME_LABEL: Readonly<Record<VerificationOutcome, string>> = {
  satisfied: "Satisfied",
  failed: "Failed",
  needs_person: "Waiting on you",
  not_machine_verifiable: "Not checkable here",
};

export const VERIFICATION_AUTHORITY_LABEL: Readonly<Record<VerificationAuthority, string>> = {
  spec: "Spec",
  design: "Design",
  plan: "Plan",
  task: "Task",
};

/** One row a person reads: the criterion, its outcome and what said so. */
export interface VerificationRow {
  criterion: VerificationCriterion;
  finding: VerificationFinding;
}

/**
 * The findings, grouped by outcome in the order the report is read in:
 * what failed, what is yours, what nothing here can decide, what passed.
 */
export function rowsByOutcome(report: VerificationReport): Array<{ outcome: VerificationOutcome; rows: VerificationRow[] }> {
  const byId = new Map(report.criteria.map((criterion) => [criterion.id, criterion]));
  const order: VerificationOutcome[] = ["failed", "needs_person", "not_machine_verifiable", "satisfied"];
  return order
    .map((outcome) => ({
      outcome,
      rows: report.findings
        .filter((finding) => finding.outcome === outcome)
        .flatMap((finding) => {
          const criterion = byId.get(finding.criterionId);
          return criterion ? [{ criterion, finding }] : [];
        }),
    }))
    .filter((group) => group.rows.length > 0);
}

/** The browser-matrix items, which are always a person's and never an agent's. */
export function matrixRows(report: VerificationReport): VerificationRow[] {
  return rowsByOutcome(report)
    .flatMap((group) => group.rows)
    .filter((row) => row.criterion.kind === "browser_matrix");
}

/** The one sentence the panel's live region says while a run is going. */
export function progressSentence(run: { line: string; phase: string } | undefined): string {
  if (!run) return "";
  return run.line;
}

/**
 * The conversation a person's verification run would belong to (M21-T19).
 *
 * A verification run is a Command: it appears in the fleet under a session and
 * is stopped from there, so it has to have one. The honest answer is the
 * conversation this Task is already being worked on in — its newest attempt
 * that this window still has a session for, preferring one that is still
 * running. When there is none the panel hands the person to Start…, which is
 * the existing act that joins a Task to a conversation; nothing here invents
 * a session, and no run starts without a row.
 */
export function verificationSessionFor(
  detail: Detail,
  sessions: ReadonlyArray<{ id: string; path: string }>,
): { sessionId: string; path: string } | undefined {
  const byId = new Map(sessions.map((session) => [session.id, session.path]));
  const candidates = detail.executionLinks
    .filter((link) => link.targetUnavailable !== true && byId.has(link.targetId))
    .sort((a, b) => (a.endedAt === undefined ? -1 : 0) - (b.endedAt === undefined ? -1 : 0) || b.attempt - a.attempt);
  const chosen = candidates[0];
  return chosen ? { sessionId: chosen.targetId, path: byId.get(chosen.targetId)! } : undefined;
}
