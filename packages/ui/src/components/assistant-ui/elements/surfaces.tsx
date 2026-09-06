"use client";
/**
 * The shared style vocabulary every adopted element builds on
 * (`elements-surfaces`, docs/ux-elements.md "Beyond the published catalog").
 *
 * Adopted from the assistant-ui registry and mapped onto the semantic tokens
 * in docs/ux-theme.md, so every element that imports `paper` or `field` gets
 * laser's ground rather than the catalog's `bg-foreground/[0.04]` guesses.
 * Divergences from the registry copy, each on purpose:
 *
 *   - `mono` is `typed` — 12px, the legibility floor — not the catalog's 11px.
 *   - `ShimmerLabel` uses the `shimmer-text` utility (globals.css), so the
 *     `tw-shimmer` dependency is not installed.
 *   - Durations and easings come from the motion tokens; scale transforms on
 *     press are replaced by the one press affordance the app uses
 *     (`active:translate-y-px`).
 *   - `collapsePanel` targets Radix (`data-state`), which is the collapsible
 *     this package ships; the catalog copy targets Base UI's starting styles.
 *   - No blur on the label swap: DESIGN.md's motion budget is a crossfade.
 */
import type { ComponentProps, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** A card on the page ground. */
export const paper = "bg-surface border border-line";

/** A popover or sheet: the same card, floating, so it casts the one soft shadow. */
export const floating = "bg-surface border border-line shadow-float";

/** An inset field or a code ground. */
export const field = "bg-surface-2";

/** One quiet, recognizable row for reasoning, tools and their aggregate. */
export const activityRow = "relative w-full min-w-0 rounded-md bg-surface px-2 text-ink-2";
export const activityTrigger =
  "group/trigger relative isolate flex min-h-8 pointer-coarse:min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-start text-sm text-ink-2 outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live";

export const pressable = "transition-transform duration-(--motion-instant) active:translate-y-px motion-reduce:transition-none";

export const ghostButton =
  "flex items-center justify-center rounded-md text-ink-3 outline-none transition-[background-color,color] duration-(--motion-instant) hover:bg-surface-2 hover:text-ink active:translate-y-px focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live motion-reduce:transition-none";

export const iconSwap = "[grid-area:1/1] transition-[opacity,scale] duration-(--motion-fast) motion-reduce:transition-none";
export const iconSwapIn = "scale-100 opacity-100";
export const iconSwapOut = "scale-[0.25] opacity-0";

export const labelSwap =
  "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-opacity duration-(--motion-fast) motion-reduce:transition-none";
export const labelSwapIn = "opacity-100";
export const labelSwapOut = "pointer-events-none select-none opacity-0";

/** Radix collapsible content: the height is measured, the token plays it, reduced motion makes it instant. */
export const collapsePanel =
  "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up [animation-duration:var(--motion-fast)] motion-reduce:animate-none";

/** The streaming accent. */
export const live = "text-live";

/** Typed values: paths, ids, counts. 12px is the floor, so this is `typed`, not the catalog's 11px. */
export const mono = "typed";

export function ShimmerLabel({ active = true, className, ...props }: ComponentProps<"span"> & { active?: boolean }) {
  return <span className={cn(active && "shimmer-text", className)} {...props} />;
}

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its background at the fold.
 */
export const codeScroll = "overflow-x-auto";
export const codeSurface = "w-max min-w-full";

/**
 * Two labels in one slot; the active one shows, and the slot's width follows
 * it so the row does not jump when "Running" becomes "Ran".
 */
export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [ReactNode, ReactNode];
  className?: string | undefined;
}) {
  const first = useRef<HTMLSpanElement>(null);
  const second = useRef<HTMLSpanElement>(null);
  const layers = [first, second] as const;
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = layers[active].current;
    if (!target) return undefined;
    const measure = () => setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are stable
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid min-w-0 overflow-x-clip transition-[width] duration-(--motion-fast) motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index as 0 | 1]}
          aria-hidden={active !== index}
          className={cn(labelSwap, active === index ? labelSwapIn : labelSwapOut)}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
