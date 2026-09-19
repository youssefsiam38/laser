import { ThreadPrimitive, useThreadViewport, unstable_useThreadMessageIds } from "@assistant-ui/react";
import { defaultRangeExtractor, elementScroll, observeElementRect, useVirtualizer, type Range, type Rect, type Virtualizer } from "@tanstack/react-virtual";
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLaserState, visibleSessionPath } from "@/runtime";
import { activityDetailLevel } from "@/runtime/sessionPreferences";
import { motionMs } from "@/motion";
import { clearAnchoredMessages, setAnchoredMessages, setAtLiveEdge, setStandingRows } from "@/runtime/anchored-messages";
import { ThreadMessage } from "./messages.js";
import { HistoryReserve } from "./history-reserve-view.js";
import { HistoryPlaceholder, PLACEHOLDER_TURN_HEIGHT } from "./history-reserve.js";

export interface TranscriptTarget { messageId: string; toolCallId?: string; leafId?: string | null }
export interface LocateOptions {
  reason: "find" | "map" | "question" | "action" | "focus" | "restore";
  signal?: AbortSignal;
  locate?: () => Promise<unknown>;
  rect?: (message: HTMLElement) => DOMRect | undefined;
}
export type LocateResult = "visible" | "cancelled" | "missing";
/** Where the reader is: the newest turn, or a row and how far into it. */
type Anchor = { messageId: string; offset: number };
type Place = { anchor?: Anchor; following: boolean };

/**
 * The transcript's item list is the head item followed by one item per
 * message, so index 0 is always the head and message `i` is always item
 * `i + 1`.
 *
 * The head carries the history controls and the unloaded-history placeholder.
 * It is an item rather than content above the list for two reasons: the
 * virtualizer measures it and anchors through it like any other row, so the
 * controls appearing or the placeholder shrinking moves nobody; and a list
 * whose first key never changes lets the engine detect every prepend, trim and
 * replacement from the item count alone.
 */
const HEAD_INDEX = 0;
const ITEM_OFFSET = 1;
const HEAD_KEY = "\u0000head";
/** Rows kept mounted on each side of the reading window. */
const OVERSCAN = 4;
/** How close to the newest message still counts as being at the live edge. */
const LIVE_EDGE = 4;
/** A row nobody has measured yet, before the type scale is known. */
const DEFAULT_ROW_ESTIMATE = 150;
/** What the head is worth before it is measured: the controls and its turns. */
const HEAD_CONTROLS_ESTIMATE = 48;
/** A destination gives up rather than chasing a layout that will not settle. */
const LOCATE_FRAME_BUDGET = 180;
const COMPONENTS = { Message: ThreadMessage };

/**
 * Measure a row the way the browser sees it. The engine's own default reads
 * `offsetHeight`, which is rounded to whole pixels only on the asynchronous
 * path and skips a synchronous read entirely; a transcript needs the size in
 * the commit that mounted the row — that is the commit whose scroll position
 * depends on it — so this reads the box directly and rounds both paths the
 * same way, leaving no sub-pixel difference between a first measurement and
 * the one the `ResizeObserver` delivers for the identical layout.
 */
function measureRow(element: Element, entry: ResizeObserverEntry | undefined): number {
  const box = entry?.borderBoxSize?.[0];
  if (box) return Math.round(box.blockSize);
  return Math.round(element.getBoundingClientRect().height);
}

/**
 * The scroller's size, with one substitution: a scroller that reports no
 * height at all is not a window onto nothing. It is a surface the browser has
 * not laid out yet, or one in a hidden tab, and a transcript that mounted no
 * rows there would have nothing for Find, a deep link or a screen reader to
 * reach when it comes back. The window's own height stands in until the
 * element has one.
 */
function observeReadingWindow(instance: Virtualizer<HTMLElement, HTMLElement>, cb: (rect: Rect) => void) {
  return observeElementRect(instance, rect => cb({ width: rect.width, height: rect.height || (typeof window === "undefined" ? 0 : window.innerHeight) }));
}

/**
 * Every scroll position this transcript ever writes passes through here — the
 * engine's anchoring and Laser's own explicit destinations alike — so the
 * browser acceptance harness can attribute each one to the code that asked
 * for it. Read-only: the harness sets the array, nothing here reads it back.
 */
function writeScroll(offset: number, options: { adjustments?: number; behavior?: ScrollBehavior }, instance: Virtualizer<HTMLElement, HTMLElement>) {
  const trace = (globalThis as { __laserScrollTrace?: unknown[] }).__laserScrollTrace;
  if (Array.isArray(trace)) {
    trace.push({
      at: performance.now(),
      from: instance.scrollElement?.scrollTop ?? 0,
      to: offset + (options.adjustments ?? 0),
      adjustment: options.adjustments ?? 0,
      stack: new Error().stack,
    });
  }
  elementScroll(offset, options, instance);
}

/**
 * One instance per rendered thread scope.
 *
 * It owns what is Laser's: which conversation is on screen, which rows are
 * pinned open, where a destination is going, how much unloaded history stands
 * above the loaded rows, and what this surface is standing on. It owns no
 * geometry. The mounted range and every scroll adjustment that follows a data
 * or measurement change belong to one engine (`@tanstack/react-virtual`,
 * D-303), and the only `scrollTop` writes are that engine's own — either its
 * anchoring, or an explicit person/destination intent routed through
 * `scrollToIndex`/`scrollToOffset`.
 */
export class TranscriptViewport {
  path = "";
  ids: readonly string[] = [];
  positions = new Map<string, number>();
  viewport: HTMLElement | undefined;
  content: HTMLElement | undefined;
  /** The engine, for as long as a transcript is mounted on this surface. */
  private engine: Virtualizer<HTMLElement, HTMLElement> | undefined;
  private listeners = new Set<() => void>();
  private revision = 0;
  private nodes = new Map<string, HTMLElement>();
  private rowRefs = new Map<string, (node: HTMLElement | null) => void>();
  private pins = new Map<string, number>();
  private selected: [string, string] | undefined;
  private focused: string | undefined;
  private target: TranscriptTarget | undefined;
  private place: Place = { following: true };
  /** Unloaded earlier history, as placeholder turns the engine measures. */
  private placeholder = new HistoryPlaceholder();
  private historyUserOffset = 0;
  private historyBefore: string | undefined;
  private estimate = DEFAULT_ROW_ESTIMATE;
  private typeSignature = "";
  /** Where the transcript starts inside the scroller. */
  private margin = 0;
  /** This surface owes the live edge one placement: a session just opened. */
  private pendingLatest = false;
  private leafId: string | null | undefined;
  private loaded: string | undefined;
  private intent = 0;
  private controlIntent = 0;
  private pendingFrames = new Map<number, () => void>();
  private pendingLocates = new Set<() => void>();
  /** Earlier-history requests in flight, for the late-page indicator only. */
  private pages = 0;
  private frame = 0;
  private publishing = 0;
  private disposed = false;

  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.revision++; this.publishAnchors(); for (const listener of this.listeners) listener(); }
  /**
   * Publish after this render. `configure()` and `setIds()` run while React is
   * rendering the transcript, and a subscriber notified from there would be a
   * state update during a render.
   */
  private publishSoon() {
    if (this.publishing || this.disposed) return;
    this.publishing = requestAnimationFrame(() => { this.publishing = 0; if (!this.disposed) this.publish(); });
  }

  /**
   * The rows this surface is standing on, so releasing the older part of the
   * conversation never pulls one out from under a person (RP-5b): the row the
   * reading position is on, the focused row, anything a surface pinned while
   * it is open, and the row a navigation is on its way to.
   */
  private publishAnchors() {
    if (!this.path) return;
    setAnchoredMessages(this.path, [this.place.anchor?.messageId, this.focused, this.target?.messageId, ...this.pins.keys()]
      .flatMap(id => (id ? [id] : [])));
    // The same rows, told apart, for a trim's stamp (RP-5b §7), and whether
    // this surface is showing the newest turn.
    setStandingRows(this.path, {
      anchor: this.place.anchor?.messageId,
      focused: this.focused,
      targets: [this.target?.messageId, ...this.pins.keys()],
    });
    setAtLiveEdge(this.path, this.place.following === true);
  }

  // ── What the engine asks this controller ──────────────────────────────
  // Every one of these is a stable bound method: the engine memoises its
  // measurements on the identity of `getItemKey`, so a new closure per render
  // would rebuild the whole list on every commit.

  get itemCount() { return this.ids.length + ITEM_OFFSET; }
  getScrollElement = () => this.viewport ?? null;
  itemKey = (index: number) => (index === HEAD_INDEX ? `${this.path}${HEAD_KEY}` : `${this.path}\u0000${this.ids[index - ITEM_OFFSET] ?? index}`);
  estimateSize = (index: number) => (index === HEAD_INDEX ? HEAD_CONTROLS_ESTIMATE + this.placeholder.turns * PLACEHOLDER_TURN_HEIGHT : this.estimate);
  measureItem = (element: Element, entry: ResizeObserverEntry | undefined) => measureRow(element, entry);
  /**
   * The mounted window: what the engine's own range says, plus the head and
   * every row a surface is holding open — an edit, an expanded request, the
   * focused row, a destination on its way, and a native selection, which stays
   * whole because the browser owns it and a released row would truncate it.
   */
  get rangeExtractor() { return this.extractor; }
  /**
   * Rebuilt whenever the held rows change. The engine memoises the mounted
   * window on this function's identity, so a new pin on the same scroll
   * position would otherwise never reach it.
   */
  private held() { this.extractor = (range: Range) => this.extractRange(range); }
  private extractor = (range: Range) => this.extractRange(range);
  private extractRange = (range: Range) => {
    const indexes = new Set<number>(defaultRangeExtractor(range));
    indexes.add(HEAD_INDEX);
    const add = (id: string | undefined) => {
      const index = id === undefined ? undefined : this.positions.get(id);
      if (index !== undefined) indexes.add(index + ITEM_OFFSET);
    };
    for (const id of this.pins.keys()) add(id);
    add(this.focused);
    add(this.target?.messageId);
    if (this.selected) {
      const a = this.positions.get(this.selected[0]), b = this.positions.get(this.selected[1]);
      if (a !== undefined && b !== undefined) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) indexes.add(i + ITEM_OFFSET);
    }
    return [...indexes].filter(index => index >= 0 && index < range.count).sort((a, b) => a - b);
  };
  /** The engine, while a transcript is mounted. Set from its own render. */
  bind(engine: Virtualizer<HTMLElement, HTMLElement> | undefined) {
    this.engine = engine;
    if (engine) engine.shouldAdjustScrollPositionOnItemSizeChange = this.holdsReadingPosition;
  }

  /**
   * Whether a measurement that changed an item's height moves the reading
   * position with it. One rule, and it is Laser's from M16-T85: content that
   * ends at or above where the person is reading moves them by exactly what it
   * changed; content they can see does not.
   *
   * The engine's own default adds a direction guard — it declines to
   * compensate a re-measurement while the reader is travelling upwards, so
   * that a row growing at its bottom cannot drag the viewport. That guard is
   * unnecessary here because a row spanning the reading line is already
   * excluded, and it is harmful here because the placeholder for unloaded
   * history shrinks precisely while somebody reads upwards.
   */
  private holdsReadingPosition = (item: { key: string | number | bigint; start: number; end: number }, _delta: number, engine: Virtualizer<HTMLElement, HTMLElement>) => {
    const offset = (engine.scrollOffset ?? 0) + engine.scrollAdjustments;
    // Nothing has ever measured this item: the whole estimated block was
    // above the reading position, so the correction belongs to it as a whole.
    if (!engine.itemSizeCache.has(item.key)) return item.start < offset;
    return item.end <= offset + 0.5;
  };
  get scrollMargin() { return this.margin; }
  get placeholderTurns() { return this.placeholder.turns; }

  // ── The conversation on screen ────────────────────────────────────────

  configure(path: string, leafId?: string | null, loaded?: string) {
    this.leafId = leafId;
    if (this.path === path) {
      // This surface read the session's recent tail again. That is not a
      // reason to take the person back to the latest turn: an authoritative
      // page replacing what this device painted is the same conversation, and
      // the engine keeps them on the row they are reading (RP-11). Somebody
      // who *was* at the live edge stays there, because the replacement is an
      // append at the end and the engine follows it.
      if (loaded !== undefined && loaded !== this.loaded) this.loaded = loaded;
      return;
    }
    this.cancel();
    if (this.path) clearAnchoredMessages(this.path);
    this.path = path;
    this.loaded = loaded;
    this.ids = [];
    this.positions.clear();
    this.nodes.clear();
    this.rowRefs.clear();
    this.pins.clear();
    this.selected = undefined;
    this.focused = undefined;
    this.placeholder.reset();
    this.historyUserOffset = 0;
    this.historyBefore = undefined;
    this.pages = 0;
    // A conversation opens at its newest turn. The engine cannot know that:
    // to it this is a list that grew from nothing, so the placement is an
    // explicit intent, made once, in the commit that has the rows.
    this.place = { following: true };
    this.pendingLatest = Boolean(path);
    this.publishAnchors();
  }

  setIds(ids: readonly string[]) {
    if (this.ids === ids || (this.ids.length === ids.length && this.ids.every((id, i) => ids[i] === id))) return;
    const previous = this.ids;
    this.ids = ids;
    this.positions = new Map(ids.map((id, i) => [id, i]));
    for (const id of this.rowRefs.keys()) if (!this.positions.has(id)) this.rowRefs.delete(id);
    // A branch replacement cancels a pending destination; appends and
    // prepends do not.
    if (previous.length && previous.some(id => !this.positions.has(id))) this.cancel("structure");
  }

  /**
   * What the producer says about earlier history. A page that arrives at the
   * head reduces the prompts it still has before this window, and that
   * decrease is how many placeholder turns the page just replaced.
   */
  setHistoryWindow(userOffset: number, _loadedUserTurns: number, before: string | undefined) {
    const offset = Math.max(0, userOffset);
    const arrived = this.historyBefore !== undefined && before !== undefined ? this.historyUserOffset - offset : 0;
    this.historyUserOffset = offset;
    this.historyBefore = before;
    if (arrived > 0) this.placeholder.arrived(arrived, this.turnsInFrontOfTheReader());
    this.configurePlaceholder();
  }

  /** True when the number of placeholder turns changed. */
  private configurePlaceholder(): boolean {
    return this.placeholder.configure({
      hasBefore: this.historyBefore !== undefined,
      unloadedUserTurns: this.historyUserOffset,
      viewportHeight: this.viewport?.clientHeight,
      mayGrow: this.mayGrowPlaceholder(),
      minimum: this.turnsInFrontOfTheReader(),
    });
  }

  /**
   * How many placeholder turns the region may not give up, because they are
   * the ones the person is looking at.
   *
   * A page arriving takes the pixels the placeholder was holding, which is
   * right when those pixels are behind the reader or above them, and wrong
   * when they are on screen: a row would appear in front of somebody who has
   * not reached it yet. So while the reading position is inside the region,
   * only the turns below the fold are given back, and the rest follow as the
   * person reads past them. Outside the region there is nothing to protect:
   * the whole of it is above the reading position and the engine moves them
   * with it.
   */
  private turnsInFrontOfTheReader(): number {
    const viewport = this.viewport;
    const region = this.content?.querySelector('[data-slot="history-reserve"]');
    if (!viewport || !region || this.placeholder.turns <= 0) return 0;
    // Measured from the layout on screen, not from the model: the model can
    // already have moved on, and what must not change is what the person is
    // looking at.
    const rect = region.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    if (rect.bottom <= view.top + 0.5) return 0;
    return Math.max(0, Math.min(this.placeholder.turns, Math.ceil((view.bottom - rect.top) / PLACEHOLDER_TURN_HEIGHT)));
  }

  /**
   * Whether the estimated range in front of the reader may grow back to its
   * bounded size in this pass. Arrived pages consume it, so after a few pages
   * it sits at its floor while the producer still has hundreds of turns before
   * it, and the thumb then tells the person they are at the root of a
   * conversation they are nowhere near the root of (D-302).
   *
   * Growth is content added above the reader, so there are exactly two places
   * it cannot be felt: at the live edge, where the engine holds the newest
   * turn against everything above it; and with the reader on loaded rows,
   * where the whole region is above their reading position and the engine
   * moves them with it, to the pixel. Never in the middle of a gesture, never
   * while a destination is landing, and never while the person is inside the
   * region — there it would push the conversation further away from them, one
   * page at a time, which is the treadmill this rule exists to prevent.
   */
  private mayGrowPlaceholder(): boolean {
    const engine = this.engine;
    if (!engine || this.target || engine.isScrolling) return false;
    if (this.place.following) return true;
    // A reader on loaded rows has the whole region above their reading
    // position, so the engine moves them with it and they feel nothing. A
    // reader inside the region would instead watch the conversation being
    // pushed further away from them, one page at a time.
    return !this.isReadingHistoryReserve();
  }

  /**
   * Where the scroller is. The engine's own record while it has one, and the
   * element itself before its first scroll event, so an answer is never a
   * guess about a viewport that is right there to read.
   */
  private offset(): number {
    return this.engine?.scrollOffset ?? this.viewport?.scrollTop ?? 0;
  }

  /**
   * The reading position — the viewport's top edge — is inside the head item:
   * the person has crossed above the oldest loaded row, into the placeholder
   * for history that has not arrived. Rows lower down the screen may still be
   * loaded ones.
   */
  isReadingHistoryReserve(): boolean {
    const engine = this.engine;
    if (!engine || this.placeholder.turns <= 0) return false;
    return engine.getVirtualItemForOffset(this.offset())?.index === HEAD_INDEX;
  }

  // ── Rows ──────────────────────────────────────────────────────────────

  /**
   * A row's ref, stable for as long as the row exists, so React never detaches
   * and re-attaches it for a re-render: it records the node for this
   * controller and hands the same node to the engine to measure.
   */
  rowRef(id: string) {
    let ref = this.rowRefs.get(id);
    if (!ref) {
      ref = (node: HTMLElement | null) => {
        this.register(id, node);
        this.engine?.measureElement(node);
      };
      this.rowRefs.set(id, ref);
    }
    return ref;
  }
  /**
   * The head's ref. The head is an item the engine measures, but it is not a
   * row: nothing looks it up by message id, and the maps that answer "which
   * rows are mounted" must not contain it.
   */
  headRef = (node: HTMLElement | null) => { this.engine?.measureElement(node); };
  register(id: string, node: HTMLElement | null) {
    if (node) this.nodes.set(id, node);
    else this.nodes.delete(id);
  }
  setContent = (node: HTMLElement | null) => { this.content = node ?? undefined; };
  pin(id: string) {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1); this.held(); this.publish();
    return () => { const n = (this.pins.get(id) ?? 1) - 1; if (n) this.pins.set(id, n); else this.pins.delete(id); this.held(); this.publish(); };
  }

  // ── Where the reader is ───────────────────────────────────────────────

  /**
   * Read the reading position from the engine: the newest turn, or the row
   * under the viewport's top edge and how far into it. Nothing is written
   * here; this is what the rest of the app is told about.
   */
  capture = (): Place => {
    const engine = this.engine;
    if (!engine) return this.place;
    const offset = this.offset();
    const item = engine.getVirtualItemForOffset(offset);
    // Inside the head — the placeholder for history that has not arrived — the
    // row the person is on is the oldest one they have: it is the row they
    // will be back on, and the one a trim must not release under them.
    const index = item ? Math.max(item.index, ITEM_OFFSET) : undefined;
    const messageId = index === undefined ? undefined : this.ids[index - ITEM_OFFSET];
    const following = this.pendingLatest || engine.isAtEnd(LIVE_EDGE);
    this.place = { following, ...(messageId && item ? { anchor: { messageId, offset: offset - item.start } } : {}) };
    return this.place;
  };

  /**
   * The newest turn, now. An explicit intent — the person asked for it, or
   * they sent something — so it goes through the engine's own scroll and
   * supersedes whatever else was happening.
   */
  latest = () => {
    this.cancel();
    this.pendingLatest = true;
    this.place = { following: true };
    this.placeToLatest();
    this.publish();
  };
  private placeToLatest() {
    const engine = this.engine;
    if (!engine || this.ids.length === 0 || !this.viewport) return;
    this.pendingLatest = false;
    engine.scrollToIndex(this.itemCount - 1, { align: "end" });
  }

  /**
   * The layout React just committed. The engine has already synchronised its
   * own scroll position in its layout effect; this is where Laser's own
   * state catches up with it — where the transcript starts inside the
   * scroller, how much unloaded history the head should draw, and what this
   * surface is standing on.
   */
  committed() {
    if (this.disposed) return;
    let changed = this.readLayout();
    if (this.pendingLatest) this.placeToLatest();
    const before = this.place;
    this.capture();
    if (this.configurePlaceholder()) changed = true;
    if (changed) this.publish();
    else if (before.following !== this.place.following || before.anchor?.messageId !== this.place.anchor?.messageId) this.publishAnchors();
  }

  /**
   * Where the transcript starts inside the scroller, and what an unmeasured
   * row is worth. Both are read from the browser, never predicted: the first
   * is whatever the app renders above the transcript inside the same
   * scroller, and the second follows the active type and spacing scales.
   */
  private readLayout(): boolean {
    const viewport = this.viewport, content = this.content;
    if (!viewport || !content) return false;
    const margin = content.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    let changed = false;
    if (Number.isFinite(margin) && Math.abs(margin - this.margin) >= 0.5) { this.margin = margin; changed = true; }
    const css = getComputedStyle(content);
    const line = Number.parseFloat(css.lineHeight) || Number.parseFloat(css.fontSize) * 1.5;
    const spacing = Number.parseFloat(css.paddingTop) / 5 || line / 4;
    const signature = [content.clientWidth, css.fontFamily, css.fontSize, css.lineHeight, spacing, activityDetailLevel(this.path)].join("|");
    if (signature !== this.typeSignature) {
      this.typeSignature = signature;
      const estimate = line * 6 + spacing * 5;
      if (Number.isFinite(estimate) && estimate > 0 && Math.abs(estimate - this.estimate) >= 0.5) { this.estimate = estimate; changed = true; }
    }
    return changed;
  }

  // ── Destinations ──────────────────────────────────────────────────────

  cancel = (reason?: unknown) => {
    this.intent++;
    if (this.target) { this.target = undefined; this.held(); this.publishSoon(); }
    if (reason !== "structure") this.controlIntent++;
    for (const [frame, resolve] of this.pendingFrames) { cancelAnimationFrame(frame); resolve(); }
    this.pendingFrames.clear();
    for (const resolve of this.pendingLocates) resolve();
    this.pendingLocates.clear();
  };
  startAction() { this.capture(); this.cancel(); return { path: this.path, intent: this.controlIntent }; }
  async afterAction(ticket: { path: string; intent: number }, target?: TranscriptTarget): Promise<void> {
    // Engine moves publish before React commits. Begin the new location only
    // after that commit, and never after a later person/destination intent.
    do {
      await this.nextFrame();
      if (this.disposed || ticket.path !== this.path || ticket.intent !== this.controlIntent) return;
      // A successful engine move can settle before React commits its history.
      // Wait for that exact branch, not an arbitrary number of frames. Only
      // the accepted action calls here; later person/destination intents cancel.
    } while (target && ((target.leafId !== undefined && target.leafId !== this.leafId) || !this.positions.has(target.messageId)));
    if (target) { await this.ensureVisible(target, { reason: "action" }); return; }
    this.latest();
  }
  private nextFrame() {
    return new Promise<void>(resolve => {
      const frame = requestAnimationFrame(() => { this.pendingFrames.delete(frame); resolve(); });
      this.pendingFrames.set(frame, resolve);
    });
  }

  /**
   * Take a row — and a block inside it — to the reading position. The engine
   * owns every scroll: a coarse landing by index, which keeps reconciling as
   * the rows on the way measure, and then the exact offset once the row is
   * mounted and its own rectangle can be read.
   */
  async ensureVisible(target: TranscriptTarget, options: LocateOptions): Promise<LocateResult> {
    this.cancel();
    const intent = this.intent, path = this.path;
    const cancelled = () => this.disposed || options.signal?.aborted || this.intent !== intent || path !== this.path || (target.leafId !== undefined && target.leafId !== this.leafId);
    const abort = () => { if (this.intent === intent) this.cancel(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (cancelled()) return "cancelled";
      if (!this.positions.has(target.messageId) && options.locate) {
        let wake!: () => void;
        const stopped = new Promise<void>(resolve => { wake = resolve; this.pendingLocates.add(resolve); });
        try { await Promise.race([options.locate(), stopped]); }
        catch { return cancelled() ? "cancelled" : "missing"; }
        finally { this.pendingLocates.delete(wake); }
        if (cancelled()) return "cancelled";
        await this.nextFrame();
        if (cancelled()) return "cancelled";
      }
      if (!this.positions.has(target.messageId)) return "missing";
      // An explicit destination supersedes the live edge and any placement
      // this surface still owed.
      this.pendingLatest = false;
      this.place = { ...this.place, following: false };
      this.target = target;
      this.held();
      this.publish();
      let stable = 0;
      let settledAfter: number | undefined;
      for (let frames = 0; frames < LOCATE_FRAME_BUDGET; frames++) {
        await this.nextFrame();
        if (cancelled()) return "cancelled";
        const index = this.positions.get(target.messageId);
        const engine = this.engine, viewport = this.viewport;
        if (index === undefined || !engine || !viewport) { this.cancel(); return "missing"; }
        const row = this.nodes.get(target.messageId);
        if (!row) { engine.scrollToIndex(index + ITEM_OFFSET, { align: "center" }); this.publish(); continue; }
        settledAfter ??= performance.now() + motionMs("--motion-fast");
        const message = row.querySelector<HTMLElement>("[data-message-id]") ?? row;
        const tool = target.toolCallId ? message.querySelector<HTMLElement>(`[data-tool-call="${CSS.escape(target.toolCallId)}"]`) : undefined;
        const rect = options.rect?.(message) ?? (tool ?? message).getBoundingClientRect();
        const footer = viewport.querySelector<HTMLElement>('[data-slot="thread-footer"]')?.getBoundingClientRect().height ?? 0;
        const delta = rect.top - viewport.getBoundingClientRect().top - Math.max(0, viewport.clientHeight - footer) / 3;
        if (Math.abs(delta) < 0.5) stable++;
        else { stable = 0; engine.scrollToOffset(this.offset() + delta); }
        if (stable >= 2 && performance.now() >= settledAfter) {
          this.target = undefined; this.held(); this.capture(); this.publish();
          return target.toolCallId && !tool ? "missing" : "visible";
        }
      }
      // The layout never settled. Say what is true: the row is mounted where
      // the engine put it, or it is not there at all.
      const landed = this.nodes.has(target.messageId);
      this.target = undefined; this.held(); this.capture(); this.publish();
      return landed ? "visible" : "missing";
    } finally { options.signal?.removeEventListener("abort", abort); }
  }

  // ── Earlier history ───────────────────────────────────────────────────
  //
  // The page itself is the history loader's (M16-T81/T85). All this surface
  // keeps is whether one is in flight, so a page that is late while the person
  // is inside the placeholder can say so.

  beginEarlierPage() { this.pages++; this.publish(); }
  finishEarlierPage() { if (this.pages > 0) { this.pages--; this.publish(); } }
  cancelEarlierPage() { if (this.pages > 0) { this.pages = 0; this.publish(); } }
  get loadingEarlier() { return this.pages > 0; }

  // ── Input ─────────────────────────────────────────────────────────────

  attach(viewport: HTMLElement) {
    this.disposed = false;
    this.viewport = viewport;
    // The engine reads its scroll element from this controller; the render
    // that follows this publication is where it picks it up.
    this.publish();
    const schedule = () => {
      if (this.frame || this.disposed) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.disposed) return;
        const before = this.place;
        this.capture();
        if (before.following !== this.place.following || before.anchor?.messageId !== this.place.anchor?.messageId) this.publishAnchors();
      });
    };
    const scrolled = () => { this.pendingLatest = false; schedule(); };
    /**
     * Deliberate movement by the person. It ends a destination — the row they
     * were being taken to is no longer where they are going — and it ends this
     * surface's claim on the live edge. It never writes a scroll position:
     * the browser is already doing that, and the engine follows it.
     */
    const user = () => { this.cancel(); this.pendingLatest = false; schedule(); };
    const selection = () => {
      const selected = document.getSelection();
      if (selected && !selected.isCollapsed && selected.anchorNode === this.content && selected.focusNode === this.content && this.ids.length) {
        this.selected = [this.ids[0]!, this.ids.at(-1)!]; this.held(); this.publish(); return;
      }
      const id = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-window-message]")?.dataset.windowMessage;
      const start = id(selected?.anchorNode ?? null), end = id(selected?.focusNode ?? null);
      const a = start ? this.positions.get(start) : undefined, b = end ? this.positions.get(end) : undefined;
      if (!selected || selected.isCollapsed) this.selected = undefined;
      else if (a !== undefined && b !== undefined) this.selected = [start!, end!];
      else if (selected.rangeCount && this.content && selected.getRangeAt(0).intersectsNode(this.content)) {
        // A drag can end on a container boundary before the next window
        // commits. Preserve the already selected interval through that gap.
        const range = selected.getRangeAt(0);
        const intersecting = [...this.nodes].filter(([, node]) => range.intersectsNode(node)).map(([id]) => this.positions.get(id)!);
        if (this.selected) for (const id of this.selected) { const index = this.positions.get(id); if (index !== undefined) intersecting.push(index); }
        if (intersecting.length) this.selected = [this.ids[Math.min(...intersecting)]!, this.ids[Math.max(...intersecting)]!];
      } else this.selected = undefined;
      this.held();
      this.publish();
    };
    const focus = (event: FocusEvent) => {
      const target = event.type === "focusout" ? event.relatedTarget : event.target;
      // Portalled menus retain their originating row until focus returns to the thread.
      if (!(target instanceof Element) || !viewport.contains(target)) return;
      this.focused = target.closest<HTMLElement>("[data-window-message]")?.dataset.windowMessage;
      this.held();
      this.publish();
    };
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      const editsText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      const inComposer = target instanceof Element && target.closest('[data-slot="composer"]') !== null;
      const moves = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home"
        || event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End"
        || event.key === " " || event.key === "Spacebar";
      if (moves && !editsText && !inComposer) user();
      else this.cancel();
      if (event.key === "Tab" && event.target instanceof HTMLElement) {
        const row = event.target.closest<HTMLElement>("[data-window-message]");
        const id = row?.dataset.windowMessage;
        const index = id ? this.positions.get(id) : undefined;
        const selector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
        const controlsOf = (node?: Element) => [...(node?.querySelectorAll<HTMLElement>(selector) ?? [])].filter(control => control.getClientRects().length > 0);
        const controls = controlsOf(row ?? undefined), backward = event.shiftKey, direction = backward ? -1 : 1;
        const edge = backward ? controls[0] : controls.at(-1);
        if (edge !== event.target || index === undefined || !row) return;
        let nextIndex = index + direction;
        while (this.ids[nextIndex] && this.nodes.has(this.ids[nextIndex]!) && !controlsOf(this.nodes.get(this.ids[nextIndex]!)).length) nextIndex += direction;
        const next = this.ids[nextIndex];
        if (next && !this.nodes.has(next)) {
          event.preventDefault();
          void (async () => {
            // A notice can have no controls. Continue to the next canonical
            // focus target instead of dropping Tab through a window gap.
            for (let i = nextIndex; i >= 0 && i < this.ids.length; i += direction) {
              const nextId = this.ids[i]!;
              if (!this.nodes.has(nextId) && await this.ensureVisible({ messageId: nextId }, { reason: "focus" }) !== "visible") return;
              const candidates = controlsOf(this.nodes.get(nextId)), control = backward ? candidates.at(-1) : candidates[0];
              if (!control) continue;
              if (await this.ensureVisible({ messageId: nextId }, { reason: "focus", rect: () => control.getBoundingClientRect() }) === "visible") control.focus({ preventScroll: true });
              return;
            }
            const outside = controlsOf(document.body).filter(control => !this.content?.contains(control) && Boolean(control.compareDocumentPosition(row) & (backward ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING)));
            (backward ? outside.at(-1) : outside[0])?.focus({ preventScroll: true });
          })();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
        // Explicit native Select All is the documented temporary all-loaded DOM exception.
        event.preventDefault(); this.selected = this.ids.length ? [this.ids[0]!, this.ids.at(-1)!] : undefined; this.held(); this.publish();
        const intent = this.intent;
        requestAnimationFrame(() => { if (intent !== this.intent || !this.content) return; const range = document.createRange(); range.selectNodeContents(this.content); const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); });
      }
    };
    const pointer = (event: PointerEvent) => {
      // A click in the wide transcript gutter is not a scroll intent, and a
      // click on a row is not one either: only the scrollbar moves the view.
      const unit = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-unit"));
      const overlayEdge = Number.isFinite(unit) ? unit * 3 : 0;
      const rtl = viewport.dir === "rtl" || getComputedStyle(viewport).direction === "rtl";
      const overScrollbar = event.offsetX < 0 || event.offsetX > viewport.clientWidth || (rtl ? event.offsetX <= overlayEdge : event.offsetX >= viewport.clientWidth - overlayEdge);
      if (event.target === viewport && viewport.scrollHeight > viewport.clientHeight && overScrollbar) user();
      else this.cancel();
    };
    const wheel = () => user();
    const touchstart = () => user();
    const touchmove = () => user();
    viewport.addEventListener("scroll", scrolled, { passive: true });
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("touchstart", touchstart, { passive: true });
    viewport.addEventListener("touchmove", touchmove, { passive: true });
    viewport.addEventListener("pointerdown", pointer, { passive: true });
    viewport.addEventListener("focusin", focus); viewport.addEventListener("focusout", focus); viewport.addEventListener("keydown", key);
    document.addEventListener("selectionchange", selection);
    return () => {
      this.cancel();
      this.disposed = true;
      clearAnchoredMessages(this.path);
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (this.publishing) cancelAnimationFrame(this.publishing);
      this.publishing = 0;
      viewport.removeEventListener("scroll", scrolled);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", touchstart);
      viewport.removeEventListener("touchmove", touchmove);
      viewport.removeEventListener("pointerdown", pointer);
      viewport.removeEventListener("focusin", focus); viewport.removeEventListener("focusout", focus); viewport.removeEventListener("keydown", key);
      document.removeEventListener("selectionchange", selection);
      this.viewport = undefined;
    };
  }
}

const Context = createContext<TranscriptViewport | undefined>(undefined);
/**
 * The controller for this surface. In the app it is always the one `Thread`
 * provides; a row mounted outside a conversation (a harness, a preview) gets
 * its own, attached to nothing, so there is still exactly one implementation
 * of this scroll and no caller has to carry a second one.
 */
export function useTranscriptViewport(): TranscriptViewport {
  const provided = useContext(Context);
  const [detached] = useState(() => (provided ? undefined : new TranscriptViewport()));
  return provided ?? detached!;
}
export function TranscriptViewportProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new TranscriptViewport());
  // The conversation on screen, which while a navigation resolves is the row
  // that was chosen rather than the one committed (RP-11). Keyed on the
  // committed path this controller would change identity the moment the host
  // confirmed the paint — and take the person back to the latest turn, in the
  // middle of reading.
  const path = useLaserState(s => visibleSessionPath(s) ?? "");
  const destination = useLaserState(s => s.destination);
  const epoch = useLaserState(s => { const target = visibleSessionPath(s); return target ? s.open[target]?.updateEpoch : undefined; });
  const leafId = useLaserState(s => { const target = visibleSessionPath(s); return target ? s.open[target]?.leafId : undefined; });
  const loaded = useLaserState(s => { const target = visibleSessionPath(s); return target ? s.open[target]?.historyRevision : undefined; });
  const previous = useRef({ destination, epoch });
  if (previous.current.destination !== destination || previous.current.epoch !== epoch) {
    controller.cancel(previous.current.destination !== destination ? undefined : "structure");
    previous.current = { destination, epoch };
  }
  controller.configure(path, leafId, loaded);
  return <Context value={controller}>{children}</Context>;
}
export function TranscriptViewportBinding() {
  const controller = useTranscriptViewport();
  const viewport = useThreadViewport(s => s.element.viewport);
  useLayoutEffect(() => viewport && controller ? controller.attach(viewport) : undefined, [controller, viewport]);
  return null;
}

/**
 * The transcript itself: the head — history controls and the placeholder for
 * unloaded history — followed by the rows the engine has chosen, each in
 * normal chronological order and positioned by the engine's own measurements.
 *
 * `head` is content, not chrome: it scrolls with the conversation and it is
 * measured with it, so the controls appearing or the placeholder being
 * replaced by real rows is a size change the engine anchors through, not a
 * push nobody accounted for.
 */
export function WindowedMessages({ head }: { head?: ReactNode } = {}) {
  const controller = useTranscriptViewport();
  const ids = unstable_useThreadMessageIds();
  const userOffset = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.history?.userOffset ?? 0 : 0; });
  const before = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.history?.before : undefined; });
  const loadedUserTurns = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.blocks.filter(block => block.kind === "user" && !block.optimistic).length ?? 0 : 0; });
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  controller.setIds(ids);
  controller.setHistoryWindow(userOffset, loadedUserTurns, before);
  const engine = useVirtualizer<HTMLElement, HTMLElement>({
    count: controller.itemCount,
    getScrollElement: controller.getScrollElement,
    estimateSize: controller.estimateSize,
    getItemKey: controller.itemKey,
    rangeExtractor: controller.rangeExtractor,
    measureElement: controller.measureItem,
    scrollMargin: controller.scrollMargin,
    overscan: OVERSCAN,
    // The transcript is a chat: the newest turn is the end, a page of older
    // messages is a prepend, and the reader's row keeps its position through
    // both because the engine resolves its anchor in the same pass that
    // renders the new range.
    anchorTo: "end",
    followOnAppend: "auto",
    scrollToFn: writeScroll,
    observeElementRect: observeReadingWindow,
  });
  controller.bind(engine);
  useLayoutEffect(() => { controller.committed(); });
  useEffect(() => () => controller.bind(undefined), [controller]);
  // Arriving history is not something the person should have to watch. The
  // one visible sign is a page that is late — longer than a slow motion step
  // — while they are inside the placeholder, and it goes on arrival.
  const loading = controller.loadingEarlier;
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!loading) { setOverdue(false); return; }
    const timer = setTimeout(() => { if (controller.isReadingHistoryReserve()) setOverdue(true); }, motionMs("--motion-slow"));
    return () => clearTimeout(timer);
  }, [controller, loading]);
  const items = engine.getVirtualItems();
  const margin = controller.scrollMargin;
  return <div
    ref={controller.setContent}
    data-slot="thread-messages"
    aria-busy={loading || undefined}
    // `shrink-0`: the transcript's height is the engine's measurement, and the
    // column around it is a flex container that would otherwise compress it.
    className="relative w-full shrink-0"
    style={{ height: engine.getTotalSize(), overflowAnchor: "none" }}
  >
    {items.map(item => (item.index === HEAD_INDEX
      ? <TranscriptHead key="head" top={item.start - margin} index={item.index} controller={controller} turns={controller.placeholderTurns} overdue={overdue}>{head}</TranscriptHead>
      : <WindowRow key={controller.itemKey(item.index)} id={ids[item.index - ITEM_OFFSET]!} index={item.index} top={item.start - margin} controller={controller} />))}
    {/* Nothing else: the head and the rows are the transcript, and their
        positions come from the one engine that measured them. */}
  </div>;
}

/** Everything that belongs above the first message, measured with it. */
function TranscriptHead({ top, index, controller, turns, overdue, children }: { top: number; index: number; controller: TranscriptViewport; turns: number; overdue: boolean; children?: ReactNode }) {
  return <div
    ref={controller.headRef}
    data-index={index}
    data-slot="transcript-head"
    className="absolute inset-x-0 flex flex-col pt-5"
    style={{ top }}
  >
    {children}
    <HistoryReserve turns={turns} overdue={overdue} />
  </div>;
}

/**
 * Memoised on purpose. The transcript re-renders whenever a row is measured, a
 * pin changes or the conversation grows — several times per streamed batch —
 * and a row whose position has not changed must not re-render with it: its own
 * message subscription is what tells it that its content moved.
 */
const WindowRow = memo(function WindowRow({ id, index, top, controller }: { id: string; index: number; top: number; controller: TranscriptViewport }) {
  // Positioned with `top`, never a transform: a transform would make this row
  // the containing block for anything sticky or fixed inside it, and rows
  // carry both.
  return <div
    ref={controller.rowRef(id)}
    data-index={index}
    data-window-message={id}
    className="absolute inset-x-0 pb-5 [&_[data-message-id]]:[content-visibility:visible]"
    style={{ top }}
  >
    <ThreadPrimitive.Unstable_MessageById messageId={id} components={COMPONENTS} />
  </div>;
});
