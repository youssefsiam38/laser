import { ThreadPrimitive, useAuiState, useThreadViewport, useThreadViewportStore, unstable_useThreadMessageIds } from "@assistant-ui/react";
import { LegendList, type LegendListRef, type MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { useLaserState, visibleSessionPath } from "@/runtime";
import { activityDetailLevel } from "@/runtime/sessionPreferences";
import { motionMs, prefersReducedMotion } from "@/motion";
import { clearAnchoredMessages, setAnchoredMessages, setAtLiveEdge, setStandingRows } from "@/runtime/anchored-messages";
import { ThreadMessage } from "./messages.js";
import { HistoryReserve } from "./history-reserve-view.js";
import { HistoryPlaceholder } from "./history-reserve.js";

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

/** How close to the newest message still counts as being at the live edge. */
const LIVE_EDGE = 4;
/** A row nobody has measured yet, before the type scale is known. */
const DEFAULT_ROW_ESTIMATE = 150;
/** A destination gives up rather than chasing a layout that will not settle. */
const LOCATE_FRAME_BUDGET = 180;
/** Commits an opening conversation may take to land on its newest turn. */
const LATEST_ATTEMPTS = 60;
/** How far from the end the list still keeps following, in screens. */
const FOLLOW_THRESHOLD = 1;
/** Prefetch earlier history while the reserve is within this many screens of the reader. */
export const HISTORY_PREFETCH_SCREENS = 2;
/**
 * One prefetch burst never asks for more than this many pages. Awaited
 * sequence, never parallel. Combined with the byte budget so a conversation
 * of tiny pages still fills the screen, and a conversation of megabyte pages
 * cannot pin the network. The producer already caps a page at 1 MB / 200 rows.
 */
export const HISTORY_PREFETCH_PAGE_BUDGET = 16;
/** A few megabytes for one burst: four producer-capped pages, or many small ones. */
export const HISTORY_PREFETCH_BYTE_BUDGET = 4 * 1024 * 1024;
/** Frames a fold may take to change a row's height before the hold lapses. */
const DISCLOSURE_FRAME_BUDGET = 12;
const COMPONENTS = { Message: ThreadMessage };

/**
 * Live follow, as the list performs it.
 *
 * `footerLayout: false` is the load-bearing one: the composer's inset is a
 * spacer at the end of the list, and a composer that grows a line must not
 * move a message the person is looking at. Everything else that can add
 * content at the end — a turn arriving, a row growing, the window resizing —
 * still keeps the newest turn pinned.
 */
const FOLLOW_INSTANT = {
  animated: false,
  on: { dataChange: true, footerLayout: false, itemLayout: true, layout: true },
} as const satisfies MaintainScrollAtEndOptions;
/**
 * Streamed text lands a paragraph at a time, and a smooth follow turns each
 * landing into a short glide instead of a jump. Session switches and layout
 * settles keep the instant variant, so nothing visibly travels; reduced
 * motion keeps it too, and loses only the movement.
 */
const FOLLOW_ANIMATED = { ...FOLLOW_INSTANT, animated: true } as const satisfies MaintainScrollAtEndOptions;

/**
 * One instance per rendered thread scope.
 *
 * It owns what is Laser's: which conversation is on screen, which rows are
 * pinned open, where a destination is going, how much unloaded history stands
 * above the loaded rows, and whether the person is reading history or riding
 * the live edge. It owns no geometry. Which rows are mounted, where each one
 * sits, and every scroll adjustment that follows a prepend, a trim or a row
 * changing size belong to `@legendapp/list` (D-306), whose
 * `maintainVisibleContentPosition` refuses to move content above the reader
 * rather than correcting it afterwards. The only scroll positions written
 * from here are explicit person/destination intents, through the list's own
 * `scrollToIndex`/`scrollToOffset`/`scrollToEnd`.
 */
export class TranscriptViewport {
  path = "";
  ids: readonly string[] = [];
  positions = new Map<string, number>();
  /** The scroller: the list's own element, which this surface never styles by hand. */
  viewport: HTMLElement | undefined;
  private list: LegendListRef | undefined;
  private listeners = new Set<() => void>();
  private revision = 0;
  private nodes = new Map<string, HTMLElement>();
  private rowRefs = new Map<string, (node: HTMLElement | null) => void>();
  private pins = new Map<string, number>();
  private selected: [string, string] | undefined;
  private focused: string | undefined;
  private target: TranscriptTarget | undefined;
  private place: Place = { following: true };
  /** The person moved the view themselves since the last reading sample. */
  private gestured = false;
  /**
   * The direction of the person's last deliberate movement. An upward one is
   * the person leaving the live edge to read, and it holds: no sample that
   * happens to find the view at the end — a smooth scroll that has not moved
   * yet, a glide the list was already performing, a row that shrank — may put
   * them back on it. Only a movement of their own towards the end, or an
   * explicit "Jump to latest" / Send, does. A person who has scrolled up is
   * never scrolled down by anything but themselves.
   */
  private lastGesture: "up" | "down" | "either" | undefined;
  /**
   * How many times the person has moved the view, ever, on this surface. A
   * scroll event is not this — the list's own position keeping raises those
   * too — so a pager that must re-arm only when the person moves reads this
   * count rather than the scroller.
   */
  private gestures = 0;
  get gestureCount() { return this.gestures; }
  /** Unloaded earlier history, as placeholder turns inside the list's header. */
  private placeholder = new HistoryPlaceholder();
  private historyUserOffset = 0;
  private historyBefore: string | undefined;
  /** Rows arrived at the front of the conversation in this render. */
  private prepended = false;
  private estimate = DEFAULT_ROW_ESTIMATE;
  private typeSignature = "";
  /** The row a disclosure toggle named, while that toggle settles. */
  private disclosure: string | undefined;
  private disclosureFrames: number[] = [];
  /** This surface owes the live edge one placement: a session just opened. */
  private pendingLatest = false;
  private attempts = 0;
  private leafId: string | null | undefined;
  private intent = 0;
  private controlIntent = 0;
  private pendingFrames = new Map<number, () => void>();
  private pendingLocates = new Set<() => void>();
  /** Earlier-history requests in flight, for the late-page indicator only. */
  private pages = 0;
  private frame = 0;
  private publishing = 0;
  private disposed = false;
  /** What a row of each kind has measured, so an unmeasured one guesses better. */
  private types = new Map<string, string>();
  /** Last measured scroller height, so a first layout that grew from zero republishes. */
  private lastHeight = 0;

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

  // ── What the list asks this controller ────────────────────────────────
  // Stable bound methods: the list memoises on their identity, so a new
  // closure per render would rebuild the whole list on every commit.

  key = (id: string) => id;
  /**
   * A row's kind, for the list's per-kind size averages. A row that has never
   * been mounted has no kind yet and takes the list's overall average, which
   * is the honest answer: nothing here knows a message's role before the
   * message renders itself.
   */
  itemType = (id: string) => this.types.get(id) ?? "message";
  noteType(id: string, type: string) { if (this.types.get(id) !== type) this.types.set(id, type); }
  get estimatedItemSize() { return this.estimate; }
  /**
   * Rows pinned open by a surface that is not the reading window: an edit, an
   * expanded request, a question. Nothing about them is a scroll, so the list
   * has no reason of its own to look at the data again — this is the set whose
   * change asks it to.
   */
  get pinnedKeys(): string[] {
    return [...this.pins.keys()].filter(id => this.positions.has(id));
  }
  /** Rows a surface is holding open, which the list keeps mounted wherever they are. */
  get heldKeys(): string[] {
    const keys = new Set<string>();
    for (const id of this.pins.keys()) keys.add(id);
    if (this.focused) keys.add(this.focused);
    if (this.target) keys.add(this.target.messageId);
    if (this.selected) {
      const a = this.positions.get(this.selected[0]), b = this.positions.get(this.selected[1]);
      if (a !== undefined && b !== undefined) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { const id = this.ids[i]; if (id) keys.add(id); }
    }
    return [...keys].filter(id => this.positions.has(id));
  }
  /**
   * Whether a row that changed size restores the reading position.
   *
   * Always, except while a disclosure toggle is settling: there the person
   * clicked one row, and that row — not whichever row happens to be under the
   * reading position — is the one that must not move.
   */
  shouldRestorePosition = (id: string) => this.disclosure === undefined || id === this.disclosure;
  /**
   * The position policy, built once: the list memoises on this object's
   * identity, and a new one per render would reset what it is holding.
   */
  readonly maintainPosition = { data: true, size: true, shouldRestorePosition: (id: string) => this.shouldRestorePosition(id) };
  /**
   * The same policy while a fold the person clicked is settling. Size
   * anchoring is what restores "the first row whose top is on screen", and
   * that is the wrong row here: the right one is the row they clicked, which
   * keeps its own top by nobody moving anything. Prepends still anchor, so a
   * page arriving in the same two frames is still held.
   */
  readonly maintainPositionThroughDisclosure = { data: true, size: false, shouldRestorePosition: (id: string) => this.shouldRestorePosition(id) };
  get positionPolicy() { return this.disclosure === undefined ? this.maintainPosition : this.maintainPositionThroughDisclosure; }
  /**
   * The list scrolled, or a row changed size. Neither is intent — the list's
   * own position keeping arrives here too — so all this does is re-read where
   * the reader now is, once per frame.
   */
  onListScroll = () => { this.scheduleSample(); };
  onItemSizeChanged = (info: { itemKey: string }) => {
    // The fold the person clicked has measured. One more frame covers the
    // browser's own deferred shrink, and then the row is an ordinary row
    // again.
    if (info.itemKey === this.disclosure) this.releaseDisclosure();
    this.scheduleSample();
  };
  private scheduleSample() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      const before = this.place;
      this.capture();
      if (before.following !== this.place.following || before.anchor?.messageId !== this.place.anchor?.messageId) this.publishAnchors();
      else this.publishSoon();
    });
  }
  /** How the list follows the newest turn, or that it must not right now. */
  followMode(streaming: boolean): MaintainScrollAtEndOptions | false {
    if (!this.place.following || this.target || this.disclosure !== undefined) return false;
    return streaming && !prefersReducedMotion() ? FOLLOW_ANIMATED : FOLLOW_INSTANT;
  }
  bindList(list: LegendListRef | undefined) { this.list = list; }
  setViewport(node: HTMLElement | undefined) {
    if (this.viewport === node) return;
    this.viewport = node;
    this.publishSoon();
  }
  /** The list's content container: what a native selection spans. */
  get content(): HTMLElement | undefined {
    return this.viewport?.firstElementChild instanceof HTMLElement ? this.viewport.firstElementChild : undefined;
  }
  get atLiveEdge() { return this.place.following; }
  get placeholderTurns() { return this.placeholder.turns; }

  // ── The conversation on screen ────────────────────────────────────────

  configure(path: string, leafId?: string | null) {
    this.leafId = leafId;
    // The same conversation, whatever else changed about it. A re-read of the
    // session's recent tail is not a reason to take the person back to the
    // latest turn: an authoritative page replacing what this device painted is
    // the same conversation, and the list keeps them on the row they are
    // reading (RP-11). Somebody who *was* at the live edge stays there,
    // because the replacement is an append at the end and the list follows it.
    if (this.path === path) return;
    this.cancel();
    if (this.path) clearAnchoredMessages(this.path);
    this.path = path;
    this.ids = [];
    this.positions.clear();
    this.nodes.clear();
    this.rowRefs.clear();
    this.pins.clear();
    this.types.clear();
    this.selected = undefined;
    this.focused = undefined;
    this.placeholder.reset();
    this.historyUserOffset = 0;
    this.historyBefore = undefined;
    this.prepended = false;
    this.pages = 0;
    this.lastHeight = 0;
    // A conversation opens at its newest turn. The list cannot know that: to
    // it this is a list that grew from nothing, so the placement is an
    // explicit intent, made once, in the commit that has the rows.
    this.place = { following: true };
    this.gestured = false;
    this.lastGesture = undefined;
    this.attempts = 0;
    this.pendingLatest = Boolean(path);
    this.publishAnchors();
  }

  setIds(ids: readonly string[]) {
    if (this.ids === ids || (this.ids.length === ids.length && this.ids.every((id, i) => ids[i] === id))) return;
    const previous = this.ids;
    this.ids = ids;
    this.positions = new Map(ids.map((id, i) => [id, i]));
    // Rows arrived in front of the row that used to be first: this surface has
    // seen a page of earlier history with its own eyes, whatever the producer
    // says its remaining count is.
    if (previous.length && (this.positions.get(previous[0]!) ?? 0) > 0) this.prepended = true;
    for (const id of this.rowRefs.keys()) if (!this.positions.has(id)) this.rowRefs.delete(id);
    for (const id of this.types.keys()) if (!this.positions.has(id)) this.types.delete(id);
    // A branch replacement cancels a pending destination; appends and
    // prepends do not.
    if (previous.length && previous.some(id => !this.positions.has(id))) this.cancel("structure");
  }

  /**
   * What the producer says about earlier history. A page that arrives at the
   * head reduces the prompts it still has before this window, and that
   * decrease is how many placeholder turns the page just replaced.
   *
   * That count is the producer's, and the region may not depend on it alone: a
   * page whose count does not move would leave the placeholder never yielding,
   * the reader pinned inside it and continuous paging asking for ever. So a
   * page arriving at the front is itself a shrink signal, worth at least the
   * one turn this surface can see it is — the two agree in the normal case,
   * because a page always walks back to a user prompt.
   */
  setHistoryWindow(userOffset: number, before: string | undefined) {
    const offset = Math.max(0, userOffset);
    const known = this.historyBefore !== undefined && before !== undefined;
    const claimed = known ? this.historyUserOffset - offset : 0;
    const arrived = Math.max(claimed, known && this.prepended ? 1 : 0);
    this.prepended = false;
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

  /** The placeholder region's box on screen, while it has one. */
  private reserveRect(): DOMRect | undefined {
    if (this.placeholder.turns <= 0) return undefined;
    const region = this.content?.querySelector('[data-slot="history-reserve"]');
    return region ? region.getBoundingClientRect() : undefined;
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
   * person reads past them.
   *
   * This reads the layout from inside a render, which looks like a mistake and
   * is not: the model has already moved on to the page that arrived, so the
   * only truthful answer to "what is the person looking at" is the box the
   * browser last laid out. It costs one forced layout per arriving page, not
   * one per frame.
   */
  private turnsInFrontOfTheReader(): number {
    const viewport = this.viewport, rect = this.reserveRect();
    if (!viewport || !rect) return 0;
    const view = viewport.getBoundingClientRect();
    if (rect.bottom <= view.top + 0.5) return 0;
    const turn = rect.height / Math.max(1, this.placeholder.turns);
    return Math.max(0, Math.min(this.placeholder.turns, Math.ceil((view.bottom - rect.top) / Math.max(1, turn))));
  }

  /**
   * Whether the estimated range in front of the reader may grow back to its
   * bounded size in this pass. Arrived pages consume it, so after a few pages
   * it sits at its floor while the producer still has hundreds of turns before
   * it, and the thumb then tells the person they are at the root of a
   * conversation they are nowhere near the root of (D-302).
   *
   * Growth is content added above the reader, so there are exactly two places
   * it cannot be felt: at the live edge, where the list holds the newest turn
   * against everything above it; and with the reader on loaded rows, where the
   * whole region is above their reading position and the list moves them with
   * it, to the pixel. Never while a destination is landing, and never while
   * the person is inside the region — there it would push the conversation
   * further away from them, one page at a time.
   */
  private mayGrowPlaceholder(): boolean {
    const viewport = this.viewport;
    if (!viewport || this.target) return false;
    if (this.place.following) return true;
    // A whole screen clear of the region, not one pixel: a page arriving
    // resizes the region and moves the scroll in the same commit, and for
    // part of that commit the region's own box is somewhere neither it nor
    // the person will be when the commit ends. Growth is permanent; a
    // transient must not be allowed to ask for it.
    const rect = this.reserveRect();
    if (!rect) return true;
    return rect.bottom < viewport.getBoundingClientRect().top - viewport.clientHeight;
  }

  /**
   * The reading position — the viewport's top edge — has not reached the
   * oldest loaded row: the person is inside the placeholder for history that
   * has not arrived, or above it among the history controls. Rows lower down
   * the screen may still be loaded ones.
   */
  isReadingHistoryReserve(): boolean {
    const viewport = this.viewport, rect = this.reserveRect();
    if (!viewport || !rect) return false;
    return rect.bottom > viewport.getBoundingClientRect().top + 0.5;
  }

  /**
   * Distance from the top of the viewport to the bottom of the unloaded-history
   * reserve. Infinity when there is no reserve: nothing to prefetch.
   */
  reserveDistance(): number {
    const viewport = this.viewport, rect = this.reserveRect();
    if (!viewport || !rect) return Infinity;
    return viewport.getBoundingClientRect().top - rect.bottom;
  }

  /**
   * True while the reserve is within `screens` viewport heights of the reading
   * position — including while it is on screen (a negative distance). Paging
   * continues until at least this much real transcript stands above the reader,
   * rather than stopping the moment the reserve leaves the viewport.
   */
  needsPrefetch(screens = HISTORY_PREFETCH_SCREENS): boolean {
    const viewport = this.viewport;
    if (!viewport || viewport.clientHeight <= 0) return false;
    const distance = this.reserveDistance();
    if (!Number.isFinite(distance)) return false;
    return distance < screens * viewport.clientHeight;
  }

  // ── Rows ──────────────────────────────────────────────────────────────

  /**
   * A row's ref, stable for as long as the row exists, so React never detaches
   * and re-attaches it for a re-render.
   */
  rowRef(id: string) {
    let ref = this.rowRefs.get(id);
    if (!ref) {
      ref = (node: HTMLElement | null) => { this.register(id, node); };
      this.rowRefs.set(id, ref);
    }
    return ref;
  }
  register(id: string, node: HTMLElement | null) {
    if (node) this.nodes.set(id, node);
    else this.nodes.delete(id);
  }
  pin(id: string) {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1); this.publish();
    return () => { const n = (this.pins.get(id) ?? 1) - 1; if (n) this.pins.set(id, n); else this.pins.delete(id); this.publish(); };
  }

  // ── Where the reader is ───────────────────────────────────────────────

  /**
   * Read the reading position from the layout: the row under the viewport's
   * top edge, how far into it the person is, and whether they are riding the
   * newest turn. Nothing is written here; this is what the rest of the app is
   * told about.
   *
   * The live edge is a mode, not a measurement. Reaching the end enters it and
   * a gesture away from the end leaves it, so content arriving underneath a
   * follower — the exact moment the distance to the end is briefly non-zero —
   * never reads as the person having walked away.
   */
  capture = (): Place => {
    const viewport = this.viewport;
    if (!viewport) return this.place;
    const atEnd = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= LIVE_EDGE;
    // Owed placement first; then the person's own last movement. Upwards
    // holds them off the edge whatever the geometry says right now — the
    // wheel may not have moved the view yet, or the list may still be gliding
    // to an end they have just asked to leave. Otherwise being at the end is
    // being on the edge, and a movement that did not reach it is not.
    const following = this.pendingLatest ? true
      : this.lastGesture === "up" ? false
      : atEnd ? true
      : this.gestured ? false
      : this.place.following;
    this.gestured = false;
    const view = viewport.getBoundingClientRect();
    let anchor: Anchor | undefined;
    // The row under the reading position, read from the boxes on screen. Above
    // the oldest loaded row — inside the placeholder for history that has not
    // arrived — the row the person is on is the oldest one they have: the row
    // they will be back on, and the one a trim must not release under them.
    for (const id of this.ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= view.top + 0.5) continue;
      anchor = { messageId: id, offset: view.top - rect.top };
      break;
    }
    this.place = { following, ...(anchor ? { anchor } : {}) };
    return this.place;
  };

  /**
   * The newest turn, now. An explicit intent — the person asked for it, or
   * they sent something — so it goes through the list's own scroll and
   * supersedes whatever else was happening.
   */
  latest = () => {
    this.cancel();
    this.attempts = 0;
    this.pendingLatest = true;
    this.lastGesture = undefined;
    this.place = { following: true };
    this.placeToLatest();
    this.publish();
  };
  /**
   * Place this surface at the newest turn, and keep owing that placement
   * until the layout actually lands there. A conversation opens with its
   * header still growing — the placeholder for unloaded history is sized from
   * a viewport that did not exist in the first commit — so one scroll to the
   * end can be the right scroll to a list that is about to be taller.
   * A person's gesture or a destination cancels the debt.
   */
  private placeToLatest() {
    if (!this.list || this.ids.length === 0 || !this.viewport) return;
    if (this.attempts++ > LATEST_ATTEMPTS) { this.pendingLatest = false; return; }
    void this.list.scrollToEnd({ animated: false });
  }

  /**
   * The layout React just committed. The list has already restored the
   * reading position in its own layout effect; this is where Laser's own
   * state catches up with it — what an unmeasured row is worth, how much
   * unloaded history the header should draw, and what this surface is
   * standing on.
   */
  committed() {
    if (this.disposed) return;
    let changed = this.readLayout();
    const height = this.viewport?.clientHeight ?? 0;
    if (height !== this.lastHeight) { this.lastHeight = height; changed = true; }
    if (this.pendingLatest) this.placeToLatest();
    const before = this.place;
    this.capture();
    if (this.configurePlaceholder()) changed = true;
    if (changed) this.publish();
    else if (before.following !== this.place.following || before.anchor?.messageId !== this.place.anchor?.messageId) this.publishAnchors();
  }

  /**
   * What an unmeasured row is worth, read from the browser rather than
   * predicted: it follows the active type and spacing scales, so a person who
   * changes either gets an estimate that matches what they will see.
   */
  private readLayout(): boolean {
    const content = this.content;
    if (!content) return false;
    const css = getComputedStyle(content);
    const line = Number.parseFloat(css.lineHeight) || Number.parseFloat(css.fontSize) * 1.5;
    const spacing = Number.parseFloat(css.paddingTop) / 5 || line / 4;
    const signature = [content.clientWidth, css.fontFamily, css.fontSize, css.lineHeight, spacing, activityDetailLevel(this.path)].join("|");
    if (signature === this.typeSignature) return false;
    this.typeSignature = signature;
    const estimate = line * 6 + spacing * 5;
    if (!Number.isFinite(estimate) || estimate <= 0 || Math.abs(estimate - this.estimate) < 0.5) return false;
    this.estimate = estimate;
    return true;
  }

  // ── Disclosure ────────────────────────────────────────────────────────

  /**
   * A fold is opening or closing in this row. For as long as it takes to
   * settle, the list restores *that* row rather than whichever row is under
   * the reading position, and it stops maintaining the live edge: the person
   * clicked one control, and the thing that must not move is the thing they
   * clicked.
   */
  holdDisclosure(id: string) {
    this.disclosure = id;
    this.clearDisclosureFrames();
    // The hold ends when the row has measured (`onItemSizeChanged`), and this
    // is the bound for a control whose fold changed no height at all.
    let frames = DISCLOSURE_FRAME_BUDGET;
    const tick = () => {
      if (this.disposed) return;
      if (frames-- > 0) { this.disclosureFrames = [requestAnimationFrame(tick)]; return; }
      this.disclosureFrames = [];
      this.disclosure = undefined;
      this.publish();
    };
    this.disclosureFrames = [requestAnimationFrame(tick)];
    this.publish();
  }
  /** The fold has settled: one frame for the browser's deferred shrink, then go. */
  private releaseDisclosure() {
    this.clearDisclosureFrames();
    this.disclosureFrames = [requestAnimationFrame(() => {
      this.disclosureFrames = [];
      if (this.disposed) return;
      this.disclosure = undefined;
      this.publish();
    })];
  }
  private clearDisclosureFrames() {
    for (const frame of this.disclosureFrames) cancelAnimationFrame(frame);
    this.disclosureFrames = [];
  }

  // ── Destinations ──────────────────────────────────────────────────────

  cancel = (reason?: unknown) => {
    this.intent++;
    if (this.target) { this.target = undefined; this.publishSoon(); }
    if (reason !== "structure") this.controlIntent++;
    for (const [frame, resolve] of this.pendingFrames) { cancelAnimationFrame(frame); resolve(); }
    this.pendingFrames.clear();
    for (const resolve of this.pendingLocates) resolve();
    this.pendingLocates.clear();
  };
  startAction() { this.capture(); this.cancel(); return { path: this.path, intent: this.controlIntent }; }
  async afterAction(ticket: { path: string; intent: number }, target?: TranscriptTarget): Promise<void> {
    // List moves publish before React commits. Begin the new location only
    // after that commit, and never after a later person/destination intent.
    do {
      await this.nextFrame();
      if (this.disposed || ticket.path !== this.path || ticket.intent !== this.controlIntent) return;
      // A successful move can settle before React commits its history. Wait
      // for that exact branch, not an arbitrary number of frames. Only the
      // accepted action calls here; later person/destination intents cancel.
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
   * Take a row — and a block inside it — to the reading position. The list
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
      this.publish();
      let stable = 0;
      let settledAfter: number | undefined;
      for (let frames = 0; frames < LOCATE_FRAME_BUDGET; frames++) {
        await this.nextFrame();
        if (cancelled()) return "cancelled";
        const index = this.positions.get(target.messageId);
        const list = this.list, viewport = this.viewport;
        if (index === undefined || !list || !viewport) { this.cancel(); return "missing"; }
        const row = this.nodes.get(target.messageId);
        if (!row) { void list.scrollToIndex({ index, animated: false, viewPosition: 0.5 }); this.publish(); continue; }
        settledAfter ??= performance.now() + motionMs("--motion-fast");
        const message = row.querySelector<HTMLElement>("[data-message-id]") ?? row;
        const tool = target.toolCallId ? message.querySelector<HTMLElement>(`[data-tool-call="${CSS.escape(target.toolCallId)}"]`) : undefined;
        const rect = options.rect?.(message) ?? (tool ?? message).getBoundingClientRect();
        const footer = this.footerInset();
        const delta = rect.top - viewport.getBoundingClientRect().top - Math.max(0, viewport.clientHeight - footer) / 3;
        if (Math.abs(delta) < 0.5) stable++;
        else { stable = 0; void list.scrollToOffset({ offset: viewport.scrollTop + delta, animated: false }); }
        if (stable >= 2 && performance.now() >= settledAfter) {
          this.target = undefined; this.capture(); this.publish();
          return target.toolCallId && !tool ? "missing" : "visible";
        }
      }
      // The layout never settled. Say what is true: the row is mounted where
      // the list put it, or it is not there at all.
      const landed = this.nodes.has(target.messageId);
      this.target = undefined; this.capture(); this.publish();
      return landed ? "visible" : "missing";
    } finally { options.signal?.removeEventListener("abort", abort); }
  }

  /** How much of the viewport's bottom the composer covers. */
  private footerInset(): number {
    const footer = this.viewport?.parentElement?.querySelector<HTMLElement>('[data-slot="thread-footer"]');
    return footer ? footer.getBoundingClientRect().height : 0;
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
    this.publish();
    const schedule = () => { this.scheduleSample(); };
    // A scroll event is not intent. It is the outcome of one — the person's,
    // or the list's own position keeping — and the list's own writes arrive
    // here too, so nothing this surface owes may be spent on it.
    const scrolled = () => { schedule(); };
    /**
     * Whether a gesture in this direction can move anything. At the bottom of
     * the conversation a wheel further down is not movement, and a tap is not
     * movement at all: neither is a reason to abandon where the person asked
     * to be taken.
     */
    const canMove = (direction: "up" | "down" | "either") => {
      const up = viewport.scrollTop > 0.5;
      const down = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 0.5;
      return direction === "up" ? up : direction === "down" ? down : up || down;
    };
    /**
     * Deliberate movement by the person. It ends a destination — the row they
     * were being taken to is no longer where they are going — and it is the
     * only thing that takes this surface off the live edge. It never writes a
     * scroll position: the browser is already doing that, and the list
     * follows it.
     */
    const user = (direction: "up" | "down" | "either") => {
      if (!canMove(direction)) return;
      this.gestures++;
      this.cancel();
      this.pendingLatest = false;
      this.gestured = true;
      this.lastGesture = direction;
      schedule();
    };
    const selection = () => {
      const content = this.content;
      const selected = document.getSelection();
      if (selected && !selected.isCollapsed && selected.anchorNode === content && selected.focusNode === content && this.ids.length) {
        this.selected = [this.ids[0]!, this.ids.at(-1)!]; this.publish(); return;
      }
      const id = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-window-message]")?.dataset.windowMessage;
      const start = id(selected?.anchorNode ?? null), end = id(selected?.focusNode ?? null);
      const a = start ? this.positions.get(start) : undefined, b = end ? this.positions.get(end) : undefined;
      if (!selected || selected.isCollapsed) this.selected = undefined;
      else if (a !== undefined && b !== undefined) this.selected = [start!, end!];
      else if (selected.rangeCount && content && selected.getRangeAt(0).intersectsNode(content)) {
        // A drag can end on a container boundary before the next window
        // commits. Preserve the already selected interval through that gap.
        const range = selected.getRangeAt(0);
        const intersecting = [...this.nodes].filter(([, node]) => range.intersectsNode(node)).map(([id]) => this.positions.get(id)!);
        if (this.selected) for (const id of this.selected) { const index = this.positions.get(id); if (index !== undefined) intersecting.push(index); }
        if (intersecting.length) this.selected = [this.ids[Math.min(...intersecting)]!, this.ids[Math.max(...intersecting)]!];
      } else this.selected = undefined;
      this.publish();
    };
    const focus = (event: FocusEvent) => {
      const target = event.type === "focusout" ? event.relatedTarget : event.target;
      // Portalled menus retain their originating row until focus returns to the thread.
      if (!(target instanceof Element) || !viewport.contains(target)) return;
      this.focused = target.closest<HTMLElement>("[data-window-message]")?.dataset.windowMessage;
      this.publish();
    };
    /**
     * A fold opening or closing. The control that owns a fold is the one that
     * says whether it is open, so this is the one thing a transcript can read
     * from any disclosure — its own rows', a tool's, a reasoning block's —
     * without every one of them having to tell it. A keyboard activation of a
     * button raises the same click, so both pointers and keys arrive here.
     */
    const disclosed = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest("[aria-expanded]");
      if (!control) return;
      const id = control.closest<HTMLElement>("[data-window-message]")?.dataset.windowMessage;
      if (id) this.holdDisclosure(id);
    };
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      const editsText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      const inComposer = target instanceof Element && target.closest('[data-slot="composer"]') !== null;
      const space = event.key === " " || event.key === "Spacebar";
      const moves = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (space && event.shiftKey)
        ? "up" as const
        : event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" || space
          ? "down" as const
          : undefined;
      if (moves && !editsText && !inComposer) user(moves);
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
        event.preventDefault(); this.selected = this.ids.length ? [this.ids[0]!, this.ids.at(-1)!] : undefined; this.publish();
        const intent = this.intent;
        requestAnimationFrame(() => { if (intent !== this.intent) return; const content = this.content; if (!content) return; const range = document.createRange(); range.selectNodeContents(content); const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); });
      }
    };
    const pointer = (event: PointerEvent) => {
      // A click in the wide transcript gutter is not a scroll intent, and a
      // click on a row is not one either: only the scrollbar moves the view.
      const unit = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-unit"));
      const overlayEdge = Number.isFinite(unit) ? unit * 3 : 0;
      const rtl = viewport.dir === "rtl" || getComputedStyle(viewport).direction === "rtl";
      const overScrollbar = event.offsetX < 0 || event.offsetX > viewport.clientWidth || (rtl ? event.offsetX <= overlayEdge : event.offsetX >= viewport.clientWidth - overlayEdge);
      if (event.target === viewport && viewport.scrollHeight > viewport.clientHeight && overScrollbar) user("either");
      else this.cancel();
    };
    const wheel = (event: WheelEvent) => { if (event.deltaY) user(event.deltaY < 0 ? "up" : "down"); };
    // A touch that has not moved is a tap, not a gesture: only the movement
    // between two points is the person asking to go somewhere else.
    let touchY: number | undefined;
    const touchstart = (event: TouchEvent) => { touchY = event.touches?.[0]?.clientY; };
    const touchmove = (event: TouchEvent) => {
      const next = event.touches?.[0]?.clientY;
      if (next === undefined || touchY === undefined) return;
      const delta = next - touchY;
      touchY = next;
      if (Math.abs(delta) < 0.5) return;
      user(delta > 0 ? "up" : "down");
    };
    const touchend = () => { touchY = undefined; };
    viewport.addEventListener("scroll", scrolled, { passive: true });
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("touchstart", touchstart, { passive: true });
    viewport.addEventListener("touchmove", touchmove, { passive: true });
    viewport.addEventListener("touchend", touchend, { passive: true });
    viewport.addEventListener("touchcancel", touchend, { passive: true });
    viewport.addEventListener("pointerdown", pointer, { passive: true });
    viewport.addEventListener("click", disclosed, { capture: true });
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
      for (const frame of this.disclosureFrames) cancelAnimationFrame(frame);
      this.disclosureFrames = [];
      viewport.removeEventListener("scroll", scrolled);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", touchstart);
      viewport.removeEventListener("touchmove", touchmove);
      viewport.removeEventListener("touchend", touchend);
      viewport.removeEventListener("touchcancel", touchend);
      viewport.removeEventListener("pointerdown", pointer);
      viewport.removeEventListener("click", disclosed, { capture: true });
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
  const previous = useRef({ destination, epoch });
  if (previous.current.destination !== destination || previous.current.epoch !== epoch) {
    controller.cancel(previous.current.destination !== destination ? undefined : "structure");
    previous.current = { destination, epoch };
  }
  controller.configure(path, leafId);
  return <Context value={controller}>{children}</Context>;
}

/**
 * The transcript is the thread's viewport now: the list owns the scroller, so
 * the element every other surface asks the thread for — the conversation map's
 * rail, the question notice, Find — has to be that one and not a box around
 * it. This publishes it, its height, and whether the newest turn is on screen,
 * which is the one thing `ThreadPrimitive.ScrollToBottom` reads to decide
 * whether "Jump to latest" exists.
 */
export function TranscriptViewportBinding() {
  const controller = useTranscriptViewport();
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const store = useThreadViewportStore();
  const viewport = controller.viewport;
  const following = controller.atLiveEdge;
  useLayoutEffect(() => {
    if (!viewport) return;
    const releaseElement = store.getState().registerViewportElement(viewport);
    const size = store.getState().registerViewport();
    const measure = () => size.setHeight(viewport.clientHeight);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    observer?.observe(viewport);
    return () => { observer?.disconnect(); size.unregister(); releaseElement(); };
  }, [store, viewport]);
  useEffect(() => {
    // The viewport store's own writer is the scrolling `ThreadPrimitive.Viewport`,
    // which this thread does not have: the list is the scroller. This surface
    // is therefore the only thing that knows, and `setState` on the store is
    // how the primitive itself would say it.
    (store as unknown as { setState(partial: { isAtBottom: boolean }): void }).setState({ isAtBottom: following });
  }, [store, following]);
  return null;
}

/**
 * The transcript: the header — the notices, the history controls and the
 * placeholder for unloaded history — then one row per message, then a spacer
 * the height of the composer that floats over them.
 *
 * Everything that can change height is inside the list, because anything
 * above it pushes the reader by exactly the height that appeared. The list
 * measures the header like a row and restores the reading position through
 * it; a spacer at the end is explicitly excluded from live follow, so a
 * composer growing a line moves nothing.
 */
export function WindowedMessages({ head, empty }: { head?: ReactNode; empty?: ReactElement | null } = {}) {
  const controller = useTranscriptViewport();
  const ids = unstable_useThreadMessageIds();
  const userOffset = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.history?.userOffset ?? 0 : 0; });
  const before = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.history?.before : undefined; });
  const streaming = useAuiState(s => s.thread.isRunning);
  // The composer floats over the transcript; the list carries its height as
  // trailing space so the newest turn can be read above it.
  const inset = useThreadViewport(s => s.height.inset);
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  controller.setIds(ids);
  controller.setHistoryWindow(userOffset, before);
  const listRef = useRef<LegendListRef>(null);
  useLayoutEffect(() => { controller.bindList(listRef.current ?? undefined); });
  useEffect(() => () => controller.bindList(undefined), [controller]);
  useLayoutEffect(() => { controller.committed(); });
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
  const attached = useRef<HTMLElement | undefined>(undefined);
  const detach = useRef<(() => void) | undefined>(undefined);
  const scroller = useCallback((node: { getScrollableNode?: () => HTMLElement } | HTMLElement | null) => {
    const element = node instanceof HTMLElement ? node : node?.getScrollableNode?.();
    if (attached.current === element) return;
    detach.current?.();
    detach.current = undefined;
    attached.current = element ?? undefined;
    if (element) detach.current = controller.attach(element);
    else controller.setViewport(undefined);
  }, [controller]);
  useEffect(() => () => { detach.current?.(); detach.current = undefined; attached.current = undefined; }, []);
  const renderItem = useCallback(({ item }: { item: string }) => <WindowRow id={item} controller={controller} />, [controller]);
  const heldSignature = controller.heldKeys.join("\u0000");
  const pinnedSignature = controller.pinnedKeys.join("\u0000");
  const alwaysRender = useMemo(() => ({ keys: heldSignature ? heldSignature.split("\u0000") : [] }), [heldSignature]);
  const footer = useMemo(() => <TranscriptInset height={inset} />, [inset]);
  const header = <TranscriptHead turns={controller.placeholderTurns} overdue={overdue}>{head}</TranscriptHead>;
  return <LegendList<string>
    ref={listRef}
    refScrollView={scroller}
    data={ids}
    extraData={`${controller.path}\u0000${ids.length}`}
    // A row a surface is holding open only reaches the list's mounted set on
    // its next pass over the data, and a pin is not a scroll: this is the
    // token that asks for that pass.
    dataVersion={`${controller.path}\u0000${pinnedSignature}`}
    keyExtractor={controller.key}
    getItemType={controller.itemType}
    renderItem={renderItem}
    estimatedItemSize={controller.estimatedItemSize}
    recycleItems={false}
    alwaysRender={alwaysRender}
    initialScrollAtEnd
    // Content above the reader does not move: not when older pages are
    // prepended (`data`), and not when a row grows (`size`). A disclosure
    // toggle names the row it belongs to, and then only that row is restored.
    maintainVisibleContentPosition={controller.positionPolicy}
    maintainScrollAtEnd={controller.followMode(streaming)}
    maintainScrollAtEndThreshold={FOLLOW_THRESHOLD}
    onScroll={controller.onListScroll}
    onItemSizeChanged={controller.onItemSizeChanged}
    showsHorizontalScrollIndicator={false}
    data-slot="thread-viewport"
    aria-busy={loading || undefined}
    className="h-full min-h-0 flex-1 overflow-x-hidden overscroll-y-contain px-4 [overflow-anchor:none] md:px-6"
    ListHeaderComponent={header}
    ListEmptyComponent={empty}
    ListFooterComponent={footer}
  />;
}

/** Everything that belongs above the first message, measured with it. */
function TranscriptHead({ turns, overdue, children }: { turns: number; overdue: boolean; children?: ReactNode }) {
  return <div data-slot="transcript-head" className="mx-auto flex w-full max-w-(--measure-thread) flex-col pt-5">
    {children}
    <HistoryReserve turns={turns} overdue={overdue} />
  </div>;
}

/**
 * The space the composer occupies. It is the list's own trailing content, so
 * the newest turn can be read above the composer, and it is excluded from
 * live follow so that a composer growing a line never moves a message.
 */
function TranscriptInset({ height }: { height: number }) {
  return <div aria-hidden="true" data-slot="transcript-inset" style={{ height: Math.max(0, height) }} />;
}

/**
 * Memoised on purpose. The transcript re-renders whenever a pin changes or the
 * conversation grows — several times per streamed batch — and a row whose
 * content has not changed must not re-render with it: its own message
 * subscription is what tells it that its content moved.
 */
const WindowRow = memo(function WindowRow({ id, controller }: { id: string; controller: TranscriptViewport }) {
  return <div
    ref={controller.rowRef(id)}
    data-window-message={id}
    className="mx-auto w-full max-w-(--measure-thread) pb-5 [&_[data-message-id]]:[content-visibility:visible]"
  >
    <ThreadPrimitive.Unstable_MessageById messageId={id} components={COMPONENTS} />
  </div>;
});
