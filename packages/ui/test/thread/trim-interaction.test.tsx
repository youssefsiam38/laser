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

const SESSION = "/project/session.jsonl";
/** One line of the transcript, for the geometry seam below. */
const LINE = 24;
const ROW = LINE * 4;

const stable = vi.hoisted(() => ({
  client: { request: vi.fn(async () => ({})) },
  actions: {
    listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn(),
    loadEarlierEntries: vi.fn(async () => true), loadAllEntries: vi.fn(async () => true),
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
function stubGeometry(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    // The scroller itself is a window nine hundred pixels tall.
    if ((this as HTMLElement).dataset?.slot === "thread-viewport") {
      return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 900, width: 600, height: 900, toJSON: () => ({}) } as DOMRect;
    }
    const row = this.closest?.("[data-message-id]") as HTMLElement | null;
    // A row sits where its turn sits in the conversation, not where it sits in
    // the DOM: releasing older rows must be visible as a scroll compensation,
    // not hidden by renumbering.
    const id = row?.dataset.messageId ?? "";
    const index = /^entry:e(\d+)$/.exec(id) ? Number(/^entry:e(\d+)$/.exec(id)![1]) : -1;
    const viewport = container.querySelector<HTMLElement>('[data-slot="thread-viewport"]');
    const top = index >= 0 ? index * ROW - (viewport?.scrollTop ?? 0) : 0;
    return { x: 0, y: top, top, left: 0, right: 600, bottom: top + ROW, width: 600, height: index >= 0 ? ROW : 0, toJSON: () => ({}) } as DOMRect;
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
      epoch: "w1", seq: 24, revision: "r1.env.24", environmentKey: "k", userOffset: 0, complete: true,
      branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], anchor: "e0", before: "cursor-older",
    } },
  ];
  for (const action of actions) {
    const before = store.getSnapshot();
    store.dispatch(action as never);
    cache?.observeTransaction(action as never, before, store.getSnapshot());
  }
}

const rowIds = (): string[] => [...container.querySelectorAll("[data-message-id]")].map(node => (node as HTMLElement).dataset.messageId!);
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
            <ThreadPrimitive.Viewport autoScroll={false} scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false} data-slot="thread-viewport">
              <TranscriptViewportBinding />
              <HistoryControls />
              <WindowedMessages />
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
  it("keeps focus, place, draft and action identity, and never shows an empty transcript", async () => {
    const store = createStateStore(opened());
    const presentation = store.presentation;
    // The conversation is read in before the cache is watching, so nothing is
    // released before the surface is on screen: the trim below really does
    // happen while somebody is reading.
    const cache = cacheFor(store, 12 * 1024);
    hydrateThrough(store, undefined);
    const controller = await mount(store, presentation);

    // A real message action, focused, and the row it belongs to.
    // Read an older part of the conversation: scroll the real viewport there
    // and let the controller do what it does with a scroll.
    const viewport = container.querySelector<HTMLElement>('[data-slot="thread-viewport"]')!;
    scrolled = 24 * ROW - 900;
    await act(async () => {
      Object.defineProperty(viewport, "scrollTop", { value: scrolled, configurable: true, writable: true });
      Object.defineProperty(viewport, "clientHeight", { value: 900, configurable: true });
      Object.defineProperty(viewport, "scrollHeight", { value: 24 * ROW, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));
    });
    await act(async () => { await Promise.resolve(); });
    // The newest turn, which is where a reader lands and which the transcript
    // is showing: the surface picks it, the test only names it.
    const knownId = rowIds().at(-1)!;
    expect(knownId).toBe("entry:e23");
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

    // Reading an older part of the conversation: scroll there and let the
    // viewport publish what it is standing on. No timer is guessed — the
    // publication itself is what is waited for.
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
    if (!after.trimmed) throw new Error(`no trim: blocks=${after.blocks.length} counters=${JSON.stringify(cache.counters().bytes)} limit=${12 * 1024}`);
    expect(after.trimmed).toBeDefined();
    expect(after.blocks.length).toBeLessThan(beforeTrim.blocks.length);
    expect(frames.every(count => count > 0)).toBe(true);
    expect(rowIds().length).toBeGreaterThan(0);

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

    // The action still names the same entry, and prompt ordinals still mean
    // what they meant: the offset rose by exactly the prompts released.
    const releasedPrompts = beforeTrim.blocks.filter(block => block.kind === "user").length
      - after.blocks.filter(block => block.kind === "user").length;
    expect(after.history!.userOffset).toBe(offsetBefore + releasedPrompts);
    expect(after.blocks.some(block => "entryId" in block && block.entryId === knownEntry)).toBe(true);
    expect(after.entries.some(record => (record as { id: string }).id === knownEntry)).toBe(true);
    for (const id of rowIds()) expect(rowsBefore).toContain(id);

    // The stamp carries what the surface was standing on, as entry ids.
    expect(after.trimmed?.identities?.focusedEntryId).toBe(knownEntry);

    cache.dispose();
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
      const seen = store.getSnapshot();
      const update = { type: "notification", method: "session/update", params: { sessionPath: SESSION, seq: 25, at: "", update: { kind: "state", state: seen.open[SESSION]!.state } } };
      store.dispatch(update as never);
      cache.observeTransaction(update as never, seen, store.getSnapshot());
      cache.maintain();
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
