import { describe, expect, it } from "vitest";
import type { LogEntry } from "@lasercode/protocol";
import { adoptCaptures, NO_SHOWN_CAPTURES } from "../../src/components/logs/captures.js";

const capture = (id: number): LogEntry => ({
  id, at: `2026-09-06T10:0${id}:00.000Z`, section: "provider", kind: "provider_request", level: "info",
  summary: "test-model", sessionPath: "/session",
});

describe("adoptCaptures", () => {
  it("takes the first read whole and selects its newest-first head", () => {
    const shown = adoptCaptures(NO_SHOWN_CAPTURES, [capture(1), capture(2)]);
    expect(shown.entries.map((row) => row.id)).toEqual([1, 2]);
    expect(shown.selected).toBe(1);
  });

  it("offers a capture that arrived since, without moving the person's selection", () => {
    const first = adoptCaptures(NO_SHOWN_CAPTURES, [capture(1), capture(2)]);
    const chosen = { ...first, selected: 2 };
    const refreshed = adoptCaptures(chosen, [capture(1), capture(2), capture(3)]);
    expect(refreshed.entries.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(refreshed.selected).toBe(2);
  });

  it("keeps the object a shown capture already has, so its body is not re-read", () => {
    const first = adoptCaptures(NO_SHOWN_CAPTURES, [capture(1)]);
    const again = adoptCaptures(first, [{ ...capture(1) }]);
    expect(again).toBe(first);
    expect(again.entries[0]).toBe(first.entries[0]);
  });

  it("leaves what is being read alone when a read finds nothing", () => {
    const first = adoptCaptures(NO_SHOWN_CAPTURES, [capture(1)]);
    expect(adoptCaptures(first, [])).toBe(first);
    expect(adoptCaptures(NO_SHOWN_CAPTURES, [])).toBe(NO_SHOWN_CAPTURES);
  });

  it("falls back to the head only when the chosen capture is no longer offered", () => {
    const chosen = { ...adoptCaptures(NO_SHOWN_CAPTURES, [capture(1), capture(2)]), selected: 2 };
    const expired = adoptCaptures(chosen, [capture(3)]);
    expect(expired.entries.map((row) => row.id)).toEqual([3]);
    expect(expired.selected).toBe(3);
  });
});
