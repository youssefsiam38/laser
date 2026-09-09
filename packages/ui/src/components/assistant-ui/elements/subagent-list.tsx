"use client";
/**
 * Subagent list — THE fleet's list (docs/ux-elements.md "Agents": "every run
 * across projects"). A section per session, the session's work nested inside
 * it exactly as it nests in reality, each row one piece of work.
 *
 * Divergences from the registry copy, which was a stack of name / model /
 * fake-percentage cards:
 *   - No progress bars: none of the producers has a percentage. A row says
 *     what the work is doing in its own words, or it says nothing.
 *   - Parentage is structural: a child's list lives inside its parent's list
 *     item and a continuous lineage rail connects them. Attention rolls into
 *     the parent's dot but never pulls a child out of its subtree.
 *   - Two kinds of work in one list — a child agent and a background command —
 *     because from the person's side they are the same question.
 *   - A session that is closed here but whose work kept going says so.
 *
 * Presentation only: every value arrives on a {@link FleetItem}, and the two
 * actions are callbacks. The surfaces around it (the column and the phone's
 * sheet) own the data and the host.
 */
import { ChevronDown, RadioTower } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusDot } from "@/components/status";
import { formatElapsed, shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { FLEET_STATE_LABEL, partitionItems, type FleetGroup, type FleetItem } from "@/fleet/model";

export type { FleetGroup, FleetItem };

export interface SubagentListProps extends Omit<ComponentProps<"div">, "children" | "onToggle"> {
  groups: readonly FleetGroup[];
  /** The item key whose row is open, if any. */
  expandedKey: string | undefined;
  onToggle(key: string): void;
  /** The body of the open row: the surface owns what a run and a task show. */
  renderDetail(item: FleetItem): ReactNode;
  /** Put the finished work away. Absent when there is nothing this view can clear. */
  onClearFinished?: (() => void) | undefined;
}

export function SubagentList({ groups, expandedKey, onToggle, renderDetail, onClearFinished, className, ...props }: SubagentListProps) {
  const [finishedOpen, setFinishedOpen] = useState(false);
  const partition = useMemo(() => partitionGroups(groups), [groups]);

  // Opening a finished row from elsewhere (a task-exit notice) must not land
  // on a fold that hides it.
  useEffect(() => {
    if (expandedKey && partition.finished.some((group) => group.items.some((item) => branchHas(item, expandedKey)))) {
      setFinishedOpen(true);
    }
  }, [expandedKey, partition.finished]);

  return (
    <div data-slot="subagent-list" className={cn("flex flex-col", className)} {...props}>
      <FleetSectionHeader icon={RadioTower} label="In progress" count={partition.activeCount} />
      {partition.active.length > 0 ? (
        <FleetGroups groups={partition.active} expandedKey={expandedKey} onToggle={onToggle} renderDetail={renderDetail} />
      ) : (
        <p className="px-4 py-5 text-sm leading-sm text-ink-3">Nothing is in progress.</p>
      )}

      {partition.finishedCount > 0 && (
        <Collapsible open={finishedOpen} onOpenChange={setFinishedOpen} className="hairline-t">
          {/*
            Dimmed, and with no tick. A green double-check here said "done, well
            done" about the one thing that needs no attention, in an app where
            green means *happening now* (D-154). Finished work is a count you
            can open, and a Clear when you are finished with it.
          */}
          <div className="flex items-center">
            <CollapsibleTrigger className="group/finished flex min-h-11 min-w-0 flex-1 items-center gap-2 ps-4 pe-2 py-3 text-start text-ink-3 outline-none transition-colors duration-(--motion-instant) hover:text-ink-2 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset">
              <span className="text-xs leading-xs font-medium">Finished</span>
              <span className="tnum text-xs leading-xs">{partition.finishedCount}</span>
              <ChevronDown
                aria-hidden="true"
                className="ms-auto size-4 shrink-0 transition-transform duration-(--motion-fast) group-data-[state=open]/finished:rotate-180 motion-reduce:transition-none"
              />
            </CollapsibleTrigger>
            {onClearFinished && (
              <button
                type="button"
                data-slot="fleet-clear-finished"
                onClick={onClearFinished}
                className="me-2 shrink-0 rounded-md px-2 py-1 text-xs leading-xs text-ink-3 outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink-2 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Clear
              </button>
            )}
          </div>
          <CollapsibleContent>
            <FleetGroups groups={partition.finished} expandedKey={expandedKey} onToggle={onToggle} renderDetail={renderDetail} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function FleetSectionHeader({ icon: Icon, label, count }: { icon: typeof RadioTower; label: string; count: number }) {
  return (
    <header className="flex items-center gap-2 px-4 py-3">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-accent" />
      <h3 className="text-xs leading-xs font-medium text-ink">{label}</h3>
      <span className="tnum text-xs leading-xs text-ink-3">{count}</span>
    </header>
  );
}

function FleetGroups({
  groups,
  expandedKey,
  onToggle,
  renderDetail,
}: {
  groups: readonly FleetGroup[];
  expandedKey: string | undefined;
  onToggle(key: string): void;
  renderDetail(item: FleetItem): ReactNode;
}) {
  return groups.map((group) => (
    <section key={group.path} aria-label={group.title}>
      {/* Opaque: DESIGN.md keeps glass out of the system, and a blurred
          header over a scrolling list is exactly the decoration it names. */}
      <header className="sticky top-0 z-10 flex items-baseline gap-2 bg-bg px-4 py-1.5 hairline-b">
        <h4 className="min-w-0 truncate text-xs leading-xs font-medium text-ink">{group.title}</h4>
        {group.cwd && <span className="eyebrow shrink-0">{shortCwd(group.cwd)}</span>}
        {group.orphaned && (
          <span className="shrink-0 text-xs leading-xs text-ink-3" title="This session is closed here; its work kept going.">
            session closed
          </span>
        )}
      </header>
      <ul role="list" className="flex flex-col gap-1.5 px-2 py-2">
        {group.items.map((item) => (
          <FleetBranch key={item.key} item={item} expandedKey={expandedKey} onToggle={onToggle} renderDetail={renderDetail} />
        ))}
      </ul>
    </section>
  ));
}

function partitionGroups(groups: readonly FleetGroup[]): {
  active: FleetGroup[];
  finished: FleetGroup[];
  activeCount: number;
  finishedCount: number;
} {
  const active: FleetGroup[] = [];
  const finished: FleetGroup[] = [];
  let activeCount = 0;
  let finishedCount = 0;
  for (const group of groups) {
    const parts = partitionItems(group.items);
    if (parts.active.length > 0) active.push({ ...group, items: parts.active });
    if (parts.finished.length > 0) finished.push({ ...group, items: parts.finished, running: 0 });
    for (const item of parts.active) activeCount += countWhere(item, (candidate) => !candidate.terminal);
    for (const item of parts.finished) finishedCount += countWhere(item, (candidate) => candidate.terminal);
  }
  return { active, finished, activeCount, finishedCount };
}

function countWhere(item: FleetItem, predicate: (item: FleetItem) => boolean): number {
  return (predicate(item) ? 1 : 0) + item.children.reduce((total, child) => total + countWhere(child, predicate), 0);
}

function branchHas(item: FleetItem, key: string): boolean {
  return item.key === key || item.children.some((child) => branchHas(child, key));
}

/** One subtree. Nested lists keep lineage intact in both the DOM and the paint. */
function FleetBranch({
  item,
  nested = false,
  expandedKey,
  onToggle,
  renderDetail,
}: {
  item: FleetItem;
  nested?: boolean;
  expandedKey: string | undefined;
  onToggle(key: string): void;
  renderDetail(item: FleetItem): ReactNode;
}) {
  return (
    <li
      data-slot="fleet-branch"
      className={cn(
        "relative min-w-0",
        nested && "before:absolute before:-start-3 before:top-5 before:h-px before:w-3 before:bg-line before:content-['']",
      )}
    >
      <FleetRow item={item} expanded={expandedKey === item.key} onToggle={() => onToggle(item.key)} renderDetail={renderDetail} />
      {item.children.length > 0 && (
        <ul role="list" aria-label={`Work ${item.title} started`} className="relative ms-4 mt-1.5 flex flex-col gap-1.5 border-s border-line ps-3">
          {item.children.map((child) => (
            <FleetBranch key={child.key} item={child} nested expandedKey={expandedKey} onToggle={onToggle} renderDetail={renderDetail} />
          ))}
        </ul>
      )}
    </li>
  );
}

const DOT_STATUS = {
  queued: "working",
  running: "working",
  blocked: "waiting_for_input",
  completed: "finished_unread",
  failed: "error",
  cancelled: "idle",
} as const;

/**
 * One piece of work. The row grows its detail in place rather than replacing
 * itself, so the dot keeps ticking and the row keeps its position.
 */
function FleetRow({
  item,
  expanded,
  onToggle,
  renderDetail,
}: {
  item: FleetItem;
  expanded: boolean;
  onToggle(): void;
  renderDetail(item: FleetItem): ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);

  const label = FLEET_STATE_LABEL[item.state];
  // The one line under the name: what it is doing, else why it ended, else
  // what it was asked to do. Never all three — this is a row, not a record.
  const line = item.activity ?? item.terminalReason ?? item.subtitle;

  return (
    <div
      ref={ref}
      data-slot="fleet-row"
      data-kind={item.kind}
      data-state={item.state}
      data-expanded={expanded || undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-line bg-surface text-ink",
        "transition-[border-color,box-shadow] duration-(--motion-instant) motion-reduce:transition-none",
        expanded && "border-live shadow-[0_0_0_1px_var(--live)]",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start outline-none",
          "transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          "motion-reduce:transition-none",
        )}
      >
        <StatusDot status={DOT_STATUS[item.state]} label={label} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm leading-sm font-medium text-ink">{item.title}</span>
            <span className="shrink-0 text-xs leading-xs text-ink-3">{item.kind === "task" ? "command" : label}</span>
          </span>
          {line && (
            <span className={cn("min-w-0 truncate text-xs leading-xs", item.state === "failed" ? "text-danger" : "text-ink-2")} title={line}>
              {line}
            </span>
          )}
        </span>
        {item.elapsedMs !== undefined && <span className="typed shrink-0 tnum text-xs leading-xs text-ink-3">{formatElapsed(item.elapsedMs)}</span>}
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", expanded && "rotate-180")}
        />
      </button>
      {expanded && <div className="min-w-0 px-3 pb-3 hairline-t pt-3">{renderDetail(item)}</div>}
    </div>
  );
}
