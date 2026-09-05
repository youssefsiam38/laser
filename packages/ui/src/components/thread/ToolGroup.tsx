import { useAuiState, type MessagePrimitive } from "@assistant-ui/react";
import { ChevronRight, CircleAlert, FilePen, FilePlus, FileText, FolderOpen, FolderSearch, Search, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType, type ReactNode, type SVGProps } from "react";

import { StatusDot } from "@/components/status";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { duration } from "@/format";
import { cn } from "@/lib/utils";
import { elapsedOf, markDone, markRunning, useTick } from "./timing.js";
import { summarizeToolGroup, toolGroupDefaultOpen, type ToolGroupMember } from "./tool-groups.js";
import type { ToolKind } from "./tool-summary.js";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const ICONS: Record<ToolKind, Icon> = {
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  bash: SquareTerminal,
  grep: Search,
  find: FolderSearch,
  ls: FolderOpen,
  other: Wrench,
};

type GroupPart = MessagePrimitive.GroupedParts.GroupPart;

export interface ToolGroupProps {
  /** The `group-tool` node from `MessagePrimitive.GroupedParts`. */
  part: GroupPart;
  /** The individual `ToolRow`s, rendered by the grouped-parts pipeline. */
  children: ReactNode;
}

const isSettled = (status: { type: string }): boolean => status.type === "complete" || status.type === "incomplete";

/**
 * Consecutive tool calls as ONE row by default — "Ran 2 commands", "Edited 3
 * files" — with a chevron that opens the individual rows in place (D-20 §4).
 * The summary row stays as the group's header when open, so the element the
 * eye is on never disappears; the rows grow out beneath it (Radix measures
 * the height, `animate-collapsible-*` plays it, and the global reduced-motion
 * rule makes that instant). A group holding an error or a pending decision
 * opens by default and carries the danger / attention hairline on its header.
 * A group of one renders as that call's row.
 */
export function ToolGroup({ part, children }: ToolGroupProps) {
  const parts = useAuiState((s) => s.message.parts);
  const members = useMemo<ToolGroupMember[]>(() => {
    const out: ToolGroupMember[] = [];
    for (const index of part.indices) {
      const p = parts[index];
      if (!p || p.type !== "tool-call") continue;
      const status = p.status;
      const running = status.type === "running";
      const awaiting = status.type === "requires-action";
      const failed = p.isError === true || (status.type === "incomplete" && status.reason !== "cancelled");
      out.push({
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args,
        isError: failed,
        running,
        awaiting,
        cancelled: status.type === "incomplete" && status.reason === "cancelled",
      });
    }
    return out;
  }, [part.indices, parts]);

  if (members.length <= 1) return <>{children}</>;
  return <ToolGroupRow members={members} groupStatus={part.status}>{children}</ToolGroupRow>;
}

function ToolGroupRow({
  members,
  groupStatus,
  children,
}: {
  members: readonly ToolGroupMember[];
  groupStatus: GroupPart["status"];
  children: ReactNode;
}) {
  const summary = useMemo(() => summarizeToolGroup(members), [members]);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? toolGroupDefaultOpen(summary);

  // The rows inside are unmounted while collapsed, so the group keeps the
  // wall-clock marks their durations are read from (same keys as ToolRow).
  useEffect(() => {
    for (const m of members) {
      if (m.running || m.awaiting) markRunning(m.toolCallId);
      else markDone(m.toolCallId);
    }
  }, [members]);
  useTick(summary.running);
  const elapsed = members.reduce<number | undefined>((total, m) => {
    const ms = elapsedOf(m.toolCallId);
    return ms === undefined ? total : (total ?? 0) + ms;
  }, undefined);

  const failed = summary.hasError && isSettled(groupStatus);
  const attention = summary.hasDecision;
  const failures = members.filter((m) => m.isError).length;
  const Icon = ICONS[summary.iconKind];
  const title = summary.lines.join("\n");

  return (
    <Collapsible
      open={open}
      onOpenChange={setUserOpen}
      data-slot="tool-group"
      data-family={summary.family}
      data-count={summary.count}
      className={cn(
        "group/toolgroup relative -mx-2 rounded-md px-2",
        failed && "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-danger",
        !failed && attention && "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-attention",
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={`${summary.label}${summary.detail ? ` · ${summary.detail}` : ""}. ${open ? "Collapse" : "Expand"} to ${open ? "hide" : "show"} each call.`}
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none",
            "transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            {summary.running ? (
              <StatusDot status="working" size="sm" aria-hidden="true" />
            ) : failed ? (
              <CircleAlert className="size-3.5 text-danger" />
            ) : (
              <Icon className={cn("size-3.5", attention ? "text-attention" : "text-ink-3")} />
            )}
          </span>
          <span className="shrink-0 text-sm font-medium text-ink">{summary.label}</span>
          {summary.detail ? (
            <span className={cn("typed min-w-0 truncate", summary.running || attention ? "text-ink-2" : "text-ink-3")}>
              {summary.detail}
            </span>
          ) : null}
          {failures > 0 && !open ? (
            <span className="typed shrink-0 text-danger">{failures === summary.count ? "failed" : `${failures} failed`}</span>
          ) : null}
          <span
            aria-hidden="true"
            className="mt-px min-w-3 flex-1 self-center border-b border-dotted border-line transition-colors duration-(--motion-instant) group-hover/toolgroup:border-ink-3"
          />
          {elapsed !== undefined ? (
            <span className={cn("typed shrink-0 tnum", summary.running ? "text-live" : "text-ink-3")}>{duration(elapsed)}</span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) ease-out motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none",
        )}
      >
        {/* Indented under the header's icon column, with a hairline so the rows read as its children. */}
        <div className="ms-[7px] flex flex-col border-s border-line ps-[9px] pb-1 pt-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
