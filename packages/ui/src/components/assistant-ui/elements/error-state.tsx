"use client";
/**
 * Error state (`elements-error-state`): `extension_error`, a failed turn, a
 * crashed worker. Written for a person — what went wrong, then what to do —
 * and the Retry appears only when there is something to retry (R2). The
 * `retrying` form is what an auto-retry shows while it counts.
 *
 * Divergences from the registry copy: `--danger` throughout instead of
 * `red-500` alphas, the detail is optional, and there is no `max-w-sm`.
 */
import { CircleAlert, RefreshCw } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { ShimmerLabel } from "./surfaces.js";

export interface ErrorStateProps extends Omit<ComponentProps<"div">, "children" | "role"> {
  title: string;
  detail?: string | undefined;
  retrying?: boolean;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
}

export function ErrorState({ title, detail, retrying = false, onRetry, retryLabel = "Retry", className, ...props }: ErrorStateProps) {
  if (retrying) {
    return (
      <div data-slot="error-state" data-retrying role="status" className={cn("flex items-center gap-2 text-sm", className)} {...props}>
        <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 text-ink-3 motion-safe:animate-sweep" />
        <ShimmerLabel className="relative inline-block">{title}</ShimmerLabel>
        {detail ? <span className="typed text-ink-3">{detail}</span> : null}
      </div>
    );
  }
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn("flex items-start gap-2.5 rounded-xl bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-sm", className)}
      {...props}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-danger">{title}</p>
        {detail ? <p className="mt-0.5 wrap-break-word whitespace-pre-wrap text-sm text-ink-2">{detail}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="destructive-ghost" size="xs" className="shrink-0" onClick={onRetry}>
          <RefreshCw />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
