/**
 * Anchored review on a design: pins and the before/after of a revision
 * (M21-T13; leap "Design contract"; `docs/design-phase.md` "What a person
 * sees" → Review).
 *
 * Two pure models, both DOM-free:
 *
 * 1. **Pins.** A comment on a design anchors to a *node* or a *screen*, and
 *    the canvas has to show where. A pin is numbered in the order the comments
 *    were written, belongs to exactly one screen, and when the node it names
 *    is no longer in the revision the pin is **orphaned** — kept, counted and
 *    labelled, never silently moved to something plausible (leap, "Design
 *    contract": coordinates only position a pin).
 * 2. **Before/after.** Two revisions of one design compared as a node diff:
 *    what was added, what was removed, and what changed — by component, by
 *    fidelity, by variant, by state or by text. Screens added and removed are
 *    the same question one level up.
 */
import type { DesignBody, DesignNode, DesignScreen, ProjectWorkComment } from "@lasercode/protocol";

// ---------------------------------------------------------------- the pins

export interface DesignPin {
  commentId: string;
  /** 1-based, in the order the comments were written. */
  number: number;
  /** The screen the pin belongs to; absent only for an orphaned node pin. */
  screenId?: string;
  /** The node the comment names, for a node anchor. */
  nodeId?: string;
  /** The anchor no longer resolves in this revision. */
  orphaned: boolean;
  /** The comment's own words, bounded for a tooltip. */
  text: string;
  blocking: boolean;
  resolved: boolean;
  author: string;
}

function screenOfNodeId(body: Pick<DesignBody, "screens">, nodeId: string): DesignScreen | undefined {
  return body.screens.find((screen) => "tree" in screen.content && screen.content.tree.nodes.some((node) => node.id === nodeId));
}

/**
 * Every pin of one design revision, in writing order.
 *
 * A comment the host already marked `orphaned` stays orphaned whatever this
 * body says: the host decided it against the revision the comment was written
 * on, and a client must not overrule it. A comment whose node this revision
 * does not have is orphaned here too — a body the host has not re-resolved yet
 * must not draw a pin on nothing.
 */
export function designPins(body: Pick<DesignBody, "screens">, comments: readonly ProjectWorkComment[] | undefined): DesignPin[] {
  const pins: DesignPin[] = [];
  let number = 0;
  for (const comment of comments ?? []) {
    const anchor = comment.anchor;
    if (anchor.target !== "node" && anchor.target !== "region") continue;
    number += 1;
    const base = {
      commentId: comment.commentId,
      number,
      text: comment.text,
      blocking: comment.blocking,
      resolved: comment.state === "resolved",
      author: comment.origin.actor.label,
    };
    if (anchor.target === "region") {
      const screen = body.screens.find((candidate) => candidate.id === anchor.regionId);
      pins.push({ ...base, ...(screen ? { screenId: screen.id } : {}), orphaned: comment.orphaned === true || screen === undefined });
      continue;
    }
    const screen = anchor.screenId !== undefined ? body.screens.find((candidate) => candidate.id === anchor.screenId) : screenOfNodeId(body, anchor.nodeId);
    const present = screen !== undefined && "tree" in screen.content && screen.content.tree.nodes.some((node) => node.id === anchor.nodeId);
    pins.push({
      ...base,
      nodeId: anchor.nodeId,
      ...(present && screen ? { screenId: screen.id } : {}),
      orphaned: comment.orphaned === true || !present,
    });
  }
  return pins;
}

/** The pins of one screen, and the orphaned ones that belong to no screen. */
export function pinsForScreen(pins: readonly DesignPin[], screenId: string): DesignPin[] {
  return pins.filter((pin) => pin.screenId === screenId);
}

export function orphanedPins(pins: readonly DesignPin[]): DesignPin[] {
  return pins.filter((pin) => pin.orphaned);
}

// ----------------------------------------------------------- before / after

export type DesignNodeChangeKind = "added" | "removed" | "changed";

export interface DesignNodeChange {
  kind: DesignNodeChangeKind;
  nodeId: string;
  screenId: string;
  screenName: string;
  /** What the node draws, in words: an index entry id or a primitive name. */
  component: string;
  /** For a change: the fields that differ, named. */
  fields?: string[];
  /** For a change: the values, so the person reads the change not the word. */
  before?: string;
  after?: string;
}

export interface DesignScreenChange {
  kind: DesignNodeChangeKind;
  screenId: string;
  screenName: string;
}

export interface DesignDiff {
  screens: DesignScreenChange[];
  nodes: DesignNodeChange[];
  /** True when the two revisions are the same design, node for node. */
  identical: boolean;
}

function componentOf(node: DesignNode): string {
  return "indexEntryId" in node.component ? node.component.indexEntryId : node.component.primitive;
}

function nodesOf(screen: DesignScreen): DesignNode[] {
  return "tree" in screen.content ? screen.content.tree.nodes : [];
}

function summarise(node: DesignNode): string {
  const parts = [componentOf(node), node.fidelity];
  if (node.variant !== undefined) parts.push(node.variant);
  if (node.state !== undefined) parts.push(node.state);
  if (node.text !== undefined) parts.push(`“${node.text.slice(0, 60)}”`);
  return parts.join(" · ");
}

/**
 * What changed between two revisions of one design.
 *
 * Node ids are stable across revisions (that is what makes a comment survive
 * an edit), so the diff is by id and never by position: a node moved inside
 * its parent is not a change of the node, and a node replaced under the same
 * id is.
 */
export function designDiff(before: Pick<DesignBody, "screens">, after: Pick<DesignBody, "screens">): DesignDiff {
  const screens: DesignScreenChange[] = [];
  const nodes: DesignNodeChange[] = [];
  const beforeScreens = new Map(before.screens.map((screen) => [screen.id, screen]));
  const afterScreens = new Map(after.screens.map((screen) => [screen.id, screen]));

  for (const screen of after.screens) {
    if (!beforeScreens.has(screen.id)) screens.push({ kind: "added", screenId: screen.id, screenName: screen.name });
  }
  for (const screen of before.screens) {
    if (!afterScreens.has(screen.id)) screens.push({ kind: "removed", screenId: screen.id, screenName: screen.name });
  }

  for (const [screenId, screen] of afterScreens) {
    const previous = beforeScreens.get(screenId);
    const previousNodes = new Map((previous ? nodesOf(previous) : []).map((node) => [node.id, node]));
    for (const node of nodesOf(screen)) {
      const was = previousNodes.get(node.id);
      if (!was) {
        if (previous) nodes.push({ kind: "added", nodeId: node.id, screenId, screenName: screen.name, component: componentOf(node), after: summarise(node) });
        continue;
      }
      const fields: string[] = [];
      if (componentOf(was) !== componentOf(node)) fields.push("component");
      if (was.fidelity !== node.fidelity) fields.push("fidelity");
      if (was.variant !== node.variant) fields.push("variant");
      if (was.state !== node.state) fields.push("state");
      if (was.text !== node.text) fields.push("text");
      if (JSON.stringify(was.props) !== JSON.stringify(node.props)) fields.push("props");
      if (was.children.join(",") !== node.children.join(",")) fields.push("children");
      if (fields.length === 0) continue;
      nodes.push({
        kind: "changed",
        nodeId: node.id,
        screenId,
        screenName: screen.name,
        component: componentOf(node),
        fields,
        before: summarise(was),
        after: summarise(node),
      });
    }
    for (const node of previousNodes.values()) {
      if (nodesOf(screen).some((candidate) => candidate.id === node.id)) continue;
      nodes.push({ kind: "removed", nodeId: node.id, screenId, screenName: screen.name, component: componentOf(node), before: summarise(node) });
    }
  }

  return { screens, nodes, identical: screens.length === 0 && nodes.length === 0 };
}

/** The one-line summary the Review section shows above the list. */
export function diffSummary(diff: DesignDiff): string {
  if (diff.identical) return "Nothing changed between these two revisions.";
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const node of diff.nodes) counts[node.kind] += 1;
  const parts: string[] = [];
  if (diff.screens.length > 0) {
    const added = diff.screens.filter((screen) => screen.kind === "added").length;
    const removed = diff.screens.filter((screen) => screen.kind === "removed").length;
    if (added > 0) parts.push(`${String(added)} screen${added === 1 ? "" : "s"} added`);
    if (removed > 0) parts.push(`${String(removed)} screen${removed === 1 ? "" : "s"} removed`);
  }
  if (counts.added > 0) parts.push(`${String(counts.added)} node${counts.added === 1 ? "" : "s"} added`);
  if (counts.removed > 0) parts.push(`${String(counts.removed)} node${counts.removed === 1 ? "" : "s"} removed`);
  if (counts.changed > 0) parts.push(`${String(counts.changed)} node${counts.changed === 1 ? "" : "s"} changed`);
  return parts.join(" · ");
}
