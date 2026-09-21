import { describe, expect, it } from "vitest";
import type { ProjectTaskState } from "@lasercode/protocol";

import { actionForDrop, boardColumns, checkDrop } from "../../src/project-work/board.js";
import { BOARD_COLUMNS, boardColumnLabel, stateLabel, stateTone } from "../../src/project-work/vocabulary.js";

import { item } from "./fixture.js";

const task = (state: ProjectTaskState, over: { unmet?: string[]; number?: number } = {}) =>
  item({
    entityId: `t-${state}`,
    kind: "task",
    number: over.number ?? 44,
    state,
    ...(over.unmet ? { unmetDependencies: over.unmet } : {}),
  });

describe("the board's drops", () => {
  it("refuses an illegal move with the state machine's own sentence", () => {
    expect(checkDrop(task("draft"), "needs_review")).toEqual({ allowed: false, reason: "draft cannot become needs_review." });
    expect(checkDrop(task("done"), "ready")).toMatchObject({ allowed: false });
  });

  it("refuses a start and a ready by naming the keys that are missing", () => {
    const blocked = task("draft", { unmet: ["TASK-12", "TASK-13"] });
    expect(checkDrop(blocked, "ready")).toEqual({ allowed: false, reason: "TASK-12, TASK-13 must be done first." });
    expect(checkDrop(task("ready", { unmet: ["SPEC-1"] }), "in_progress")).toEqual({
      allowed: false,
      reason: "SPEC-1 must be done first.",
    });
  });

  it("asks for the right action, and they are not interchangeable", () => {
    expect(actionForDrop("ready", "in_progress")).toBe("start");
    expect(actionForDrop("needs_review", "in_progress")).toBe("request_changes");
    expect(actionForDrop("done", "in_progress")).toBe("reopen");
    expect(actionForDrop("in_progress", "needs_review")).toBe("submit_for_review");
    expect(actionForDrop("draft", "cancelled")).toBe("cancel");
  });

  it("lets a completion through to the host, which owns the evidence rule", () => {
    // This window cannot see acceptance evidence, so it does not pretend to:
    // the drop is sent and the engine's refusal is what a person reads.
    expect(checkDrop(task("in_progress"), "done")).toEqual({ allowed: true, action: "complete" });
    expect(checkDrop(task("needs_review"), "done")).toEqual({ allowed: true, action: "complete" });
  });

  it("says nothing useless about a card dropped back where it was", () => {
    expect(checkDrop(task("ready"), "ready")).toEqual({ allowed: false, reason: "TASK-44 is already there." });
  });

  it("puts every task in exactly one column, and keeps artifacts out", () => {
    const rows = [
      task("draft", { number: 1 }),
      task("in_progress", { number: 2 }),
      item({ entityId: "s1", kind: "spec", number: 1 }),
      item({ entityId: "t9", kind: "task", number: 9, archived: true }),
    ];
    const columns = boardColumns(rows, BOARD_COLUMNS);
    expect(columns.map((column) => column.rows.length)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(columns.flatMap((column) => column.rows).every((row) => row.kind === "task")).toBe(true);
  });
});

describe("the vocabulary each kind speaks", () => {
  it("names the Task states the way the board does", () => {
    expect(BOARD_COLUMNS.map(boardColumnLabel)).toEqual(["To do", "Ready", "Blocked", "Running", "Needs review", "Done"]);
    expect(stateLabel("task", "in_progress")).toBe("Running");
  });

  it("says the same wire state differently for different kinds", () => {
    expect(stateLabel("spec", "needs_review")).toBe("Awaiting approval");
    expect(stateLabel("design", "needs_review")).toBe("Awaiting design approval");
    expect(stateLabel("research", "needs_review")).toBe("Awaiting review");
    expect(stateLabel("task", "needs_review")).toBe("Needs review");
  });

  it("uses the existing status tones and introduces no new one", () => {
    expect(stateTone("in_progress")).toBe("live");
    expect(stateTone("needs_review")).toBe("attention");
    expect(stateTone("stale")).toBe("attention");
    expect(stateTone("blocked")).toBe("attention");
    expect(stateTone("approved")).toBe("ok");
    expect(stateTone("done")).toBe("ok");
    expect(stateTone("draft")).toBe("muted");
  });
});
