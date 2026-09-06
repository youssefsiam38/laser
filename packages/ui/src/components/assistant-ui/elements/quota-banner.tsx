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
  usedPercent: number;
  resetsLabel: string;
}

export function QuotaBanner({ label, usedPercent, resetsLabel, className, ...props }: QuotaBannerProps) {
  const used = Math.min(100, Math.max(0, usedPercent));
  const remaining = Math.max(0, 100 - used);
  const tone = remaining <= 10 ? "danger" : remaining <= 30 ? "attention" : "ok";
  return (
    <div data-slot="quota-banner" className={cn("rounded-xl border border-line bg-surface-2/70 p-3", className)} {...props}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs leading-4 text-ink-3">{label}</p>
          <p className="mt-0.5 font-mono text-lg font-semibold text-ink tnum">{formatPercent(remaining)} left</p>
        </div>
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface",
            tone === "danger" ? "text-danger" : tone === "attention" ? "text-attention" : "text-ok",
          )}
        >
          <Gauge className="size-4" aria-hidden="true" />
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
        aria-valuetext={`${formatPercent(remaining)} left; ${formatPercent(used)} used`}
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface"
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-(--motion-slow) ease-morph motion-reduce:transition-none",
            tone === "danger" ? "bg-danger" : tone === "attention" ? "bg-attention" : "bg-ok",
          )}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs leading-4 text-ink-3">
        <span>{formatPercent(used)} used</span>
        <span className="flex items-center gap-1 text-end"><Clock3 className="size-3" aria-hidden="true" />{resetsLabel}</span>
      </div>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}
