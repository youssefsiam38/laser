import { cn } from "@/lib/utils";
import { diffStats, type DiffHunk, type DiffView } from "./diff.js";

export interface DiffBlockProps {
  view: DiffView;
  className?: string | undefined;
}

/**
 * Unified diff for edit/write results. Adds and deletions are a 10% tint of
 * `--ok` / `--danger` with the status color as ink; the gutter is tabular
 * Martian Mono in tertiary ink. Hairlines only, no box.
 */
export function DiffBlock({ view, className }: DiffBlockProps) {
  const { added, removed } = diffStats(view.hunks);
  return (
    <div data-slot="diff-block" className={cn("overflow-hidden rounded-lg border border-line", className)}>
      <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-3 py-1.5">
        <span className="typed min-w-0 flex-1 truncate text-ink-2">{view.path ?? "diff"}</span>
        <span className="typed shrink-0 tnum">
          {added > 0 ? <span className="text-ok">+{added}</span> : null}
          {added > 0 && removed > 0 ? <span className="text-ink-3"> </span> : null}
          {removed > 0 ? <span className="text-danger">−{removed}</span> : null}
        </span>
      </div>
      <div className="max-h-96 overflow-auto bg-surface">
        <table className="w-full border-collapse font-mono text-xs leading-[18px]">
          <tbody>
            {view.hunks.map((hunk, i) => (
              <Hunk key={i} hunk={hunk} showHeader={view.hunks.length > 1 || i > 0} />
            ))}
          </tbody>
        </table>
        {view.truncated ? (
          <p className="typed border-t border-line px-3 py-1.5 text-ink-3">diff truncated</p>
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
          <td colSpan={3} className="border-y border-line bg-surface-2/60 px-3 py-0.5 text-ink-3">
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
          <td className="w-10 select-none pe-2 ps-3 text-end align-top text-ink-3 tnum">{line.oldNo ?? ""}</td>
          <td className="w-10 select-none pe-2 text-end align-top text-ink-3 tnum">{line.newNo ?? ""}</td>
          <td className="w-full pe-3 align-top">
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
            <span className="wrap-break-word whitespace-pre-wrap">{line.text}</span>
          </td>
        </tr>
      ))}
    </>
  );
}
