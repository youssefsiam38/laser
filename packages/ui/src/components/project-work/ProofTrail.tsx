"use client";
/**
 * What a decision here rests on — and the proof itself, opened (D-363,
 * M21-T19).
 *
 * The record already shows the evidence a repository record points at *now*.
 * This answers the other question, the one a person needs months later: which
 * evidence was the approval actually made on, and what is in it. They are
 * different questions whenever a later gate corrected a capture, and reading
 * the second as an answer to the first is exactly the mistake this history
 * exists to prevent — so every row says which it is, a decision's row never
 * claims to be the record's evidence today unless it really is, and opening a
 * proof reads **the blob the decision bound**, never the link's current
 * pointer.
 *
 * Four rules shape the surface:
 *
 * - **Bounded, always.** One request is one page of at most
 *   {@link REPOSITORY_CAPTURE_HISTORY_MAX} rows; a page *replaces* the one
 *   before it, and Back walks the cursors this window has already been
 *   handed. Nothing accumulates, whatever a person clicks.
 * - **An opened proof is bounded too.** At most
 *   {@link PROOF_CAPTURE_MAX_PAGES} pages of the stored capture are read, the
 *   files it kept whole are listed up to
 *   {@link PROOF_CAPTURE_FILES_SHOWN}, and what is not listed is said.
 * - **Nothing is inferred.** A decision this app never bound is not shown as
 *   having rested on nothing: `known` is the difference, and the two get two
 *   different sentences. Gone, released and damaged evidence each say so.
 * - **Answers belong to the item they were asked about.** Every read carries
 *   the project, entity and revision it was made for; a reply that arrives
 *   after the panel has moved on is dropped, and the rows, the cursor, the
 *   opened proof and any refusal are cleared when the subject changes.
 */
import { useEffect, useRef, useState } from "react";
import {
  PROJECT_WORK_BLOB_PAGE_MAX_BYTES,
  REPOSITORY_CAPTURE_HISTORY_MAX,
  type ClientRequests,
  type ProjectWorkApproval,
  type RepositoryCaptureHistoryPage,
} from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateTime, relativeTime } from "@/format";
import { useProjectWorkSnapshot, type ProjectWorkStore } from "@/project-work";

import { WorkRefusal } from "./states.js";
import {
  associationProofRows,
  decisionProofRows,
  proofCaptureFrom,
  proofCaptureSummary,
  type ProofCaptureSummary,
  type ProofTrailRow,
} from "./verification-model.js";

type Detail = ClientRequests["project/work/get"]["result"];
type Selection = "decisions" | "associations";

/** Pages of a stored capture one open ever reads. A capture is at most 4 MB. */
export const PROOF_CAPTURE_MAX_PAGES = 8;

/** Decisions offered by name at once. More than this is a list, not a choice. */
export const PROOF_DECISIONS_OFFERED = 5;

const TITLE: Readonly<Record<Selection, string>> = {
  decisions: "What decisions here rest on",
  associations: "Every proof this work has had",
};

const EMPTY: Readonly<Record<Selection, string>> = {
  decisions:
    "No decision here has recorded evidence it rests on yet. A decision made before this app kept that record is not listed — its evidence is not something this app can attest.",
  associations: "Nothing has been kept as proof of this work's code yet.",
};

interface OpenProof {
  blobId: string;
  state: "reading" | "ready" | "gone";
  summary?: ProofCaptureSummary;
  message?: string;
}

export function ProofTrail({ store, detail }: { store: ProjectWorkStore | undefined; detail: Detail }) {
  const work = useProjectWorkSnapshot(store);
  // The subject every answer on this surface belongs to. A different project,
  // item or revision is a different question, and an answer to the old one is
  // not an answer to this one.
  const scope = `${work.projectId ?? "none"}|${detail.entity.entityId}|${detail.entity.currentRevisionId}`;
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [decisionId, setDecisionId] = useState<string | undefined>(undefined);
  const [page, setPage] = useState<{ rows: ProofTrailRow[]; nextCursor?: string; known?: boolean } | undefined>(undefined);
  /** The cursors that led here. `[]` is the first page; Back pops one. */
  const [trail, setTrail] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [proof, setProof] = useState<OpenProof | undefined>(undefined);
  // One counter for every in-flight read. A reply whose generation is not the
  // current one is a reply to a question nobody is asking any more.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setSelection(undefined);
    setDecisionId(undefined);
    setPage(undefined);
    setTrail([]);
    setProblem(undefined);
    setProof(undefined);
    setBusy(false);
  }, [scope]);

  const approvals = decisionsOffered(detail.approvals);

  const read = async (of: Selection, cursor: string | undefined, forDecision: string | undefined, trailNext: string[]): Promise<void> => {
    if (!store) return;
    const mine = (generation.current += 1);
    setBusy(true);
    setProof(undefined);
    const outcome = await store.get({
      entityId: detail.entity.entityId,
      body: { mode: "none" },
      include: {
        links: true,
        captureHistory: {
          of,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(forDecision !== undefined ? { decisionId: forDecision } : {}),
        },
      },
    });
    if (mine !== generation.current) return;
    setBusy(false);
    if (!outcome.ok) {
      setProblem(outcome.failure.message);
      return;
    }
    const answer: RepositoryCaptureHistoryPage | undefined = outcome.value.captureHistory;
    if (!answer) {
      setProblem("This item's evidence history could not be read.");
      return;
    }
    const rows =
      of === "decisions" ? decisionProofRows(answer, outcome.value.repositoryLinks) : associationProofRows(answer, outcome.value.repositoryLinks);
    setProblem(undefined);
    setSelection(of);
    setDecisionId(forDecision);
    setTrail(trailNext);
    setPage({ rows, ...(answer.nextCursor !== undefined ? { nextCursor: answer.nextCursor } : {}), ...(answer.known !== undefined ? { known: answer.known } : {}) });
  };

  /**
   * Open the capture a row names — by its own content address, which is what
   * the decision bound. A correction to what the link points at afterwards
   * changes nothing here, and neither does git having forgotten the commit.
   */
  const open = async (blobId: string): Promise<void> => {
    if (!store) return;
    const mine = (generation.current += 1);
    setProof({ blobId, state: "reading" });
    let text = "";
    let offset = 0;
    for (let read = 0; read < PROOF_CAPTURE_MAX_PAGES; read += 1) {
      const outcome = await store.readBlob({ blobId, offset, limit: PROJECT_WORK_BLOB_PAGE_MAX_BYTES });
      if (mine !== generation.current) return;
      if (!outcome.ok) {
        setProof({ blobId, state: "gone", message: outcome.failure.message });
        return;
      }
      if (outcome.value.released) {
        setProof({ blobId, state: "gone", message: outcome.value.released.detail });
        return;
      }
      if (outcome.value.data === undefined) {
        setProof({ blobId, state: "gone", message: "This proof's bytes are not on this machine any more." });
        return;
      }
      text += decode(outcome.value.data);
      if (outcome.value.nextOffset === undefined) {
        const capture = proofCaptureFrom(text);
        setProof(
          capture
            ? { blobId, state: "ready", summary: proofCaptureSummary(capture) }
            : {
                blobId,
                state: "gone",
                message: "This proof is stored in a form this window cannot read, so what it holds cannot be shown here.",
              },
        );
        return;
      }
      offset = outcome.value.nextOffset;
    }
    setProof({
      blobId,
      state: "gone",
      message: "This proof is larger than this window reads at once, so it is not shown here in full.",
    });
  };

  const ask = (of: Selection, forDecision?: string): void => void read(of, undefined, forDecision, []);

  return (
    <div data-slot="proof-trail" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(["decisions", "associations"] as const).map((of) => (
          <Button
            key={of}
            size="xs"
            variant="outline"
            disabled={!store || busy}
            aria-pressed={selection === of}
            onClick={() => ask(of)}
          >
            {TITLE[of]}
          </Button>
        ))}
      </div>

      {selection === "decisions" && approvals.length > 0 ? (
        <div data-slot="proof-trail-decisions" className="flex flex-wrap items-center gap-2">
          <span className="text-xs leading-xs text-ink-3">One decision:</span>
          {approvals.map((approval) => (
            <Button
              key={approval.approvalId}
              size="xs"
              variant="ghost"
              disabled={!store || busy}
              aria-pressed={decisionId === approval.approvalId}
              title={dateTime(approval.at)}
              onClick={() => ask("decisions", approval.approvalId)}
            >
              {approval.gate} · {relativeTime(approval.at)}
            </Button>
          ))}
          {detail.approvals.length > approvals.length ? (
            <span className="text-xs leading-xs text-ink-3">
              {String(detail.approvals.length - approvals.length)} older decisions are not offered here.
            </span>
          ) : null}
        </div>
      ) : null}

      {problem ? <WorkRefusal message={problem} recovery="Nothing was changed. Try reading it again." /> : null}

      {selection !== undefined && problem === undefined && page !== undefined ? (
        <>
          {page.rows.length === 0 ? (
            <p data-slot="proof-trail-empty" className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
              {decisionId !== undefined && page.known === true
                ? "This decision recorded that it rested on no repository evidence at all."
                : decisionId !== undefined && page.known === false
                  ? "This app has no record of what this decision rested on: it was decided before that record was kept, so nothing here can attest it. Review it again if it matters."
                  : EMPTY[selection]}
            </p>
          ) : (
            <ul role="list" data-slot="proof-trail-rows" className="flex flex-col gap-1.5">
              {page.rows.map((row) => (
                <li key={row.id} className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 text-sm leading-5 text-ink">{row.headline}</span>
                    <Badge variant={row.current ? "ok" : "outline"}>{row.current ? "current" : "superseded"}</Badge>
                    <span className="typed min-w-0 truncate text-ink-3" title={row.proofId}>
                      {row.proof}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!store}
                      aria-pressed={proof?.blobId === row.proofId}
                      onClick={() => void open(row.proofId)}
                    >
                      Open this proof
                    </Button>
                  </span>
                  <span className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">{row.detail}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {trail.length > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void read(selection, trail[trail.length - 2], decisionId, trail.slice(0, -1))}
              >
                Back
              </Button>
            ) : null}
            {page.nextCursor !== undefined ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void read(selection, page.nextCursor, decisionId, [...trail, page.nextCursor as string])}
              >
                Next {String(REPOSITORY_CAPTURE_HISTORY_MAX)}
              </Button>
            ) : null}
            <span data-slot="proof-trail-place" className="text-xs leading-xs text-ink-3">
              {place(trail.length, page.rows.length, page.nextCursor !== undefined)}
            </span>
          </div>
        </>
      ) : null}

      {proof ? <OpenedProof proof={proof} /> : null}
    </div>
  );
}

function OpenedProof({ proof }: { proof: OpenProof }) {
  if (proof.state === "reading") {
    return (
      <p role="status" data-slot="proof-trail-capture" className="text-sm leading-5 text-ink-2">
        Reading what this proof holds…
      </p>
    );
  }
  if (proof.state === "gone" || !proof.summary) {
    return (
      <div data-slot="proof-trail-capture">
        <WorkRefusal
          message={proof.message ?? "This proof could not be read."}
          recovery="The decision that rests on it stands; what it rested on is what cannot be shown. Review the work again if you need to see it."
        />
      </div>
    );
  }
  const summary = proof.summary;
  return (
    <div data-slot="proof-trail-capture" className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
      <p className="text-sm leading-5 text-ink">
        {summary.repository} · {summary.at}
      </p>
      {summary.from ? <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">It keeps {summary.from}.</p> : null}
      {summary.files.length === 0 ? (
        <p className="text-sm leading-5 text-ink-2">This proof lists no files of its own.</p>
      ) : (
        <ul role="list" className="flex flex-col gap-0.5">
          {summary.files.map((file) => (
            <li key={`${file.path}-${file.note}`} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="typed min-w-0 truncate text-ink-2">{file.path}</span>
              <span className="text-xs leading-xs text-ink-3">{file.note}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.more ? <p className="text-xs leading-xs text-ink-3">{summary.more}</p> : null}
      {summary.truncated ? <p className="max-w-(--measure-prose) text-xs leading-xs text-ink-3">{summary.truncated}</p> : null}
    </div>
  );
}

/** The most recent decisions, newest first: a choice, never a wall of them. */
function decisionsOffered(approvals: readonly ProjectWorkApproval[]): ProjectWorkApproval[] {
  return [...approvals].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, PROOF_DECISIONS_OFFERED);
}

/** Where a person is, in words, without ever claiming a total nobody counted. */
function place(depth: number, rows: number, more: boolean): string {
  const page = depth === 0 ? "" : `Page ${String(depth + 1)} · `;
  if (rows === 0) return depth === 0 ? "" : `${page}nothing here.`;
  const counted = rows === 1 ? "one record" : `${String(rows)} records`;
  return more ? `${page}${counted}, and more after them.` : `${page}${counted}, and no more after them.`;
}

function decode(base64: string): string {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(base64, "base64").toString("utf8");
}
