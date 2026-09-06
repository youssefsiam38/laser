/**
 * Dock layout: islands are absolutely positioned inside one container, so an
 * island is one DOM element for its whole life and a size change is a change
 * of rectangle — which is what the morph animates. Pure.
 *
 *   ┌────────────────────────────┐
 *   │ [pill] [pill] [pill] [+N]  │  minimal islands: a strip that wraps to two rows
 *   ├────────────────────────────┤
 *   │ one expanded island        │  one fills the canvas
 *   ├────────────────────────────┤
 *   │ two expanded islands       │  two are full-width stacked rows
 *   ├──────────────┬─────────────┤
 *   │ first        │ third       │  three or four activate a 2×2 grid
 *   ├──────────────┼─────────────┤
 *   │ second       │ fourth      │  without remounting any island
 *   └──────────────┴─────────────┘
 *
 * The pure parts are tested in test/panels/dock-state.test.ts.
 */
import { MAX_EXPANDED_PER_COLUMN, type DockState, type IslandSize } from "./dock-state.js";

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface IslandRect extends Rect {
  size: IslandSize;
  /** Beyond the two-row budget: represented by the `+N` island instead. */
  hidden: boolean;
}

export interface DockLayout {
  rects: Readonly<Record<string, IslandRect>>;
  /** Keys folded into the `+N` island, in order. */
  overflow: readonly string[];
  /** Where the `+N` island sits, when there is one. */
  overflowRect?: Rect;
  /** Height of the minimal strip including padding, 0 when empty. */
  stripHeight: number;
  /** Divider handles, one per column with two expanded islands. */
  dividers: ReadonlyArray<{ column: 0 | 1; rect: Rect; keys: [string, string] }>;
  /** Content height actually needed (the container may be taller). */
  contentHeight: number;
}

export const ISLAND_HEIGHT: Record<Exclude<IslandSize, "expanded" | "maximized">, number> = { minimal: 28, compact: 36 };
export const PILL_WIDTH = 164;
export const GAP = 8;
export const PAD = 8;
export const STRIP_ROWS = 2;
/** Height of an expanded island's header; it never shrinks below this. */
export const EXPANDED_MIN = 40;

/**
 * How many minimal pills fit a strip this wide, and how many fit two rows
 * before the rest folds into `+N` (docs/ux-panels.md: "Minimal islands wrap…
 * Past two rows, and only then, the remainder collapses into a single `+N`").
 *
 * Shared with the phone's strip so both fold at the same place: a pill is a
 * fixed width that truncates, so the budget is arithmetic rather than a guess
 * at how long the titles are.
 */
export function stripBudget(inner: number): { pillWidth: number; perRow: number; budget: number } {
  const pillWidth = Math.min(PILL_WIDTH, Math.max(0, inner));
  const perRow = Math.max(1, Math.floor((inner + GAP) / (pillWidth + GAP)));
  return { pillWidth, perRow, budget: perRow * STRIP_ROWS };
}

export function layoutDock(state: DockState, width: number, height: number): DockLayout {
  const rects: Record<string, IslandRect> = {};
  const inner = Math.max(0, width - PAD * 2);

  // --- strip: minimal islands (and popped-out ones), wrapping, then +N ------
  const minimal = state.order.filter((k) => {
    const island = state.islands[k];
    return island !== undefined && (island.size === "minimal" || island.poppedOut) && state.maximized !== k;
  });
  const { pillWidth, perRow, budget } = stripBudget(inner);
  const needsOverflow = minimal.length > budget;
  const visibleCount = needsOverflow ? budget - 1 : minimal.length;
  const visible = minimal.slice(0, visibleCount);
  const overflow = minimal.slice(visibleCount);
  const slots = visible.length + (needsOverflow ? 1 : 0);
  const rows = slots === 0 ? 0 : Math.ceil(slots / perRow);
  const stripHeight = rows === 0 ? 0 : PAD + rows * ISLAND_HEIGHT.minimal + (rows - 1) * GAP;
  const slot = (i: number): Rect => ({
    top: PAD + Math.floor(i / perRow) * (ISLAND_HEIGHT.minimal + GAP),
    left: PAD + (i % perRow) * (pillWidth + GAP),
    width: pillWidth,
    height: ISLAND_HEIGHT.minimal,
  });
  visible.forEach((key, i) => {
    rects[key] = { ...slot(i), size: "minimal", hidden: false };
  });
  const overflowRect = needsOverflow ? slot(visible.length) : undefined;
  for (const key of overflow) rects[key] = { ...slot(visible.length), size: "minimal", hidden: true };

  // --- watched panels -------------------------------------------------------
  // Width says whether two readable columns are possible; occupancy says
  // whether there is any reason to use them. Projecting creation order into
  // visual slots here also upgrades persisted docks whose first two panels
  // were previously assigned to separate columns.
  const expandedKeys = state.order
    .filter((key) => {
      const island = state.islands[key];
      return island !== undefined && island.size === "expanded" && !island.poppedOut;
    })
    .slice(0, state.columns * MAX_EXPANDED_PER_COLUMN);
  const columns = state.columns === 2 && expandedKeys.length >= 3 ? 2 : 1;
  const colWidth = Math.max(0, (inner - (columns - 1) * GAP) / columns);
  const bodyTop = stripHeight + PAD;
  const bodyHeight = Math.max(0, height - bodyTop - PAD);
  const dividers: Array<{ column: 0 | 1; rect: Rect; keys: [string, string] }> = [];
  let contentHeight = stripHeight;

  for (let c = 0; c < columns; c++) {
    const column = c as 0 | 1;
    const left = PAD + c * (colWidth + GAP);
    const compact = state.order.filter((k) => {
      const island = state.islands[k];
      return island !== undefined
        && island.size === "compact"
        && !island.poppedOut
        && (columns === 1 || island.column === column)
        && state.maximized !== k;
    });
    const expanded = columns === 1
      ? expandedKeys.slice(0, MAX_EXPANDED_PER_COLUMN)
      : expandedKeys.slice(column * MAX_EXPANDED_PER_COLUMN, (column + 1) * MAX_EXPANDED_PER_COLUMN);

    let y = bodyTop;
    for (const key of compact) {
      rects[key] = { top: y, left, width: colWidth, height: ISLAND_HEIGHT.compact, size: "compact", hidden: false };
      y += ISLAND_HEIGHT.compact + GAP;
    }
    const remaining = Math.max(0, bodyHeight - (y - bodyTop));
    if (expanded.length === 1) {
      const key = expanded[0]!;
      // In the 2×2 layout a lone third panel owns the top-right quadrant;
      // the empty fourth cell is real empty space until a fourth panel opens.
      const h = columns === 2 ? Math.max(EXPANDED_MIN, Math.round((remaining - GAP) / 2)) : Math.max(EXPANDED_MIN, remaining);
      rects[key] = { top: y, left, width: colWidth, height: h, size: state.maximized === key ? "maximized" : "expanded", hidden: false };
      y += h;
    } else if (expanded.length === 2) {
      const usable = Math.max(EXPANDED_MIN * 2 + GAP, remaining);
      const ratio = state.dividers[column] ?? 0.5;
      const first = Math.max(EXPANDED_MIN, Math.min(usable - GAP - EXPANDED_MIN, Math.round((usable - GAP) * ratio)));
      const second = usable - GAP - first;
      const [a, b] = expanded as [string, string];
      rects[a] = { top: y, left, width: colWidth, height: first, size: state.maximized === a ? "maximized" : "expanded", hidden: false };
      dividers.push({ column, rect: { top: y + first, left, width: colWidth, height: GAP }, keys: [a, b] });
      rects[b] = { top: y + first + GAP, left, width: colWidth, height: second, size: state.maximized === b ? "maximized" : "expanded", hidden: false };
      y += usable;
    }
    contentHeight = Math.max(contentHeight, y + PAD);
  }

  return { rects, overflow, ...(overflowRect ? { overflowRect } : {}), stripHeight, dividers, contentHeight };
}

/** The ratio a divider drag lands on, from the pointer's y inside the column's expanded region. */
export function dividerRatio(pointerY: number, regionTop: number, regionHeight: number): number {
  if (regionHeight <= 0) return 0.5;
  return (pointerY - regionTop) / regionHeight;
}
