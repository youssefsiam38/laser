// @vitest-environment happy-dom
/**
 * RP-5b acceptance A11 and §7, on the mounted transcript.
 *
 * Releasing the older part of a conversation somebody is reading happens while
 * they are reading it. So this mounts the real transcript over the real store,
 * with the real viewport controller and the real view cache, focuses a real
 * message action, types a real draft, scrolls to a real row — and then trims
 * through the cache's own pass, with the surface still on screen.
 *
 * What it proves: focus does not move, the row the viewport was holding stays
 * where it was, the draft is untouched, the action still names the same entry
 * and the same prompt ordinal, and no committed frame in between was empty.
 * Then a replacement page that does not contain those rows is refused — the
 * transcript on screen does not change, and the surface offers to read recent
 * history again instead of pretending it can page backwards.
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
import { ThreadMessage } from "../../src/components/thread/messages.js";
import { HistoryControls } from "../../src/components/thread/Thread.js";
import { TranscriptViewportBinding, TranscriptViewportProvider, WindowedMessages, useTranscriptViewport } from "../../src/components/thread/transcript-viewport.js";
import { createViewCache, VIEW_CACHE_LIMITS } from "../../src/runtime/view-cache.js";
import { resetAnchoredMessages, standingRows } from "../../src/runtime/anchored-messages.js";
import { MessageEditPresentation, TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";
import { sessionState } from "../agents/fixtures.js";
import { motionMs } from "../../src/motion.js";

const SESSION = "/project/session.jsonl";
/** One line of the transcript, for the geometry seam below. */
const LINE = 24;
const ROW = LINE * 4;

const stable = vi.hoisted(() => ({
  client: { request: vi.fn(async () => ({})) },
  actions: {
    listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn(),
    loadEarlierEntries: vi.fn(async () => true), loadAllEntries: vi.fn(async () => true),
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

/**
 * The only stub, and only at the seam where a DOM would measure: happy-dom
 * lays nothing out, so a row's rectangle is derived from its position in the
 * transcript. Everything above this — anchors, publication, the trim itself —
 * is the real thing.
 */
/** The list's own container track: the box every row is positioned inside. */
function track(): HTMLElement {
  const content = container.querySelector<HTMLElement>(".legend-list-content-container");
  return [...(content?.children ?? [])].find(node => (node as HTMLElement).style.height) as HTMLElement
    ?? content as HTMLElement;
}

function stubGeometry(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    // The scroller itself is a window nine hundred pixels tall.
    if ((this as HTMLElement).dataset?.slot === "thread-viewport") {
      return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 900, width: 600, height: 900, toJSON: () => ({}) } as DOMRect;
    }
    const top = (node: number) => node - scrolled;
    const messages = track();
    if (this === messages) {
      const height = Number.parseFloat(messages.style.height) || 0;
      return { x: 0, y: top(0), top: top(0), left: 0, right: 600, bottom: top(height), width: 600, height, toJSON: () => ({}) } as DOMRect;
    }
    // The list positions its rows itself, so a row is where the list put it —
    // the inline `top` of the container holding it — and a row's height is the
    // fixture's, whatever the list guessed. A trim must show up as a scroll
    // compensation, never be hidden by renumbering.
    // Either the row itself, or the container the list positions it in:
    // the list measures the container, the transcript reads the row.
    const row = (this.closest?.("[data-window-message]") ?? this.querySelector?.("[data-window-message]")) as HTMLElement | null;
    const item = row?.parentElement;
    if (!item) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    const start = top(Number.parseFloat(item.style.top) || 0);
    return { x: 0, y: start, top: start, left: 0, right: 600, bottom: start + ROW, width: 600, height: ROW, toJSON: () => ({}) } as DOMRect;
  };
  return () => { Element.prototype.getBoundingClientRect = original; };
}
let scrolled = 0;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetAnchoredMessages();
  scrolled = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  restoreGeometry = stubGeometry();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreGeometry?.();
  resetAnchoredMessages();
  vi.clearAllMocks();
});

const entry = (index: number) => ({
  id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, type: "message",
  message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${index === 0 ? "first prompt" : `turn ${index}`} ${"x".repeat(3000)}` }] },
});

/** The session open and on screen, before any history has been read. */
function opened(): AppState {
  let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: SESSION, cwd: "/project" }) });
  state = { ...state, current: SESSION };
  return reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/project", path: SESSION } } } as never);
}

/**
 * Read the conversation in, through the cache — the same transactions the app
 * dispatches, watched the same way, so the cache measures this view for real.
 */
function hydrateThrough(store: ReturnType<typeof createStateStore>, cache: ReturnType<typeof cacheFor> | undefined): void {
  const entries = Array.from({ length: 24 }, (_, index) => entry(index));
  const actions = [
    { type: "historyBegin", path: SESSION, token: "t" },
    { type: "historySnapshot", path: SESSION, token: "t", entries, leafId: "e23", window: {
      epoch: "w1", seq: 24, revision: "r1.env.24", environmentKey: "k", userOffset: 0, complete: false,
      branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], anchor: "e0", before: "cursor-older",
    } },
  ];
  for (const action of actions) {
    const before = store.getSnapshot();
    store.dispatch(action as never);
    cache?.observeTransaction(action as never, before, store.getSnapshot());
  }
}

// In the order the person sees them: the list sorts its own containers back
// into index order on a debounce, so the DOM's order is not the reading order
// between one change and the next.
const rowIds = (): string[] => [...container.querySelectorAll("[data-message-id]")]
  .map(node => ({ id: (node as HTMLElement).dataset.messageId!, top: node.getBoundingClientRect().top }))
  .sort((a, b) => a.top - b.top)
  .map(row => row.id);
const rowOf = (id: string): HTMLElement | null => container.querySelector(`[data-message-id="${id}"]`);

/** The mounted surface: the real store, viewport, presentation and transcript. */
async function mount(store: ReturnType<typeof createStateStore>, presentation: TranscriptPresentation) {
  let controller: ReturnType<typeof useTranscriptViewport> | undefined;
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
              {/* The controls are the list's header, exactly as the app
                  mounts them: chrome above the list is the one thing that
                  pushes a reader by its own height (M16-T91). */}
              <WindowedMessages head={<HistoryControls />} />
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </FileOpenerProvider>
      </AssistantRuntimeProvider>
    );
  }
  void presentation;
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
  // A real scroller around the real transcript: the window is nine hundred
  // pixels, the range is whatever the transcript rendered, and a write to
  // `scrollTop` is clamped and reported like a browser's.
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
  return controller!;
}

/** A view cache watching this store, trimming to what a bounded view may hold. */
function cacheFor(store: ReturnType<typeof createStateStore>, viewBytes: number) {
  return createViewCache({
    read: store.getSnapshot,
    dispatch: store.dispatch,
    environment: { scoped: () => [], hasDraft: () => false, heldPaths: () => [], environmentKey: () => "env" } as never,
    schedule: (run: () => void) => { run(); return () => {}; },
    limits: { ...VIEW_CACHE_LIMITS, viewBytes },
  } as never);
}

describe("a trim while somebody is reading", () => {
  it("offers the next earlier page immediately whenever the window has a cursor", async () => {
    const store = createStateStore(opened());
    hydrateThrough(store, undefined);
    await mount(store, store.presentation);
    // The unloaded range is placeholder rows and nothing else: no words, no
    // card, no promise to read. Only the explicit control carries copy.
    const reserve = container.querySelector('[data-slot="history-reserve"]');
    expect(reserve).not.toBeNull();
    expect(reserve!.textContent?.trim()).toBe("");
    expect(reserve!.getAttribute("aria-hidden")).toBe("true");
    expect(reserve!.querySelectorAll('[data-slot="history-reserve-turn"]').length).toBeGreaterThan(0);
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Load earlier messages");
    expect(button).toBeDefined();
    await act(async () => { button!.click(); await Promise.resolve(); });
    expect(stable.actions.loadEarlierEntries).toHaveBeenCalledOnce();
  });

  it("says a page is in flight once, for screen readers only, and marks the region busy", async () => {
    vi.useFakeTimers();
    try {
      const store = createStateStore(opened());
      hydrateThrough(store, undefined);
      let settle!: (loaded: boolean) => void;
      stable.actions.loadEarlierEntries.mockImplementationOnce(() => new Promise<boolean>(resolve => { settle = resolve; }));
      const controller = await mount(store, store.presentation);
      const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Load earlier messages")!;

      await act(async () => { button.click(); await Promise.resolve(); });
      // One exposed status, and it is not on screen.
      const exposed = [...container.querySelectorAll('[role="status"]')].filter(node => !node.closest('[aria-hidden="true"]'));
      expect(exposed).toHaveLength(1);
      expect(exposed[0]!.textContent).toBe("Loading earlier messages");
      expect(exposed[0]!.classList.contains("sr-only")).toBe(true);
      expect(container.querySelector('[data-slot="thread-viewport"]')!.getAttribute("aria-busy")).toBe("true");
      // Nothing visible says so: no card, no copy in the transcript region.
      // The explicit control is the one exception and always was — it is the
      // button the person pressed, and it lives in the head item with the
      // rest of what stands above the conversation.
      expect(container.querySelector('[data-slot="history-reserve-loading"]')).toBeNull();
      const visibleCopy = [...container.querySelectorAll('[data-slot="thread-viewport"] *')]
        .filter(node => node.childElementCount === 0 && /loading/i.test(node.textContent ?? "") && !node.closest(".sr-only") && !node.closest("button"));
      expect(visibleCopy).toHaveLength(0);
      // The overdue mark appears only past one slow motion step, only while
      // the person is inside the estimated range, and goes on arrival.
      vi.spyOn(controller, "isReadingHistoryReserve").mockReturnValue(true);
      expect(container.querySelector('[data-slot="history-reserve-indicator"]')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(motionMs("--motion-slow") + 1); });
      const indicator = container.querySelector('[data-slot="history-reserve-indicator"]');
      expect(indicator).not.toBeNull();
      expect(indicator!.getAttribute("aria-hidden")).toBe("true");
      expect(indicator!.textContent?.trim()).toBe("");
      await act(async () => { settle(false); await Promise.resolve(); await Promise.resolve(); });
      expect(container.querySelector('[data-slot="history-reserve-indicator"]')).toBeNull();
      expect(container.querySelector('[data-slot="thread-viewport"]')!.getAttribute("aria-busy")).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("releases failed and rejected earlier-page requests so the person can retry", async () => {
    const store = createStateStore(opened());
    hydrateThrough(store, undefined);
    const controller = await mount(store, store.presentation);
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Load earlier messages")!;

    stable.actions.loadEarlierEntries.mockResolvedValueOnce(false);
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(controller.loadingEarlier).toBe(false);

    stable.actions.loadEarlierEntries.mockRejectedValueOnce(new Error("fixture transport refusal"));
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(controller.loadingEarlier).toBe(false);
    expect(stable.actions.loadEarlierEntries).toHaveBeenCalledTimes(2);
  });

  it("keeps the active logical transcript, focus, place, draft and action identity above soft targets", async () => {
    const store = createStateStore(opened());
    const presentation = store.presentation;
    // The conversation is read in before the cache is watching, so nothing is
    // released before the surface is on screen: the trim below really does
    // happen while somebody is reading.
    const cache = cacheFor(store, 12 * 1024);
    hydrateThrough(store, undefined);
    const controller = await mount(store, presentation);

    // Read an older part of the conversation: land at the newest turn the way
    // an opening conversation does, then travel back up through it and let the
    // browser's own scroll event reach the controller, as a wheel would.
    const viewport = container.querySelector<HTMLElement>('[data-slot="thread-viewport"]')!;
    await act(async () => { controller.latest(); await Promise.resolve(); });
    await act(async () => { viewport.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
    await act(async () => { viewport.scrollTop = Math.max(0, viewport.scrollTop - ROW * 12); await Promise.resolve(); });
    await act(async () => { viewport.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
    // The row the reading position is on: the surface picks it, the test only
    // names it — and it is not the newest turn, which is the easy case.
    const knownId = controller.capture().anchor?.messageId ?? rowIds().at(-1)!;
    expect(rowIds()).toContain(knownId);
    expect(knownId, "the reader never left the live edge").not.toBe(rowIds().at(-1));
    const knownEntry = knownId.slice("entry:".length);
    const target = rowOf(knownId)!;
    const action = target.querySelector("button")!;
    // Focus the way a person does: the viewport's own focus listener records
    // which row it belongs to.
    await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(document.activeElement).toBe(action);

    // A real draft, in the surface's own presentation.
    const draft = presentation.edit(SESSION, knownId) ?? new MessageEditPresentation("");
    presentation.rememberEdit(SESSION, knownId, draft);
    draft.update({ draft: "half an edit", editing: true });

    // Let the viewport publish what it is standing on. No timer is guessed —
    // the publication itself is what is waited for.
    await act(async () => { controller.capture(); controller.committed(); });
    await act(async () => { await Promise.resolve(); });
    expect(standingRows(SESSION)?.focusedEntryId).toBe(knownEntry);

    const anchorTopBefore = rowOf(knownId)!.getBoundingClientRect().top;
    const rowsBefore = rowIds();
    const beforeTrim = store.getSnapshot().open[SESSION]!;
    const offsetBefore = beforeTrim.history!.userOffset;

    // Every committed render is watched: none of them may be an empty
    // transcript, not even for one frame.
    const frames: number[] = [];
    const observer = new MutationObserver(() => frames.push(container.querySelectorAll("[data-message-id]").length));
    observer.observe(container, { childList: true, subtree: true });

    // The cache notices this conversation from a real transaction, with the
    // surface mounted, and then its own pass releases the older part of it.
    await act(async () => {
      const seen = store.getSnapshot();
      const update = { type: "notification", method: "session/update", params: { sessionPath: SESSION, seq: 25, at: "", update: { kind: "state", state: seen.open[SESSION]!.state } } };
      store.dispatch(update as never);
      cache.observeTransaction(update as never, seen, store.getSnapshot());
      cache.maintain();
    });
    await act(async () => { await Promise.resolve(); });
    observer.disconnect();

    const after = store.getSnapshot().open[SESSION]!;
    expect(after.trimmed).toBeUndefined();
    expect(after.blocks).toBe(beforeTrim.blocks);
    expect(after.entries).toBe(beforeTrim.entries);
    expect(cache.counters().bytes).toBeGreaterThan(12 * 1024);
    expect(cache.counters().overflow).toBe("protected");
    expect(frames.every(count => count > 0)).toBe(true);
    expect(rowIds().length).toBe(rowsBefore.length);

    // The row the viewport was holding is still here, and has not moved by
    // more than a line.
    const anchorAfter = rowOf(knownId);
    expect(anchorAfter).not.toBeNull();
    expect(Math.abs(anchorAfter!.getBoundingClientRect().top - anchorTopBefore)).toBeLessThanOrEqual(LINE);

    // Focus is on the same node, not merely on something like it.
    expect(document.activeElement).toBe(action);
    expect(action.isConnected).toBe(true);

    // The draft is untouched.
    expect(draft.getSnapshot().draft).toBe("half an edit");
    expect(presentation.hasEditDraft(SESSION)).toBe(true);

    // The action still names the same entry, and no prompt ordinal moved.
    expect(after.history!.userOffset).toBe(offsetBefore);
    expect(after.blocks.some(block => "entryId" in block && block.entryId === knownEntry)).toBe(true);
    expect(after.entries.some(record => (record as { id: string }).id === knownEntry)).toBe(true);
    for (const id of rowIds()) expect(rowsBefore).toContain(id);

    expect(standingRows(SESSION)?.focusedEntryId).toBe(knownEntry);

    cache.dispose();
  });

  it("offers the producer's sentence and one re-read when a page base is refused", async () => {
    const store = createStateStore(opened());
    hydrateThrough(store, undefined);
    await mount(store, store.presentation);
    expect(container.textContent).toContain("Load earlier messages");

    // The conversation moved past the base this window holds: the producer
    // refuses its earlier pages and says why, for a person.
    const message = "This conversation changed since that page was read. Re-read recent messages to continue.";
    await act(async () => {
      store.dispatch({ type: "historyPageRefused", path: SESSION, cause: "stale-base", message } as never);
    });

    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain("Load earlier messages");
    const actions = [...container.querySelectorAll("button")].filter(node => /reload recent messages/i.test(node.textContent ?? ""));
    expect(actions).toHaveLength(1);

    // Reading upwards no longer asks the producer the question it just refused.
    const viewport = container.querySelector<HTMLElement>('[data-slot="thread-viewport"]')!;
    Object.defineProperty(viewport, "scrollTop", { value: 0, configurable: true, writable: true });
    await act(async () => { viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })); await Promise.resolve(); });
    expect(stable.actions.loadEarlierEntries).not.toHaveBeenCalled();

    // The keyboard path is the same path: focus the control and press Enter.
    const control = actions[0]!;
    await act(async () => {
      control.focus();
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      control.click();
      await Promise.resolve();
    });
    expect(stable.actions.rereadHistory).toHaveBeenCalledOnce();
    await act(async () => { await Promise.resolve(); });
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain("Recent messages reloaded.");

    // An accepted window carries no refusal, so the ordinary control returns.
    await act(async () => {
      store.dispatch({ type: "historyBegin", path: SESSION, token: "after" } as never);
      store.dispatch({ type: "historySnapshot", path: SESSION, token: "after", leafId: "e23",
        entries: Array.from({ length: 24 }, (_, index) => entry(index)), window: {
          epoch: "w1", seq: 40, revision: "r3.env.40", environmentKey: "k", userOffset: 0, complete: false,
          branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], anchor: "e0", before: "cursor-older",
        } } as never);
    });
    expect(container.textContent).not.toContain(message);
    expect(container.textContent).toContain("Load earlier messages");
  });

  it("refuses an unsafe replacement and keeps every route to Load earlier messages working", async () => {
    const store = createStateStore(opened());
    const presentation = store.presentation;
    const cache = cacheFor(store, 12 * 1024);
    hydrateThrough(store, undefined);
    void presentation;
    const controller = await mount(store, presentation);
    const knownId = rowIds().at(-1)!;
    const action = rowOf(knownId)!.querySelector("button")!;
    await act(async () => { action.focus(); action.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    await act(async () => {
      const standing = standingRows(SESSION);
      store.dispatch({ type: "views/trim", paths: [SESSION], keepBytes: 12 * 1024, at: "2026-09-18T00:00:00.000Z",
        anchored: knownId ? [knownId.slice("entry:".length)] : [], ...(standing ? { standing } : {}) } as never);
    });
    await act(async () => { await Promise.resolve(); });
    const stamp = store.getSnapshot().open[SESSION]!.trimmed!.at;
    const rowsAfterTrim = rowIds();
    const anchorTop = rowOf(knownId)!.getBoundingClientRect().top;

    // Before the trim the surface offered to page backwards; it has no cursor
    // now, so it does not.
    const page = (over: Record<string, unknown>) => ({
      epoch: "w1", seq: 30, revision: "r2.env.30", environmentKey: "k", userOffset: 0, complete: true,
      branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], ...over,
    });

    // A recent tail that does not carry the rows this surface stands on.
    await act(async () => {
      // Exactly what the loader does: begin the read, so anything that arrives
      // while it is in flight is buffered by the canonical fold.
      store.dispatch({ type: "historyBegin", path: SESSION, token: "rec-1" } as never);
      store.dispatch({ type: "views/reconcile", path: SESSION, at: stamp, token: "rec-1", leafId: "e23",
        entries: [entry(22), entry(23)], window: page({}) } as never);
    });
    const deferred = store.getSnapshot().open[SESSION]!;
    expect(deferred.trimmed?.deferred).toBe(true);
    // Not one row of the refused page is on screen, and nothing moved.
    expect(rowIds()).toEqual(rowsAfterTrim);
    expect(rowOf(knownId)!.getBoundingClientRect().top).toBe(anchorTop);
    expect(document.activeElement).toBe(action);
    expect(container.textContent).toContain("Load earlier messages");
    expect(container.textContent).not.toContain("Reload recent history");

    const viewport = container.querySelector<HTMLElement>('[data-slot="thread-viewport"]')!;
    Object.defineProperty(viewport, "scrollTop", { value: 0, configurable: true, writable: true });
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Load earlier messages")!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    await act(async () => { viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })); await Promise.resolve(); });
    await act(async () => { viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); await Promise.resolve(); });
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", { value: [{ clientY: y }] });
      viewport.dispatchEvent(event);
    };
    await act(async () => { touch("touchstart", 10); touch("touchmove", 30); await Promise.resolve(); });
    expect(stable.actions.loadEarlierEntries).toHaveBeenCalledTimes(4);

    // A safe read that does contain them restores the conversation and its
    // cursor, and the row a person was on is still there.
    await act(async () => {
      store.dispatch({ type: "historyBegin", path: SESSION, token: "rec-2" } as never);
      store.dispatch({ type: "views/reconcile", path: SESSION, at: stamp, token: "rec-2", leafId: "e23",
        entries: Array.from({ length: 24 }, (_, index) => entry(index)), window: page({ before: "cursor-older" }) } as never);
    });
    await act(async () => { await Promise.resolve(); });
    const restored = store.getSnapshot().open[SESSION]!;
    expect(restored.trimmed).toBeUndefined();
    expect(restored.history?.before).toBe("cursor-older");
    expect(rowIds()).toContain(knownId);
    expect(container.textContent).toContain("Load earlier messages");

    cache.dispose();
  });
});
