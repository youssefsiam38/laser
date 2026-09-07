"use client";

/**
 * assistant-ui Quota Banner, adapted for provider-owned percentage windows.
 * It receives normalized values only; authentication and provider payloads
 * stay behind the worker boundary.
 */
import type { ComponentProps } from "react";
import { Clock3, Gauge } from "lucide-react";

import { cn } from "@/lib/utils";

export interface QuotaBannerProps extends Omit<ComponentProps<"div">, "children"> {
  label: string;
  bucketLabel?: string;
  hideBucketLabel?: boolean;
  compact?: boolean;
  usedPercent: number;
  resetsLabel: string;
}

export function QuotaBanner({ label, bucketLabel, hideBucketLabel, compact = false, usedPercent, resetsLabel, className, ...props }: QuotaBannerProps) {
  const used = Math.min(100, Math.max(0, usedPercent));
  const remaining = Math.max(0, 100 - used);
  const tone = remaining <= 10 ? "danger" : remaining <= 30 ? "attention" : "ok";
  return (
    <div data-slot="quota-banner" className={cn("rounded-xl border border-line bg-surface-2/70 p-3", className)} {...props}>
      <div className="flex items-center justify-between gap-3">
        <div className={cn("min-w-0", compact && "flex w-full items-center justify-between gap-2")}>
          {bucketLabel && !hideBucketLabel ? <p className="mb-1 break-words text-xs font-medium leading-4 text-ink" title={bucketLabel}>{bucketLabel}</p> : null}
          <p className="truncate text-xs leading-4 text-ink-3">{label}</p>
          <p className={cn("shrink-0 font-mono font-semibold text-ink tnum", compact ? "text-xs" : "mt-0.5 text-lg")}>{formatPercent(remaining)} left</p>
        </div>
        {!compact && <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface",
            tone === "danger" ? "text-danger" : tone === "attention" ? "text-attention" : "text-ok",
          )}
        >
          <Gauge className="size-4" aria-hidden="true" />
        </span>}
      </div>
      <div
        role="progressbar"
        aria-label={`${bucketLabel ? `${bucketLabel} · ` : ""}${label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
        aria-valuetext={`${formatPercent(remaining)} left; ${formatPercent(used)} used`}
        className={cn("overflow-hidden rounded-full bg-surface", compact ? "mt-2 h-1" : "mt-3 h-2")}
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-(--motion-slow) ease-morph motion-reduce:transition-none",
            tone === "danger" ? "bg-danger" : tone === "attention" ? "bg-attention" : "bg-ok",
          )}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs leading-4 text-ink-3">
        {!compact && <span>{formatPercent(used)} used</span>}
        <span className="flex min-w-0 items-start gap-1"><Clock3 className="mt-0.5 size-3 shrink-0" aria-hidden="true" /><span>{resetsLabel}</span></span>
      </div>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}
