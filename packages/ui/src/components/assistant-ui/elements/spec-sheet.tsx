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
 */
import type { RunPanel } from "@piorbit/protocol";
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
}

const row = (label: string, value: string | number | undefined | null, typed = false): SpecRow[] =>
  value === undefined || value === null || value === "" ? [] : [{ label, value: String(value), typed }];

/** What a `run` panel knows about itself, in the order a person asks. */
export function runSpecRows(panel: RunPanel): SpecRow[] {
  const usage = panel.usage ?? undefined;
  const total = usage && (usage.input ?? 0) + (usage.output ?? 0) > 0 ? (usage.input ?? 0) + (usage.output ?? 0) : undefined;
  return [
    ...row("model", panel.model, true),
    ...(panel.requested?.model && panel.requested.model !== panel.model ? row("requested", panel.requested.model, true) : []),
    ...row("thinking", panel.requested?.thinking, true),
    ...row("origin", panel.origin),
    ...row("handle", panel.handle, true),
    ...(panel.parent ? row(panel.parent.relation === "step-of" ? "step of" : "spawned by", panel.parent.id, true) : []),
    ...(total !== undefined ? row("tokens", tokens(total), true) : []),
    ...(panel.usage === null && panel.usage !== undefined ? row("usage", "not measured") : []),
    ...row("id", panel.id, true),
  ];
}

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
    <div data-slot="spec-sheet" className={cn("flex w-full min-w-0 flex-col gap-2", !bare && cn(paper, "rounded-lg p-3"), className)} {...props}>
      {title || subtitle ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {title ? <span className="truncate text-sm font-medium text-ink">{title}</span> : null}
          {subtitle ? <span className="truncate text-xs text-ink-2">{subtitle}</span> : null}
        </div>
      ) : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="eyebrow self-baseline pt-px">{r.label}</dt>
            <dd
              className={cn("min-w-0 truncate text-end", r.typed ? cn(mono, "tnum") : "text-sm", r.emphasis ? "font-medium text-ink" : "text-ink-2")}
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
