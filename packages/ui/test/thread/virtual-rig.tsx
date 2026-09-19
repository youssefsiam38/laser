/**
 * The transcript, mounted over a browser that lays it out (M16-T91).
 *
 * happy-dom lays nothing out, so this rig is the layout engine, and it is
 * deliberately the *browser's* half of the contract rather than the list's:
 * it never asks the list where anything is.
 *
 *   - the scroller is the list's own element, with a real `scrollTop` clamped
 *     to the content the last render produced, dispatching a `scroll` event
 *     after the stack that moved it, the way a browser does;
 *   - an element's box is walked from the DOM the list produced — a
 *     positioned container takes its inline `top`, everything else follows its
 *     preceding siblings — so a list that has run ahead of the DOM shows up
 *     here as it would on screen;
 *   - a row's height is the fixture's, whatever the list guessed, so a row
 *     that measures taller than its estimate is a real disagreement;
 *   - `ResizeObserver` deliveries happen after layout and before the next
 *     paint, in one place the test drives, so a growing row reaches the list
 *     exactly where a browser would deliver it.
 *
 * Everything above that line — the list, the controller, the header, the
 * placeholder, the rows — is the real thing.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";
import { initialState, type AppState } from "../../src/store.js";
import { TranscriptViewportProvider, WindowedMessages, useTranscriptViewport, type TranscriptViewport } from "../../src/components/thread/transcript-viewport.js";

export const PATH = "/project/session.jsonl";
/** One placeholder turn, as the stylesheet fixes it. */
export const TURN = 288;
const WIDTH = 600;

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
  /** The laid-out height of a row, whatever the list guessed. */
  height: (id: string) => number;
  clientHeight?: number;
  /** The history controls' own height inside the list's header. */
  headHeight?: number;
  history?: RigHistory;
  head?: ReactNode;
}

interface Layout {
  clientHeight: number;
  headHeight: number;
  height: (id: string) => number;
}

/** Observed elements and the size each one was last told about. */
interface FakeObserver { callback: ResizeObserverCallback; sizes: Map<Element, number> }
const observers = new Set<FakeObserver>();
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
/**
 * Installed once and never taken away. The list keeps one process-wide
 * `ResizeObserver` and hands every rig's elements to it, so a rig that
 * restored the original would leave the next one measuring nothing.
 */
function installResizeObserver() {
  if (globalThis.ResizeObserver === (FakeResizeObserver as unknown as typeof ResizeObserver)) return;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  if (typeof window !== "undefined") (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
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
  /** Replace the rows without waiting for the list to settle. */
  render(ids: readonly string[]): Promise<void>;
  /** Replace what the producer says about earlier history. */
  setHistory(history: RigHistory): Promise<void>;
  /**
   * A page of earlier history arriving: the rows and what the producer now
   * says about what is left, in one update. The store carries both, so a rig
   * that delivered them separately would be testing a commit the app never
   * makes.
   */
  page(ids: readonly string[], history: RigHistory): Promise<void>;
  /**
   * The header's own content changes height: a notice appearing or going, the
   * history control becoming a refusal, the loading state.
   */
  setHead(height: number): Promise<void>;
  /** Deliver pending resizes and let the list's frames run. */
  settle(rounds?: number): Promise<void>;
  /** Nobody has touched the scroller for a while. */
  idle(): Promise<void>;
  /** Scroll the way a person does: a gesture, then the browser's own move. */
  scrollBy(delta: number): Promise<void>;
  scrollTo(top: number): Promise<void>;
  scrollTop(): number;
  scrollHeight(): number;
  /** The rows the list has mounted, in order. */
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
  let clock = 0;
  const realNow = Date.now;
  const started = realNow();
  Date.now = () => started + clock;

  const slotOf = (node: Element) => (node instanceof HTMLElement ? node.dataset["slot"] : undefined);
  const isScroller = (node: Element) => node.firstElementChild?.classList.contains("legend-list-content-container") === true;
  const scroller = () => container.querySelector<HTMLElement>(".legend-list-content-container")?.parentElement ?? undefined;
  const content = () => container.querySelector<HTMLElement>(".legend-list-content-container") ?? undefined;
  const pixels = (value: string) => { const n = Number.parseFloat(value); return Number.isFinite(n) ? n : 0; };
  const absolute = (node: Element) => node instanceof HTMLElement && node.style.position === "absolute";

  /** A box the fixture knows outright, or nothing when it is a container. */
  const ownHeight = (node: HTMLElement): number | undefined => {
    if (isScroller(node)) return layout.clientHeight;
    const id = node.dataset["windowMessage"];
    if (id !== undefined) return heightOf(id);
    const slot = slotOf(node);
    if (slot === "rig-head") return layout.headHeight;
    if (slot === "history-reserve") return node.querySelectorAll('[data-slot="history-reserve-turn"]').length * TURN;
    if (slot === "transcript-inset") return pixels(node.style.height);
    return undefined;
  };
  const boxHeight = (node: HTMLElement): number => {
    const own = ownHeight(node);
    if (own !== undefined) return own;
    let total = 0;
    for (const child of node.children) if (!absolute(child)) total += boxHeight(child as HTMLElement);
    // The list's own container track carries its total size inline; its rows
    // are positioned out of flow inside it.
    if (total === 0 && node.style.height) return pixels(node.style.height);
    return total;
  };
  const contentHeight = () => {
    const node = content();
    if (!node) return 0;
    let total = 0;
    for (const child of node.children) if (!absolute(child)) total += boxHeight(child as HTMLElement);
    return total;
  };
  const scrollHeight = () => contentHeight();
  const maxTop = () => Math.max(0, scrollHeight() - layout.clientHeight);

  const install = () => {
    const proto = globalThis.Element.prototype as unknown as Record<string, unknown>;
    const html = globalThis.HTMLElement.prototype as unknown as Record<string, unknown>;
    const define = (name: string, descriptor: PropertyDescriptor) => {
      Object.defineProperty(proto, name, { configurable: true, ...descriptor });
      Object.defineProperty(html, name, { configurable: true, ...descriptor });
    };
    define("clientHeight", { get(this: Element) { return isScroller(this) ? layout.clientHeight : 0; } });
    define("clientWidth", { get(this: Element) { return isScroller(this) ? WIDTH : 0; } });
    define("scrollHeight", { get(this: Element) { return isScroller(this) || this === content() ? scrollHeight() : 0; } });
    define("scrollWidth", { get(this: Element) { return isScroller(this) || this === content() ? WIDTH : 0; } });
    define("scrollTop", {
      get(this: Element) { return isScroller(this) ? scrollTop : 0; },
      set(this: Element, value: number) {
        if (!isScroller(this)) return;
        const next = Math.min(Math.max(0, value), maxTop());
        const trace = (globalThis as { __rigTrace?: unknown[] }).__rigTrace;
        if (Array.isArray(trace)) trace.push({ want: value, next, max: maxTop(), from: scrollTop, stack: String(new Error().stack).split("\n").slice(1, 5).join(" <- ") });
        if (next === scrollTop) return;
        scrollTop = next;
        if (pendingScroll) return;
        pendingScroll = true;
        // A browser dispatches `scroll` after the stack that moved it, never
        // inside it: the list folds its own adjustment before the event.
        queueMicrotask(() => { pendingScroll = false; this.dispatchEvent(new Event("scroll")); });
      },
    });
    define("scrollTo", { value(this: HTMLElement, arg: { top?: number } | number) { this.scrollTop = typeof arg === "number" ? arg : arg?.top ?? this.scrollTop; } });
    define("scrollBy", { value(this: HTMLElement, arg: { top?: number } | number) { this.scrollTop += typeof arg === "number" ? arg : arg?.top ?? 0; } });
  };

  const originalRects = Element.prototype.getClientRects;
  const originalRect = Element.prototype.getBoundingClientRect;
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["clientHeight", "clientWidth", "scrollHeight", "scrollWidth", "scrollTop", "scrollTo", "scrollBy"]) {
    originalDescriptors.set(`Element.${name}`, Object.getOwnPropertyDescriptor(Element.prototype, name));
    originalDescriptors.set(`HTMLElement.${name}`, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  }
  install();

  Element.prototype.getClientRects = function rects(this: Element) {
    const rect = this.getBoundingClientRect();
    const list = rect.width || rect.height ? [rect] : [];
    return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    if (!(this instanceof HTMLElement)) return new DOMRect(0, 0, 0, 0);
    if (isScroller(this)) return new DOMRect(0, 0, WIDTH, layout.clientHeight);
    const node = content();
    if (!node || !node.contains(this)) return new DOMRect(0, 0, 0, 0);
    const chain: HTMLElement[] = [];
    for (let element: HTMLElement | null = this; element && element !== node; element = element.parentElement) chain.unshift(element);
    let top = -scrollTop;
    for (const element of chain) {
      if (absolute(element)) { top += pixels(element.style.top); continue; }
      for (const sibling of element.parentElement!.children) {
        if (sibling === element) break;
        if (!absolute(sibling)) top += boxHeight(sibling as HTMLElement);
      }
    }
    return new DOMRect(0, top, WIDTH, boxHeight(this));
  };

  installResizeObserver();

  /** Layout happened: tell every observer whose element changed size. */
  const deliver = () => {
    for (const observer of [...observers]) {
      const entries: ResizeObserverEntry[] = [];
      for (const [element, previous] of observer.sizes) {
        if (!(element instanceof HTMLElement)) continue;
        // A rig that has gone leaves its elements behind in the list's shared
        // observer. They are not on screen any more, so they have no size.
        if (!element.isConnected) { observer.sizes.delete(element); continue; }
        const height = boxHeight(element);
        if (height === previous) continue;
        observer.sizes.set(element, height);
        entries.push({ target: element, borderBoxSize: [{ blockSize: height, inlineSize: WIDTH }], contentRect: new DOMRect(0, 0, WIDTH, height) } as unknown as ResizeObserverEntry);
      }
      if (entries.length) observer.callback(entries, undefined as unknown as ResizeObserver);
    }
  };

  let controller!: TranscriptViewport;
  let ids = [...options.ids];
  let history = options.history;

  function Capture() {
    controller = useTranscriptViewport();
    return null;
  }

  const build = options.messages ?? ((list: readonly string[]) => list.map((id, index) => ({ id, role: index % 2 ? "assistant" : "user", content: id }) as ThreadMessageLike));

  function Fixture() {
    const runtime = useExternalStoreRuntime({ messages: build(ids), convertMessage: (message: ThreadMessageLike) => message, isRunning: options.running ?? false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}>{options.extras}<Capture />
      <WindowedMessages head={<><div data-slot="rig-head" />{options.head}</>} />
    </AssistantRuntimeProvider>;
  }

  function App() {
    return <TranscriptViewportProvider><Fixture /></TranscriptViewportProvider>;
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
  const apply = () => { snapshot = state(history, ids); for (const listener of [...listeners]) listener(); render(); };

  const frames = async (count: number) => {
    for (let i = 0; i < count; i++) {
      // A frame is sixteen milliseconds of the person's time. The list dates
      // some of its own bookkeeping, so a rig whose clock never moves would
      // hand it a browser where a whole reading session happens inside one
      // instant — which is the one thing a browser never does.
      clock += 16;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  };
  const settle = async (rounds = 3) => {
    for (let round = 0; round < rounds; round++) {
      clock += 100;
      await act(async () => { deliver(); await frames(2); });
    }
  };
  await act(async () => { render(); });
  await settle(6);

  return {
    get controller() { return controller; },
    get viewport() { return scroller()!; },
    container,
    async setIds(next) { ids = [...next]; await act(async () => { apply(); }); await settle(); },
    async render(next) { ids = [...next]; await act(async () => { apply(); }); },
    async setHistory(next) { history = next; await act(async () => { apply(); }); await settle(); },
    async page(next, nextHistory) { ids = [...next]; history = nextHistory; await act(async () => { apply(); }); await settle(); },
    async setHead(height) { layout.headHeight = height; await settle(2); },
    settle,
    async idle() {
      await act(async () => { clock += 500; await new Promise<void>(resolve => setTimeout(resolve, 250)); });
      await settle(2);
    },
    async scrollBy(delta) {
      await act(async () => {
        const node = scroller()!;
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: delta }));
        node.scrollTop = scrollTop + delta;
        await frames(1);
      });
      await settle(1);
    },
    async scrollTo(top) {
      await act(async () => {
        const node = scroller()!;
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: top - scrollTop }));
        node.scrollTop = top;
        await frames(1);
      });
      await settle(1);
    },
    scrollTop: () => scrollTop,
    scrollHeight,
    // In the order the person sees them. The list only sorts its containers
    // back into index order on a debounce, so the DOM's own order is not the
    // reading order between one change and the next.
    mounted: () => [...container.querySelectorAll<HTMLElement>("[data-window-message]")]
      .map(node => ({ id: node.dataset["windowMessage"]!, top: node.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)
      .map(row => row.id),
    screenTop(id) {
      const node = container.querySelector<HTMLElement>(`[data-window-message="${id}"]`);
      return node ? node.getBoundingClientRect().top : undefined;
    },
    node: (id) => container.querySelector<HTMLElement>(`[data-window-message="${id}"]`) ?? undefined,
    topVisible() {
      const rows = [...container.querySelectorAll<HTMLElement>("[data-window-message]")]
        .map(node => ({ id: node.dataset["windowMessage"]!, rect: node.getBoundingClientRect() }))
        .sort((a, b) => a.rect.top - b.rect.top);
      for (const row of rows) if (row.rect.bottom > 0 && row.rect.top < layout.clientHeight) return row.id;
      return undefined;
    },
    placeholderTurns: () => container.querySelectorAll('[data-slot="history-reserve-turn"]').length,
    async grow(id, height) { heights.set(id, height); await settle(2); },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
      Element.prototype.getBoundingClientRect = originalRect;
      Element.prototype.getClientRects = originalRects;
      for (const [key, descriptor] of originalDescriptors) {
        const [owner, name] = key.split(".") as [string, string];
        const target = owner === "Element" ? Element.prototype : HTMLElement.prototype;
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete (target as unknown as Record<string, unknown>)[name];
      }
      Date.now = realNow;
    },
  };
}
