/**
 * A Plan's declared graph, laid out (M21-T16, D-355 "Detail, by kind" → Plan).
 *
 * A Plan is a dependency graph, not a schedule (leap, "Plan and Project Task
 * contract"), so this file computes exactly one thing: where each Task sits
 * relative to the Tasks it waits on. There is no time axis, no duration, no
 * percentage and no invented order — a node's column is the length of the
 * longest chain of declared dependencies behind it, and nothing else.
 *
 * What the host says stays the host's (M21-T15): `planGraph.problems[]` carry
 * their own sentences and their own keys, and `planGraph.orphans[]` are Tasks
 * that still name this Plan after a revision stopped listing them. This module
 * only marks which nodes those refusals are about, so the surface can draw them
 * — it never rewrites the words and never hides a node a refusal names.
 */
import type {
  PlanBody,
  PlanGraphReport,
  ProjectWorkKind,
  ProjectWorkListItem,
  ProjectWorkState,
} from "@lasercode/protocol";

export interface PlanGraphNode {
  /** `TASK-44`. The person-facing handle, and this layout's own id. */
  key: string;
  /** Set when this window holds the row, so the node can be opened. */
  entityId: string | undefined;
  /** What the key names. A key this window has not read is assumed a Task. */
  kind: ProjectWorkKind;
  title: string;
  /** False when no row for this key has been read: it exists, we have not seen it. */
  known: boolean;
  state: ProjectWorkState | undefined;
  /** The phase that lists it, when a phase does. */
  phase: string | undefined;
  /** Dependency depth: 0 waits on nothing this Plan declares. */
  column: number;
  /** Position inside the column, in the order the Plan lists its Tasks. */
  row: number;
  /** Named by one of the host's graph problems. */
  inProblem: boolean;
  /** A Task that names this Plan and which this revision no longer lists. */
  orphan: boolean;
}

export interface PlanGraphEdgeView {
  id: string;
  /** `from` waits for `to`. The arrow is drawn from `to` to `from`. */
  from: string;
  to: string;
  reason: string | undefined;
  /** Part of a cycle the host refused, or of another problem it named. */
  problem: boolean;
}

export interface PlanGraphLayout {
  nodes: PlanGraphNode[];
  edges: PlanGraphEdgeView[];
  /** How many dependency columns there are. */
  columns: number;
  /** The tallest column. */
  rows: number;
  /**
   * The declared dependencies go round. The host refuses to store one, so this
   * is only ever reachable for a graph written before the rule, or for one a
   * refusal is being shown for — either way the layout stays readable.
   */
  cyclic: boolean;
}

const UNREAD_TITLE = "Not in what this window has read";

/**
 * Lay a Plan's Tasks out by dependency depth.
 *
 * Every key a phase lists is a node; a dependency whose ends are both listed is
 * an edge. Keys the Plan declares but no phase lists are still drawn (a
 * dependency is not allowed to point outside the Plan, so one that does is a
 * problem the host already named, and dropping the node would hide it).
 */
export function layoutPlanGraph(input: {
  body: PlanBody;
  items?: readonly ProjectWorkListItem[];
  report?: PlanGraphReport | undefined;
}): PlanGraphLayout {
  const { body, items = [], report } = input;
  const rowByKey = new Map(items.map((item) => [item.key, item]));
  const phaseByKey = new Map<string, string>();
  const order: string[] = [];
  const add = (key: string, phase?: string): void => {
    if (!phaseByKey.has(key) && phase) phaseByKey.set(key, phase);
    if (!order.includes(key)) order.push(key);
  };

  for (const phase of body.phases) for (const key of phase.taskKeys) add(key, phase.name);
  for (const edge of body.dependencies) {
    add(edge.from);
    add(edge.to);
  }
  const orphans = report?.orphans ?? [];
  for (const orphan of orphans) add(orphan.key);

  const problemKeys = new Set((report?.problems ?? []).flatMap((problem) => problem.keys));
  const orphanKeys = new Set(orphans.map((orphan) => orphan.key));

  // `from` waits for `to`, so `to` is upstream and sits one column earlier.
  const upstream = new Map<string, string[]>();
  for (const key of order) upstream.set(key, []);
  for (const edge of body.dependencies) {
    if (edge.from === edge.to) continue;
    upstream.get(edge.from)?.push(edge.to);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const cycleKeys = new Set<string>();
  let cyclic = false;

  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) {
      // A cycle. The host refuses to store one; keep the layout readable and
      // say so rather than looping.
      cyclic = true;
      cycleKeys.add(key);
      return 0;
    }
    visiting.add(key);
    let deepest = 0;
    for (const parent of upstream.get(key) ?? []) deepest = Math.max(deepest, depthOf(parent) + 1);
    visiting.delete(key);
    depth.set(key, deepest);
    return deepest;
  };
  for (const key of order) depthOf(key);

  const perColumn = new Map<number, number>();
  const nodes: PlanGraphNode[] = order.map((key) => {
    const column = orphanKeys.has(key) ? 0 : (depth.get(key) ?? 0);
    const row = perColumn.get(column) ?? 0;
    perColumn.set(column, row + 1);
    const item = rowByKey.get(key);
    const orphan = orphans.find((candidate) => candidate.key === key);
    return {
      key,
      entityId: item?.ref.entityId ?? orphan?.entityId,
      kind: item?.kind ?? "task",
      title: item?.title ?? orphan?.title ?? UNREAD_TITLE,
      known: item !== undefined || orphan !== undefined,
      state: item?.state ?? orphan?.state,
      phase: phaseByKey.get(key),
      column,
      row,
      inProblem: problemKeys.has(key) || cycleKeys.has(key),
      orphan: orphanKeys.has(key),
    };
  });

  const edges: PlanGraphEdgeView[] = body.dependencies.map((edge) => ({
    id: `${edge.from}\u2190${edge.to}`,
    from: edge.from,
    to: edge.to,
    reason: edge.reason,
    problem: problemKeys.has(edge.from) && problemKeys.has(edge.to),
  }));

  return {
    nodes,
    edges,
    columns: Math.max(...[...perColumn.keys()].map((column) => column + 1), 0),
    rows: Math.max(...[...perColumn.values()], 0),
    cyclic,
  };
}

/**
 * Reading order for the keyboard: column by column, top to bottom — the same
 * order the eye takes, so Tab lands where a person is looking.
 */
export function planGraphOrder(layout: PlanGraphLayout): PlanGraphNode[] {
  return [...layout.nodes].sort((left, right) => left.column - right.column || left.row - right.row);
}

/** Where an arrow key goes from here. Returns the same node when there is nowhere. */
export function planGraphStep(
  layout: PlanGraphLayout,
  from: PlanGraphNode,
  direction: "up" | "down" | "before" | "after",
): PlanGraphNode {
  if (direction === "up" || direction === "down") {
    const column = layout.nodes.filter((node) => node.column === from.column).sort((a, b) => a.row - b.row);
    const at = column.findIndex((node) => node.key === from.key);
    return column[at + (direction === "down" ? 1 : -1)] ?? from;
  }
  const next = from.column + (direction === "after" ? 1 : -1);
  const column = layout.nodes.filter((node) => node.column === next).sort((a, b) => a.row - b.row);
  if (column.length === 0) return from;
  return column.find((node) => node.row === from.row) ?? column[column.length - 1] ?? from;
}
