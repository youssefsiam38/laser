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
