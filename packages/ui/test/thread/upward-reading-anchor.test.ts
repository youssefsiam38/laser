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
 *   - a mounted row occupies its real height, whatever the model guessed;
 *   - an unmounted row occupies whatever the model currently says, because
 *     that is what the virtual spacers render;
 *   - the estimated range for unloaded history sits above both;
 *   - `scrollTop` is clamped to the scroller, as a real one is.
 *
 * A page therefore arrives with rows the model has only estimated, the reserve
 * changes in the same commit, and the rows above the reader are a mixture of
 * measurements and guesses. Arithmetic over that mixture is what pushed a
 * person back down every time they scrolled up; the browser's own rectangles
 * are what this controller now reads instead.
 */
interface Rig {
  controller: TranscriptViewport;
  viewport: HTMLElement;
  /** Render with these ids: mount exactly the controller's window, then commit. */
  render(ids?: readonly string[]): void;
  frame(): Promise<void>;
  /** A wheel notch upwards, then the scroll the browser would dispatch. */
  readUp(pixels: number): void;
  scrollTop(): number;
  /** The id at the top of the viewport, or undefined inside the estimate. */
  topVisible(): string | undefined;
  screenTop(id: string): number | undefined;
  /** Every `scrollTop` this controller wrote since the last reset. */
  writes(): { from: number; to: number }[];
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
}): Rig {
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

  /** Where a row starts inside the scroller: real heights mounted, model heights not. */
  const rowTop = (id: string) => {
    const index = ids.indexOf(id);
    let offset = above + controller.reserveHeight;
    for (let i = 0; i < index; i++) {
      const other = ids[i]!;
      offset += nodes.has(other) ? options.height(other) : controller.heights.height(i);
    }
    return offset;
  };
  const contentHeight = () => {
    let total = 0;
    for (const [index, id] of ids.entries()) total += nodes.has(id) ? options.height(id) : controller.heights.height(index);
    return total;
  };
  const scrollHeight = () => above + controller.reserveHeight + contentHeight();
  const maxTop = () => Math.max(0, scrollHeight() - options.clientHeight);
  Object.defineProperties(viewport, {
    clientHeight: { value: options.clientHeight },
    clientWidth: { value: 600 },
    scrollHeight: { get: scrollHeight },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.min(Math.max(0, value), maxTop()); } },
  });
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, options.clientHeight);
  content.getBoundingClientRect = () => new DOMRect(0, above - top, 600, controller.reserveHeight + contentHeight());
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
    // Exactly what `WindowedMessages` does: the controller chooses the window,
    // React mounts it, and the layout effect commits.
    const wanted = new Set(controller.ranges().flatMap(range => ids.slice(range.start, range.end)));
    for (const id of [...nodes.keys()]) if (!wanted.has(id)) unmount(id);
    for (const id of wanted) if (!nodes.has(id)) mount(id);
    controller.committed();
  };
  return {
    controller, viewport,
    render,
    async frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
      await Promise.resolve();
    },
    readUp(pixels: number) {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      viewport.scrollTop = top - pixels;
      viewport.dispatchEvent(new Event("scroll"));
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
    writes: () => [...trace],
    resetWrites() { trace.length = 0; },
    dispose() {
      detach();
      viewport.remove();
      delete (globalThis as { __laserScrollTrace?: unknown[] }).__laserScrollTrace;
      vi.unstubAllGlobals();
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
  it("never moves the reader back through twenty-four pages of mixed measured and estimated rows", async () => {
    // The replay of the reported session: the person wheels up 900 px at a
    // time; whenever the reading position is in front of the loaded rows the
    // producer answers with another page, exactly as `HistoryControls` asks.
    const OLDEST = 0, PAGE = 6, PAGES = 24;
    let first = 150;
    const scope = layoutRig({ path: "/replay", ids: Array.from({ length: 24 }, (_, i) => row(first + i)), height: realHeight, clientHeight: 780, above: 44 });
    try {
      scope.controller.setHistoryWindow(first - OLDEST, 12, "cursor-150");
      scope.render();
      await scope.frame();
      scope.viewport.scrollTop = scope.viewport.scrollHeight;
      scope.viewport.dispatchEvent(new Event("scroll"));
      await scope.frame();

      const readings: { ordinal: number; withinRow: number }[] = [];
      const record = () => {
        const id = scope.topVisible();
        if (id) readings.push({ ordinal: ordinalOf(id), withinRow: -(scope.screenTop(id) ?? 0) });
      };
      record();
      let pages = 0, insideReserveArrivals = 0, onRowArrivals = 0, atTopArrivals = 0;
      const heldStill: number[] = [];

      for (let notch = 0; notch < 400 && pages < PAGES; notch++) {
        scope.readUp(900);
        scope.render();
        await scope.frame();
        record();
        if (!(scope.controller.isReadingHistoryReserve() || scope.scrollTop() <= 0)) continue;

        // A page arrives. Remember what the person can actually see first.
        const anchorId = scope.topVisible();
        const anchorBefore = anchorId ? scope.screenTop(anchorId)! : undefined;
        const topBefore = scope.scrollTop();
        const inside = anchorId === undefined;
        if (inside) insideReserveArrivals++; else onRowArrivals++;
        if (topBefore <= 0) atTopArrivals++;
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
        scope.render();
        await scope.frame();
        pages++;

        if (anchorId !== undefined && scope.screenTop(anchorId) !== undefined) {
          // On loaded rows: the row the person was reading is where it was.
          heldStill.push(Math.abs(scope.screenTop(anchorId)! - anchorBefore!));
        } else if (inside) {
          // Inside the estimate there is nothing to hold, so nothing is written.
          expect(scope.writes(), `page ${pages} wrote while inside the estimate`).toEqual([]);
          expect(scope.scrollTop()).toBe(topBefore);
        }
        record();
      }

      expect(pages).toBe(PAGES);
      expect(insideReserveArrivals + onRowArrivals).toBe(pages);
      expect(onRowArrivals).toBeGreaterThan(0);
      // Most of this replay happens at `scrollTop` 0 — the geometry of the
      // reported trace, where every further page arrives with the person
      // already at the top of the scroller.
      expect(atTopArrivals).toBeGreaterThan(0);
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
      scope.render();
      await scope.frame();
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
      scope.render();
      await scope.frame();
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
      scope.render();
      await scope.frame();
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
