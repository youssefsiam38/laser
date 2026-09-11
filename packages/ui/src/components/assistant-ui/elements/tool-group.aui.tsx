"use client";
import { useSearchReveal } from "@/components/thread/search-state";
/**
 * `tool-group` (assistant-ui registry), restyled: consecutive reasoning and
 * tool activity collapsed into one summary row — including mixed actions — with
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
import { useAui, useAuiState, useScrollLock, type MessagePrimitive } from "@assistant-ui/react";
import { ChevronRight, FilePen, FilePlus, FileText, FolderOpen, FolderSearch, ScanText, Search, SquareTerminal, Wrench } from "lucide-react";
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
import { ActivityBeam, ThinkingIndicator } from "@/components/assistant-ui/elements/thinking-indicator";
import {
  summarizeActivityGroup,
  type ActivityIconKind,
  type ReasoningActivity,
  type ToolGroupBreakdownItem,
  type ToolGroupMember,
  type ToolGroupSummary,
} from "@/components/thread/tool-groups";
import { useSessionMcpServers } from "@/agents/hooks";
import { diffStats, diffViewForTool, type DiffStats } from "@/components/thread/diff";
import { classifyMcpTool } from "@/components/thread/mcp-tools";
import { isNonZeroExit, resultDetails, resultText } from "@/components/thread/tool-summary";
import { markDone, markRunning, useElapsed } from "@/components/thread/timing";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { duration } from "@/format";
import { cn } from "@/lib/utils";
import { activityGroupDefaultOpen, toolDisplayResult, useActivityDetailLevel, useLaserState, type ActivityDetailLevel } from "@/runtime";
import { useActivityDisclosureOverride } from "@/runtime/sessionPreferences";

import { DiffStat, diffStatDescription } from "./code-diff.js";
import { ReasoningText } from "./reasoning.js";
import { activityRow, activityTrigger, collapsePanel, mono } from "./surfaces.js";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export const TOOL_ICONS: Record<ActivityIconKind, Icon> = {
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  bash: SquareTerminal,
  grep: Search,
  find: FolderSearch,
  ls: FolderOpen,
  other: Wrench,
  reasoning: ScanText,
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
  const reveal = useSearchReveal();
  const isOpen = reveal || (isControlled ? controlledOpen : uncontrolledOpen);

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
        activityRow, "group/toolgroup",
        // No rail for a failure, on purpose. A red bar down the side of the
        // block reads as "something is wrong with the app" for what is usually
        // an agent probing: a file that was not there, a command that came back
        // non-zero. The failure says so in its own text, inside. `attention`
        // keeps its rail — that one is a question waiting on a person.
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
  /** Said in the accessible name only: quiet is not the same as hidden. */
  failed?: boolean | undefined;
  attention?: boolean | undefined;
  elapsedMs?: number | undefined;
  /** One line per call, for the tooltip and the accessible name. */
  lines?: readonly string[] | undefined;
  /** Mixed activity: two complete category labels, then a count of other kinds. */
  breakdown?: readonly ToolGroupBreakdownItem[] | undefined;
  /** Exact currently running child action, rendered by the assistant-ui thinking indicator. */
  activeLabel?: string | undefined;
  /** Full-source changes from successfully completed edit/write children. */
  diffStats?: DiffStats | undefined;
  open?: boolean | undefined;
};

function ToolGroupTrigger({
  label,
  detail,
  icon,
  active = false,
  failed = false,
  attention = false,
  elapsedMs,
  lines,
  breakdown,
  activeLabel,
  diffStats: changes,
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
  const changeDescription = changes ? diffStatDescription(changes) : undefined;
  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      data-active={active || undefined}
      title={lines?.join("\n")}
      // Nothing here goes red for a failure, so the accessible name is where
      // a failure is still said out loud.
      aria-label={`${accessibleSummary}${changeDescription ? `, ${changeDescription}` : ""}.${failed ? " Something in it failed." : ""} ${open ? "Collapse" : "Expand"} details.`}
      className={cn(
        activityTrigger,
        className,
      )}
      {...props}
    >
      {active && <ActivityBeam />}
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {active ? (
          <StatusDot status="working" size="sm" aria-hidden="true" />
        ) : (
          <LeadIcon className={cn("size-3.5", attention ? "text-attention" : "text-ink-3")} />
        )}
      </span>
      <span className={cn("flex min-w-0 flex-1", !active && breakdown?.length ? "flex-col items-start gap-1 py-1.5" : "items-center gap-2 overflow-hidden")}>
        {active && activeLabel ? (
          <ThinkingIndicator
            label={activeLabel}
            dot={false}
            className="min-w-0 overflow-hidden [&_[data-slot=thinking-indicator-label]]:max-w-full [&_[data-slot=thinking-indicator-label]]:truncate"
          />
        ) : (
          <span data-slot="tool-group-trigger-label" className="min-w-0 break-words text-sm font-medium text-ink-2">
            {label}
          </span>
        )}
        {!active && !!breakdown?.length && (
          <span data-slot="tool-group-breakdown" aria-hidden="true" className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            {breakdown.slice(0, 2).map((item) => {
              const BreakdownIcon = TOOL_ICONS[item.iconKind];
              return (
                <span key={item.family} data-slot="tool-group-breakdown-item" className="inline-flex max-w-full items-center gap-1.5">
                  <BreakdownIcon className="size-3 shrink-0" />
                  <span className="break-words">{item.label}</span>
                </span>
              );
            })}
            {breakdown.length > 2 && <span data-slot="tool-group-breakdown-more" className="whitespace-nowrap">+{breakdown.length - 2} types</span>}
          </span>
        )}
        {!active && !breakdown?.length && detail ? (
          <span className={cn(mono, "min-w-0 truncate", active || attention ? "text-ink-2" : "text-ink-3")}>{detail}</span>
        ) : null}
      </span>
      {changes ? <DiffStat added={changes.added} removed={changes.removed} /> : null}
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
          "flex min-w-0 flex-col gap-1 border-t border-line py-1",
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
  /** The shared reasoning/tool activity node from `MessagePrimitive.GroupedParts`. */
  part: GroupPart;
  /** Stable wall-clock key for a live aggregate. */
  timingKey: string;
  /** The individual tool rows, rendered by the grouped-parts pipeline. */
  children: ReactNode;
}

const isSettled = (status: { type: string }): boolean => status.type === "complete" || status.type === "incomplete";

interface GroupActivity {
  members: ToolGroupMember[];
  reasoning: ReasoningActivity;
}

/** Projects the message's reasoning and tool parts into what the summary needs. */
function useGroupActivity(part: GroupPart): GroupActivity {
  const parts = useAuiState((s) => s.message.parts);
  // The aggregate names an MCP call the way its own row does, so the live line
  // reads "Using Playwright · browser navigate" rather than the registered
  // name (docs/mcp.md "In the transcript").
  const mcpServers = useSessionMcpServers(useLaserState((laser) => laser.current));
  return useMemo(() => {
    const out: ToolGroupMember[] = [];
    let reasoningCount = 0;
    let reasoningRunning = false;
    for (const index of part.indices) {
      const p = parts[index];
      if (!p) continue;
      if (p.type === "reasoning") {
        reasoningCount += 1;
        reasoningRunning ||= p.status.type === "running";
        continue;
      }
      if (p.type !== "tool-call") continue;
      const status = p.status;
      const running = status.type === "running";
      const awaiting = status.type === "requires-action";
      const isError = p.isError === true || (status.type === "incomplete" && status.reason !== "cancelled");
      const displayResult = toolDisplayResult(p);
      const view = status.type === "complete" && !isError && (p.toolName === "edit" || p.toolName === "write")
        ? diffViewForTool(p.toolName, p.args, resultDetails(displayResult))
        : undefined;
      const changes = view ? (view.stats ?? diffStats(view.hunks)) : undefined;
      const mcp = classifyMcpTool(p.toolName, resultDetails(displayResult), mcpServers);
      out.push({
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args,
        isError,
        // A command that ran and exited non-zero is a result: the aggregate
        // reads exactly as it would had it exited 0 (tool-summary.ts).
        nonZeroExit: isError && isNonZeroExit(p.toolName, true, resultText(displayResult)),
        running,
        awaiting,
        cancelled: status.type === "incomplete" && status.reason === "cancelled",
        ...(changes ? { diffStats: changes } : {}),
        ...(mcp ? { mcp } : {}),
      });
    }
    return { members: out, reasoning: { count: reasoningCount, running: reasoningRunning } };
  }, [part.indices, parts, mcpServers]);
}

function ToolGroupImpl({ part, timingKey, children }: ToolGroupProps) {
  const partCount = useAuiState((state) => state.message.parts.length);
  const messageStatus = useAuiState((state) => state.message.status?.type);
  const lastIndex = part.indices.at(-1);
  // A settled child does not end an activity span: the model may pause before
  // its next reasoning/tool step. The span ends only when another kind of
  // message part has committed after this adjacent group, or the turn itself
  // terminates. A decision remains live until it is answered.
  const spanRunning =
    lastIndex !== undefined &&
    lastIndex === partCount - 1 &&
    (messageStatus === "running" || messageStatus === "requires-action");
  const elapsed = useElapsed(timingKey, spanRunning ? "running" : "done");

  // Observe the group while it still has one child so a later aggregate starts
  // at the first reasoning/tool step. Keep the one-action presentation exactly
  // as it was: the child already owns its disclosure row.
  if (part.indices.length === 1) return children;

  return (
    <div className="my-2 flex flex-col first:mt-0 last:mb-0">
      <ToolGroupDetails part={part} timingKey={timingKey} elapsedMs={elapsed}>
        {children}
      </ToolGroupDetails>
    </div>
  );
}

function ToolGroupDetails({
  part,
  timingKey,
  elapsedMs,
  children,
}: ToolGroupProps & { elapsedMs: number | undefined }) {
  const { members, reasoning } = useGroupActivity(part);
  const path = useLaserState((state) => state.current);
  const activityLevel = useActivityDetailLevel(path);
  // Namer's early name for the call in flight (agents leap): the aggregate
  // says "Checking the test suite" while it runs and drops back to the
  // computed summary when the call ends. The store keeps the label per call
  // id, so only the running member's is read.
  const activeId = members.find((member) => member.running)?.toolCallId;
  const namerLabel = useLaserState((state) => (path !== undefined && activeId !== undefined ? state.open[path]?.namerLabels[activeId] : undefined));
  return (
    <ToolGroupSummaryRow
      members={members}
      reasoning={reasoning}
      activityLevel={activityLevel}
      timingKey={timingKey}
      groupStatus={part.status}
      elapsedMs={elapsedMs}
      activeLabel={namerLabel}
    >
      {children}
    </ToolGroupSummaryRow>
  );
}

export function ToolGroupSummaryRow({
  members,
  reasoning,
  activityLevel,
  timingKey,
  groupStatus,
  elapsedMs,
  activeLabel,
  children,
}: {
  members: readonly ToolGroupMember[];
  reasoning: ReasoningActivity;
  activityLevel: ActivityDetailLevel;
  timingKey: string;
  groupStatus: GroupPart["status"];
  /** Full wall-clock span supplied by the runtime-connected group. */
  elapsedMs?: number | undefined;
  /** A name for the call in flight that beats the computed one (Namer). */
  activeLabel?: string | undefined;
  children: ReactNode;
}) {
  const summary: ToolGroupSummary = useMemo(() => summarizeActivityGroup(members, reasoning), [members, reasoning]);
  const path = useLaserState((state) => state.current);
  const [manualOpen, rememberOpen] = useActivityDisclosureOverride(path, `group:${timingKey}`);
  const open = manualOpen ?? activityGroupDefaultOpen(activityLevel, reasoning.count > 0, summary.hasError || summary.hasDecision);

  // The rows inside are unmounted while collapsed, so the group keeps the
  // wall-clock marks their durations are read from (same keys as the rows).
  useEffect(() => {
    for (const m of members) {
      if (m.running || m.awaiting) markRunning(m.toolCallId);
      else markDone(m.toolCallId);
    }
  }, [members]);
  // A settled group that contains a failure is still a settled group. Nothing
  // about the block goes red — no rail, no icon, no count — because a failure
  // inside an agent's work is ordinary: a file it looked for and did not find,
  // a command that came back non-zero. What went wrong remains available on
  // the child row without forcing an Answers-only aggregate open.
  const failed = summary.hasError && isSettled(groupStatus);

  return (
    <ToolGroupRoot
      open={open}
      onOpenChange={rememberOpen}
      tone={summary.hasDecision ? "attention" : undefined}
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
        elapsedMs={elapsedMs}
        lines={summary.lines}
        breakdown={summary.breakdown}
        activeLabel={summary.running && activeLabel ? activeLabel : summary.activeLabel}
        diffStats={summary.diffStats}
        open={open}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}

/** Reasoning uses exactly the same reversible row as every other action. */
interface ActivityReasoningProps {
  running?: boolean;
  children: ReactNode;
  /** Stable identity supplied by non-runtime fixtures or alternate renderers. */
  disclosureId?: string;
}

function ActivityReasoningRow({ running = false, children, disclosureId }: Required<Pick<ActivityReasoningProps, "disclosureId">> & Omit<ActivityReasoningProps, "disclosureId">) {
  const path = useLaserState((state) => state.current);
  const level = useActivityDetailLevel(path);
  const [manualOpen, rememberOpen] = useActivityDisclosureOverride(path, `reasoning:${disclosureId}`);
  const open = manualOpen ?? level !== "answers";
  return (
    <ToolGroupRoot data-slot="activity-reasoning" open={open} onOpenChange={rememberOpen}>
      <ToolGroupTrigger label="Reasoning" icon={ScanText} active={running} activeLabel="Thinking" open={open} />
      <ToolGroupContent>
        <ReasoningText className="ms-0 max-h-none border-s-0 px-2 py-1">{children}</ReasoningText>
      </ToolGroupContent>
    </ToolGroupRoot>
  );
}

function RuntimeActivityReasoning(props: Omit<ActivityReasoningProps, "disclosureId">) {
  const aui = useAui();
  const messageId = useAuiState((state) => state.message.id);
  const query = aui.part.query;
  const partIdentity = query && "type" in query && query.type === "index" ? query.index : "unknown";
  return <ActivityReasoningRow {...props} disclosureId={`${messageId}:${partIdentity}`} />;
}

function ActivityReasoning({ disclosureId, ...props }: ActivityReasoningProps) {
  return disclosureId === undefined
    ? <RuntimeActivityReasoning {...props} />
    : <ActivityReasoningRow {...props} disclosureId={disclosureId} />;
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

export { ActivityReasoning, ToolGroup, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent };
