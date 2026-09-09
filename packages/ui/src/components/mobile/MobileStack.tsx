import type * as React from "react";

import { cn } from "@/lib/utils";
import { useFooterAnchor } from "./use-footer-anchor.js";

/**
 * The strip directly above the composer where a phone's islands and notices
 * live (on a phone they live directly above the
 * composer"). One fixed column, anchored to the thread footer so it rides the
 * keyboard with it; children are laid out bottom-up so the newest thing sits
 * nearest the thumb. The container itself never eats taps.
 */
export function MobileStack({ className, children, ...props }: React.ComponentProps<"div">) {
  const anchor = useFooterAnchor();
  // Before the footer is found, span the window; once found, align to the
  // composer column exactly (a desktop thread is offset by its side panels).
  const horizontal = anchor.width > 0 ? { left: `${anchor.left}px`, width: `${anchor.width}px` } : { left: 0, right: 0 };
  return (
    <div
      data-slot="mobile-stack"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed z-30 flex flex-col items-stretch gap-2 px-3",
        "[&>*]:pointer-events-auto",
        className,
      )}
      style={{ bottom: `${anchor.bottom + 8}px`, ...horizontal }}
      {...props}
    >
      {children}
    </div>
  );
}

/** A 28px row that still gives a 44px hit area on touch (DESIGN.md legibility floor). */
export function StackRow({ className, tone = "neutral", children, ...props }: React.ComponentProps<"div"> & { tone?: "neutral" | "attention" | "live" | "danger" }) {
  return (
    <div
      {...props}
      data-slot="stack-row"
      data-tone={tone}
      className={cn(
        "mx-auto flex w-full max-w-[76ch] items-center gap-2 rounded-xl border border-line bg-surface px-3 shadow-float-sm",
        "min-h-9 text-xs text-ink",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-(--motion-slow)",
        tone === "attention" && "border-[color-mix(in_oklab,var(--attention)_45%,var(--line))]",
        tone === "live" && "border-[color-mix(in_oklab,var(--live)_45%,var(--line))]",
        tone === "danger" && "border-[color-mix(in_oklab,var(--danger)_45%,var(--line))]",
        className,
      )}
    >
      {children}
    </div>
  );
}
