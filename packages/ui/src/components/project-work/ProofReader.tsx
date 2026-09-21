"use client";
/**
 * One opened proof, read (D-363, M21-T19).
 *
 * The trail beside this says which evidence a decision was made on; this is
 * the reading of that evidence: what the capture is of, which files it kept
 * whole, which it only named and why, and — one at a time — the retained text
 * of one of them.
 *
 * Two bounds hold at once, and they are different bounds:
 *
 * - **What is held.** The index of files is metadata only, and exactly one
 *   file's retained text (at most 128 KB) is in memory at a time. The capture
 *   a page was parsed out of is never kept.
 * - **What is shown.** Files, the files named without their source, and the
 *   parts of one body are each walked a page at a time. Nothing a capture
 *   recorded is unreachable: a cap that hid the hundredth file would be this
 *   surface quietly dropping evidence, which is the opposite of its purpose.
 *
 * The text is rendered as text. It is somebody's source, it may be a file full
 * of angle brackets, and React escapes every character of it.
 */
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { WorkRefusal } from "./states.js";
import {
  PROOF_CAPTURE_FILES_SHOWN,
  PROOF_SOURCE_WINDOW_CHARS,
  proofPageLine,
  proofPageOf,
  type ProofCaptureSummary,
  type ProofOmission,
  type ProofPage,
  type ProofSourceEntry,
  type ProofSourceWindow,
} from "./verification-model.js";

/** One file a person is reading, and where in it they are. */
export interface ReadingFile {
  path: string;
  side: "before" | "after";
  note: string;
  /** This one file's retained text. Never the whole capture's. */
  text: string;
  window: ProofSourceWindow;
}

/** One proof a person opened: its bounded index, and what is being read of it. */
export interface OpenProof {
  blobId: string;
  state: "reading" | "ready" | "gone";
  summary?: ProofCaptureSummary;
  /** Every file whose text this proof holds — the index, never the bodies. */
  sources?: ProofSourceEntry[];
  /** Every file it names without its source, each with the reason. */
  omissions?: ProofOmission[];
  message?: string;
  file?: ReadingFile | undefined;
  /** Set when the body of one file could not be read back. */
  fileProblem?: string | undefined;
}

export function OpenedProof({
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
  // Where in the two lists this person is. Opening another proof is another
  // subject, and the trail replaces this component rather than carrying a
  // page number across.
  const [filePage, setFilePage] = useState(1);
  const [omissionPage, setOmissionPage] = useState(1);

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
          recovery="The record of this decision is kept; it is the proof it was made on that cannot be read here. Review the work before relying on this decision."
        />
      </div>
    );
  }
  const summary = proof.summary;
  const files = proofPageOf(proof.sources ?? [], filePage, PROOF_CAPTURE_FILES_SHOWN);
  const omitted = proofPageOf(proof.omissions ?? [], omissionPage, PROOF_CAPTURE_FILES_SHOWN);
  return (
    <div data-slot="proof-trail-capture" className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
      <p className="text-sm leading-5 text-ink">
        {summary.repository} · {summary.at}
      </p>
      {summary.from ? <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">It keeps {summary.from}.</p> : null}

      {files.total === 0 ? (
        <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">This proof holds no file text of its own.</p>
      ) : (
        <ul role="list" data-slot="proof-trail-sources" className="flex flex-col gap-0.5">
          {files.items.map((entry) => (
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
      <Pager page={files} label="Files" name="files this proof kept" slot="proof-trail-sources-pager" onGo={setFilePage} />

      {omitted.total > 0 ? (
        <>
          <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">Named by this proof, without their source:</p>
          <ul role="list" data-slot="proof-trail-omitted" className="flex flex-col gap-0.5">
            {omitted.items.map((omission) => (
              <li key={omission.path} className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="typed min-w-0 truncate text-ink-3">{omission.path}</span>
                <span className="text-xs leading-xs text-ink-3">{omission.note}</span>
              </li>
            ))}
          </ul>
          <Pager page={omitted} label="Files" name="files named without their source" slot="proof-trail-omitted-pager" onGo={setOmissionPage} />
        </>
      ) : null}

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
 * Turning the page of one bounded list.
 *
 * The buttons read `Previous` and `Next` because that is what they do, and
 * each carries the name of the list it turns, so a person who hears the page
 * rather than sees it knows which of them they are on.
 */
function Pager({
  page,
  label,
  name,
  slot,
  onGo,
}: {
  page: ProofPage<unknown>;
  label: string;
  name: string;
  slot: string;
  onGo: (page: number) => void;
}) {
  if (page.total === 0) return null;
  return (
    <div data-slot={slot} className="flex flex-wrap items-center gap-2">
      {page.page > 1 ? (
        <Button size="xs" variant="ghost" aria-label={`Previous ${name}`} onClick={() => onGo(page.page - 1)}>
          Previous
        </Button>
      ) : null}
      {page.page < page.pages ? (
        <Button size="xs" variant="ghost" aria-label={`Next ${name}`} onClick={() => onGo(page.page + 1)}>
          Next
        </Button>
      ) : null}
      <span className="text-xs leading-xs text-ink-3">{proofPageLine(page, label)}</span>
    </div>
  );
}

/**
 * One retained body, in parts.
 *
 * Wrapping rather than scrolling sideways, because a proof a person cannot
 * read the right-hand side of is not evidence they can check. The parts are
 * cut so that no character is ever split in half.
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
            : `Part ${String(shown.part)} of ${String(shown.parts)} · characters ${String(shown.from + 1)}–${String(shown.to)}, about ${String(
                PROOF_SOURCE_WINDOW_CHARS,
              )} at a time.`}
        </span>
      </div>
    </div>
  );
}
