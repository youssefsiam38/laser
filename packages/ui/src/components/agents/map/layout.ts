/**
 * The live map's geometry, pure (docs/agents.md §5, M13-T7).
 *
 * Three decisions live here and nowhere else:
 *
 *   1. Which composition a measured surface gets — a lineage list when the
 *      box is too small for a canvas, a concise canvas in the main column,
 *      a spacious canvas with an inspector when there is room. Measured
 *      container size, never a window breakpoint: the same tree in a dock
 *      island and in the main column is two different surfaces.
 *   2. Which nodes are on the map — ended agents fold away until asked for,
 *      but an ended parent whose descendants are still going stays, because a
 *      branch cannot hang from nothing.
 *   3. Where every node goes — a deterministic layered tree: the root at the
 *      top, children in creation order, a parent centred over its children.
 *      Positions depend on the structure and the direction alone, so a status
 *      or output update never moves anything (memoise on {@link structureKey}).
 *
 * Every number here is a position or a box the graph is drawn at, not type or
 * colour.
 * Tested in test/agents/map/layout.test.ts.
 */
import type { AgentTree, AgentTreeNode } from "@/agents";

export type MapComposition = "constrained" | "panel" | "full";
export type MapDirection = "TB" | "LR";

export interface MapSize {
  width: number;
  height: number;
}

/** Below either of these the canvas is not a canvas any more: it is a list. */
export const CONSTRAINED_WIDTH = 520;
export const CONSTRAINED_HEIGHT = 360;
/** From here the canvas has room for rich nodes and an inspector column. */
export const FULL_WIDTH = 960;
/** The inspector column's width in the full composition. */
export const INSPECTOR_WIDTH = 320;
/** The share of the panel composition's height the details row may take. */
export const INSPECTOR_ROW_SHARE = 0.48;
/** Under this zoom a node draws its mark and dot only: text never shrinks below the floor. */
export const ZOOM_COMPACT = 0.6;
/** A minimap earns its place once the tree is bigger than this. */
export const MINIMAP_FROM = 9;

/**
 * Which composition a box this size gets. A fullscreen host on a phone is
 * still a canvas — that is what "Open map" opens — so it forces the canvas
 * through `canvas` and takes the panel composition instead of the list.
 */
export function compositionFor(size: MapSize, options: { canvas?: boolean } = {}): MapComposition {
  const { width, height } = size;
  if (!options.canvas && (width < CONSTRAINED_WIDTH || height < CONSTRAINED_HEIGHT)) return "constrained";
  if (width >= FULL_WIDTH && height >= CONSTRAINED_HEIGHT) return "full";
  return "panel";
}

export interface NodeBox {
  width: number;
  height: number;
  /** Space between siblings along the breadth axis. */
  gap: number;
  /** Space between levels along the depth axis. */
  level: number;
}

/** Node boxes per composition. The content inside follows the type scale; the box is the layout's. */
export const NODE_BOX: Readonly<Record<Exclude<MapComposition, "constrained">, NodeBox>> = {
  panel: { width: 216, height: 64, gap: 24, level: 56 },
  full: { width: 272, height: 144, gap: 32, level: 72 },
};

export interface VisibleTree {
  root: AgentTreeNode;
  /** Root first, depth-first in creation order. */
  nodes: AgentTreeNode[];
  edges: Array<{ from: string; to: string }>;
  byPath: ReadonlyMap<string, AgentTreeNode>;
  /** Children per node, in creation order, hidden ones removed. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Nodes folded away because they ended. */
  hidden: number;
  /** Nodes that ended, shown or not. */
  ended: number;
}

/**
 * The tree with ended agents folded away unless `showEnded`. A node folds only
 * when everything under it has ended too; the root never folds.
 */
export function visibleTreeOf(tree: AgentTree, showEnded: boolean): VisibleTree {
  const settled = new Map<string, boolean>();
  const settledUnder = (node: AgentTreeNode): boolean => {
    const known = settled.get(node.id);
    if (known !== undefined) return known;
    const value = node.ended && node.children.every((child) => {
      const c = tree.byPath.get(child);
      return c === undefined || settledUnder(c);
    });
    settled.set(node.id, value);
    return value;
  };
  let ended = 0;
  for (const node of tree.nodes) if (node.depth > 0 && node.ended) ended += 1;
  const nodes: AgentTreeNode[] = [];
  const edges: VisibleTree["edges"] = [];
  const byPath = new Map<string, AgentTreeNode>();
  const children = new Map<string, readonly string[]>();
  let hidden = 0;
  const walk = (node: AgentTreeNode): void => {
    nodes.push(node);
    byPath.set(node.id, node);
    const kept: string[] = [];
    for (const id of node.children) {
      const child = tree.byPath.get(id);
      if (!child) continue;
      if (!showEnded && settledUnder(child)) {
        hidden += 1 + countDescendants(tree, child);
        continue;
      }
      kept.push(id);
    }
    children.set(node.id, kept);
    for (const id of kept) {
      edges.push({ from: node.id, to: id });
      walk(tree.byPath.get(id)!);
    }
  };
  walk(tree.root);
  return { root: tree.root, nodes, edges, byPath, children, hidden, ended };
}

function countDescendants(tree: AgentTree, node: AgentTreeNode): number {
  let n = 0;
  for (const id of node.children) {
    const child = tree.byPath.get(id);
    if (child) n += 1 + countDescendants(tree, child);
  }
  return n;
}

/**
 * What the geometry depends on: the visible node set and who hangs from whom.
 * Two trees with the same key lay out identically, whatever their statuses.
 */
export function structureKey(tree: VisibleTree): string {
  return tree.nodes.map((node) => `${node.id}>${node.parentPath ?? ""}`).join("|");
}

export interface MapLayout {
  direction: MapDirection;
  positions: ReadonlyMap<string, { x: number; y: number }>;
  /** The drawn extent, from the origin. */
  width: number;
  height: number;
}

/**
 * The layered tree. Breadth is the axis siblings spread along (x for TB,
 * y for LR); depth is the other one. A leaf takes one box; a parent takes the
 * span of its children and sits centred over it; children narrower than their
 * parent are centred under it. Creation order is preserved left to right.
 */
export function layoutTree(tree: VisibleTree, box: NodeBox, direction: MapDirection = "TB"): MapLayout {
  const along = direction === "TB" ? box.width : box.height;
  const across = direction === "TB" ? box.height : box.width;
  const breadth = new Map<string, number>();
  const breadthOf = (id: string): number => {
    const known = breadth.get(id);
    if (known !== undefined) return known;
    const kids = tree.children.get(id) ?? [];
    const span = kids.length === 0 ? along : kids.reduce((sum, kid) => sum + breadthOf(kid), 0) + box.gap * (kids.length - 1);
    const value = Math.max(along, span);
    breadth.set(id, value);
    return value;
  };
  const positions = new Map<string, { x: number; y: number }>();
  let depthMax = 0;
  const place = (id: string, start: number, depth: number): void => {
    const kids = tree.children.get(id) ?? [];
    const span = breadthOf(id);
    const own = start + (span - along) / 2;
    const d = depth * (across + box.level);
    positions.set(id, direction === "TB" ? { x: own, y: d } : { x: d, y: own });
    depthMax = Math.max(depthMax, depth);
    const kidsSpan = kids.reduce((sum, kid) => sum + breadthOf(kid), 0) + box.gap * Math.max(0, kids.length - 1);
    let cursor = start + (span - kidsSpan) / 2;
    for (const kid of kids) {
      place(kid, cursor, depth + 1);
      cursor += breadthOf(kid) + box.gap;
    }
  };
  place(tree.root.id, 0, 0);
  const total = breadthOf(tree.root.id);
  const deep = (depthMax + 1) * across + depthMax * box.level;
  return direction === "TB"
    ? { direction, positions, width: total, height: deep }
    : { direction, positions, width: deep, height: total };
}

/**
 * Which way the tree should grow in a box this shape. The root stays at the
 * top unless the panel composition fits clearly better sideways — a deep,
 * narrow tree in a short, wide column. With a `current` direction the answer
 * only changes when the other way fits at least a tenth better, so a small
 * resize never flips the map back and forth.
 */
export function directionFor(tree: VisibleTree, box: NodeBox, size: MapSize, composition: MapComposition, current?: MapDirection): MapDirection {
  if (composition !== "panel" || size.width <= 0 || size.height <= 0) return "TB";
  const fit = (layout: MapLayout) => Math.min(size.width / Math.max(1, layout.width), size.height / Math.max(1, layout.height));
  const tb = fit(layoutTree(tree, box, "TB"));
  const lr = fit(layoutTree(tree, box, "LR"));
  if (current === "LR") return tb > lr * 1.1 ? "TB" : "LR";
  if (current === "TB") return lr > tb * 1.1 ? "LR" : "TB";
  return lr > tb ? "LR" : "TB";
}
