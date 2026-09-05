"use client";
/**
 * Checkpoints — "points you can fall back to, with what each one would give
 * back" (docs/ux-elements.md "Agents": Pi's session tree as checkpoint
 * history, M1-T9). Installed from `elements-checkpoint-history` and fed the
 * session's persisted entries as `HistoryRow`s: side branches indent, a corner
 * glyph marks where each one starts, labels ride on their target entry.
 *
 * Two ways back, because Pi has two: **jump** moves this session's cursor to
 * the entry (the element's "restore"); **fork** starts a new session with
 * everything before it and puts its text in the composer.
 *
 * Divergences from the registry copy:
 *   - A tree, not a list: depth and branch starts are drawn, because a Pi
 *     session forks.
 *   - Each row says what it is (You, Pi, Compaction…), how many tool calls it
 *     folded, its label and its time; "N files" is not something Pi records.
 *   - Restore became Jump and Fork, shown on hover and focus, always on touch.
 *   - The current entry is the live colour; nothing "ahead" is dimmed, since
 *     in a tree the leaf is not the last row.
 */
import { CornerDownRight, GitFork, Milestone, Tag } from "lucide-react";
import type { ComponentProps } from "react";

import { HISTORY_KIND_LABEL, type HistoryRow } from "@/components/shell/model";
import { Badge } from "@/components/ui/badge";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { clockTime, dateTime } from "@/format";
import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

const INDENT = 12;
const GUTTER = 16;

export interface CheckpointHistoryProps extends Omit<ComponentProps<"ol">, "children"> {
  rows: readonly HistoryRow[];
  /** The entry the session's cursor is on; defaults to the last jumpable row. */
  currentId?: string | undefined;
  onFork(entryId: string): void;
  onJump(entryId: string): void;
  /** Hides fork/jump while a turn is running: they would not work (R2). */
  busy: boolean;
}

export function CheckpointHistory({ rows, currentId, onFork, onJump, busy, className, ...props }: CheckpointHistoryProps) {
  if (rows.length === 0) {
    return <p className="px-4 pb-4 text-xs leading-xs text-ink-3">Nothing saved yet. The session file is written on the first message.</p>;
  }
  const current = currentId ?? [...rows].reverse().find((r) => r.canJump)?.id;
  return (
    <ol data-slot="checkpoint-history" role="list" className={cn("pb-2", className)} {...props}>
      {rows.map((row) => (
        <Row key={row.id} row={row} current={row.id === current} busy={busy} onFork={onFork} onJump={onJump} />
      ))}
    </ol>
  );
}

function Row({ row, current, busy, onFork, onJump }: { row: HistoryRow; current: boolean; busy: boolean; onFork(entryId: string): void; onJump(entryId: string): void }) {
  const primary = row.kind === "user" || row.kind === "assistant";
  const meta = row.kind === "name" || row.kind === "model" || row.kind === "thinking";
  const controls = !busy && (row.canFork || (row.canJump && !current));
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={cn(
        "group relative flex gap-2 py-1.5 pe-3 transition-colors duration-(--motion-instant)",
        current ? "bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)]" : "hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)]",
      )}
      style={{ paddingInlineStart: GUTTER + row.depth * INDENT }}
    >
      {Array.from({ length: row.depth }, (_, i) => (
        <span key={i} aria-hidden="true" className="absolute top-0 bottom-0 w-px bg-line" style={{ insetInlineStart: GUTTER + i * INDENT + 5 }} />
      ))}
      <span className="mt-[3px] flex size-3 shrink-0 items-center justify-center">
        {row.branchStart ? (
          <CornerDownRight className="size-3 text-ink-3" aria-label="Branch starts here" />
        ) : (
          <span aria-hidden="true" className={cn("rounded-full", current ? "size-2 bg-live" : primary ? "size-1 bg-ink-3" : "size-1 bg-line")} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex h-4 items-center gap-1.5">
          <span className={cn("eyebrow leading-xs", row.kind === "user" && "text-ink-2")}>{HISTORY_KIND_LABEL[row.kind]}</span>
          {row.tools > 0 && (
            <span className={cn(mono, "text-ink-3")}>
              · {row.tools} tool{row.tools === 1 ? "" : "s"}
            </span>
          )}
          {row.label && (
            <Badge variant="live" className="h-4.5 gap-1 px-1.5 text-xs leading-none">
              <Tag className="size-2.5" aria-hidden="true" />
              {row.label}
            </Badge>
          )}
          <span className="ms-auto flex items-center gap-0.5">
            {current && <span className={cn(mono, "text-live")}>current</span>}
            {row.at && (
              <time
                dateTime={row.at}
                title={dateTime(row.at)}
                className={cn(mono, "text-ink-3", controls && "group-hover:hidden group-focus-within:hidden [@media(pointer:coarse)]:hidden")}
              >
                {clockTime(row.at)}
              </time>
            )}
            {controls && (
              <span className="-my-1 hidden items-center group-hover:flex group-focus-within:flex [@media(pointer:coarse)]:flex">
                {row.canFork && (
                  <TooltipIconButton tooltip="Fork here" size="icon-xs" side="left" className="text-ink-3" onClick={() => onFork(row.id)}>
                    <GitFork />
                  </TooltipIconButton>
                )}
                {row.canJump && !current && (
                  <TooltipIconButton tooltip="Jump here" size="icon-xs" side="left" className="text-ink-3" onClick={() => onJump(row.id)}>
                    <Milestone />
                  </TooltipIconButton>
                )}
              </span>
            )}
          </span>
        </div>
        <p className={cn("mt-0.5 line-clamp-2 text-xs leading-xs break-words", primary ? "text-ink" : "text-ink-2", meta && "font-mono")}>
          {row.text || <span className="text-ink-3">{row.tools > 0 ? "Tool calls only" : "No text"}</span>}
        </p>
      </div>
    </li>
  );
}
