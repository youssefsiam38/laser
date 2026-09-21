"use client";
/**
 * What a decision here rests on, and how this record's evidence changed
 * (D-363, M21-T19).
 *
 * The record already shows the evidence a repository record points at *now*.
 * This answers the other question, the one a person needs months later: which
 * evidence was the approval actually made on, and which review was recorded
 * against what. They are different questions whenever a later gate corrected
 * a capture, and reading the second as an answer to the first is exactly the
 * mistake this history exists to prevent — so each row says which it is, and
 * a decision's row never claims to be the record's evidence today unless it
 * really is.
 *
 * Two rules shape the surface:
 *
 * - **Bounded, always.** One request is one page of at most
 *   {@link REPOSITORY_CAPTURE_HISTORY_MAX} rows across every record on this
 *   item, and more is fetched only when a person asks for it. Nothing here
 *   grows with the number of records or the number of corrections.
 * - **Nothing is inferred.** A decision this app never bound is not shown as
 *   having rested on nothing; it is simply not among the answers, and the
 *   empty state says so in a sentence.
 */
import { useState } from "react";
import { REPOSITORY_CAPTURE_HISTORY_MAX, type ClientRequests, type RepositoryCaptureHistoryPage } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProjectWorkStore } from "@/project-work";

import { WorkRefusal } from "./states.js";
import { associationProofRows, decisionProofRows, type ProofTrailRow } from "./verification-model.js";

type Detail = ClientRequests["project/work/get"]["result"];
type Selection = "decisions" | "associations";

const TITLE: Readonly<Record<Selection, string>> = {
  decisions: "What decisions here rest on",
  associations: "Every proof this work has had",
};

const EMPTY: Readonly<Record<Selection, string>> = {
  decisions: "No decision here has recorded evidence it rests on yet. A decision made before this app kept that record is not listed — its evidence is not something this app can attest.",
  associations: "Nothing has been kept as proof of this work's code yet.",
};

export function ProofTrail({ store, detail }: { store: ProjectWorkStore | undefined; detail: Detail }) {
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [rows, setRows] = useState<ProofTrailRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const read = async (of: Selection, from?: string): Promise<void> => {
    if (!store) return;
    setBusy(true);
    const outcome = await store.get({
      entityId: detail.entity.entityId,
      body: { mode: "none" },
      include: { links: true, captureHistory: { of, ...(from !== undefined ? { cursor: from } : {}) } },
    });
    setBusy(false);
    if (!outcome.ok) {
      setProblem(outcome.failure.message);
      return;
    }
    const page: RepositoryCaptureHistoryPage | undefined = outcome.value.captureHistory;
    if (!page) {
      setProblem("This item's evidence history could not be read.");
      return;
    }
    const next = of === "decisions" ? decisionProofRows(page, outcome.value.repositoryLinks) : associationProofRows(page, outcome.value.repositoryLinks);
    setProblem(undefined);
    setSelection(of);
    setRows(from === undefined ? next : [...rows, ...next]);
    setCursor(page.nextCursor);
  };

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
            onClick={() => void read(of)}
          >
            {TITLE[of]}
          </Button>
        ))}
      </div>

      {problem ? <WorkRefusal message={problem} recovery="Nothing was changed. Try reading it again." /> : null}

      {selection !== undefined && problem === undefined ? (
        rows.length === 0 ? (
          <p data-slot="proof-trail-empty" className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
            {EMPTY[selection]}
          </p>
        ) : (
          <>
            <ul role="list" data-slot="proof-trail-rows" className="flex flex-col gap-1.5">
              {rows.map((row) => (
                <li key={row.id} className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 text-sm leading-5 text-ink">{row.headline}</span>
                    <Badge variant={row.current ? "ok" : "outline"}>{row.current ? "current" : "superseded"}</Badge>
                    <span className="typed min-w-0 truncate text-ink-3" title={row.proofId}>
                      {row.proof}
                    </span>
                  </span>
                  <span className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">{row.detail}</span>
                </li>
              ))}
            </ul>
            {cursor === undefined ? (
              <p className="text-xs leading-xs text-ink-3">
                {rows.length === 1 ? "One record." : `All ${String(rows.length)} of them.`}
              </p>
            ) : (
              <div>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => void read(selection, cursor)}>
                  Show {String(REPOSITORY_CAPTURE_HISTORY_MAX)} more
                </Button>
              </div>
            )}
          </>
        )
      ) : null}
    </div>
  );
}
