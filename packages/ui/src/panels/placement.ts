/**
 * Placement is laser's decision, not the extension's (docs/ux-panels.md).
 * kind × intent × viewport → surface. This is the table in the contract,
 * verbatim, with its one branch: on a phone the dock does not exist.
 *
 * A placement carries `via`, which says *why* it landed where it did. Two
 * different intents produce a `sheet` — `inspect` from the table, and `follow`
 * on a phone — and they want opposite treatment: `inspect` means "I want your
 * attention now" and opens; a phone's `follow` is an island that waits above
 * the composer until it is tapped. Without the reason, the surface alone
 * cannot tell them apart after the fact.
 *
 * Tested in test/panels/placement.test.ts.
 */
import type { DecisionBlocking, Panel, PanelIntent, PanelKind } from "@lasercode/protocol";

export type Viewport = "desktop" | "tablet" | "mobile";
export type Surface = "ambient" | "inline" | "dock" | "sheet" | "none";

/** How an `inline` placement renders, when the table says more than "a card". */
export type InlineMode = "card" | "collapsed" | "tail" | "tool-row";

/** Why a placement is what it is. `table` is the plain reading of the row. */
export type PlacementVia = "table" | "phone-follow";

export interface Placement {
  surface: Surface;
  inline?: InlineMode;
  via?: PlacementVia;
}

export interface PlacementHints {
  /** For decisions: what they block decides everything. */
  blocking?: DecisionBlocking;
  /** For decisions: the tool row exists to render into. */
  hasToolRow?: boolean;
}

const A: Placement = { surface: "ambient" };
const D: Placement = { surface: "dock" };
const S: Placement = { surface: "sheet" };
const N: Placement = { surface: "none" };
const card: Placement = { surface: "inline", inline: "card" };
const collapsed: Placement = { surface: "inline", inline: "collapsed" };
const tail: Placement = { surface: "inline", inline: "tail" };

/** The table. Decision is handled by blocking scope below and is `none` here for intents that make no sense. */
const TABLE: Record<Exclude<PanelKind, "decision">, Record<PanelIntent, Placement>> = {
  run: { glance: A, inline: card, follow: D, inspect: S },
  plan: { glance: A, inline: card, follow: D, inspect: S },
  document: { glance: N, inline: collapsed, follow: D, inspect: S },
  stream: { glance: A, inline: tail, follow: D, inspect: S },
  collection: { glance: N, inline: card, follow: D, inspect: S },
};

export function placePanel(kind: PanelKind, intent: PanelIntent, viewport: Viewport, hints: PlacementHints = {}): Placement {
  if (kind === "decision") {
    // "inline, in its tool row" when it blocks one tool and that row exists;
    // a sheet only if it blocks everything; otherwise a card above the composer.
    if (hints.blocking === "session") return S;
    if (hints.blocking === "tool" && hints.hasToolRow) return { surface: "inline", inline: "tool-row" };
    return card;
  }
  const placement = TABLE[kind][intent];
  // The only branch: on a phone the dock does not exist. `follow` becomes a
  // sheet, and the island sits above the composer as a chip until tapped.
  if (viewport === "mobile" && placement.surface === "dock") return { surface: "sheet", via: "phone-follow" };
  return placement;
}

/** Convenience over a whole panel. */
export function placementOf(panel: Panel, viewport: Viewport, hasToolRow = false): Placement {
  return placePanel(panel.kind, panel.intent, viewport, {
    ...(panel.kind === "decision" ? { blocking: panel.blocking, hasToolRow: hasToolRow && panel.toolCallId !== undefined } : {}),
  });
}

/**
 * Does this panel live as an island (dock on desktop, chip-and-sheet on a
 * phone)? Islands need a live number; the table already keeps kinds without
 * one out of the dock.
 *
 * Only the phone's own `follow → sheet` branch counts. A genuine `inspect`
 * panel also reads `sheet`, and turning it into a 28px pill on a phone would
 * give the intent that means "now" strictly less attention than it gets on a
 * desktop; those open instead (see `PanelInspectSheet`).
 */
export function isIsland(panel: Panel, viewport: Viewport): boolean {
  const p = placementOf(panel, viewport);
  return p.surface === "dock" || (viewport === "mobile" && p.surface === "sheet" && p.via === "phone-follow" && panel.kind !== "decision");
}

/**
 * Does this panel want a sheet of its own, on every width? That is `inspect`
 * — the intent whose whole meaning is "I want your attention now" — and never
 * a decision, which has its own three surfaces.
 */
export function wantsInspectSheet(panel: Panel, viewport: Viewport): boolean {
  if (panel.kind === "decision") return false;
  const p = placementOf(panel, viewport);
  return p.surface === "sheet" && p.via !== "phone-follow";
}
