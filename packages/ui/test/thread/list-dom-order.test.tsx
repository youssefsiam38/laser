// @vitest-environment happy-dom
/**
 * The list's own DOM-order pass, and what a person is holding while it runs.
 *
 * `@legendapp/list` sorts its row containers back into index order on a 500 ms
 * debounce (`useDOMOrder`). Where `Element.moveBefore` exists the move keeps the
 * subtree's state; where it does not — Safari, and every test DOM — an insert is
 * a removal and an insertion, so the browser blurs whatever had focus inside the
 * moved row and collapses a selection with an endpoint in it. The
 * `moveChildBefore` hunk of `patches/@legendapp__list@3.3.5.patch` holds focus, caret and selection across
 * that fallback, for the moved subtree only.
 *
 * Every case here drives the list's pass at its own boundary — faked
 * `setTimeout`/`clearTimeout`, advanced by exactly the debounce — and asserts
 * that the pass really did re-sort the containers, so nothing here can pass by
 * doing nothing. Two behaviours cannot be produced by happy-dom and are named
 * as proxies where they are used: it fires no `blur`/`focusout` when a focused
 * node is removed, and it does not apply the DOM's range mutation on removal.
 * The real-engine acceptance for both is the person's, on an iPhone.
 */
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import { LaserStoreProvider, createStateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { TranscriptViewport, TranscriptViewportBinding, TranscriptViewportProvider, WindowedMessages, useTranscriptViewport } from "../../src/components/thread/transcript-viewport.js";
import { resetAnchoredMessages } from "../../src/runtime/anchored-messages.js";
import { sessionState } from "../agents/fixtures.js";
import { LIST_DOM_ORDER_DEBOUNCE_MS } from "./list-dom-order.js";

const SESSION = "/project/session.jsonl";
const LINE = 24;
const ROW = LINE * 4;

const stable = vi.hoisted(() => ({
  client: { request: vi.fn(async () => ({})) },
  actions: {
    listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn(),
    loadEarlierEntries: vi.fn(async () => ({ accepted: false, bytes: 0 })),
    rereadHistory: vi.fn(async () => {}),
  },
}));
vi.mock("@/runtime", async original => ({
  ...await original<typeof import("../../src/runtime/index.js")>(),
  useLaserStable: () => stable,
  useWholeTranscriptRefusal: () => ({ paused: false, explanation: undefined }),
  useActivityDetailLevel: () => "everything",
}));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));

let root: Root;
let container: HTMLDivElement;
let restoreGeometry: (() => void) | undefined;
let prefetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let scrolled = 0;

/** The list's own container track: the box every row is positioned inside. */
function track(): HTMLElement {
  const content = container.querySelector<HTMLElement>(".legend-list-content-container");
  return [...(content?.children ?? [])].find(node => (node as HTMLElement).style.height) as HTMLElement
    ?? content as HTMLElement;
}

/** The one stub: happy-dom lays nothing out, so a row is where the list put it. */
function stubGeometry(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset?.slot === "thread-viewport") return 900;
      return originalClientHeight?.get?.call(this) ?? 0;
    },
  });
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    if ((this as HTMLElement).dataset?.slot === "thread-viewport") {
      return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 900, width: 600, height: 900, toJSON: () => ({}) } as DOMRect;
    }
    const top = (node: number) => node - scrolled;
    const messages = track();
    if (this === messages) {
      const height = Number.parseFloat(messages.style.height) || 0;
      return { x: 0, y: top(0), top: top(0), left: 0, right: 600, bottom: top(height), width: 600, height, toJSON: () => ({}) } as DOMRect;
    }
    const row = (this.closest?.("[data-window-message]") ?? this.querySelector?.("[data-window-message]")) as HTMLElement | null;
    const item = row?.parentElement;
    if (!item) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    const start = top(Number.parseFloat(item.style.top) || 0);
    return { x: 0, y: start, top: start, left: 0, right: 600, bottom: start + ROW, width: 600, height: ROW, toJSON: () => ({}) } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  resetAnchoredMessages();
  scrolled = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  restoreGeometry = stubGeometry();
  prefetchSpy = vi.spyOn(TranscriptViewport.prototype, "needsPrefetch").mockReturnValue(false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
  restoreGeometry?.();
  resetAnchoredMessages();
  prefetchSpy?.mockRestore();
  prefetchSpy = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

const entry = (index: number) => ({
  id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, type: "message",
  message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${index === 0 ? "first prompt" : `turn ${index}`} ${"x".repeat(3000)}` }] },
});

function opened(): AppState {
  let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: SESSION, cwd: "/project" }) });
  state = { ...state, current: SESSION };
  return reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/project", path: SESSION } } } as never);
}

function hydrate(store: ReturnType<typeof createStateStore>): void {
  const entries = Array.from({ length: 24 }, (_, index) => entry(index));
  store.dispatch({ type: "historyBegin", path: SESSION, token: "t" } as never);
  store.dispatch({ type: "historySnapshot", path: SESSION, token: "t", entries, leafId: "e23", window: {
    epoch: "w1", seq: 24, revision: "r1.env.24", environmentKey: "k", userOffset: 0, complete: false,
    branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], anchor: "e0", before: "cursor-older",
  } } as never);
}

/** The containers in document order — what the pass changes. */
const domOrder = (): string[] => [...container.querySelectorAll("[data-message-id]")].map(node => (node as HTMLElement).dataset.messageId!);
/** The same rows in the order the person reads them. */
const readingOrder = (): string[] => [...container.querySelectorAll("[data-message-id]")]
  .map(node => ({ id: (node as HTMLElement).dataset.messageId!, top: node.getBoundingClientRect().top }))
  .sort((a, b) => a.top - b.top).map(row => row.id);
const rowOf = (id: string): HTMLElement | null => container.querySelector(`[data-message-id="${id}"]`);

/**
 * The surface a person is reading: the real store, viewport, list and rows,
 * landed at the newest turn and then read back up through, so the list has
 * assigned its containers the way it does in a conversation.
 */
async function reading() {
  let controller: ReturnType<typeof useTranscriptViewport> | undefined;
  const store = createStateStore(opened());
  hydrate(store);
  function Capture() {
    controller = useTranscriptViewport();
    return null;
  }
  function Transcript() {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const view = state.open[SESSION]!;
    const { messages } = projectMessages({ blocks: view.blocks, running: false, dialogs: [] });
    const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages, isRunning: false, onNew: async () => {} });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <FileOpenerProvider>
          <ThreadPrimitive.Root>
            <ThreadPrimitive.Viewport autoScroll={false} scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false}>
              <TranscriptViewportBinding />
              <WindowedMessages />
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </FileOpenerProvider>
      </AssistantRuntimeProvider>
    );
  }
  await act(async () => root.render(
    <LaserStoreProvider store={store}>
      <TooltipProvider>
        <TranscriptViewportProvider>
          <Capture />
          <Transcript />
        </TranscriptViewportProvider>
      </TooltipProvider>
    </LaserStoreProvider>,
  ));
  const viewport = container.querySelector<HTMLElement>('[data-slot="thread-viewport"]')!;
  const content = () => Number.parseFloat(track()?.style.height ?? "0") || 0;
  Object.defineProperties(viewport, {
    clientHeight: { value: 900, configurable: true },
    scrollHeight: { get: content, configurable: true },
    scrollTop: {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => {
        const next = Math.min(Math.max(0, value), Math.max(0, content() - 900));
        if (next === scrolled) return;
        scrolled = next;
        queueMicrotask(() => viewport.dispatchEvent(new Event("scroll")));
      },
    },
    scrollTo: { configurable: true, value: (arg: { top?: number } | number) => { viewport.scrollTop = typeof arg === "number" ? arg : arg?.top ?? scrolled; } },
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { controller!.latest(); await Promise.resolve(); });
  await act(async () => { viewport.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
  await act(async () => { viewport.scrollTop = Math.max(0, viewport.scrollTop - ROW * 12); await Promise.resolve(); });
  await act(async () => { viewport.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
  const held = controller!.capture().anchor?.messageId ?? readingOrder().at(-1)!;
  const row = rowOf(held)!;
  return { store, controller: controller!, viewport, held, row, action: row.querySelector("button")! };
}

/**
 * Run the list's DOM-order pass at its own boundary and report what it did.
 * A case that reorders nothing would prove nothing, so the pass is asserted to
 * have moved containers and never to have scrolled the reader.
 */
async function sortPass(viewport: HTMLElement): Promise<{ before: string[]; after: string[] }> {
  // Whatever the reading above left in flight commits first: the pass is the
  // only thing under test here, so it is measured from a settled surface.
  await act(async () => { await Promise.resolve(); });
  const before = domOrder();
  const scrollBefore = viewport.scrollTop;
  await act(async () => { vi.advanceTimersByTime(LIST_DOM_ORDER_DEBOUNCE_MS); await Promise.resolve(); });
  const after = domOrder();
  expect(after, "the list's pass really did re-sort its containers").not.toEqual(before);
  expect(after.length).toBe(before.length);
  expect(viewport.scrollTop, "re-sorting containers is not a scroll").toBe(scrollBefore);
  return { before, after };
}

/**
 * Take part in the moves the list makes on its own track, as the DOM would.
 * `during` runs immediately after each container is inserted — the moment a
 * browser has already blurred the subtree and collapsed a selection inside it.
 */
function duringMoves(during: (moved: HTMLElement) => void): { moved: HTMLElement[]; release: () => void } {
  const node = track();
  const moved: HTMLElement[] = [];
  for (const name of ["insertBefore", "appendChild"] as const) {
    const original = (Node.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    Object.defineProperty(node, name, {
      configurable: true,
      value: function taking(this: HTMLElement, ...args: unknown[]) {
        const out = original.apply(this, args);
        moved.push(args[0] as HTMLElement);
        during(args[0] as HTMLElement);
        return out;
      },
    });
  }
  return { moved, release: () => { Reflect.deleteProperty(node, "insertBefore"); Reflect.deleteProperty(node, "appendChild"); } };
}

/**
 * The DOM's own range mutation around a move, which happy-dom does not
 * implement, written out from the standard and applied at the two moments it
 * happens rather than predicted:
 *
 * - *removing steps*: every live boundary whose node is an inclusive descendant
 *   of the node being removed becomes (that node's parent, that node's index);
 * - *insertion steps*: every live boundary in the parent whose offset is
 *   greater than the index the node is inserted at rises by one.
 *
 * Nothing is dropped: a browser leaves a collapsed selection at that point, and
 * that is the state the repair has to recognise as its own. `applies` chooses
 * which moved container is treated as removed, so a case can hold one endpoint
 * inside the row that moves and leave the other one untouched. `left` records
 * the point the DOM was left at, so a case can assert the repair left it there
 * instead of restating the repair's own formula. `during` runs immediately
 * after that, the moment a browser's synchronous blur handler would run with
 * the boundary already relocated.
 */
type LeftBehind = { anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number };
function withDomRangeMutation(
  applies: (moved: HTMLElement) => boolean,
  during?: (moved: HTMLElement) => void,
): { relocations: number; left: LeftBehind | null; release: () => void } {
  const node = track();
  const selection = document.getSelection()!;
  const state: { relocations: number; left: LeftBehind | null; release: () => void } = { relocations: 0, left: null, release: () => {} };
  for (const name of ["insertBefore", "appendChild"] as const) {
    const original = (Node.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    Object.defineProperty(node, name, {
      configurable: true,
      value: function mutating(this: HTMLElement, ...args: unknown[]) {
        const moved = args[0] as HTMLElement;
        const inside = (endpoint: Node | null) => !!endpoint && (endpoint === moved || moved.contains(endpoint));
        const had = selection.rangeCount > 0 && !!selection.anchorNode && !!selection.focusNode;
        const touches = had && applies(moved) && (inside(selection.anchorNode) || inside(selection.focusNode));
        const index = [...this.childNodes].indexOf(moved);
        let anchor = { node: selection.anchorNode as Node, offset: selection.anchorOffset };
        let focus = { node: selection.focusNode as Node, offset: selection.focusOffset };
        if (touches) {
          if (inside(anchor.node)) anchor = { node: this, offset: index };
          if (inside(focus.node)) focus = { node: this, offset: index };
        }
        const out = original.apply(this, args);
        if (touches) {
          const insertedAt = [...this.childNodes].indexOf(moved);
          const shift = (point: { node: Node; offset: number }) => point.node === this && point.offset > insertedAt
            ? { node: point.node, offset: point.offset + 1 }
            : point;
          anchor = shift(anchor);
          focus = shift(focus);
          selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
          state.relocations += 1;
          state.left = {
            anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
            focusNode: selection.focusNode, focusOffset: selection.focusOffset,
          };
        }
        during?.(moved);
        return out;
      },
    });
  }
  state.release = () => { Reflect.deleteProperty(node, "insertBefore"); Reflect.deleteProperty(node, "appendChild"); };
  return state;
}

/** The longest text node inside a row: what a person's selection lands in. */
function textIn(row: HTMLElement): Text {
  let best: Text | undefined;
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node as Text;
      if (!best || (text.data?.length ?? 0) > (best.data?.length ?? 0)) best = text;
      return;
    }
    for (const child of [...node.childNodes]) walk(child);
  };
  walk(row);
  if (!best) throw new Error("no text in this row");
  return best;
}

describe("the list's own DOM-order pass", () => {
  it("keeps the action a keyboard is on focused, on the same node in the same row", async () => {
    const { viewport, held, action } = await reading();
    // happy-dom does not move focus on Tab, so focus is placed on the node the
    // keyboard would land on and the key is sent to the viewport as well: the
    // proxy is the traversal, never the identity of the focused node.
    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      action.focus();
      action.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(document.activeElement).toBe(action);

    const { after } = await sortPass(viewport);
    expect(after).toContain(held);
    expect(document.activeElement).toBe(action);
    expect(action.isConnected).toBe(true);
    expect(rowOf(held)!.contains(action)).toBe(true);
    // The reading order is the index order the pass sorted the containers into.
    expect(readingOrder()).toEqual(after);
  });

  it("does not take focus or a selection that was never inside a moved row", async () => {
    const { viewport } = await reading();
    const outside = document.createElement("button");
    outside.textContent = "somewhere else";
    const prose = document.createElement("p");
    prose.textContent = "a paragraph the person selected outside the conversation";
    document.body.append(outside, prose);
    try {
      outside.focus();
      const selection = document.getSelection()!;
      selection.setBaseAndExtent(prose.firstChild!, 2, prose.firstChild!, 11);
      expect(document.activeElement).toBe(outside);

      await sortPass(viewport);

      expect(document.activeElement).toBe(outside);
      expect(selection.anchorNode).toBe(prose.firstChild);
      expect(selection.anchorOffset).toBe(2);
      expect(selection.focusOffset).toBe(11);

      // And with nothing focused at all, nothing becomes focused.
      outside.blur();
      expect(document.activeElement).toBe(document.body);
      await act(async () => { viewport.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(LIST_DOM_ORDER_DEBOUNCE_MS); await Promise.resolve(); });
      expect(document.activeElement).toBe(document.body);
    } finally {
      outside.remove();
      prose.remove();
    }
  });

  it("leaves focus where a blur-time handler moved it, instead of taking it back", async () => {
    const { viewport, action } = await reading();
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "the control a blur handler chose";
    document.body.append(elsewhere);
    // The proxy, named: happy-dom fires no blur or focusout when a focused node
    // is removed, so the handler's effect — focus moving on while the row is
    // being re-inserted — is applied at exactly that moment instead.
    const taking = duringMoves(moved => { if (moved.contains(action)) elsewhere.focus(); });
    try {
      await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
      await sortPass(viewport);
      expect(document.activeElement).toBe(elsewhere);
      expect(action.isConnected).toBe(true);
    } finally {
      taking.release();
      elsewhere.remove();
    }
  });

  it("keeps a forward selection's endpoints inside a moved row (proxy: happy-dom keeps ranges a browser would collapse)", async () => {
    const { viewport, held, action } = await reading();
    const text = textIn(rowOf(held)!);
    const selection = document.getSelection()!;
    await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    selection.setBaseAndExtent(text, 4, text, 19);
    let collapses = 0;
    // What a browser does on removal, at the moment it does it: a range with an
    // endpoint in the removed subtree collapses. happy-dom does not implement
    // that mutation, so the case applies it.
    const taking = duringMoves(moved => {
      if (!moved.contains(text)) return;
      collapses += 1;
      selection.removeAllRanges();
    });
    try {
      await sortPass(viewport);
      expect(collapses, "the row holding the selection is one the pass moved").toBeGreaterThan(0);
      expect(selection.rangeCount).toBe(1);
      expect(selection.anchorNode).toBe(text);
      expect(selection.anchorOffset).toBe(4);
      expect(selection.focusNode).toBe(text);
      expect(selection.focusOffset).toBe(19);
      expect(selection.toString()).toBe(text.data.slice(4, 19));
      expect(document.activeElement).toBe(action);
    } finally {
      taking.release();
    }
  });

  it("keeps a backward selection across two moved rows backward (same proxy)", async () => {
    const { viewport, held } = await reading();
    const order = readingOrder();
    const next = order[order.indexOf(held) + 1]!;
    const first = textIn(rowOf(held)!);
    const second = textIn(rowOf(next)!);
    const selection = document.getSelection()!;
    // Selected upwards: the anchor is in the lower row, the focus in the upper.
    selection.setBaseAndExtent(second, 9, first, 3);
    expect(selection.anchorNode).toBe(second);
    let collapses = 0;
    const taking = duringMoves(moved => {
      if (!moved.contains(first) && !moved.contains(second)) return;
      collapses += 1;
      selection.removeAllRanges();
    });
    try {
      await sortPass(viewport);
      expect(collapses, "at least one row holding an endpoint was moved").toBeGreaterThan(0);
      expect(selection.anchorNode, "the direction the person selected in").toBe(second);
      expect(selection.anchorOffset).toBe(9);
      expect(selection.focusNode).toBe(first);
      expect(selection.focusOffset).toBe(3);
    } finally {
      taking.release();
    }
  });

  it("restores a selection the DOM relocated to the container, which is what a browser actually leaves", async () => {
    const { viewport, held, action } = await reading();
    const text = textIn(rowOf(held)!);
    const selection = document.getSelection()!;
    await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    selection.setBaseAndExtent(text, 4, text, 19);
    // Removal does not empty the selection: both endpoints end up in the track,
    // outside the row, at the index the row used to have. A repair that only
    // recognised an emptied selection would walk away from this one.
    const mutation = withDomRangeMutation(moved => moved.contains(text));
    try {
      await sortPass(viewport);
      expect(mutation.relocations, "the row holding the selection is one the pass moved").toBeGreaterThan(0);
      expect(selection.anchorNode).toBe(text);
      expect(selection.anchorOffset).toBe(4);
      expect(selection.focusNode).toBe(text);
      expect(selection.focusOffset).toBe(19);
      expect(selection.toString()).toBe(text.data.slice(4, 19));
      expect(document.activeElement).toBe(action);
    } finally {
      mutation.release();
    }
  });

  it("restores a relocated endpoint and leaves the endpoint the move never touched where it is", async () => {
    const { viewport, held } = await reading();
    const order = readingOrder();
    const other = order[order.indexOf(held) + 1]!;
    const inside = textIn(rowOf(held)!);
    const untouched = textIn(rowOf(other)!);
    const selection = document.getSelection()!;
    // Selected downwards out of the row that moves into a row that did not:
    // only the first endpoint is relocated, the second keeps its own node.
    selection.setBaseAndExtent(inside, 5, untouched, 11);
    const mutation = withDomRangeMutation(moved => moved.contains(inside));
    try {
      await sortPass(viewport);
      expect(mutation.relocations).toBeGreaterThan(0);
      expect(selection.anchorNode).toBe(inside);
      expect(selection.anchorOffset).toBe(5);
      expect(selection.focusNode).toBe(untouched);
      expect(selection.focusOffset).toBe(11);
    } finally {
      mutation.release();
    }
  });

  it("keeps a selection somebody else made during the move, even without a focus change", async () => {
    const { viewport, held } = await reading();
    const text = textIn(rowOf(held)!);
    const prose = document.createElement("p");
    prose.textContent = "the selection something else made meanwhile";
    document.body.append(prose);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(text, 4, text, 19);
    // No focus moves here at all: the only signal that this is not the move's
    // own leftover is that the endpoints are nodes the move never had.
    const taking = duringMoves(moved => {
      if (!moved.contains(text)) return;
      selection.setBaseAndExtent(prose.firstChild!, 2, prose.firstChild!, 9);
    });
    try {
      await sortPass(viewport);
      expect(selection.anchorNode).toBe(prose.firstChild);
      expect(selection.anchorOffset).toBe(2);
      expect(selection.focusOffset).toBe(9);
    } finally {
      taking.release();
      prose.remove();
    }
  });

  it("keeps a selection something else made inside the very row that moved, with no focus change", async () => {
    const { viewport, held } = await reading();
    const text = textIn(rowOf(held)!);
    // The other words are inside the moved subtree too, so the only thing that
    // separates them from the move's own leftover is that they are not where
    // the move left the boundary: a different node, at offsets nobody held.
    const aside = document.createElement("p");
    aside.textContent = "the words something else selected inside this very row";
    rowOf(held)!.append(aside);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(text, 4, text, 19);
    // No focus moves at all, so the handover check never fires: this is the
    // ownership test on its own.
    const taking = duringMoves(moved => {
      if (!moved.contains(text)) return;
      selection.setBaseAndExtent(aside.firstChild!, 2, aside.firstChild!, 9);
    });
    try {
      await sortPass(viewport);
      expect(document.activeElement).toBe(document.body);
      expect(selection.anchorNode, "an intentional selection inside the row is not overwritten").toBe(aside.firstChild);
      expect(selection.anchorOffset).toBe(2);
      expect(selection.focusNode).toBe(aside.firstChild);
      expect(selection.focusOffset).toBe(9);
    } finally {
      taking.release();
      aside.remove();
    }
  });

  it("leaves a handover into another field in the same moved row holding focus, caret and the selection the DOM left", async () => {
    const { viewport, held, action } = await reading();
    const text = textIn(rowOf(held)!);
    const selection = document.getSelection()!;
    // The field the handover moves into is inside the moved row itself, and the
    // document's selection is exactly where the DOM's own steps left it — so
    // every other guard says "restore": the endpoints are the move's own
    // relocated point, they fit, and they changed. Only the handover check
    // knows that putting the row's selection back would reach across an
    // editable control the person was just moved into.
    const field = document.createElement("input");
    field.value = "the field the handler moved into";
    rowOf(held)!.append(field);
    await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    selection.setBaseAndExtent(text, 4, text, 19);
    // Both proxies at once, named: happy-dom implements neither the DOM's range
    // mutation on removal nor a blur when a focused node is removed, so the
    // case applies the standard's steps and then runs the handler's effect at
    // the moment the browser would.
    const mutation = withDomRangeMutation(moved => moved.contains(text), moved => {
      if (!moved.contains(field)) return;
      field.focus();
      field.setSelectionRange(4, 9, "forward");
    });
    try {
      await sortPass(viewport);
      expect(mutation.relocations, "the row holding the selection is one the pass moved").toBeGreaterThan(0);
      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(4);
      expect(field.selectionEnd).toBe(9);
      // The selection is left exactly as the DOM left it, read from the DOM at
      // the moment of the move rather than recomputed here.
      expect(selection.anchorNode).toBe(mutation.left!.anchorNode);
      expect(selection.anchorOffset).toBe(mutation.left!.anchorOffset);
      expect(selection.focusNode).toBe(mutation.left!.focusNode);
      expect(selection.focusOffset).toBe(mutation.left!.focusOffset);
      expect(selection.anchorNode, "the row's own selection was not put back over the handover").not.toBe(text);
      expect(action.isConnected).toBe(true);
    } finally {
      mutation.release();
    }
  });

  it("leaves both the focus and the selection a blur-time handover chose, and overwrites neither", async () => {
    const { viewport, held, action } = await reading();
    const text = textIn(rowOf(held)!);
    const selection = document.getSelection()!;
    const field = document.createElement("input");
    field.value = "the handler's own field";
    const prose = document.createElement("p");
    prose.textContent = "and the handler's own selection";
    document.body.append(field, prose);
    // The person was reading a message with text selected in it, with the row's
    // action focused. Both proxies at once: the range collapses the way removal
    // makes it, and the handover happens at the same moment, because happy-dom
    // raises no blur of its own.
    await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    selection.setBaseAndExtent(text, 4, text, 19);
    const taking = duringMoves(moved => {
      if (!moved.contains(text)) return;
      selection.removeAllRanges();
      field.focus();
      field.setSelectionRange(2, 5, "forward");
      selection.setBaseAndExtent(prose.firstChild!, 1, prose.firstChild!, 6);
    });
    try {
      await sortPass(viewport);
      // The handover keeps focus, its own caret, and its own selection: putting
      // the row's selection back would overwrite an editable control the person
      // was moved into.
      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(2);
      expect(field.selectionEnd).toBe(5);
      expect(selection.anchorNode).toBe(prose.firstChild);
      expect(selection.anchorOffset).toBe(1);
      expect(selection.focusOffset).toBe(6);
    } finally {
      taking.release();
      field.remove();
      prose.remove();
    }
  });

  it("drops a held selection whose own text changed while the row was out of the tree, and still finishes the sort", async () => {
    const { viewport, held } = await reading();
    const text = textIn(rowOf(held)!);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(text, 4, text, 40);
    const taking = duringMoves(moved => {
      if (!moved.contains(text)) return;
      selection.removeAllRanges();
      // A handler that rewrote the row's text leaves the held offsets past the
      // end of it, where `setBaseAndExtent` throws. The pass must not stop
      // half-sorted because a repair was impossible.
      text.data = "rewritten";
    });
    try {
      await sortPass(viewport);
      expect(selection.rangeCount).toBe(0);
      expect(readingOrder()).toEqual(domOrder());
    } finally {
      taking.release();
    }
  });

  it("keeps the caret in a focused field inside a moved row", async () => {
    const { viewport, held } = await reading();
    const field = document.createElement("input");
    field.value = "half an edit";
    rowOf(held)!.append(field);
    field.focus();
    field.setSelectionRange(3, 9, "backward");
    expect(document.activeElement).toBe(field);

    await sortPass(viewport);

    // Focus is the part a browser loses here; the field's own value and caret
    // survive a re-insertion in happy-dom, so those two are a guard on the
    // repair rather than the proof.
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("half an edit");
    expect(field.selectionStart).toBe(3);
    expect(field.selectionEnd).toBe(9);
    expect(field.selectionDirection).toBe("backward");
  });

  it("restores a caret's direction, not only its offsets (proxy: the field's range is reset to forward during the move)", async () => {
    const { viewport, held } = await reading();
    const field = document.createElement("input");
    field.value = "half an edit";
    rowOf(held)!.append(field);
    field.focus();
    field.setSelectionRange(3, 9, "backward");
    // A field whose caret comes back with the same offsets but selected the
    // other way round is a person's shift-selection turned inside out. happy-dom
    // keeps the direction across a re-insertion, so the case resets it at the
    // moment of the move, which is what a browser that forgets it would do.
    const taking = duringMoves(moved => { if (moved.contains(field)) field.setSelectionRange(3, 9, "forward"); });
    try {
      await sortPass(viewport);
      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(3);
      expect(field.selectionEnd).toBe(9);
      expect(field.selectionDirection).toBe("backward");
    } finally {
      taking.release();
    }
  });

  it("uses the native state-preserving move untouched where it exists (stub: happy-dom has no Element.moveBefore)", async () => {
    const { viewport, action } = await reading();
    await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    const node = track();
    const calls = { native: 0, fallback: 0 };
    // The stub can move a node, not preserve its state — that is the browser's
    // half of the contract. So this case proves the one thing it can: with a
    // `moveBefore` present, the reordering takes it and the repair path, with
    // its capture and its restore, never runs.
    Object.defineProperty(node, "moveBefore", {
      configurable: true,
      value: function moveBefore(this: HTMLElement, element: Node, reference: Node | null) {
        calls.native += 1;
        if (reference) Node.prototype.insertBefore.call(this, element, reference);
        else Node.prototype.appendChild.call(this, element);
      },
    });
    const taking = duringMoves(() => { calls.fallback += 1; });
    try {
      await sortPass(viewport);
      expect(calls.native).toBeGreaterThan(0);
      expect(calls.fallback).toBe(0);
    } finally {
      taking.release();
      Reflect.deleteProperty(node, "moveBefore");
    }
  });
});
