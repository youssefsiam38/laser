import { describe, expect, it } from "vitest";
import { isOpenAICodexProvider, parseOpenAICodexUsage } from "../src/modules/account-usage.js";

describe("OpenAI Codex account usage", () => {
  it("recognizes Pi's named account providers", () => {
    expect(isOpenAICodexProvider("openai-codex")).toBe(true);
    expect(isOpenAICodexProvider("openai-codex-2")).toBe(true);
    expect(isOpenAICodexProvider("openai")).toBe(false);
  });

  it("normalizes allowance windows and purchased credits without credentials", () => {
    const snapshot = parseOpenAICodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 24.5, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
      },
      credits: { has_credits: true, unlimited: false, balance: "42.7500" },
      access_token: "must not cross the boundary",
    });
    expect(snapshot).toMatchObject({
      provider: "openai-codex",
      planType: "pro",
      windows: [
        { kind: "primary", usedPercent: 24.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        { kind: "secondary", usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "42.7500" },
    });
    expect(snapshot).not.toHaveProperty("access_token");
  });

  it("accepts the camel-case app-server-shaped window vocabulary", () => {
    expect(parseOpenAICodexUsage({ rateLimits: { primary: { usedPercent: 10, windowMinutes: 300 } } }))
      .toMatchObject({ windows: [{ kind: "primary", usedPercent: 10, windowDurationMins: 300 }] });
    expect(parseOpenAICodexUsage({ unrelated: true })).toBeUndefined();
  });
});
