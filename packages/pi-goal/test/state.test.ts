import { describe, expect, it } from "vitest";
import { goalStateFromEntries } from "../src/index.js";

describe("goalStateFromEntries", () => {
  it("returns the latest canonical session goal", () => {
    expect(goalStateFromEntries([
      { type: "custom", customType: "goal-state", data: { goal: { id: "g1", text: "Older", status: "paused", startedAt: 1, updatedAt: 2, iteration: 1, tokensUsed: 3, timeUsedSeconds: 4, automaticModelTurns: 5 } } },
      { type: "custom", customType: "goal-state", data: { goal: { id: "g2", text: "Ship it", status: "active", startedAt: 10, updatedAt: 20, activeStartedAt: 21, iteration: 2, tokensUsed: 300, timeUsedSeconds: 40, automaticModelTurns: 3, tokenBudget: 1000, waiting: { reason: "Waiting for CI", resumeAt: 99 } } } },
    ])).toEqual({ id: "g2", objective: "Ship it", status: "active", startedAt: 10, updatedAt: 20, iteration: 2, automaticTurns: 3, latestReason: "Waiting for CI", waitingUntil: 99 });
  });

  it("projects only a transition adjacent to the latest canonical state", () => {
    const interrupted = { id: "g1", text: "Ship it", status: "active", startedAt: 1, updatedAt: 2, iteration: 3, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0, automaticModelTurns: 0, toolFreeRepeatCount: 0 };
    expect(goalStateFromEntries([
      { type: "custom", customType: "goal-state", data: { goal: interrupted } },
      { type: "custom", customType: "goal-transition", data: { goalId: "g1", at: 3, cause: "parent_control", initiator: "agent", previousStatus: "active", status: "active", abortReason: "Parent interrupted the turn", invocationId: "3:9", runId: "run_9" } },
    ])).toMatchObject({
      status: "active",
      latestReason: "Interrupted by agent: Parent interrupted the turn",
      transition: { cause: "parent_control", initiator: "agent", previousStatus: "active", status: "active", invocationId: "3:9", runId: "run_9" },
    });
    expect(goalStateFromEntries([
      { type: "custom", customType: "goal-state", data: { goal: interrupted } },
      { type: "custom", customType: "goal-transition", data: { goalId: "g1", at: 3, cause: "parent_control", initiator: "agent", previousStatus: "active", status: "active", abortReason: "Parent interrupted the turn", invocationId: "3:9" } },
      { type: "custom", customType: "goal-state", data: { goal: { ...interrupted, updatedAt: 4, iteration: 4 } } },
    ])?.latestReason).toBeUndefined();
  });

  it("honours an explicit clear", () => {
    expect(goalStateFromEntries([
      { type: "custom", customType: "goal-state", data: { goal: { id: "g1" } } },
      { type: "custom", customType: "goal-state", data: { goal: null } },
    ])).toBeNull();
  });
});
