"use client";
/**
 * Subagent list — THE fleet's list (docs/ux-elements.md "Agents"). One
 * session's tree (docs/ux-fleet.md "One session's tree"): the session's work
 * nested inside it exactly as it nests in reality, each row one piece of
 * work, and the row for the chat the person is reading marked as such.
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
 *   - A session that is closed here but whose work kept going says so, and
 *     a session that was deleted underneath its work says that instead.
 *   - `SubagentStrays` is the line at the bottom for work whose root session
 *     was deleted: it has no session to be seen in, so it is here, in every
 *     session's fleet, until it ends or is stopped.
 *
 * Presentation only: every value arrives on a {@link FleetItem}, and the two
 * actions are callbacks. The surfaces around it (the column and the phone's
 * sheet) own the data and the host.
 */
import { ChevronDown, FileX, RadioTower } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { STATUS_LABEL, StatusDot } from "@/components/status";
import { formatElapsed, shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { FLEET_STATE_LABEL, type FleetItem, type FleetProjectedGroup, type FleetProjectedItem, type FleetSections } from "@/fleet/model";

export type { FleetItem, FleetSections };

export type FleetSectionName = "active" | "finished";
export type FleetSurfaceName = "tree" | "strays";

/** A projected row's disclosure identity; canonical keys may exist in both sections and roles. */
export interface FleetDisclosure {
  surface: FleetSurfaceName;
  groupPath: string;
  section: FleetSectionName;
  key: string;
  role: "actual" | "context";
}

export interface SubagentListProps extends Omit<ComponentProps<"div">, "children" | "onToggle"> {
  sections: FleetSections;
  surface: FleetSurfaceName;
  /** The section-scoped row whose body is open, if any. */
  expanded: FleetDisclosure | undefined;
  /** The item key for the chat the person is reading, when it is in this tree. */
  currentKey?: string | undefined;
  onToggle(target: FleetDisclosure): void;
  /** The body of the open row: the surface owns what a run and a task show. */
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
  /** Put the finished work away. Absent when there is nothing this view can clear. */
  onClearFinished?: (() => void) | undefined;
}

export function SubagentList({ sections, surface, expanded, currentKey, onToggle, renderDetail, onClearFinished, className, ...props }: SubagentListProps) {
  const [finishedOpen, setFinishedOpen] = useState(false);

  // Opening a finished row from elsewhere (a task-exit notice) must not land
  // on a fold that hides it. Ordinary rerenders never override a manual fold.
  useEffect(() => {
    if (expanded?.surface === surface && expanded.section === "finished") setFinishedOpen(true);
  }, [expanded, surface]);

  return (
    <div data-slot="subagent-list" className={cn("flex flex-col", className)} {...props}>
      <FleetSectionHeader icon={RadioTower} label="In progress" count={sections.active.count} />
      {sections.active.groups.length > 0 ? (
        <FleetGroups
          groups={sections.active.groups}
          surface={surface}
          section="active"
          expanded={expanded}
          currentKey={currentKey}
          onToggle={onToggle}
          renderDetail={renderDetail}
        />
      ) : (
        <p className="px-4 py-5 text-sm leading-sm text-ink-3">Nothing is in progress.</p>
      )}

      {sections.finished.count > 0 && (
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
              <span className="tnum text-xs leading-xs">{sections.finished.count}</span>
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
            <FleetGroups
              groups={sections.finished.groups}
              surface={surface}
              section="finished"
              expanded={expanded}
              currentKey={currentKey}
              onToggle={onToggle}
              renderDetail={renderDetail}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function FleetSectionHeader({ icon: Icon, label, count }: { icon: typeof RadioTower; label: string; count: number }) {
  return (
    <header className="flex items-center gap-2 px-4 py-3">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-live" />
      <h3 className="text-xs leading-xs font-medium text-ink">{label}</h3>
      <span className="tnum text-xs leading-xs text-ink-3">{count}</span>
    </header>
  );
}

function FleetGroups({
  groups,
  surface,
  section,
  expanded,
  currentKey,
  onToggle,
  renderDetail,
}: {
  groups: readonly FleetProjectedGroup[];
  surface: FleetSurfaceName;
  section: FleetSectionName;
  expanded: FleetDisclosure | undefined;
  currentKey?: string | undefined;
  onToggle(target: FleetDisclosure): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
}) {
  return groups.map((projectedGroup) => {
    const group = projectedGroup.group;
    return (
      <section key={group.path} aria-label={group.title} data-slot="fleet-group" data-section={section} data-deleted={group.deleted || undefined}>
        {/* Opaque: DESIGN.md keeps glass out of the system, and a blurred
            header over a scrolling list is exactly the decoration it names. */}
        <header className="sticky top-0 z-10 flex items-baseline gap-2 bg-bg px-4 py-1.5 hairline-b">
          <h4 className="min-w-0 truncate text-xs leading-xs font-medium text-ink" title={group.deleted ? group.path : undefined}>
            {group.title}
          </h4>
          {group.cwd && <span className="eyebrow shrink-0">{shortCwd(group.cwd)}</span>}
          {group.deleted ? (
            // Deleted, not closed: there is no session to open, so the header
            // says what the work lost rather than implying a way back to it.
            <span className="shrink-0 text-xs leading-xs text-ink-3" title="This session was deleted; its work kept going.">
              session deleted
            </span>
          ) : group.orphaned ? (
            <span className="shrink-0 text-xs leading-xs text-ink-3" title="This session is closed here; its work kept going.">
              session closed
            </span>
          ) : null}
        </header>
        <ul role="list" className="flex flex-col gap-1.5 px-2 py-2">
          {projectedGroup.items.map((item) => (
            <FleetBranch
              key={`${section}:${item.item.key}`}
              item={item}
              target={{ surface, groupPath: group.path, section, key: item.item.key, role: item.contextOnly ? "context" : "actual" }}
              expanded={expanded}
              currentKey={currentKey}
              onToggle={onToggle}
              renderDetail={renderDetail}
            />
          ))}
        </ul>
      </section>
    );
  });
}

export interface SubagentStraysProps extends Omit<ComponentProps<"div">, "children" | "onToggle"> {
  /** Projected groups whose root session was deleted. */
  sections: FleetSections;
  expanded: FleetDisclosure | undefined;
  onToggle(target: FleetDisclosure): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
  /** Put its finished work away. Absent when nothing here has finished. */
  onClearFinished?: (() => void) | undefined;
}

/**
 * Work whose root session was deleted (docs/ux-fleet.md, "Work whose session
 * is gone"). A deleted root cannot be navigated to, so this work would be
 * invisible everywhere while still running and still spending; instead it is
 * one line at the bottom of every fleet, saying what it is and how many, and
 * opening into the same rows — with the same Stop — as the tree above it.
 *
 * A line, not a group at the top: it is not about the session being read,
 * and putting it first would make every fleet start with someone else's
 * leftovers. Closed by default; a reveal that lands inside it opens it.
 */
export function SubagentStrays({ sections, expanded, onToggle, renderDetail, onClearFinished, className, ...props }: SubagentStraysProps) {
  const [open, setOpen] = useState(false);
  const count = sections.active.count + sections.finished.count;
  const running = sections.active.running;
  const needsYou = sections.active.needsYou;

  useEffect(() => {
    if (expanded?.surface === "strays") setOpen(true);
  }, [expanded]);

  if (count === 0) return null;
  const roots = new Set([...sections.active.groups, ...sections.finished.groups].map((group) => group.group.path));
  const sessions = roots.size;
  const what = `${count} ${count === 1 ? "piece" : "pieces"} of work from ${sessions === 1 ? "a deleted session" : `${sessions} deleted sessions`}`;
  // The second line is the one thing to know: whether it is still costing.
  const why =
    needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you. It has no session to answer in; its own chat still opens from here.`
    : running > 0 ? `${running} still going, and still costing. End it here, or let it finish.`
    : "Finished. Clear puts it away.";

  return (
    <div data-slot="fleet-strays" className={cn("hairline-t", className)} {...props}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center">
          <CollapsibleTrigger
            data-slot="fleet-strays-toggle"
            className="group/strays flex min-h-11 min-w-0 flex-1 items-center gap-2.5 ps-4 pe-2 py-3 text-start outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
          >
            <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
              <FileX aria-hidden="true" className="size-4" />
              {(running > 0 || needsYou > 0) && (
                <StatusDot status={needsYou > 0 ? "waiting_for_input" : "working"} label={needsYou > 0 ? "Asking" : "Working"} className="absolute -end-1 -top-1" />
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="min-w-0 truncate text-xs leading-xs font-medium text-ink-2">{what}</span>
              {/* Wraps rather than truncates: a phone has no tooltip to put the rest in. */}
              <span className="line-clamp-2 min-w-0 text-xs leading-xs text-ink-3">{why}</span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) group-data-[state=open]/strays:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          {onClearFinished && (
            <button
              type="button"
              data-slot="fleet-strays-clear"
              onClick={onClearFinished}
              className="me-2 shrink-0 rounded-md px-2 py-1 text-xs leading-xs text-ink-3 outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink-2 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Clear
            </button>
          )}
        </div>
        <CollapsibleContent>
          <SubagentList
            sections={sections}
            surface="strays"
            expanded={expanded}
            onToggle={onToggle}
            renderDetail={renderDetail}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

const sameDisclosure = (left: FleetDisclosure | undefined, right: FleetDisclosure): boolean =>
  left?.surface === right.surface &&
  left.groupPath === right.groupPath &&
  left.section === right.section &&
  left.key === right.key &&
  left.role === right.role;

/** One subtree. Nested lists keep lineage intact in both the DOM and the paint. */
function FleetBranch({
  item,
  target,
  nested = false,
  expanded,
  currentKey,
  onToggle,
  renderDetail,
}: {
  item: FleetProjectedItem;
  target: FleetDisclosure;
  nested?: boolean;
  expanded: FleetDisclosure | undefined;
  currentKey?: string | undefined;
  onToggle(target: FleetDisclosure): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
}) {
  const source = item.item;
  return (
    <li
      data-slot="fleet-branch"
      className={cn(
        "relative min-w-0",
        nested && "before:absolute before:-start-3 before:top-5 before:h-px before:w-3 before:bg-line before:content-['']",
      )}
    >
      <FleetRow item={item} expanded={sameDisclosure(expanded, target)} current={currentKey === source.key} onToggle={() => onToggle(target)} renderDetail={renderDetail} />
      {item.children.length > 0 && (
        <ul role="list" aria-label={`Work ${source.title} started`} className="relative ms-4 mt-1.5 flex flex-col gap-1.5 border-s border-line ps-3">
          {item.children.map((child) => (
            <FleetBranch
              key={`${target.section}:${child.item.key}`}
              item={child}
              target={{ ...target, key: child.item.key, role: child.contextOnly ? "context" : "actual" }}
              nested
              expanded={expanded}
              currentKey={currentKey}
              onToggle={onToggle}
              renderDetail={renderDetail}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One piece of work. The row grows its detail in place rather than replacing
 * itself, so the dot keeps ticking and the row keeps its position.
 *
 * `current` is the row for the chat the person is reading: the same treatment
 * the sessions column gives the open session — a filled ground and a word —
 * because "which of these am I in" is the first thing this column answers
 * when a child is open.
 */
function FleetRow({
  item,
  expanded,
  current = false,
  onToggle,
  renderDetail,
}: {
  item: FleetProjectedItem;
  expanded: boolean;
  current?: boolean;
  onToggle(): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);

  const source = item.item;
  const label = FLEET_STATE_LABEL[source.state];
  const rolledUp = item.contextOnly || item.attention !== source.own;
  const dotLabel = rolledUp ? `${STATUS_LABEL[item.attention]} below` : label;
  // Context carries lineage, not membership. Its own activity, reason and live
  // elapsed would make a Working parent look filed under Finished.
  const line = item.contextOnly ? "Parent of work shown here." : (source.activity ?? source.terminalReason ?? source.subtitle);

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
        <StatusDot status={item.attention} label={dotLabel} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn("min-w-0 truncate text-sm leading-sm font-medium", item.contextOnly ? "text-ink-2" : "text-ink")}>{source.title}</span>
            <span className="shrink-0 text-xs leading-xs text-ink-3">{source.kind === "task" ? "command" : label}</span>
            {item.contextOnly && <span className="eyebrow shrink-0 text-ink-3">context</span>}
            {current && (
              <span className="eyebrow shrink-0 text-ink-2" title="The chat you are reading">
                reading
              </span>
            )}
          </span>
          {line && (
            <span className={cn("min-w-0 truncate text-xs leading-xs", !item.contextOnly && source.state === "failed" ? "text-danger" : "text-ink-2")} title={line}>
              {line}
            </span>
          )}
        </span>
        {!item.contextOnly && source.elapsedMs !== undefined && <span className="typed shrink-0 tnum text-xs leading-xs text-ink-3">{formatElapsed(source.elapsedMs)}</span>}
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", expanded && "rotate-180")}
        />
      </button>
      {expanded && <div className="min-w-0 px-3 pb-3 hairline-t pt-3">{renderDetail(source, item.contextOnly)}</div>}
    </div>
  );
}
