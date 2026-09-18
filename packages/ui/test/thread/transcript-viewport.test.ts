// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { TranscriptViewport } from "../../src/components/thread/transcript-viewport.js";
import { HeightIndex } from "../../src/components/thread/transcript-window.js";
import {
  HistoryReserveModel,
  estimateHistoryReserve,
  transitionEarlierPage,
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
  it("opens a replaced recent tail at its latest message after returning from an old reading place", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 120 }, (_, i) => `message-${i}`);
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, controller.heights.total);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/one", undefined, "first-window"); controller.setIds(ids);
    const detach = controller.attach(viewport);
    try {
      await step();
      expect(viewport.scrollTop).toBeGreaterThan(0);
      // The person leaves from earlier history. Main navigation then clears the
      // current path while it awaits the authoritative recent-tail read.
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      viewport.scrollTop = 1_000; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
      controller.configure("", undefined, undefined); controller.setIds([]);
      // The ready path and its already-accepted replacement revision arrive in
      // one render, which used to restore the discarded window's old anchor.
      viewport.scrollTop = 0;
      controller.configure("/one", undefined, "replacement-window"); controller.setIds(ids.slice(-40));
      await step();
      expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
      expect(controller.capture().following).toBe(true);
      expect(controller.ranges().some(range => range.end === 40)).toBe(true);
      // The stale reading state also prevented the agent's next output from
      // following. Once re-entry owns latest, later growth stays there.
      controller.setIds([...ids.slice(-40), "agent-output"]);
      controller.committed();
      expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
      expect(controller.capture().following).toBe(true);
      // A scoped reload can replace the same path in place. Unchanged row count
      // and typography still require an explicit bottom placement.
      const thirdWindow = Array.from({ length: 41 }, (_, i) => `third-${i}`);
      viewport.scrollTop = 0;
      controller.configure("/one", undefined, "third-window"); controller.setIds(thirdWindow);
      await step();
      expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
      expect(controller.capture().following).toBe(true);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); }
  });
  it("keeps a same-path replacement on the reader's anchor when they were away", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 20 }, (_, index) => `row-${index}`);
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2_000 } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, 2_000);
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/same", undefined, "revision-one"); controller.setIds(ids); controller.heights = new HeightIndex(ids.map(() => 100));
    for (const [index, id] of ids.entries()) {
      const row = document.createElement("div");
      row.getBoundingClientRect = () => new DOMRect(0, index * 100 - viewport.scrollTop, 600, 100);
      content.append(row); controller.register(id, row);
    }
    viewport.scrollTop = 1_400;
    const detach = controller.attach(viewport);
    try {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
      viewport.scrollTop = 700; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
      const anchor = controller.capture().anchor?.messageId;
      controller.configure("/same", undefined, "revision-two");
      controller.setIds([...ids]); controller.committed();
      expect(controller.capture().following).toBe(false);
      expect(controller.capture().anchor?.messageId).toBe(anchor);
      expect(viewport.scrollTop).toBe(700);
    } finally { detach(); viewport.remove(); }
  });

  it("lets an explicit destination supersede replacement-tail arrival", async () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2_000 } });
    controller.configure("/one", undefined, "first-window"); controller.setIds(["target"]);
    const detach = controller.attach(viewport);
    try {
      controller.configure("", undefined, undefined); controller.setIds([]);
      controller.configure("/one", undefined, "replacement-window"); controller.setIds(["target"]);
      const pending = controller.ensureVisible({ messageId: "target" }, { reason: "find" });
      viewport.scrollTop = 100; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
      controller.cancel();
      expect(await pending).toBe("cancelled");
    } finally { detach(); }
  });
  it("lets explicit wheel input beat followed growth after the run has settled", () => {
    let resized!: ResizeObserverCallback;
    class Observer {
      constructor(callback: ResizeObserverCallback) { resized = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", Observer);
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), row = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2_000 } });
    controller.configure("/settled");
    const detach = controller.attach(viewport);
    try {
      resized([{ target: row } as ResizeObserverEntry], {} as ResizeObserver);
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      viewport.scrollTop = 100;
      viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
    } finally { detach(); vi.unstubAllGlobals(); }
  });

  it.each([
    ["downward wheel", (viewport: HTMLElement) => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }))],
    ["tap without drag", (viewport: HTMLElement) => viewport.dispatchEvent(new Event("touchstart"))],
    ["ArrowDown", (viewport: HTMLElement) => viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }))],
    ["PageDown", (viewport: HTMLElement) => viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }))],
    ["End", (viewport: HTMLElement) => viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }))],
    ["Space", (viewport: HTMLElement) => viewport.dispatchEvent(new KeyboardEvent("keydown", { key: " " }))],
  ])("keeps follow through a no-op %s at the physical bottom", (_label, gesture) => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    let total = 2_000;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => total } });
    viewport.scrollTop = 1_400;
    controller.configure("/no-op-bottom");
    const detach = controller.attach(viewport);
    try {
      gesture(viewport);
      expect(viewport.scrollTop).toBe(1_400);
      expect(controller.capture().following).toBe(true);
      total += 100;
      controller.committed();
      expect(viewport.scrollTop).toBe(1_500);
      expect(controller.capture().following).toBe(true);
    } finally { detach(); }
  });

  it("does not cancel a destination for a no-op wheel at the bottom", async () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2_000 } });
    viewport.scrollTop = 1_400;
    controller.configure("/destination");
    const detach = controller.attach(viewport);
    try {
      let settled = false;
      const pending = controller.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(() => {}) })
        .finally(() => { settled = true; });
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
      await Promise.resolve();
      expect(settled).toBe(false);
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
      expect(await pending).toBe("cancelled");
    } finally { detach(); }
  });

  it("keeps the first scrollbar drag movement during streamed growth", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    let total = 2_000;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, clientWidth: { value: 600 }, scrollHeight: { get: () => total } });
    viewport.scrollTop = 1_400;
    controller.configure("/scrollbar-stream");
    const detach = controller.attach(viewport);
    try {
      const pointer = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(pointer, "offsetX", { value: 610 });
      viewport.dispatchEvent(pointer);
      total += 50;
      viewport.scrollTop -= 150;
      viewport.dispatchEvent(new Event("scroll"));
      controller.committed();
      expect(viewport.scrollTop).toBe(1_250);
      expect(controller.capture().following).toBe(false);
    } finally { detach(); }
  });

  it("re-arms follow geometrically after the reader returns to the bottom", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    let total = 2_000;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => total } });
    viewport.scrollTop = 1_400;
    controller.configure("/return-bottom");
    const detach = controller.attach(viewport);
    try {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
      viewport.scrollTop = 1_000; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
      viewport.scrollTop = 1_400; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(true);
      total += 120; controller.committed();
      expect(viewport.scrollTop).toBe(1_520);
    } finally { detach(); }
  });

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
  it.each(["wheel", "touchmove", "scrollbar drag", "keydown"])("keeps an explicit version detached through queued layout scrolls until %s intent", async intent => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0, now = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const step = async () => { now += 20; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now); await Promise.resolve(); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 100 }, (_, i) => `row-${i}`);
    let total = 10000;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, total);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    const rows = new Map<string, HTMLElement>();
    for (const [index, id] of ids.entries()) {
      const row = document.createElement("div"); row.dataset.windowMessage = id;
      row.getBoundingClientRect = () => new DOMRect(0, index * 100 - viewport.scrollTop, 600, 100);
      content.append(row); rows.set(id, row); controller.register(id, row);
    }
    controller.configure("/versions", "old-leaf"); controller.setIds(ids);
    // Configure clears previous-scope nodes, just as the committed row refs rebind.
    for (const [id, row] of rows) controller.register(id, row);
    const detach = controller.attach(viewport);
    try {
      await step(); viewport.dispatchEvent(new Event("scroll"));
      const locate = vi.spyOn(controller, "ensureVisible");
      let settled = false;
      const pending = controller.afterAction(controller.startAction(), { messageId: "row-10", leafId: "new-leaf" }).then(() => { settled = true; });
      await step(); await step(); expect(locate).not.toHaveBeenCalled();
      controller.configure("/versions", "new-leaf"); await step();
      expect(locate).toHaveBeenCalledTimes(1);
      // Native layout/clamping can report a transient bottom while the explicit
      // destination is mounted but before its measured position is established.
      total = 8000; viewport.scrollTop = 7400; viewport.dispatchEvent(new Event("scroll")); total = 10000;
      for (let i = 0; i < 40 && !settled; i++) await step();
      expect(settled).toBe(true); await pending;
      expect(controller.capture().following).toBe(false);
      const before = rows.get("row-10")!.getBoundingClientRect().top;
      expect(before).toBe(200);
      // A queued browser scroll arriving after settlement must not claim tail
      // ownership either. Resize and another frame must restore the same anchor.
      viewport.scrollTop = 9400; viewport.dispatchEvent(new Event("scroll"));
      controller.schedule(); await step(); await step();
      expect(controller.capture().following).toBe(false);
      expect(rows.get("row-10")!.getBoundingClientRect().top).toBe(before);
      expect(controller.ranges().some(range => range.start <= 10 && range.end > 10)).toBe(true);
      // Real scroll intent releases ownership, so reaching the bottom can follow.
      if (intent === "keydown") viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
      else if (intent === "wheel") viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
      else if (intent === "touchmove") {
        const start = new Event("touchstart"); Object.defineProperty(start, "touches", { value: [{ clientY: 200 }] }); viewport.dispatchEvent(start);
        const move = new Event("touchmove"); Object.defineProperty(move, "touches", { value: [{ clientY: 100 }] }); viewport.dispatchEvent(move);
      } else {
        const event = new MouseEvent("pointerdown", { bubbles: true });
        Object.defineProperty(event, "offsetX", { value: 610 });
        viewport.dispatchEvent(event);
        viewport.scrollTop = 700; viewport.dispatchEvent(new Event("scroll"));
      }
      viewport.scrollTop = 9400; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(true);
    } finally { detach(); viewport.remove(); clock.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("never moves the viewport back under a person's wheel while their anchor is not mounted", async () => {
    // 0.6.0 fought the reader: scrolling up landed the anchor on a row that
    // was not mounted yet, and the next commit re-placed it from estimated
    // heights, pushing the viewport back down under the wheel, page after page.
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 200 }, (_, i) => `row-${i}`);
    const total = 200 * 100;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, total);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/reading"); controller.setIds(ids);
    // Only the tail is mounted, as after opening a conversation.
    // Geometry follows the index, as the spacers do in the browser: a row sits
    // where the estimates above it say, and measuring it to 100px shrinks
    // everything below by the difference.
    const mount = (index: number) => {
      const row = document.createElement("div"); row.dataset.windowMessage = ids[index]!;
      row.getBoundingClientRect = () => new DOMRect(0, controller.heights.offset(index) - viewport.scrollTop, 600, 100);
      content.append(row); controller.register(ids[index]!, row); return row;
    };
    for (let i = 190; i < 200; i++) mount(i);
    const detach = controller.attach(viewport);
    try {
      viewport.scrollTop = total - 600; viewport.dispatchEvent(new Event("scroll")); await step();
      // The person wheels up a long way: the anchor is now an unmounted row.
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
      viewport.scrollTop = 4000; viewport.dispatchEvent(new Event("scroll"));
      const anchor = controller.capture().anchor?.messageId;
      expect(controller.capture().following).toBe(false);
      expect(anchor).toBeDefined();
      expect(content.querySelector(`[data-window-message="${anchor}"]`)).toBeNull();
      // A commit lands (the window is catching up) before any of those rows exist.
      controller.committed(); await step();
      expect(viewport.scrollTop).toBe(4000);
      // Rows around the anchor mount and measure smaller than their estimates.
      // The content above the anchor shrinks; the anchor must stay where the
      // person left it on screen, so scrollTop moves by exactly that shrink.
      const index = ids.indexOf(anchor!);
      const screenTop = controller.heights.offset(index) - viewport.scrollTop;
      for (let i = Math.max(0, index - 5); i < index + 5; i++) mount(i);
      controller.committed(); await step();
      expect(controller.heights.offset(index) - viewport.scrollTop).toBeCloseTo(screenTop, 0);
      expect(viewport.scrollTop).toBeLessThan(4000);
      // Once the person has stopped, a commit is allowed to place the anchor
      // from the DOM — which, with nothing changed, is exactly where it is.
      const rested = viewport.scrollTop;
      vi.advanceTimersByTime(500); await step();
      controller.committed(); await step();
      expect(viewport.scrollTop).toBeCloseTo(rested, 0);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
  it("does not restore a mounted anchor over a wheel scroll before its native scroll event", async () => {
    // The browser applies a wheel's scroll position before it dispatches the
    // scroll event that lets us capture it. A React layout commit can land in
    // that gap. Restoring the previously captured mounted row there cancels
    // the wheel; repeated commits make the viewport fight every wheel step.
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 20 }, (_, i) => `row-${i}`);
    const scrollHeight = () => controller.heights.total;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: scrollHeight } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, scrollHeight());
    content.style.fontSize = "14px"; content.style.lineHeight = "21px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/wheel-race"); controller.setIds(ids);
    for (const [index, id] of ids.entries()) {
      const row = document.createElement("div"); row.dataset.windowMessage = id;
      row.getBoundingClientRect = () => new DOMRect(0, controller.heights.offset(index) - viewport.scrollTop, 600, 100);
      content.append(row); controller.register(id, row);
    }
    const detach = controller.attach(viewport);
    try {
      await step();
      viewport.scrollTop = 1400; viewport.dispatchEvent(new Event("scroll")); await step();
      expect(controller.capture().anchor?.messageId).toBe("row-14");
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -500 }));
      // Browser default scrolling has happened; its scroll event has not.
      viewport.scrollTop = 900;
      controller.committed();
      expect(viewport.scrollTop).toBe(900);
      viewport.dispatchEvent(new Event("scroll")); await step();
      expect(viewport.scrollTop).toBe(900);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it("keeps native momentum and scrollbar movement authoritative between scroll events", async () => {
    // Touch momentum, a long drag, a scrollbar drag and Space can scroll without
    // a fresh wheel/touchstart/viewport-key event. Their first native scroll
    // event must keep the reading window alive for the next default-scroll →
    // scroll-event gap, or a commit restores the previous position over it.
    vi.useFakeTimers();
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 20 }, (_, i) => `row-${i}`);
    controller.configure("/native-scroll"); controller.setIds(ids); controller.content = content;
    controller.heights = new HeightIndex(ids.map(() => 100));
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, 2000);
    viewport.append(content); document.body.append(viewport);
    for (const [index, id] of ids.entries()) {
      const row = document.createElement("div"); row.dataset.windowMessage = id;
      row.getBoundingClientRect = () => new DOMRect(0, index * 100 - viewport.scrollTop, 600, 100);
      content.append(row); controller.register(id, row);
    }
    const detach = controller.attach(viewport);
    try {
      viewport.scrollTop = 1400; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().anchor?.messageId).toBe("row-14");
      // One momentum/drag scroll is captured normally.
      viewport.scrollTop = 1100; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().anchor?.messageId).toBe("row-11");
      // The next native position lands before its scroll event.
      viewport.scrollTop = 800;
      controller.committed();
      expect(viewport.scrollTop).toBe(800);
    } finally { detach(); viewport.remove(); vi.useRealTimers(); }
  });

  it("lets explicit Send choose latest while passive growth preserves the reader", async () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    let total = 2000;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => total } });
    viewport.scrollTop = 500;
    controller.configure("/new-run");
    const detach = controller.attach(viewport);
    try {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
      // Passive output is geometry, not a run-state signal, and preserves a reader.
      total += 50; controller.committed();
      expect(controller.capture().following).toBe(false);
      expect(viewport.scrollTop).toBe(500);

      // The local composer submit owns the navigation to latest.
      controller.latest();
      expect(controller.capture().following).toBe(true);
      expect(viewport.scrollTop).toBe(total - viewport.clientHeight);
      // The row can grow before the native event for that tail scroll arrives,
      // and the delayed primitive scroll can land between its old and new end.
      // It must not reinterpret that mismatched scrollTop as a reader.
      total += 50; viewport.scrollTop += 25; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(true);
      controller.committed();
      expect(viewport.scrollTop).toBe(total - viewport.clientHeight);
      // Explicit reading input opts out even while that same row continues.
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      viewport.scrollTop -= 100;
      viewport.dispatchEvent(new Event("scroll"));
      const readingTop = viewport.scrollTop;
      total += 50; controller.committed();
      expect(controller.capture().following).toBe(false);
      expect(viewport.scrollTop).toBe(readingTop);
      controller.latest();
      expect(viewport.scrollTop).toBe(total - viewport.clientHeight);
    } finally { detach(); }
  });

  it("keeps following when two transcript blocks append in one tick", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    let total = 2_000;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => total } });
    viewport.scrollTop = 1_400;
    controller.configure("/batched-blocks"); controller.setIds(["old"]);
    const detach = controller.attach(viewport);
    try {
      controller.setIds(["old", "first", "second"]); total = 2_200;
      // The browser can report layout/clamp scroll before React's layout
      // effect pins the followed transcript to its new end.
      viewport.dispatchEvent(new Event("scroll"));
      controller.committed();
      expect(controller.capture().following).toBe(true);
      expect(viewport.scrollTop).toBe(1_600);
    } finally { detach(); }
  });

  it("keeps following when a transcript block appends after running becomes false", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    let total = 2_000;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => total } });
    viewport.scrollTop = 1_400;
    controller.configure("/settled-append"); controller.setIds(["old"]);
    const detach = controller.attach(viewport);
    try {
      controller.setIds(["old", "late"]); total = 2_100;
      viewport.dispatchEvent(new Event("scroll"));
      controller.committed();
      expect(controller.capture().following).toBe(true);
      expect(viewport.scrollTop).toBe(1_500);
    } finally { detach(); }
  });

  it("does not stop following until a scrollbar gesture actually moves", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, clientWidth: { value: 600 }, scrollHeight: { value: 2000 } });
    viewport.scrollTop = 1400;
    controller.configure("/pointer-stream");
    const detach = controller.attach(viewport);
    const pointer = (offsetX: number) => {
      const event = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(event, "offsetX", { value: offsetX });
      viewport.dispatchEvent(event);
    };
    try {
      pointer(100);
      expect(controller.capture().following).toBe(true);
      pointer(610);
      expect(controller.capture().following).toBe(true);
      viewport.scrollTop = 1200; viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
      document.documentElement.style.setProperty("--space-unit", "4px");
      controller.latest();
      pointer(595); // overlay scrollbar, inside clientWidth
      expect(controller.capture().following).toBe(true);
      viewport.dir = "rtl";
      controller.latest();
      pointer(5);
      expect(controller.capture().following).toBe(true);
    } finally { document.documentElement.style.removeProperty("--space-unit"); detach(); }
  });

  it.each(["PageUp"])("lets %s focused inside a message leave a followed stream", (key) => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
    viewport.scrollTop = 1400;
    const button = document.createElement("button");
    viewport.append(button);
    controller.configure("/keyboard-stream");
    const detach = controller.attach(viewport);
    try {
      button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      viewport.scrollTop = 1000;
      viewport.dispatchEvent(new Event("scroll"));
      controller.committed();
      expect(controller.capture().following).toBe(false);
    } finally { detach(); }
  });

  it("keeps no-op Space at the bottom and ignores Space in the composer", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
    viewport.scrollTop = 1400;
    const row = document.createElement("div");
    const composer = document.createElement("div");
    composer.dataset.slot = "composer";
    const send = document.createElement("button");
    composer.append(send); viewport.append(row, composer);
    controller.configure("/keyboard-stream");
    const detach = controller.attach(viewport);
    try {
      send.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(controller.capture().following).toBe(true);
      row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(controller.capture().following).toBe(true);
    } finally { detach(); }
  });

  it("opens at latest when switching back even if the accepted revision is unchanged", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
    viewport.scrollTop = 500;
    controller.configure("/one", undefined, "same-window");
    const detach = controller.attach(viewport);
    try {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      viewport.scrollTop -= 100;
      viewport.dispatchEvent(new Event("scroll"));
      expect(controller.capture().following).toBe(false);
      controller.configure("/two");
      controller.committed();
      controller.configure("/one", undefined, "same-window");
      controller.committed();
      expect(controller.capture().following).toBe(true);
      expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
    } finally { detach(); }
  });

  it("keeps the reader's section on screen when an earlier page arrives above it", async () => {
    // 0.6.2 lost the reader's place: reading upwards at the top loaded the
    // earlier page, the rows landed above the anchor and the viewport stayed
    // at scrollTop 0 — the top of the new page — while the section being
    // read was pushed a whole page down. Every further wheel notch at the top
    // loaded another page the same way; the person saw only page tops, and
    // met the same section again scrolling back down to find their place.
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    let ids = Array.from({ length: 40 }, (_, i) => `row-${i + 40}`);
    const scrollHeight = () => controller.heights.total;
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: scrollHeight } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, scrollHeight());
    content.style.fontSize = "14px"; content.style.lineHeight = "21px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/paging"); controller.setIds(ids);
    const rows = new Map<string, HTMLElement>();
    const mount = (id: string) => {
      const row = document.createElement("div"); row.dataset.windowMessage = id;
      row.getBoundingClientRect = () => new DOMRect(0, controller.heights.offset(ids.indexOf(id)) - viewport.scrollTop, 600, 100);
      content.append(row); controller.register(id, row); rows.set(id, row); return row;
    };
    for (const id of ids) mount(id);
    const detach = controller.attach(viewport);
    try {
      viewport.scrollTop = scrollHeight() - 600; viewport.dispatchEvent(new Event("scroll")); await step();
      // Read up to the very top, the way a wheel does, and ask for what came before.
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
      viewport.scrollTop = 120; viewport.dispatchEvent(new Event("scroll"));
      const place = controller.capture();
      expect(place.following).toBe(false);
      const anchor = place.anchor!.messageId;
      const screenTop = rows.get(anchor)!.getBoundingClientRect().top;
      // Forty earlier rows arrive above; the list renders with them first.
      ids = [...Array.from({ length: 40 }, (_, i) => `row-${i}`), ...ids];
      controller.setIds(ids);
      const inserted = controller.heights.offset(40);
      expect(inserted).toBeGreaterThan(0);
      // The window this render mounts is around the anchor, not the page top.
      const ranges = controller.ranges();
      expect(ranges.some(r => r.start <= 40 && r.end > 40)).toBe(true);
      controller.committed(); await step();
      // The anchor row is exactly where the person left it on screen.
      expect(rows.get(anchor)!.getBoundingClientRect().top).toBeCloseTo(screenTop, 0);
      expect(viewport.scrollTop).toBeCloseTo(120 + inserted, 0);
      // And once they have stopped, nothing moves it.
      vi.advanceTimersByTime(500); await step();
      controller.committed(); await step();
      expect(rows.get(anchor)!.getBoundingClientRect().top).toBeCloseTo(screenTop, 0);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it("sizes unloaded history from producer prompt counts and the loaded turn average", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => controller.reserveHeight + controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, controller.reserveHeight + controller.heights.total);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px"; content.style.paddingTop = "20px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/reserve"); controller.setHistoryWindow(6, 2, "before-6"); controller.setIds(["a", "b", "c", "d"]);
    const detach = controller.attach(viewport);
    try {
      await step(); await step();
      expect(controller.reserveHeight).toBeCloseTo(controller.heights.total / 2 * 6, 5);
      expect(viewport.scrollHeight).toBeGreaterThan(controller.heights.total);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); }
  });

  it("exchanges arrived page height with reserve space without moving the anchor", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    let ids = ["old-a", "old-b", "old-c", "old-d"];
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => controller.reserveHeight + controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, controller.reserveHeight + controller.heights.total);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px"; content.style.paddingTop = "20px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/reserve-page"); controller.setHistoryWindow(8, 2, "before-8"); controller.setIds(ids);
    const detach = controller.attach(viewport);
    try {
      await step(); await step();
      viewport.scrollTop = controller.reserveHeight; viewport.dispatchEvent(new Event("scroll"));
      controller.beginEarlierPage();
      const beforeTop = viewport.scrollTop, beforeTotal = viewport.scrollHeight, beforeReserve = controller.reserveHeight;
      // The history cursor settles before assistant-ui projects the prepended
      // messages. The page transaction must span both commits.
      controller.finishEarlierPage(); controller.committed();
      expect(controller.loadingEarlier).toBe(true);
      ids = ["new-a", "new-b", ...ids];
      controller.setHistoryWindow(6, 3, "before-6"); controller.setIds(ids);
      const arrived = controller.heights.offset(2);
      expect(controller.reserveHeight).toBeCloseTo(beforeReserve - arrived, 5);
      controller.committed(); await step();
      expect(controller.loadingEarlier).toBe(false);
      expect(viewport.scrollTop).toBeCloseTo(beforeTop, 5);
      expect(viewport.scrollHeight).toBeCloseTo(beforeTotal, 5);
      controller.setHistoryWindow(0, 4, undefined); controller.setIds(ids); controller.committed();
      expect(controller.reserveHeight).toBe(0);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); }
  });

  it("keeps a measured root-page anchor within one pixel on every committed frame", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    let ids = ["old-a", "old-b", "old-c"], heights: Record<string, number> = { "old-a": 120, "old-b": 140, "old-c": 160, "new-a": 80, "new-b": 220 };
    Object.defineProperties(viewport, { clientHeight: { value: 300 }, scrollHeight: { get: () => controller.reserveHeight + controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 300);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, viewport.scrollHeight);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px"; content.style.paddingTop = "20px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/measured-root"); controller.setIds(ids); controller.setHistoryWindow(1, 1, "cursor");
    const nodes = new Map<string, HTMLElement>();
    const mount = (id: string) => {
      const row = document.createElement("div"); row.dataset.windowMessage = id;
      row.getBoundingClientRect = () => new DOMRect(0, controller.reserveHeight + controller.heights.offset(ids.indexOf(id)) - viewport.scrollTop, 600, heights[id]!);
      content.append(row); nodes.set(id, row); controller.register(id, row);
    };
    ids.forEach(mount);
    const detach = controller.attach(viewport);
    try {
      await step();
      viewport.scrollTop = controller.reserveHeight - 40;
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 })); viewport.dispatchEvent(new Event("scroll"));
      const anchor = controller.capture().anchor!.messageId;
      const screen = () => nodes.get(anchor)!.getBoundingClientRect().top;
      const frameTops = [screen()];
      controller.beginEarlierPage();
      ids = ["new-a", "new-b", ...ids]; controller.setIds(ids); mount("new-a"); mount("new-b");
      controller.setHistoryWindow(0, 2, undefined); controller.finishEarlierPage(); controller.committed();
      frameTops.push(screen());
      await step(); frameTops.push(screen());
      for (let index = 1; index < frameTops.length; index++) expect(Math.abs(frameTops[index]! - frameTops[index - 1]!)).toBeLessThanOrEqual(1);
      expect(controller.loadingEarlier).toBe(false);
      expect(controller.earlierPageFallbackCount).toBe(0);
      expect(controller.reserveHeight).toBe(0);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); }
  });

  it("never runs absolute restore while an earlier page is committing at root", async () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    let ids = Array.from({ length: 40 }, (_, index) => `old-${index}`);
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => controller.reserveHeight + controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, controller.reserveHeight + controller.heights.total);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px"; content.style.paddingTop = "20px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    controller.configure("/page-root"); controller.setHistoryWindow(1, 1, "before-root"); controller.setIds(ids);
    const detach = controller.attach(viewport);
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      viewport.scrollTop = 120; viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll"));
      controller.beginEarlierPage();
      ids = [...Array.from({ length: 40 }, (_, index) => `new-${index}`), ...ids];
      controller.setIds(ids); controller.committed();
      expect(viewport.scrollTop).toBeLessThanOrEqual(1);
      expect(controller.capture().following).toBe(false);
    } finally { detach(); viewport.remove(); }
  });

  it("does not alternate mounted windows when a phone version target evicts the old reading anchor", async () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 100 }, (_, i) => `row-${i}`), nodes = new Map<string, HTMLElement>();
    controller.configure("/phone", "new-leaf"); controller.setIds(ids);
    controller.content = content; controller.heights = new HeightIndex(ids.map(() => 100));
    Object.defineProperties(viewport, { clientHeight: { value: 844 }, scrollHeight: { value: 10000 } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 390, 10000);
    viewport.append(content); document.body.append(viewport);
    const detach = controller.attach(viewport);
    const commit = (ranges: ReturnType<TranscriptViewport["ranges"]>) => {
      const mounted = new Set(ranges.flatMap(range => ids.slice(range.start, range.end)));
      for (const [id, node] of nodes) if (!mounted.has(id)) { node.remove(); nodes.delete(id); controller.register(id, null); }
      for (const id of mounted) if (!nodes.has(id)) {
        const node = document.createElement("div"), index = ids.indexOf(id);
        node.getBoundingClientRect = () => new DOMRect(0, index * 100 - viewport.scrollTop, 390, 100);
        content.append(node); nodes.set(id, node); controller.register(id, node);
      }
    };
    try {
      commit([{ start: 0, end: 10 }]); controller.capture();
      const pending = controller.ensureVisible({ messageId: "row-50", leafId: "new-leaf" }, { reason: "action" });
      viewport.scrollTop = 5000 - 844 / 3;
      const first = controller.ranges(); commit(first);
      // MessageRoot ref cleanup updates its hover resource synchronously. React
      // may therefore render again before the controller's next measured frame.
      const second = controller.ranges(); commit(second);
      const third = controller.ranges();
      controller.cancel(); await pending;
      expect(first).toEqual(second); expect(second).toEqual(third);
      expect(nodes.has("row-0")).toBe(false);
      expect(nodes.has("row-50")).toBe(true);
    } finally { detach(); viewport.remove(); }
  });
  it.each(["wheel", "touchmove", "scrollbar drag", "keydown", "path", "branch", "destination"])("cancels an active explicit destination on newer %s intent", async intent => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, clientWidth: { value: 600 }, scrollHeight: { value: 2_000 } });
    viewport.scrollTop = 1_000;
    controller.configure("/one", "leaf"); controller.setIds(["message"]);
    const detach = controller.attach(viewport);
    try {
      const pending = controller.ensureVisible({ messageId: "message", leafId: "leaf" }, { reason: "action" });
      if (intent === "path") controller.configure("/two");
      else if (intent === "branch") controller.setIds(["other"]);
      else if (intent === "destination") controller.latest();
      else if (intent === "keydown") viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
      else if (intent === "wheel") viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
      else if (intent === "touchmove") {
        const start = new Event("touchstart"); Object.defineProperty(start, "touches", { value: [{ clientY: 200 }] }); viewport.dispatchEvent(start);
        const move = new Event("touchmove"); Object.defineProperty(move, "touches", { value: [{ clientY: 100 }] }); viewport.dispatchEvent(move);
      } else {
        const pointer = new MouseEvent("pointerdown", { bubbles: true }); Object.defineProperty(pointer, "offsetX", { value: 610 }); viewport.dispatchEvent(pointer);
        viewport.scrollTop -= 100; viewport.dispatchEvent(new Event("scroll"));
      }
      expect(await pending).toBe("cancelled");
    } finally { detach(); }
  });
  it("Tabs through an unmounted noninteractive notice to a visible canonical control", async () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = ["first", "notice", "last"];
    controller.configure("/keys"); controller.setIds(ids); controller.content = content;
    content.style.fontSize = "14px"; content.style.lineHeight = "21px";
    viewport.append(content); document.body.append(viewport);
    Object.defineProperties(viewport, { clientHeight: { value: 700 }, scrollHeight: { value: 30000 } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 700);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, 30000);
    const mounted = new Set<string>();
    const mount = (id: string) => {
      if (mounted.has(id)) return; mounted.add(id);
      const row = document.createElement("div"), index = ids.indexOf(id); row.dataset.windowMessage = id;
      row.getBoundingClientRect = () => new DOMRect(0, index * 10000 - viewport.scrollTop, 600, 10000);
      if (id !== "notice") {
        const control = document.createElement("button"); control.textContent = id;
        control.getBoundingClientRect = () => new DOMRect(0, (index + 1) * 10000 - 30 - viewport.scrollTop, 80, 20);
        control.getClientRects = () => [control.getBoundingClientRect()] as unknown as DOMRectList;
        row.append(control);
      }
      content.append(row); controller.register(id, row);
    };
    mount("first");
    const unsubscribe = controller.subscribe(() => { for (const range of controller.ranges()) for (let i = range.start; i < range.end; i++) mount(ids[i]!); });
    const detach = controller.attach(viewport);
    try {
      viewport.scrollTop = 9700;
      const first = content.querySelector("button")!; first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("last"));
      const rect = document.activeElement!.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(700);
    } finally { detach(); unsubscribe(); viewport.remove(); }
  });
  it("keeps main and Beam intents independent even at the same canonical path", async () => {
    const main = new TranscriptViewport(), beam = new TranscriptViewport();
    main.configure("/same"); beam.configure("/same");
    let finish!: () => void;
    const mainPending = main.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(() => {}) });
    const beamPending = beam.ensureVisible({ messageId: "missing" }, { reason: "find", locate: () => new Promise<void>(done => { finish = done; }) });
    main.cancel(); expect(await mainPending).toBe("cancelled");
    finish(); expect(await beamPending).toBe("missing");
  });

  it("makes cancellation idempotent and accepts settlement before or after the store commit", () => {
    let cancelled = transitionEarlierPage(undefined, { type: "begin", before: "cursor-a" }).state;
    const first = transitionEarlierPage(cancelled, { type: "cancel" });
    expect(first.released).toBe(true);
    cancelled = first.state;
    expect(transitionEarlierPage(cancelled, { type: "cancel" }).released).toBe(false);

    for (const order of [["store-change", "commit", "settled"], ["settled", "store-change", "commit"]] as const) {
      let state = transitionEarlierPage(undefined, { type: "begin", before: "cursor-a" }).state;
      let released = false;
      for (const type of order) {
        const next = transitionEarlierPage(state, { type });
        state = next.state; released ||= next.released;
      }
      expect(released, order.join(" → ")).toBe(true);
      expect(state, order.join(" → ")).toBeUndefined();
    }
  });

  it("pushes a top reader by the exact unabsorbed height of a merged page", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    let ids = ["old-head", "tail"];
    controller.configure("/merged-page-push"); controller.setIds(ids); controller.setHistoryWindow(1, 1, "cursor-a");
    Object.defineProperties(viewport, { clientHeight: { value: 300 }, scrollHeight: { get: () => controller.reserveHeight + controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 300);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, viewport.scrollHeight);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px"; content.style.paddingTop = "20px";
    viewport.append(content); document.body.append(viewport); controller.content = content;
    const detach = controller.attach(viewport);
    try {
      await step();
      viewport.scrollTop = 1; viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
      viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll"));
      controller.beginEarlierPage();
      ids = ["page-a", "page-b", "page-c", ...ids]; controller.setIds(ids);
      controller.setHistoryWindow(1, 1, "cursor-b"); controller.finishEarlierPage(); controller.committed(); await step();
      expect(controller.reserveHeight).toBe(1);

      viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll")); controller.capture();
      const before = { top: viewport.scrollTop, height: viewport.scrollHeight };
      controller.beginEarlierPage();
      ids = ["merged-head", "tail"]; controller.setIds(ids);
      const merged = document.createElement("div");
      merged.getBoundingClientRect = () => new DOMRect(0, controller.reserveHeight - viewport.scrollTop, 600, 900);
      content.append(merged); controller.register("merged-head", merged);
      controller.setHistoryWindow(0, 1, undefined); controller.finishEarlierPage(); controller.committed();
      await step();
      const after = { top: viewport.scrollTop, height: viewport.scrollHeight };
      expect(after.height).toBeGreaterThanOrEqual(before.height - 1);
      expect(Math.abs((after.top - before.top) - (after.height - before.height))).toBeLessThanOrEqual(1);
      expect(controller.earlierPageFallbackCount).toBe(0);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); }
  });

  it("releases after page commits that merge, replace, retain a cursor, or change metadata", () => {
    for (const shape of ["merged", "replacement", "same-cursor", "metadata"] as const) {
      const controller = new TranscriptViewport();
      controller.configure(`/release-${shape}`);
      controller.setIds(["old-head", "old-tail"]);
      controller.setHistoryWindow(1, 1, "cursor-a");
      controller.beginEarlierPage();
      if (shape === "merged") controller.setIds(["merged-head", "old-tail"]);
      else if (shape === "replacement") controller.setIds(["replacement-head"]);
      else if (shape === "same-cursor") controller.setIds(["new-head", "old-head", "old-tail"]);
      controller.setHistoryWindow(shape === "metadata" ? 2 : 1, shape === "metadata" ? 2 : 1, shape === "merged" || shape === "replacement" ? "cursor-b" : "cursor-a");
      controller.finishEarlierPage();
      controller.committed();
      expect(controller.loadingEarlier, shape).toBe(false);
      expect(controller.earlierPageFallbackCount, shape).toBe(0);
    }
  });

  it("cancels an earlier-page transaction on explicit cancellation, path change and unmount", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    controller.configure("/cancel"); controller.beginEarlierPage(); controller.cancelEarlierPage();
    expect(controller.loadingEarlier).toBe(false);
    controller.beginEarlierPage(); controller.configure("/path");
    expect(controller.loadingEarlier).toBe(false);
    const detach = controller.attach(viewport);
    controller.beginEarlierPage(); detach();
    expect(controller.loadingEarlier).toBe(false);
    expect(controller.earlierPageFallbackCount).toBe(0);
  });

  it("keeps the geometric live edge while an earlier page arrives above", () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    let ids = ["old-a", "old-b", "old-c", "old-d"];
    controller.configure("/live-page"); controller.setIds(ids); controller.setHistoryWindow(1, 1, "cursor-a");
    controller.heights = new HeightIndex(ids.map(() => 300));
    Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { get: () => controller.reserveHeight + controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, viewport.scrollHeight);
    viewport.append(content); document.body.append(viewport);
    controller.content = content; viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    const detach = controller.attach(viewport);
    try {
      controller.beginEarlierPage();
      ids = ["new-a", "new-b", ...ids]; controller.setIds(ids);
      controller.setHistoryWindow(0, 2, "cursor-b");
      controller.finishEarlierPage(); controller.committed();
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(1);
      expect(controller.capture().following).toBe(true);
      expect(controller.earlierPageFallbackCount).toBe(0);
    } finally { detach(); viewport.remove(); }
  });

  it("keeps a nonzero page-based reserve while a cursor remains with one prompt", () => {
    const estimate = estimateHistoryReserve({ hasBefore: true, userOffset: 1, loadedUserTurns: 1, loadedHeight: 400, rowEstimate: 100, lastPageHeight: 0 });
    expect(estimate).toBe(400);
    const reserve = new HistoryReserveModel();
    reserve.configure({ hasBefore: true, userOffset: 1, loadedUserTurns: 1, loadedHeight: 400, rowEstimate: 100, rows: 4 });
    reserve.startReading();
    const initial = reserve.height;
    const initialRange = initial + 400;
    const arrivedHeight = initial * 2;
    reserve.arrived(arrivedHeight);
    expect(reserve.height).toBe(1);
    expect(reserve.height + 400 + arrivedHeight).toBeGreaterThanOrEqual(initialRange);
    reserve.configure({ hasBefore: false, userOffset: 0, loadedUserTurns: 2, loadedHeight: 400 + arrivedHeight, rowEstimate: 100, rows: 8 });
    expect(reserve.height).toBe(0);
    expect(400 + arrivedHeight).toBeGreaterThanOrEqual(initialRange - 1);
  });

  it("does not exchange reserve for streaming or disclosure growth outside an arrived page", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const step = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); };
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div"), row = document.createElement("div");
    let rowHeight = 100;
    controller.configure("/unrelated-growth"); controller.setIds(["row"]); controller.setHistoryWindow(4, 1, "cursor");
    Object.defineProperties(viewport, { clientHeight: { value: 60 }, scrollHeight: { get: () => controller.reserveHeight + controller.heights.total } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 60);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 600, viewport.scrollHeight);
    content.style.fontSize = "14px"; content.style.lineHeight = "21px";
    row.getBoundingClientRect = () => new DOMRect(0, controller.reserveHeight - viewport.scrollTop, 600, rowHeight);
    viewport.append(content); content.append(row); document.body.append(viewport); controller.content = content; controller.register("row", row);
    const detach = controller.attach(viewport);
    try {
      await step(); const before = controller.reserveHeight;
      viewport.scrollTop = 10; viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }));
      rowHeight = 350; controller.schedule(); await step();
      expect(controller.reserveHeight).toBe(before);
    } finally { detach(); viewport.remove(); vi.unstubAllGlobals(); }
  });
});
