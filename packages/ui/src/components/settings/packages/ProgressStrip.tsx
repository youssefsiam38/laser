"use client";
/**
 * A running install, update or remove (docs/ux-elements.md "Job progress"):
 * the `job-progress` element's indeterminate sweep under one line that says
 * what is happening to which extension. Nobody reports a percentage, so no
 * bar pretends to. Terminal events hold for a moment and then leave.
 */
import { Check } from "lucide-react";

import { JobProgress } from "@/components/assistant-ui/elements/job-progress";
import { cn } from "@/lib/utils";

import type { ProgressPhase } from "./model.js";

export function ProgressStrip({ phase, className }: { phase: ProgressPhase; className?: string | undefined }) {
  const failed = phase.tone === "failed";
  const done = phase.tone === "done";
  return (
    <div
      role="status"
      aria-live="polite"
      data-tone={phase.tone}
      className={cn(
        "flex flex-col gap-2 rounded-xl px-3 py-2.5",
        failed
          ? "bg-[color-mix(in_oklab,var(--danger)_8%,transparent)]"
          : done
            ? "bg-[color-mix(in_oklab,var(--ok)_10%,transparent)]"
            : "bg-surface-2",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {done && <Check aria-hidden="true" className="size-3.5 shrink-0 translate-y-0.5 text-ok" />}
        <span className={cn("text-sm font-medium", failed ? "text-danger" : done ? "text-ok" : "text-ink")}>{phase.label}</span>
        {phase.detail && <span className="min-w-0 truncate text-xs text-ink-2" title={phase.detail}>{phase.detail}</span>}
      </div>
      {phase.tone === "working" && <JobProgress progress="indeterminate" />}
    </div>
  );
}
