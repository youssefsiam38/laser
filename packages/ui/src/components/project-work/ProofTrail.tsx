"use client";
/**
 * What a decision here rests on — and the source it rests on, read (D-363,
 * M21-T19).
 *
 * The record already shows the evidence a repository record points at *now*.
 * This answers the other question, the one a person needs months later: which
 * evidence was the approval actually made on, and **what is in it** — the
 * retained text of the files the decision rested on, out of the exact
 * immutable capture it bound. Names and digests are not evidence a person can
 * read; the bodies are, and a capture exists precisely so they survive git
 * forgetting the commit.
 *
 * Five rules shape the surface:
 *
 * - **Bounded history.** One request is one page of at most
 *   {@link REPOSITORY_CAPTURE_HISTORY_MAX} rows; a page *replaces* the one
 *   before it, and Back walks the cursors this window has already been handed.
 * - **Bounded reading.** A capture may hold four megabytes. What is retained
 *   here is an index of the files whose text it holds, and — only while a
 *   person is reading one — that single file's text, shown about two thousand
 *   characters at a time with navigation (`ProofReader`).
 *   The other bodies are dropped as soon as the blob is parsed. Bounded is
 *   not hidden: files, omitted files, decisions and the parts of one body are
 *   each turned a page at a time, and everything recorded stays reachable.
 * - **Bytes are read once.** A blob arrives in pages, and a page boundary
 *   falls wherever it falls — in the middle of a character, if that is where
 *   half a megabyte lands. The pages are assembled and decoded in a single
 *   fatal pass, so the text this surface shows is the text that was stored,
 *   or an honest refusal.
 * - **The bound proof, never the pointer.** Every read is by the blob id the
 *   decision bound, so a later correction of what the link points at changes
 *   nothing a person reads here.
 * - **Nothing is inferred.** `known` is the difference between a decision that
 *   recorded resting on nothing and one this app cannot attest, and the two
 *   get two different sentences. Released, deleted, damaged and unreadable
 *   evidence each say what happened.
 * - **Answers belong to the subject they were asked about.** The whole surface
 *   is keyed by store, project, item and revision, so a change replaces it
 *   before the next paint rather than leaving the previous subject's rows on
 *   screen; every in-flight read is invalidated by that unmount and by each
 *   new request.
 */
import { useEffect, useRef, useState } from "react";
import {
  PROJECT_WORK_BLOB_PAGE_MAX_BYTES,
  REPOSITORY_CAPTURE_HISTORY_MAX,
  type ClientRequests,
  type ProjectWorkApproval,
  type RepositoryCapture,
  type RepositoryCaptureHistoryPage,
} from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateTime, relativeTime } from "@/format";
import { useProjectWorkSnapshot, type ProjectWorkStore } from "@/project-work";

import { OpenedProof, type OpenProof } from "./ProofReader.js";
import { WorkRefusal } from "./states.js";
import {
  PROOF_CAPTURE_MAX_BYTES,
  PROOF_CAPTURE_MAX_PAGES,
  associationProofRows,
  decisionProofRows,
  proofCaptureFrom,
  proofCaptureSummary,
  proofOmissions,
  proofPageBytes,
  proofPageLine,
  proofPageOf,
  proofSourceEntries,
  proofSourceText,
  proofSourceWindow,
  proofTextFrom,
  type ProofSourceEntry,
  type ProofTrailRow,
} from "./verification-model.js";

type Detail = ClientRequests["project/work/get"]["result"];
type Selection = "decisions" | "associations";

/** Decisions offered by name at once. More than this is a list, not a choice. */
export const PROOF_DECISIONS_OFFERED = 5;

const TITLE: Readonly<Record<Selection, string>> = {
  decisions: "What decisions here rest on",
  associations: "Every proof this work has had",
};

const EMPTY: Readonly<Record<Selection, string>> = {
  decisions:
    "No decision here has recorded evidence it rests on yet. A decision whose evidence this app cannot attest is not listed — ask about it by name to see what is known of it.",
  associations: "Nothing has been kept as proof of this work's code yet.",
};

/**
 * Which store instance this is, as an identity a key can carry.
 *
 * Two stores can answer for the same project id — a window that reopened one,
 * a second checkout of the same project — and an answer from the old one is
 * not an answer from this one. A `WeakMap` keeps the mapping without keeping
 * the store alive.
 */
const STORE_IDENTITY = new WeakMap<object, string>();
let minted = 0;
function storeIdentity(store: object | undefined): string {
  if (!store) return "no-store";
  const known = STORE_IDENTITY.get(store);
  if (known) return known;
  minted += 1;
  const id = `store-${String(minted)}`;
  STORE_IDENTITY.set(store, id);
  return id;
}

export function ProofTrail({ store, detail }: { store: ProjectWorkStore | undefined; detail: Detail }) {
  const work = useProjectWorkSnapshot(store);
  // The subject every answer on this surface belongs to. A different store,
  // project, item or revision is a different question — and it is answered by
  // *replacing* the surface, in the same render, rather than by an effect that
  // tidies up after the previous subject's rows have already been painted.
  const scope = `${storeIdentity(store)}|${work.projectId ?? "no-project"}|${detail.entity.entityId}|${detail.entity.currentRevisionId}`;
  return <ProofTrailFor key={scope} store={store} detail={detail} />;
}

function ProofTrailFor({ store, detail }: { store: ProjectWorkStore | undefined; detail: Detail }) {
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [decisionId, setDecisionId] = useState<string | undefined>(undefined);
  const [page, setPage] = useState<{ rows: ProofTrailRow[]; nextCursor?: string; known?: boolean } | undefined>(undefined);
  /** The cursors that led here. `[]` is the first page; Back pops one. */
  const [trail, setTrail] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [proof, setProof] = useState<OpenProof | undefined>(undefined);
  /** Which page of this item's decisions is offered by name. 1-based. */
  const [decisionPage, setDecisionPage] = useState(1);
  // One counter for every in-flight read. A reply whose generation is not the
  // current one — because another read started, or because this surface was
  // replaced — is a reply to a question nobody is asking any more.
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const approvals = proofPageOf(decisionsNewestFirst(detail.approvals), decisionPage, PROOF_DECISIONS_OFFERED);

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
    setPage({
      rows,
      ...(answer.nextCursor !== undefined ? { nextCursor: answer.nextCursor } : {}),
      ...(answer.known !== undefined ? { known: answer.known } : {}),
    });
  };

  /**
   * Read the stored capture a row names — by its own content address, which is
   * what the decision bound. What is kept afterwards is the projection, not the
   * blob: the parsed capture goes out of scope here, so the other bodies it
   * holds are never retained.
   */
  const fetchCapture = async (blobId: string, mine: number): Promise<RepositoryCapture | { failed: string } | undefined> => {
    // The pages, as bytes. They are decoded once, at the end: a character
    // whose bytes straddle a page boundary is one character, and decoding
    // page by page would turn it into replacement characters that are not in
    // the file this proof is of.
    const pages: Uint8Array[] = [];
    let bytes = 0;
    let offset = 0;
    for (let read = 0; read < PROOF_CAPTURE_MAX_PAGES; read += 1) {
      const outcome = await store?.readBlob({ blobId, offset, limit: PROJECT_WORK_BLOB_PAGE_MAX_BYTES });
      if (mine !== generation.current) return undefined;
      if (!outcome) return { failed: "This project has not been read yet." };
      // A refusal first: bytes that no longer match what they are addressed
      // by are damaged, and the host says so rather than answering with a
      // page. Then release, which is a decision someone took; only then is
      // an absent body "not here any more".
      if (!outcome.ok) return { failed: outcome.failure.message };
      if (outcome.value.released) return { failed: outcome.value.released.detail };
      if (outcome.value.data === undefined) return { failed: "This proof's bytes are not on this machine any more." };
      const page = proofPageBytes(outcome.value.data);
      if (!page) {
        return { failed: "This proof's bytes did not arrive in a form this window can read, so what it holds cannot be shown here." };
      }
      bytes += page.length;
      // Our own bound, not the page count's: what came back is what this
      // window would have to hold.
      if (bytes > PROOF_CAPTURE_MAX_BYTES) {
        return { failed: "This proof is larger than this window reads at once, so it is not shown here in full." };
      }
      pages.push(page);
      if (outcome.value.nextOffset === undefined) {
        const text = proofTextFrom(pages);
        if (text === undefined) {
          return { failed: "This proof's bytes are not the text they are stored as, so it cannot be read here. It may be damaged." };
        }
        const capture = proofCaptureFrom(text);
        return (
          capture ?? {
            failed: "This proof is stored in a form this window cannot read, so what it holds cannot be shown here.",
          }
        );
      }
      offset = outcome.value.nextOffset;
    }
    return { failed: "This proof is larger than this window reads at once, so it is not shown here in full." };
  };

  const open = async (blobId: string): Promise<void> => {
    if (!store) return;
    const mine = (generation.current += 1);
    setProof({ blobId, state: "reading" });
    const answer = await fetchCapture(blobId, mine);
    if (answer === undefined || mine !== generation.current) return;
    if ("failed" in answer) {
      setProof({ blobId, state: "gone", message: answer.failed });
      return;
    }
    setProof({
      blobId,
      state: "ready",
      summary: proofCaptureSummary(answer),
      sources: proofSourceEntries(answer),
      omissions: proofOmissions(answer),
    });
  };

  /** One file's retained text, read out of the same bound capture. */
  const openFile = async (blobId: string, entry: ProofSourceEntry): Promise<void> => {
    if (!store) return;
    const mine = (generation.current += 1);
    setProof((current) => (current ? { ...current, fileProblem: undefined } : current));
    const answer = await fetchCapture(blobId, mine);
    if (answer === undefined || mine !== generation.current) return;
    if ("failed" in answer) {
      setProof((current) => (current ? { ...current, fileProblem: answer.failed } : current));
      return;
    }
    const text = proofSourceText(answer, entry.path, entry.side);
    if (text === undefined) {
      setProof((current) =>
        current ? { ...current, fileProblem: `${entry.path} is named by this proof, but its text is not in it.` } : current,
      );
      return;
    }
    setProof((current) =>
      current
        ? { ...current, file: { path: entry.path, side: entry.side, note: entry.note, text, window: proofSourceWindow(text, 1) } }
        : current,
    );
  };

  const turnTo = (part: number): void =>
    setProof((current) =>
      current?.file ? { ...current, file: { ...current.file, window: proofSourceWindow(current.file.text, part) } } : current,
    );

  const ask = (of: Selection, forDecision?: string): void => void read(of, undefined, forDecision, []);

  const decisionsLine = proofPageLine(approvals, "Decisions");

  return (
    <div data-slot="proof-trail" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(["decisions", "associations"] as const).map((of) => (
          <Button key={of} size="xs" variant="outline" disabled={!store || busy} aria-pressed={selection === of} onClick={() => ask(of)}>
            {TITLE[of]}
          </Button>
        ))}
      </div>

      {selection === "decisions" && approvals.total > 0 ? (
        <div data-slot="proof-trail-decisions" className="flex flex-wrap items-center gap-2">
          <span className="text-xs leading-xs text-ink-3">One decision:</span>
          {approvals.items.map((approval) => (
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
          {approvals.page > 1 ? (
            <Button size="xs" variant="ghost" disabled={!store || busy} aria-label="Newer decisions" onClick={() => setDecisionPage(approvals.page - 1)}>
              Newer
            </Button>
          ) : null}
          {approvals.page < approvals.pages ? (
            <Button size="xs" variant="ghost" disabled={!store || busy} aria-label="Older decisions" onClick={() => setDecisionPage(approvals.page + 1)}>
              Older
            </Button>
          ) : null}
          {approvals.pages > 1 ? <span className="text-xs leading-xs text-ink-3">{decisionsLine}</span> : null}
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
                  ? "This app has no record of what this decision rested on. Why there is none is not something this app knows — it may predate the record, or the record may not have survived — so nothing here can attest it either way. Review it again if it matters."
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

      {proof ? (
        <OpenedProof
          key={proof.blobId}
          proof={proof}
          onRead={(entry) => void openFile(proof.blobId, entry)}
          onTurn={turnTo}
          onClose={() => setProof((current) => (current ? { ...current, file: undefined, fileProblem: undefined } : current))}
        />
      ) : null}
    </div>
  );
}

/**
 * This item's decisions, newest first.
 *
 * A handful are offered at a time, because a wall of them is not a choice —
 * but every one of them is reachable, because a decision a person cannot ask
 * about is a decision this surface is hiding.
 */
function decisionsNewestFirst(approvals: readonly ProjectWorkApproval[]): ProjectWorkApproval[] {
  return [...approvals].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Where a person is, in words, without ever claiming a total nobody counted. */
function place(depth: number, rows: number, more: boolean): string {
  const page = depth === 0 ? "" : `Page ${String(depth + 1)} · `;
  if (rows === 0) return depth === 0 ? "" : `${page}nothing here.`;
  const counted = rows === 1 ? "one record" : `${String(rows)} records`;
  return more ? `${page}${counted}, and more after them.` : `${page}${counted}, and no more after them.`;
}
