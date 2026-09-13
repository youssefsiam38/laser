// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { TranscriptViewport } from "../../src/components/thread/transcript-viewport.js";
import { HeightIndex } from "../../src/components/thread/transcript-window.js";

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
  it.each(["wheel", "touchstart", "pointerdown", "keydown"])("keeps an explicit version detached through queued layout scrolls until %s intent", async intent => {
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
    const tail = vi.fn(() => { viewport.scrollTop = total - viewport.clientHeight; });
    const detach = controller.attach(viewport, tail);
    try {
      await step(); viewport.dispatchEvent(new Event("scroll")); tail.mockClear();
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
      expect(tail).not.toHaveBeenCalled();
      // Real scroll intent releases ownership, so reaching the bottom can follow.
      viewport.dispatchEvent(intent === "keydown" ? new KeyboardEvent("keydown", { key: "PageDown" }) : new Event(intent));
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
    const detach = controller.attach(viewport, () => { viewport.scrollTop = total - 600; });
    try {
      viewport.scrollTop = total - 600; viewport.dispatchEvent(new Event("scroll")); await step();
      // The person wheels up a long way: the anchor is now an unmounted row.
      viewport.dispatchEvent(new Event("wheel"));
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
  it("does not alternate mounted windows when a phone version target evicts the old reading anchor", async () => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div"), content = document.createElement("div");
    const ids = Array.from({ length: 100 }, (_, i) => `row-${i}`), nodes = new Map<string, HTMLElement>();
    controller.configure("/phone", "new-leaf"); controller.setIds(ids);
    controller.content = content; controller.heights = new HeightIndex(ids.map(() => 100));
    Object.defineProperties(viewport, { clientHeight: { value: 844 }, scrollHeight: { value: 10000 } });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
    content.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 390, 10000);
    viewport.append(content); document.body.append(viewport);
    const detach = controller.attach(viewport, () => {});
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
  it.each(["wheel", "touchstart", "pointerdown", "keydown", "path", "branch", "destination"])("cancels an active explicit destination on newer %s intent", async intent => {
    const controller = new TranscriptViewport(), viewport = document.createElement("div");
    controller.configure("/one", "leaf"); controller.setIds(["message"]);
    const detach = controller.attach(viewport, () => {});
    try {
      const pending = controller.ensureVisible({ messageId: "message", leafId: "leaf" }, { reason: "action" });
      if (intent === "path") controller.configure("/two");
      else if (intent === "branch") controller.setIds(["other"]);
      else if (intent === "destination") controller.latest();
      else viewport.dispatchEvent(intent === "keydown" ? new KeyboardEvent("keydown", { key: "PageDown" }) : new Event(intent));
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
    const detach = controller.attach(viewport, () => {});
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
});
