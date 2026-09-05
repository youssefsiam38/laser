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
 */
import { ArrowRight, Square } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { field, mono } from "./surfaces.js";

export interface StoppedRunProps extends Omit<ComponentProps<"div">, "children"> {
  /** Why it stopped, in a person's words. */
  reason: string;
  /** The raw detail (an error message), shown after the reason when it adds something. */
  detail?: string | undefined;
  onContinue?: (() => void) | undefined;
  tone?: "muted" | "danger";
}

export function StoppedRun({ reason, detail, onContinue, tone = "muted", className, ...props }: StoppedRunProps) {
  return (
    <div data-slot="stopped-run" role="status" className={cn("mt-2 flex min-w-0 flex-wrap items-center gap-2", className)} {...props}>
      <span className={cn(field, mono, "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5", tone === "danger" ? "text-danger" : "text-ink-2")}>
        <Square aria-hidden="true" className="size-2.5 fill-current" />
        {reason}
      </span>
      {detail ? <span className="min-w-0 truncate text-xs text-ink-3" title={detail}>{detail}</span> : null}
      {onContinue ? (
        <Button variant="ghost" size="xs" className="ms-auto" onClick={onContinue}>
          Continue
          <ArrowRight />
        </Button>
      ) : null}
    </div>
  );
}
