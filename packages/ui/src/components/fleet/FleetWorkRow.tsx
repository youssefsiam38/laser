"use client";
/**
 * One collapsed fleet row: three lines in a 320px column (leap §3 A.1–A.2).
 * Kind is a shape. Line 2 is never the task brief.
 */
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { STATUS_LABEL, StatusDot } from "@/components/status";
import { Hint } from "@/components/ui/hint";
import {
  FLEET_STATE_LABEL,
  agentTintIndex,
  headlineText,
  type FleetHeadline,
  type FleetItem,
  type FleetProjectedItem,
  type FleetStrip,
  type FleetWorktreeChip,
} from "@/fleet";
import { BRANCH_BUDGET, PATH_BUDGET, isPathShaped, middleTruncate, suffixTruncate } from "@/fleet/truncate.js";
import { formatBytes, formatElapsed } from "@/format";
import { cn } from "@/lib/utils";

const AGENT_TINT = [
  "bg-fleet-agent-0",
  "bg-fleet-agent-1",
  "bg-fleet-agent-2",
  "bg-fleet-agent-3",
  "bg-fleet-agent-4",
  "bg-fleet-agent-5",
  "bg-fleet-agent-6",
  "bg-fleet-agent-7",
] as const;

export function FleetKindTile({ item }: { item: FleetItem }) {
  if (item.kind === "task") {
    return (
      <span
        data-slot="fleet-kind-tile"
        data-shape="square"
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-none bg-terminal font-mono text-xs leading-xs text-terminal-ink"
      >
        {">"}
      </span>
    );
  }
  const name = item.strip.kind === "agent" ? item.strip.agentName : item.title;
  const tint = AGENT_TINT[agentTintIndex(name)] ?? AGENT_TINT[0];
  return (
    <span
      data-slot="fleet-kind-tile"
      data-shape="round"
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg font-sans text-xs leading-xs font-medium text-on-fleet-agent",
        tint,
      )}
    >
      {item.initials ?? "?"}
    </span>
  );
}

function TruncatedValue({
  full,
  visible,
  className,
}: {
  full: string;
  visible: string;
  className?: string;
}) {
  const truncated = visible !== full;
  const node = (
    <span className={className} aria-label={full}>
      {visible}
    </span>
  );
  return truncated ? <Hint hint={full}>{node}</Hint> : node;
}

export function FleetHeadlineLine({ headline, failed }: { headline: FleetHeadline; failed: boolean }) {
  const full = headlineText(headline);
  const rest = headline.restIsPath ? middleTruncate(headline.text, PATH_BUDGET) : headline.text;
  const tone = failed ? "text-danger" : "text-ink-2";
  return (
    <span data-slot="fleet-headline" data-kind={headline.kind} className={cn("flex min-w-0 items-baseline gap-1", tone)} aria-label={full}>
      {headline.verb ? <span className="shrink-0 font-medium">{headline.verb}</span> : null}
      {headline.restIsPath ? (
        <TruncatedValue full={headline.text} visible={rest} className="typed min-w-0 truncate" />
      ) : (
        <span className="min-w-0 truncate">{headline.verb ? rest : full}</span>
      )}
    </span>
  );
}

function WorktreeChip({ chip }: { chip: FleetWorktreeChip }) {
  const full = chip.kind === "branch" ? chip.branch : "shared checkout";
  const visible = chip.kind === "branch" ? suffixTruncate(chip.branch, BRANCH_BUDGET) : "shared checkout";
  return (
    <TruncatedValue
      full={full}
      visible={visible}
      className="typed min-w-0"
    />
  );
}

export function FleetStripLine({ strip }: { strip: FleetStrip }) {
  if (strip.kind === "agent") {
    const parts: string[] = [strip.agentName];
    if (strip.model) parts.push(strip.model);
    if (strip.turns !== undefined) parts.push(`${strip.turns}t`);
    const worktreeFull = strip.worktree.kind === "branch" ? strip.worktree.branch : "shared checkout";
    const full = [...parts, worktreeFull].join(" · ");
    return (
      <span data-slot="fleet-strip" data-kind="agent" className="flex min-w-0 items-baseline gap-1 text-ink-3" aria-label={full}>
        <span className="typed min-w-0 truncate">{strip.agentName}</span>
        {strip.model ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="typed shrink-0">{strip.model}</span>
          </>
        ) : null}
        {strip.turns !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="typed tnum shrink-0">{strip.turns}t</span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <span data-slot="fleet-worktree-chip" data-mode={strip.worktree.kind} className="min-w-0">
          <WorktreeChip chip={strip.worktree} />
        </span>
      </span>
    );
  }
  const byteLabel = strip.bytes === undefined ? undefined : formatBytes(strip.bytes);
  const full = [strip.command, byteLabel, strip.clock].filter(Boolean).join(" · ");
  const commandVisible = isPathShaped(strip.command) ? middleTruncate(strip.command, PATH_BUDGET) : strip.command;
  return (
    <span data-slot="fleet-strip" data-kind="task" className="flex min-w-0 items-baseline gap-1 text-ink-3" aria-label={full}>
      <TruncatedValue full={strip.command} visible={commandVisible} className="typed min-w-0 truncate" />
      {byteLabel ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="typed tnum shrink-0">{byteLabel}</span>
        </>
      ) : null}
      {strip.clock ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="typed tnum shrink-0">{strip.clock}</span>
        </>
      ) : null}
    </span>
  );
}

export function FleetWorkRow({
  item,
  expanded,
  current = false,
  onToggle,
  renderDetail,
  askingActions,
}: {
  item: FleetProjectedItem;
  expanded: boolean;
  current?: boolean;
  onToggle(): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
  askingActions?: ReactNode | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);

  const source = item.item;
  const label = FLEET_STATE_LABEL[source.state];
  const rolledUp = item.contextOnly || item.attention !== source.own;
  const dotLabel = rolledUp ? `${STATUS_LABEL[item.attention]} below` : label;
  const headline = item.contextOnly ? undefined : source.headline;
  const elapsed = !item.contextOnly && source.elapsedMs !== undefined ? formatElapsed(source.elapsedMs) : undefined;
  const stripFull =
    !item.contextOnly && source.strip.kind === "agent"
      ? [source.strip.agentName, source.strip.model, source.strip.turns !== undefined ? `${source.strip.turns}t` : undefined, source.strip.worktree.kind === "branch" ? source.strip.worktree.branch : "shared checkout"].filter(Boolean).join(" · ")
      : !item.contextOnly && source.strip.kind === "task"
        ? [source.strip.command, source.strip.bytes !== undefined ? formatBytes(source.strip.bytes) : undefined, source.strip.clock].filter(Boolean).join(" · ")
        : undefined;
  const accessible = [
    source.title,
    item.contextOnly ? "Parent of work shown here." : headline ? headlineText(headline) : undefined,
    stripFull,
    elapsed,
    current ? "reading" : undefined,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <div
      ref={ref}
      data-slot="fleet-row"
      data-kind={source.kind}
      data-state={source.state}
      data-attention={item.attention}
      data-context={item.contextOnly || undefined}
      data-expanded={expanded || undefined}
      data-current={current || undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-line bg-surface text-ink",
        "transition-[border-color,box-shadow] duration-(--motion-instant) motion-reduce:transition-none",
        item.contextOnly && "bg-bg text-ink-2",
        current && "bg-surface-2",
        expanded && "border-live shadow-[0_0_0_1px_var(--live)]",
      )}
    >
      <div className="flex min-w-0 items-start gap-2 px-2 py-1.5">
        <FleetKindTile item={source} />
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={accessible}
          onClick={onToggle}
          className={cn(
            "flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-lg px-0.5 py-0 text-start outline-none",
            "transition-colors duration-(--motion-instant) hover:bg-surface-2",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
            "motion-reduce:transition-none",
          )}
        >
          <span className="mt-1.5 shrink-0">
            <StatusDot status={item.attention} label={dotLabel} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                data-slot="fleet-name"
                className={cn(
                  "min-w-0 truncate text-sm leading-sm font-medium",
                  source.kind === "task" && "typed font-normal",
                  item.contextOnly ? "text-ink-2" : "text-ink",
                )}
              >
                {source.title}
              </span>
              {item.contextOnly && <span className="eyebrow shrink-0 text-ink-3">context</span>}
              {current && (
                <span className="eyebrow shrink-0 text-ink-2" title="The chat you are reading">
                  reading
                </span>
              )}
              {elapsed ? (
                <span data-slot="fleet-elapsed" className="ms-auto typed shrink-0 tnum text-xs leading-xs text-ink-3">
                  {elapsed}
                </span>
              ) : null}
            </span>
            {item.contextOnly ? (
              <span className="min-w-0 truncate text-xs leading-xs text-ink-3">Parent of work shown here.</span>
            ) : headline ? (
              <FleetHeadlineLine headline={headline} failed={source.state === "failed"} />
            ) : null}
            {!item.contextOnly ? <FleetStripLine strip={source.strip} /> : null}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "mt-1.5 size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
        </button>
      </div>
      {askingActions}
      {expanded && <div className="min-w-0 px-3 pb-3 hairline-t pt-3">{renderDetail(source, item.contextOnly)}</div>}
    </div>
  );
}
