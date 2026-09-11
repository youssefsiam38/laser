"use client";
/**
 * `elements-tool-call` (assistant-ui registry), de-demoed and restyled: the
 * tool row itself (docs/ux-elements.md "Tool call").
 *
 * The registry copy is a specimen — `label`/`activeLabel`/`query` strings, a
 * `max-w-sm`, a request/result pair of paragraphs. Here it is the row grammar
 * DESIGN.md specifies, `[icon] verb summary ····· duration ›`, composed from
 * the `tool-fallback` parts so an unknown tool and a known one are the same
 * row with different bodies. The body is whatever the caller renders as
 * children (a terminal block, a diff, args and result); `footer` is where an
 * approval, an interrupt or a declared decision goes, outside the collapsible
 * so a question is never hidden behind a chevron.
 */
import type { ComponentType, ReactNode, SVGProps } from "react";

import { cn } from "@/lib/utils";

import {
  ToolFallbackContent,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  type ToolRowState,
} from "./tool-fallback.aui.js";

export type { ToolRowState } from "./tool-fallback.aui.js";

export interface ToolCallProps {
  icon?: ComponentType<SVGProps<SVGSVGElement>> | undefined;
  verb: string;
  activeLabel?: string | undefined;
  summary?: string | undefined;
  detail?: string | undefined;
  state: ToolRowState;
  /** Wall-clock elapsed, when the caller keeps the clock; otherwise the runtime's. */
  elapsedMs?: number | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Trailing header content before the duration. */
  trailing?: ReactNode;
  /** Extra screen-reader description; the trigger keeps its existing accessible name. */
  accessibleDescription?: string | undefined;
  /** Rendered under the header while collapsed: an error excerpt, a hint. */
  peek?: ReactNode;
  /** The expanded body. Absent → the row is not expandable. */
  children?: ReactNode;
  /** Approval, interrupt or decision — always visible, never inside the fold. */
  footer?: ReactNode;
  toolName?: string | undefined;
  className?: string | undefined;
}

export function ToolCall({
  icon,
  verb,
  activeLabel,
  summary,
  detail,
  state,
  elapsedMs,
  open,
  onOpenChange,
  trailing,
  accessibleDescription,
  peek,
  children,
  footer,
  toolName,
  className,
}: ToolCallProps) {
  const expandable = children !== undefined && children !== null && children !== false;
  // No tone for a failure of any kind. A rail down the side of the row reads
  // as "the app is broken" for what is usually an agent probing — a file it
  // looked for and did not find, a command that came back non-zero. What went
  // wrong is written, in red, in the row's own body. `awaiting` keeps its
  // rail: that one is a question waiting on a person, not a result.
  const tone = state === "awaiting" ? "attention" : undefined;
  return (
    <ToolFallbackRoot
      data-slot="tool-call"
      data-tool={toolName}
      data-state-row={state}
      open={open}
      onOpenChange={onOpenChange}
      tone={tone}
      className={cn(className)}
    >
      <ToolFallbackTrigger
        verb={verb}
        activeLabel={activeLabel}
        summary={summary}
        detail={detail}
        icon={icon}
        state={state}
        elapsedMs={elapsedMs}
        expandable={expandable}
        trailing={trailing}
        aria-description={accessibleDescription}
        className={trailing ? "[&_[data-slot=tool-fallback-trigger-label]]:shrink-0" : undefined}
      />
      {!open && peek ? <div className="mb-1.5 ms-6">{peek}</div> : null}
      {expandable ? <ToolFallbackContent>{children}</ToolFallbackContent> : null}
      {footer}
    </ToolFallbackRoot>
  );
}
