import { CornerDownRight, GitFork, Milestone, Tag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { clockTime, dateTime } from "@/format";
import { cn } from "@/lib/utils";

import { HISTORY_KIND_LABEL, type HistoryRow } from "./model.js";

export interface HistoryTreeProps {
  rows: readonly HistoryRow[];
  onFork(entryId: string): void;
  onJump(entryId: string): void;
  /** Disables fork/jump while a turn is running. */
  busy: boolean;
}

const INDENT = 12;
const GUTTER = 16;

/**
 * The session's persisted entries as a tree: side branches indent, a corner
 * glyph marks where each one starts, labels ride on their target entry.
 * Fork = new session with everything before this entry (its text goes to the
 * composer); jump = move this session's cursor here.
 */
export function HistoryTree({ rows, onFork, onJump, busy }: HistoryTreeProps) {
  if (rows.length === 0) {
    return (
      <p className="px-4 pb-4 text-xs leading-4 text-ink-3">
        Nothing persisted yet. Pi writes the session file on the first message.
      </p>
    );
  }
  return (
    <ol role="list" className="pb-2">
      {rows.map((row) => (
        <HistoryRowView key={row.id} row={row} busy={busy} onFork={onFork} onJump={onJump} />
      ))}
    </ol>
  );
}

function HistoryRowView({
  row,
  busy,
  onFork,
  onJump,
}: {
  row: HistoryRow;
  busy: boolean;
  onFork(entryId: string): void;
  onJump(entryId: string): void;
}) {
  const primary = row.kind === "user" || row.kind === "assistant";
  const meta = row.kind === "name" || row.kind === "model" || row.kind === "thinking";
  return (
    <li
      className="group relative flex gap-2 py-1.5 pe-3 hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)]"
      style={{ paddingInlineStart: GUTTER + row.depth * INDENT }}
    >
      {Array.from({ length: row.depth }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-line"
          style={{ insetInlineStart: GUTTER + i * INDENT + 5 }}
        />
      ))}
      <span className="mt-[3px] flex size-3 shrink-0 items-center justify-center">
        {row.branchStart ? (
          <CornerDownRight className="size-3 text-ink-3" aria-label="Branch starts here" />
        ) : (
          <span aria-hidden="true" className={cn("size-1 rounded-full", primary ? "bg-ink-3" : "bg-line")} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex h-4 items-center gap-1.5">
          <span className={cn("eyebrow leading-4", row.kind === "user" && "text-ink-2")}>
            {HISTORY_KIND_LABEL[row.kind]}
          </span>
          {row.tools > 0 && (
            <span className="font-mono text-xs leading-4 text-ink-3 tnum">
              · {row.tools} tool{row.tools === 1 ? "" : "s"}
            </span>
          )}
          {row.label && (
            <Badge variant="live" className="h-[18px] gap-1 px-1.5 text-xs leading-none">
              <Tag className="size-2.5" aria-hidden="true" />
              {row.label}
            </Badge>
          )}
          <span className="ms-auto flex items-center gap-0.5">
            {row.at && (
              <time
                dateTime={row.at}
                title={dateTime(row.at)}
                className="font-mono text-xs leading-4 text-ink-3 tnum group-hover:hidden group-focus-within:hidden [@media(pointer:coarse)]:hidden"
              >
                {clockTime(row.at)}
              </time>
            )}
            {(row.canFork || row.canJump) && (
              <span className="-my-1 hidden items-center group-hover:flex group-focus-within:flex [@media(pointer:coarse)]:flex">
                {row.canFork && (
                  <TooltipIconButton
                    tooltip="Fork here"
                    size="icon-xs"
                    side="left"
                    className="text-ink-3"
                    disabled={busy}
                    onClick={() => onFork(row.id)}
                  >
                    <GitFork />
                  </TooltipIconButton>
                )}
                {row.canJump && (
                  <TooltipIconButton
                    tooltip="Jump here"
                    size="icon-xs"
                    side="left"
                    className="text-ink-3"
                    disabled={busy}
                    onClick={() => onJump(row.id)}
                  >
                    <Milestone />
                  </TooltipIconButton>
                )}
              </span>
            )}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 line-clamp-2 text-xs leading-4 break-words",
            primary ? "text-ink" : "text-ink-2",
            meta && "font-mono text-xs",
          )}
        >
          {row.text || <span className="text-ink-3">{row.tools > 0 ? "Tool calls only" : "No text"}</span>}
        </p>
      </div>
    </li>
  );
}
