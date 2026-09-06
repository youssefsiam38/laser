"use client";
/**
 * Loader (`elements-loading-state`): a 3×3 matrix that keeps time while
 * there is nothing to show yet, with a shimmering label beneath it. Used for
 * session hydration, the entries fetch, the model list and a panel body
 * before its first data.
 *
 * Divergences from the registry copy, each on purpose:
 *   - `tick` is optional. Left out, the loader drives itself off the
 *     `--motion-fast` token, and holds still when that token is zero
 *     (reduced motion), so no caller has to own an interval.
 *   - Left-aligned like everything else in the thread; no `items-center`.
 *   - Cells are `--ink-3`, the label is `--ink-2`; no `foreground/55` alphas.
 */
import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";

import { LaserMark } from "@/components/brand/Logo";
import { useTick } from "@/components/thread/timing";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";

import { ShimmerLabel } from "./surfaces.js";

export type GenerationLoaderVariant = "dots" | "squares" | "rounded";

export interface GenerationLoaderProps extends Omit<ComponentProps<"div">, "children"> {
  /** What is being waited for, in words a person reads: "Loading session". */
  label: string;
  /** Drive the matrix from outside; omit to let it tick on its own. */
  tick?: number | undefined;
  variant?: GenerationLoaderVariant;
  /** `inline` fits a row (a menu, a table cell); `block` stands alone. */
  layout?: "inline" | "block";
}

const CELL_SHAPES: Record<GenerationLoaderVariant, string> = {
  dots: "rounded-full",
  squares: "rounded-[1px]",
  rounded: "rounded-xs",
};

export function GenerationLoader({ label, tick, variant = "dots", layout = "block", className, ...props }: GenerationLoaderProps) {
  const step = motionMs("--motion-fast");
  const own = useTick(tick === undefined && step > 0, Math.max(step, 50) * 2);
  const frame = tick ?? own;
  const pixelOffset = Math.floor(frame / 3);

  return (
    <div
      data-slot="generation-loader"
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn(layout === "block" ? "flex flex-col items-start gap-3" : "flex items-center gap-2.5", className)}
      {...props}
    >
      <div aria-hidden="true" className={cn("grid grid-cols-3", layout === "block" ? "gap-1" : "gap-px")}>
        {Array.from({ length: 9 }, (_, index) => {
          const active = (index * 2 + pixelOffset) % 9 < 3;
          return (
            <span
              key={index}
              className={cn(
                "bg-ink-3 transition-opacity duration-(--motion-fast) motion-reduce:transition-none",
                layout === "block" ? "size-1.5" : "size-1",
                CELL_SHAPES[variant],
                active ? "opacity-90" : "opacity-20",
              )}
            />
          );
        })}
      </div>
      <ShimmerLabel className="relative inline-block text-sm">{label}</ShimmerLabel>
    </div>
  );
}

interface StartupRestorationScreenProps {
  label: string;
  exiting?: boolean;
  notice?: ReactNode;
  onExited?: () => void;
}

/**
 * Full-window form of the catalog Loader. The converging SVG paths follow
 * Magic UI's Animated Beam composition, but use Laser's mark, motion tokens
 * and theme colours instead of the registry demo's integration logos.
 */
export function StartupRestorationScreen({ label, exiting = false, notice, onExited }: StartupRestorationScreenProps) {
  const gradientPrefix = useId().replaceAll(":", "");
  const gradients = {
    left: `${gradientPrefix}-left`,
    right: `${gradientPrefix}-right`,
    topLeft: `${gradientPrefix}-top-left`,
    bottomLeft: `${gradientPrefix}-bottom-left`,
    topRight: `${gradientPrefix}-top-right`,
    bottomRight: `${gradientPrefix}-bottom-right`,
  };

  return (
    <div
      data-slot="startup-restoration"
      data-exiting={exiting || undefined}
      role={exiting ? undefined : "status"}
      aria-live={exiting ? undefined : "polite"}
      aria-busy={exiting ? undefined : "true"}
      aria-label={exiting ? undefined : label}
      aria-hidden={exiting || undefined}
      className={cn(
        "startup-restoration fixed inset-0 z-100 grid overflow-hidden bg-bg text-ink",
        exiting && "startup-restoration-exit pointer-events-none",
      )}
      onAnimationEnd={(event) => {
        if (exiting && event.currentTarget === event.target) onExited?.();
      }}
    >
      {!exiting && notice}
      <svg
        aria-hidden="true"
        viewBox="0 0 1200 800"
        preserveAspectRatio="none"
        className="startup-restoration-beams absolute inset-0 size-full"
      >
        <defs>
          <linearGradient id={gradients.left} gradientUnits="userSpaceOnUse" x1="0" y1="400" x2="590" y2="400">
            <stop offset="0" stopColor="var(--live)" stopOpacity="0" />
            <stop offset="0.18" stopColor="var(--live)" stopOpacity="0.72" />
            <stop offset="0.72" stopColor="var(--live)" />
            <stop offset="1" stopColor="var(--live)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={gradients.right} gradientUnits="userSpaceOnUse" x1="1200" y1="400" x2="610" y2="400">
            <stop offset="0" stopColor="var(--live)" stopOpacity="0" />
            <stop offset="0.18" stopColor="var(--live)" stopOpacity="0.72" />
            <stop offset="0.72" stopColor="var(--live)" />
            <stop offset="1" stopColor="var(--live)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={gradients.topLeft} gradientUnits="userSpaceOnUse" x1="360" y1="0" x2="590" y2="400">
            <stop offset="0" stopColor="var(--live)" stopOpacity="0" />
            <stop offset="0.2" stopColor="var(--live)" stopOpacity="0.58" />
            <stop offset="0.8" stopColor="var(--live)" />
            <stop offset="1" stopColor="var(--live)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={gradients.bottomLeft} gradientUnits="userSpaceOnUse" x1="360" y1="800" x2="590" y2="400">
            <stop offset="0" stopColor="var(--live)" stopOpacity="0" />
            <stop offset="0.2" stopColor="var(--live)" stopOpacity="0.58" />
            <stop offset="0.8" stopColor="var(--live)" />
            <stop offset="1" stopColor="var(--live)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={gradients.topRight} gradientUnits="userSpaceOnUse" x1="840" y1="0" x2="610" y2="400">
            <stop offset="0" stopColor="var(--live)" stopOpacity="0" />
            <stop offset="0.2" stopColor="var(--live)" stopOpacity="0.58" />
            <stop offset="0.8" stopColor="var(--live)" />
            <stop offset="1" stopColor="var(--live)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={gradients.bottomRight} gradientUnits="userSpaceOnUse" x1="840" y1="800" x2="610" y2="400">
            <stop offset="0" stopColor="var(--live)" stopOpacity="0" />
            <stop offset="0.2" stopColor="var(--live)" stopOpacity="0.58" />
            <stop offset="0.8" stopColor="var(--live)" />
            <stop offset="1" stopColor="var(--live)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="startup-beam-tracks">
          <path d="M0 400C250 400 450 400 590 400" stroke={`url(#${gradients.left})`} />
          <path d="M1200 400C950 400 750 400 610 400" stroke={`url(#${gradients.right})`} />
          <path d="M360 0C360 164 402 248 484 300C548 341 578 369 590 400" stroke={`url(#${gradients.topLeft})`} />
          <path d="M360 800C360 636 402 552 484 500C548 459 578 431 590 400" stroke={`url(#${gradients.bottomLeft})`} />
          <path d="M840 0C840 164 798 248 716 300C652 341 622 369 610 400" stroke={`url(#${gradients.topRight})`} />
          <path d="M840 800C840 636 798 552 716 500C652 459 622 431 610 400" stroke={`url(#${gradients.bottomRight})`} />
        </g>
        <g className="startup-beam-live">
          <path d="M0 400C250 400 450 400 590 400" pathLength="1" stroke={`url(#${gradients.left})`} />
          <path d="M1200 400C950 400 750 400 610 400" pathLength="1" stroke={`url(#${gradients.right})`} />
          <path d="M360 0C360 164 402 248 484 300C548 341 578 369 590 400" pathLength="1" stroke={`url(#${gradients.topLeft})`} />
          <path d="M360 800C360 636 402 552 484 500C548 459 578 431 590 400" pathLength="1" stroke={`url(#${gradients.bottomLeft})`} />
          <path d="M840 0C840 164 798 248 716 300C652 341 622 369 610 400" pathLength="1" stroke={`url(#${gradients.topRight})`} />
          <path d="M840 800C840 636 798 552 716 500C652 459 622 431 610 400" pathLength="1" stroke={`url(#${gradients.bottomRight})`} />
        </g>
      </svg>

      <div className="startup-aperture relative z-10 m-auto flex flex-col items-center">
        <div aria-hidden="true" className="startup-aperture-halo absolute left-1/2 top-0 -translate-x-1/2" />
        <LaserMark aria-hidden="true" className="startup-mark relative z-10 size-20" />
        <p className="mt-7 text-xl font-semibold tracking-title">{PRODUCT_DISPLAY_NAME}</p>
        <p className="mt-2 text-sm text-ink-2">{label}</p>
        <span aria-hidden="true" className="startup-signal mt-5 block h-px w-24 overflow-hidden bg-line">
          <span className="block h-full w-1/2 bg-live" />
        </span>
      </div>
    </div>
  );
}

interface StartupRestorationGateProps {
  active: boolean;
  label: string;
  notice?: ReactNode;
  children: ReactNode;
}

/** Do not mount the operational shell until restoration is complete. */
export function StartupRestorationGate({ active, label, notice, children }: StartupRestorationGateProps) {
  const [overlayPresent, setOverlayPresent] = useState(active);

  useEffect(() => {
    if (active) setOverlayPresent(true);
  }, [active]);

  if (active) return <StartupRestorationScreen label={label} notice={notice} />;

  return (
    <>
      {children}
      {overlayPresent && (
        <StartupRestorationScreen
          label={label}
          exiting
          notice={notice}
          onExited={() => setOverlayPresent(false)}
        />
      )}
    </>
  );
}
