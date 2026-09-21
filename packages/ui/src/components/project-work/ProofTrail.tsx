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
 *   person is reading one — that single file's text, shown
 *   {@link PROOF_SOURCE_WINDOW_CHARS} characters at a time with navigation.
 *   The other bodies are dropped as soon as the blob is parsed.
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

import { WorkRefusal } from "./states.js";
import {
  PROOF_SOURCE_WINDOW_CHARS,
  associationProofRows,
  decisionProofRows,
  proofCaptureFrom,
  proofCaptureSummary,
  proofOmissions,
  proofSourceEntries,
  proofSourceText,
  proofSourceWindow,
  type ProofCaptureSummary,
  type ProofOmission,
  type ProofSourceEntry,
  type ProofSourceWindow,
  type ProofTrailRow,
} from "./verification-model.js";

type Detail = ClientRequests["project/work/get"]["result"];
type Selection = "decisions" | "associations";

/** Pages of a stored capture one read ever walks. A capture is at most 4 MB. */
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

/** One file a person is reading, and where in it they are. */
interface ReadingFile {
  path: string;
  side: "before" | "after";
  note: string;
  /** This one file's retained text. Never the whole capture's. */
  text: string;
  window: ProofSourceWindow;
}

interface OpenProof {
  blobId: string;
  state: "reading" | "ready" | "gone";
  summary?: ProofCaptureSummary;
  sources?: { entries: ProofSourceEntry[]; more?: string };
  omissions?: { omitted: ProofOmission[]; more?: string };
  message?: string;
  file?: ReadingFile | undefined;
  /** Set when the body of one file could not be read back. */
  fileProblem?: string | undefined;
}

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
    let text = "";
    let offset = 0;
    for (let read = 0; read < PROOF_CAPTURE_MAX_PAGES; read += 1) {
      const outcome = await store?.readBlob({ blobId, offset, limit: PROJECT_WORK_BLOB_PAGE_MAX_BYTES });
      if (mine !== generation.current) return undefined;
      if (!outcome) return { failed: "This project has not been read yet." };
      if (!outcome.ok) return { failed: outcome.failure.message };
      if (outcome.value.released) return { failed: outcome.value.released.detail };
      if (outcome.value.data === undefined) return { failed: "This proof's bytes are not on this machine any more." };
      text += decode(outcome.value.data);
      if (outcome.value.nextOffset === undefined) {
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

  return (
    <div data-slot="proof-trail" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(["decisions", "associations"] as const).map((of) => (
          <Button key={of} size="xs" variant="outline" disabled={!store || busy} aria-pressed={selection === of} onClick={() => ask(of)}>
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

      {proof ? (
        <OpenedProof
          proof={proof}
          onRead={(entry) => void openFile(proof.blobId, entry)}
          onTurn={turnTo}
          onClose={() => setProof((current) => (current ? { ...current, file: undefined, fileProblem: undefined } : current))}
        />
      ) : null}
    </div>
  );
}

function OpenedProof({
  proof,
  onRead,
  onTurn,
  onClose,
}: {
  proof: OpenProof;
  onRead: (entry: ProofSourceEntry) => void;
  onTurn: (part: number) => void;
  onClose: () => void;
}) {
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
  const sources = proof.sources ?? { entries: [] };
  const omissions = proof.omissions ?? { omitted: [] };
  return (
    <div data-slot="proof-trail-capture" className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
      <p className="text-sm leading-5 text-ink">
        {summary.repository} · {summary.at}
      </p>
      {summary.from ? <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">It keeps {summary.from}.</p> : null}

      {sources.entries.length === 0 ? (
        <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">This proof holds no file text of its own.</p>
      ) : (
        <ul role="list" data-slot="proof-trail-sources" className="flex flex-col gap-0.5">
          {sources.entries.map((entry) => (
            <li key={`${entry.path}-${entry.side}`} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="typed min-w-0 truncate text-ink-2">{entry.path}</span>
              <span className="text-xs leading-xs text-ink-3">{entry.note}</span>
              <Button
                size="xs"
                variant="ghost"
                aria-pressed={proof.file?.path === entry.path && proof.file.side === entry.side}
                onClick={() => onRead(entry)}
              >
                Read it
              </Button>
            </li>
          ))}
        </ul>
      )}
      {sources.more ? <p className="text-xs leading-xs text-ink-3">{sources.more}</p> : null}

      {omissions.omitted.length > 0 ? (
        <ul role="list" data-slot="proof-trail-omitted" className="flex flex-col gap-0.5">
          {omissions.omitted.map((omission) => (
            <li key={omission.path} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="typed min-w-0 truncate text-ink-3">{omission.path}</span>
              <span className="text-xs leading-xs text-ink-3">{omission.note}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {omissions.more ? <p className="text-xs leading-xs text-ink-3">{omissions.more}</p> : null}

      {proof.fileProblem ? (
        <WorkRefusal
          message={proof.fileProblem}
          recovery="The rest of this proof is unaffected. Try another file, or review the work again."
        />
      ) : null}

      {proof.file ? <SourceReader file={proof.file} onTurn={onTurn} onClose={onClose} /> : null}

      {summary.truncated ? <p className="max-w-(--measure-prose) text-xs leading-xs text-ink-3">{summary.truncated}</p> : null}
    </div>
  );
}

/**
 * One retained body, in parts.
 *
 * The text is rendered as text: it is somebody's source, it may be a file full
 * of angle brackets, and it is never anything but characters on the screen.
 * Wrapping rather than scrolling sideways, because a proof a person cannot
 * read the right-hand side of is not evidence they can check.
 */
function SourceReader({ file, onTurn, onClose }: { file: ReadingFile; onTurn: (part: number) => void; onClose: () => void }) {
  const { window: shown } = file;
  return (
    <div data-slot="proof-trail-source" className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 p-2.5">
      <p className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="typed min-w-0 truncate text-ink">{file.path}</span>
        <Badge variant="outline">{file.side === "before" ? "as it was before" : "as it was kept"}</Badge>
        <Button size="xs" variant="ghost" className="ms-auto" onClick={onClose}>
          Close
        </Button>
      </p>
      <pre
        data-slot="proof-trail-source-text"
        className="typed max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-ink-2"
      >
        {shown.text}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        {shown.part > 1 ? (
          <Button size="xs" variant="ghost" onClick={() => onTurn(shown.part - 1)}>
            Previous part
          </Button>
        ) : null}
        {shown.part < shown.parts ? (
          <Button size="xs" variant="ghost" onClick={() => onTurn(shown.part + 1)}>
            Next part
          </Button>
        ) : null}
        <span data-slot="proof-trail-source-place" className="text-xs leading-xs text-ink-3">
          {shown.parts === 1
            ? `The whole of what this proof kept of it (${String(shown.text.length)} characters).`
            : `Part ${String(shown.part)} of ${String(shown.parts)} · characters ${String(shown.from + 1)}–${String(shown.to)}, ${String(
                PROOF_SOURCE_WINDOW_CHARS,
              )} at a time.`}
        </span>
      </div>
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
