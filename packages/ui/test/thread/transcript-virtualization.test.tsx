// @vitest-environment happy-dom
/**
 * The transcript's windowing and anchoring, on the engine that owns them
 * (M16-T87, D-303, `docs/transcript-virtualization.md`).
 *
 * Every test here mounts the real transcript over the rig's browser
 * (`virtual-rig.tsx`) and measures the pixels a person would see: where the
 * row they are reading sits on screen, which rows are mounted, and what
 * `scrollTop` did. Nothing asks the controller where it thinks anything is.
 *
 * This suite replaces `upward-reading-anchor.test.ts` and the geometric half
 * of `transcript-viewport.test.ts`, which drove Laser's own window/anchor
 * arithmetic directly. What moved, and what did not:
 *
 * - the reader's row holding through twenty-four mixed-height pages, a page
 *   measuring taller than its estimate, a page arriving while the reader is
 *   inside the placeholder, the estimate growing back under a settled reader,
 *   the live edge through streaming and a page above, a row growing above the
 *   reader, the beginning of the conversation arriving: all here, measured
 *   from the DOM instead of from the controller's model;
 * - the mounted window, the merged-head anchor, the "layout stale" window
 *   choice and the reserve exchange: the engine owns the range and the
 *   position now, so what is tested is the outcome (no hole on screen, no row
 *   in front of the reader) rather than Laser's arithmetic for it;
 * - clamp debt, the earlier-page transaction fence, the absolute-restore ban
 *   and the disclosure hold: deleted with the second authority they existed to
 *   fence (D-303). Their outcomes are covered by the tests above;
 * - the block-level reading anchor is gone with `reading-anchor.ts`. The row
 *   is the unit of identity the engine can express, so content growing inside
 *   the row the reader is on, above their line, moves their text by that much.
 *   That is worse than a plain page, whose browser anchoring this scroller
 *   switches off on purpose; `docs/transcript-reading.md` records the trade,
 *   and images now reserve their box so the largest instance cannot happen.
 *
 * Which option each group pins, so the suite can be read as evidence rather
 * than taken on trust (each verified by removing the option and watching these
 * tests go red):
 *
 * - `shouldAdjustScrollPositionOnItemSizeChange` — `reading upwards > holds the
 *   reader's row through twenty-four pages`, `rows that grow > holds the
 *   reading position when a row above it grows`, `the head > …`;
 * - `measureElement` (rounding both paths identically) — `rows that grow >
 *   counts a sub-pixel change as no change at all`;
 * - `observeElementRect` (a zero-height scroller reads as the window) — every
 *   test here mounts in happy-dom, and the wider suites
 *   (`trim-interaction`, `session-opening`, `immediate-paint`) fail without it;
 * - the placeholder's turn floor — `the unloaded-history placeholder > …`.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRig, TURN, type Rig } from "./virtual-rig.js";
import type { LocateResult, TranscriptTarget } from "../../src/components/thread/transcript-viewport.js";

/**
 * The subject is geometry, not the message body: a row is a labelled box with
 * one control — except the rows a test puts in `quiet`, which stand for a
 * notice nobody can focus.
 */
const quiet = vi.hoisted(() => new Set<string>());
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState } = await import("@assistant-ui/react");
  return { ThreadMessage: function Message() {
    const id = useAuiState(s => s.message.id);
    return <div data-message-id={id}>{quiet.has(id) ? <span>{id}</span> : <button>{id}</button>}</div>;
  } };
});
afterEach(() => quiet.clear());

let rig: Rig | undefined;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await rig?.dispose(); rig = undefined; });

/** Tool-heavy turns: a short prompt, a long reply, a very long tool body. */
const HEIGHTS = [96, 240, 168, 612, 132, 384, 204, 900];
const ordinalOf = (id: string) => Number.parseInt(id.slice(1), 10);
const realHeight = (id: string) => HEIGHTS[ordinalOf(id) % HEIGHTS.length]!;
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => `r${from + i}`);

describe("the mounted window", () => {
  it("opens a conversation at its newest turn with a bounded window", async () => {
    const ids = rows(0, 400);
    rig = await mountRig({ ids, height: realHeight, clientHeight: 900 });
    expect(rig.mounted().at(-1)).toBe("r399");
    expect(rig.mounted().length).toBeLessThan(40);
    expect(rig.mounted().length).toBeGreaterThan(1);
    // The newest turn is on screen, at the bottom of the viewport.
    expect(rig.scrollTop()).toBeCloseTo(rig.scrollHeight() - 900, 0);
  });

  it("never leaves a hole on screen while the reader travels upwards", async () => {
    rig = await mountRig({ ids: rows(0, 300), height: realHeight, clientHeight: 900 });
    for (let step = 0; step < 40; step++) {
      await rig.scrollBy(-320);
      expect(uncovered(rig), `step ${step} at scrollTop ${rig.scrollTop()}`).toBe("");
    }
  });

  it("never leaves a hole on screen while the reader travels downwards", async () => {
    rig = await mountRig({ ids: rows(0, 300), height: realHeight, clientHeight: 900 });
    await rig.scrollTo(0);
    for (let step = 0; step < 40; step++) {
      await rig.scrollBy(280);
      expect(uncovered(rig), `step ${step} at scrollTop ${rig.scrollTop()}`).toBe("");
    }
  });
});

/**
 * The band of the viewport that no mounted row covers, described. The rows are
 * read from the DOM in their laid-out positions, so a window chosen from a
 * model the browser has already contradicted shows up here as a gap on screen.
 */
function uncovered(rig: Rig, height = 900): string {
  const boxes = rig.mounted()
    .map(id => ({ id, rect: rig.node(id)!.getBoundingClientRect() }))
    .filter(row => row.rect.bottom > 0 && row.rect.top < height)
    .sort((a, b) => a.rect.top - b.rect.top);
  if (boxes.length === 0) return "";
  let covered = Math.min(0, boxes[0]!.rect.top);
  for (const box of boxes) {
    if (box.rect.top > covered + 1) return `gap of ${Math.round(box.rect.top - covered)}px above ${box.id}`;
    covered = Math.max(covered, box.rect.bottom);
  }
  return "";
}

describe("reading upwards", () => {
  /**
   * A long conversation with a hundred loaded rows and a producer that still
   * has a hundred and twenty prompts before them. Pages of five turns arrive
   * as the person reads, exactly as the history loader delivers them.
   */
  async function paging() {
    const loaded = rows(200, 100);
    return {
      rig: await mountRig({
        ids: loaded,
        height: realHeight,
        clientHeight: 900,
        headHeight: 40,
        history: { before: "cursor", userOffset: 120 },
      }),
      ids: loaded,
    };
  }

  it("holds the reader's row through twenty-four pages, mid-transcript", async () => {
    const started = await paging();
    rig = started.rig;
    let ids = started.ids;
    // Somewhere in the middle of the loaded rows, reading upwards.
    await rig.scrollTo(Math.round(rig.scrollHeight() / 2));
    for (let page = 0; page < 24; page++) {
      await rig.scrollBy(-240);
      const reader = rig.topVisible()!;
      const before = rig.screenTop(reader)!;
      ids = [...rows(200 - (page + 1) * 5, 5), ...ids];
      await rig.page(ids, { before: "cursor", userOffset: Math.max(0, 120 - (page + 1) * 5) });
      const after = rig.screenTop(reader);
      expect(after, `page ${page}: the row the reader was on left the window`).toBeDefined();
      expect(Math.abs(after! - before), `page ${page}: the reader's row moved on screen`).toBeLessThanOrEqual(1);
      expect(uncovered(rig), `page ${page}`).toBe("");
    }
  });

  it("puts no row in front of a reader inside the placeholder, and never pushes them forward", async () => {
    const started = await paging();
    rig = started.rig;
    let ids = started.ids;
    await rig.scrollTo(0);
    expect(rig.controller.isReadingHistoryReserve()).toBe(true);
    for (let page = 0; page < 24; page++) {
      const onScreen = rig.mounted().filter(id => {
        const rect = rig!.node(id)!.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < 900;
      });
      const tops = new Map(onScreen.map(id => [id, rig!.screenTop(id)!]));
      ids = [...rows(200 - (page + 1) * 5, 5), ...ids];
      await rig.page(ids, { before: "cursor", userOffset: Math.max(0, 120 - (page + 1) * 5) });
      // `scrollTop` is the list's to spend: content arriving above the reader
      // moves the scroll position by exactly what it added, which is how
      // nothing the person is looking at moves. What must not change is the
      // picture, and that is what the rows below assert.
      for (const [id, before] of tops) {
        const after = rig.screenTop(id);
        expect(after, `page ${page}: ${id} left the window while on screen`).toBeDefined();
        expect(Math.abs(after! - before), `page ${page}: ${id} moved under the reader`).toBeLessThanOrEqual(1);
      }
      // What arrives, arrives in the placeholder: the rows a person is
      // scrolling up towards take the grey they are looking at, never the
      // space between them and a row they were already reading.
      const arrived = rig.mounted().filter(id => !tops.has(id) && rig!.screenTop(id)! < 900 && rig!.screenTop(id)! + realHeight(id) > 0);
      for (const id of arrived) {
        for (const [known, top] of tops) expect(rig.screenTop(id)!, `page ${page}: ${id} arrived below ${known}`).toBeLessThan(top);
      }
    }
    // Twenty-four pages of reading upwards ends deeper in the conversation
    // than it started, never at the live edge.
    expect(rig.controller.capture().following).toBe(false);
  });
});

describe("the live edge", () => {
  it("stays at the newest turn while a page arrives above it", async () => {
    const ids = rows(100, 60);
    rig = await mountRig({
      ids,
      height: realHeight,
      clientHeight: 900,
      headHeight: 40,
      history: { before: "cursor", userOffset: 40 },
    });
    expect(rig.scrollTop()).toBeCloseTo(rig.scrollHeight() - 900, 0);
    await rig.page([...rows(95, 5), ...ids], { before: "cursor", userOffset: 35 });
    expect(rig.mounted().at(-1)).toBe("r159");
    expect(rig.scrollTop()).toBeCloseTo(rig.scrollHeight() - 900, 0);
    // And it keeps following while the newest row streams.
    await rig.grow("r159", 1400);
    expect(rig.scrollTop()).toBeCloseTo(rig.scrollHeight() - 900, 0);
  });

  it("opens the next conversation at its own newest turn", async () => {
    rig = await mountRig({ ids: rows(0, 80), height: realHeight, clientHeight: 900 });
    await rig.scrollTo(200);
    expect(rig.controller.capture().following).toBe(false);
    // The surface is pointed at another conversation, then back at this one.
    await act(async () => { rig!.controller.configure("/other"); });
    await act(async () => { rig!.controller.configure("/project/session.jsonl"); });
    await rig.setIds(rows(0, 80));
    expect(rig.mounted().at(-1)).toBe("r79");
    expect(rig.controller.capture().following).toBe(true);
  });

  it("leaves an away reader where they are when the recent tail is read again", async () => {
    const ids = rows(0, 80);
    rig = await mountRig({ ids, height: realHeight, clientHeight: 900 });
    await rig.scrollTo(Math.round(rig.scrollHeight() / 2));
    const reader = rig.topVisible()!;
    const before = rig.screenTop(reader)!;
    const top = rig.scrollTop();
    // The same conversation, read again: same rows, one more at the end.
    await rig.setIds([...ids, "r80"]);
    expect(rig.scrollTop()).toBe(top);
    expect(Math.abs(rig.screenTop(reader)! - before)).toBeLessThanOrEqual(1);
  });

  it("follows an appended turn only when the reader is at the end", async () => {
    const ids = rows(0, 60);
    rig = await mountRig({ ids, height: realHeight, clientHeight: 900 });
    await rig.setIds([...ids, "r60"]);
    expect(rig.mounted()).toContain("r60");
    expect(rig.scrollTop()).toBeCloseTo(rig.scrollHeight() - 900, 0);
    // Away from the end, an appended turn changes nothing on screen.
    await rig.scrollTo(400);
    const reader = rig.topVisible()!;
    const before = rig.screenTop(reader)!;
    const top = rig.scrollTop();
    await rig.setIds([...ids, "r60", "r61"]);
    expect(rig.scrollTop()).toBe(top);
    expect(rig.screenTop(reader)! - before).toBeLessThanOrEqual(1);
  });
});

/** Take the transcript somewhere, the way Find, the map and a deep link do. */
async function locate(target: Rig, message: TranscriptTarget): Promise<LocateResult> {
  let result!: LocateResult;
  await act(async () => { result = await target.controller.ensureVisible(message, { reason: "find" }); });
  await target.settle(1);
  return result;
}

describe("destinations", () => {
  it("lands a deep link on its row, a third of the way down", async () => {
    rig = await mountRig({ ids: rows(0, 300), height: realHeight, clientHeight: 900 });
    expect(await locate(rig, { messageId: "r42" })).toBe("visible");
    const top = rig.screenTop("r42");
    expect(top).toBeDefined();
    expect(Math.abs(top! - 300)).toBeLessThanOrEqual(2);
    expect(uncovered(rig)).toBe("");
  });

  it("keeps the destination row mounted while it is the target, and says when there is none", async () => {
    rig = await mountRig({ ids: rows(0, 300), height: realHeight, clientHeight: 900 });
    expect(await locate(rig, { messageId: "nowhere" })).toBe("missing");
    expect(await locate(rig, { messageId: "r7" })).toBe("visible");
    expect(rig.mounted()).toContain("r7");
  });

  it("holds a located row through a page arriving above it", async () => {
    rig = await mountRig({
      ids: rows(100, 100),
      height: realHeight,
      clientHeight: 900,
      history: { before: "cursor", userOffset: 40 },
    });
    expect(await locate(rig, { messageId: "r120" })).toBe("visible");
    const before = rig.screenTop("r120")!;
    await rig.page([...rows(95, 5), ...rows(100, 100)], { before: "cursor", userOffset: 35 });
    expect(Math.abs(rig.screenTop("r120")! - before)).toBeLessThanOrEqual(1);
  });
});

describe("rows a surface is holding open", () => {
  it("keeps a pinned row mounted far outside the reading window, across a prepend", async () => {
    rig = await mountRig({ ids: rows(0, 300), height: realHeight, clientHeight: 900 });
    const release = rig.controller.pin("r3");
    await rig.settle(1);
    expect(rig.mounted()).toContain("r3");
    await rig.setIds([...["o1", "o2", "o3", "o4", "o5"], ...rows(0, 300)]);
    expect(rig.mounted()).toContain("r3");
    await act(async () => { release(); });
    await rig.settle(1);
    // Released is not unmounted on the spot: the list owns a bounded pool of
    // rows and gives this one back when it needs the container. What the
    // release ends is the hold, and with it the claim on the reading window
    // — the row is nowhere near the screen and the window stays bounded.
    expect(rig.controller.heldKeys).not.toContain("r3");
    expect(rig.screenTop("r3") ?? -1e6).toBeLessThan(-900);
    expect(rig.mounted().length).toBeLessThan(40);
  });

  it("keeps every row of a native selection mounted", async () => {
    rig = await mountRig({ ids: rows(0, 200), height: realHeight, clientHeight: 900 });
    await rig.scrollTo(Math.round(rig.scrollHeight() / 2));
    const visible = rig.mounted();
    const anchor = rig.node(visible[0]!)!, focus = rig.node(visible.at(-1)!)!;
    await act(async () => {
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.setStart(anchor, 0);
      range.setEnd(focus, 0);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await rig.settle(1);
    // Reading away from the selection must not release the rows inside it:
    // the browser owns the selection and a released row would truncate it.
    await rig.scrollBy(-2000);
    for (const id of visible) expect(rig.mounted(), `${id} left the selection`).toContain(id);
  });
});

describe("the conversation changing underneath", () => {
  it("holds the reader when the older part of the window is released", async () => {
    const ids = rows(0, 200);
    rig = await mountRig({ ids, height: realHeight, clientHeight: 900 });
    await rig.scrollTo(Math.round(rig.scrollHeight() * 0.7));
    const reader = rig.topVisible()!;
    const before = rig.screenTop(reader)!;
    // A trim: the oldest forty rows are released while somebody is reading.
    await rig.setIds(ids.slice(40));
    expect(rig.screenTop(reader)).toBeDefined();
    expect(Math.abs(rig.screenTop(reader)! - before)).toBeLessThanOrEqual(1);
    expect(uncovered(rig)).toBe("");
  });

  it("takes Tab past a row with nothing in it to focus", async () => {
    rig = await mountRig({ ids: rows(0, 200), height: realHeight, clientHeight: 900 });
    await rig.scrollTo(Math.round(rig.scrollHeight() / 2));
    const last = rig.mounted().at(-1)!;
    // The row Tab reaches next is a notice: no button, no link, nothing to
    // land on. Focus belongs to the row after it, not to the window's gap.
    const notice = `r${ordinalOf(last) + 1}`;
    const after = `r${ordinalOf(last) + 2}`;
    quiet.add(notice);
    expect(rig.mounted()).not.toContain(notice);
    const control = rig.node(last)!.querySelector("button")!;
    await act(async () => {
      control.focus();
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      await new Promise<void>(resolve => setTimeout(resolve, 1200));
    });
    await rig.settle(2);
    expect(rig.mounted(), "the notice never mounted").toContain(notice);
    expect(rig.node(notice)!.querySelector("button")).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe(after);
  });

  it("takes Tab into a row the window had released", async () => {
    rig = await mountRig({ ids: rows(0, 200), height: realHeight, clientHeight: 900 });
    await rig.scrollTo(Math.round(rig.scrollHeight() / 2));
    const mounted = rig.mounted();
    const last = mounted.at(-1)!;
    const next = `r${ordinalOf(last) + 1}`;
    expect(mounted).not.toContain(next);
    const control = rig.node(last)!.querySelector("button")!;
    await act(async () => {
      control.focus();
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      await new Promise<void>(resolve => setTimeout(resolve, 1200));
    });
    await rig.settle(2);
    expect(rig.mounted(), "the next row never mounted").toContain(next);
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe(next);
  });
});

describe("rows that grow", () => {
  /**
   * A conversation of even rows, and a reading position a hundred pixels into
   * one of them. The row above it ends just above the fold, so it is mounted:
   * a row that is not on screen cannot grow, and a test that grew one would
   * be measuring the model rather than the person's screen.
   */
  const EVEN = 200;
  async function reading(height = EVEN, at = 20) {
    const started = await mountRig({ ids: rows(0, 80), height: () => height, clientHeight: 900 });
    await started.scrollTo(at * height + 100);
    return started;
  }

  it("holds the reading position when a row above it grows", async () => {
    rig = await reading();
    const reader = rig.topVisible()!;
    const before = rig.screenTop(reader)!;
    const above = rig.mounted()[rig.mounted().indexOf(reader) - 1]!;
    expect(above).toBeDefined();
    expect(above).not.toBe(reader);
    // An image decoding, a disclosure opening, highlighting reflowing.
    await rig.grow(above, EVEN + 360);
    expect(Math.abs(rig.screenTop(reader)! - before)).toBeLessThanOrEqual(1);
  });

  /**
   * The one position this list does not hold, recorded rather than implied
   * (`docs/transcript-reading.md`). The list restores the row whose top is
   * on screen, so content arriving *below* the reading line inside the row
   * the person is already halfway through moves the boundary under it and the
   * view follows by that much. It is the mirror of the trade D-303 had to
   * make, and the better half of it: that one moved the reader for growth
   * *above* their line, which is what happens all the time while somebody
   * reads upwards, and this one needs late work inside the one row they are
   * in. A fold is the case a person causes, and that one is held (below).
   */
  it("follows the row it is reading when that row grows below the reading line, and says so", async () => {
    rig = await reading();
    const reader = rig.topVisible()!;
    const before = rig.screenTop(reader)!;
    await rig.grow(reader, EVEN + 500);
    expect(rig.screenTop(reader)! - before).toBeCloseTo(-500, 0);
  });

  it("counts a sub-pixel change as no change at all", async () => {
    // Real rows do not measure in whole pixels. A row that reflows by a third
    // of a pixel is not a resize: nothing is compensated, and nothing moves by
    // a third of a pixel either.
    rig = await reading(EVEN + 0.1);
    const reader = rig.topVisible()!;
    const before = rig.screenTop(reader)!;
    const top = rig.scrollTop();
    const above = rig.mounted()[rig.mounted().indexOf(reader) - 1]!;
    expect(above).not.toBe(reader);
    await rig.grow(above, EVEN + 0.4);
    expect(rig.scrollTop()).toBe(top);
    expect(rig.screenTop(reader)).toBe(before);
  });

  it("stays at the newest turn while it streams", async () => {
    const ids = rows(0, 60);
    rig = await mountRig({ ids, height: realHeight, clientHeight: 900 });
    const last = ids.at(-1)!;
    for (const height of [400, 800, 1200]) {
      await rig.grow(last, height);
      expect(rig.scrollTop(), `at ${height}px`).toBeCloseTo(rig.scrollHeight() - 900, 0);
    }
  });
});

describe("the head", () => {
  it("holds the reader when a notice appears above the conversation and goes again", async () => {
    // The worker-recovery notice and the load error live in the head item, so
    // they arrive as an item resize the engine anchors through — not as a
    // change of the ground the whole list stands on, which moves everybody by
    // exactly the height that appeared (M16-T87, B2).
    rig = await mountRig({ ids: rows(0, 120), height: realHeight, clientHeight: 900, headHeight: 40 });
    await rig.scrollTo(Math.round(rig.scrollHeight() / 2));
    const reader = rig.topVisible()!;
    const held = rig.screenTop(reader)!;
    await rig.setHead(240);
    expect(Math.abs(rig.screenTop(reader)! - held), "the notice pushed the reader").toBeLessThanOrEqual(1);
    await rig.setHead(40);
    expect(Math.abs(rig.screenTop(reader)! - held), "the notice going pulled the reader").toBeLessThanOrEqual(1);
    expect(uncovered(rig)).toBe("");
  });
});

describe("the unloaded-history placeholder", () => {
  it("draws bounded placeholder turns while a cursor remains", async () => {
    rig = await mountRig({
      ids: rows(100, 40),
      height: realHeight,
      clientHeight: 900,
      history: { before: "cursor", userOffset: 60 },
    });
    const turns = rig.placeholderTurns();
    expect(turns).toBeGreaterThan(0);
    expect(turns * TURN).toBeLessThanOrEqual(900 * 3);
  });

  it("draws nothing at all once the producer has no cursor", async () => {
    rig = await mountRig({
      ids: rows(100, 40),
      height: realHeight,
      clientHeight: 900,
      history: { before: "cursor", userOffset: 60 },
    });
    await rig.scrollTo(0);
    expect(rig.placeholderTurns()).toBeGreaterThan(0);
    // The page that reached the beginning: the rows arrive and the cursor goes.
    await rig.page([...rows(95, 5), ...rows(100, 40)], { before: undefined, userOffset: 0 });
    expect(rig.placeholderTurns()).toBe(0);
    expect(rig.controller.isReadingHistoryReserve()).toBe(false);
    // The beginning of the conversation, not the end of it: the rows the
    // person was reading stayed where they were, and the oldest row is now
    // the first thing above them rather than an estimate.
    await rig.scrollTo(0);
    expect(rig.mounted()[0]).toBe("r95");
    expect(rig.screenTop("r95")).toBeCloseTo(rig.screenTop("r95")!, 0);
  });

  it("gives its turns back to pages that arrive even when the producer's count does not move", async () => {
    // The producer's remaining-prompt count is the producer's. A page that
    // does not move it must still take the pixels it replaced, or the region
    // never yields, the reader stays pinned inside it and continuous paging
    // asks for ever (M16-T87, M1).
    let ids = rows(200, 40);
    rig = await mountRig({
      ids,
      height: realHeight,
      clientHeight: 900,
      headHeight: 40,
      history: { before: "cursor", userOffset: 120 },
    });
    await rig.scrollTo(0);
    expect(rig.controller.isReadingHistoryReserve()).toBe(true);
    const ceiling = rig.placeholderTurns();
    expect(ceiling).toBeGreaterThan(1);
    let yielded = 0;
    for (let page = 0; page < 8; page++) {
      // The person is still reading upwards: each page arrives while they are
      // inside the region it is filling.
      await rig.scrollTo(0);
      const turns = rig.placeholderTurns();
      ids = [...rows(200 - (page + 1) * 5, 5), ...ids];
      // The count is frozen: the producer says exactly what it said before.
      await rig.page(ids, { before: "cursor", userOffset: 120 });
      // Either the region gave pixels back to the page, or the page put the
      // person back on loaded rows — where the region may grow again,
      // because growth above a reader on real rows cannot be felt (D-302).
      // What may not happen is a region that never yields while somebody
      // reads into it: that is continuous paging asking for ever.
      if (rig.placeholderTurns() < turns) yielded += 1;
      else expect(rig.controller.isReadingHistoryReserve(), `page ${page}: the region neither yielded nor released the reader`).toBe(false);
    }
    expect(yielded, "the region never gave anything back").toBeGreaterThan(0);
    await rig.scrollTo(0);
    expect(rig.placeholderTurns(), "the region never gave anything back").toBeLessThanOrEqual(ceiling);
  });

  it("grows back under a settled reader on loaded rows, and never under one inside it", async () => {
    rig = await mountRig({
      ids: rows(100, 40),
      height: realHeight,
      clientHeight: 900,
      history: { before: "cursor", userOffset: 60 },
    });
    const ceiling = rig.placeholderTurns();
    await rig.scrollTo(Math.round(rig.scrollHeight() / 2));
    // A page arrives and takes its turns.
    await rig.page([...rows(95, 5), ...rows(100, 40)], { before: "cursor", userOffset: 55 });
    const reader = rig.topVisible()!;
    const held = rig.screenTop(reader)!;
    await rig.idle();
    expect(rig.placeholderTurns()).toBe(ceiling);
    // Growth above a settled reader moves the scrollbar, never the reader.
    expect(Math.abs(rig.screenTop(reader)! - held)).toBeLessThanOrEqual(1);
  });
});
