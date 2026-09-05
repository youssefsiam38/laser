import { describe, expect, it } from "vitest";

import { computeKeyboardInset } from "../src/hooks/use-keyboard-inset.js";
import { aggregateStatus, statusRank, toneForPercent } from "../src/components/status/status.js";

describe("computeKeyboardInset", () => {
  it("uses docHeight - vv.height - vv.offsetTop, clamped at 0", () => {
    expect(computeKeyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(computeKeyboardInset(800, { height: 500, offsetTop: 100 })).toBe(200);
    expect(computeKeyboardInset(800, { height: 900, offsetTop: 0 })).toBe(0);
  });
  it("ignores browser-chrome jitter under the threshold", () => {
    expect(computeKeyboardInset(800, { height: 780, offsetTop: 0 })).toBe(0);
    expect(computeKeyboardInset(800, { height: 780, offsetTop: 0 }, 10)).toBe(20);
  });
});

describe("status vocabulary", () => {
  it("ranks waiting > error > finished_unread > working > idle", () => {
    expect(statusRank("waiting_for_input")).toBeLessThan(statusRank("error"));
    expect(statusRank("error")).toBeLessThan(statusRank("finished_unread"));
    expect(statusRank("finished_unread")).toBeLessThan(statusRank("working"));
    expect(statusRank("working")).toBeLessThan(statusRank("idle"));
  });
  it("aggregates to the most attention-worthy status", () => {
    expect(aggregateStatus([])).toBe("idle");
    expect(aggregateStatus(["idle", "working"])).toBe("working");
    expect(aggregateStatus(["working", "waiting_for_input", "error"])).toBe("waiting_for_input");
  });
});

describe("toneForPercent", () => {
  it("is calm below 70, warm below 90, danger at 90+", () => {
    expect(toneForPercent(0)).toBe("live");
    expect(toneForPercent(69)).toBe("live");
    expect(toneForPercent(70)).toBe("attention");
    expect(toneForPercent(90)).toBe("danger");
  });
});
