/**
 * Reading a verification report in this window (M21-T19).
 *
 * The report is a stored document, not a derived view: it is written once, at
 * exact revisions, and read back exactly as it was written. Everything here is
 * pure — finding the record, decoding the blob, grouping the findings — so the
 * component stays about what a person sees.
 */
import {
  PROJECT_WORK_BLOB_PAGE_MAX_BYTES,
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
  const bytes = proofPageBytes(page.data);
  if (!bytes) return undefined;
  const text = proofTextFrom([bytes]);
  if (text === undefined) return undefined;
  try {
    const parsed = verificationReportSchema.safeParse(JSON.parse(withoutMark(text)));
    return parsed.success ? (parsed.data as VerificationReport) : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------- bytes, read back as text

/** Pages of a stored blob one read ever walks. A capture is at most 4 MB. */
export const PROOF_CAPTURE_MAX_PAGES = 8;

/**
 * Bytes one read ever assembles, whatever the pages say.
 *
 * The page count alone is not a bound: a page is at most
 * {@link PROJECT_WORK_BLOB_PAGE_MAX_BYTES}, but what actually comes back is
 * what this window decides to hold, so the bytes are counted too.
 */
export const PROOF_CAPTURE_MAX_BYTES = PROOF_CAPTURE_MAX_PAGES * PROJECT_WORK_BLOB_PAGE_MAX_BYTES;

/** Base64 of one page, exactly: anything else is not this page's bytes. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * One page of a blob, as the bytes it is.
 *
 * Strict on purpose: `Buffer.from(…, "base64")` drops characters it does not
 * understand and returns a plausible shorter buffer, which is the one thing a
 * proof reader must never do. A page that is not base64 is refused, not
 * quietly shortened.
 */
export function proofPageBytes(base64: string): Uint8Array | undefined {
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) return undefined;
  try {
    if (typeof atob === "function") {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
      return bytes;
    }
    const buffer = Buffer.from(base64, "base64");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return undefined;
  }
}

/**
 * Every page of one blob, decoded **once**, as the text it is.
 *
 * A page boundary is a byte boundary, not a character one: a multi-byte
 * character can straddle it, and decoding each page on its own turns such a
 * character into replacement characters — a proof that reads differently from
 * the source it is a proof of. So the pages are assembled and decoded in one
 * pass, and that pass is `fatal`: bytes that are not valid UTF-8 are a refusal
 * a person is told about, never `\uFFFD` silently standing in for what the
 * file really said. `ignoreBOM: true` keeps a leading mark rather than eating
 * it, so what comes out is what was stored.
 */
export function proofTextFrom(pages: readonly Uint8Array[]): string | undefined {
  let total = 0;
  for (const page of pages) total += page.length;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const page of pages) {
    bytes.set(page, at);
    at += page.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** JSON never starts with a byte order mark; a document that kept one still parses. */
function withoutMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
 * One bounded page of a list a person walks, and where in the list it is.
 *
 * A cap on what is *shown* is not a cap on what exists: everything a capture
 * recorded stays reachable by turning the page, because a proof that quietly
 * stops listing what it holds is a proof a person cannot check.
 */
export interface ProofPage<T> {
  items: T[];
  /** 1-based. */
  page: number;
  pages: number;
  /** 1-based and inclusive; both 0 when the list is empty. */
  from: number;
  to: number;
  total: number;
}

/** One page of a list, clamped to the pages that exist. */
export function proofPageOf<T>(items: readonly T[], page: number, size: number): ProofPage<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(1, Math.trunc(page)), pages);
  const from = (at - 1) * size;
  const shown = items.slice(from, from + size);
  return {
    items: [...shown],
    page: at,
    pages,
    from: shown.length === 0 ? 0 : from + 1,
    to: from + shown.length,
    total: items.length,
  };
}

/** Where a person is in a paged list, counted rather than guessed at. */
export function proofPageLine(page: ProofPage<unknown>, label: string): string {
  if (page.total === 0) return "";
  return `${label} ${String(page.from)}\u2013${String(page.to)} of ${String(page.total)}.`;
}

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
    const parsed = repositoryCaptureSchema.safeParse(JSON.parse(withoutMark(text)));
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
 *
 * Every retained file is indexed, not the first page of them: the index is
 * metadata for the hundred files a capture may hold at most, and holds
 * no body at all, and a surface pages through it with
 * {@link proofPageOf}. Capping the index instead would make the hundredth file
 * of a proof unreadable, which is hiding evidence rather than bounding it.
 */
export function proofSourceEntries(capture: RepositoryCapture): ProofSourceEntry[] {
  const required = capture.required?.entries ?? [];
  return capture.sources.map((source): ProofSourceEntry => {
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
}

/**
 * The files this proof names but whose bytes it did not keep, each saying why.
 *
 * Not a gap to hide: a person reading a decision's evidence has to know that
 * a binary file's bytes were never evidence and that a file listed without
 * its source is listed without its source. Every one of them is named — the
 * reader pages through them — because "and some others" is exactly the gap
 * this list exists to close.
 */
export function proofOmissions(capture: RepositoryCapture): ProofOmission[] {
  return capture.files
    .filter((file) => file.omitted !== undefined)
    .map((file) => ({ path: file.path, note: OMISSION_NOTE[file.omitted as keyof typeof OMISSION_NOTE] }));
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
 *
 * A cut never falls between the two halves of one character. JavaScript counts
 * UTF-16 units, so an emoji or any other character outside the basic plane is
 * two of them; cutting between them would show a person half a character that
 * is not in the file they are reading. The high half moves to the next part
 * instead, so the parts still join back into exactly the retained text and no
 * part is ever longer than {@link PROOF_SOURCE_WINDOW_CHARS}.
 */
export function proofSourceWindow(text: string, part: number): ProofSourceWindow {
  const cuts = windowCuts(text);
  const parts = Math.max(1, cuts.length - 1);
  const at = Math.min(Math.max(1, Math.trunc(part)), parts);
  const from = cuts[at - 1] ?? 0;
  const to = cuts[at] ?? text.length;
  return { text: text.slice(from, to), part: at, parts, from, to };
}

/** Where each part of one retained body starts and ends, `[0, …, length]`. */
function windowCuts(text: string): number[] {
  const cuts = [0];
  let at = 0;
  while (at < text.length) {
    at = wholeCharacterAt(text, Math.min(text.length, at + PROOF_SOURCE_WINDOW_CHARS));
    cuts.push(at);
  }
  return cuts;
}

/** The nearest cut at or before `index` that does not split a surrogate pair. */
function wholeCharacterAt(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  const before = text.charCodeAt(index - 1);
  const here = text.charCodeAt(index);
  const splits = before >= 0xd800 && before <= 0xdbff && here >= 0xdc00 && here <= 0xdfff;
  return splits ? index - 1 : index;
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
