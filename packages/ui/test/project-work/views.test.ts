import { afterEach, describe, expect, it } from "vitest";

import { nextKeyFor } from "../../src/components/project-work/CreateDialog.js";
import { titleFromText } from "../../src/components/project-work/create-work.js";
import {
  applyFilter,
  deleteView,
  EMPTY_FILTER,
  isEmptyFilter,
  resetSavedViews,
  sameFilter,
  saveView,
  sortWork,
} from "../../src/project-work/views.js";

import { item } from "./fixture.js";

const rows = [
  item({ entityId: "a", kind: "spec", number: 1, title: "The relay", updatedAt: "2026-01-05T00:00:00.000Z" }),
  item({ entityId: "b", kind: "task", number: 2, title: "Wire the board", updatedAt: "2026-01-04T00:00:00.000Z", needsAttention: true, state: "blocked" }),
  item({ entityId: "c", kind: "task", number: 12, title: "Ship it", updatedAt: "2026-01-06T00:00:00.000Z", linkCounts: { edges: 1, repository: 0, execution: 0 } }),
  item({ entityId: "d", kind: "design", number: 3, title: "The relay screen", updatedAt: "2026-01-01T00:00:00.000Z", archived: true }),
];

afterEach(() => resetSavedViews());

describe("the backlog's filters", () => {
  it("hides archived work until it is asked for", () => {
    expect(applyFilter(rows, EMPTY_FILTER).map((row) => row.key)).toEqual(["SPEC-1", "TASK-2", "TASK-12"]);
    expect(applyFilter(rows, { ...EMPTY_FILTER, includeArchived: true })).toHaveLength(4);
  });

  it("filters by type, by text, by needs-you and by having a link", () => {
    expect(applyFilter(rows, { ...EMPTY_FILTER, kinds: ["task"] }).map((row) => row.key)).toEqual(["TASK-2", "TASK-12"]);
    expect(applyFilter(rows, { ...EMPTY_FILTER, text: "relay" }).map((row) => row.key)).toEqual(["SPEC-1"]);
    expect(applyFilter(rows, { ...EMPTY_FILTER, text: "TASK-12" }).map((row) => row.key)).toEqual(["TASK-12"]);
    expect(applyFilter(rows, { ...EMPTY_FILTER, needsYou: true }).map((row) => row.key)).toEqual(["TASK-2"]);
    expect(applyFilter(rows, { ...EMPTY_FILTER, hasLink: true }).map((row) => row.key)).toEqual(["TASK-12"]);
  });

  it("sorts by recency, by key as a number, and puts an exact key first", () => {
    expect(sortWork(rows, "updated").map((row) => row.key)).toEqual(["TASK-12", "SPEC-1", "TASK-2", "DES-3"]);
    // TASK-2 before TASK-12: the number is a number.
    expect(sortWork(rows, "key").map((row) => row.key)).toEqual(["DES-3", "SPEC-1", "TASK-2", "TASK-12"]);
    expect(sortWork(rows, "updated", "task-2")[0]?.key).toBe("TASK-2");
  });

  it("puts what needs a person first when sorting by status", () => {
    expect(sortWork(rows, "status")[0]?.key).toBe("TASK-2");
  });
});

describe("saved views", () => {
  it("is a named filter, and nothing more", () => {
    const view = saveView("p1", { name: "Tasks that need me", filter: { ...EMPTY_FILTER, kinds: ["task"], needsYou: true }, sort: "status" });
    expect(view.id).toBeTruthy();
    expect(sameFilter(view.filter, { ...EMPTY_FILTER, kinds: ["task"], needsYou: true })).toBe(true);
    expect(isEmptyFilter(view.filter)).toBe(false);

    saveView("p1", { ...view, name: "Mine" });
    deleteView("p1", "nope");
    expect(isEmptyFilter(EMPTY_FILTER)).toBe(true);
    deleteView("p1", view.id);
  });
});

describe("the next key, and the title a command derives", () => {
  it("shows the key this project hands out next, per kind", () => {
    const keys = ["SPEC-1", "SPEC-12", "TASK-3"];
    expect(nextKeyFor("spec", keys)).toBe("SPEC-13");
    expect(nextKeyFor("task", keys)).toBe("TASK-4");
    expect(nextKeyFor("research", keys)).toBe("RES-1");
  });

  it("takes the first line as a title and never loses the rest", () => {
    expect(titleFromText("Ship the relay\n\nand everything under it")).toBe("Ship the relay");
    expect(titleFromText("  ")).toBe("");
    const long = "a".repeat(60) + " " + "b".repeat(40);
    expect(titleFromText(long)).toBe(`${"a".repeat(60)}…`);
    expect(titleFromText(long).length).toBeLessThanOrEqual(81);
  });
});
