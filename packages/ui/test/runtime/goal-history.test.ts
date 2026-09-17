import { describe, expect, it } from "vitest";
import { goalRecords } from "../../src/runtime/goal-history.js";
import { GOAL_DATA_PART, projectMessages } from "../../src/runtime/projection.js";
import { applyUpdate, blocksFromEntries, type SessionView } from "../../src/store.js";
import { MESSAGE_METADATA_NS } from "@lasercode/protocol";

const objective = 'Compare "root compose"  with docker/compose\nDo not edit files.';
const state = (id: string, status: string, updatedAt: number, text = objective) => ({ type: "custom", customType: "goal-state", id: `e-${id}-${updatedAt}`, data: { goal: { id, text, status, startedAt: 1, updatedAt, iteration: 0 } } });
const prompt = (id: string) => ({ type: "message", message: { role: "user", content: `Goal mode is active.\n<goal_objective>\n${objective}\n</goal_objective>\n<goal_id>\n${id}\n</goal_id>\nInternal rules\n<!-- pi-goal-prompt:test-${id} -->` } });
const clear = { type: "custom", customType: "goal-state", data: { goal: null } };
const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "complete", name: "goal_complete", arguments: { goal_id: "g2", summary: "Root is for development; docker/ is for CI." } }] } };
const result = { type: "message", message: { role: "toolResult", toolCallId: "complete", content: "Goal complete: Root is for development; docker/ is for CI." } };
const entries = [state("g1", "active", 1), prompt("g1"), state("g1", "paused", 2), state("g2", "active", 3), prompt("g2"), call, state("g2", "complete", 4), clear, result];

describe("durable goal presentation", () => {
  it("retains initial objective, edit/resume IDs and outcome after automatic clear", () => {
    const blocks = blocksFromEntries(entries);
    const goals = goalRecords(entries, blocks);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ objective, ids: ["g1", "g2"], status: "complete", summary: "Root is for development; docker/ is for CI." });
    expect(goals[0]!.moments.map(moment => moment.status)).toEqual(["active", "paused", "active", "complete"]);
    expect(JSON.stringify(goals)).not.toMatch(/tokensUsed|tokenBudget|timeUsedSeconds/);
  });
  it("shows the goal setter once and completion outside the tool aggregate", () => {
    const withQuestion = [...entries, { type: "message", message: { role: "user", content: "Next question" } }];
    const blocks = blocksFromEntries(withQuestion);
    const projected = projectMessages({ blocks, running: false, dialogs: [], goals: goalRecords(withQuestion, blocks) });
    const users = projected.messages.filter(message => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]!.content).toEqual([{ type: "text", text: objective }]);
    expect(users[0]!.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ goalSetter: true, userOrdinal: 0 });
    expect(users[1]!.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ userOrdinal: 2 });
    const text = JSON.stringify(projected.messages);
    expect(text).toContain(GOAL_DATA_PART);
    expect(text).not.toContain('"toolName":"goal_complete"');
    expect(text).not.toContain("Internal rules");
  });
  it("keeps rejected completion tools and ordinary look-alike messages visible", () => {
    const blocks = blocksFromEntries([state("g1", "active", 1), call, { ...result, message: { ...result.message, content: "Goal completion rejected: stale ID" } }]);
    const goals = goalRecords([state("g1", "active", 1)], blocks);
    expect(goals[0]?.completionToolId).toBeUndefined();
    expect(projectMessages({ blocks: [{ kind: "user", files: [], id: "u", text: "Goal mode is active. Normal user text", images: [] }], goals, running: false, dialogs: [] }).messages[0]?.content).toEqual([{ type: "text", text: "Goal mode is active. Normal user text" }]);
  });
  it("deduplicates live custom entries and retains them after clear", () => {
    let view = { entries: [], blocks: [] } as unknown as SessionView;
    const event = { kind: "entry_appended", entry: state("g1", "active", 1) } as const;
    view = applyUpdate(applyUpdate(view, event), event);
    expect(view.entries).toHaveLength(1);
    view = applyUpdate(view, { kind: "entry_appended", entry: clear });
    expect(goalRecords(view.entries, view.blocks)[0]?.status).toBe("cleared");
    expect(goalRecords([], [])).toEqual([]);
  });
});

describe("goal context before a history page", () => {
  // A long goal writes a record per step; the page carries only the first and
  // last of each run of identical moments, and goal history must not change.
  it("compacts repeated goal records without changing the goal history", async () => {
    const { historyWindow } = await import("@lasercode/protocol");
    const rows: Record<string, unknown>[] = [];
    let parent: string | null = null;
    const push = (row: Record<string, unknown>) => { const id = `r${rows.length}`; rows.push({ ...row, id, parentId: parent, timestamp: new Date(1_000 + rows.length).toISOString() }); parent = id; };
    let updatedAt = 10;
    for (const [goalId, startedAt] of [["g1", 5], ["g2", 5], ["g3", 900]] as const) {
      for (let run = 0; run < 12; run++) {
        const waiting = run % 3 === 1 ? { reason: "Waiting for your answer." } : undefined;
        for (let step = 0; step < 25; step++) {
          push({ type: "custom", customType: "goal-state", data: { goal: { id: goalId, text: `Objective ${startedAt}`, status: run === 11 && goalId === "g3" ? "complete" : "active", startedAt, updatedAt: updatedAt++, iteration: run * 25 + step, ...(waiting ? { waiting } : {}) } } });
          push({ type: "message", message: { role: "assistant", content: `step ${step}` } });
        }
      }
      if (goalId === "g2") push({ type: "custom", customType: "goal-state", data: { goal: null } });
    }
    push({ type: "message", message: { role: "user", content: "Latest" } });
    push({ type: "message", message: { role: "assistant", content: "Reply" } });

    const scope = { sessionId: "11111111-2222-3333-4444-555555555555", epoch: "w", seq: 0, revision: "r1.AAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBB", environmentKey: "e1.CCCCCCCCCCCCCCCCCCCCCC" };
    const page = historyWindow({ entries: rows, leafId: parent }, { tail: 2 }, scope);
    const full = rows.slice(0, rows.length - page.entries.length).filter(row => row.customType === "goal-state");
    expect(page.window.context.length).toBeLessThan(full.length / 5);
    expect(goalRecords([...page.window.context, ...page.entries], [])).toEqual(goalRecords([...full, ...page.entries], []));
  });
});
