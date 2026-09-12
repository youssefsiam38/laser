"use client";
/**
 * `elements-terminal-block` (assistant-ui registry), de-demoed and restyled:
 * `bash` output in the transcript, and a background command's output in the
 * fleet's task detail (docs/ux-elements.md "Terminal block").
 *
 * Dark ground in BOTH themes (DESIGN.md "Transcript"): agent output is read
 * on the `terminal` utility's ground everywhere, so the ANSI palette is tuned
 * once. What the registry copy had that this does not: `lines`/`visibleCount`
 * (a demo's typewriter), the `paper`/`ink` variants, a `max-w-md`, a
 * `min-h-[8.5rem]`, and a hard-coded `exit 0`. What it has that the copy did
 * not: the real exit code, a failure state, and elision — a command that cats
 * a large file must not put megabytes into the DOM, so the head and tail are
 * shown and "Show all" is the escape hatch.
 *
 * Three opt-ins the fleet needs and the transcript does not (M13-T60), each
 * off by default so the transcript mount is unchanged:
 *
 *   - `follow`: while the command is still running, new output keeps the
 *     bottom in view — unless the reader has scrolled up, in which case their
 *     place is theirs. Once the command has ended nothing moves, so a person
 *     opening a finished command reads it from where the scroller starts.
 *   - `truncatedHead`: the caller already serves a tail (the host reads a
 *     command's output from byte N), so the block says so in one line at the
 *     top and does not elide an already-tailed window a second time.
 *   - `ansi`: decode SGR colour escapes through the shared `ansi-text`
 *     decoder. A dev server prints in colour; the transcript's `bash` tool
 *     hands back text Pi has already flattened, so it does not ask for this.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type UIEvent } from "react";

import { AnsiText } from "@/components/assistant-ui/elements/ansi-text";
import { StatusDot } from "@/components/status";
import { elideText, type ElidedText } from "@/components/thread/tool-summary";
import { cn } from "@/lib/utils";
import { useSearchReveal } from "@/components/thread/search-state";

export interface TerminalBlockProps extends Omit<ComponentProps<"div">, "children"> {
  command: string;
  /** stdout + stderr as Pi returns them (one stream). */
  output: string;
  exitCode?: number | undefined;
  running: boolean;
  /** The tool itself broke — it could not run, or it was killed. Not a non-zero exit. */
  isError: boolean;
  /**
   * Keep the end in view while `running` and `output` grows. A reader who has
   * scrolled up is left where they are; a command that has ended never moves.
   */
  follow?: boolean | undefined;
  /**
   * `output` is the tail of something longer: say so, and do not elide it
   * again. The caller that serves a tail owns the choice of where it starts.
   */
  truncatedHead?: boolean | undefined;
  /** Decode SGR colour escapes instead of showing them as text. */
  ansi?: boolean | undefined;
}

/**
 * How far from the bottom still counts as "at the bottom". Scroll positions
 * are fractional on a scaled display, so an exact comparison would let go of
 * the bottom on its own; this is one rounding error, not a distance anyone
 * chose.
 */
const STUCK_SLACK = 2;

export function TerminalBlock({
  command,
  output,
  exitCode,
  running,
  isError,
  follow = false,
  truncatedHead = false,
  ansi = false,
  className,
  ...props
}: TerminalBlockProps) {
  // Two different facts, and only one of them is an alarm. A command that ran
  // and came back non-zero says so in its own line, on the terminal's own red;
  // a command that could not run at all keeps the loud treatment.
  const nonZero = !running && exitCode !== undefined && exitCode !== 0;
  const broken = !running && isError && !nonZero;
  const failed = nonZero || broken;
  const [showAll, setShowAll] = useState(false);
  const reveal = useSearchReveal();
  const elided = useMemo<ElidedText>(
    () => (truncatedHead ? { text: output, truncated: false, note: "" } : elideText(output)),
    [output, truncatedHead],
  );
  const shown = showAll || reveal ? output : elided.text;

  // Following: the reader's own scroll decides whether the next chunk moves
  // the view. `stuck` is true until they scroll away from the bottom and true
  // again once they return to it; the effect only ever scrolls when it is.
  const pre = useRef<HTMLPreElement>(null);
  const stuck = useRef(true);
  const onScroll = (event: UIEvent<HTMLPreElement>) => {
    const el = event.currentTarget;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STUCK_SLACK;
  };
  useLayoutEffect(() => {
    if (!follow || !running || !stuck.current) return;
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow, running, shown]);

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
        <span
          data-search-content
          className={cn("min-w-0 flex-1 wrap-break-word whitespace-pre-wrap", nonZero ? "text-terminal-danger" : "text-terminal-ink")}
        >
          {command}
        </span>
        <span className={cn("shrink-0 tabular-nums", running ? "text-live" : broken ? "text-danger" : "text-terminal-ink-2")}>
          {running ? (
            <StatusDot status="working" size="sm" label="Running" className="mt-1" />
          ) : exitCode !== undefined ? (
            `exit ${exitCode}`
          ) : failed ? (
            "failed"
          ) : null}
        </span>
      </div>
      {truncatedHead ? (
        <p data-slot="terminal-truncated-head" className="border-b border-terminal-line px-3 py-1.5 text-terminal-ink-2">
          Showing the end of the output.
        </p>
      ) : null}
      {output || running ? (
        <pre dir="ltr"
          ref={pre}
          onScroll={follow ? onScroll : undefined}
          data-search-content
          data-follow={follow && running ? "true" : undefined}
          className={cn(
            "max-h-80 overflow-auto px-3 py-2 wrap-break-word whitespace-pre-wrap",
            failed ? "text-terminal-ink" : "text-terminal-ink-2",
          )}
        >
          {ansi ? <AnsiText text={shown} /> : shown}
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
