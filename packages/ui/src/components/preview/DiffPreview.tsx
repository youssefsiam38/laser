"use client";
/**
 * A unified diff as a document-panel body (M8-T3).
 *
 * The transcript already draws diffs, in `DiffBlock` — but as a *card*: a
 * bordered box capped at 24rem that sits inside a tool row. A document panel is
 * the opposite shape: no box (the island is the box), and it fills its share of
 * the dock with its own scroll. Both read from the same pure `diff.ts`, so the
 * colours, the gutter and the line semantics cannot drift; only the geometry
 * differs, which is the thing that actually has to.
 *
 * Wide lines scroll inside the table, never the page (R13, DESIGN.md
 * "Legibility floor"): each row keeps its content on one line and the body owns
 * the horizontal scrollbar, because a diff whose lines wrap is a diff you
 * cannot read alignment in.
 *
 * Content that does not parse as a unified patch is shown as text with a line
 * saying so, rather than as an empty diff.
 */
import { useMemo } from "react";

import { diffStats, parseUnifiedPatch, type DiffHunk } from "@/components/thread/diff";
import { cn } from "@/lib/utils";

export interface DiffPreviewProps {
  /** A unified patch, as the producer sent it. */
  patch: string;
  /** The file the patch is against, when the panel knows. */
  path?: string | undefined;
  /** The read stopped short of the end. */
  truncated?: boolean | undefined;
  className?: string | undefined;
}

/** Lines drawn before the body starts saying "and more". A diff is a view, not the file. */
const MAX_LINES = 4000;

export function DiffPreview({ patch, path, truncated, className }: DiffPreviewProps) {
  const { hunks, total, clipped } = useMemo(() => bound(parseUnifiedPatch(patch)), [patch]);
  const { added, removed } = useMemo(() => diffStats(hunks), [hunks]);

  if (hunks.length === 0) {
    return (
      <div data-slot="diff-preview" className={cn("flex min-h-0 flex-col", className)}>
        <p className="typed shrink-0 px-4 py-2 text-ink-2 hairline-b">
          This is not a unified diff, so it is shown as text.
        </p>
        <pre data-island-scroll className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-sm text-ink">{patch}</pre>
      </div>
    );
  }

  return (
    <div data-slot="diff-preview" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-3 px-4 py-2 hairline-b">
        <span className="typed min-w-0 flex-1 truncate text-ink-2" title={path}>
          {path ?? "diff"}
        </span>
        <span className="typed shrink-0 tnum">
          {added > 0 ? <span className="text-ok">+{added}</span> : null}
          {added > 0 && removed > 0 ? " " : null}
          {removed > 0 ? <span className="text-danger">−{removed}</span> : null}
          {added === 0 && removed === 0 ? <span className="text-ink-3">no changes</span> : null}
        </span>
      </div>

      <div data-island-scroll className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-sm">
          <tbody>
            {hunks.map((hunk, i) => (
              <Hunk key={`${hunk.header}-${i}`} hunk={hunk} showHeader={hunks.length > 1 || i > 0} />
            ))}
          </tbody>
        </table>
        {clipped || truncated ? (
          <p className="typed px-4 py-2 text-ink-3 hairline-t">
            {clipped ? `Showing the first ${MAX_LINES.toLocaleString()} of ${total.toLocaleString()} lines. ` : null}
            {truncated ? "The diff is longer than one read." : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Hunk({ hunk, showHeader }: { hunk: DiffHunk; showHeader: boolean }) {
  return (
    <>
      {showHeader ? (
        <tr>
          {/* Sticky so you always know which lines you are looking at in a long diff. */}
          <td colSpan={3} className="sticky top-0 z-10 bg-surface-2 px-4 py-0.5 text-ink-3 hairline-b">
            {hunk.header}
          </td>
        </tr>
      ) : null}
      {hunk.lines.map((line, i) => (
        <tr
          key={i}
          data-kind={line.kind}
          className={cn(
            line.kind === "add" && "bg-[color-mix(in_oklab,var(--ok)_10%,transparent)] text-ink",
            line.kind === "del" && "bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-ink",
            line.kind === "ctx" && "text-ink-2",
          )}
        >
          <td className="w-10 select-none pe-2 ps-4 text-end align-top text-ink-3 tnum">{line.oldNo ?? ""}</td>
          <td className="w-10 select-none pe-2 text-end align-top text-ink-3 tnum">{line.newNo ?? ""}</td>
          {/*
            `whitespace-pre` on the cell, not only on the text: a line break is
            legal between an atomic inline (the +/− marker) and the text after
            it, so without this a long line starts on the row below its own
            marker. The transcript's card does not hit this because its text
            wraps; a diff body must not wrap, or the columns stop lining up.
          */}
          <td className="w-full whitespace-pre pe-4 align-top">
            <span
              aria-hidden="true"
              className={cn(
                "me-2 inline-block w-2 select-none",
                line.kind === "add" && "text-ok",
                line.kind === "del" && "text-danger",
                line.kind === "ctx" && "text-transparent",
              )}
            >
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </td>
        </tr>
      ))}
    </>
  );
}

/** Keep the DOM bounded; say how much was left out rather than silently cutting. */
function bound(hunks: readonly DiffHunk[]): { hunks: DiffHunk[]; total: number; clipped: boolean } {
  const total = hunks.reduce((n, hunk) => n + hunk.lines.length, 0);
  if (total <= MAX_LINES) return { hunks: [...hunks], total, clipped: false };
  const out: DiffHunk[] = [];
  let budget = MAX_LINES;
  for (const hunk of hunks) {
    if (budget <= 0) break;
    if (hunk.lines.length <= budget) {
      out.push(hunk);
      budget -= hunk.lines.length;
    } else {
      out.push({ header: hunk.header, lines: hunk.lines.slice(0, budget) });
      budget = 0;
    }
  }
  return { hunks: out, total, clipped: true };
}
