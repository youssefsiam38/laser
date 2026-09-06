"use client";
/**
 * `tool-group` (assistant-ui registry), restyled: consecutive tool calls
 * collapsed into one summary row — including mixed counted actions — with
 * a live thinking indicator and a chevron that opens every individual row in place (D-20 §4,
 * docs/ux-elements.md "Tool group"). This element IS that feature.
 *
 * The registry parts (Root / Trigger / Content) keep their contract: Root is
 * a Collapsible that locks the thread viewport while it animates, Content
 * staggers the rows in. What changed:
 *   - The trigger's label is not "N tool calls": it is the family summary
 *     from `tool-groups.ts` (pure, tested), in the row grammar every other
 *     tool row uses, with the call in flight as its typed fragment.
 *   - One design, no `variant` cva: the transcript has no boxed variant.
 *   - Durations, easing and colours are tokens; the 200ms constant is read
 *     from `--motion-fast`.
 *   - `ToolGroup` (default) takes the `group-tool` part from
 *     `MessagePrimitive.GroupedParts`, not the deprecated start/end indices.
 */
import { useAuiState, useScrollLock, type MessagePrimitive } from "@assistant-ui/react";
import { ChevronRight, CircleAlert, FilePen, FilePlus, FileText, FolderOpen, FolderSearch, Search, SquareTerminal, Wrench } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type ReactNode,
  type SVGProps,
} from "react";

import { StatusDot } from "@/components/status";
import { ThinkingIndicator } from "@/components/assistant-ui/elements/thinking-indicator";
import {
  summarizeToolGroup,
  toolGroupDefaultOpen,
  type ToolGroupBreakdownItem,
  type ToolGroupMember,
  type ToolGroupSummary,
} from "@/components/thread/tool-groups";
import { elapsedOf, markDone, markRunning, useTick } from "@/components/thread/timing";
import type { ToolKind } from "@/components/thread/tool-summary";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { duration } from "@/format";
import { cn } from "@/lib/utils";

import { collapsePanel, mono } from "./surfaces.js";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export const TOOL_ICONS: Record<ToolKind, Icon> = {
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  bash: SquareTerminal,
  grep: Search,
  find: FolderSearch,
  ls: FolderOpen,
  other: Wrench,
};

function motionFastMs(): number {
  if (typeof document === "undefined") return 0;
  const n = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--motion-fast"));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type ToolGroupRootProps = Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  defaultOpen?: boolean | undefined;
  tone?: "danger" | "attention" | undefined;
};

function ToolGroupRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  tone,
  children,
  ...props
}: ToolGroupRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [lockMs] = useState(motionFastMs);
  const lockScroll = useScrollLock(collapsibleRef, lockMs);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      lockScroll();
      if (!isControlled) setUncontrolledOpen(next);
      controlledOnOpenChange?.(next);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-group-root"
      data-tone={tone}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "group/toolgroup relative -mx-2 rounded-md px-2",
        tone === "danger" && "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-danger",
        tone === "attention" &&
          "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-attention",
        className,
      )}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export type ToolGroupTriggerProps = Omit<React.ComponentProps<typeof CollapsibleTrigger>, "children"> & {
  /** "Ran 2 commands", "Editing 3 files". */
  label: string;
  /** Typed fragment after the label: the live call, or "3 edits". */
  detail?: string | undefined;
  icon?: Icon | undefined;
  active?: boolean | undefined;
  failed?: boolean | undefined;
  attention?: boolean | undefined;
  /** "2 failed", shown while collapsed. */
  trailing?: string | undefined;
  elapsedMs?: number | undefined;
  /** One line per call, for the tooltip and the accessible name. */
  lines?: readonly string[] | undefined;
  /** Mixed activity: counted categories shown together on one line. */
  breakdown?: readonly ToolGroupBreakdownItem[] | undefined;
  /** Exact currently running child action, rendered by the assistant-ui thinking indicator. */
  activeLabel?: string | undefined;
  open?: boolean | undefined;
};

function ToolGroupTrigger({
  label,
  detail,
  icon,
  active = false,
  failed = false,
  attention = false,
  trailing,
  elapsedMs,
  lines,
  breakdown,
  activeLabel,
  open = false,
  className,
  ...props
}: ToolGroupTriggerProps) {
  const LeadIcon = icon ?? Wrench;
  const accessibleSummary =
    active && activeLabel
      ? activeLabel
      : breakdown?.length
        ? `${label}: ${breakdown.map((item) => item.label).join(", ")}`
        : `${label}${detail ? ` · ${detail}` : ""}`;
  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      title={lines?.join("\n")}
      aria-label={`${accessibleSummary}. ${open ? "Collapse to hide" : "Expand to show"} each call.`}
      className={cn(
        "group/trigger flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none",
        "transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live",
        className,
      )}
      {...props}
    >
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {active ? (
          <StatusDot status="working" size="sm" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert className="size-3.5 text-danger" />
        ) : (
          <LeadIcon className={cn("size-3.5", attention ? "text-attention" : "text-ink-3")} />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        {active && activeLabel ? (
          <ThinkingIndicator
            label={activeLabel}
            dot={false}
            className="min-w-0 overflow-hidden [&_[data-slot=thinking-indicator-label]]:max-w-full [&_[data-slot=thinking-indicator-label]]:truncate"
          />
        ) : (
          <span data-slot="tool-group-trigger-label" className="shrink-0 text-sm font-medium text-ink">
            {label}
          </span>
        )}
        {!active && breakdown?.map((item, index) => {
          const BreakdownIcon = TOOL_ICONS[item.iconKind];
          return (
            <span
              key={item.family}
              data-slot="tool-group-breakdown-item"
              className={cn(
                "flex min-w-0 shrink items-center gap-1.5 text-xs text-ink-2",
                index > 0 && "border-s border-line ps-2",
              )}
              aria-hidden="true"
            >
              <BreakdownIcon className="size-3 shrink-0 text-ink-3" />
              <span className="truncate">{item.label}</span>
              {item.detail ? <span className={cn(mono, "shrink-0 text-ink-3")}>· {item.detail}</span> : null}
            </span>
          );
        })}
        {!active && !breakdown?.length && detail ? (
          <span className={cn(mono, "min-w-0 truncate", active || attention ? "text-ink-2" : "text-ink-3")}>{detail}</span>
        ) : null}
      </span>
      {trailing && !open ? <span className={cn(mono, "shrink-0 text-danger")}>{trailing}</span> : null}
      <span
        aria-hidden="true"
        className="mt-px min-w-3 flex-1 self-center border-b border-dotted border-line transition-colors duration-(--motion-instant) group-hover/trigger:border-ink-3"
      />
      {elapsedMs !== undefined ? (
        <span className={cn(mono, "shrink-0 tnum", active ? "text-live" : "text-ink-3")}>{duration(elapsedMs)}</span>
      ) : null}
      <ChevronRight
        data-slot="tool-group-trigger-chevron"
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none",
          "group-data-[state=open]/trigger:rotate-90",
        )}
      />
    </CollapsibleTrigger>
  );
}

// ---------------------------------------------------------------------------
// Content — the rows grow out beneath the header, indented under its icon
// ---------------------------------------------------------------------------

function ToolGroupContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent data-slot="tool-group-content" className={cn(collapsePanel, "outline-none", className)} {...props}>
      <div
        className={cn(
          "ms-[7px] flex flex-col border-s border-line ps-[9px] pt-0.5 pb-1",
          "[&>*]:animate-in [&>*]:fade-in-0 [&>*]:fill-mode-both [&>*]:[animation-duration:var(--motion-fast)] [&>*]:ease-(--motion-ease)",
          "[&>*]:motion-reduce:animate-none",
          "[&>*:nth-child(2)]:[animation-delay:calc(var(--motion-instant)*0.5)]",
          "[&>*:nth-child(3)]:[animation-delay:var(--motion-instant)]",
          "[&>*:nth-child(n+4)]:[animation-delay:calc(var(--motion-instant)*1.5)]",
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

// ---------------------------------------------------------------------------
// The runtime-connected group
// ---------------------------------------------------------------------------

type GroupPart = MessagePrimitive.GroupedParts.GroupPart;

export interface ToolGroupProps {
  /** The `group-tool*` node from `MessagePrimitive.GroupedParts`. */
  part: GroupPart;
  /** The individual tool rows, rendered by the grouped-parts pipeline. */
  children: ReactNode;
}

const isSettled = (status: { type: string }): boolean => status.type === "complete" || status.type === "incomplete";

/** Projects the message's tool parts into what the summary needs. */
function useGroupMembers(part: GroupPart): ToolGroupMember[] {
  const parts = useAuiState((s) => s.message.parts);
  return useMemo(() => {
    const out: ToolGroupMember[] = [];
    for (const index of part.indices) {
      const p = parts[index];
      if (!p || p.type !== "tool-call") continue;
      const status = p.status;
      const running = status.type === "running";
      const awaiting = status.type === "requires-action";
      out.push({
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args,
        isError: p.isError === true || (status.type === "incomplete" && status.reason !== "cancelled"),
        running,
        awaiting,
        cancelled: status.type === "incomplete" && status.reason === "cancelled",
      });
    }
    return out;
  }, [part.indices, parts]);
}

function ToolGroupImpl({ part, children }: ToolGroupProps) {
  const members = useGroupMembers(part);
  if (members.length <= 1) return <>{children}</>;
  return (
    <ToolGroupSummaryRow members={members} groupStatus={part.status}>
      {children}
    </ToolGroupSummaryRow>
  );
}

function ToolGroupSummaryRow({
  members,
  groupStatus,
  children,
}: {
  members: readonly ToolGroupMember[];
  groupStatus: GroupPart["status"];
  children: ReactNode;
}) {
  const summary: ToolGroupSummary = useMemo(() => summarizeToolGroup(members), [members]);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? toolGroupDefaultOpen(summary);

  // The rows inside are unmounted while collapsed, so the group keeps the
  // wall-clock marks their durations are read from (same keys as the rows).
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
  const failures = members.filter((m) => m.isError).length;

  return (
    <ToolGroupRoot
      open={open}
      onOpenChange={setUserOpen}
      tone={failed ? "danger" : summary.hasDecision ? "attention" : undefined}
      data-family={summary.family}
      data-count={summary.count}
    >
      <ToolGroupTrigger
        label={summary.label}
        detail={summary.detail}
        icon={TOOL_ICONS[summary.iconKind]}
        active={summary.running}
        failed={failed}
        attention={summary.hasDecision}
        trailing={failures > 0 ? (failures === summary.count ? "failed" : `${failures} failed`) : undefined}
        elapsedMs={elapsed}
        lines={summary.lines}
        breakdown={summary.breakdown}
        activeLabel={summary.activeLabel}
        open={open}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}

const ToolGroup = memo(ToolGroupImpl) as unknown as FC<ToolGroupProps> & {
  Root: typeof ToolGroupRoot;
  Trigger: typeof ToolGroupTrigger;
  Content: typeof ToolGroupContent;
};

ToolGroup.displayName = "ToolGroup";
ToolGroup.Root = ToolGroupRoot;
ToolGroup.Trigger = ToolGroupTrigger;
ToolGroup.Content = ToolGroupContent;

export { ToolGroup, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent };
