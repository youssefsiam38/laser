import { describe, expect, it } from "vitest";
import type { BackgroundTask } from "@lasercode/protocol";

import { branchIsActive, buildFleet, flattenFleet, fleetSummary, partitionItems, type FleetGroup } from "../../src/fleet/model.js";
import { run, summary, view } from "../agents/fixtures.js";

const ROOT = "/p/root.jsonl";
const OTHER = "/p/other.jsonl";
const NOW = Date.parse("2026-09-08T10:05:00.000Z");

const task = (over: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "sessionPath">): BackgroundTask => ({
  command: "pnpm -r test",
  title: "pnpm -r test",
  status: "running",
  origin: "background",
  startedAt: "2026-09-08T10:00:00.000Z",
  outputBytes: 0,
  ...over,
});

const byId = <T extends { runId?: string; id?: string }>(list: readonly T[], key: "runId" | "id"): Record<string, T> =>
  Object.fromEntries(list.map((item) => [String(item[key]), item]));

const build = (input: Partial<Parameters<typeof buildFleet>[0]> = {}): FleetGroup[] =>
  buildFleet({ sessions: [], runs: {}, tasks: {}, views: {}, now: NOW, ...input });

describe("buildFleet", () => {
  it("is empty when there is no agent work and no background command", () => {
    expect(build({ sessions: [summary({ path: ROOT })] })).toEqual([]);
    expect(fleetSummary([])).toEqual({ running: 0, needsYou: 0, attention: "idle" });
  });

  it("groups by top-level session and nests a child agent under its parent", () => {
    const parent = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
    const grandchild = run({
      runId: "r2",
      sessionPath: "/p/grandchild.jsonl",
      subagentName: "reader",
      depth: 2,
      parent: { sessionPath: "/p/child.jsonl", sessionId: "child", runId: "r1" },
    });
    const groups = build({
      sessions: [summary({ path: ROOT, name: "Root session" }), summary({ path: "/p/child.jsonl" }), summary({ path: "/p/grandchild.jsonl" })],
      runs: byId([parent, grandchild], "runId"),
      views: { [ROOT]: view({ path: ROOT }) },
      currentPath: ROOT,
    });
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.path).toBe(ROOT);
    expect(group.title).toBe("Root session");
    // The root session is the header, never an item of its own.
    expect(group.items.map((item) => item.title)).toEqual(["explorer"]);
    expect(group.items[0]!.children.map((item) => item.title)).toEqual(["reader"]);
    expect(group.items[0]!.depth).toBe(0);
    expect(group.items[0]!.children[0]!.depth).toBe(1);
    expect(flattenFleet(group.items)).toHaveLength(2);
  });

  it("hangs a background command off the session that started it, not off the group", () => {
    const child = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
    const groups = build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" })],
      runs: byId([child], "runId"),
      tasks: byId([task({ id: "t-root", sessionPath: ROOT, title: "vite dev" }), task({ id: "t-child", sessionPath: "/p/child.jsonl" })], "id"),
    });
    const group = groups[0]!;
    // The root's command is a top-level item; the child's belongs to the child.
    expect(group.items.map((item) => [item.kind, item.title])).toEqual([
      ["agent", "explorer"],
      ["task", "vite dev"],
    ]);
    expect(group.items[0]!.children.map((item) => [item.kind, item.title])).toEqual([["task", "pnpm -r test"]]);
    expect(group.items[0]!.children[0]!.stop).toEqual({ kind: "task", path: "/p/child.jsonl", id: "t-child" });
  });

  it("rolls attention up so a blocked grandchild lights the parent it is under", () => {
    const parent = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
    const blocked = run({
      runId: "r2",
      sessionPath: "/p/grandchild.jsonl",
      subagentName: "reader",
      status: "blocked",
      parent: { sessionPath: "/p/child.jsonl", sessionId: "child", runId: "r1" },
      endedAt: "2026-09-08T10:02:00.000Z",
    });
    const groups = build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" }), summary({ path: "/p/grandchild.jsonl" })],
      runs: byId([parent, blocked], "runId"),
    });
    const group = groups[0]!;
    expect(group.items[0]!.own).toBe("working");
    expect(group.items[0]!.attention).toBe("waiting_for_input");
    expect(group.attention).toBe("waiting_for_input");
    expect(group.needsYou).toBe(1);
    expect(fleetSummary(groups)).toMatchObject({ needsYou: 1 });
  });

  it("ticks elapsed for live work and freezes it once the work ends", () => {
    const live = run({ runId: "r1", sessionPath: "/p/a.jsonl" });
    const done = run({ runId: "r2", sessionPath: "/p/b.jsonl", status: "completed", endedAt: "2026-09-08T10:01:00.000Z" });
    const groups = build({ sessions: [summary({ path: ROOT })], runs: byId([live, done], "runId") });
    const items = flattenFleet(groups[0]!.items);
    expect(items.find((item) => item.key === "agent:/p/a.jsonl")?.elapsedMs).toBe(5 * 60_000);
    expect(items.find((item) => item.key === "agent:/p/b.jsonl")?.elapsedMs).toBe(60_000);
  });

  it("says when a session is closed here but its work kept going", () => {
    const child = run({ runId: "r1", sessionPath: "/p/child.jsonl" });
    const open = build({ sessions: [summary({ path: ROOT })], runs: byId([child], "runId"), views: { [ROOT]: view({ path: ROOT }) } });
    expect(open[0]!.orphaned).toBe(false);
    const closed = build({ sessions: [summary({ path: ROOT })], runs: byId([child], "runId") });
    expect(closed[0]!.orphaned).toBe(true);
    // Looking at it counts as having it, even before the view lands.
    const looking = build({ sessions: [summary({ path: ROOT })], runs: byId([child], "runId"), currentPath: ROOT });
    expect(looking[0]!.orphaned).toBe(false);
  });

  it("stops showing what work was doing once it has stopped doing it", () => {
    const done = run({
      runId: "r1",
      sessionPath: "/p/a.jsonl",
      status: "completed",
      endedAt: "2026-09-08T10:01:00.000Z",
      activity: { turns: 3, tools: 4, currentTool: "complete_agent_run", lastAt: "2026-09-08T10:01:00.000Z" },
    });
    const live = run({
      runId: "r2",
      sessionPath: "/p/b.jsonl",
      activity: { turns: 1, tools: 1, label: "Reading the router", lastAt: "2026-09-08T10:01:00.000Z" },
    });
    const stopped = task({ id: "t1", sessionPath: ROOT, status: "stopped", activity: "still going", endedAt: "2026-09-08T10:01:00.000Z" });
    const items = flattenFleet(
      build({ sessions: [summary({ path: ROOT })], runs: byId([done, live], "runId"), tasks: byId([stopped], "id") })[0]!.items,
    );
    expect(items.find((item) => item.key === "agent:/p/a.jsonl")?.activity).toBeUndefined();
    expect(items.find((item) => item.key === "agent:/p/b.jsonl")?.activity).toBe("Reading the router");
    expect(items.find((item) => item.kind === "task")?.activity).toBeUndefined();
  });

  it("carries the reason a run ended, and a task's exit, rather than losing it", () => {
    const cancelled = run({
      runId: "r1",
      sessionPath: "/p/a.jsonl",
      status: "cancelled",
      endedBy: { initiator: "user", reason: "wrong branch" },
      endedAt: "2026-09-08T10:01:00.000Z",
    });
    const stopped = task({ id: "t1", sessionPath: ROOT, status: "stopped", exitCode: null, terminalReason: "you stopped it", endedAt: "2026-09-08T10:01:00.000Z" });
    const groups = build({ sessions: [summary({ path: ROOT })], runs: byId([cancelled], "runId"), tasks: byId([stopped], "id") });
    const items = flattenFleet(groups[0]!.items);
    expect(items.find((item) => item.kind === "agent")?.terminalReason).toBe("wrong branch");
    expect(items.find((item) => item.kind === "task")?.terminalReason).toBe("you stopped it");
    // Terminal work offers no Stop.
    expect(items.every((item) => item.stop === undefined)).toBe(true);
  });

  it("puts the session you are in first, then what needs you, then what is going", () => {
    const busy = run({ runId: "r1", sessionPath: "/p/a.jsonl", rootSessionPath: OTHER, parent: { sessionPath: OTHER, sessionId: "o" } });
    const mine = run({
      runId: "r2",
      sessionPath: "/p/b.jsonl",
      status: "completed",
      endedAt: "2026-09-08T10:01:00.000Z",
    });
    const groups = build({
      sessions: [summary({ path: ROOT, name: "zzz" }), summary({ path: OTHER, name: "aaa" })],
      runs: byId([busy, mine], "runId"),
      currentPath: ROOT,
    });
    expect(groups.map((group) => group.path)).toEqual([ROOT, OTHER]);
  });

  it("moves whole branches between in-progress and finished, never half a branch", () => {
    const liveParent = run({ runId: "r1", sessionPath: "/p/child.jsonl" });
    const doneChild = run({
      runId: "r2",
      sessionPath: "/p/grandchild.jsonl",
      status: "completed",
      endedAt: "2026-09-08T10:01:00.000Z",
      parent: { sessionPath: "/p/child.jsonl", sessionId: "child", runId: "r1" },
    });
    const groups = build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" }), summary({ path: "/p/grandchild.jsonl" })],
      runs: byId([liveParent, doneChild], "runId"),
    });
    const items = groups[0]!.items;
    expect(branchIsActive(items[0]!)).toBe(true);
    const parts = partitionItems(items);
    expect(parts.active).toHaveLength(1);
    expect(parts.finished).toHaveLength(0);
    // The finished child stays inside the live branch rather than being moved.
    expect(parts.active[0]!.children.map((item) => item.state)).toEqual(["completed"]);
  });
});
