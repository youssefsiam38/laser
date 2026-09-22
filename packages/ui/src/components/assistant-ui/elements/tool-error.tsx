"use client";
/**
 * `elements-tool-error` (assistant-ui registry), de-demoed: a tool row with
 * `isError` (docs/ux-elements.md "Tool failure").
 *
 * The registry card carries an attempt counter and Retry / Skip buttons. Pi
 * has no per-tool retry — the model decides what to do after a failed call —
 * so those controls would be dead, and R2 says a control that does nothing is
 * not shown. What remains is the honest part: the error, written for a
 * person, in danger ink on a code ground. `compact` is the three-line excerpt
 * a collapsed row shows; the full text lives in the expanded body.
 */
import {
  TOOL_ERROR_COMMITTED_SENTENCE,
  TOOL_ERROR_UNCOMMITTED_SENTENCE,
  parseToolError,
  type ToolError as ParsedToolError,
} from "@lasercode/protocol";
import { CircleAlert, CornerDownRight } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export interface ToolErrorProps extends Omit<ComponentProps<"div">, "children"> {
  message: string;
  /** The tool, when the surrounding row does not already say. */
  name?: string | undefined;
  /** What it was acting on, when known. */
  target?: string | undefined;
  /** First lines only, for a collapsed row. */
  compact?: boolean | undefined;
}

/** The first `n` non-blank lines, with an ellipsis when more follow. */
export function errorExcerpt(text: string, n = 3): string {
  const lines = text.slice(0, 4096).split("\n").filter((l) => l.trim());
  const head = lines.slice(0, n).join("\n");
  return lines.length > n ? `${head}\n…` : head;
}

export function ToolError({ message, name, target, compact = false, className, ...props }: ToolErrorProps) {
  const text = compact ? errorExcerpt(message) : message;
  if (compact) {
    return (
      <p data-slot="tool-error" role="alert" className={cn(mono, "wrap-break-word whitespace-pre-wrap text-danger", className)} {...props}>
        {text}
      </p>
    );
  }
  return (
    <div data-slot="tool-error" role="alert" className={cn("flex flex-col gap-1.5", className)} {...props}>
      {name || target ? (
        <div className="flex min-w-0 items-center gap-2">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
          {name ? <span className={cn(mono, "shrink-0 text-ink-2")}>{name}</span> : null}
          {target ? (
            <span className={cn(mono, "min-w-0 truncate text-ink-3")} title={target}>
              {target}
            </span>
          ) : null}
        </div>
      ) : null}
      <pre dir="ltr" data-search-content className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-sm wrap-break-word whitespace-pre-wrap text-danger">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A Laser tool's failure, in its own three parts (M26-T4, D-359.a)
// ---------------------------------------------------------------------------

export interface ToolErrorReportProps extends Omit<ComponentProps<"div">, "children"> {
  /** The result text of the failed call, exactly as the transcript holds it. */
  text: string;
  /** The headline and the saved/not-saved fact only, for a collapsed row. */
  compact?: boolean | undefined;
}

/**
 * A failed tool row's body.
 *
 * A Laser tool fails with a rendered `ToolError` — `[code] message`, then
 * whether anything was saved, then the next call (`docs/agent-tool-contract.md`
 * §2, decision D-359.a). When `parseToolError` recognises that shape this
 * draws the three parts as three things a person reads in order:
 *
 *   - the **message** as the headline, in primary ink beside the danger mark,
 *     because a sentence written for a person is easier to read in ink than in
 *     red; the row already carries the danger rail and the alert icon;
 *   - what was **saved**, in its own tone: `attention` when some of the work
 *     landed — that is the line that may need you — and the quiet danger tone
 *     when nothing changed, which is a statement, not a task;
 *   - the **next** step, quieter and marked as the suggestion it is.
 *
 * The `code` is never the headline. It is correlation for a bug report and for
 * the evaluation harness, so it draws as a small typed chip.
 *
 * Anything that is not a Laser tool error — an engine tool, an MCP tool, a
 * crash, a capture from before the contract — falls through to {@link ToolError}
 * and looks exactly as it did before.
 */
export function ToolErrorReport({ text, compact = false, className, ...props }: ToolErrorReportProps) {
  const parsed = parseToolError(text);
  if (!parsed) return <ToolError message={text} compact={compact} className={className} {...props} />;
  return (
    <div
      data-slot="tool-error-report"
      data-committed={parsed.committed ? "true" : "false"}
      role="alert"
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-danger" />
        <p data-slot="tool-error-message" data-search-content className="min-w-0 flex-1 text-sm wrap-break-word text-ink">
          {parsed.message}
        </p>
        {compact ? null : (
          <code data-slot="tool-error-code" dir="ltr" className={cn(mono, "shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 text-ink-3")}>
            {parsed.code}
          </code>
        )}
      </div>
      <CommittedLine committed={parsed.committed} />
      {compact ? null : (
        <p data-slot="tool-error-next" className="flex min-w-0 items-start gap-1.5 text-sm text-ink-2">
          <CornerDownRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 wrap-break-word">
            <span className="eyebrow">Next </span>
            <span data-search-content>{parsed.next}</span>
          </span>
        </p>
      )}
    </div>
  );
}

/** The one line that says whether anything survived the failure. */
function CommittedLine({ committed }: { committed: ParsedToolError["committed"] }) {
  return (
    <p
      data-slot="tool-error-committed"
      className={cn("ms-5.5 text-sm", committed ? "font-medium text-attention" : "text-danger-quiet")}
    >
      {committed ? TOOL_ERROR_COMMITTED_SENTENCE : TOOL_ERROR_UNCOMMITTED_SENTENCE}
    </p>
  );
}
