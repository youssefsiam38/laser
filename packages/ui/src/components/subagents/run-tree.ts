/**
 * The run tree (docs/ux-agent-work.md "Navigating runs"). Pure: panel entries
 * in, one level of tabs and a breadcrumb out.
 *
 * The shape of the whole feature is in one rule: **the strip shows exactly one
 * level** — the children of whatever is focused — and depth lives in the
 * breadcrumb. That is what lets arbitrary fan-out stay navigable without ever
 * becoming a tree widget with expand arrows, which is the thing R5 exists to
 * prevent: an expanding tree makes you hunt for the item that needs you.
 *
 * Attention rolls *up* (R1/R5): a node wears the highest-attention state
 * anywhere beneath it, so a decision three levels down lights the tab you can
 * actually see. Ordering is creation order, never attention order — a strip
 * that reshuffles is a strip you cannot learn.
 */
import { ATTENTION_RANK, highestAttention, type Attention, type Panel } from "@piorbit/protocol";
import { attentionOfEntry, elapsedOf, type PanelEntry } from "@/panels";

export interface RunNode {
  /** The panel store key (`<path> <id>`), which is also the React key. */
  key: string;
  id: string;
  title: string;
  kind: "run" | "plan";
  entry: PanelEntry;
  /** This node's own dot. */
  own: Attention;
  /** This node's dot including everything beneath it (R5). */
  attention: Attention;
  children: RunNode[];
  /** Live for a running child; frozen once it ends. */
  elapsedMs: number | undefined;
  depth: number;
}

export interface RunTree {
  /** Top-level runs of the session, in creation order. */
  roots: RunNode[];
  byId: ReadonlyMap<string, RunNode>;
  /** The highest attention anywhere in the tree — what the session row wears. */
  attention: Attention;
  /** Runs still going, for the strip's summary. */
  running: number;
}

const RUNNISH = new Set<Panel["kind"]>(["run", "plan"]);

const isRunning = (panel: Panel): boolean =>
  panel.kind === "run" ? panel.lifecycle === "running" || panel.lifecycle === "queued" : false;

/**
 * Build the tree from one session's panels. A child names its parent by panel
 * id; a parent that never arrived (its plan was pruned, or the child outlived
 * it) leaves the child at the top rather than dropping it — nothing vanishes
 * silently (R7).
 */
export function buildRunTree(
  entries: readonly PanelEntry[],
  decisions: ReadonlySet<string>,
  now: number,
): RunTree {
  const nodes = new Map<string, RunNode>();
  const order: string[] = [];
  for (const entry of entries) {
    if (!RUNNISH.has(entry.panel.kind) || entry.closed) continue;
    const node: RunNode = {
      key: entry.key,
      id: entry.panel.id,
      title: entry.panel.title,
      kind: entry.panel.kind as "run" | "plan",
      entry,
      own: attentionOfEntry(entry, decisions),
      attention: "idle",
      children: [],
      elapsedMs: elapsedOf(entry, now),
      depth: 0,
    };
    nodes.set(node.id, node);
    order.push(node.id);
  }

  const roots: RunNode[] = [];
  for (const id of order) {
    const node = nodes.get(id);
    if (!node) continue;
    const parentId = node.entry.panel.kind === "run" ? node.entry.panel.parent?.id : undefined;
    const parent = parentId !== undefined ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // Depth and the attention roll-up, in one post-order walk. Cycles cannot
  // happen with well-formed ids, but a `seen` set keeps a malformed feed from
  // hanging the tab strip.
  const seen = new Set<string>();
  const settle = (node: RunNode, depth: number): Attention => {
    if (seen.has(node.id)) return node.own;
    seen.add(node.id);
    node.depth = depth;
    node.attention = highestAttention([node.own, ...node.children.map((child) => settle(child, depth + 1))]);
    return node.attention;
  };
  for (const root of roots) settle(root, 0);

  let running = 0;
  for (const node of nodes.values()) if (isRunning(node.entry.panel)) running += 1;

  return {
    roots,
    byId: nodes,
    attention: highestAttention(roots.map((root) => root.attention)),
    running,
  };
}

/** Root-first path to a node: the breadcrumb, and the phone's back-stack. */
export function pathTo(tree: RunTree, id: string | undefined): RunNode[] {
  if (!id) return [];
  const target = tree.byId.get(id);
  if (!target) return [];
  const chain: RunNode[] = [];
  const walk = (nodes: readonly RunNode[], trail: RunNode[]): boolean => {
    for (const node of nodes) {
      const next = [...trail, node];
      if (node.id === id) {
        chain.push(...next);
        return true;
      }
      if (walk(node.children, next)) return true;
    }
    return false;
  };
  walk(tree.roots, []);
  return chain;
}

/** Most tabs the strip shows before the rest become a `+N` chip (D-19). */
export const MAX_TABS = 5;

export interface TabRow {
  /** The children of the focused node — exactly one level. */
  tabs: RunNode[];
  /** Everything past the fifth, reachable through the overflow chip. */
  overflow: RunNode[];
  /** What the strip is a level *of*: undefined at the session root. */
  focused: RunNode | undefined;
  /** Root-first, excluding the focused node itself. */
  trail: RunNode[];
}

/**
 * One level of the strip. The overflow is a plain tail of creation order, not
 * "the least important five": which five you see must not change under you
 * while you are reading them. Attention still reaches you — the chip carries
 * the highest attention it hides.
 */
export function tabsFor(tree: RunTree, focusedId: string | undefined, max = MAX_TABS): TabRow {
  const focused = focusedId !== undefined ? tree.byId.get(focusedId) : undefined;
  const level = focused ? focused.children : tree.roots;
  const trail = focused ? pathTo(tree, focused.id).slice(0, -1) : [];
  return {
    tabs: level.slice(0, max),
    overflow: level.slice(max),
    focused,
    trail,
  };
}

/** The dot the `+N` chip wears: the loudest thing it is hiding. */
export function overflowAttention(overflow: readonly RunNode[]): Attention {
  return highestAttention(overflow.map((node) => node.attention));
}

/**
 * Where focus goes when the focused run disappears (it was pruned, or its
 * session changed): the nearest ancestor still present, else the session root.
 * Never a sibling — jumping sideways loses your place.
 */
export function reconcileFocus(tree: RunTree, focusedId: string | undefined, previousTrail: readonly string[]): string | undefined {
  if (focusedId !== undefined && tree.byId.has(focusedId)) return focusedId;
  for (let i = previousTrail.length - 1; i >= 0; i -= 1) {
    const id = previousTrail[i];
    if (id !== undefined && tree.byId.has(id)) return id;
  }
  return undefined;
}

/** Every node, flattened depth-first — the fleet sheet's list and `piorbit runs`. */
export function flatten(tree: RunTree): RunNode[] {
  const out: RunNode[] = [];
  const walk = (nodes: readonly RunNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(tree.roots);
  return out;
}

/** Attention-first ordering, for the fleet sheet only — never for the strip. */
export function byAttention(nodes: readonly RunNode[]): RunNode[] {
  return [...nodes].sort((a, b) => ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention] || a.entry.firstSeenAt - b.entry.firstSeenAt);
}
