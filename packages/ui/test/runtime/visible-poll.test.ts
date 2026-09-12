// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { startVisiblePoll } from "../../src/runtime/visible-poll.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("pauses hidden polling, reconciles immediately once on return, and releases all work on disconnect", () => {
  vi.useFakeTimers();
  let visible: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
  const refresh = vi.fn(), baseline = vi.fn();
  const old = setInterval(baseline, 20_000);
  const stop = startVisiblePoll(refresh, 20_000);
  const visibility = (next: DocumentVisibilityState) => { visible = next; document.dispatchEvent(new Event("visibilitychange")); };
  try {
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(baseline).toHaveBeenCalledTimes(3);
    refresh.mockClear(); baseline.mockClear();
    visibility("hidden");
    vi.advanceTimersByTime(60_000);
    expect(baseline).toHaveBeenCalledTimes(3);
    expect(refresh).not.toHaveBeenCalled();
    visibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    visibility("hidden"); visibility("visible");
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally { stop(); clearInterval(old); }
});

it("starts hidden without an interval and fences a tick before the hidden event is delivered", () => {
  vi.useFakeTimers();
  let visible: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
  const refresh = vi.fn(), stop = startVisiblePoll(refresh, 20_000);
  try {
    expect(vi.getTimerCount()).toBe(0);
    visible = "visible"; document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
    visible = "hidden";
    vi.advanceTimersByTime(20_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally { stop(); }
  expect(vi.getTimerCount()).toBe(0);
});
