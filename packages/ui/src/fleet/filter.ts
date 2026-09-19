/**
 * Going · Asking · Ended, plus a kind cut. Applied to an already-projected
 * lifecycle tree so Clear and context ancestry stay one walk.
 */
import { highestAttention, type Attention } from "@lasercode/protocol";

import type { FleetItem, FleetItemKind, FleetProjectedGroup, FleetProjectedItem, FleetSectionProjection, FleetSections } from "./model.js";

export interface FleetLifecycleFilter {
  going: boolean;
  asking: boolean;
  ended: boolean;
}

export type FleetKindFilter = "all" | FleetItemKind;

export interface FleetFilter {
  lifecycle: FleetLifecycleFilter;
  kind: FleetKindFilter;
}

export const DEFAULT_FLEET_FILTER: FleetFilter = {
  lifecycle: { going: true, asking: true, ended: true },
  kind: "all",
};

export interface FleetFilterCounts {
  going: number;
  asking: number;
  ended: number;
  agents: number;
  commands: number;
}

export function itemMatchesFilter(item: FleetItem, filter: FleetFilter): boolean {
  if (filter.kind !== "all" && item.kind !== filter.kind) return false;
  if (item.state === "needs_input") return filter.lifecycle.asking;
  if (item.terminal) return filter.lifecycle.ended;
  return filter.lifecycle.going;
}

function filterProjectedItems(items: readonly FleetProjectedItem[], filter: FleetFilter): FleetProjectedItem[] {
  const out: FleetProjectedItem[] = [];
  for (const node of items) {
    const children = filterProjectedItems(node.children, filter);
    const own = !node.contextOnly && itemMatchesFilter(node.item, filter);
    if (!own && children.length === 0) continue;
    const attention: Attention = own
      ? highestAttention([node.item.own, ...children.map((child) => child.attention)])
      : highestAttention(children.map((child) => child.attention));
    out.push({
      item: node.item,
      contextOnly: !own,
      attention,
      children,
    });
  }
  return out;
}

function countActual(items: readonly FleetProjectedItem[]): { count: number; running: number; needsYou: number; attention: Attention } {
  let count = 0;
  let running = 0;
  let needsYou = 0;
  const seen: Attention[] = [];
  const walk = (list: readonly FleetProjectedItem[]): void => {
    for (const node of list) {
      if (!node.contextOnly) {
        count += 1;
        if (!node.item.terminal) running += 1;
        if (node.item.state === "needs_input") needsYou += 1;
        seen.push(node.attention);
      }
      walk(node.children);
    }
  };
  walk(items);
  return { count, running, needsYou, attention: highestAttention(seen) };
}

function filterSection(section: FleetSectionProjection, filter: FleetFilter, include: boolean): FleetSectionProjection {
  if (!include) {
    return { groups: [], count: 0, running: 0, needsYou: 0, attention: highestAttention([]) };
  }
  const groups: FleetProjectedGroup[] = [];
  for (const projected of section.groups) {
    const items = filterProjectedItems(projected.items, filter);
    if (items.length === 0) continue;
    const tallied = countActual(items);
    groups.push({
      group: projected.group,
      items,
      count: tallied.count,
      running: tallied.running,
      needsYou: tallied.needsYou,
      attention: tallied.attention,
    });
  }
  return {
    groups,
    count: groups.reduce((total, group) => total + group.count, 0),
    running: groups.reduce((total, group) => total + group.running, 0),
    needsYou: groups.reduce((total, group) => total + group.needsYou, 0),
    attention: highestAttention(groups.map((group) => group.attention)),
  };
}

/** Cut a projected fleet by lifecycle and kind. Context ancestors stay. */
export function filterFleetSections(sections: FleetSections, filter: FleetFilter): FleetSections {
  const live = filter.lifecycle.going || filter.lifecycle.asking;
  return {
    active: filterSection(sections.active, filter, live),
    finished: filterSection(sections.finished, filter, filter.lifecycle.ended),
  };
}

function walkActual(items: readonly FleetProjectedItem[], visit: (item: FleetItem) => void): void {
  for (const node of items) {
    if (!node.contextOnly) visit(node.item);
    walkActual(node.children, visit);
  }
}

/** Counts for the chips: always the unfiltered tree, so a chip does not zero itself. */
export function fleetFilterCounts(sections: FleetSections): FleetFilterCounts {
  const counts: FleetFilterCounts = { going: 0, asking: 0, ended: 0, agents: 0, commands: 0 };
  const visit = (item: FleetItem): void => {
    if (item.kind === "agent") counts.agents += 1;
    else counts.commands += 1;
    if (item.state === "needs_input") counts.asking += 1;
    else if (item.terminal) counts.ended += 1;
    else counts.going += 1;
  };
  for (const projected of [...sections.active.groups, ...sections.finished.groups]) {
    walkActual(projected.items, visit);
  }
  return counts;
}
