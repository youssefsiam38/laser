/**
 * What a map node says about a child paused on a question (M13-T45): active
 * but not working, the question as its action, counted as needing you.
 */
import { describe, expect, it } from "vitest";
import { buildAgentTree } from "../../../src/agents/index.js";
import { eventLook, nodeAction, nodeAriaLabel, nodeIsActive, nodeIsAsking, nodeStatusLabel, treeSummary } from "../../../src/components/agents/map/node-model.js";
import { run, summary } from "../fixtures.js";

const ROOT = "/p/root.jsonl";
const NOW = Date.parse("2026-09-08T10:05:00.000Z");

function tree(status: "running" | "needs_input" | "blocked") {
  const runs = [
    run({
      runId: "r-a",
      sessionPath: "/p/a.jsonl",
      subagentName: "reviewer-1",
      status,
      activity: { turns: 2, tools: 3, currentTool: "bash", lastAt: "2026-09-08T10:04:00.000Z" },
      ...(status === "needs_input" ? { question: { id: "ui-1", kind: "select" as const, title: "Which token store?", options: ["cookie", "header"], askedAt: "2026-09-08T10:04:00.000Z" } } : {}),
    }),
    run({ runId: "r-b", sessionPath: "/p/b.jsonl", subagentName: "tester-1", startedAt: "2026-09-08T10:01:00.000Z" }),
  ];
  return buildAgentTree({ rootPath: ROOT, sessions: [summary({ path: ROOT, name: "Ship it", attention: "working" })], runs });
}

describe("a node paused on a question", () => {
  it("is active without working, says the question as its action, and reads as Asking", () => {
    const node = tree("needs_input").byPath.get("/p/a.jsonl")!;
    expect(nodeIsActive(node)).toBe(true);
    expect(nodeIsAsking(node)).toBe(true);
    expect(nodeStatusLabel(node.status)).toBe("Asking");
    expect(node.tone).toBe("attention");
    expect(nodeAction(node)).toBe("Which token store?");
    expect(nodeAriaLabel(node, NOW)).toBe("reviewer, reviewer-1, Asking, 5 minutes");
  });

  it("counts as needing you in the tree summary, not as working", () => {
    expect(treeSummary(tree("needs_input").nodes)).toBe("2 agents · 1 working · 1 needs you");
    expect(treeSummary(tree("running").nodes)).toBe("2 agents · 2 working");
    expect(treeSummary(tree("blocked").nodes)).toBe("2 agents · 1 working · 1 needs you");
  });

  it("keeps the tool as the action while it is only working", () => {
    const node = tree("running").byPath.get("/p/a.jsonl")!;
    expect(nodeIsAsking(node)).toBe(false);
    expect(nodeAction(node)).toBe("bash");
  });

  it("gives the question event its own look, in the attention tone", () => {
    expect(eventLook("needs_input").tone).toBe("attention");
    expect(eventLook("needs_input").icon).not.toBe(eventLook("blocked").icon);
  });
});
