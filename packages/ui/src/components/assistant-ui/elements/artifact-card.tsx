"use client";
/**
 * Artifact card — "a generated document as a tangible object" (docs/ux-elements.md
 * "Agents": mission artifacts, and a `document` panel shown as a card).
 * Installed from `elements-artifact-card`. Two callers: a run's `artifacts`
 * list, and the inline surface's collapsed document card.
 *
 * Divergences from the registry copy:
 *   - Renders a `<button>`: the card opens the thing, so it is a control with
 *     hover, focus and pressed states rather than a div with a cursor.
 *   - `words` is gone (no producer counts words); `generating` keeps the
 *     shimmer for a document still being written.
 *   - No fixed `max-w-xs`: the caller lays it out; inside a flex-wrap list of
 *     artifacts it truncates at the width it is given (R13).
 */
import { ArrowUpRight, FileText } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono, paper, ShimmerLabel } from "./surfaces.js";

const pressed = "active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]";

export function ArtifactCard({
  title,
  meta,
  generating = false,
  icon: Icon = FileText,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "title"> & {
  title: string;
  /** One typed line under the title: media type, version, path. */
  meta: string;
  generating?: boolean;
  icon?: typeof FileText;
}) {
  return (
    <button
      type="button"
      data-slot="artifact-card"
      title={title}
      className={cn(
        paper,
        pressed,
        "group/artifact flex min-w-0 items-center gap-3 rounded-xl p-2.5 text-start outline-none",
        "transition-colors duration-(--motion-instant) hover:bg-surface-2",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        className,
      )}
      {...props}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3">
        <Icon className={cn("size-4", generating && "motion-safe:animate-attention")} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-ink" title={title}>
          {title}
        </span>
        {generating ? (
          <span className={cn(mono, "flex items-center gap-1 text-ink-3")}>
            <ShimmerLabel className="relative inline-block leading-none">Writing</ShimmerLabel>
            {meta && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate" title={meta}>
                  {meta}
                </span>
              </>
            )}
          </span>
        ) : (
          <span className={cn(mono, "truncate text-ink-3")} title={meta}>
            {meta}
          </span>
        )}
      </span>
      <ArrowUpRight
        className="size-3.5 shrink-0 text-ink-3 opacity-0 transition-opacity duration-(--motion-instant) group-hover/artifact:opacity-100 group-focus-visible/artifact:opacity-100 [@media(pointer:coarse)]:opacity-100"
        aria-hidden="true"
      />
    </button>
  );
}
