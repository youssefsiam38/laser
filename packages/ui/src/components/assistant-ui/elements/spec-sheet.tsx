"use client";
/**
 * `elements-spec-sheet` (assistant-ui registry), de-demoed and restyled: one
 * object, labelled — run and session metadata: model, thinking, cwd, ids
 * (docs/ux-elements.md "Spec sheet").
 *
 * The registry copy takes `visibleCount` (a demo's typewriter) and a fixed
 * label column. Here `runSpecRows` builds the rows from a `run` panel and
 * `sessionSpecRows` from session metadata, values are typed (paths, ids,
 * counts are mono and tabular), long values truncate with the full text in
 * the tooltip, and a row with nothing to say is not drawn rather than drawn
 * as "—" (R3).
 *
 * **Narrow containers stack.** A label column is `max-content`, so a long
 * label ("peak resident (not additive)") leaves a phone with sixty pixels for
 * the value it explains — which then truncates behind a `title` no touch
 * screen can open, or breaks a word down the column. Below `@sm` the row
 * therefore becomes label-over-value across the full width and nothing
 * truncates; at `@sm` and wider it is the same compact two-column sheet it
 * always was. The measurement is the *container*, not the viewport: this
 * element lives in rails and sheets that are narrow on a wide screen.
 */
import type { ComponentProps } from "react";

import { shortCwd, tokens } from "@/format";
import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

export interface SpecRow {
  label: string;
  value: string;
  /** Draw the value in mono (a path, an id, a count). */
  typed?: boolean | undefined;
  emphasis?: boolean | undefined;
  /** Long explanatory prose wraps; identifiers and compact values truncate. */
  wrap?: boolean | undefined;
}

const row = (label: string, value: string | number | undefined | null, typed = false): SpecRow[] =>
  value === undefined || value === null || value === "" ? [] : [{ label, value: String(value), typed }];

export interface SessionSpec {
  model?: string | undefined;
  thinking?: string | undefined;
  cwd?: string | undefined;
  id?: string | undefined;
  path?: string | undefined;
}

export function sessionSpecRows(meta: SessionSpec): SpecRow[] {
  return [
    ...row("model", meta.model, true),
    ...row("thinking", meta.thinking, true),
    ...(meta.cwd ? [{ label: "cwd", value: shortCwd(meta.cwd), typed: true }] : []),
    ...row("session", meta.id, true),
    ...row("file", meta.path, true),
  ];
}

export interface SpecSheetProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  title?: string | undefined;
  subtitle?: string | undefined;
  rows: readonly SpecRow[];
  /** No card: the caller's surface is the card (an island, a rail section). */
  bare?: boolean | undefined;
}

export function SpecSheet({ title, subtitle, rows, bare = false, className, ...props }: SpecSheetProps) {
  if (rows.length === 0) return null;
  return (
    <div data-slot="spec-sheet" className={cn("@container flex w-full min-w-0 flex-col gap-2", !bare && cn(paper, "rounded-lg p-3"), className)} {...props}>
      {title || subtitle ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {title ? <span className="truncate text-sm font-medium text-ink">{title}</span> : null}
          {subtitle ? <span className="truncate text-xs text-ink-2">{subtitle}</span> : null}
        </div>
      ) : null}
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-2 @sm:grid-cols-[max-content_minmax(0,1fr)] @sm:gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex min-w-0 flex-col gap-0.5 @sm:contents">
            <dt className="eyebrow self-baseline pt-px">{r.label}</dt>
            <dd
              className={cn(
                "min-w-0 wrap-break-word whitespace-normal @sm:text-end",
                r.wrap ? "@sm:wrap-break-word @sm:whitespace-normal" : "@sm:truncate",
                r.typed ? cn(mono, "tnum") : "text-sm",
                r.emphasis ? "font-medium text-ink" : "text-ink-2",
              )}
              title={r.value}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
