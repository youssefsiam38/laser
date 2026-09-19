const MINIMUM_RESERVE = 1;
/**
 * How much unloaded history may stand in front of the reader at once, in
 * screens. An estimate of a whole long conversation can be tens of thousands
 * of pixels; a person reading upwards would then travel through a blank region
 * no page can fill fast enough, which is what they see as "loading for ever".
 * Pages arrive as they read, so the range ahead is kept to what the next few
 * pages can cover, and grows again while a cursor remains (D-302).
 */
const RESERVE_SCREENS = 3;

export interface HistoryReserveEstimate {
  hasBefore: boolean;
  userOffset: number;
  loadedUserTurns: number;
  loadedHeight: number;
  rowEstimate: number;
  lastPageHeight: number;
  /** The reading window's height; the reserve never exceeds a few of these. */
  viewportHeight?: number | undefined;
}

/**
 * Estimates only the history that is still unloaded. `userOffset` is normally
 * the strongest signal. A tool-heavy turn can contain many pages behind one
 * prompt, so a remaining cursor with zero/one earlier prompts uses the loaded
 * projected page as its conservative range rather than multiplying protocol
 * entries that may all fold into one rendered turn.
 */
export function estimateHistoryReserve(input: HistoryReserveEstimate): number {
  if (!input.hasBefore) return 0;
  const row = Math.max(MINIMUM_RESERVE, input.rowEstimate);
  const averageTurn = input.loadedUserTurns > 0 && input.loadedHeight > 0
    ? input.loadedHeight / input.loadedUserTurns
    : row;
  const estimate = input.userOffset > 1
    ? Math.max(row, averageTurn * input.userOffset)
    : Math.max(row, input.loadedHeight, input.lastPageHeight);
  const ceiling = input.viewportHeight && input.viewportHeight > 0
    ? input.viewportHeight * RESERVE_SCREENS
    : undefined;
  return ceiling ? Math.max(row, Math.min(estimate, ceiling)) : estimate;
}

/** Unloaded-history geometry. Only arrived-page height may reduce it. */
export class HistoryReserveModel {
  height = 0;
  ready = false;
  private reading = false;
  private hasBefore = false;
  private lastPageHeight = 0;

  reset() {
    this.height = 0;
    this.ready = false;
    this.reading = false;
    this.hasBefore = false;
    this.lastPageHeight = 0;
  }

  configure(input: Omit<HistoryReserveEstimate, "lastPageHeight"> & { rows: number; mayGrow?: boolean }) {
    this.hasBefore = input.hasBefore;
    if (!input.hasBefore) {
      this.height = 0;
      this.ready = false;
      return;
    }
    // An empty index cannot make an honest estimate. Wait until ids and their
    // initial heights exist; the caller deliberately invokes this after setIds.
    if (input.rows <= 0 || input.loadedHeight <= 0 || input.rowEstimate <= 0) return;
    const estimate = estimateHistoryReserve({ ...input, lastPageHeight: this.lastPageHeight });
    if (!this.ready || !this.reading) {
      this.height = estimate;
      this.ready = true;
      return;
    }
    // Arrived pages consume the estimate, so that the next page lands in the
    // pixels the placeholder was holding. After a few pages it sits at its
    // floor while the producer still has hundreds of turns before it: the
    // thumb then says "this is the root" of a conversation nowhere near its
    // root, and the reading position is never "inside the estimate" again.
    // While a cursor remains, the range ahead is grown back to the bounded
    // estimate (D-302) — but only when the caller says the growth can be held
    // still, because space added above the reader is movement until something
    // measures it away.
    this.height = Math.max(this.height, input.mayGrow ? estimate : this.floor());
  }

  startReading() { this.reading = true; }

  /** Convert this much estimated unloaded content into rows loaded above. */
  arrived(pageHeight: number) {
    if (!this.hasBefore || !this.ready || !Number.isFinite(pageHeight) || pageHeight <= 0) return;
    this.lastPageHeight = pageHeight;
    this.height = Math.max(this.floor(), this.height - pageHeight);
  }

  /**
   * Refine the same arrived page; unrelated row growth never calls this.
   * Answers whether the range actually moved, so the caller can tell a render
   * that changes geometry from one that does not.
   */
  refineArrived(delta: number): boolean {
    if (!this.hasBefore || !this.ready || !Number.isFinite(delta) || Math.abs(delta) < 0.5) return false;
    const before = this.height;
    this.lastPageHeight = Math.max(MINIMUM_RESERVE, this.lastPageHeight + delta);
    this.height = Math.max(this.floor(), this.height - delta);
    return Math.abs(this.height - before) >= 0.5;
  }

  // Once reading starts, one geometric unit is enough to say "not the root".
  // A row-sized floor can exceed the final page and collapse the range when the
  // producer removes the cursor; arrived rows now grow the range monotonically.
  private floor() { return this.hasBefore ? MINIMUM_RESERVE : 0; }

}

export interface EarlierPageTransaction {
  readonly before: string | undefined;
  readonly settled: boolean;
  readonly storeChanged: boolean;
  readonly committedAfterStoreChange: boolean;
}

export type EarlierPageTransition =
  | { type: "begin"; before: string | undefined }
  | { type: "store-change" }
  | { type: "settled" }
  | { type: "commit" }
  | { type: "cancel" };

export interface EarlierPageTransitionResult {
  state: EarlierPageTransaction | undefined;
  released: boolean;
}

/** One transition authority makes every transaction exit explicit and idempotent. */
export function transitionEarlierPage(
  state: EarlierPageTransaction | undefined,
  event: EarlierPageTransition,
): EarlierPageTransitionResult {
  if (event.type === "begin") {
    return {
      state: { before: event.before, settled: false, storeChanged: false, committedAfterStoreChange: false },
      released: false,
    };
  }
  if (!state) return { state: undefined, released: false };
  if (event.type === "cancel") return { state: undefined, released: true };
  const next: EarlierPageTransaction = event.type === "store-change"
    ? { ...state, storeChanged: true }
    : event.type === "settled"
      ? { ...state, settled: true }
      : state.storeChanged
        ? { ...state, committedAfterStoreChange: true }
        : state;
  const released = next.settled && next.committedAfterStoreChange;
  return { state: released ? undefined : next, released };
}
