// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

import { messageTimeDescription, messageTimeLabel } from "../../src/components/assistant-ui/elements/message-timestamp.js";
import { hoverReveal } from "../../src/components/assistant-ui/elements/message-pair.js";

describe("message timestamps", () => {
  const message = new Date(2026, 8, 6, 16, 5);

  it("uses the person's local clock rather than a machine timestamp", () => {
    expect(messageTimeLabel(message, "en-US")).toBe("4:05 PM");
  });

  it("describes recent dates in natural language", () => {
    expect(messageTimeDescription(message, new Date(2026, 8, 6, 18), "en-US")).toBe("Today at 4:05 PM");
    expect(messageTimeDescription(message, new Date(2026, 8, 7, 18), "en-US")).toBe("Yesterday at 4:05 PM");
    expect(messageTimeDescription(message, new Date(2027, 8, 7, 18), "en-US")).toContain("Sep 6, 2026 at 4:05 PM");
  });

  it("caches formatters separately by locale and clears them on languagechange", () => {
    window.dispatchEvent(new Event("languagechange"));
    const construct = vi.spyOn(Intl, "DateTimeFormat");
    expect(messageTimeLabel(message, "en-US")).toBe("4:05 PM");
    expect(messageTimeLabel(message, "en-US")).toBe("4:05 PM");
    expect(messageTimeLabel(message, "de-DE")).toBe("16:05");
    expect(construct).toHaveBeenCalledTimes(2);
    messageTimeLabel(message);
    expect(construct).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new Event("languagechange"));
    messageTimeLabel(message, "en-US");
    expect(construct).toHaveBeenCalledTimes(4);
  });

  it("recomputes day labels across midnight rather than caching Today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 6, 23, 59, 59));
    expect(messageTimeDescription(message, undefined, "en-US")).toBe("Today at 4:05 PM");
    vi.advanceTimersByTime(2_000);
    expect(messageTimeDescription(message, undefined, "en-US")).toBe("Yesterday at 4:05 PM");
  });

  it("reveals row details for pointer, keyboard and touch users", () => {
    expect(hoverReveal).toContain("group-hover/message:opacity-100");
    expect(hoverReveal).toContain("group-focus-within/message:opacity-100");
    expect(hoverReveal).toContain("[@media(pointer:coarse)]:opacity-100");
  });
});
