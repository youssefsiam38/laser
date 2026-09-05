import { useMemo, useState } from "react";

import { StatusDot } from "@/components/status";
import { cn } from "@/lib/utils";
import { elideText } from "./tool-summary.js";

export interface TerminalBlockProps {
  command: string;
  /** stdout + stderr as Pi returns them (one stream). */
  output: string;
  exitCode?: number | undefined;
  running: boolean;
  isError: boolean;
  className?: string | undefined;
}

/**
 * Bash output. Dark ground in both themes (DESIGN.md "Transcript"), Martian
 * Mono 12/18, tabular numerals. The header owns the command and the exit
 * status; the body is the raw stream, bounded and scrollable.
 */
export function TerminalBlock({ command, output, exitCode, running, isError, className }: TerminalBlockProps) {
  const failed = !running && (isError || (exitCode !== undefined && exitCode !== 0));
  const [showAll, setShowAll] = useState(false);
  // A command that cats a large file must not put megabytes into the DOM.
  const elided = useMemo(() => elideText(output), [output]);
  return (
    <div
      data-slot="terminal-block"
      className={cn(
        "terminal overflow-hidden rounded-lg border border-terminal-line",
        className,
      )}
    >
      <div className="flex items-start gap-2 border-b border-terminal-line px-3 py-1.5">
        <span aria-hidden="true" className="select-none text-terminal-ink-2">
          $
        </span>
        <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap text-terminal-ink">{command}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            running ? "text-live" : failed ? "text-danger" : "text-terminal-ink-2",
          )}
        >
          {running ? (
            <StatusDot status="working" size="sm" label="Running" className="mt-1" />
          ) : exitCode !== undefined ? (
            `exit ${exitCode}`
          ) : failed ? (
            "failed"
          ) : null}
        </span>
      </div>
      {output || running ? (
        <pre
          className={cn(
            "max-h-80 overflow-auto px-3 py-2 wrap-break-word whitespace-pre-wrap",
            failed ? "text-terminal-ink" : "text-terminal-ink-2",
          )}
        >
          {showAll ? output : elided.text}
          {running ? <span aria-hidden="true" className="caret" /> : null}
        </pre>
      ) : (
        <p className="px-3 py-2 text-terminal-ink-2">no output</p>
      )}
      {elided.truncated && !showAll ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full border-t border-terminal-line px-3 py-1.5 text-start text-terminal-ink-2 outline-none hover:text-terminal-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
        >
          Show all ({elided.note} hidden)
        </button>
      ) : null}
    </div>
  );
}
