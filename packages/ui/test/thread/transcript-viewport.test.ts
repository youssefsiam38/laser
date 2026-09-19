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
