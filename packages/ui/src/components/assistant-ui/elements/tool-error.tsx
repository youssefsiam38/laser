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
import { CircleAlert } from "lucide-react";
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
      <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-sm wrap-break-word whitespace-pre-wrap text-danger">
        {text}
      </pre>
    </div>
  );
}
