import { describe, expect, it } from "vitest";
import { allowanceExplanation, allowanceWindowLabel, groupAllowances, resetLabel } from "../../src/components/shell/account-allowance.js";

describe("account allowance presentation", () => {
  it("groups periods by identity, preserves order and never adds percentages", () => {
    const windows = [
      { limitId: "spark", limitName: "Spark", kind: "primary" as const, usedPercent: 20 },
      { limitId: "other", limitName: "Spark", kind: "primary" as const, usedPercent: 35 },
      { limitId: "spark", limitName: "Spark", kind: "secondary" as const, usedPercent: 70 },
      { limitName: "Future bucket", kind: "primary" as const, usedPercent: 0 },
    ];
    const groups = groupAllowances(windows);
    expect(groups.map(group => group.windows.length)).toEqual([2, 1, 1]);
    expect(groups[0]?.windows).toEqual([windows[0], windows[2]]);
    expect(groups.flatMap(group => group.windows)).toHaveLength(4);
  });
  it("explains known buckets and explicitly qualifies reserve and unknown meanings", () => {
    expect(allowanceExplanation({ id: "id:codex_bengalfox", name: "GPT-5.3-Codex-Spark" }).text).toContain("not standard GPT-5.3-Codex");
    expect(allowanceExplanation({ id: "id:base_model_inference", name: "gpt-reserve" })).toMatchObject({ text: expect.stringContaining("not defined") });
    expect(allowanceExplanation({ id: "id:future", name: "Future" }).text).toContain("not documented here");
    expect(allowanceExplanation({ id: "id:code-review", name: "Code review" }).source).toMatch(/^https:\/\/learn.chatgpt.com\//);
  });
  it("does not invent fixed 5-hour/weekly durations for unfamiliar windows", () => {
    expect(allowanceWindowLabel(300, "primary")).toBe("5-hour allowance");
    expect(allowanceWindowLabel(10080, "secondary")).toBe("Weekly allowance");
    expect(allowanceWindowLabel(15, "primary")).toBe("15-minute allowance");
    expect(allowanceWindowLabel(301, "primary")).toBe("301-minute allowance");
    expect(allowanceWindowLabel(undefined, "primary")).toBe("Primary allowance");
  });
  it("formats live remaining time, exact local dates and unavailable/elapsed timestamps", () => {
    const now = Date.UTC(2026, 8, 7, 12);
    const reset = now / 1000 + 90060;
    expect(resetLabel(reset, "remaining", now)).toBe("Resets in 1d 1h 1m");
    expect(resetLabel(reset, "remaining", now + 60000)).toBe("Resets in 1d 1h");
    expect(resetLabel(now / 1000, "remaining", now)).toBe("Reset due · refresh to check");
    expect(resetLabel(undefined, "time", now)).toBe("Reset unavailable");
    expect(resetLabel(NaN, "remaining", now)).toBe("Reset unavailable");
    expect(resetLabel(reset, "time", now)).toBe(`Resets ${new Date(reset * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`);
  });
});
