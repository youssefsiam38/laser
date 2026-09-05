"use client";
/**
 * `elements-code-diff` (assistant-ui registry), de-demoed and restyled: the
 * `edit` and `write` tool results (docs/ux-elements.md "Code diff").
 *
 * The registry copy is a flat list of `{kind, text}` lines behind a `cycle`
 * counter and a per-line animation delay. A real diff needs what that lacks:
 * two line-number gutters, hunk headers, a cap, and a scroll region that
 * keeps long lines on one line (DESIGN.md "Legibility floor" — a diff whose
 * lines wrap is a diff you cannot read alignment in). So the element renders a
 * `DiffView` from `diff.ts` (pure, tested) and exports its rows, `CodeDiffRows`,
 * for the document-panel body that draws the same diff without the card.
 *
 * Adds are a 10% tint of `--ok`, deletions of `--danger`, with the status
 * colour as the marker ink; the gutter is tabular mono in tertiary ink.
 */
import type { ComponentProps } from "react";

import { diffStats, type DiffHunk, type DiffView } from "@/components/thread/diff";
import { cn } from "@/lib/utils";

import { codeScroll, mono } from "./surfaces.js";

export interface CodeDiffProps extends Omit<ComponentProps<"div">, "children"> {
  view: DiffView;
}

/** The card: header with path and `+n −m`, rows below, bounded and scrollable. */
export function CodeDiff({ view, className, ...props }: CodeDiffProps) {
  const { added, removed } = diffStats(view.hunks);
  return (
    <div data-slot="code-diff" className={cn("overflow-hidden rounded-lg border border-line", className)} {...props}>
      <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-3 py-1.5">
        <span className={cn(mono, "min-w-0 flex-1 truncate text-ink-2")} title={view.path}>
          {view.path ?? "diff"}
        </span>
        <DiffStat added={added} removed={removed} />
      </div>
      <div className={cn(codeScroll, "max-h-96 overflow-y-auto bg-surface")}>
        <CodeDiffRows hunks={view.hunks} inset="px-3" />
        {view.truncated ? <p className={cn(mono, "border-t border-line px-3 py-1.5 text-ink-3")}>diff truncated</p> : null}
      </div>
    </div>
  );
}

export function DiffStat({ added, removed, className }: { added: number; removed: number; className?: string | undefined }) {
  return (
    <span className={cn(mono, "shrink-0 tnum", className)}>
      {added > 0 ? <span className="text-ok">+{added}</span> : null}
      {added > 0 && removed > 0 ? " " : null}
      {removed > 0 ? <span className="text-danger">−{removed}</span> : null}
      {added === 0 && removed === 0 ? <span className="text-ink-3">no changes</span> : null}
    </span>
  );
}

export interface CodeDiffRowsProps {
  hunks: readonly DiffHunk[];
  /** Horizontal inset class for the outer cells (`px-3` in a card, `px-4` in a pane). */
  inset?: "px-3" | "px-4" | undefined;
  /** Hunk headers stick to the top of the scroll region in a long diff. */
  stickyHeaders?: boolean | undefined;
  className?: string | undefined;
}

/** The rows alone, as a table, for any container that owns its own scroll. */
export function CodeDiffRows({ hunks, inset = "px-3", stickyHeaders = false, className }: CodeDiffRowsProps) {
  const start = inset === "px-4" ? "ps-4" : "ps-3";
  const end = inset === "px-4" ? "pe-4" : "pe-3";
  return (
    <table data-slot="code-diff-rows" className={cn("w-full border-collapse font-mono text-xs leading-sm", className)}>
      <tbody>
        {hunks.map((hunk, i) => (
          <Hunk
            key={`${hunk.header}-${i}`}
            hunk={hunk}
            showHeader={hunks.length > 1 || i > 0}
            sticky={stickyHeaders}
            start={start}
            end={end}
            inset={inset}
          />
        ))}
      </tbody>
    </table>
  );
}

function Hunk({
  hunk,
  showHeader,
  sticky,
  start,
  end,
  inset,
}: {
  hunk: DiffHunk;
  showHeader: boolean;
  sticky: boolean;
  start: string;
  end: string;
  inset: string;
}) {
  return (
    <>
      {showHeader ? (
        <tr>
          <td
            colSpan={3}
            className={cn("border-y border-line bg-surface-2 py-0.5 text-ink-3", inset, sticky && "sticky top-0 z-10")}
          >
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
          <td className={cn("w-10 select-none pe-2 text-end align-top text-ink-3 tnum", start)}>{line.oldNo ?? ""}</td>
          <td className="w-10 select-none pe-2 text-end align-top text-ink-3 tnum">{line.newNo ?? ""}</td>
          {/*
            `whitespace-pre` on the cell, not only on the text: a line break is
            legal between an atomic inline (the marker) and the text after it,
            so without this a long line starts on the row below its own marker.
          */}
          <td className={cn("w-full whitespace-pre align-top", end)}>
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
