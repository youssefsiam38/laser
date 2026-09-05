import type * as React from "react";

import { cn } from "@/lib/utils";
import { STATUS_LABEL, statusColor, type Status } from "./status.js";

export type StatusDotSize = "sm" | "md";

export interface StatusDotProps extends Omit<React.ComponentProps<"span">, "children"> {
  status: Status;
  /** sm = 8px (list rows), md = 10px (top bar, rail). */
  size?: StatusDotSize;
  /** Overrides the default aria-label (STATUS_LABEL). */
  label?: string;
}

const SIZE: Record<StatusDotSize, string> = { sm: "size-2", md: "size-2.5" };

/**
 * One dot, one vocabulary:
 *  working          — --live, slow radar sweep (conic gradient rotating, 2s)
 *  waiting_for_input — --attention, gentle pulse (1 → .6, 1.6s)
 *  error            — --danger, still
 *  finished_unread  — --live outline, still
 *  idle             — --ink-3, still
 * Under reduced motion the sweep/pulse stop on a solid dot; color + aria-label carry the state.
 */
function StatusDot({ status, size = "sm", label, className, style, ...props }: StatusDotProps) {
  const color = statusColor(status);
  const outline = status === "finished_unread";
  return (
    <span
      role="img"
      aria-label={label ?? STATUS_LABEL[status]}
      data-slot="status-dot"
      data-status={status}
      className={cn(
        "relative inline-block shrink-0 rounded-full align-middle",
        SIZE[size],
        outline ? "bg-transparent shadow-[inset_0_0_0_1.5px_var(--dot)]" : "bg-(--dot)",
        status === "waiting_for_input" && "motion-safe:animate-attention",
        className,
      )}
      style={{ "--dot": color, ...style } as React.CSSProperties}
      {...props}
    >
      {status === "working" && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -inset-[3px] rounded-full motion-safe:animate-sweep",
            "bg-[conic-gradient(from_0deg,transparent_0deg,transparent_250deg,color-mix(in_oklab,var(--dot)_55%,transparent)_360deg)]",
            "[mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-2px))]",
            "motion-reduce:hidden",
          )}
        />
      )}
    </span>
  );
}

export { StatusDot };
