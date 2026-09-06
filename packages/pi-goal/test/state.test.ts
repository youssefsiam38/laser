import { describe, expect, it } from "vitest";
import { goalStateFromEntries } from "../src/index.js";

describe("goalStateFromEntries", () => {
  it("returns the latest canonical session goal", () => {
    expect(goalStateFromEntries([
      { type: "custom", customType: "goal-state", data: { goal: { id: "g1", text: "Older", status: "paused", startedAt: 1, updatedAt: 2, iteration: 1, tokensUsed: 3, timeUsedSeconds: 4, automaticModelTurns: 5 } } },
      { type: "custom", customType: "goal-state", data: { goal: { id: "g2", text: "Ship it", status: "active", startedAt: 10, updatedAt: 20, activeStartedAt: 21, iteration: 2, tokensUsed: 300, timeUsedSeconds: 40, automaticModelTurns: 3, tokenBudget: 1000, waiting: { reason: "Waiting for CI", resumeAt: 99 } } } },
    ])).toEqual({ id: "g2", objective: "Ship it", status: "active", startedAt: 10, updatedAt: 20, activeStartedAt: 21, iteration: 2, tokensUsed: 300, timeUsedSeconds: 40, automaticTurns: 3, tokenBudget: 1000, latestReason: "Waiting for CI", waitingUntil: 99 });
  });

  it("honours an explicit clear", () => {
    expect(goalStateFromEntries([
      { type: "custom", customType: "goal-state", data: { goal: { id: "g1" } } },
      { type: "custom", customType: "goal-state", data: { goal: null } },
    ])).toBeNull();
  });
});
