"use client";
/**
 * Stopped run (`elements-stopped-run`): an aborted turn, and a run whose
 * `terminalReason` is a stop. It always says WHY it stopped (R3) — "You
 * stopped it", "Hit the output limit", the provider's error — and offers to
 * continue only where continuing is possible (R2).
 *
 * Divergences from the registry copy: the typewriter of "words" is gone (the
 * text that arrived is already in the transcript above this row), and so is
 * "Discard", which Pi cannot do. The reason pill is `typed` and the row sits
 * flush with the message.
 *
 * A provider failure gets a second line: what to do next, the one button that
 * does it, and the provider's own words folded away behind "What the provider
 * said" for whoever is debugging a local model server. A raw JSON payload is
 * never the first thing a person reads.
 */
import { ArrowRight, ChevronDown, Square } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { JsonViewer, parseJsonText } from "./json-viewer.js";

import { field, mono } from "./surfaces.js";

export interface StoppedRunProps extends Omit<ComponentProps<"div">, "children" | "action"> {
  /** Why it stopped, in a person's words. */
  reason: string;
  /** The reason in one more sentence, when there is one to add. */
  detail?: string | undefined;
  /** What to do next. Shown under the reason, never as a stack trace. */
  advice?: string | undefined;
  /** The provider's own payload, folded away. */
  raw?: string | undefined;
  /** The one control that acts on the advice — "Open Providers and models". */
  action?: { label: string; icon?: ReactNode; onClick: () => void } | undefined;
  onContinue?: (() => void) | undefined;
  tone?: "muted" | "danger" | "warning";
}

export function StoppedRun({ reason, detail, advice, raw, action, onContinue, tone = "muted", className, ...props }: StoppedRunProps) {
  const [open, setOpen] = useState(false);
  const secondLine = advice !== undefined || action !== undefined || raw !== undefined;

  return (
    <div data-slot="stopped-run" role="status" className={cn("mt-2 flex min-w-0 flex-col gap-1.5", className)} {...props}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={cn(field, mono, "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5", tone === "danger" ? "text-danger" : tone === "warning" ? "text-attention" : "text-ink-2")}>
          <Square aria-hidden="true" className="size-2.5 fill-current" />
          {reason}
        </span>
        {detail ? (
          // A basis the sentence can actually be read in: with only `min-w-0
          // flex-1` the explanation shrank to a few pixels beside a long
          // reason pill and clipped its words instead of wrapping under it.
          <span className="min-w-0 flex-1 basis-56 text-xs leading-4 text-ink-2" title={detail}>
            {detail}
          </span>
        ) : null}
        {onContinue ? (
          <Button variant="ghost" size="xs" className="ms-auto shrink-0" onClick={onContinue}>
            Continue
            <ArrowRight className="rtl:-scale-x-100" />
          </Button>
        ) : null}
      </div>

      {secondLine ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 ps-0.5">
          {advice ? <span className="min-w-0 text-xs leading-4 text-ink-3">{advice}</span> : null}
          {action ? (
            <Button variant="secondary" size="xs" className="shrink-0" onClick={action.onClick}>
              {action.icon}
              {action.label}
            </Button>
          ) : null}
          {raw ? (
            <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 basis-full">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="xs" className="-ms-2 text-ink-3">
                  <ChevronDown aria-hidden="true" className={cn("transition-transform duration-(--motion-instant)", open && "rotate-180")} />
                  What the provider said
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                {parseJsonText(raw) === undefined ? (
                  <pre className={cn(field, mono, "mt-1 max-h-40 overflow-auto rounded-lg p-2.5 text-xs leading-4 whitespace-pre-wrap text-ink-2")}>{raw}</pre>
                ) : (
                  <JsonViewer value={parseJsonText(raw)} expandedDepth={1} className="mt-1 max-h-40" />
                )}
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
