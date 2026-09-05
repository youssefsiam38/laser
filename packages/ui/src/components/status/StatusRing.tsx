import type * as React from "react";

import { cn } from "@/lib/utils";
import {
  STATUS_LABEL,
  statusColor,
  TONE_COLOR,
  toneForPercent,
  type RingTone,
  type Status,
} from "./status.js";

export interface StatusRingProps extends Omit<React.ComponentProps<"span">, "children"> {
  /**
   * Fill 0–100 (context usage). Omit for a status ring, which draws the full
   * circle in the status color.
   */
  percent?: number;
  /** Aggregate status (rail project icon). The full arc takes the status color. */
  status?: Status;
  /** Force an arc color; defaults to `toneForPercent(percent)` or the status color. */
  tone?: RingTone;
  /** Outer diameter in px. */
  size?: number;
  /** Stroke width in px. */
  thickness?: number;
  /** Content centered inside the ring: initials, an icon, or a tabular number. */
  children?: React.ReactNode;
  /**
   * Show `percent` as a tabular label inside when no children are given.
   * Defaults to true when `percent` is set.
   */
  showLabel?: boolean;
  label?: string;
}

/**
 * Conic ring drawn as an SVG arc (crisp at any size, round caps, no mask
 * artifacts). Two uses:
 *  - project aggregate in the rail: `status` → full ring in the status color,
 *    working sweeps, waiting pulses, idle is a hairline.
 *  - context usage: `percent` → arc with a tabular label inside.
 */
function StatusRing({
  percent,
  status,
  tone,
  size = 32,
  thickness = 2,
  children,
  showLabel,
  label,
  className,
  style,
  ...props
}: StatusRingProps) {
  const isPercent = typeof percent === "number";
  const clamped = isPercent ? Math.max(0, Math.min(100, percent)) : 100;
  const trackOnly = !isPercent && (status === undefined || status === "idle");

  const color = tone
    ? TONE_COLOR[tone]
    : isPercent
      ? TONE_COLOR[toneForPercent(clamped)]
      : status
        ? statusColor(status)
        : TONE_COLOR.neutral;

  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;

  const aria =
    label ??
    (isPercent
      ? `${Math.round(clamped)}% used`
      : status
        ? STATUS_LABEL[status]
        : undefined);

  const wantLabel = showLabel ?? (isPercent && children === undefined);
  const fontSize = Math.max(9, Math.round(size * 0.3));

  return (
    <span
      role={aria ? "img" : undefined}
      aria-label={aria}
      data-slot="status-ring"
      data-status={status}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center align-middle",
        status === "waiting_for_input" && !isPercent && "motion-safe:animate-attention",
        className,
      )}
      style={{ width: size, height: size, "--ring": color, ...style } as React.CSSProperties}
      {...props}
    >
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={thickness}
        />
        {!trackOnly && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--ring)"
            strokeWidth={thickness}
            strokeLinecap={isPercent && clamped > 0 && clamped < 100 ? "round" : "butt"}
            strokeDasharray={`${dash} ${c}`}
            className="transition-[stroke-dasharray,stroke] duration-(--motion-slow) ease-out"
            {...(status === "finished_unread" && !isPercent ? { strokeOpacity: 0.55 } : {})}
          />
        )}
      </svg>
      {status === "working" && !isPercent && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-full motion-safe:animate-sweep motion-reduce:hidden",
            "bg-[conic-gradient(from_0deg,transparent_0deg,transparent_240deg,color-mix(in_oklab,var(--ring)_70%,transparent)_360deg)]",
          )}
          style={{
            // A mask's colour is its alpha channel, never something a person
            // sees: opaque black means "keep these pixels".
            mask: `radial-gradient(farthest-side, transparent calc(100% - ${thickness + 1}px), #000 calc(100% - ${thickness}px))`,
            WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${thickness + 1}px), #000 calc(100% - ${thickness}px))`,
          }}
        />
      )}
      <span
        className="relative z-[1] inline-flex items-center justify-center font-mono leading-none font-medium tnum"
        style={{ fontSize }}
      >
        {children ?? (wantLabel ? Math.round(clamped) : null)}
      </span>
    </span>
  );
}

export { StatusRing };
