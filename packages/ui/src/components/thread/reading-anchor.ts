/**
 * Where the person is reading, measured from the browser, and what to write to
 * `scrollTop` when a layout moves it (M16-T85).
 *
 * The position is recorded in the scroller's own content coordinates
 * (`rect.top - viewport.top + scrollTop`), which are scroll-invariant: the
 * person's own scrolling between two readings cancels out, and a write this
 * controller makes never looks like content moving. At the layout that moves
 * the recorded element — a React commit, a `ResizeObserver` delivery, a
 * measured frame — `scrollTop` moves by exactly the difference.
 *
 * It lives beside the viewport controller rather than inside it because its
 * only inputs are the viewport element, the mounted rows and their indices, so
 * it can be exercised on its own.
 */

/** The blocks a reading position can be pinned to inside a row. */
export const LANDMARKS = ".md-body > *, [data-slot=collapsible-trigger]";
/**
 * How many rows the reader's measured position is recorded on. One is the
 * answer whenever it survives the change; the rest exist because a producer
 * page can fold the row the place is anchored on into a merged group.
 */
const ANCHOR_CANDIDATES = 4;

/** The row, and the block inside it, the person is reading (from `capture()`). */
export interface ReadingLandmark {
  messageId: string;
  landmark?: number;
  toolCallId?: string;
}

/** One thing the reading position is held by: a row, or a block inside a row. */
interface Candidate {
  id: string;
  docTop: number;
  /** Set when this candidate is a block inside the row rather than the row. */
  mark?: ReadingLandmark;
}

export interface ReadingAnchorContext {
  viewport: HTMLElement | undefined;
  nodes: ReadonlyMap<string, HTMLElement>;
  positions: ReadonlyMap<string, number>;
  /** The reading landmark, as `capture()` last resolved it. */
  landmark: ReadingLandmark | undefined;
  /** The viewport's top edge is above the loaded rows: inside the estimate. */
  insideEstimate: boolean;
  /** A page has arrived and is still being reconciled: do not re-choose. */
  reconciling: boolean;
  /** A row's estimated offset in content coordinates, for the one fallback. */
  offsetOf(id: string): number | undefined;
  /** Move by exactly what changed above the reader; true when it wrote. */
  shift(delta: number): boolean;
}

/** A row's top in the scroller's content coordinates, so a scroll cannot change it. */
export function contentTop(rect: DOMRect, viewportTop: number, viewport: HTMLElement) {
  return rect.top - viewportTop + viewport.scrollTop;
}

/**
 * The block inside a row the reading position names, resolved exactly as the
 * absolute placement resolves it, or nothing when it is not there any more.
 */
export function resolveLandmark(row: HTMLElement, mark: ReadingLandmark): HTMLElement | undefined {
  const element = mark.toolCallId
    ? row.querySelector<HTMLElement>(`[data-tool-call="${CSS.escape(mark.toolCallId)}"] ${LANDMARKS.split(",").at(-1)!.trim()}`)
    : mark.landmark === undefined
      ? undefined
      : row.querySelectorAll<HTMLElement>(LANDMARKS)[mark.landmark];
  return element && element.getBoundingClientRect().height > 0 ? element : undefined;
}

export class ReadingAnchor {
  private candidates: Candidate[] | undefined;
  /** The one case with no measured element at all: a reader on loaded rows with none mounted. */
  private estimate: { id: string; offset: number } | undefined;

  constructor(private readonly context: () => ReadingAnchorContext) {}

  /** Something measured is recorded, so this is the authority for the reader's pixels. */
  get recorded() { return this.candidates !== undefined; }

  clear() { this.candidates = undefined; this.estimate = undefined; }

  /**
   * Record where the reader is standing, from the DOM, while the layout is
   * settled. Preference order: the block the person is reading, then the row
   * it is in, then the rest of what is on screen, then the nearest rows just
   * outside the viewport, which answer the same question when a page folds or
   * replaces everything visible.
   *
   * The block comes first because growth *inside* the row the reader is in —
   * an image decoding, highlighting reflowing, a late markdown block — does
   * not move the row's top and does move the person's text.
   *
   * Nothing is recorded at all when no loaded row is on screen: the person is
   * looking at the placeholder for history that has not arrived, the rows that
   * arrive belong exactly there, and holding a row below the fold still would
   * push them back down for their own reading (D-302).
   */
  record() {
    const context = this.context();
    const { viewport, nodes, positions, landmark, insideEstimate, reconciling } = context;
    if (!viewport) { this.clear(); return; }
    // A page that has arrived but not been measured is still being reconciled:
    // its rows hold estimated space that the next measured frame exchanges
    // with the estimated range. Re-recording in the middle of that would spend
    // half the exchange and keep the other half, which is exactly how a reader
    // ends up somewhere neither position meant. One page, one answer.
    if (reconciling && this.candidates !== undefined) return;
    const box = viewport.getBoundingClientRect();
    const measured = [...nodes.entries()]
      .flatMap(([id, node]) => {
        const index = positions.get(id);
        return index === undefined ? [] : [{ id, index, node, rect: node.getBoundingClientRect() }];
      })
      .sort((a, b) => a.index - b.index);
    const onScreen = measured.filter(row => row.rect.bottom > box.top && row.rect.top < box.bottom);
    const nearby = onScreen.length === 0 ? [] : [
      ...measured.filter(row => row.rect.bottom <= box.top).slice(-1),
      ...measured.filter(row => row.rect.top >= box.bottom).slice(0, 1),
    ];
    const anchorRow = landmark ? onScreen.find(row => row.id === landmark.messageId) : undefined;
    const candidates: Candidate[] = [];
    if (anchorRow && landmark) {
      const mark = resolveLandmark(anchorRow.node, landmark);
      if (mark) candidates.push({ id: anchorRow.id, docTop: contentTop(mark.getBoundingClientRect(), box.top, viewport), mark: landmark });
    }
    const rows: string[] = [];
    for (const row of [...(anchorRow ? [anchorRow] : []), ...onScreen, ...nearby]) {
      if (rows.includes(row.id)) continue;
      rows.push(row.id);
      candidates.push({ id: row.id, docTop: contentTop(row.rect, box.top, viewport) });
      if (rows.length >= ANCHOR_CANDIDATES) break;
    }
    // The estimated index is kept for exactly one case: the reader is on
    // loaded rows and there is no measured row to hold — a destination jump, or
    // a window that has not caught up with a long wheel. It is a last resort,
    // not the authority, because it mixes measured rows with guessed ones.
    const offset = rows.length === 0 && landmark && !insideEstimate ? context.offsetOf(landmark.messageId) : undefined;
    this.candidates = candidates;
    this.estimate = offset === undefined || !landmark ? undefined : { id: landmark.messageId, offset };
  }

  /**
   * Spend the recorded position against the layout the browser has now: the
   * measured delta already contains the arrived rows, whatever they measured
   * against their estimate, the reserve giving space back and the controls
   * above the transcript, so nothing else may shift in the same commit.
   */
  apply(above: number): boolean {
    const candidates = this.candidates;
    const { viewport, nodes, positions, offsetOf, shift } = this.context();
    if (!candidates || !viewport) return false;
    const box = viewport.getBoundingClientRect();
    for (const candidate of candidates) {
      const node = nodes.get(candidate.id);
      if (!node || !positions.has(candidate.id)) continue;
      // A block that cannot be resolved any more — the row re-rendered into a
      // different shape — falls through to the row's own top, which is the
      // next candidate for the same row.
      const element = candidate.mark ? resolveLandmark(node, candidate.mark) : node;
      if (!element) continue;
      const delta = contentTop(element.getBoundingClientRect(), box.top, viewport) - candidate.docTop;
      if (!shift(delta)) return false;
      // The change has been spent. A recorded position is in content
      // coordinates, so the write itself did not move it: without this the
      // next commit finds the same difference and pays for it again.
      this.refresh();
      return true;
    }
    // Nothing recorded survived. Inside the estimate that is the honest answer:
    // what the person is looking at is the placeholder those rows belong in,
    // and nothing was recorded there, so there is nothing to spend.
    const estimate = this.estimate;
    if (!estimate) return false;
    const offset = offsetOf(estimate.id);
    if (!shift((offset === undefined ? 0 : offset - estimate.offset) + above)) return false;
    this.refresh();
    return true;
  }

  /**
   * Keep the recorded elements, move their recorded positions to where the
   * layout that was just compensated puts them. Used instead of a fresh record
   * while an arrived page is still settling, so one page is never half-spent.
   */
  refresh() {
    const candidates = this.candidates;
    const { viewport, nodes, positions, offsetOf } = this.context();
    if (!candidates || !viewport) return;
    const box = viewport.getBoundingClientRect();
    this.candidates = candidates.flatMap(candidate => {
      const node = nodes.get(candidate.id);
      if (!node || !positions.has(candidate.id)) return [];
      const element = candidate.mark ? resolveLandmark(node, candidate.mark) : node;
      if (!element) return [];
      return [{ ...candidate, docTop: contentTop(element.getBoundingClientRect(), box.top, viewport) }];
    });
    const offset = this.estimate ? offsetOf(this.estimate.id) : undefined;
    this.estimate = this.estimate && offset !== undefined ? { id: this.estimate.id, offset } : undefined;
  }
}
