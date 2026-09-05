"use client";
/**
 * `elements-inline-citation` (assistant-ui registry), reduced to what this app
 * can actually mount (docs/ux-elements.md "Inline citation").
 *
 * The registry copy is a hard-coded paragraph about optimistic updates with
 * two citations spliced in, on Base UI's `PreviewCard`. Nothing in Pi's
 * transcript produces a numbered source list a hover card could preview: what
 * does appear is a GFM footnote reference (`[^1]`) inside assistant markdown.
 * So the chip *style* is what survives, and `markdown-text` draws footnote
 * references with it. The hover-card component itself was deleted rather than
 * left unmountable — an unreachable file in the tree reads as done work and is
 * not. It comes back the day a producer emits sources (`sources.aui` is the
 * runtime request that would feed it).
 */
import { cn } from "@/lib/utils";

/** The numbered chip, 12px at the floor; drawn by the markdown footnote reference. */
export const citationChip = cn(
  "mx-0.5 inline-flex h-4 min-w-4 -translate-y-0.5 items-center justify-center rounded-sm px-1 align-middle",
  "font-mono text-xs leading-none font-medium tabular-nums no-underline outline-none",
  "bg-surface-2 text-ink-2 transition-colors duration-(--motion-instant) hover:bg-live hover:text-on-live",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
  "data-[state=open]:bg-live data-[state=open]:text-on-live",
);
