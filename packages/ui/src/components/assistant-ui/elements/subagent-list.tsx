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
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";

import { FleetFilters } from "@/components/fleet/FleetFilters.js";
import { FleetWorkRow } from "@/components/fleet/FleetWorkRow.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusDot } from "@/components/status";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import {
  GROUP_TITLE_BUDGET,
  filterFleetSections,
  fleetFilterCounts,
  fleetFilterIsRestricting,
  middleTruncate,
  type FleetFilter,
  type FleetGroup,
  type FleetItem,
  type FleetProjectedGroup,
  type FleetProjectedItem,
  type FleetSections,
} from "@/fleet";

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
  /** Answer / Open on a live `needs_input` row. Absent on context and on commands. */
  renderAskingActions?: ((item: FleetItem) => ReactNode) | undefined;
  /** Put the finished work away. Absent when there is nothing this view can clear. */
  onClearFinished?: (() => void) | undefined;
  /** Show Going · Asking · Ended chips. The tree list does; strays do not. */
  filters?: boolean;
  /** Lifted filter, shared by the column and the sheet and persisted. */
  filter?: FleetFilter;
  onFilterChange?: ((next: FleetFilter) => void) | undefined;
}

export function SubagentList({ sections, surface, expanded, currentKey, onToggle, renderDetail, renderAskingActions, onClearFinished, filters = false, filter, onFilterChange, className, ...props }: SubagentListProps) {
  const [finishedOpen, setFinishedOpen] = useState(false);
  const counts = useMemo(() => fleetFilterCounts(sections), [sections]);
  const visible = useMemo(() => (filters && filter ? filterFleetSections(sections, filter) : sections), [filter, filters, sections]);

  // Opening a finished row from elsewhere (a task-exit notice) must not land
  // on a fold that hides it. Ordinary rerenders never override a manual fold.
  useEffect(() => {
    if (expanded?.surface === surface && expanded.section === "finished") setFinishedOpen(true);
  }, [expanded, surface]);

  return (
    <div data-slot="subagent-list" className={cn("flex flex-col", className)} {...props}>
      {filters && filter && onFilterChange ? <FleetFilters filter={filter} counts={counts} onChange={onFilterChange} /> : null}
      {/*
        The tree draws no "In progress" band. The panel header already says
        what is going and what is asking, the filter row already carries the
        same counts, and a third copy cost 44px of a 320px column to repeat
        them. The deleted-session line still labels its section, because
        nothing above it has said any of that (`fleet/chrome.ts`).
      */}
      {filters ? null : <FleetSectionHeader label="In progress" count={visible.active.count} />}
      {visible.active.groups.length > 0 ? (
        <FleetGroups
          groups={visible.active.groups}
          surface={surface}
          section="active"
          expanded={expanded}
          currentKey={currentKey}
          onToggle={onToggle}
          renderDetail={renderDetail}
          renderAskingActions={renderAskingActions}
        />
      ) : (
        <p className="px-3 py-5 text-sm leading-sm text-ink-3">
          {filters && filter && fleetFilterIsRestricting(filter) ? "Nothing matches these filters." : "Nothing is in progress."}
        </p>
      )}

      {visible.finished.count > 0 && (
        <Collapsible open={finishedOpen} onOpenChange={setFinishedOpen} className="hairline-t">
          {/*
            Dimmed, and with no tick. A green double-check here said "done, well
            done" about the one thing that needs no attention, in an app where
            green means *happening now* (D-154). Finished work is a count you
            can open, and a Clear when you are finished with it.
          */}
          <div className="flex items-center">
            <CollapsibleTrigger className="group/finished flex min-h-11 min-w-0 flex-1 items-center gap-2 ps-3 pe-2 py-3 text-start text-ink-3 outline-none transition-colors duration-(--motion-instant) hover:text-ink-2 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset">
              <span className="text-xs leading-xs font-medium">Finished</span>
              <span className="tnum text-xs leading-xs">{visible.finished.count}</span>
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
              groups={visible.finished.groups}
              surface={surface}
              section="finished"
              expanded={expanded}
              currentKey={currentKey}
              onToggle={onToggle}
              renderDetail={renderDetail}
              renderAskingActions={renderAskingActions}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function FleetSectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <header data-slot="fleet-section-header" className="flex items-center gap-2 px-3 py-2">
      <RadioTower aria-hidden="true" className="size-4 shrink-0 text-live" />
      <h3 className="text-xs leading-xs font-medium text-ink">{label}</h3>
      <span className="tnum text-xs leading-xs text-ink-3">{count}</span>
    </header>
  );
}

/**
 * The group's counts, in words, with zeroes left out: `2 going · 1 asking`.
 *
 * They used to read `1 · 2` under an uppercase `PROJECT`, which is a number
 * nobody can decode without opening the source. Three characters of width is
 * not worth a line a developer cannot read.
 */
function GroupCounts({ group }: { group: FleetGroup }) {
  const parts: { n: number; word: string }[] = [];
  if (group.running > 0) parts.push({ n: group.running, word: "going" });
  if (group.needsYou > 0) parts.push({ n: group.needsYou, word: "asking" });
  if (group.ended > 0) parts.push({ n: group.ended, word: "ended" });
  if (parts.length === 0) return null;
  const words = parts.map((part) => `${part.n} ${part.word}`).join(" · ");
  return (
    <span data-slot="fleet-group-counts" className="tnum shrink-0 text-xs leading-xs text-ink-3" aria-label={words}>
      {words}
    </span>
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
  renderAskingActions,
}: {
  groups: readonly FleetProjectedGroup[];
  surface: FleetSurfaceName;
  section: FleetSectionName;
  expanded: FleetDisclosure | undefined;
  currentKey?: string | undefined;
  onToggle(target: FleetDisclosure): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
  renderAskingActions?: ((item: FleetItem) => ReactNode) | undefined;
}) {
  return groups.map((projectedGroup) => {
    const group = projectedGroup.group;
    return (
      <section key={group.path} aria-label={group.title} data-slot="fleet-group" data-section={section} data-deleted={group.deleted || undefined}>
        {/*
          Two lines and no filled band. Opaque, because DESIGN.md keeps glass
          out of the system — but on the column's own ground, so a sticky
          header reads as a heading rather than as a bar laid over the list.
          Line 1 is the session, middle-truncated so the end of a long prompt
          survives; line 2 is where it lives and how it stands.
        */}
        <header className="sticky top-0 z-10 flex min-w-0 flex-col bg-surface px-3 py-1.5 hairline-b">
          <h4 className="min-w-0 truncate text-sm leading-sm font-medium text-ink" title={group.deleted ? group.path : undefined}>
            {middleTruncate(group.title, GROUP_TITLE_BUDGET)}
          </h4>
          <span className="flex min-w-0 items-baseline gap-1.5">
            {group.cwd ? <span className="typed min-w-0 truncate text-ink-3">{shortCwd(group.cwd)}</span> : null}
            <GroupCounts group={group} />
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
          </span>
        </header>
        {/* One hairline between siblings, and nothing else: no gaps to make
            each row an island, no card to put it in. */}
        <ul role="list" className="flex flex-col divide-y divide-line">
          {projectedGroup.items.map((item) => (
            <FleetBranch
              // A row is the work, not the list it is drawn in. The section and
              // the context/actual role are this drawing's facts and travel as
              // props; the key is the work's own identity, so nothing about
              // where a row is projected can make React replace it.
              key={item.item.key}
              item={item}
              target={{ surface, groupPath: group.path, section, key: item.item.key, role: item.contextOnly ? "context" : "actual" }}
              expanded={expanded}
              currentKey={currentKey}
              onToggle={onToggle}
              renderDetail={renderDetail}
              renderAskingActions={renderAskingActions}
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
  renderAskingActions?: ((item: FleetItem) => ReactNode) | undefined;
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
export function SubagentStrays({ sections, expanded, onToggle, renderDetail, renderAskingActions, onClearFinished, className, ...props }: SubagentStraysProps) {
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
            className="group/strays flex min-h-11 min-w-0 flex-1 items-center gap-2.5 ps-3 pe-2 py-3 text-start outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
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
            renderAskingActions={renderAskingActions}
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
  renderAskingActions,
}: {
  item: FleetProjectedItem;
  target: FleetDisclosure;
  nested?: boolean;
  expanded: FleetDisclosure | undefined;
  currentKey?: string | undefined;
  onToggle(target: FleetDisclosure): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
  renderAskingActions?: ((item: FleetItem) => ReactNode) | undefined;
}) {
  const source = item.item;
  const asking =
    !item.contextOnly && source.state === "needs_input" && renderAskingActions ? renderAskingActions(source) : undefined;
  return (
    <li data-slot="fleet-branch" data-nested={nested || undefined} className="relative min-w-0">
      <FleetWorkRow
        item={item}
        expanded={sameDisclosure(expanded, target)}
        current={currentKey === source.key}
        onToggle={() => onToggle(target)}
        renderDetail={renderDetail}
        askingActions={asking}
      />
      {item.children.length > 0 && (
        // The rail is a hairline, not a box, and it is the only thing that
        // says "this belongs to that": no indent inside a border, no card, no
        // second ground. The rows keep their own padding, so a child's tile
        // sits one rail's width inside its parent's.
        <ul
          role="list"
          aria-label={`Work ${source.title} started`}
          className="relative ms-4 flex flex-col divide-y divide-line border-s border-line"
        >
          {item.children.map((child) => (
            <FleetBranch
              key={child.item.key}
              item={child}
              target={{ ...target, key: child.item.key, role: child.contextOnly ? "context" : "actual" }}
              nested
              expanded={expanded}
              currentKey={currentKey}
              onToggle={onToggle}
              renderDetail={renderDetail}
              renderAskingActions={renderAskingActions}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
