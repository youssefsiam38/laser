"use client";
/**
 * Subagent list — THE fleet sheet's list (docs/ux-elements.md "Agents":
 * "every run across projects"). Installed from `elements-subagent-list` and
 * fed the run tree of every session that has panels: a section per session,
 * chronological parent/child subtrees inside it, each row a run.
 *
 * Divergences from the registry copy, which was a stack of name / model /
 * fake-percentage cards:
 *   - A row IS the island the dock uses, at compact size, expanding in place.
 *     Same element, same four sizes, less room — the shape of the whole panel
 *     system, with no second implementation of a run here. The compact header
 *     already carries the model-free honest values: elapsed, phase, cost.
 *   - No progress bars: none of the run producers has a percentage
 *     (docs/ux-panels.md "Nobody has a progress percentage"); a run that
 *     declares `progress` draws it inside its own body when expanded.
 *   - Parentage is structural: a child's list lives inside its parent's list
 *     item and a continuous lineage rail connects them. Attention rolls into
 *     the parent status but never pulls a child away from that subtree.
 *   - A session that is closed here but whose runs kept going says so.
 */
import { CheckCheck, ChevronDown, RadioTower } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { Island } from "@/panels/islands/Island";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { partitionRunRoots, runNodeIsTerminal, type RunNode } from "@/components/subagents/run-tree";

export interface FleetGroup {
  path: string;
  cwd: string;
  title: string;
  /** The session is not open in this client: its runs kept going without it. */
  orphaned: boolean;
  /** Chronological top-level runs; every descendant remains on its node. */
  roots: RunNode[];
  running: number;
}

const COLLAPSED_H = 44;
/**
 * How tall an expanded row grows: as much of the sheet as it can have, bounded
 * by what a run's body needs to lay out (the usage row, the output tail and its
 * encoding tabs) and by leaving the list itself visible above and below.
 *
 * A constant would be wrong at both ends — 440px inside an 85dvh sheet on a
 * 667px phone leaves about 130px for the header and every other row, and on a
 * 1200px monitor it wastes the rest of the sheet.
 */
const EXPANDED_MIN_H = 260;
const EXPANDED_MAX_H = 520;
/** Room kept for the sheet header and at least a couple of collapsed rows. */
const RESERVED_H = 180;

/** How tall an expanded row may grow in this window, kept between its bounds. */
function useExpandedHeight(): number {
  const [height, setHeight] = useState(EXPANDED_MIN_H);
  useEffect(() => {
    const measure = () => {
      const sheet = (globalThis.innerHeight ?? 0) * 0.85;
      setHeight(Math.round(Math.min(EXPANDED_MAX_H, Math.max(EXPANDED_MIN_H, sheet - RESERVED_H))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return height;
}

export function SubagentList({
  groups,
  expandedId,
  onToggle,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "onToggle"> & {
  groups: readonly FleetGroup[];
  /** The panel id whose row is open, if any. */
  expandedId: string | undefined;
  onToggle(id: string): void;
}) {
  const expandedHeight = useExpandedHeight();
  const [finishedOpen, setFinishedOpen] = useState(true);
  const partition = useMemo(() => partitionGroups(groups), [groups]);
  useEffect(() => {
    if (expandedId && partition.finished.some((group) => group.roots.some((root) => branchHas(root, expandedId)))) {
      setFinishedOpen(true);
    }
  }, [expandedId, partition.finished]);

  return (
    <div data-slot="subagent-list" className={cn("flex flex-col", className)} {...props}>
      <FleetSectionHeader icon={RadioTower} label="In progress" count={partition.activeCount} />
      {partition.active.length > 0 ? (
        <FleetGroups groups={partition.active} expandedId={expandedId} expandedHeight={expandedHeight} onToggle={onToggle} />
      ) : (
        <p className="px-4 py-5 text-sm text-ink-3">Nothing is in progress.</p>
      )}

      {partition.finishedCount > 0 && (
        <Collapsible open={finishedOpen} onOpenChange={setFinishedOpen} className="hairline-t">
          <CollapsibleTrigger className="group/finished flex w-full items-center gap-2 px-4 py-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset">
            <CheckCheck aria-hidden="true" className="size-4 shrink-0 text-ok" />
            <span className="text-xs font-medium text-ink">Finished</span>
            <span className="tnum text-xs text-ink-3">{partition.finishedCount}</span>
            <ChevronDown aria-hidden="true" className="ms-auto size-4 text-ink-3 transition-transform duration-(--motion-fast) group-data-[state=open]/finished:rotate-180 motion-reduce:transition-none" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <FleetGroups groups={partition.finished} expandedId={expandedId} expandedHeight={expandedHeight} onToggle={onToggle} />
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
      <h3 className="text-xs font-medium text-ink">{label}</h3>
      <span className="tnum text-xs text-ink-3">{count}</span>
    </header>
  );
}

function FleetGroups({
  groups,
  expandedId,
  expandedHeight,
  onToggle,
}: {
  groups: readonly FleetGroup[];
  expandedId: string | undefined;
  expandedHeight: number;
  onToggle(id: string): void;
}) {
  return groups.map((group) => (
    <section key={group.path} aria-label={group.title}>
      {/* Opaque: DESIGN.md keeps glass out of the system, and a blurred
          header over a scrolling list is exactly the decoration it names. */}
      <header className="sticky top-0 z-10 flex items-baseline gap-2 bg-bg px-4 py-1.5 hairline-b">
        <h4 className="min-w-0 truncate text-xs font-medium text-ink">{group.title}</h4>
        {group.cwd && <span className="eyebrow shrink-0">{shortCwd(group.cwd)}</span>}
        {group.orphaned && (
          <span className="shrink-0 text-xs text-ink-3" title="This session is closed here; its runs kept going.">
            session closed
          </span>
        )}
      </header>
      <ul role="list" className="flex flex-col gap-2 px-2 py-2">
        {group.roots.map((node) => (
          <SubagentBranch key={node.key} node={node} expandedId={expandedId} expandedHeight={expandedHeight} onToggle={onToggle} />
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
    const roots = partitionRunRoots(group.roots);
    if (roots.active.length > 0) active.push({ ...group, roots: roots.active });
    if (roots.finished.length > 0) finished.push({ ...group, roots: roots.finished, running: 0 });
    for (const root of roots.active) activeCount += countWhere(root, (node) => !runNodeIsTerminal(node));
    for (const root of roots.finished) finishedCount += countWhere(root, runNodeIsTerminal);
  }
  return { active, finished, activeCount, finishedCount };
}

function countWhere(node: RunNode, predicate: (node: RunNode) => boolean): number {
  return (predicate(node) ? 1 : 0) + node.children.reduce((total, child) => total + countWhere(child, predicate), 0);
}

function branchHas(node: RunNode, id: string): boolean {
  return node.id === id || node.children.some((child) => branchHas(child, id));
}

/** One actual subtree. Nested lists keep lineage intact in both DOM and paint. */
function SubagentBranch({
  node,
  nested = false,
  expandedId,
  expandedHeight,
  onToggle,
}: {
  node: RunNode;
  nested?: boolean;
  expandedId: string | undefined;
  expandedHeight: number;
  onToggle(id: string): void;
}) {
  return (
    <li
      data-slot="subagent-branch"
      className={cn(
        "relative min-w-0",
        nested && "before:absolute before:-start-3 before:top-5 before:h-px before:w-3 before:bg-line before:content-['']",
      )}
    >
      <SubagentRow
        node={node}
        expanded={expandedId === node.id}
        expandedHeight={expandedHeight}
        onToggle={() => onToggle(node.id)}
      />
      {node.children.length > 0 ? (
        <ul
          role="list"
          aria-label={`${node.title} child runs`}
          className="relative ms-4 mt-1.5 flex flex-col gap-1.5 border-s border-line ps-3"
        >
          {node.children.map((child) => (
            <SubagentBranch
              key={child.key}
              node={child}
              nested
              expandedId={expandedId}
              expandedHeight={expandedHeight}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * One run. The island keeps its identity across the size change, so the dot
 * keeps ticking and the body keeps its scroll when you collapse it again.
 */
function SubagentRow({ node, expanded, onToggle, expandedHeight }: { node: RunNode; expanded: boolean; onToggle(): void; expandedHeight: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);
  return (
    <div
      ref={ref}
      data-slot="subagent-row"
      style={{ height: expanded ? expandedHeight : COLLAPSED_H }}
      className="rounded-xl border border-line transition-[height] duration-(--motion-morph) ease-morph motion-reduce:transition-none"
      onClickCapture={(event) => {
        // The island's own header button toggles size inside the dock; in a
        // list the row owns that, so a click on the island's toggle — and on
        // the inert header behind it — collapses or expands here instead.
        //
        // Every *other* control has to survive: a compact island's primary
        // action is a Button with a `title` and no `aria-label`, so an
        // exclusion written in terms of `aria-label` swallowed Stop and toggled
        // the row instead. The test is the island's own toggle, by its marker.
        const target = event.target as HTMLElement;
        if (!target.closest("[data-island-header]")) return;
        const isToggle = target.closest("[data-island-toggle]") !== null;
        const isControl = target.closest("button, a, input, textarea, select, [role='menuitem']") !== null;
        if (!isToggle && isControl) return;
        event.stopPropagation();
        onToggle();
      }}
    >
      <Island entry={node.entry} size={expanded ? "expanded" : "compact"} frame="sheet" />
    </div>
  );
}
