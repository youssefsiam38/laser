/**
 * The dock's geometry state (docs/ux-panels.md "The dock", D-20). Pure.
 *
 *   - four island sizes, one element each (the size is the only thing that changes)
 *   - at most two expanded per column; a third shrinks the least recently
 *     watched to minimal, never evicts
 *   - capacity for two columns past ~640px; occupancy activates the second
 *   - a draggable divider per column, remembered per session
 *   - maximize is a flag over an expanded island, so Esc returns it exactly
 *
 * Tested in test/panels/dock-state.test.ts.
 */

export type IslandSize = "minimal" | "compact" | "expanded" | "maximized";

export interface DockIsland {
  key: string;
  /** The size the island keeps under a maximize; never "maximized" itself. */
  size: Exclude<IslandSize, "maximized">;
  column: 0 | 1;
  /** Epoch ms of the last time a person expanded or interacted with it. */
  lastWatchedAt: number;
  /** Shown as minimal, pointing at the window/tab it went to. */
  poppedOut: boolean;
}

export interface DockState {
  islands: Readonly<Record<string, DockIsland>>;
  /** Creation order — islands never reshuffle. */
  order: readonly string[];
  columns: 1 | 2;
  /** Dock width in px; the user drags its edge. */
  width: number;
  /** Share of the column's expanded height taken by the first expanded island, per column. */
  dividers: readonly [number, number];
  /** Key of the island taking over the window, if any. */
  maximized?: string | undefined;
  /** The dock was hidden by a person; islands keep their state underneath. */
  hidden: boolean;
  /** Dismissed by a person: hidden until the panel needs them (see `resurface`). */
  dismissed: readonly string[];
}

export const DOCK_MIN_WIDTH = 288;
export const DOCK_DEFAULT_WIDTH = 384;
export const DOCK_TWO_COLUMN_WIDTH = 640;
export const WINDOW_TWO_COLUMN_WIDTH = 1600;
export const MAX_EXPANDED_PER_COLUMN = 2;
/** A pane never shrinks below its header. */
export const DIVIDER_MIN = 0.15;

export const initialDock: DockState = {
  islands: {},
  order: [],
  columns: 1,
  width: DOCK_DEFAULT_WIDTH,
  dividers: [0.5, 0.5],
  hidden: false,
  dismissed: [],
};

export type DockAction =
  | { type: "register"; key: string; now: number }
  | { type: "unregister"; key: string }
  | { type: "reorder"; key: string; over: string }
  | { type: "setSize"; key: string; size: Exclude<IslandSize, "maximized">; now: number }
  | { type: "toggleExpanded"; key: string; now: number }
  | { type: "maximize"; key: string; now: number }
  | { type: "restore" }
  | { type: "popOut"; key: string; now: number }
  | { type: "popIn"; key: string }
  | { type: "setColumns"; columns: 1 | 2 }
  | { type: "setWidth"; width: number; maxWidth: number }
  | { type: "setDivider"; column: 0 | 1; ratio: number }
  | { type: "setHidden"; hidden: boolean }
  | { type: "dismiss"; key: string }
  /** The panel wants a person: undo a dismissal so it can be seen (R5). */
  | { type: "resurface"; key: string; now: number }
  | { type: "watched"; key: string; now: number };

/**
 * One column or two (D-20: "past a width of about 640px — or a window of
 * 1600px and up — it becomes two columns").
 *
 * The rule is the *dock's* width, never the window's. A wide monitor is why
 * the dock grows (see {@link defaultDockWidth}), not a reason to split a
 * narrow one: a 1860px window with a 384px dock would otherwise get two 180px
 * columns, which is narrower than one column at any width and is exactly the
 * "shrink by dropping content, never by squeezing" rule inverted (R13).
 */
export function columnsFor(dockWidth: number, _windowWidth?: number): 1 | 2 {
  return dockWidth >= DOCK_TWO_COLUMN_WIDTH ? 2 : 1;
}

/**
 * The dock's own chrome: its padding and its hairline. `columnsFor` measures
 * the content box, so a dock opened at exactly the threshold would lay out one
 * column and look like the rule was ignored.
 */
export const DOCK_CHROME = 24;

/**
 * How wide the dock starts on a screen this size. A wide monitor opens it wide
 * enough for two columns, so "a wide monitor gets four expanded panels without
 * any of them getting narrow" is true out of the box. Only the *default*: a
 * width a person dragged is theirs and is never overridden.
 */
export function defaultDockWidth(windowWidth: number): number {
  return windowWidth >= WINDOW_TWO_COLUMN_WIDTH ? DOCK_TWO_COLUMN_WIDTH + DOCK_CHROME : DOCK_DEFAULT_WIDTH;
}

export function reduceDock(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case "register": {
      if (state.islands[action.key]) return state;
      const island: DockIsland = { key: action.key, size: "minimal", column: 0, lastWatchedAt: action.now, poppedOut: false };
      return { ...state, islands: { ...state.islands, [action.key]: island }, order: [...state.order, action.key] };
    }
    case "unregister": {
      if (!state.islands[action.key]) return state;
      const { [action.key]: _gone, ...islands } = state.islands;
      return {
        ...state,
        islands,
        order: state.order.filter((k) => k !== action.key),
        dismissed: state.dismissed.filter((k) => k !== action.key),
        ...(state.maximized === action.key ? { maximized: undefined } : {}),
      };
    }
    case "reorder": {
      const from = state.order.indexOf(action.key);
      const to = state.order.indexOf(action.over);
      if (from < 0 || to < 0 || from === to) return state;
      const order = [...state.order];
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved!);
      return { ...state, order };
    }
    case "setSize":
      return setSize(state, action.key, action.size, action.now);
    case "toggleExpanded": {
      const island = state.islands[action.key];
      if (!island) return state;
      return setSize(state, action.key, island.size === "expanded" ? "compact" : "expanded", action.now);
    }
    case "maximize": {
      if (!state.islands[action.key]) return state;
      const expanded = state.islands[action.key]!.size === "expanded" ? state : setSize(state, action.key, "expanded", action.now);
      return { ...expanded, maximized: action.key, hidden: false };
    }
    case "restore":
      return state.maximized === undefined ? state : { ...state, maximized: undefined };
    case "popOut": {
      const island = state.islands[action.key];
      if (!island) return state;
      const next = setSize(state, action.key, "minimal", action.now);
      return {
        ...next,
        islands: { ...next.islands, [action.key]: { ...next.islands[action.key]!, poppedOut: true } },
        ...(state.maximized === action.key ? { maximized: undefined } : {}),
      };
    }
    case "popIn": {
      const island = state.islands[action.key];
      if (!island || !island.poppedOut) return state;
      return { ...state, islands: { ...state.islands, [action.key]: { ...island, poppedOut: false } } };
    }
    case "setColumns": {
      if (action.columns === state.columns) return state;
      let next: DockState = { ...state, columns: action.columns };
      if (action.columns === 1) {
        // Everything moves to the one column, then the per-column rule applies.
        const islands: Record<string, DockIsland> = {};
        for (const [key, island] of Object.entries(state.islands)) islands[key] = { ...island, column: 0 };
        next = enforceColumn({ ...next, islands }, 0);
      }
      return next;
    }
    case "setWidth": {
      const width = Math.round(Math.min(Math.max(action.width, DOCK_MIN_WIDTH), Math.max(DOCK_MIN_WIDTH, action.maxWidth)));
      return width === state.width ? state : { ...state, width };
    }
    case "setDivider": {
      const ratio = Math.min(1 - DIVIDER_MIN, Math.max(DIVIDER_MIN, action.ratio));
      // Snap to the midpoint: a divider that is almost centred is centred.
      const snapped = Math.abs(ratio - 0.5) < 0.03 ? 0.5 : ratio;
      const dividers: [number, number] = [state.dividers[0], state.dividers[1]];
      dividers[action.column] = snapped;
      return { ...state, dividers };
    }
    case "setHidden":
      return state.hidden === action.hidden ? state : { ...state, hidden: action.hidden };
    case "dismiss": {
      if (!state.islands[action.key] || state.dismissed.includes(action.key)) return state;
      const next = setSize(state, action.key, "minimal", Date.now());
      return {
        ...next,
        dismissed: [...state.dismissed, action.key],
        ...(state.maximized === action.key ? { maximized: undefined } : {}),
      };
    }
    case "resurface": {
      if (!state.dismissed.includes(action.key)) return state;
      return { ...state, dismissed: state.dismissed.filter((k) => k !== action.key) };
    }
    case "watched": {
      const island = state.islands[action.key];
      if (!island) return state;
      return { ...state, islands: { ...state.islands, [action.key]: { ...island, lastWatchedAt: action.now } } };
    }
  }
}

function setSize(state: DockState, key: string, size: DockIsland["size"], now: number): DockState {
  const island = state.islands[key];
  if (!island) return state;
  if (island.size === size && !island.poppedOut) return { ...state, islands: { ...state.islands, [key]: { ...island, lastWatchedAt: now } } };
  const column = size === "expanded" && island.size !== "expanded" ? leastLoadedColumn(state) : island.column;
  const islands: Record<string, DockIsland> = {
    ...state.islands,
    [key]: { ...island, size, column, lastWatchedAt: now, poppedOut: false },
  };
  let next: DockState = { ...state, islands };
  if (size === "expanded") next = enforceColumn(next, column, key);
  if (state.maximized === key && size !== "expanded") next = { ...next, maximized: undefined };
  return next;
}

/** The column with fewer expanded islands; ties go left. */
export function leastLoadedColumn(state: DockState): 0 | 1 {
  if (state.columns === 1) return 0;
  const counts = [0, 0];
  for (const island of Object.values(state.islands)) if (island.size === "expanded") counts[island.column]!++;
  return counts[1]! < counts[0]! ? 1 : 0;
}

/**
 * At most MAX_EXPANDED_PER_COLUMN expanded in a column. The one just expanded
 * (`keep`) stays; the least recently watched of the rest shrinks to minimal,
 * where it keeps ticking. Nothing is evicted.
 */
function enforceColumn(state: DockState, column: 0 | 1, keep?: string): DockState {
  const expanded = state.order
    .map((k) => state.islands[k])
    .filter((i): i is DockIsland => i !== undefined && i.size === "expanded" && i.column === column);
  if (expanded.length <= MAX_EXPANDED_PER_COLUMN) return state;
  const candidates = expanded.filter((i) => i.key !== keep).sort((a, b) => a.lastWatchedAt - b.lastWatchedAt);
  const islands = { ...state.islands };
  let excess = expanded.length - MAX_EXPANDED_PER_COLUMN;
  for (const island of candidates) {
    if (excess === 0) break;
    islands[island.key] = { ...island, size: "minimal" };
    excess--;
  }
  return { ...state, islands };
}

/** Sizes as rendered: the maximized flag wins over the stored size. */
export function renderedSize(state: DockState, key: string): IslandSize {
  if (state.maximized === key) return "maximized";
  return state.islands[key]?.size ?? "minimal";
}

export function expandedIn(state: DockState, column: 0 | 1): DockIsland[] {
  return state.order
    .map((k) => state.islands[k])
    .filter((i): i is DockIsland => i !== undefined && i.size === "expanded" && i.column === column);
}

// ---------------------------------------------------------------------------
// Persistence (per browser session)
// ---------------------------------------------------------------------------

export interface DockPrefs {
  width: number;
  dividers: [number, number];
  hidden: boolean;
  /** key → size, so a reload keeps what you were watching. */
  sizes: Record<string, DockIsland["size"]>;
}

export function dockPrefs(state: DockState): DockPrefs {
  const sizes: Record<string, DockIsland["size"]> = {};
  for (const [key, island] of Object.entries(state.islands)) if (island.size !== "minimal") sizes[key] = island.size;
  return { width: state.width, dividers: [state.dividers[0], state.dividers[1]], hidden: state.hidden, sizes };
}

export function parseDockPrefs(raw: unknown): Partial<DockPrefs> {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<DockPrefs> = {};
  if (typeof p.width === "number" && Number.isFinite(p.width)) out.width = p.width;
  if (Array.isArray(p.dividers) && p.dividers.length === 2 && p.dividers.every((d) => typeof d === "number")) {
    out.dividers = [p.dividers[0] as number, p.dividers[1] as number];
  }
  if (typeof p.hidden === "boolean") out.hidden = p.hidden;
  if (p.sizes && typeof p.sizes === "object") {
    const sizes: Record<string, DockIsland["size"]> = {};
    for (const [key, size] of Object.entries(p.sizes as Record<string, unknown>)) {
      if (size === "compact" || size === "expanded") sizes[key] = size;
    }
    out.sizes = sizes;
  }
  return out;
}

export function applyDockPrefs(state: DockState, prefs: Partial<DockPrefs>): DockState {
  return {
    ...state,
    ...(prefs.width !== undefined ? { width: Math.max(DOCK_MIN_WIDTH, prefs.width) } : {}),
    ...(prefs.dividers ? { dividers: prefs.dividers } : {}),
    ...(prefs.hidden !== undefined ? { hidden: prefs.hidden } : {}),
  };
}
