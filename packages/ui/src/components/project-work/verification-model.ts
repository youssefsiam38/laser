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
  repositoryCaptureSchema,
  type RepositoryCapture,
  type RepositoryCaptureHistoryPage,
  type RepositoryLink,
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

// ------------------------------------------------- what a decision rests on

/**
 * One row of the proof trail, as a person reads it (D-363).
 *
 * Two kinds of question share one row shape, because the answer a person
 * wants is the same in both: which evidence, kept when, and is that still
 * what this record points at. `current` is the one thing that must never be
 * implied — a decision's proof is the capture it was made on, and saying it is
 * the record's evidence *today* when the pointer has since moved would be the
 * exact confusion this history exists to prevent.
 */
export interface ProofTrailRow {
  id: string;
  headline: string;
  detail: string;
  /** The capture's own address, shortened for reading; the full one is the title. */
  proof: string;
  proofId: string;
  current: boolean;
}

const DECISION_HEADLINE = {
  approval: "An approval",
  task_completion: "Marked done",
} as const;

const ASSOCIATION_DETAIL = {
  first_capture: "Kept with this record when it was made.",
  gate_preparation: "Kept while a decision was being prepared, which is not a decision that happened.",
  legacy_baseline: "The only evidence this app could attest for this record when it upgraded; what came before it is not known.",
} as const;

/** Which evidence each decision on this item was actually made on. */
export function decisionProofRows(page: RepositoryCaptureHistoryPage, links: readonly RepositoryLink[]): ProofTrailRow[] {
  return page.bindings.map((binding) => {
    const link = links.find((row) => row.linkId === binding.linkId);
    const current = link?.captureBlobId === binding.blobId;
    return {
      id: `${binding.decisionId}-${binding.linkId}`,
      headline: DECISION_HEADLINE[binding.kind],
      detail: current
        ? "Rests on the evidence kept for it, which is still what this record points at."
        : "Rests on the evidence kept for it. This record's evidence has been corrected since, and that correction is not what was decided on.",
      proof: short(binding.blobId),
      proofId: binding.blobId,
      current,
    };
  });
}

/** How the evidence behind this item's repository records changed, newest first. */
export function associationProofRows(page: RepositoryCaptureHistoryPage, links: readonly RepositoryLink[]): ProofTrailRow[] {
  return page.associations.map((association) => {
    const link = links.find((row) => row.linkId === association.linkId);
    const current = link?.captureBlobId === association.blobId;
    return {
      id: association.revisionId,
      headline: link ? repositoryRecordHeadline(link) : "A repository record",
      detail: ASSOCIATION_DETAIL[association.reason],
      proof: short(association.blobId),
      proofId: association.blobId,
      current,
    };
  });
}

function repositoryRecordHeadline(link: RepositoryLink): string {
  const at = "change" in link.target ? link.target.change.head.commitObjectId : link.target.state.commitObjectId;
  return link.relation === "implemented_by" ? `The change delivered at ${short(at)}` : `The state reviewed at ${short(at)}`;
}

function short(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/** Files one opened proof lists at a time. A capture holds at most a hundred. */
export const PROOF_CAPTURE_FILES_SHOWN = 20;

/**
 * Characters of one retained file shown at a time (D-363).
 *
 * A capture may hold four megabytes of source; a person reads one file, in
 * parts. Nothing here ever holds more than one file's retained text, and it
 * shows one part of that.
 */
export const PROOF_SOURCE_WINDOW_CHARS = 2_000;

/** What an opened proof says, bounded, in the words of the thing it proves. */
export interface ProofCaptureSummary {
  repository: string;
  /** The exact code this proof is of, as the capture recorded it. */
  at: string;
  /** Where the set it keeps whole was taken from, when it says. */
  from?: string;
  /** The capture's own sentence about what it left out. */
  truncated?: string;
}

/** One file whose **text** this proof retained, and can be read out of it. */
export interface ProofSourceEntry {
  path: string;
  side: "before" | "after";
  note: string;
  bytes: number;
  /** Characters of retained text, which is what the reader pages through. */
  length: number;
  /** True when the capture kept only the first bytes of the file. */
  truncated?: boolean;
}

/** One file this proof names but did **not** keep the bytes of, and why. */
export interface ProofOmission {
  path: string;
  note: string;
}

/** One part of one retained file, as it is shown. */
export interface ProofSourceWindow {
  text: string;
  /** 1-based. */
  part: number;
  parts: number;
  from: number;
  to: number;
}

const BASIS_SENTENCE = {
  attempt_base_to_state: "everything the attempt changed, from where it started to this exact state",
  commit_parent_to_commit: "everything this commit introduced over the one before it",
  accepted_change: "everything the accepted change touched",
  complete_bounded_state: "the whole of one named part of the repository, because nothing had changed",
} as const;

const STATUS_NOTE = {
  added: "added",
  modified: "changed",
  deleted: "removed",
  present: "kept whole",
} as const;

const OMISSION_NOTE = {
  binary: "not text, so its bytes were never what a person would read",
  too_large: "too large to keep whole, so none of it was kept",
  budget: "listed without its source, to keep this proof bounded",
  deleted: "removed here; what it said before is kept as its before side",
} as const;

/** One stored capture, read as the bounded record a person can check. */
export function proofCaptureFrom(text: string): RepositoryCapture | undefined {
  try {
    const parsed = repositoryCaptureSchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data as RepositoryCapture) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to show of an opened proof (D-363).
 *
 * The sources it kept whole come first, because they are what a review of the
 * decision reads; the manifest behind them is not listed here, and the count
 * says so rather than the list quietly stopping.
 */
export function proofCaptureSummary(capture: RepositoryCapture): ProofCaptureSummary {
  const required = capture.required;
  return {
    // A capture written before the name was recorded says "a repository"
    // rather than inventing one.
    repository: capture.repositoryName ?? "A repository",
    at: capture.state
      ? `the state at ${short(capture.state.commitObjectId)}${capture.state.checkpointId ? " (a checkpoint)" : ""}`
      : capture.change
        ? `the change from ${short(capture.change.base.commitObjectId)} to ${short(capture.change.head.commitObjectId)}`
        : "code this capture does not name",
    ...(required ? { from: BASIS_SENTENCE[required.basis] } : {}),
    ...(capture.truncated ? { truncated: capture.truncated } : {}),
  };
}

/**
 * The files whose text this proof really holds — the ones a review of the
 * decision reads (D-363).
 *
 * An index, never the bodies: what comes back is path, side, size and how much
 * text there is, so a surface can offer a file without holding the whole
 * capture. The note comes from the required block when there is one, because
 * "changed" and "as it was before" are what a person needs to know about a
 * body before reading it.
 */
export function proofSourceEntries(capture: RepositoryCapture): { entries: ProofSourceEntry[]; more?: string } {
  const required = capture.required?.entries ?? [];
  const all = capture.sources.map((source): ProofSourceEntry => {
    const side = source.side ?? "after";
    const named = required.find((entry) => entry.path === source.path && entry.side === side);
    return {
      path: source.path,
      side,
      note: `${named ? STATUS_NOTE[named.status] : "kept whole"}${side === "before" ? ", as it was before" : ""}${
        source.truncated === true ? ", first part only" : ""
      }`,
      bytes: source.bytes,
      length: source.text.length,
      ...(source.truncated === true ? { truncated: true } : {}),
    };
  });
  const entries = all.slice(0, PROOF_CAPTURE_FILES_SHOWN);
  return {
    entries,
    ...(all.length > entries.length
      ? { more: `${String(all.length - entries.length)} more files this proof holds are not offered here.` }
      : {}),
  };
}

/**
 * The files this proof names but whose bytes it did not keep, each saying why.
 *
 * Not a gap to hide: a person reading a decision's evidence has to know that
 * a binary file's bytes were never evidence and that a file listed without
 * its source is listed without its source.
 */
export function proofOmissions(capture: RepositoryCapture): { omitted: ProofOmission[]; more?: string } {
  const all = capture.files
    .filter((file) => file.omitted !== undefined)
    .map((file) => ({ path: file.path, note: OMISSION_NOTE[file.omitted as keyof typeof OMISSION_NOTE] }));
  const omitted = all.slice(0, PROOF_CAPTURE_FILES_SHOWN);
  return {
    omitted,
    ...(all.length > omitted.length ? { more: `${String(all.length - omitted.length)} more files are listed without their source.` } : {}),
  };
}

/** One retained body, by path and side. Nothing else of the capture is kept. */
export function proofSourceText(capture: RepositoryCapture, path: string, side: "before" | "after"): string | undefined {
  return capture.sources.find((source) => source.path === path && (source.side ?? "after") === side)?.text;
}

/**
 * One part of one retained body.
 *
 * Cut by characters rather than lines on purpose: a capture may hold a file
 * with no newlines at all, and "the first two thousand characters" is a bound
 * that holds whatever the bytes look like.
 */
export function proofSourceWindow(text: string, part: number): ProofSourceWindow {
  const parts = Math.max(1, Math.ceil(text.length / PROOF_SOURCE_WINDOW_CHARS));
  const at = Math.min(Math.max(1, part), parts);
  const from = (at - 1) * PROOF_SOURCE_WINDOW_CHARS;
  const to = Math.min(text.length, from + PROOF_SOURCE_WINDOW_CHARS);
  return { text: text.slice(from, to), part: at, parts, from, to };
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
