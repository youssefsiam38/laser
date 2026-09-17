import { ThreadPrimitive, useAuiState, useThreadViewport, unstable_useThreadMessageIds } from "@assistant-ui/react";
import { createContext, memo, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLaserState, visibleSessionPath } from "@/runtime";
import { activityDetailLevel } from "@/runtime/sessionPreferences";
import { motionMs } from "@/motion";
import { HeightIndex, windowRanges } from "./transcript-window.js";
import { clearAnchoredMessages, setAnchoredMessages, setAtLiveEdge, setStandingRows } from "@/runtime/anchored-messages";
import { ThreadMessage } from "./messages.js";

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
  private tail: (() => void) | undefined;
  private expectedTop: number | undefined;
  /** Appended rows or row growth whose native scroll events belong to following. */
  private followingGrowth = false;
  /** Movement of the anchor caused by a list change that has rendered but not painted. */
  private structuralShift: number | undefined;
  /** The person is moving the viewport right now; layout may shift it, never re-place it. */
  private reading: ReturnType<typeof setTimeout> | undefined;
  private running = false;
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
        if (this.place.following) this.arriving = true;
        this.schedule();
      }
      return;
    }
    const leftRevision = this.loaded;
    this.loaded = loaded;
    this.running = false;
    this.expectedTop = undefined;
    this.followingGrowth = false;
    this.cancel();
    if (this.path) {
      this.places.set(this.path, { ...this.place, revision: leftRevision });
      // The conversation this surface has left stands on nothing: its ids go
      // with it, so they neither protect its rows from a trim nor linger.
      clearAnchoredMessages(this.path);
    }
    this.path = path;
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
    if (this.place.following && previous.length > 0 && ids.length > previous.length && previous.every((id, index) => ids[index] === id)) this.followingGrowth = true;
    // Where the person's anchor sits before the list changes under it. Rows
    // inserted above it (an earlier page) move it by their estimated height;
    // the viewport must move by exactly that before the next paint, or the
    // reader is left looking at the top of the page that just arrived while
    // the section they were reading is now a page further down. Later
    // measurements refine estimates by their delta, as they already do.
    const anchor = !this.place.following ? this.place.anchor : undefined;
    const anchorIndex = anchor ? this.positions.get(anchor.messageId) : undefined;
    const anchorBefore = anchorIndex !== undefined ? this.heights.offset(anchorIndex) : undefined;
    this.ids = ids;
    this.positions = new Map(ids.map((id, i) => [id, i]));
    this.rebuild();
    if (anchor && anchorBefore !== undefined) {
      const index = this.positions.get(anchor.messageId);
      const shift = index === undefined ? 0 : this.heights.offset(index) - anchorBefore;
      if (Math.abs(shift) >= 0.5) this.structuralShift = (this.structuralShift ?? 0) + shift;
    }
    // A branch replacement cancels a pending destination; appends/prepends do not.
    if (previous.length && previous.some(id => !this.positions.has(id))) this.cancel("structure");
  }
  private rebuild() { this.heights = new HeightIndex(this.ids.map(id => this.measured.get(this.cacheKey(id)) ?? this.estimate)); }
  private top() {
    if (!this.viewport || !this.content) return 0;
    return this.viewport.getBoundingClientRect().top - this.content.getBoundingClientRect().top;
  }
  ranges() {
    const height = this.viewport?.clientHeight || window.innerHeight;
    let top = this.top();
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
  private scroll(top: number) {
    if (!this.viewport) return;
    this.viewport.scrollTop = top;
    this.expectedTop = this.viewport.scrollTop;
  }
  capture = (): Place => {
    const viewport = this.viewport;
    if (!viewport) return this.place;
    const top = viewport.getBoundingClientRect().top;
    const row = [...this.nodes.entries()].sort((a, b) => (this.positions.get(a[0]) ?? 0) - (this.positions.get(b[0]) ?? 0))
      .find(([, node]) => node.getBoundingClientRect().bottom > top);
    if (!row || row[1].getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom) {
      const index = this.heights.at(this.top());
      const messageId = this.ids[index];
      if (messageId) { const offset = this.heights.offset(index) - this.top(); this.place = { following: this.place.following, anchor: { messageId, offset, messageOffset: offset } }; }
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
    if (!viewport || this.target) return;
    if (this.place.following) {
      if (Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 0.5) {
        this.arriving = false;
        // Keep ownership through every native scroll caused by one layout
        // batch. The first event clears expectedTop; the measured bottom then
        // proves that batch has settled.
        if (this.followingGrowth && this.expectedTop === undefined) this.followingGrowth = false;
      } else {
        // The primitive's tail event also focuses its composer. Passive layout
        // correction must not steal an active find field, menu, or question.
        const focused = document.activeElement;
        this.tail?.();
        // assistant-ui's action may decline when its own sticky-state snapshot
        // still says the reader is in history. This controller has already
        // accepted latest as the destination, so place the native viewport too.
        this.scroll(Math.max(0, viewport.scrollHeight - viewport.clientHeight));
        if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
      }
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
      if (index !== undefined) { this.scroll(viewport.scrollTop + this.heights.offset(index) - this.top() - anchor.messageOffset); return; }
      // The transcript this place belonged to is not loaded here any more —
      // a reloaded recent tail, or a branch that dropped the message. Latest
      // is the honest answer; the top of an arbitrary window is not.
      this.place = { following: true };
      this.arriving = true;
      this.tail?.();
      this.expectedTop = viewport.scrollTop;
      return;
    }
    const mark = anchor.toolCallId ? row.querySelector<HTMLElement>(`[data-tool-call="${CSS.escape(anchor.toolCallId)}"] ${LANDMARKS.split(",").at(-1)!.trim()}`)
      : anchor.landmark === undefined ? undefined : row.querySelectorAll<HTMLElement>(LANDMARKS)[anchor.landmark];
    const live = mark && mark.getBoundingClientRect().height > 0 ? mark : row;
    this.scroll(viewport.scrollTop + live.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (live === row ? anchor.messageOffset : anchor.offset));
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
    this.signature = signature; this.rebuild(); return true;
  }
  private measure = () => {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.disposed) return;
    let changed = this.layout();
    // Where the anchor sits before this pass. When measured rows replace
    // estimates above it, the person must not feel it: shift by exactly what
    // changed above the anchor, never re-place it from a fresh absolute.
    const anchorIndex = !this.place.following && this.place.anchor ? this.positions.get(this.place.anchor.messageId) : undefined;
    const anchorBefore = anchorIndex !== undefined ? this.heights.offset(anchorIndex) : undefined;
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
    // A global measurement budget, including layouts and previously visited sessions.
    while (this.measured.size > 20_000) this.measured.delete(this.measured.keys().next().value!);
    if (changed || this.windowDirty) {
      this.windowDirty = false;
      const mounted = this.reading && anchorIndex !== undefined && anchorBefore !== undefined && this.viewport && !this.target && this.nodes.has(this.place.anchor!.messageId);
      if (mounted) {
        const shift = this.heights.offset(anchorIndex) - anchorBefore;
        if (Math.abs(shift) >= 0.5) this.scroll(this.viewport!.scrollTop + shift);
      } else this.restore();
      this.publish();
    }
    this.capture();
  };
  schedule = () => { if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(this.measure); };
  committed() {
    if (this.layout()) this.windowDirty = true;
    const shift = this.structuralShift;
    this.structuralShift = undefined;
    // Rows arrived above the anchor in this commit: move by what they take up
    // now, before anyone sees the frame. `measure` refines that estimate; an
    // absolute `restore` is safe only after active input has settled.
    if (shift !== undefined && this.viewport && !this.target) this.scroll(this.viewport.scrollTop + shift);
    // Browser default scrolling updates scrollTop before its scroll event lets
    // capture() move the anchor. A layout commit can land in that gap. Never
    // restore the stale mounted anchor over active wheel/touch/key movement;
    // structural and measured-height deltas above are the only safe changes.
    if (!this.reading || this.place.following) this.restore();
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
      if (!row) { this.scroll(viewport.scrollTop + this.heights.offset(this.positions.get(target.messageId)!) - this.top()); this.publish(); continue; }
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
  followRun(running: boolean) {
    this.running = running;
    // Starting elsewhere is output, not this reader's navigation intent. The
    // local composer's submit calls `latest()`; once chosen, streamed growth
    // follows until explicit input changes `following` to false.
    if (running && this.place.following) {
      this.windowDirty = true;
      this.restore();
      this.schedule();
    }
  }
  latest = () => {
    this.cancel(); this.place.following = true; this.publish(); this.tail?.();
    if (this.viewport) this.scroll(Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight));
    // The first streamed delta can grow the row before the native event for
    // this tail scroll arrives. Keep that event owned even if its scrollTop is
    // already a few pixels behind the new scrollHeight.
    this.expectedTop = this.viewport?.scrollTop;
    this.schedule();
  };
  attach(viewport: HTMLElement, tail: () => void) {
    this.disposed = false; this.viewport = viewport; this.tail = tail;
    this.observer = new ResizeObserver(entries => {
      // A settled message can grow after `isRunning` became false (batched
      // blocks, markdown, an image). It is still output, not reader intent.
      // Resizing the viewport itself is not transcript growth.
      if (this.place.following && entries.some(entry => entry.target !== this.viewport)) this.followingGrowth = true;
      this.schedule();
    });
    this.observer.observe(viewport);
    for (const node of this.nodes.values()) this.observer.observe(node);
    const markReading = () => {
      if (this.reading) clearTimeout(this.reading);
      this.reading = setTimeout(() => { this.reading = undefined; this.schedule(); }, 400);
    };
    const scroll = () => {
      if (this.place.following && (this.running || this.expectedTop !== undefined || this.followingGrowth)) {
        // scrollToBottom can emit more than one delayed scroll while a streamed
        // row grows. Explicit wheel/touch/key/scrollbar input clears following
        // first; without that input, every scroll during the followed run is
        // still ours even after an earlier event consumed expectedTop.
        this.expectedTop = undefined;
        this.windowDirty = true;
        this.schedule();
        return;
      }
      if (this.expectedTop !== undefined && Math.abs(viewport.scrollTop - this.expectedTop) < 0.5) {
        this.expectedTop = undefined;
        return;
      }
      if (this.arriving) { this.place.following = true; this.windowDirty = true; this.schedule(); return; }
      if (this.ownsLocation) {
        // Only wheel/touch/pointer/keyboard or another explicit destination can
        // relinquish this anchor. A scroll event itself is not user intent.
        this.windowDirty = true; this.schedule(); return;
      }
      // Native scrolls also carry touch momentum, scrollbar drags, Space and
      // keys focused inside a row. Programmatic corrections returned above via
      // expectedTop; keep every other scroll authoritative through its next
      // default-scroll → scroll-event gap.
      markReading();
      this.place.following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
      this.capture(); this.publish(); this.schedule();
    };
    const user = () => {
      this.cancel(); this.arriving = false; this.place.following = false; this.expectedTop = undefined; this.followingGrowth = false;
      markReading();
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
      this.cancel();
      const target = event.target;
      const editsText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      const inComposer = target instanceof Element && target.closest('[data-slot="composer"]') !== null;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"].includes(event.key) && !editsText && !inComposer) user();
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
      if (event.target === viewport && viewport.scrollHeight > viewport.clientHeight && overScrollbar) user();
      else this.cancel();
    };
    viewport.addEventListener("scroll", scroll, { passive: true });
    viewport.addEventListener("wheel", user, { passive: true }); viewport.addEventListener("touchstart", user, { passive: true });
    viewport.addEventListener("pointerdown", pointer, { passive: true });
    viewport.addEventListener("focusin", focus); viewport.addEventListener("focusout", focus); viewport.addEventListener("keydown", key);
    document.addEventListener("selectionchange", selection);
    const theme = new MutationObserver(this.schedule); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    document.fonts?.addEventListener("loadingdone", this.schedule);
    this.schedule();
    return () => {
      this.cancel(); this.disposed = true; clearAnchoredMessages(this.path); cancelAnimationFrame(this.frame); this.frame = 0; if (this.reading) { clearTimeout(this.reading); this.reading = undefined; }
      this.observer?.disconnect(); this.observer = undefined; theme.disconnect();
      viewport.removeEventListener("scroll", scroll); viewport.removeEventListener("wheel", user); viewport.removeEventListener("touchstart", user);
      viewport.removeEventListener("pointerdown", pointer);
      viewport.removeEventListener("focusin", focus); viewport.removeEventListener("focusout", focus); viewport.removeEventListener("keydown", key);
      document.removeEventListener("selectionchange", selection); document.fonts?.removeEventListener("loadingdone", this.schedule);
      this.viewport = undefined; this.tail = undefined;
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
  const tail = useThreadViewport(s => s.scrollToBottom);
  useLayoutEffect(() => viewport && controller ? controller.attach(viewport, () => tail({ behavior: "auto" })) : undefined, [controller, viewport, tail]);
  return null;
}
export function WindowedMessages() {
  const controller = useTranscriptViewport();
  const ids = unstable_useThreadMessageIds();
  const running = useAuiState(s => s.thread.isRunning);
  controller.setIds(ids);
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const ranges = controller.ranges();
  useLayoutEffect(() => { controller.followRun(running); }, [controller, running, controller.path]);
  useLayoutEffect(() => { controller.committed(); });
  let cursor = 0;
  return <div ref={node => { controller.content = node ?? undefined; }} data-slot="thread-messages" className="flex flex-col pt-5 empty:hidden" style={{ overflowAnchor: "none" }}>
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
