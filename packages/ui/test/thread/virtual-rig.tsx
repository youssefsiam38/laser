/**
 * The transcript, mounted over a browser that lays it out (M16-T87).
 *
 * happy-dom lays nothing out, so this rig is the layout engine, and it is
 * deliberately the *browser's* half of the contract rather than the
 * controller's: it never asks the virtualizer where anything is.
 *
 *   - the scroller is a real element with a real `scrollTop`, clamped to the
 *     content the last render produced, and it dispatches a `scroll` event
 *     after the stack that moved it, the way a browser does;
 *   - an item's position is the one React rendered (its inline `top`), never
 *     the one the model holds now, so a model that has run ahead of the DOM
 *     shows up here as it would on screen;
 *   - an item's height is the fixture's, whatever the model guessed, so a row
 *     that measures taller than its estimate is a real disagreement;
 *   - `ResizeObserver` deliveries happen after layout and before the next
 *     paint, in one place the test drives, so a growing row reaches the engine
 *     exactly where a browser would deliver it.
 *
 * Everything above that line — the engine, the controller, the head, the
 * placeholder, the rows — is the real thing.
 */
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";
import { initialState, type AppState } from "../../src/store.js";
import { TranscriptViewportProvider, WindowedMessages, useTranscriptViewport, type TranscriptViewport } from "../../src/components/thread/transcript-viewport.js";

export const PATH = "/project/session.jsonl";
/** One placeholder turn, as the stylesheet fixes it. */
export const TURN = 288;

export interface RigHistory {
  before?: string | undefined;
  userOffset?: number;
}

export interface RigOptions {
  ids: readonly string[];
  /** The rows themselves, when a test needs more than a labelled box. */
  messages?: (ids: readonly string[]) => ThreadMessageLike[];
  /** A turn is in flight. */
  running?: boolean;
  /** Anything that must live beside the transcript, inside its providers. */
  extras?: ReactNode;
  /** The laid-out height of a row, whatever the model guessed. */
  height: (id: string) => number;
  clientHeight?: number;
  /** Whatever the app draws above the transcript inside the same scroller. */
  above?: number;
  /** The history controls' own height inside the head item. */
  headHeight?: number;
  history?: RigHistory;
  head?: ReactNode;
}

interface Layout {
  clientHeight: number;
  above: number;
  headHeight: number;
  height: (id: string) => number;
}

/** Observed elements and the size each one was last told about. */
interface FakeObserver { callback: ResizeObserverCallback; sizes: Map<Element, number> }
const observers = new Set<FakeObserver>();

function itemOf(element: Element): HTMLElement | undefined {
  const item = element.closest<HTMLElement>("[data-index]");
  return item ?? undefined;
}

function state(history: RigHistory | undefined, ids: readonly string[]): AppState {
  return {
    ...initialState,
    current: PATH,
    open: {
      [PATH]: {
        path: PATH,
        blocks: ids.map(id => ({ kind: "user", id, optimistic: false })),
        history: history ? { userOffset: history.userOffset ?? 0, ...(history.before !== undefined ? { before: history.before } : {}) } : undefined,
      },
    },
  } as unknown as AppState;
}

export interface Rig {
  controller: TranscriptViewport;
  viewport: HTMLElement;
  container: HTMLElement;
  /** Replace the conversation; ids only, heights come from the fixture. */
  setIds(ids: readonly string[]): Promise<void>;
  /** Replace the rows without waiting for the engine to settle. */
  render(ids: readonly string[]): Promise<void>;
  /** Replace what the producer says about earlier history. */
  setHistory(history: RigHistory): Promise<void>;
  /**
   * The head's own content changes height: a notice appearing or going, the
   * history control becoming a refusal, the loading state.
   */
  setHead(height: number): Promise<void>;
  /** Deliver pending resizes and let the engine's frames run. */
  settle(rounds?: number): Promise<void>;
  /**
   * Nobody has touched the scroller for a while: the engine's own
   * "is scrolling" window has expired, the way it does when a person stops.
   */
  idle(): Promise<void>;
  /** Scroll the way a person does: a gesture, then the browser's own move. */
  scrollBy(delta: number): Promise<void>;
  scrollTo(top: number): Promise<void>;
  scrollTop(): number;
  scrollHeight(): number;
  /** The rows the engine has mounted, in order. */
  mounted(): string[];
  /** Where a mounted row sits on screen, or nothing when it is not mounted. */
  screenTop(id: string): number | undefined;
  node(id: string): HTMLElement | undefined;
  /** The first mounted row whose box is inside the viewport. */
  topVisible(): string | undefined;
  placeholderTurns(): number;
  /** Grow a row under the reader: an image decoding, a disclosure opening. */
  grow(id: string, height: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function mountRig(options: RigOptions): Promise<Rig> {
  const layout: Layout = {
    clientHeight: options.clientHeight ?? 900,
    above: options.above ?? 0,
    headHeight: options.headHeight ?? 0,
    height: options.height,
  };
  const heights = new Map<string, number>();
  const heightOf = (id: string) => heights.get(id) ?? layout.height(id);

  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);

  let scrollTop = 0;
  let pendingScroll = false;
  // The scroller is rendered by React, with the transcript inside it, because
  // focus, keys and selection all depend on that containment being real.
  let viewport: HTMLElement | undefined;

  const messages = () => container.querySelector<HTMLElement>('[data-slot="thread-messages"]') ?? undefined;
  const contentHeight = () => {
    const node = messages();
    const height = node ? Number.parseFloat(node.style.height) : 0;
    return Number.isFinite(height) ? height : 0;
  };
  const scrollHeight = () => layout.above + contentHeight();
  const maxTop = () => Math.max(0, scrollHeight() - layout.clientHeight);
  const fakeHeight = (element: Element): number => {
    const item = element as HTMLElement;
    const id = item.dataset?.["windowMessage"];
    if (id !== undefined) return heightOf(id);
    if (item.dataset?.["slot"] === "transcript-head") {
      return layout.headHeight + item.querySelectorAll('[data-slot="history-reserve-turn"]').length * TURN;
    }
    if (item === viewport) return layout.clientHeight;
    if (item.dataset?.["slot"] === "thread-messages") return contentHeight();
    return 0;
  };
  const install = (node: HTMLElement) => {
    viewport = node;
    Object.defineProperties(node, {
      clientHeight: { value: layout.clientHeight },
      clientWidth: { value: 600 },
      scrollHeight: { get: scrollHeight },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          const next = Math.min(Math.max(0, value), maxTop());
          if (next === scrollTop) return;
          scrollTop = next;
          if (pendingScroll) return;
          pendingScroll = true;
          // A browser dispatches `scroll` after the stack that moved it, never
          // inside it: the engine folds its own adjustment before the event.
          queueMicrotask(() => { pendingScroll = false; node.dispatchEvent(new Event("scroll")); });
        },
      },
      scrollTo: { value: (arg: { top?: number } | number) => { node.scrollTop = typeof arg === "number" ? arg : arg?.top ?? scrollTop; } },
    });
  };

  const originalRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function rects(this: Element) {
    const rect = this.getBoundingClientRect();
    const list = rect.width || rect.height ? [rect] : [];
    return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList;
  };
  const originalRect = Element.prototype.getBoundingClientRect;
  const itemTop = (item: HTMLElement) => layout.above + (Number.parseFloat(item.style.top) || 0) - scrollTop;
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    if (this === viewport) return new DOMRect(0, 0, 600, layout.clientHeight);
    const content = messages();
    if (this === content) return new DOMRect(0, layout.above - scrollTop, 600, contentHeight());
    // The placeholder region is inside the head item but is not the head: it
    // starts below whatever the head's own content is, and the controller asks
    // it where it is. Resolving it to its item's box would hide exactly the
    // offset a real history control introduces.
    const region = this instanceof HTMLElement && this.dataset["slot"] === "history-reserve" ? this : undefined;
    if (region) {
      const head = itemOf(region);
      const turns = region.querySelectorAll('[data-slot="history-reserve-turn"]').length;
      return new DOMRect(0, (head ? itemTop(head) : 0) + layout.headHeight, 600, turns * TURN);
    }
    const item = itemOf(this);
    if (item) return new DOMRect(0, itemTop(item), 600, fakeHeight(item));
    return new DOMRect(0, 0, 0, 0);
  };

  class FakeResizeObserver {
    private entry: FakeObserver;
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, sizes: new Map() };
      observers.add(this.entry);
    }
    observe(element: Element) { if (!this.entry.sizes.has(element)) this.entry.sizes.set(element, Number.NaN); }
    unobserve(element: Element) { this.entry.sizes.delete(element); }
    disconnect() { this.entry.sizes.clear(); observers.delete(this.entry); }
  }
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  if (typeof window !== "undefined") (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

  /** Layout happened: tell every observer whose element changed size. */
  const deliver = () => {
    for (const observer of [...observers]) {
      const entries: ResizeObserverEntry[] = [];
      for (const [element, previous] of observer.sizes) {
        const height = element === viewport ? layout.clientHeight : fakeHeight(element);
        if (height === previous) continue;
        observer.sizes.set(element, height);
        entries.push({ target: element, borderBoxSize: [{ blockSize: height, inlineSize: 600 }], contentRect: new DOMRect(0, 0, 600, height) } as unknown as ResizeObserverEntry);
      }
      if (entries.length) observer.callback(entries, undefined as unknown as ResizeObserver);
    }
  };

  let controller!: TranscriptViewport;
  let ids = [...options.ids];
  let history = options.history;
  let apply!: () => void;

  function Scroller({ children }: { children: ReactNode }) {
    const transcript = useTranscriptViewport();
    const attached = useRef(false);
    useLayoutEffect(() => {
      if (attached.current || !viewport) return;
      attached.current = true;
      return transcript.attach(viewport);
    }, [transcript]);
    // The ref runs before any layout effect, so the scroller behaves like a
    // scroller from the first commit the engine ever sees.
    return <div ref={node => { if (node && !viewport) install(node); }} data-slot="thread-viewport">
      <div style={{ height: layout.above }} />
      {children}
    </div>;
  }

  function Capture() {
    controller = useTranscriptViewport();
    return null;
  }

  const build = options.messages ?? ((list: readonly string[]) => list.map((id, index) => ({ id, role: index % 2 ? "assistant" : "user", content: id }) as ThreadMessageLike));

  function Fixture() {
    const runtime = useExternalStoreRuntime({ messages: build(ids), convertMessage: (message: ThreadMessageLike) => message, isRunning: options.running ?? false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}>{options.extras}<WindowedMessages head={options.head} /></AssistantRuntimeProvider>;
  }

  function App() {
    return <TranscriptViewportProvider><Capture /><Scroller><Fixture /></Scroller></TranscriptViewportProvider>;
  }

  // The store is the smallest thing `useLaserState` needs: this rig feeds it
  // what the producer would say about the conversation, nothing else.
  let snapshot = state(history, ids);
  const listeners = new Set<() => void>();
  const store: StateStore = {
    presentation: new TranscriptPresentation(),
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch() {},
  };
  const render = () => root.render(<LaserStoreProvider store={store}><App /></LaserStoreProvider>);
  apply = () => { snapshot = state(history, ids); for (const listener of [...listeners]) listener(); render(); };

  const frames = async (count: number) => {
    for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  };
  const settle = async (rounds = 3) => {
    for (let round = 0; round < rounds; round++) {
      await act(async () => { deliver(); await frames(2); });
    }
  };
  await act(async () => { render(); });
  await settle(4);

  return {
    get controller() { return controller; },
    get viewport() { return viewport!; },
    container,
    async setIds(next) { ids = [...next]; await act(async () => { apply(); }); await settle(); },
    async render(next) { ids = [...next]; await act(async () => { apply(); }); },
    async setHistory(next) { history = next; await act(async () => { apply(); }); await settle(); },
    async setHead(height) { layout.headHeight = height; await settle(2); },
    settle,
    async idle() {
      await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 200)); });
      await settle(2);
    },
    async scrollBy(delta) {
      await act(async () => {
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: delta }));
        viewport.scrollTop = scrollTop + delta;
        await frames(1);
      });
      await settle(1);
    },
    async scrollTo(top) {
      await act(async () => {
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: top - scrollTop }));
        viewport.scrollTop = top;
        await frames(1);
      });
      await settle(1);
    },
    scrollTop: () => scrollTop,
    scrollHeight,
    mounted: () => [...container.querySelectorAll<HTMLElement>("[data-window-message]")].map(node => node.dataset["windowMessage"]!),
    screenTop(id) {
      const node = container.querySelector<HTMLElement>(`[data-window-message="${id}"]`);
      return node ? node.getBoundingClientRect().top : undefined;
    },
    node: (id) => container.querySelector<HTMLElement>(`[data-window-message="${id}"]`) ?? undefined,
    topVisible() {
      for (const node of container.querySelectorAll<HTMLElement>("[data-window-message]")) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < layout.clientHeight) return node.dataset["windowMessage"];
      }
      return undefined;
    },
    placeholderTurns: () => container.querySelectorAll('[data-slot="history-reserve-turn"]').length,
    async grow(id, height) { heights.set(id, height); await settle(2); },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
      Element.prototype.getBoundingClientRect = originalRect;
      Element.prototype.getClientRects = originalRects;
      globalThis.ResizeObserver = originalObserver;
      if (typeof window !== "undefined") (window as unknown as { ResizeObserver: unknown }).ResizeObserver = originalObserver;
      observers.clear();
    },
  };
}
