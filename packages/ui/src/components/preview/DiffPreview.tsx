"use client";
/**
 * A unified diff as a document-panel body (M8-T3).
 *
 * The transcript draws diffs through the `code-diff` element — as a *card*, a
 * bordered box capped at 24rem inside a tool row. A document panel is the
 * opposite shape: no box (the island is the box), and it fills its share of
 * the dock with its own scroll. Both draw the same `CodeDiffRows` from the
 * same pure `diff.ts`, so the colours, the gutter and the line semantics
 * cannot drift; only the geometry differs, which is the thing that actually
 * has to.
 *
 * Wide lines scroll inside the table, never the page (R13, DESIGN.md
 * "Legibility floor"). Content that does not parse as a unified patch is shown
 * as text with a line saying so, rather than as an empty diff.
 */
import { useMemo } from "react";

import { CodeDiffRows, DiffStat } from "@/components/assistant-ui/elements/code-diff";
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
        <p className="typed shrink-0 px-4 py-2 text-ink-2 hairline-b">This is not a unified diff, so it is shown as text.</p>
        <pre data-island-scroll className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-sm text-ink">
          {patch}
        </pre>
      </div>
    );
  }

  return (
    <div data-slot="diff-preview" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-3 px-4 py-2 hairline-b">
        <span className="typed min-w-0 flex-1 truncate text-ink-2" title={path}>
          {path ?? "diff"}
        </span>
        <DiffStat added={added} removed={removed} />
      </div>

      <div data-island-scroll className="min-h-0 flex-1 overflow-auto">
        <CodeDiffRows hunks={hunks} path={path} inset="px-4" stickyHeaders />
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
