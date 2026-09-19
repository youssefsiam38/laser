/**
 * How much unloaded history stands in front of the reader, counted in turns
 * (M16-T87, D-303).
 *
 * The unloaded part of a conversation is drawn as conversation-shaped
 * placeholder turns inside the transcript's head item, so the virtualizer
 * measures it like any other content. Nothing here writes pixels or
 * compensates for them: this model answers one question — how many placeholder
 * turns the head item renders — and the engine's own measurement of that item
 * is what moves, or does not move, the person.
 *
 * The turn is the unit because it is the unit the producer pages in and the
 * unit `history.userOffset` counts. A pixel model of the same thing was the
 * second authority this milestone removed.
 */

/**
 * The nominal height of one placeholder turn. It is fixed in the stylesheet
 * (`--history-placeholder-turn`), so a turn measures the same whether it has
 * been painted or is still a skipped `content-visibility` box, and the range
 * a person scrolls through never changes height under them.
 */
export const PLACEHOLDER_TURN_HEIGHT = 288;

/**
 * How much unloaded history may stand in front of the reader at once, in
 * screens. An estimate of a whole long conversation is tens of thousands of
 * pixels; a person reading upwards would travel through a blank region no page
 * can fill fast enough, which is what they saw as "loading for ever". Pages
 * arrive as they read, so the range ahead is kept to what the next few pages
 * can cover, and it grows again while a cursor remains (D-302).
 */
const RESERVE_SCREENS = 3;

/**
 * What a remaining cursor is worth when the producer cannot say. `userOffset`
 * counts user prompts, and one tool-heavy prompt can hold a whole page of
 * rows, so zero or one prompt is not "almost nothing left" — it is "unknown".
 */
const UNKNOWN_TURNS = 2;

export interface HistoryPlaceholderInput {
  /** The producer still has a cursor for earlier history. */
  hasBefore: boolean;
  /** Earlier user prompts the producer says are not loaded here. */
  unloadedUserTurns: number;
  /** The reading window's height; the range never exceeds a few of these. */
  viewportHeight?: number | undefined;
  /**
   * Space may be added in front of the reader in this pass. Growth is content
   * above them, so it happens only where it cannot be felt: at the live edge,
   * or with the reader already at the top of the scroll range, where it is the
   * only way to give them somewhere to keep reading.
   */
  mayGrow: boolean;
  /**
   * Turns the region may not give up in this pass: the ones the person is
   * looking at. Replacing those with real rows would put a row in front of
   * somebody who has not reached it yet.
   */
  minimum?: number;
}

/** The most placeholder turns this window may hold at once. */
export function placeholderTurnCeiling(viewportHeight: number | undefined): number {
  const screens = viewportHeight && viewportHeight > 0 ? viewportHeight : PLACEHOLDER_TURN_HEIGHT;
  return Math.max(1, Math.round((screens * RESERVE_SCREENS) / PLACEHOLDER_TURN_HEIGHT));
}

/** The turn count a window with this much unloaded history aims at. */
export function placeholderTurnTarget(input: HistoryPlaceholderInput): number {
  if (!input.hasBefore) return 0;
  const ceiling = placeholderTurnCeiling(input.viewportHeight);
  const claimed = Math.ceil(Math.max(0, input.unloadedUserTurns)) || UNKNOWN_TURNS;
  return Math.max(1, Math.min(claimed, ceiling));
}

/**
 * The placeholder region's size over time. It shrinks from the bottom — the
 * turns nearest the loaded rows are the ones a page replaces — and grows only
 * when the caller says growth can be added without moving anybody.
 */
export class HistoryPlaceholder {
  /** Placeholder turns the head item renders right now. */
  turns = 0;
  private hasBefore = false;

  reset(): void {
    this.turns = 0;
    this.hasBefore = false;
  }

  /** True when the number of rendered turns actually changed. */
  configure(input: HistoryPlaceholderInput): boolean {
    const before = this.turns;
    this.hasBefore = input.hasBefore;
    const target = placeholderTurnTarget(input);
    const next = !input.hasBefore || this.turns === 0 || input.mayGrow
      ? target
      : Math.min(this.turns, target);
    // Never below what is on screen, and never above what there already is:
    // the floor protects the turns the person is reading, it cannot add any.
    this.turns = input.hasBefore ? Math.max(next, Math.min(this.turns, input.minimum ?? 0)) : next;
    return this.turns !== before;
  }

  /**
   * This many earlier turns have arrived as real rows. They belong at the
   * bottom of the region, so the same number of placeholder turns goes from
   * there: the page takes the pixels the placeholder was holding instead of
   * pushing the conversation further away from the person reading towards it.
   *
   * One turn always remains while a cursor does, because the region is also
   * the only thing on screen that says "this is not the beginning", and the
   * turns the reader can actually see stay until they have read past them.
   */
  arrived(turns: number, minimum = 0): boolean {
    if (!this.hasBefore || !Number.isFinite(turns) || turns <= 0 || this.turns === 0) return false;
    const before = this.turns;
    this.turns = Math.max(1, Math.min(this.turns, minimum), this.turns - Math.ceil(turns));
    return this.turns !== before;
  }
}
