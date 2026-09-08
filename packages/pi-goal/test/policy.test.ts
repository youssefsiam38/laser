import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { GOAL_TOOL_NAMES, goalExtensionPath } from "../src/index.js";

const root = dirname(goalExtensionPath());
// Deliberately exercise the exact patched dependency, not a copy of its parser.
const engine = await import(pathToFileURL(join(root, "chunks/chunk-QWIUWKRW.js")).href);
const accounting = await import(pathToFileURL(join(root, "chunks/chunk-UQRRW4CY.js")).href);

describe("goal tool names", () => {
  it("names exactly the tools the installed engine registers", () => {
    // The gate that attaches these only while a goal is active (D-146) keys on
    // the names, so a version that renames or adds one must fail here rather
    // than quietly leaving a tool attached to every session.
    expect([engine.GOAL_COMPLETE_TOOL, engine.GOAL_BLOCKED_TOOL, engine.GOAL_WAIT_TOOL]).toEqual([...GOAL_TOOL_NAMES]);
    const source = readFileSync(goalExtensionPath(), "utf8");
    const registered = [...source.matchAll(/pi\.registerTool\(([A-Za-z0-9_]+)\)/g)].map((match) => match[1]);
    expect(registered).toEqual(["goalCompleteTool", "goalBlockedTool", "goalWaitTool"]);
    expect(GOAL_TOOL_NAMES).toHaveLength(registered.length);
  });
});

describe("goal policy", () => {
  it("preserves objective punctuation, spaces, quotes and newlines", () => {
    const objective = 'Compare "root compose"  with docker/compose\nDon\'t edit either.';
    expect(engine.parseCommand(objective)).toEqual({ kind: "start", objective });
    expect(engine.parseCommand(`edit ${objective}`)).toEqual({ kind: "edit", objective });
  });
  it("rejects removed budgets and does not offer budget completions", () => {
    expect(engine.parseCommand("--tokens 100k inspect this")).toMatch(/do not have token budgets/);
    expect(engine.parseCommand("edit --tokens 100k inspect this")).toMatch(/do not have token budgets/);
    expect(engine.completeGoalArguments("").some((item: { value: string }) => item.value.includes("tokens"))).toBe(false);
    expect(engine.createGoal("Inspect", 1, 100).tokenBudget).toBeUndefined();
  });
  it("never reads session usage and never accumulates goal accounting", () => {
    const ctx = { get sessionManager() { throw new Error("Goal must not read usage"); } };
    const goal = engine.createGoal("Inspect", undefined, 0);
    expect(accounting.currentTokenTotal(ctx)).toBe(0);
    accounting.updateGoalUsage(goal, ctx);
    accounting.checkpointGoalActiveTime(goal, Date.now() + 50000, true);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.timeUsedSeconds).toBe(0);
    expect(goal.activeStartedAt).toBeUndefined();
  });
  it("ignores historical budgets and accounting while preserving continuation safety", () => {
    const saved = { ...engine.createGoal("Inspect", undefined, 0), status: "budget_limited", tokenBudget: 500, tokensUsed: 600, timeUsedSeconds: 90, baselineTokens: 10, automaticModelTurns: 25 };
    const loaded = engine.loadGoalStateFromSession({ sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal: saved } }] } }).goal;
    expect(loaded).toMatchObject({ text: "Inspect", status: "paused", tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0, automaticModelTurns: 25 });
    expect(loaded.tokenBudget).toBeUndefined();
    expect(loaded.activeStartedAt).toBeUndefined();
  });
  it("keeps completion terminating, without adding a final-answer instruction", () => {
    const source = readFileSync(goalExtensionPath(), "utf8");
    const completion = source.slice(source.indexOf("const goalCompleteTool"), source.indexOf("const goalBlockedTool"));
    expect(completion).toContain("terminate: true");
    expect(completion).toContain("runtime.clearCompletedGoal(ctx)");
    expect(completion).not.toMatch(/final.answer|visible.answer/i);
  });
});
