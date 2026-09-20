// @vitest-environment happy-dom
/**
 * The transcript controller's own contract: identity, destinations, actions,
 * held rows and the unloaded-history model (M16-T87, D-303).
 *
 * Geometry is not here any more. The mounted window and every scroll
 * adjustment belong to one engine now, and they are measured where they can
 * only be measured honestly — over a browser that lays the transcript out,
 * in `transcript-virtualization.test.tsx`. This file was rewritten with that
 * split, and the tests it lost are listed in that file's header, each with
 * where it went or why the behaviour it pinned no longer exists.
 */
import { describe, expect, it, vi } from "vitest";
import { TranscriptViewport } from "../../src/components/thread/transcript-viewport.js";
import {
  HistoryPlaceholder,
  PLACEHOLDER_TURN_HEIGHT,
  placeholderTurnCeiling,
  placeholderTurnTarget,
} from "../../src/components/thread/history-reserve.js";

describe("scoped transcript destinations", () => {
  it("settles cancellation without waiting for an unloaded-entry request", async () => {
    const controller = new TranscriptViewport(); controller.configure("/one");
    let resolve!: () => void;
    const pending = controller.ensureVisible({ messageId: "old" }, { reason: "find", locate: () => new Promise<void>(done => { resolve = done; }) });
    controller.configure("/two");
    expect(await pending).toBe("cancelled");
    resolve();
    expect(await controller.ensureVisible({ messageId: "absent" }, { reason: "map" })).toBe("missing");
  });

  it("cancels a scheduled mount/focus when its caller closes", async () => {
    const controller = new TranscriptViewport(); controller.configure("/one"); controller.setIds(["message"]);
    const abort = new AbortController();
    const pending = controller.ensureVisible({ messageId: "message" }, { reason: "focus", signal: abort.signal });
    abort.abort(); expect(await pending).toBe("cancelled");
  });

  it("keeps main and Beam intents independent even at the same canonical path", async () => {
    const main = new TranscriptViewport(), beam = new TranscriptViewport();
    main.configure("/same"); beam.configure("/same");
    main.setIds(["row"]); beam.setIds(["row"]);
    const pending = main.ensureVisible({ messageId: "row" }, { reason: "find" });
    beam.cancel();
    // Beam cancelling its own surface says nothing about the main one; the
    // main destination ends because its own surface has no engine to land on.
    expect(await pending).toBe("missing");
  });

  it("refuses a destination whose version is not the one on screen", async () => {
    const controller = new TranscriptViewport();
    controller.configure("/versions", "leaf-one");
    controller.setIds(["row"]);
    expect(await controller.ensureVisible({ messageId: "row", leafId: "leaf-two" }, { reason: "action" })).toBe("cancelled");
  });
});

describe("actions that move the conversation", () => {
  it("waits for the accepted branch commit before locating its version", async () => {
    const controller = new TranscriptViewport();
    controller.configure("/versions", "old-leaf");
    controller.setIds(["old"]);
    const locate = vi.spyOn(controller, "ensureVisible").mockResolvedValue("visible");
    const ticket = controller.startAction();
    const pending = controller.afterAction(ticket, { messageId: "new", leafId: "new-leaf" });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(locate).not.toHaveBeenCalled();
    controller.configure("/versions", "new-leaf"); controller.setIds(["new"]);
    await pending;
    expect(locate).toHaveBeenCalledWith({ messageId: "new", leafId: "new-leaf" }, { reason: "action" });
  });

  it("does not locate an accepted version after a later person intent", async () => {
    const controller = new TranscriptViewport();
    controller.configure("/versions", "old-leaf");
    const locate = vi.spyOn(controller, "ensureVisible").mockResolvedValue("visible");
    const pending = controller.afterAction(controller.startAction(), { messageId: "new", leafId: "new-leaf" });
    controller.cancel();
    controller.configure("/versions", "new-leaf"); controller.setIds(["new"]);
    await pending;
    expect(locate).not.toHaveBeenCalled();
  });

  it("takes a settled action back to the newest turn", async () => {
    const controller = new TranscriptViewport();
    controller.configure("/action");
    controller.setIds(["one", "two"]);
    const latest = vi.spyOn(controller, "latest");
    await controller.afterAction(controller.startAction());
    expect(latest).toHaveBeenCalledOnce();
  });
});

/**
 * A gesture is what the person can actually do with the scroller. The engine
 * owns where the transcript goes; this is only the question of when a person's
 * movement ends a destination and this surface's claim on the live edge.
 */
describe("gestures that move nothing", () => {
  /** Long enough for a cancellation to have settled its promise if it came. */
  const drain = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  /** A scroller with room below the reader and none above them. */
  function scroller(scrollTop: number, total = 2_000) {
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, clientWidth: { value: 600 }, scrollHeight: { value: total } });
    viewport.scrollTop = scrollTop;
    return viewport;
  }

  it("does not cancel a destination for a no-op wheel at the bottom", async () => {
    const controller = new TranscriptViewport(), viewport = scroller(1_400);
    controller.configure("/destination");
    const detach = controller.attach(viewport);
    try {
      let settled = false;
      const pending = controller.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(() => {}) })
        .finally(() => { settled = true; });
      // Further down, from the end: the browser has nowhere to take them.
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
      await drain();
      expect(settled, "a wheel that could move nothing ended the destination").toBe(false);
      // Upwards is movement, and movement is the person saying where they are
      // going instead.
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
      expect(await pending).toBe("cancelled");
    } finally { detach(); }
  });

  it("keeps a destination through a no-op Space at the bottom", async () => {
    const controller = new TranscriptViewport(), viewport = scroller(1_400);
    controller.configure("/space");
    const detach = controller.attach(viewport);
    try {
      let settled = false;
      const pending = controller.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(() => {}) })
        .finally(() => { settled = true; });
      // Space is a page down, and the page below is already the last one.
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      await drain();
      expect(settled, "a page down at the last page ended the destination").toBe(false);
      // Shift+Space is a page up, and there is a conversation above.
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, shiftKey: true }));
      expect(await pending).toBe("cancelled");
    } finally { detach(); }
  });

  it("keeps a destination through a touch that never becomes a drag", async () => {
    const controller = new TranscriptViewport(), viewport = scroller(1_400);
    controller.configure("/touch");
    const detach = controller.attach(viewport);
    try {
      let settled = false;
      const pending = controller.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(() => {}) })
        .finally(() => { settled = true; });
      const touch = (type: string, clientY: number) => {
        const event = new Event(type, { bubbles: true }) as Event & { touches: { clientY: number }[] };
        Object.defineProperty(event, "touches", { value: [{ clientY }] });
        viewport.dispatchEvent(event);
      };
      touch("touchstart", 400);
      await drain();
      expect(settled, "a tap ended the destination").toBe(false);
      // The same finger, moved: the person is taking the conversation upwards.
      touch("touchmove", 460);
      expect(await pending).toBe("cancelled");
    } finally { detach(); }
  });
});

describe("earlier-history requests", () => {
  it("tracks requests in flight and is idempotent about ending them", () => {
    const controller = new TranscriptViewport();
    controller.configure("/history");
    expect(controller.loadingEarlier).toBe(false);
    controller.beginEarlierPage();
    expect(controller.loadingEarlier).toBe(true);
    controller.beginEarlierPage();
    controller.finishEarlierPage();
    expect(controller.loadingEarlier).toBe(true);
    controller.finishEarlierPage();
    expect(controller.loadingEarlier).toBe(false);
    controller.finishEarlierPage();
    expect(controller.loadingEarlier).toBe(false);
    controller.beginEarlierPage();
    controller.cancelEarlierPage();
    expect(controller.loadingEarlier).toBe(false);
    // Leaving the conversation takes its requests with it.
    controller.beginEarlierPage();
    controller.configure("/elsewhere");
    expect(controller.loadingEarlier).toBe(false);
  });

  it("answers the continuous-paging question with a no while nothing is mounted", () => {
    const controller = new TranscriptViewport();
    controller.configure("/history");
    expect(controller.isReadingHistoryReserve()).toBe(false);
    expect(controller.needsPrefetch()).toBe(false);
    expect(controller.reserveDistance()).toBe(Infinity);
  });

  it("wants a prefetch while the reserve is within two screens of the reader, including off-screen", () => {
    const controller = new TranscriptViewport();
    controller.configure("/history");
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    const reserve = document.createElement("div");
    reserve.setAttribute("data-slot", "history-reserve");
    content.append(reserve);
    viewport.append(content);
    Object.defineProperties(viewport, {
      clientHeight: { value: 900 },
      getBoundingClientRect: { value: () => ({ top: 0, bottom: 900, height: 900, left: 0, right: 600, width: 600, x: 0, y: 0, toJSON: () => ({}) }) },
    });
    let reserveBottom = 100;
    const reserveHeight = 288;
    Object.defineProperty(reserve, "getBoundingClientRect", {
      value: () => ({
        top: reserveBottom - reserveHeight, bottom: reserveBottom, height: reserveHeight,
        left: 0, right: 600, width: 600, x: 0, y: reserveBottom - reserveHeight, toJSON: () => ({}),
      }),
    });
    const placeReserve = (bottom: number) => { reserveBottom = bottom; };
    controller.setViewport(viewport);
    controller.setHistoryWindow(40, "cursor");
    expect(controller.placeholderTurns).toBeGreaterThan(0);
    expect(controller.isReadingHistoryReserve()).toBe(true);
    expect(controller.needsPrefetch()).toBe(true);
    expect(controller.reserveDistance()).toBe(-100);
    // One screen above the reader: no longer in the reserve, still within the prefetch margin.
    placeReserve(-900);
    expect(controller.isReadingHistoryReserve()).toBe(false);
    expect(controller.needsPrefetch()).toBe(true);
    expect(controller.reserveDistance()).toBe(900);
    // More than two screens above: stop prefetching.
    placeReserve(-2000);
    expect(controller.isReadingHistoryReserve()).toBe(false);
    expect(controller.needsPrefetch()).toBe(false);
    expect(controller.reserveDistance()).toBe(2000);
  });
});

describe("how much unloaded history stands in front of the reader", () => {
  it("is bounded to three screens of turns, and never claims the root while a cursor remains", () => {
    expect(placeholderTurnCeiling(900)).toBe(Math.round((900 * 3) / PLACEHOLDER_TURN_HEIGHT));
    expect(placeholderTurnCeiling(undefined)).toBe(3);
    expect(placeholderTurnCeiling(0)).toBe(3);
    expect(placeholderTurnTarget({ hasBefore: false, unloadedUserTurns: 400, mayGrow: true })).toBe(0);
    expect(placeholderTurnTarget({ hasBefore: true, unloadedUserTurns: 400, viewportHeight: 900, mayGrow: true })).toBe(placeholderTurnCeiling(900));
    expect(placeholderTurnTarget({ hasBefore: true, unloadedUserTurns: 2, viewportHeight: 900, mayGrow: true })).toBe(2);
    // A tool-heavy turn can hold a whole page of rows behind one prompt, so a
    // producer that says "zero or one prompt" is saying "unknown", not "none".
    expect(placeholderTurnTarget({ hasBefore: true, unloadedUserTurns: 0, viewportHeight: 900, mayGrow: true })).toBe(2);
  });

  it("gives its turns to arriving pages and grows back only when told it may", () => {
    const placeholder = new HistoryPlaceholder();
    const input = { hasBefore: true, unloadedUserTurns: 400, viewportHeight: 900, mayGrow: false };
    expect(placeholder.configure(input)).toBe(true);
    const ceiling = placeholderTurnCeiling(900);
    expect(placeholder.turns).toBe(ceiling);
    expect(placeholder.arrived(3)).toBe(true);
    expect(placeholder.turns).toBe(ceiling - 3);
    // Held still: a reader who has not stopped moving gets no new space.
    expect(placeholder.configure(input)).toBe(false);
    expect(placeholder.turns).toBe(ceiling - 3);
    expect(placeholder.configure({ ...input, mayGrow: true })).toBe(true);
    expect(placeholder.turns).toBe(ceiling);
  });

  it("never gives away the turns the reader is looking at", () => {
    const placeholder = new HistoryPlaceholder();
    placeholder.configure({ hasBefore: true, unloadedUserTurns: 400, viewportHeight: 900, mayGrow: true });
    const ceiling = placeholder.turns;
    // Four turns are on screen: a page may only take what is below the fold.
    expect(placeholder.arrived(ceiling, 4)).toBe(true);
    expect(placeholder.turns).toBe(4);
    expect(placeholder.arrived(4, 4)).toBe(false);
    expect(placeholder.turns).toBe(4);
    // And the producer running out of prompts cannot take them either.
    placeholder.configure({ hasBefore: true, unloadedUserTurns: 1, viewportHeight: 900, mayGrow: true, minimum: 4 });
    expect(placeholder.turns).toBe(4);
  });

  it("disappears the moment the producer has no cursor", () => {
    const placeholder = new HistoryPlaceholder();
    placeholder.configure({ hasBefore: true, unloadedUserTurns: 40, viewportHeight: 900, mayGrow: true });
    expect(placeholder.turns).toBeGreaterThan(0);
    placeholder.configure({ hasBefore: false, unloadedUserTurns: 0, viewportHeight: 900, mayGrow: false, minimum: 4 });
    expect(placeholder.turns).toBe(0);
    expect(placeholder.arrived(2)).toBe(false);
  });
});
