"use client";
/**
 * Adopted `elements-research-report`, installed at last because M21 gives it a
 * real producer (docs/ux-elements.md "Research report", D-355).
 *
 * The registry copy is an outline that fills in section by section, each
 * carrying the number of sources behind it, over demo props: a `title`, a
 * `sections[]` of `pending | writing | done`, and a `sourcesRead` count.
 * A Research revision *is* that shape, with the words the domain actually
 * uses — so the outline keeps its structure and loses everything else:
 *
 *   - sections become the question tree, nested to the depth the body has;
 *   - `pending | writing | done` becomes the four question states
 *     (`open · answered · unanswerable · handed to you`), drawn with the
 *     app's own status marks — no new mark, no blue literal, no spinner on
 *     something that is not running;
 *   - the outline is *selectable*: picking a question is what the findings
 *     panel beside it reads (`docs/research-phase.md`, "What a person sees");
 *   - `max-w-sm`, the `[13px]` type, `text-foreground/35` and the fixed
 *     animation duration are gone. Every value is a token and nothing is
 *     below the 12px floor.
 */
import type { ComponentProps, ReactNode } from "react";

import { StatusDot, type Status } from "@/components/status";
import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export interface ReportSection {
  id: string;
  heading: string;
  /** The state in the producer's own vocabulary. Already a person-facing word. */
  state: string;
  /** Which of the app's five marks it draws. */
  mark: Status;
  /** How deep in the outline this section sits. */
  depth?: number;
  /** How many cited sources or findings stand behind it. */
  sources?: number;
  preview?: string | undefined;
}

export function ResearchReport({
  title,
  summary,
  sections,
  selectedId,
  onSelect,
  empty,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "title" | "onSelect"> & {
  title: string;
  /** One line under the title: what this outline has cost and settled so far. */
  summary?: ReactNode;
  sections: readonly ReportSection[];
  selectedId?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
  empty?: ReactNode;
}) {
  return (
    <div data-slot="research-report" className={cn("flex w-full min-w-0 flex-col gap-2", className)} {...props}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="eyebrow">{title}</span>
        {summary ? <span className={cn(mono, "text-ink-3")}>{summary}</span> : null}
      </div>
      {sections.length === 0 ? (
        <p className="text-sm leading-5 text-ink-3">{empty ?? "No questions yet."}</p>
      ) : (
        <ul role="list" className="flex min-w-0 flex-col">
          {sections.map((section) => {
            const selected = section.id === selectedId;
            const row = (
              <>
                <StatusDot status={section.mark} size="sm" label={section.state} className="mt-1.5 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("min-w-0 text-sm leading-5", selected ? "text-ink" : "text-ink-2")}>{section.heading}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-3">
                    <span>{section.state}</span>
                    {section.sources !== undefined && section.sources > 0 ? (
                      <span className={cn(mono, "tnum")}>
                        {section.sources} finding{section.sources === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </span>
                  {section.preview ? <span className="min-w-0 truncate text-xs leading-xs text-ink-3">{section.preview}</span> : null}
                </span>
              </>
            );
            return (
              <li key={section.id} style={{ paddingInlineStart: `calc(var(--spacing) * ${3 * Math.min(section.depth ?? 0, 3)})` }}>
                {onSelect ? (
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect(section.id)}
                    className={cn(
                      "flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-start outline-none",
                      "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                      "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                      "pointer-coarse:min-h-11",
                      selected && "bg-surface-2",
                    )}
                  >
                    {row}
                  </button>
                ) : (
                  <span className="flex w-full min-w-0 items-start gap-2 px-1.5 py-1.5">{row}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
