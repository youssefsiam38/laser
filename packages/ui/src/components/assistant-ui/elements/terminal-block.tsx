"use client";
/**
 * `elements-terminal-block` (assistant-ui registry), de-demoed and restyled:
 * `bash` output in the transcript, and worker stderr in the logs screen
 * (docs/ux-elements.md "Terminal block").
 *
 * Dark ground in BOTH themes (DESIGN.md "Transcript"): agent output is read
 * on the `terminal` utility's ground everywhere, so the ANSI palette is tuned
 * once. What the registry copy had that this does not: `lines`/`visibleCount`
 * (a demo's typewriter), the `paper`/`ink` variants, a `max-w-md`, a
 * `min-h-[8.5rem]`, and a hard-coded `exit 0`. What it has that the copy did
 * not: the real exit code, a failure state, and elision — a command that cats
 * a large file must not put megabytes into the DOM, so the head and tail are
 * shown and "Show all" is the escape hatch.
 */
import { useMemo, useState, type ComponentProps } from "react";

import { StatusDot } from "@/components/status";
import { elideText } from "@/components/thread/tool-summary";
import { cn } from "@/lib/utils";

export interface TerminalBlockProps extends Omit<ComponentProps<"div">, "children"> {
  command: string;
  /** stdout + stderr as Pi returns them (one stream). */
  output: string;
  exitCode?: number | undefined;
  running: boolean;
  isError: boolean;
}

export function TerminalBlock({ command, output, exitCode, running, isError, className, ...props }: TerminalBlockProps) {
  const failed = !running && (isError || (exitCode !== undefined && exitCode !== 0));
  const [showAll, setShowAll] = useState(false);
  const elided = useMemo(() => elideText(output), [output]);

  return (
    <div
      data-slot="terminal-block"
      data-exit={exitCode}
      className={cn("terminal overflow-hidden rounded-lg border border-terminal-line", className)}
      {...props}
    >
      <div className="flex items-start gap-2 border-b border-terminal-line px-3 py-1.5">
        <span aria-hidden="true" className="select-none text-terminal-ink-2">
          $
        </span>
        <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap text-terminal-ink">{command}</span>
        <span className={cn("shrink-0 tabular-nums", running ? "text-live" : failed ? "text-danger" : "text-terminal-ink-2")}>
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
          className="w-full border-t border-terminal-line px-3 py-1.5 text-start text-terminal-ink-2 outline-none transition-colors duration-(--motion-instant) hover:text-terminal-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
        >
          Show all ({elided.note} hidden)
        </button>
      ) : null}
    </div>
  );
}
