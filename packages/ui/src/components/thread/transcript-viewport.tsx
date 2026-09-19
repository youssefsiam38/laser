import { ThreadPrimitive, useThreadViewport, unstable_useThreadMessageIds } from "@assistant-ui/react";
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLaserState, visibleSessionPath } from "@/runtime";
import { activityDetailLevel } from "@/runtime/sessionPreferences";
import { motionMs } from "@/motion";
import { HeightIndex, windowRanges } from "./transcript-window.js";
import { clearAnchoredMessages, setAnchoredMessages, setAtLiveEdge, setStandingRows } from "@/runtime/anchored-messages";
import { ThreadMessage } from "./messages.js";
import { HistoryReserve } from "./history-reserve-view.js";
import {
  HistoryReserveModel,
  transitionEarlierPage,
  type EarlierPageTransaction,
} from "./history-reserve.js";

export interface TranscriptTarget { messageId: string; toolCallId?: string; leafId?: string | null }
export interface LocateOptions {
  reason: "find" | "map" | "question" | "action" | "focus" | "restore";
  signal?: AbortSignal;
  locate?: () => Promise<unknown>;
  rect?: (message: HTMLElement) => DOMRect | undefined;
}
export type LocateResult = "visible" | "cancelled" | "missing";
type Anchor = { messageId: string; landmark?: number; toolCallId?: string; offset: number; messageOffset: number };
type Place = { anchor?: Anchor; following: boolean; revision?: string | undefined };
const LANDMARKS = ".md-body > *, [data-slot=collapsible-trigger]";
/** How many head rows a producer page may fold into one merged group. */
const MERGED_HEAD_SCAN = 8;
const COMPONENTS = { Message: ThreadMessage };

/** One instance per rendered thread scope. It never retains a SessionView or an old DOM tree. */
export class TranscriptViewport {
  path = "";
  ids: readonly string[] = [];
  positions = new Map<string, number>();
  heights = new HeightIndex([]);
  viewport: HTMLElement | undefined;
  content: HTMLElement | undefined;
  private estimate = 0;
  private signature = "";
  private measured = new Map<string, number>();
  private places = new Map<string, Place>();
  private place: Place = { following: true };
  private nodes = new Map<string, HTMLElement>();
  private pins = new Map<string, number>();
  private selected: [string, string] | undefined;
  private focused: string | undefined;
  private frame = 0;
  private revision = 0;
  private windowDirty = false;
  private listeners = new Set<() => void>();
  private observer: ResizeObserver | undefined;
  private mutation: MutationObserver | undefined;
  private intent = 0;
  private controlIntent = 0;
  private leafId: string | null | undefined;
  private loaded: string | undefined;
  // A surface that just reloaded its recent tail is on its way to the latest
  // message; the clamp scrolls that replacement causes are not a person.
  private arriving = false;
  private pendingFrames = new Map<number, () => void>();
  private pendingLocates = new Set<() => void>();
  private target: TranscriptTarget | undefined;
  // A measured destination owns its anchor until a new navigation intent.
  // Native layout/clamp scrolls can arrive even after the target settles.
  private ownsLocation = false;
  private expectedTop: number | undefined;
  private lastTop = 0;
  private lastHeight = 0;
  /** A same-path accepted tail replacement gets one placement after its commit. */
  private pendingTailPlacement = false;
  /** Movement of the anchor caused by a list change that has rendered but not painted. */
  private structuralShift: number | undefined;
  /** The person is moving the viewport right now; layout may shift it, never re-place it. */
  private reading: ReturnType<typeof setTimeout> | undefined;
  /** Unloaded earlier turns occupy honest scroll range above the loaded window. */
  private reserve = new HistoryReserveModel();
  private historyUserOffset = 0;
  private loadedUserTurns = 0;
  private historyBefore: string | undefined;
  /** An earlier page owns estimate-based placement until its store commit. */
  private earlierPage: EarlierPageTransaction | undefined;
  private earlierFallbackFrame = 0;
  private earlierFallbacks = 0;
  /** Only this arrived prefix may exchange later first-frame measurements. */
  private arrivedPage: { ids: readonly string[]; removedHeight: number; exchangedHeight: number; refine: boolean } | undefined;
  /** The last id change kept no part of the previous window: a replacement, not a page. */
  private replacedWindow = false;
  /**
   * Where the transcript starts inside the scroller, last frame. Whatever sits
   * above it (the history controls appearing or going) is above the reader
   * too, and its height change moves them exactly like a row's would.
   */
  private contentOffset: number | undefined;
  /**
   * Compensation the clamp at scrollTop 0 could not spend. Content above the
   * reader can be removed in one commit and replaced in the next — the estimate
   * going before the last page's rows arrive — and without this the truncated
   * movement is lost and the reader stays pinned to the top of the window.
   */
  private clampDebt = 0;
  /**
   * Root arrived before the page's rows did. The estimate waits for the commit
   * that brings them, so both compensations happen in one frame; once the page
   * has settled it goes whether or not any row came with it.
   */
  private deferredRootCollapse: { rows: number } | undefined;
  /** Disclosure anchoring starts at animationstart, after the open state committed. */
  private disclosureTargets = new Set<Element>();
  private disclosureFrame = 0;
  private disclosureFollowing = false;
  private disposed = false;
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.revision++; this.publishAnchors(); for (const listener of this.listeners) listener(); }

  /**
   * The rows this surface is standing on, so releasing the older part of the
   * conversation never pulls one out from under a person (RP-5b): the anchor
   * the viewport is holding, the focused row, anything a surface pinned while
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
  private cacheKey(id: string) { return JSON.stringify([this.path, this.signature, id]); }
  configure(path: string, leafId?: string | null, loaded?: string) {
    this.leafId = leafId;
    if (this.path === path) {
      // This surface read the session's recent tail again. That is not a reason
      // to take the person back to the latest turn: an authoritative page
      // replacing what this device painted is the same conversation, and they
      // are still reading where they were (RP-11). `restore()` keeps the anchor
      // while its row is still here and falls back to the latest turn only when
      // the window genuinely no longer holds it — which is the case this reset
      // was written for. Somebody who *was* at the live edge stays there.
      if (loaded !== undefined && loaded !== this.loaded) {
        this.cancel();
        this.loaded = loaded;
        this.windowDirty = true;
        if (this.place.following) {
          this.arriving = true;
          this.pendingTailPlacement = true;
        }
        this.schedule();
      }
      return;
    }
    const leftRevision = this.loaded;
    this.loaded = loaded;
    this.expectedTop = undefined;
    this.pendingTailPlacement = false;
    this.cancel();
    if (this.path) {
      this.places.set(this.path, { ...this.place, revision: leftRevision });
      // The conversation this surface has left stands on nothing: its ids go
      // with it, so they neither protect its rows from a trim nor linger.
      clearAnchoredMessages(this.path);
    }
    this.path = path;
    this.replacedWindow = false;
    this.contentOffset = undefined;
    this.clampDebt = 0;
    this.deferredRootCollapse = undefined;
    this.reserve.reset();
    this.historyUserOffset = 0;
    this.loadedUserTurns = 0;
    this.historyBefore = undefined;
    this.releaseEarlierPage("path");
    const saved = this.places.get(path);
    // The revision stamp proves whether a saved place belongs to this accepted
    // history window. Leaving the path also ended the visit that captured it,
    // so re-entry always chooses latest even when that revision is unchanged.
    const replaced = saved !== undefined && saved.revision !== loaded;
    if (saved) this.places.delete(path);
    this.place = { following: true };
    this.arriving = Boolean(path && (saved || replaced));
    this.ids = [];
    this.positions.clear();
    this.heights = new HeightIndex([]);
    this.pins.clear(); this.selected = undefined; this.focused = undefined;
    this.nodes.clear();
    this.publishAnchors();
    // ThreadPrimitive can reset the shared native viewport to zero while this
    // destination's recent rows commit. A same-size list does not change layout,
    // so force the configured place to run on the next frame rather than leaving
    // a returning session at the first row of its tail.
    this.windowDirty = true;
    this.schedule();
  }
  retain(paths: readonly string[]) {
    const open = new Set(paths);
    for (const path of this.places.keys()) if (!open.has(path)) this.places.delete(path);
  }
  setIds(ids: readonly string[]) {
    if (this.ids === ids || (this.ids.length === ids.length && this.ids.every((id, i) => ids[i] === id))) return;
    const previous = this.ids;
    const previousHeights = this.heights;
    // Where the person's anchor sits before the list changes under it. Rows
    // inserted above it (an earlier page) move it by their estimated height;
    // the viewport must move by exactly that before the next paint, or the
    // reader is left looking at the top of the page that just arrived while
    // the section they were reading is now a page further down. Later
    // measurements refine estimates by their delta, as they already do.
    const anchor = !this.place.following ? this.place.anchor : undefined;
    const anchorIndex = anchor ? this.positions.get(anchor.messageId) : undefined;
    const anchorBefore = anchorIndex !== undefined ? this.globalOffset(anchorIndex) : undefined;
    // Where the person is looking decides what "nothing moved" means. On
    // loaded rows it means the anchored row keeps its place, so the arriving
    // page is compensated exactly. Inside the estimate there is no row on
    // screen to keep: what is under them is placeholder, and the page's rows
    // belong exactly there. Compensating then writes scrollTop against their
    // own movement — the conversation pushes back and the same row returns
    // however long they scroll (D-302).
    const insideReserve = this.readingInsideReserve();
    this.ids = ids;
    this.positions = new Map(ids.map((id, i) => [id, i]));
    this.rebuild();
    // A page may preserve its cursor while replacing or merging rows. The
    // changed store, not cursor inequality alone, is the
    // transaction signal; loading-only renders never enter setIds.
    if (this.earlierPage) this.applyEarlierTransition({ type: "store-change" });
    // A page can prepend cleanly or merge into the oldest projected group. Find
    // the preserved suffix and exchange only the positive height inserted above
    // it; a replacement with no preserved suffix is not attributed to history.
    //
    // Not gated on the page transaction: an accepted page commits over several
    // React commits, and the later ones land after the transaction has
    // released. Prefix growth while a cursor still points at unloaded history
    // is that history arriving, whichever commit carries it (M16-T83). Growth
    // *inside* an existing row — streaming, disclosure, an image — is not a
    // prefix change and never reaches here.
    const boundary = previous.length && ids.length ? this.preservedSuffix(previous, ids) : undefined;
    this.replacedWindow = previous.length > 0 && boundary === undefined;
    let pageAttributed = false;
    if (boundary && boundary.nextStart > 0 && (this.historyBefore !== undefined || this.deferredRootCollapse !== undefined)) {
      pageAttributed = true;
      const removedHeight = previousHeights.offset(boundary.previousStart);
      const insertedHeight = Math.max(0, this.heights.offset(boundary.nextStart) - removedHeight);
      const reserveBefore = this.reserve.height;
      this.reserve.arrived(insertedHeight);
      const globalShift = insertedHeight + this.reserve.height - reserveBefore;
      if (!insideReserve && Math.abs(globalShift) >= 0.5) this.structuralShift = (this.structuralShift ?? 0) + globalShift;
      this.arrivedPage = { ids: ids.slice(0, boundary.nextStart), removedHeight, exchangedHeight: insertedHeight, refine: true };
    }
    if (!pageAttributed && !insideReserve && anchor && anchorBefore !== undefined) {
      const index = this.positions.get(anchor.messageId);
      const shift = index === undefined ? 0 : this.globalOffset(index) - anchorBefore;
      if (Math.abs(shift) >= 0.5) this.structuralShift = (this.structuralShift ?? 0) + shift;
    }
    // A branch replacement cancels a pending destination; appends/prepends do not.
    if (previous.length && previous.some(id => !this.positions.has(id))) this.cancel("structure");
  }
  /**
   * Where a new id list keeps a suffix of the old one, or nothing when the
   * window was replaced. A page either prepends whole rows or folds the oldest
   * ones into a merged group, so the search is bounded to the few head rows a
   * merge can consume rather than comparing every alignment of two long lists.
   */
  private preservedSuffix(previous: readonly string[], ids: readonly string[]): { previousStart: number; nextStart: number } | undefined {
    const shift = ids.length - previous.length;
    const limit = Math.min(previous.length, MERGED_HEAD_SCAN);
    for (let start = 0; start < limit; start++) {
      const nextStart = start + shift;
      if (nextStart < 0 || nextStart > ids.length) continue;
      if (previous.length - start !== ids.length - nextStart) continue;
      let same = true;
      for (let offset = 0; same && offset < previous.length - start; offset++) same = ids[nextStart + offset] === previous[start + offset];
      if (same) return { previousStart: start, nextStart };
    }
    return undefined;
  }
  private rebuild() { this.heights = new HeightIndex(this.ids.map(id => this.measured.get(this.cacheKey(id)) ?? this.estimate)); }
  get reserveHeight() { return this.reserve.height; }
  /** Loaded-row coordinate at the viewport top; negative means the reader is in the reserve. */
  private loadedTop() { return this.top() - this.reserve.height; }
  private globalOffset(index: number) { return this.reserve.height + this.heights.offset(index); }
  private top() {
    if (!this.viewport || !this.content) return 0;
    return this.viewport.getBoundingClientRect().top - this.content.getBoundingClientRect().top;
  }
  ranges() {
    const height = this.viewport?.clientHeight || window.innerHeight;
    let top = this.loadedTop();
    const targetIndex = this.target ? this.positions.get(this.target.messageId) : undefined;
    // Mount/unmount callbacks can synchronously rerender before the next measured
    // frame. While locating, the canonical target must own the window: switching
    // between the live top and an evicted old anchor makes those renders oscillate.
    if (targetIndex !== undefined) top = this.heights.offset(targetIndex) - height / 3;
    else if (!this.content || this.place.following) top = this.heights.total - height;
    else if (this.place.anchor && (this.structuralShift !== undefined || !this.nodes.has(this.place.anchor.messageId))) top = this.heights.offset(this.positions.get(this.place.anchor.messageId) ?? 0) - this.place.anchor.messageOffset;
    const pins = [...this.pins.keys(), this.focused, this.target?.messageId].flatMap(id => id && this.positions.has(id) ? [this.positions.get(id)!] : []);
    if (this.selected) {
      const a = this.positions.get(this.selected[0]), b = this.positions.get(this.selected[1]);
      if (a !== undefined && b !== undefined) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) pins.push(i);
    }
    return windowRanges(this.heights, top, height, pins);
  }
  pin(id: string) {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1); this.publish();
    return () => { const n = (this.pins.get(id) ?? 1) - 1; if (n) this.pins.set(id, n); else this.pins.delete(id); this.publish(); };
  }
  register(id: string, node: HTMLElement | null) {
    const previous = this.nodes.get(id);
    if (previous === node) return;
    if (previous) this.observer?.unobserve(previous);
    if (node) { this.nodes.set(id, node); this.observer?.observe(node); }
    else this.nodes.delete(id);
    this.schedule();
  }
  setContent(node: HTMLElement | null) {
    if (this.content === node) return;
    this.content = node ?? undefined;
    if (!this.mutation) return;
    this.mutation.disconnect();
    if (node) this.mutation.observe(node, { subtree: true, childList: true, characterData: true });
  }
  private edgeGap() {
    const viewport = this.viewport;
    return viewport ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop : Number.POSITIVE_INFINITY;
  }
  /** Raw input may leave follow only when the viewport can move that way. */
  private canMove(direction: "up" | "down") {
    const viewport = this.viewport;
    if (!viewport) return false;
    return direction === "up" ? viewport.scrollTop > 0 : this.edgeGap() > 2;
  }
  /** Move by exactly what changed above the reader, surviving the clamp at 0. */
  private shiftBy(delta: number) {
    if (!this.viewport || (Math.abs(delta) < 0.5 && this.clampDebt === 0)) return;
    const target = this.viewport.scrollTop + delta + this.clampDebt;
    // Above the content there is nowhere to go: the part of the movement the
    // clamp cannot spend stays owed, with its sign, until content above the
    // reader exists again.
    this.clampDebt = target < 0 ? target : 0;
    this.scroll(Math.max(0, target));
  }
  /**
   * The height change, since the last frame, of everything above the
   * transcript inside the scroller. Measured from the DOM, because none of it
   * is in this controller's model; compensated like any change above the reader.
   */
  private aboveTranscriptShift(): number {
    if (!this.viewport || !this.content) return 0;
    const now = this.content.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top + this.viewport.scrollTop;
    const before = this.contentOffset;
    this.contentOffset = now;
    if (before === undefined || this.place.following) return 0;
    const delta = now - before;
    return Math.abs(delta) >= 0.5 ? delta : 0;
  }
  private scroll(top: number) {
    if (!this.viewport) return;
    const before = this.viewport.scrollTop;
    // Read-only attribution for the browser harness: it sets the array, and
    // every write this controller makes is recorded with its call path.
    const trace = (globalThis as { __laserScrollTrace?: unknown[] }).__laserScrollTrace;
    if (Array.isArray(trace)) trace.push({ at: performance.now(), from: before, to: top, reserve: this.reserve.height, following: this.place.following, reading: Boolean(this.reading), page: Boolean(this.earlierPage), anchor: this.place.anchor?.messageId, stack: new Error().stack });
    this.viewport.scrollTop = top;
    if (Math.abs(this.viewport.scrollTop - before) >= 0.5) this.expectedTop = this.viewport.scrollTop;
  }
  capture = (): Place => {
    const viewport = this.viewport;
    if (!viewport) return this.place;
    const top = viewport.getBoundingClientRect().top;
    const row = [...this.nodes.entries()].sort((a, b) => (this.positions.get(a[0]) ?? 0) - (this.positions.get(b[0]) ?? 0))
      .find(([, node]) => node.getBoundingClientRect().bottom > top);
    if (!row || row[1].getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom) {
      const loadedTop = this.loadedTop();
      const index = this.heights.at(loadedTop);
      const messageId = this.ids[index];
      if (messageId) { const offset = this.heights.offset(index) - loadedTop; this.place = { following: this.place.following, anchor: { messageId, offset, messageOffset: offset } }; }
      return this.place;
    }
    const [messageId, node] = row;
    const landmarks = [...node.querySelectorAll<HTMLElement>(LANDMARKS)];
    const landmark = landmarks.findIndex(n => n.getBoundingClientRect().height > 0 && n.getBoundingClientRect().top >= top);
    const mark = landmarks[landmark];
    const toolCallId = mark?.closest<HTMLElement>("[data-tool-call]")?.dataset.toolCall;
    this.place = { following: this.place.following, anchor: { messageId, ...(landmark >= 0 ? { landmark } : {}), ...(toolCallId ? { toolCallId } : {}), offset: (mark ?? node).getBoundingClientRect().top - top, messageOffset: node.getBoundingClientRect().top - top } };
    return this.place;
  };
  private restore() {
    const viewport = this.viewport;
    // While an earlier page is committing, only structural/measurement deltas
    // may move the viewport. An absolute estimate or latest fallback here is
    // the root-to-bottom loop this controller exists to prevent.
    if (!viewport || this.target || (this.earlierPage && !this.place.following)) return;
    if (this.place.following) {
      const placeTail = this.pendingTailPlacement || this.edgeGap() > 2;
      this.pendingTailPlacement = false;
      if (!placeTail) this.arriving = false;
      else this.scroll(Math.max(0, viewport.scrollHeight - viewport.clientHeight));
      return;
    }
    const anchor = this.place.anchor;
    if (!anchor) return;
    const row = this.nodes.get(anchor.messageId);
    if (!row) {
      const index = this.positions.get(anchor.messageId);
      // While the person is reading upwards, the anchor's row is often not
      // mounted yet and the index above it is still estimates. Placing it
      // from those estimates moved the viewport back down under their wheel.
      // Leave the position alone; measure() shifts by exactly what changes.
      if (this.reading) return;
      if (index !== undefined) { this.scroll(viewport.scrollTop + this.heights.offset(index) - this.loadedTop() - anchor.messageOffset); return; }
      // The transcript this place belonged to is not loaded here any more.
      // When the window was *replaced* — a reloaded recent tail, a branch that
      // dropped the message — latest is the honest answer. When it was not,
      // this row was folded into an older group by a page that arrived above
      // (M16-T83): the conversation is the same, the reader is still in it,
      // and taking them to the newest turn is the loop this controller exists
      // to prevent. Re-anchor on what is on screen and leave them there.
      if (!this.replacedWindow && !this.arriving) { this.capture(); return; }
      this.place = { following: true };
      this.arriving = true;
      this.scroll(Math.max(0, viewport.scrollHeight - viewport.clientHeight));
      return;
    }
    const mark = anchor.toolCallId ? row.querySelector<HTMLElement>(`[data-tool-call="${CSS.escape(anchor.toolCallId)}"] ${LANDMARKS.split(",").at(-1)!.trim()}`)
      : anchor.landmark === undefined ? undefined : row.querySelectorAll<HTMLElement>(LANDMARKS)[anchor.landmark];
    const live = mark && mark.getBoundingClientRect().height > 0 ? mark : row;
    const delta = live.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (live === row ? anchor.messageOffset : anchor.offset);
    if (Math.abs(delta) >= 0.5) this.scroll(viewport.scrollTop + delta);
  }
  private layout() {
    if (!this.content) return false;
    const css = getComputedStyle(this.content);
    // Unknown row estimates derive from the active type and spacing scales.
    const line = Number.parseFloat(css.lineHeight) || Number.parseFloat(css.fontSize) * 1.5;
    const spacing = Number.parseFloat(css.paddingTop) / 5 || line / 4;
    const signature = [this.content.clientWidth, css.fontFamily, css.fontSize, css.lineHeight, spacing, activityDetailLevel(this.path)].join("|");
    this.estimate = line * 6 + spacing * 5;
    if (signature === this.signature) return false;
    this.signature = signature; this.rebuild();
    this.configureReserve();
    return true;
  }
  private measure = () => {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.disposed) return;
    // Where the anchor sits before this pass, taken before anything in it can
    // move: type/spacing relayout, a held root estimate going, the reserve
    // refining and measured rows all change the same coordinate. Whatever any
    // of them change above the anchor, the person must not feel it: one shift
    // by exactly that amount at the end of the pass, never a fresh absolute.
    const anchorIndex = !this.place.following && this.place.anchor ? this.positions.get(this.place.anchor.messageId) : undefined;
    const anchorBefore = anchorIndex !== undefined ? this.globalOffset(anchorIndex) : undefined;
    const reserveBefore = this.reserve.height;
    let changed = this.layout();
    // A held root estimate is removed on the first measured frame after its
    // page settles, whether or not another commit follows.
    if (this.collapseDeferredRoot("now")) changed = true;
    for (const [id, node] of this.nodes) {
      const index = this.positions.get(id);
      if (index === undefined) continue;
      // Mounted messages have content-visibility:visible; skipped intrinsic boxes never enter this cache.
      const height = node.getBoundingClientRect().height;
      if (height <= 0 || this.heights.height(index) === height) continue;
      this.heights.update(index, height);
      const key = this.cacheKey(id);
      this.measured.delete(key); this.measured.set(key, height);
      changed = true;
    }
    // Refine only the prefix this page inserted, and only on its first measured
    // frame. Streaming, disclosure, image and font growth elsewhere cannot
    // become fictitious unloaded history.
    let pageDelta: number | undefined;
    if (this.arrivedPage?.refine) {
      const pageHeight = Math.max(0, this.arrivedPage.ids.reduce((sum, id) => {
        const index = this.positions.get(id);
        return sum + (index === undefined ? 0 : this.heights.height(index));
      }, 0) - this.arrivedPage.removedHeight);
      pageDelta = pageHeight - this.arrivedPage.exchangedHeight;
      this.reserve.refineArrived(pageDelta);
      this.arrivedPage.exchangedHeight = pageHeight;
      this.arrivedPage.refine = false;
    }
    this.configureReserve();
    // A global measurement budget, including layouts and previously visited sessions.
    while (this.measured.size > 20_000) this.measured.delete(this.measured.keys().next().value!);
    // Change above the reader is a relative movement, never a placement. The
    // anchor's own offset says exactly what changed above it; without a placed
    // anchor (its id was folded into a merged group this frame) the reserve and
    // the arrived prefix are everything above. An absolute restore against the
    // mounted row is right only when the person is still and no page is settling.
    const anchorRow = this.place.anchor ? this.nodes.get(this.place.anchor.messageId) : undefined;
    const readerHeld = this.viewport && !this.target && !this.place.following;
    const above = this.aboveTranscriptShift();
    let compensated = false;
    if (readerHeld && anchorIndex !== undefined && anchorBefore !== undefined
      && (Boolean(this.reading) || !anchorRow || pageDelta !== undefined || this.clampDebt !== 0 || above !== 0)) {
      compensated = true;
      this.shiftBy(this.globalOffset(anchorIndex) - anchorBefore + above);
    } else if (readerHeld && anchorIndex === undefined && (pageDelta !== undefined || above !== 0 || Math.abs(this.reserve.height - reserveBefore) >= 0.5)) {
      compensated = true;
      this.shiftBy(this.reserve.height - reserveBefore + (pageDelta ?? 0) + above);
    }
    if (changed || this.windowDirty) {
      this.windowDirty = false;
      if (!compensated) this.restore();
      this.publish();
    }
    this.capture();
  };
  schedule = () => { if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(this.measure); };
  /**
   * Bracket any change to the estimated range, which sits above everything, so
   * the reader's pixels do not move with it: compensate by how far the anchor
   * moved, or — when no anchor row is placed — by the change itself.
   */
  private withReserveCompensation(change: () => void) {
    const anchorIndex = !this.place.following && this.place.anchor ? this.positions.get(this.place.anchor.messageId) : undefined;
    const anchorBefore = anchorIndex !== undefined ? this.globalOffset(anchorIndex) : undefined;
    const reserveBefore = this.reserve.height;
    const insideReserve = this.readingInsideReserve();
    change();
    if (this.place.following || insideReserve) return;
    const shift = anchorIndex !== undefined && anchorBefore !== undefined
      ? this.globalOffset(anchorIndex) - anchorBefore
      : this.reserve.height - reserveBefore;
    if (Math.abs(shift) >= 0.5) this.structuralShift = (this.structuralShift ?? 0) + shift;
  }
  /**
   * Remove a held root estimate once the page that reached it has committed.
   * Inside a commit the change joins that frame's structural shift; on a
   * measured frame `measure()`'s own bracket compensates it with everything else.
   */
  private collapseDeferredRoot(apply: "commit" | "now"): boolean {
    const held = this.deferredRootCollapse;
    if (!held) return false;
    // While the page is still committing, its rows may still be on their way.
    if (this.ids.length === held.rows && this.earlierPage) return false;
    this.deferredRootCollapse = undefined;
    const before = this.reserve.height;
    if (apply === "commit") this.withReserveCompensation(() => this.configureReserve());
    else this.configureReserve();
    return Math.abs(this.reserve.height - before) >= 0.5;
  }
  private configureReserve() {
    this.reserve.configure({
      hasBefore: this.historyBefore !== undefined || this.deferredRootCollapse !== undefined,
      userOffset: this.historyUserOffset,
      loadedUserTurns: this.loadedUserTurns,
      loadedHeight: this.heights.total,
      rowEstimate: this.estimate,
      rows: this.ids.length,
      viewportHeight: this.viewport?.clientHeight,
    });
  }
  setHistoryWindow(userOffset: number, loadedUserTurns: number, before: string | undefined) {
    const changed = this.historyUserOffset !== userOffset || this.loadedUserTurns !== loadedUserTurns || this.historyBefore !== before;
    const pageChanged = Boolean(this.earlierPage && changed);
    this.historyUserOffset = Math.max(0, userOffset);
    this.loadedUserTurns = Math.max(0, loadedUserTurns);
    this.historyBefore = before;
    // The producer's "there is nothing before this" can commit before the rows
    // of the page that proved it. Removing the estimate then takes pixels from
    // above the reader while their replacement is still arriving, and drags
    // them to the top of the conversation (M16-T83 invariant 4). Hold the
    // estimate until the page this belongs to has finished committing.
    if (before === undefined && changed && this.earlierPage && this.reserve.height > 0) this.deferredRootCollapse ??= { rows: this.ids.length };
    if (before !== undefined) this.deferredRootCollapse = undefined;
    this.withReserveCompensation(() => this.configureReserve());
    if (pageChanged) this.applyEarlierTransition({ type: "store-change" });
    if (changed) this.windowDirty = true;
  }
  private applyEarlierTransition(event: Parameters<typeof transitionEarlierPage>[1]) {
    const result = transitionEarlierPage(this.earlierPage, event);
    this.earlierPage = result.state;
    if (result.released && this.earlierFallbackFrame) {
      cancelAnimationFrame(this.earlierFallbackFrame);
      this.earlierFallbackFrame = 0;
    }
    return result.released;
  }
  private releaseEarlierPage(_reason: "cancel" | "path" | "unmount" | "fallback") {
    const released = this.applyEarlierTransition({ type: "cancel" });
    if (this.earlierFallbackFrame) cancelAnimationFrame(this.earlierFallbackFrame);
    this.earlierFallbackFrame = 0;
    this.arrivedPage = undefined;
    if (released) { this.publish(); this.schedule(); }
  }
  beginEarlierPage() {
    this.capture();
    this.reserve.startReading();
    this.applyEarlierTransition({ type: "begin", before: this.historyBefore });
    this.arrivedPage = undefined;
    this.arriving = false;
    this.expectedTop = undefined;
    // Keep following intact: its geometric placement remains authoritative
    // while only estimate-based reading restoration is fenced.
    this.publish();
  }
  finishEarlierPage() {
    if (!this.earlierPage) return;
    const released = this.applyEarlierTransition({ type: "settled" });
    if (released) { this.publish(); this.schedule(); return; }
    const transaction = this.earlierPage;
    if (this.earlierFallbackFrame) cancelAnimationFrame(this.earlierFallbackFrame);
    this.earlierFallbackFrame = requestAnimationFrame(() => {
      this.earlierFallbackFrame = 0;
      if (this.earlierPage !== transaction || !transaction?.settled) return;
      this.earlierFallbacks++;
      this.releaseEarlierPage("fallback");
    });
  }
  cancelEarlierPage() { this.releaseEarlierPage("cancel"); }
  /** True only after the person has crossed above loaded rows into the estimate. */
  /** The reading position is in the estimate: no loaded row is on screen. */
  private readingInsideReserve() {
    return Boolean(this.viewport && this.reserve.height > 0 && this.loadedTop() < 0);
  }
  isReadingHistoryReserve() {
    return Boolean(this.viewport && this.reserve.height > 0 && this.loadedTop() < 0);
  }
  get loadingEarlier() { return this.earlierPage !== undefined; }
  get earlierPageFallbackCount() { return this.earlierFallbacks; }
  committed() {
    if (this.layout()) this.windowDirty = true;
    // The page that reached the beginning has committed: its rows now hold the
    // pixels the estimate was holding, so the estimate goes in this same frame,
    // compensated, rather than leaving a range that claims unloaded history.
    if (this.collapseDeferredRoot("commit")) this.windowDirty = true;
    const above = this.aboveTranscriptShift();
    const shift = this.structuralShift === undefined && above === 0 ? undefined : (this.structuralShift ?? 0) + above;
    this.structuralShift = undefined;
    // Rows arrived above the anchor in this commit, or the controls above the
    // transcript changed: move by what they take up now, before anyone sees
    // the frame. `measure` refines that estimate; an absolute `restore` is
    // safe only after active input has settled.
    if (shift !== undefined && this.viewport && !this.target) this.shiftBy(shift);
    // Browser default scrolling updates scrollTop before its scroll event lets
    // capture() move the anchor. A layout commit can land in that gap. Never
    // restore the stale mounted anchor over active wheel/touch/key movement;
    // structural and measured-height deltas above are the only safe changes.
    if (!this.reading || this.place.following) this.restore();
    if (this.earlierPage && this.applyEarlierTransition({ type: "commit" })) this.publish();
    this.schedule();
  }
  cancel = (reason?: unknown) => {
    this.ownsLocation = false;
    this.intent++;
    if (this.target) { this.target = undefined; this.windowDirty = true; this.schedule(); }
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
    // An explicit destination supersedes recent-tail arrival. Otherwise a
    // native locate scroll could be mistaken for the replacement clamp and
    // silently turn following back on before the target settles.
    this.arriving = false;
    this.place.following = false;
    this.ownsLocation = true;
    this.target = target;
    this.publish();
    let stable = 0;
    let settledAfter: number | undefined;
    for (;;) {
      await this.nextFrame();
      if (cancelled()) return "cancelled";
      if (!this.positions.has(target.messageId)) { this.cancel(); return "missing"; }
      const viewport = this.viewport;
      if (!viewport) { this.cancel(); return "missing"; }
      const row = this.nodes.get(target.messageId);
      if (!row) { this.scroll(viewport.scrollTop + this.heights.offset(this.positions.get(target.messageId)!) - this.loadedTop()); this.publish(); continue; }
      settledAfter ??= performance.now() + motionMs("--motion-fast");
      this.measure();
      const message = row.querySelector<HTMLElement>("[data-message-id]") ?? row;
      const tool = target.toolCallId ? message.querySelector<HTMLElement>(`[data-tool-call="${CSS.escape(target.toolCallId)}"]`) : undefined;
      const rect = options.rect?.(message) ?? (tool ?? message).getBoundingClientRect();
      const footer = viewport.querySelector<HTMLElement>('[data-slot="thread-footer"]')?.getBoundingClientRect().height ?? 0;
      const delta = rect.top - viewport.getBoundingClientRect().top - Math.max(0, viewport.clientHeight - footer) / 3;
      const before = viewport.scrollTop;
      this.scroll(before + delta);
      stable = Math.abs(viewport.scrollTop - before) < 0.5 ? stable + 1 : 0;
      if (stable >= 2 && performance.now() >= settledAfter) {
        this.target = undefined; this.capture(); this.publish();
        return target.toolCallId && !tool ? "missing" : "visible";
      }
    }
    } finally { options.signal?.removeEventListener("abort", abort); }
  }
  latest = () => {
    this.cancel(); this.clampDebt = 0; this.place.following = true; this.publish();
    if (this.viewport) this.scroll(Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight));
    // `scroll()` owns an event only when this placement actually moved.
    // Follow geometry handles later growth when latest was already in place.
    this.schedule();
  };
  private disclosureTick = () => {
    this.disclosureFrame = 0;
    if (this.disposed) return;
    for (const target of this.disclosureTargets) if (!target.isConnected || !this.viewport?.contains(target)) this.disclosureTargets.delete(target);
    if (this.disclosureFollowing ? this.place.following : !this.place.following && !this.reading) this.restore();
    if (this.disclosureTargets.size > 0) this.disclosureFrame = requestAnimationFrame(this.disclosureTick);
  };
  private startDisclosureHold(target: Element) {
    const first = this.disclosureTargets.size === 0;
    this.disclosureTargets.add(target);
    if (!first) return;
    // animationstart is dispatched only after the disclosure's open state has
    // committed. Capture the away anchor here, not in its click handler.
    this.disclosureFollowing = this.place.following;
    if (!this.disclosureFollowing) this.capture();
    if (!this.disclosureFrame) this.disclosureFrame = requestAnimationFrame(this.disclosureTick);
  }
  private endDisclosureHold(target: Element) {
    if (!this.disclosureTargets.delete(target)) return;
    // One post-animation correction settles the final keyframe.
    if (this.disclosureTargets.size === 0 && !this.disclosureFrame) this.disclosureFrame = requestAnimationFrame(this.disclosureTick);
  }
  private stopDisclosureHold() {
    this.disclosureTargets.clear();
    if (this.disclosureFrame) cancelAnimationFrame(this.disclosureFrame);
    this.disclosureFrame = 0;
  }
  attach(viewport: HTMLElement) {
    this.disposed = false; this.viewport = viewport;
    this.lastTop = viewport.scrollTop;
    this.lastHeight = viewport.scrollHeight;
    this.observer = new ResizeObserver(() => {
      // ResizeObserver runs after layout and before paint. Pin here, rather
      // than one rAF later, so a batched row expansion never paints a gap.
      // Every growth class takes this path: streamed text, a late block in an
      // existing row, image decode, highlighting and viewport reflow.
      if (this.place.following) this.restore();
      this.schedule();
    });
    this.observer.observe(viewport);
    for (const node of this.nodes.values()) this.observer.observe(node);
    this.mutation = new MutationObserver(() => {
      // Text/child commits can paint before a descendant ResizeObserver is
      // delivered. Only the followed transcript needs this earlier correction;
      // ResizeObserver and commits maintain an away reader's measured anchor.
      if (!this.place.following) return;
      this.restore();
      this.schedule();
    });
    if (this.content) this.mutation.observe(this.content, { subtree: true, childList: true, characterData: true });
    const markReading = () => {
      this.reserve.startReading();
      if (this.reading) clearTimeout(this.reading);
      this.reading = setTimeout(() => { this.reading = undefined; this.schedule(); }, 400);
    };
    let scrollbarDrag = false;
    const scroll = () => {
      const top = viewport.scrollTop;
      const height = viewport.scrollHeight;
      const previousTop = this.lastTop;
      const previousHeight = this.lastHeight;
      const moved = Math.abs(top - previousTop) >= 0.5;
      const geometryChanged = Math.abs(height - previousHeight) >= 0.5;
      const dragged = scrollbarDrag && moved;
      if (dragged) scrollbarDrag = false;
      this.lastTop = top;
      this.lastHeight = height;
      // Every write through `scroll()` is ours. Input that can move clears this
      // expectation synchronously, so a person's next movement cannot be
      // consumed as a delayed correction.
      if (this.expectedTop !== undefined) {
        this.expectedTop = undefined;
        this.windowDirty = true;
        this.schedule();
        return;
      }
      // A thumb drag is measured user movement even if streamed growth changed
      // scrollHeight in the same frame. It also supersedes any destination.
      if (dragged) { this.cancel(); this.arriving = false; }
      if (this.arriving) { this.place.following = true; this.windowDirty = true; this.schedule(); return; }
      if (this.ownsLocation) {
        // Only wheel/touch/pointer/keyboard or another explicit destination can
        // relinquish this anchor. A scroll event itself is not user intent.
        this.windowDirty = true; this.schedule(); return;
      }
      // Geometry at the edge always re-arms follow, including a reader who
      // scrolls back without sending. Growth alone changes scrollHeight, not
      // scrollTop, so it never masquerades as departure.
      if (this.edgeGap() <= 2) {
        this.place.following = true;
        this.capture(); this.publish(); this.schedule();
        return;
      }
      // A downward input can reach the physical end just before mounting the
      // tail refines the virtual spacer. Re-arm against the geometry the input
      // actually reached, then place the newly measured end once.
      if (!this.place.following && moved && top > previousTop && Math.abs(previousHeight - viewport.clientHeight - top) <= 2) {
        this.place.following = true;
        this.windowDirty = true;
        this.restore(); this.capture(); this.publish(); this.schedule();
        return;
      }
      // Release only for a measured position change that was not one of our
      // writes. Resize/mutation scroll events with a stationary top stay owned
      // by the existing follow intent. A measured thumb drag wins even while
      // streaming changes the geometry in the same frame.
      if (this.place.following && (!moved || (geometryChanged && !dragged))) { this.windowDirty = true; this.schedule(); return; }
      markReading();
      this.place.following = false;
      this.capture(); this.publish(); this.schedule();
    };
    const user = (direction?: "up" | "down") => {
      if (direction === undefined || !this.canMove(direction)) return false;
      this.cancel(); this.arriving = false; this.expectedTop = undefined;
      // A deliberate movement settles whatever the clamp still owed.
      this.clampDebt = 0;
      this.place.following = false;
      this.stopDisclosureHold();
      markReading();
      this.publish();
      return true;
    };
    const selection = () => {
      const selected = document.getSelection();
      if (selected && !selected.isCollapsed && selected.anchorNode === this.content && selected.focusNode === this.content && this.ids.length) {
        this.selected = [this.ids[0]!, this.ids.at(-1)!]; this.publish(); return;
      }
      const id = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-window-message]")?.dataset.windowMessage;
      const start = id(selected?.anchorNode ?? null), end = id(selected?.focusNode ?? null);
      const a = start ? this.positions.get(start) : undefined, b = end ? this.positions.get(end) : undefined;
      if (!selected || selected.isCollapsed) this.selected = undefined;
      else if (a !== undefined && b !== undefined) this.selected = [start!, end!];
      else if (selected.rangeCount && this.content && selected.getRangeAt(0).intersectsNode(this.content)) {
        // A drag can end on a spacer/container boundary before the next window
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
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      const editsText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      const inComposer = target instanceof Element && target.closest('[data-slot="composer"]') !== null;
      const direction = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || ((event.key === " " || event.key === "Spacebar") && event.shiftKey)
        ? "up"
        : event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" || event.key === " " || event.key === "Spacebar"
          ? "down"
          : undefined;
      if (direction && !editsText && !inComposer) user(direction);
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
        requestAnimationFrame(() => { if (intent !== this.intent || !this.content) return; const range = document.createRange(); range.selectNodeContents(this.content); const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); });
      }
    };
    const pointer = (event: PointerEvent) => {
      // A click in the wide transcript gutter is not a scroll intent. Classic
      // scrollbars land outside clientWidth; overlay scrollbars occupy the edge
      // inside it, on either side according to writing direction.
      const unit = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-unit"));
      const overlayEdge = Number.isFinite(unit) ? unit * 3 : 0;
      const rtl = viewport.dir === "rtl" || getComputedStyle(viewport).direction === "rtl";
      const overScrollbar = event.offsetX < 0 || event.offsetX > viewport.clientWidth || (rtl ? event.offsetX <= overlayEdge : event.offsetX >= viewport.clientWidth - overlayEdge);
      if (event.target === viewport && viewport.scrollHeight > viewport.clientHeight && overScrollbar) {
        // A thumb click has no direction and is not intent by itself. Its first
        // measured movement releases follow, even while content is growing.
        scrollbarDrag = true; this.expectedTop = undefined; markReading();
      } else this.cancel();
    };
    const pointerEnd = () => { scrollbarDrag = false; };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) user("up");
      else if (event.deltaY > 0) user("down");
    };
    let touchY: number | undefined;
    const touchstart = (event: TouchEvent) => {
      user();
      touchY = event.touches?.[0]?.clientY;
    };
    const touchmove = (event: TouchEvent) => {
      const next = event.touches?.[0]?.clientY;
      if (next === undefined || touchY === undefined) return;
      const delta = next - touchY;
      touchY = next;
      if (Math.abs(delta) < 0.5) return;
      user(delta > 0 ? "up" : "down");
    };
    const touchend = () => { touchY = undefined; };
    const disclosure = (event: AnimationEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.matches('[data-slot="tool-group-content"], [data-slot="reasoning-content"]')) return;
      if (event.type === "animationstart") this.startDisclosureHold(target);
      else this.endDisclosureHold(target);
    };
    viewport.addEventListener("scroll", scroll, { passive: true });
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("touchstart", touchstart, { passive: true }); viewport.addEventListener("touchmove", touchmove, { passive: true }); viewport.addEventListener("touchend", touchend, { passive: true }); viewport.addEventListener("touchcancel", touchend, { passive: true });
    viewport.addEventListener("animationstart", disclosure); viewport.addEventListener("animationend", disclosure); viewport.addEventListener("animationcancel", disclosure);
    viewport.addEventListener("pointerdown", pointer, { passive: true });
    document.addEventListener("pointerup", pointerEnd, { passive: true }); document.addEventListener("pointercancel", pointerEnd, { passive: true });
    viewport.addEventListener("focusin", focus); viewport.addEventListener("focusout", focus); viewport.addEventListener("keydown", key);
    document.addEventListener("selectionchange", selection);
    const theme = new MutationObserver(this.schedule); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    document.fonts?.addEventListener("loadingdone", this.schedule);
    this.schedule();
    return () => {
      this.cancel(); this.disposed = true; this.releaseEarlierPage("unmount"); clearAnchoredMessages(this.path); cancelAnimationFrame(this.frame); this.frame = 0; this.stopDisclosureHold(); if (this.reading) { clearTimeout(this.reading); this.reading = undefined; }
      this.observer?.disconnect(); this.observer = undefined; this.mutation?.disconnect(); this.mutation = undefined; theme.disconnect();
      viewport.removeEventListener("scroll", scroll); viewport.removeEventListener("wheel", wheel); viewport.removeEventListener("touchstart", touchstart); viewport.removeEventListener("touchmove", touchmove); viewport.removeEventListener("touchend", touchend); viewport.removeEventListener("touchcancel", touchend);
      viewport.removeEventListener("animationstart", disclosure); viewport.removeEventListener("animationend", disclosure); viewport.removeEventListener("animationcancel", disclosure);
      viewport.removeEventListener("pointerdown", pointer);
      document.removeEventListener("pointerup", pointerEnd); document.removeEventListener("pointercancel", pointerEnd);
      viewport.removeEventListener("focusin", focus); viewport.removeEventListener("focusout", focus); viewport.removeEventListener("keydown", key);
      document.removeEventListener("selectionchange", selection); document.fonts?.removeEventListener("loadingdone", this.schedule);
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
  const paths = useLaserState(s => Object.keys(s.open).join("\0"));
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
  useLayoutEffect(() => { controller.retain(paths.split("\0")); }, [controller, paths]);
  return <Context value={controller}>{children}</Context>;
}
export function TranscriptViewportBinding() {
  const controller = useTranscriptViewport();
  const viewport = useThreadViewport(s => s.element.viewport);
  useLayoutEffect(() => viewport && controller ? controller.attach(viewport) : undefined, [controller, viewport]);
  return null;
}
export function WindowedMessages() {
  const controller = useTranscriptViewport();
  const ids = unstable_useThreadMessageIds();
  const userOffset = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.history?.userOffset ?? 0 : 0; });
  const before = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.history?.before : undefined; });
  const loadedUserTurns = useLaserState(s => { const path = visibleSessionPath(s); return path ? s.open[path]?.blocks.filter(block => block.kind === "user" && !block.optimistic).length ?? 0 : 0; });
  // Ids/heights must exist before unloaded-history geometry can become ready.
  controller.setIds(ids);
  controller.setHistoryWindow(userOffset, loadedUserTurns, before);
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const ranges = controller.ranges();
  useLayoutEffect(() => { controller.committed(); });
  // Arriving history is not something the person should have to watch. The
  // one visible sign is a page that is late — longer than a slow motion step
  // — while they are inside the estimated range, and it goes on arrival.
  const loading = controller.loadingEarlier;
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!loading) { setOverdue(false); return; }
    const timer = setTimeout(() => { if (controller.isReadingHistoryReserve()) setOverdue(true); }, motionMs("--motion-slow"));
    return () => clearTimeout(timer);
  }, [controller, loading]);
  let cursor = 0;
  return <div ref={node => { controller.setContent(node); }} data-slot="thread-messages" aria-busy={loading || undefined} className="flex flex-col pt-5 empty:hidden" style={{ overflowAnchor: "none" }}>
    <HistoryReserve height={controller.reserveHeight} overdue={overdue} />
    {ranges.flatMap(range => {
      const gap = controller.heights.offset(range.start) - controller.heights.offset(cursor); cursor = range.end;
      return [
        ...(gap > 0 ? [<div key={`gap:${range.start}`} aria-hidden="true" data-slot="transcript-spacer" style={{ height: gap, flexShrink: 0 }} />] : []),
        ...ids.slice(range.start, range.end).map(id => <WindowRow key={`${controller.path}:${id}`} id={id} controller={controller} />),
      ];
    })}
    {cursor < ids.length && <div aria-hidden="true" data-slot="transcript-spacer" style={{ height: controller.heights.total - controller.heights.offset(cursor), flexShrink: 0 }} />}
  </div>;
}
/**
 * Memoised on purpose. The window republishes whenever a row is measured, a
 * pin changes or the transcript grows — several times per streamed batch — and
 * every one of those rebuilt this list. A settled row's props (its id and this
 * surface's controller) do not change, so it must not re-render with the list:
 * its own message subscription is what tells it that its content moved.
 */
const WindowRow = memo(function WindowRow({ id, controller }: { id: string; controller: TranscriptViewport }) {
  const register = useRef<(node: HTMLDivElement | null) => void>(node => controller.register(id, node));
  return <div ref={register.current} data-window-message={id} className="pb-5 [&_[data-message-id]]:[content-visibility:visible]">
    <ThreadPrimitive.Unstable_MessageById messageId={id} components={COMPONENTS} />
  </div>;
});
