import type * as React from "react";

import { cn } from "@/lib/utils";
import { STATUS_LABEL, statusColor, TONE_COLOR, type RingTone, type Status } from "./status.js";

export interface StatusRingProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** Aggregate status (rail project icon). The full arc takes the status color. */
  status?: Status;
  /** Force an arc color; defaults to the status color. */
  tone?: RingTone;
  /** Outer diameter in px. */
  size?: number;
  /** Stroke width in px. */
  thickness?: number;
  /** Content centered inside the ring: initials, an icon, a short label. */
  children?: React.ReactNode;
  label?: string;
}

/**
 * The status ring: a project's or a panel's aggregate state drawn as a full
 * SVG arc in the status colour — working sweeps, waiting pulses, idle is a
 * hairline. Crisp at any size, round caps, no mask artifacts.
 *
 * Context usage is *not* drawn here. That is one datum with one drawing,
 * `elements/context-display.tsx` (`ContextDisplayRing` / `ContextRingButton`),
 * used by the composer, the top bar and the telemetry rail alike; a second
 * ring for the same percentage was the thing the element inventory exists to
 * remove.
 *
 * The ring sizes itself, never its children: they keep the surrounding type
 * scale, so the legibility floor is a property of the text and not of each
 * call site remembering to override an inherited size.
 */
function StatusRing({ status, tone, size = 32, thickness = 2, children, label, className, style, ...props }: StatusRingProps) {
  const trackOnly = status === undefined || status === "idle";
  const color = tone ? TONE_COLOR[tone] : status ? statusColor(status) : TONE_COLOR.neutral;

  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;

  const aria = label ?? (status ? STATUS_LABEL[status] : undefined);

  return (
    <span
      role={aria ? "img" : undefined}
      aria-label={aria}
      data-slot="status-ring"
      data-status={status}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center align-middle",
        status === "waiting_for_input" && "motion-safe:animate-attention",
        className,
      )}
      style={{ width: size, height: size, "--ring": color, ...style } as React.CSSProperties}
      {...props}
    >
      <svg aria-hidden="true" width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={thickness} />
        {!trackOnly && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--ring)"
            strokeWidth={thickness}
            strokeLinecap="butt"
            strokeDasharray={`${c} ${c}`}
            className="transition-[stroke-dasharray,stroke] duration-(--motion-slow) ease-out"
            {...(status === "finished_unread" ? { strokeOpacity: 0.55 } : {})}
          />
        )}
      </svg>
      {status === "working" && (
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
      <span className="relative z-[1] inline-flex items-center justify-center font-mono leading-none font-medium tnum">{children}</span>
    </span>
  );
}

export { StatusRing };
