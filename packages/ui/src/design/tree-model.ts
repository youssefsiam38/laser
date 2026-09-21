/**
 * Editing a design, as data (M21-T11).
 *
 * Editing is two-way — direct manipulation on the canvas and the inspector
 * beside it, both producing the same revision (`docs/design-phase.md`,
 * "Editing"). Every operation here is a pure body → body function, so the
 * surface never mutates what it is rendering and a revision is written from
 * one value the person can see.
 *
 * Two invariants ride along with every edit:
 *
 * - **Ids are stable.** Nothing here mints, renumbers or reuses a node id, so
 *   a comment anchored to a node survives any edit that is not a deletion.
 * - **Fidelity is derived, never typed.** A screen is as grounded as its least
 *   grounded node and a design as its least grounded screen, so
 *   `recomputeFidelity` runs after every edit rather than trusting a field.
 */
import {
  designAggregateFidelity,
  screenFidelity,
  type DesignBody,
  type DesignNode,
  type DesignPropValue,
  type DesignScreen,
} from "@lasercode/protocol";

export interface ScreenTree {
  rootNodeId: string;
  nodes: DesignNode[];
}

export function treeOf(screen: DesignScreen | undefined): ScreenTree | undefined {
  if (!screen || !("tree" in screen.content)) return undefined;
  return screen.content.tree;
}

export function screenOf(body: Pick<DesignBody, "screens">, screenId: string | undefined): DesignScreen | undefined {
  return body.screens.find((screen) => screen.id === screenId);
}

export function nodeOf(screen: DesignScreen | undefined, nodeId: string | undefined): DesignNode | undefined {
  const tree = treeOf(screen);
  return tree?.nodes.find((node) => node.id === nodeId);
}

/** The screen a node belongs to. Used when a comment names only a node id. */
export function screenOfNode(body: Pick<DesignBody, "screens">, nodeId: string): DesignScreen | undefined {
  return body.screens.find((screen) => {
    const tree = treeOf(screen);
    return tree?.nodes.some((node) => node.id === nodeId) ?? false;
  });
}

export function parentOf(tree: ScreenTree, nodeId: string): DesignNode | undefined {
  return tree.nodes.find((node) => node.children.includes(nodeId));
}

/** Root → … → node, for the inspector's breadcrumb and for keyboard walking. */
export function ancestry(tree: ScreenTree, nodeId: string): DesignNode[] {
  const path: DesignNode[] = [];
  let current = tree.nodes.find((node) => node.id === nodeId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.unshift(current);
    current = parentOf(tree, current.id);
  }
  return path;
}

/** Depth-first order, which is the order the canvas and the keyboard use. */
export function walkTree(tree: ScreenTree): DesignNode[] {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const order: DesignNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    order.push(node);
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNodeId);
  return order;
}

function mapScreen(body: DesignBody, screenId: string, change: (screen: DesignScreen) => DesignScreen): DesignBody {
  return { ...body, screens: body.screens.map((screen) => (screen.id === screenId ? change(screen) : screen)) };
}

function mapNode(body: DesignBody, screenId: string, nodeId: string, change: (node: DesignNode) => DesignNode): DesignBody {
  return mapScreen(body, screenId, (screen) => {
    if (!("tree" in screen.content)) return screen;
    return {
      ...screen,
      content: {
        tree: {
          ...screen.content.tree,
          nodes: screen.content.tree.nodes.map((node) => (node.id === nodeId ? change(node) : node)),
        },
      },
    };
  });
}

/** Set or clear one prop. Clearing removes the key rather than storing empty. */
export function setNodeProp(body: DesignBody, screenId: string, nodeId: string, name: string, value: DesignPropValue | undefined): DesignBody {
  return recomputeFidelity(
    mapNode(body, screenId, nodeId, (node) => {
      const props = { ...node.props };
      if (value === undefined) delete props[name];
      else props[name] = value;
      return { ...node, props };
    }),
  );
}

/** Inline text edit on the canvas, and the inspector's text field. */
export function setNodeText(body: DesignBody, screenId: string, nodeId: string, text: string): DesignBody {
  return recomputeFidelity(
    mapNode(body, screenId, nodeId, (node) => {
      if (text.length === 0) {
        const { text: _text, ...rest } = node;
        return rest;
      }
      return { ...node, text };
    }),
  );
}

export function setNodeVariant(body: DesignBody, screenId: string, nodeId: string, variant: string | undefined): DesignBody {
  return recomputeFidelity(
    mapNode(body, screenId, nodeId, (node) => {
      if (variant === undefined) {
        const { variant: _variant, ...rest } = node;
        return rest;
      }
      return { ...node, variant };
    }),
  );
}

export function setNodeState(body: DesignBody, screenId: string, nodeId: string, state: string | undefined): DesignBody {
  return recomputeFidelity(
    mapNode(body, screenId, nodeId, (node) => {
      if (state === undefined) {
        const { state: _state, ...rest } = node;
        return rest;
      }
      return { ...node, state };
    }),
  );
}

/** Move a child inside its own container: drag-reorder, and its keyboard form. */
export function reorderChild(body: DesignBody, screenId: string, parentId: string, from: number, to: number): DesignBody {
  return mapNode(body, screenId, parentId, (node) => {
    const children = [...node.children];
    if (from < 0 || from >= children.length) return node;
    const target = Math.min(Math.max(to, 0), children.length - 1);
    const [moved] = children.splice(from, 1);
    if (moved === undefined) return node;
    children.splice(target, 0, moved);
    return { ...node, children };
  });
}

/** Move a node one place earlier or later among its siblings. */
export function nudgeNode(body: DesignBody, screenId: string, nodeId: string, delta: number): DesignBody {
  const tree = treeOf(screenOf(body, screenId));
  if (!tree) return body;
  const parent = parentOf(tree, nodeId);
  if (!parent) return body;
  const index = parent.children.indexOf(nodeId);
  return reorderChild(body, screenId, parent.id, index, index + delta);
}

/**
 * Re-derive every fidelity from the nodes underneath it.
 *
 * A screen made of reviewed index entries is Mapped; one new component makes
 * it Proposed; a sketch screen is Sketch. The design takes the least grounded
 * of its screens. Nothing in the UI ever writes these by hand.
 */
export function recomputeFidelity(body: DesignBody): DesignBody {
  const screens = body.screens.map((screen) => {
    const derived = screenFidelity(screen);
    return derived === screen.fidelity ? screen : { ...screen, fidelity: derived };
  });
  const next = { ...body, screens };
  const aggregate = designAggregateFidelity(next);
  return aggregate === body.fidelity ? next : { ...next, fidelity: aggregate };
}

/** How many nodes on a screen use an index entry nobody has reviewed yet. */
export function unreviewedNodes(screen: DesignScreen): DesignNode[] {
  const tree = treeOf(screen);
  if (!tree) return [];
  return tree.nodes.filter((node) => node.unreviewed === true);
}

/** The name a surface shows for a node: its text, its label prop, or its kind. */
export function nodeLabel(node: DesignNode, fallback: string): string {
  if (node.text && node.text.trim()) return node.text.trim();
  for (const key of ["label", "title", "alt", "placeholder"]) {
    const value = node.props[key];
    if (value?.type === "text" && value.value.trim()) return value.value.trim();
  }
  return fallback;
}

/** True when the design has nothing drawn at all — the honest empty state. */
export function designIsEmpty(body: Pick<DesignBody, "screens" | "sketches">): boolean {
  return body.screens.length === 0 && body.sketches.length === 0;
}

/** The sketch a screen shows, if it is a sketch screen. */
export function sketchOfScreen(body: Pick<DesignBody, "sketches">, screen: DesignScreen | undefined): DesignBody["sketches"][number] | undefined {
  if (!screen) return undefined;
  const content = screen.content;
  if (!("sketchId" in content)) return undefined;
  return body.sketches.find((sketch) => sketch.id === content.sketchId);
}

/**
 * The other side of the Sketch/Tree chip.
 *
 * A grounded sketch has a tree screen beside it, so the chip flips between the
 * two. An ungrounded one has nowhere to flip to, and the chip says so rather
 * than offering a switch that would show an empty frame.
 */
export function counterpartScreen(body: Pick<DesignBody, "screens" | "sketches">, screen: DesignScreen | undefined): DesignScreen | undefined {
  if (!screen) return undefined;
  const content = screen.content;
  if ("sketchId" in content) {
    const sketch = body.sketches.find((candidate) => candidate.id === content.sketchId);
    if (!sketch?.groundedIntoScreenId) return undefined;
    return body.screens.find((candidate) => candidate.id === sketch.groundedIntoScreenId);
  }
  const source = body.sketches.find((sketch) => sketch.groundedIntoScreenId === screen.id);
  if (!source) return undefined;
  return body.screens.find((candidate) => {
    const other = candidate.content;
    return "sketchId" in other && other.sketchId === source.id;
  });
}
