// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { TranscriptViewport } from "../../src/components/thread/transcript-viewport.js";

/**
 * Reading upwards through a long conversation, measured (M16-T85).
 *
 * Every other rig in this suite derives a row's position from
 * `controller.heights`, so the model and the layout can never disagree — and
 * the disagreement is the whole defect. Here the layout is the browser's:
 *
 *   - a mounted row occupies its **real** height, whatever the model guessed;
 *   - an unmounted row occupies whatever the model said **at the last render**,
 *     because that is what the virtual spacers were given;
 *   - the estimated range sits above both, also at its last rendered height,
 *     so a model change made after a render — the reserve draining, a row
 *     re-estimated in a measured frame — does not move a single pixel until
 *     the render that carries it, exactly as in a browser;
 *   - the history controls sit above that;
 *   - `scrollTop` is clamped to the scroller, as a real one is.
 *
 * A page therefore arrives with rows the model has only estimated, the reserve
 * changes in the same commit, the rows above the reader are a mixture of
 * measurements and guesses, and the model runs one commit ahead of the
 * pixels. Arithmetic over that mixture is what pushed a person back down every
 * time they scrolled up; the browser's own rectangles are what this controller
 * reads instead.
 */
interface Rig {
  controller: TranscriptViewport;
  viewport: HTMLElement;
  /** Render with these ids: mount exactly the controller's window, then commit. */
  render(ids?: readonly string[]): void;
  frame(): Promise<void>;
  /**
   * The first paint. A first render has no measured geometry at all — the
   * index is built before the type scale is read — so the app renders again
   * from the first measured frame, and so does this.
   */
  start(): Promise<void>;
  /** Let the reading timer expire and give the controller its settled frames. */
  settle(): Promise<void>;
  /** A wheel notch upwards, then the scroll the browser would dispatch. */
  readUp(pixels: number): void;
  /** A scrollbar thumb drag to an absolute position (never reaches `user()`). */
  dragTo(top: number): void;
  scrollTop(): number;
  /** The id at the top of the viewport, or undefined inside the estimate. */
  topVisible(): string | undefined;
  screenTop(id: string): number | undefined;
  /** The mounted row element, for events a real row would dispatch. */
  node(id: string): HTMLElement | undefined;
  /** The screen top of one `.md-body` block inside a row. */
  blockTop(id: string, index: number): number | undefined;
  /** Every `scrollTop` this controller wrote since the last reset. */
  writes(): { from: number; to: number }[];
  /** The writes that actually moved the viewport. */
  moves(): { from: number; to: number }[];
  resetWrites(): void;
  dispose(): void;
}

function layoutRig(options: {
  path: string;
  ids: readonly string[];
  height: (id: string) => number;
  clientHeight: number;
  /** The history controls above the transcript, inside the same scroller. */
  above?: number;
  /**
   * Height of the first block inside a row's `.md-body`. The row then has two
   * blocks — the landmarks a reading position is pinned to — and the second
   * one fills the rest of the row.
   */
  firstBlock?: (id: string) => number | undefined;
}): Rig {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const trace: { from: number; to: number }[] = [];
  (globalThis as { __laserScrollTrace?: unknown[] }).__laserScrollTrace = trace;

  const controller = new TranscriptViewport();
  const viewport = document.createElement("div");
  const content = document.createElement("div");
  const nodes = new Map<string, HTMLElement>();
  const above = options.above ?? 0;
  let ids = [...options.ids];
  let top = 0;
  // What the browser was last given to lay out: the reserve's rendered height
  // and the height every spacer was rendered with. The model may already have
  // moved on; those pixels do not exist until the next render.
  let laidOut = { reserve: 0, heights: new Map<string, number>() };
  const estimated = (id: string) => laidOut.heights.get(id) ?? 0;

  /** Where a row starts inside the scroller: real heights mounted, rendered estimates not. */
  const rowTop = (id: string) => {
    const index = ids.indexOf(id);
    let offset = above + laidOut.reserve;
    for (let i = 0; i < index; i++) {
      const other = ids[i]!;
      offset += nodes.has(other) ? options.height(other) : estimated(other);
    }
    return offset;
  };
  const contentHeight = () => ids.reduce((total, id) => total + (nodes.has(id) ? options.height(id) : estimated(id)), 0);
  const scrollHeight = () => above + laidOut.reserve + contentHeight();
  const maxTop = () => Math.max(0, scrollHeight() - options.clientHeight);
  Object.defineProperties(viewport, {
    clientHeight: { value: options.clientHeight },
    clientWidth: { value: 600 },
    scrollHeight: { get: scrollHeight },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.min(Math.max(0, value), maxTop()); } },
  });
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, options.clientHeight);
  content.getBoundingClientRect = () => new DOMRect(0, above - top, 600, laidOut.reserve + contentHeight());
  content.style.fontSize = "14px";
  content.style.lineHeight = "21px";
  content.style.paddingTop = "20px";
  viewport.append(content);
  document.body.append(viewport);
  controller.content = content;
  controller.configure(options.path);

  const mount = (id: string) => {
    const row = document.createElement("div");
    row.dataset.windowMessage = id;
    row.getBoundingClientRect = () => new DOMRect(0, rowTop(id) - top, 600, options.height(id));
    const first = options.firstBlock?.(id);
    if (first !== undefined) {
      const body = document.createElement("div");
      body.className = "md-body";
      const head = document.createElement("p");
      const rest = document.createElement("p");
      head.getBoundingClientRect = () => new DOMRect(0, rowTop(id) - top, 600, options.firstBlock!(id)!);
      rest.getBoundingClientRect = () => new DOMRect(0, rowTop(id) + options.firstBlock!(id)! - top, 600, Math.max(0, options.height(id) - options.firstBlock!(id)!));
      body.append(head, rest);
      row.append(body);
    }
    content.append(row);
    nodes.set(id, row);
    controller.register(id, row);
  };
  const unmount = (id: string) => {
    nodes.get(id)?.remove();
    nodes.delete(id);
    controller.register(id, null);
  };

  controller.setIds(ids);
  const detach = controller.attach(viewport);
  const render = (next?: readonly string[]) => {
    if (next) {
      ids = [...next];
      for (const id of [...nodes.keys()]) if (!ids.includes(id)) unmount(id);
      controller.setIds(ids);
    }
    // Exactly what `WindowedMessages` does: the controller chooses the window
    // and the spacer heights, React mounts them, the browser lays that out, and
    // only then does the layout effect commit.
    const wanted = new Set(controller.ranges().flatMap(range => ids.slice(range.start, range.end)));
    for (const id of [...nodes.keys()]) if (!wanted.has(id)) unmount(id);
    for (const id of wanted) if (!nodes.has(id)) mount(id);
    laidOut = { reserve: controller.reserveHeight, heights: new Map(ids.map((id, index) => [id, controller.heights.height(index)])) };
    controller.committed();
  };
  const frame = async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
    await Promise.resolve();
  };
  return {
    controller, viewport,
    render,
    frame,
    async start() {
      render();
      await frame();
      render();
      await frame();
    },
    async settle() {
      vi.advanceTimersByTime(450);
      await frame();
      render();
      await frame();
      render();
      await frame();
    },
    readUp(pixels: number) {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      viewport.scrollTop = top - pixels;
      viewport.dispatchEvent(new Event("scroll"));
    },
    dragTo(next: number) {
      const pointer = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(pointer, "offsetX", { value: 610 });
      viewport.dispatchEvent(pointer);
      viewport.scrollTop = next;
      viewport.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("pointerup"));
    },
    scrollTop: () => top,
    topVisible() {
      for (const id of ids) {
        const rect = nodes.get(id)?.getBoundingClientRect();
        if (rect && rect.bottom > 0 && rect.top < options.clientHeight) return id;
      }
      return undefined;
    },
    screenTop(id: string) {
      const node = nodes.get(id);
      return node ? node.getBoundingClientRect().top : undefined;
    },
    node: (id: string) => nodes.get(id),
    blockTop(id: string, index: number) {
      const block = nodes.get(id)?.querySelectorAll("p")[index];
      return block?.getBoundingClientRect().top;
    },
    writes: () => [...trace],
    moves: () => trace.filter(write => Math.abs(write.to - write.from) >= 0.5),
    resetWrites() { trace.length = 0; },
    dispose() {
      detach();
      viewport.remove();
      delete (globalThis as { __laserScrollTrace?: unknown[] }).__laserScrollTrace;
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
}

/** Tool-heavy turns: a short prompt, a long reply, a very long tool body. */
const realHeight = (id: string) => {
  const ordinal = Number.parseInt(id.slice(1), 10);
  return [96, 240, 168, 612, 132, 384, 204, 900][ordinal % 8]!;
};
const row = (ordinal: number) => `r${ordinal}`;
const ordinalOf = (id: string) => Number.parseInt(id.slice(1), 10);

describe("reading upwards on measured rows", () => {
  it("holds the block the person is reading when content grows inside their row above it", async () => {
    // The commonest event of an upward read: the row straddling the top edge
    // is mounted, and an image decodes, highlighting reflows or a late block
    // lands *inside* it, above the paragraph the person is reading. The row's
    // own top does not move, so a rule that holds row tops writes nothing and
    // the person's text slides down the screen. Their place is the block, not
    // the row it happens to be in.
    let decoded = 0;
    const height = (id: string) => (id === "b" ? 600 + decoded : 600);
    const scope = layoutRig({
      path: "/landmark",
      ids: ["a", "b", "c", "d"],
      height,
      clientHeight: 500,
      firstBlock: id => (id === "b" ? 200 + decoded : undefined),
    });
    try {
      await scope.start();
      // Read upwards until row b spans the top edge: its first block is above
      // it, its second block is the text on screen.
      scope.readUp(scope.scrollTop() - 750);
      scope.render();
      await scope.frame();
      await scope.settle();
      const place = scope.controller.capture();
      expect(place.anchor).toMatchObject({ messageId: "b", landmark: 1 });
      const reading = scope.blockTop("b", 1)!;
      expect(reading).toBeGreaterThanOrEqual(0);

      // 200 px of image decode inside that row, above the block being read.
      decoded = 200;
      scope.render();
      await scope.frame();
      scope.render();
      await scope.frame();

      expect(scope.blockTop("b", 1)).toBeCloseTo(reading, 0);
      // And it moved by holding the block, not by refusing to move: the row's
      // own top is 200 px higher than it was, which is what growth above it is.
      expect(scope.scrollTop()).toBeCloseTo(950, 0);
    } finally { scope.dispose(); }
  });

  it("holds the reading block while a disclosure animates open inside their row", async () => {
    // A disclosure opening above the reading position used to be the second
    // authority's own exception: it grows *inside* a row, so the row's top
    // does not move. The measured anchor holds the block instead, from the
    // `ResizeObserver` deliveries the animation itself produces, so the
    // exception is gone — and this is the case that proves it.
    let open = 0;
    const scope = layoutRig({
      path: "/disclosure",
      ids: ["a", "b", "c", "d"],
      height: id => (id === "b" ? 600 + open : 600),
      clientHeight: 500,
      firstBlock: id => (id === "b" ? 200 + open : undefined),
    });
    try {
      await scope.start();
      scope.readUp(scope.scrollTop() - 750);
      scope.render();
      await scope.frame();
      await scope.settle();
      const reading = scope.blockTop("b", 1)!;

      const panel = document.createElement("div");
      panel.dataset.slot = "tool-group-content";
      scope.node("b")!.append(panel);
      panel.dispatchEvent(new Event("animationstart", { bubbles: true }));
      // Two animation frames of the panel opening above the reading block.
      for (const height of [80, 160]) {
        open = height;
        scope.render();
        await scope.frame();
        expect(scope.blockTop("b", 1)).toBeCloseTo(reading, 0);
      }
      panel.dispatchEvent(new Event("animationend", { bubbles: true }));
      scope.render();
      await scope.frame();
      expect(scope.blockTop("b", 1)).toBeCloseTo(reading, 0);
      expect(scope.scrollTop()).toBeCloseTo(910, 0);
    } finally { scope.dispose(); }
  });

  it("never moves the reader back through twenty-four pages of mixed measured and estimated rows", async () => {
    // The replay of the reported session: the person wheels up 900 px at a
    // time, pausing as a reader does; whenever the reading position is in
    // front of the loaded rows the producer answers with another page, exactly
    // as `HistoryControls` asks.
    const OLDEST = 0, PAGE = 6, PAGES = 24;
    let first = 150;
    const scope = layoutRig({ path: "/replay", ids: Array.from({ length: 24 }, (_, i) => row(first + i)), height: realHeight, clientHeight: 780, above: 44 });
    try {
      scope.controller.setHistoryWindow(first - OLDEST, 12, "cursor-150");
      await scope.start();
      scope.viewport.scrollTop = scope.viewport.scrollHeight;
      scope.viewport.dispatchEvent(new Event("scroll"));
      await scope.frame();

      const readings: { ordinal: number; withinRow: number }[] = [];
      const record = () => {
        const id = scope.topVisible();
        if (id) readings.push({ ordinal: ordinalOf(id), withinRow: -(scope.screenTop(id) ?? 0) });
      };
      record();
      let pages = 0, insideEstimateArrivals = 0, onRowArrivals = 0, atTopArrivals = 0, deepArrivals = 0;
      const heldStill: number[] = [];
      const estimateAhead: number[] = [];

      for (let notch = 0; notch < 400 && pages < PAGES; notch++) {
        scope.readUp(900);
        scope.render();
        await scope.frame();
        record();
        // A reader pauses. This is also when the estimate in front of them is
        // allowed to grow back to its bounded size, so most of this replay
        // happens with a multi-screen range above the reading position rather
        // than with the reader pinned against the top of the scroller.
        if (notch % 2 === 1) await scope.settle();
        record();
        if (!(scope.controller.isReadingHistoryReserve() || scope.scrollTop() <= 0)) continue;

        // A page arrives. Remember what the person can actually see first.
        const anchorId = scope.topVisible();
        const anchorBefore = anchorId ? scope.screenTop(anchorId)! : undefined;
        const topBefore = scope.scrollTop();
        const inside = anchorId === undefined;
        if (inside) insideEstimateArrivals++; else onRowArrivals++;
        if (topBefore <= 0) atTopArrivals++; else deepArrivals++;
        estimateAhead.push(scope.controller.reserveHeight);
        scope.resetWrites();

        scope.controller.beginEarlierPage();
        const arrived = Array.from({ length: PAGE }, (_, i) => row(first - PAGE + i));
        first -= PAGE;
        const next = [...arrived, ...scope.controller.ids];
        scope.controller.setHistoryWindow(Math.max(0, first - OLDEST), 12 + pages, first > OLDEST ? `cursor-${first}` : undefined);
        scope.render(next);
        scope.controller.finishEarlierPage();
        scope.render();
        await scope.frame();
        pages++;
        if (inside) {
          // Inside the estimate there is nothing to hold, so the page itself
          // writes nothing: its rows fill the placeholder the person is
          // looking at. (A later frame may write to hold them still while the
          // estimate grows back above them; that is a different event, and it
          // happens with loaded rows on screen.)
          expect(scope.writes(), `page ${pages} wrote while inside the estimate`).toEqual([]);
          expect(scope.scrollTop()).toBe(topBefore);
        }
        scope.render();
        await scope.frame();

        if (anchorId !== undefined && scope.screenTop(anchorId) !== undefined) {
          // On loaded rows: the row the person was reading is where it was.
          heldStill.push(Math.abs(scope.screenTop(anchorId)! - anchorBefore!));
        }
        record();
      }

      expect(pages).toBe(PAGES);
      expect(insideEstimateArrivals + onRowArrivals).toBe(pages);
      // Both halves of the rule are exercised, and neither is a rounding
      // error: the reader is on loaded rows for most arrivals and genuinely
      // inside the placeholder for several of them.
      expect(onRowArrivals).toBeGreaterThanOrEqual(8);
      expect(insideEstimateArrivals).toBeGreaterThanOrEqual(4);
      // And most of them happen with the reader in the middle of the
      // transcript rather than clamped against the top of the scroller, where
      // a controller that never writes would pass by accident.
      expect(deepArrivals).toBeGreaterThanOrEqual(pages - atTopArrivals);
      expect(deepArrivals).toBeGreaterThanOrEqual(16);
      // The range in front of the reader is a real one, not a floor: at least
      // two screens of estimate stood above them at most arrivals.
      expect(estimateAhead.filter(height => height >= 2 * 780).length).toBeGreaterThanOrEqual(12);
      expect(heldStill.length).toBe(onRowArrivals);
      for (const moved of heldStill) expect(moved).toBeLessThanOrEqual(1);

      // The reading position only ever gets older. Not one step of this replay
      // returns the person to a row they had already read past, which is what
      // "the same section comes back however long you scroll" was.
      for (let i = 1; i < readings.length; i++) {
        const previous = readings[i - 1]!, current = readings[i]!;
        expect(current.ordinal, `step ${i} moved to a newer row`).toBeLessThanOrEqual(previous.ordinal);
        if (current.ordinal === previous.ordinal) expect(current.withinRow, `step ${i} moved down inside a row`).toBeLessThanOrEqual(previous.withinRow + 1);
      }
      expect(readings.at(-1)!.ordinal).toBeLessThan(readings[0]!.ordinal - 100);
    } finally { scope.dispose(); }
  });

  it("keeps the reader's row within a pixel when a page above it measures taller than its estimate", async () => {
    const scope = layoutRig({
      path: "/taller-than-estimate",
      ids: ["kept-a", "kept-b", "kept-c"],
      // The arriving rows are far taller than any estimate the model can make.
      height: id => (id.startsWith("page") ? 940 : 200),
      clientHeight: 300,
    });
    try {
      scope.controller.setHistoryWindow(4, 2, "cursor-a");
      await scope.start();
      scope.viewport.scrollTop = scope.viewport.scrollHeight;
      scope.viewport.dispatchEvent(new Event("scroll"));
      scope.render();
      await scope.frame();
      // Read up until the oldest loaded row sits just under the top edge, with
      // the estimated range above it: a loaded row is on screen, so it is the
      // thing that must not move.
      scope.readUp(scope.scrollTop() - scope.controller.reserveHeight - 50);
      scope.render();
      await scope.frame();
      const anchorId = scope.topVisible()!;
      expect(anchorId).toBe("kept-a");
      const held = scope.screenTop(anchorId)!;

      scope.controller.beginEarlierPage();
      scope.controller.setHistoryWindow(2, 3, "cursor-b");
      scope.render(["page-a", "page-b", "kept-a", "kept-b", "kept-c"]);
      scope.controller.finishEarlierPage();
      scope.render();
      await scope.frame();
      scope.render();
      await scope.frame();

      expect(scope.screenTop(anchorId)).toBeDefined();
      expect(Math.abs(scope.screenTop(anchorId)! - held)).toBeLessThanOrEqual(1);
      // And the range really did grow by rows the estimate never predicted.
      expect(scope.viewport.scrollHeight).toBeGreaterThan(3 * 200 + 940);
    } finally { scope.dispose(); }
  });

  it("writes nothing at all when a page arrives while the reader is inside the estimate", async () => {
    const scope = layoutRig({ path: "/inside-estimate", ids: ["tail-a", "tail-b"], height: () => 400, clientHeight: 300 });
    try {
      scope.controller.setHistoryWindow(6, 2, "cursor-a");
      await scope.start();
      scope.readUp(scope.viewport.scrollTop);
      scope.render();
      await scope.frame();
      expect(scope.controller.isReadingHistoryReserve()).toBe(true);
      expect(scope.topVisible()).toBeUndefined();
      const before = scope.scrollTop();
      scope.resetWrites();

      scope.controller.beginEarlierPage();
      scope.controller.setHistoryWindow(4, 3, "cursor-b");
      scope.render(["page-a", "page-b", "tail-a", "tail-b"]);
      scope.controller.finishEarlierPage();
      scope.render();
      await scope.frame();
      scope.render();
      await scope.frame();

      expect(scope.writes()).toEqual([]);
      expect(scope.scrollTop()).toBe(before);
      expect(scope.controller.capture().following).toBe(false);
    } finally { scope.dispose(); }
  });

  it("grows the estimate back to its bounded size under a settled reader without moving them", async () => {
    // Arrived pages consume the estimate. After two of them it sat at its one
    // pixel floor with a hundred turns still unloaded, so the thumb claimed the
    // root of the conversation and the reading position was never "inside the
    // estimate" again. While the producer has a cursor the range in front of
    // the reader has to keep meaning something — and growing it is space added
    // above them, so it may only happen where it can be held still.
    const scope = layoutRig({ path: "/regrow", ids: ["tail-a", "tail-b", "tail-c"], height: () => 300, clientHeight: 300 });
    try {
      scope.controller.setHistoryWindow(40, 3, "cursor-a");
      await scope.start();
      scope.viewport.scrollTop = scope.viewport.scrollHeight;
      scope.viewport.dispatchEvent(new Event("scroll"));
      scope.render();
      await scope.frame();
      const bounded = scope.controller.reserveHeight;
      expect(bounded).toBe(3 * 300);

      // Read up onto the oldest loaded row and take a page far larger than the
      // range, which drains it to the floor.
      scope.readUp(scope.scrollTop() - bounded - 100);
      scope.render();
      await scope.frame();
      const anchorId = scope.topVisible()!;
      scope.controller.beginEarlierPage();
      scope.controller.setHistoryWindow(37, 4, "cursor-b");
      scope.render(["page-a", "page-b", "page-c", "tail-a", "tail-b", "tail-c"]);
      scope.controller.finishEarlierPage();
      scope.render();
      await scope.frame();
      scope.render();
      await scope.frame();
      expect(scope.controller.reserveHeight).toBeLessThan(bounded / 2);
      const drained = scope.controller.reserveHeight;
      const held = scope.screenTop(anchorId)!;
      const topBefore = scope.scrollTop();

      // The person stops reading. The estimate ahead of them becomes honest
      // again, and they do not move a pixel for it.
      await scope.settle();
      expect(scope.controller.reserveHeight).toBe(bounded);
      expect(scope.screenTop(anchorId)).toBeCloseTo(held, 0);
      // Exactly the growth, and not a pixel more: the person's row is where it
      // was, and the range above them accounts for every pixel of the write.
      expect(scope.scrollTop()).toBeCloseTo(topBefore + bounded - drained, 0);
      // It is bounded, not unbounded: settling again adds nothing.
      await scope.settle();
      expect(scope.controller.reserveHeight).toBe(bounded);
      expect(scope.screenTop(anchorId)).toBeCloseTo(held, 0);
    } finally { scope.dispose(); }
  });

  it("does not spend a truncated shift after the person has dragged the scrollbar", async () => {
    // A shift the clamp at the top could not spend stays owed, because the
    // content that was removed is usually on its way back. A thumb drag never
    // reaches the wheel/touch/key path that settles it, so without an explicit
    // release the debt was spent on the next shift — a jump the person could
    // not attribute to anything they did.
    const run = async (drag: boolean) => {
      const scope = layoutRig({
        path: `/clamp-debt-${drag}`,
        ids: ["a", "b", "c", "d"],
        height: id => (id === "late" ? 500 : 300),
        clientHeight: 300,
      });
      try {
        scope.controller.setHistoryWindow(9, 4, "cursor-a");
        await scope.start();
        const reserve = scope.controller.reserveHeight;
        expect(reserve).toBe(900);
        // The reader is inside the estimate with the first loaded row on
        // screen below them.
        scope.readUp(scope.scrollTop() - (reserve - 100));
        scope.render();
        await scope.frame();
        expect(scope.screenTop("a")).toBeCloseTo(100, 0);

        // The producer proves the root: the whole estimate goes from above the
        // reader in one commit. 900 px cannot be spent from scrollTop 800, so
        // 100 px of it stays owed.
        scope.controller.beginEarlierPage();
        scope.controller.setHistoryWindow(0, 4, undefined);
        scope.render();
        scope.controller.finishEarlierPage();
        scope.render();
        await scope.frame();
        scope.render();
        await scope.frame();
        expect(scope.controller.reserveHeight).toBe(0);
        expect(scope.scrollTop()).toBe(0);

        if (drag) scope.dragTo(40);
        const chosen = scope.scrollTop();
        scope.resetWrites();
        // The content the estimate stood for arrives: 500 px of rows at the
        // front, above everything the reader can see.
        scope.render(["late", "a", "b", "c", "d"]);
        scope.render();
        await scope.frame();
        scope.render();
        await scope.frame();
        return { moved: scope.scrollTop() - chosen, row: scope.screenTop("a")! };
      } finally { scope.dispose(); }
    };

    // Nobody touched the scrollbar: the 100 px the clamp could not spend is
    // still owed, and the arriving content is where it is repaid — the row
    // goes back to the screen position the collapse took it from.
    const kept = await run(false);
    expect(kept.moved).toBeCloseTo(400, 0);
    expect(kept.row).toBeCloseTo(100, 0);
    // After a thumb drag the person's position is the one they chose, and the
    // content arriving above them costs exactly its own height — not that plus
    // a debt from before the gesture.
    const dragged = await run(true);
    expect(dragged.moved).toBeCloseTo(500, 0);
    expect(dragged.row).toBeCloseTo(-40, 0);
  });

  it("keeps the live edge while output streams at the bottom and a page arrives above", async () => {
    let tailHeight = 200;
    const scope = layoutRig({
      path: "/streaming-live-edge",
      ids: ["a", "b", "streaming"],
      height: id => (id === "streaming" ? tailHeight : 200),
      clientHeight: 300,
    });
    try {
      scope.controller.setHistoryWindow(3, 2, "cursor-a");
      await scope.start();
      scope.viewport.scrollTop = scope.viewport.scrollHeight;
      scope.viewport.dispatchEvent(new Event("scroll"));
      scope.render();
      await scope.frame();
      expect(scope.controller.capture().following).toBe(true);

      // Output grows in the last row while the page lands above it.
      tailHeight = 520;
      scope.controller.beginEarlierPage();
      scope.controller.setHistoryWindow(1, 3, "cursor-b");
      scope.render(["page-a", "page-b", "a", "b", "streaming"]);
      scope.controller.finishEarlierPage();
      scope.render();
      await scope.frame();
      tailHeight = 760;
      scope.render();
      await scope.frame();

      expect(scope.controller.capture().following).toBe(true);
      expect(scope.viewport.scrollHeight - scope.viewport.clientHeight - scope.scrollTop()).toBeLessThanOrEqual(1);
      expect(scope.controller.earlierPageFallbackCount).toBe(0);
    } finally { scope.dispose(); }
  });
});
