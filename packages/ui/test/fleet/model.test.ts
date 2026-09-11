import { describe, expect, it } from "vitest";
import type { BackgroundTask } from "@lasercode/protocol";

import { buildFleet, flattenFleet, fleetSummary, projectFleetSections, scopeFleet, type FleetGroup, type FleetProjectedItem } from "../../src/fleet/model.js";
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

const projected = (items: readonly FleetProjectedItem[]): FleetProjectedItem[] => {
  const out: FleetProjectedItem[] = [];
  const walk = (list: readonly FleetProjectedItem[]): void => {
    for (const item of list) {
      out.push(item);
      walk(item.children);
    }
  };
  walk(items);
  return out;
};

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

  it("keeps a blocked descendant as neutral ended history under its live parent", () => {
    const parent = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
    const blocked = run({
      runId: "r2",
      sessionPath: "/p/grandchild.jsonl",
      subagentName: "reader",
      status: "blocked",
      parent: { sessionPath: "/p/child.jsonl", sessionId: "child", runId: "r1" },
      endedAt: "2026-09-08T10:02:00.000Z",
      result: { status: "blocked", message: "The schema owner must choose." },
    });
    const groups = build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" }), summary({ path: "/p/grandchild.jsonl" })],
      runs: byId([parent, blocked], "runId"),
    });
    const group = groups[0]!;
    const history = group.items[0]!.children[0]!;
    expect(history).toMatchObject({ state: "blocked", tone: "muted", own: "idle", terminal: true, terminalReason: "The schema owner must choose." });
    expect(group.items[0]!.attention).toBe("working");
    expect(group.attention).toBe("working");
    expect(group.needsYou).toBe(0);
    expect(fleetSummary(groups)).toMatchObject({ needsYou: 0 });
  });

  it("stands a session on the run that can still act while a newer successor only waits behind it", () => {
    // Terminal-pending (M13-T98): the row says Working, on the executing run,
    // until the fence; the queued successor is Waiting, not the session.
    const unwinding = run({ runId: "run_old", sessionPath: "/p/pending.jsonl", subagentName: "pending", status: "running", startedAt: "2026-09-08T10:01:00.000Z", updatedAt: "2026-09-08T10:03:00.000Z", activity: { turns: 2, tools: 3, currentTool: "bash", lastAt: "2026-09-08T10:03:00.000Z" } });
    const waiting = run({ runId: "run_next", sessionPath: unwinding.sessionPath, subagentName: "pending", status: "queued", startedAt: "2026-09-08T10:02:00.000Z", updatedAt: "2026-09-08T10:02:00.000Z", task: "Also do this." });
    for (const candidates of [[unwinding, waiting], [waiting, unwinding]]) {
      const groups = build({ sessions: [summary({ path: ROOT })], runs: byId(candidates, "runId"), currentPath: ROOT });
      const item = groups[0]!.items[0]!;
      expect(item).toMatchObject({ kind: "agent", state: "running", tone: "live", terminal: false, activity: "Running bash", stop: { kind: "agent", runId: "run_old" }, run: unwinding });
      expect(groups[0]!.items).toHaveLength(1);
      expect(groups[0]).toMatchObject({ running: 1, needsYou: 0 });
    }
    const asking = { ...unwinding, status: "needs_input" as const, question: { id: "q", kind: "confirm" as const, title: "Overwrite?", askedAt: "2026-09-08T10:03:30.000Z" } };
    expect(build({ sessions: [summary({ path: ROOT })], runs: byId([waiting, asking], "runId"), currentPath: ROOT })[0]!.items[0]).toMatchObject({ state: "needs_input", activity: "Overwrite?", run: asking });
    // Once the old run has truly ended, the successor — queued or running — is the row.
    const ended = { ...unwinding, status: "completed" as const, endedAt: "2026-09-08T10:04:00.000Z", updatedAt: "2026-09-08T10:04:00.000Z", result: { status: "completed" as const, message: "First done." } };
    expect(build({ sessions: [summary({ path: ROOT })], runs: byId([ended, waiting], "runId"), currentPath: ROOT })[0]!.items[0]).toMatchObject({ state: "queued", terminal: false, run: waiting });
    expect(build({ sessions: [summary({ path: ROOT })], runs: byId([ended, { ...waiting, status: "running" as const }], "runId"), currentPath: ROOT })[0]!.items[0]).toMatchObject({ state: "running", run: { runId: "run_next" } });
  });

  it("shows a child paused on a question as live, needing you, with the question as what it is doing", () => {
    const asking = run({
      runId: "r1",
      sessionPath: "/p/child.jsonl",
      subagentName: "migrate",
      status: "needs_input",
      activity: { turns: 2, tools: 3, currentTool: "ask_person", lastAt: "2026-09-08T10:04:00.000Z" },
      question: { id: "ui-1", kind: "confirm", title: "Drop the old table?", detail: "This cannot be undone.", askedAt: "2026-09-08T10:04:00.000Z" },
    });
    const groups = build({ sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" })], runs: byId([asking], "runId") });
    const item = groups[0]!.items[0]!;
    expect(item).toMatchObject({ state: "needs_input", tone: "attention", own: "waiting_for_input", attention: "waiting_for_input", terminal: false, activity: "Drop the old table?" });
    // Live: it can still be stopped, and its clock still runs.
    expect(item.stop).toEqual({ kind: "agent", runId: "r1" });
    expect(item.elapsedMs).toBe(5 * 60_000);
    expect(item.terminalReason).toBeUndefined();
    expect(groups[0]).toMatchObject({ running: 1, needsYou: 1, attention: "waiting_for_input" });
    expect(fleetSummary(groups)).toMatchObject({ running: 1, needsYou: 1 });
    expect(projectFleetSections(groups).active.count).toBe(1);
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

  it("puts every terminal outcome in Finished, including blocked", () => {
    for (const status of ["completed", "blocked", "failed", "cancelled"] as const) {
      const ended = run({ runId: status, sessionPath: `/p/${status}.jsonl`, status, endedAt: "2026-09-08T10:01:00.000Z" });
      const sections = projectFleetSections(build({ sessions: [summary({ path: ROOT })], runs: byId([ended], "runId") }));
      expect(sections.active.count).toBe(0);
      expect(projected(sections.finished.groups[0]!.items).map((item) => item.item.state)).toEqual([status]);
    }
  });

  it("projects terminal descendants into Finished immediately while repeating only their live ancestry", () => {
    const liveParent = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
    const doneChild = run({
      runId: "r2",
      sessionPath: "/p/grandchild.jsonl",
      subagentName: "reader",
      status: "completed",
      endedAt: "2026-09-08T10:01:00.000Z",
      parent: { sessionPath: "/p/child.jsonl", sessionId: "child", runId: "r1" },
    });
    const groups = build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" }), summary({ path: "/p/grandchild.jsonl" })],
      runs: byId([liveParent, doneChild], "runId"),
    });
    const canonicalParent = groups[0]!.items[0]!;
    const canonicalChildren = canonicalParent.children;
    const sections = projectFleetSections(groups);
    const activeParent = sections.active.groups[0]!.items[0]!;
    const finishedParent = sections.finished.groups[0]!.items[0]!;

    expect(activeParent).toMatchObject({ item: canonicalParent, contextOnly: false, attention: "working", children: [] });
    expect(finishedParent).toMatchObject({ item: canonicalParent, contextOnly: true, attention: "finished_unread" });
    expect(finishedParent.children).toHaveLength(1);
    expect(finishedParent.children[0]).toMatchObject({ item: canonicalChildren[0], contextOnly: false });
    expect(sections.active).toMatchObject({ count: 1, running: 1, needsYou: 0, attention: "working" });
    expect(sections.finished).toMatchObject({ count: 1, running: 0, needsYou: 0, attention: "finished_unread" });
    // Projection references canonical records and never rewrites their tree.
    expect(canonicalParent.children).toBe(canonicalChildren);
    expect(canonicalParent.children.map((item) => item.state)).toEqual(["completed"]);
  });

  it("keeps a terminal parent as actual Finished work and only context around its live descendant", () => {
    const doneParent = run({
      runId: "r1",
      sessionPath: "/p/child.jsonl",
      subagentName: "explorer",
      status: "completed",
      endedAt: "2026-09-08T10:01:00.000Z",
    });
    const liveChild = run({
      runId: "r2",
      sessionPath: "/p/grandchild.jsonl",
      subagentName: "reader",
      parent: { sessionPath: "/p/child.jsonl", sessionId: "child", runId: "r1" },
    });
    const sections = projectFleetSections(build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" }), summary({ path: "/p/grandchild.jsonl" })],
      runs: byId([doneParent, liveChild], "runId"),
    }));
    const activeParent = sections.active.groups[0]!.items[0]!;
    const finishedParent = sections.finished.groups[0]!.items[0]!;
    expect(activeParent).toMatchObject({ contextOnly: true, attention: "working" });
    expect(activeParent.children[0]).toMatchObject({ contextOnly: false, item: { state: "running" } });
    expect(finishedParent).toMatchObject({ contextOnly: false, item: { state: "completed" }, children: [] });
    expect(sections.active.count).toBe(1);
    expect(sections.finished.count).toBe(1);

    const cleared = projectFleetSections(build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" }), summary({ path: "/p/grandchild.jsonl" })],
      runs: byId([doneParent, liveChild], "runId"),
    }), { clearedBefore: "2026-09-08T10:02:00.000Z" });
    expect(cleared.finished.count).toBe(0);
    expect(cleared.active.groups[0]!.items[0]).toMatchObject({ contextOnly: true, item: { state: "completed" } });
    expect(cleared.active.groups[0]!.items[0]!.children[0]).toMatchObject({ contextOnly: false, item: { state: "running" } });
  });

  it("clears terminal descendants recursively while retaining new work and required ancestry in creation order", () => {
    const parent = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
    const tasks = [
      task({ id: "old", sessionPath: "/p/child.jsonl", title: "old", status: "completed", startedAt: "2026-09-08T09:59:00.000Z", endedAt: "2026-09-08T10:01:00.000Z" }),
      task({ id: "fresh", sessionPath: "/p/child.jsonl", title: "fresh", status: "completed", startedAt: "2026-09-08T10:00:00.000Z", endedAt: "2026-09-08T10:03:00.000Z" }),
      task({ id: "unknown", sessionPath: "/p/child.jsonl", title: "unknown", status: "completed", startedAt: "2026-09-08T10:01:00.000Z" }),
    ];
    const groups = build({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" })],
      runs: byId([parent], "runId"),
      tasks: byId(tasks, "id"),
    });
    const canonicalParent = groups[0]!.items[0]!;
    const sections = projectFleetSections(groups, { clearedBefore: "2026-09-08T10:02:00.000Z" });
    expect(sections.active.count).toBe(1);
    expect(sections.finished.count).toBe(2);
    const finishedParent = sections.finished.groups[0]!.items[0]!;
    expect(finishedParent.contextOnly).toBe(true);
    expect(finishedParent.children.map((child) => child.item.title)).toEqual(["fresh", "unknown"]);
    expect(canonicalParent.children.map((child) => child.title)).toEqual(["old", "fresh", "unknown"]);
  });

  it("shows a resumed session from its newest run while retaining failed history", () => {
    const failed = run({ runId: "old-failed", sessionPath: "/p/child.jsonl", subagentName: "explorer", status: "failed", startedAt: "2026-09-08T10:00:00.000Z", updatedAt: "2026-09-08T10:01:00.000Z", endedAt: "2026-09-08T10:01:00.000Z", error: "Provider disconnected." });
    const resumed = run({ runId: "new-running", sessionPath: failed.sessionPath, subagentName: "explorer", status: "running", startedAt: "2026-09-08T10:02:00.000Z", updatedAt: "2026-09-08T10:02:00.000Z", task: "Try again." });
    const groups = build({ sessions: [summary({ path: ROOT })], runs: byId([failed, resumed], "runId") });
    const item = groups[0]!.items[0]!;
    expect(item).toMatchObject({ state: "running", tone: "live", terminal: false, run: resumed });
    expect(projectFleetSections(groups).active.count).toBe(1);
    expect(item.run).not.toBe(failed);
  });

  it("names a deleted root by what it has left — its name, its first line, or what it is — never its file name", () => {
    const child = run({ runId: "r1", sessionPath: "/p/child.jsonl" });
    const loaded = { sessions: [summary({ path: "/p/child.jsonl" })], runs: byId([child], "runId") };
    expect(build(loaded)[0]).toMatchObject({ deleted: true, title: "Unnamed session", cwd: "/p" });
    const named = view({ path: ROOT });
    named.state.name = "Migration";
    expect(build({ ...loaded, views: { [ROOT]: named } })[0]!.title).toBe("Migration");
    const spoken = view({ path: ROOT, blocks: [{ kind: "user", id: "u1", text: "  delegate the   review\nplease" } as never] });
    expect(build({ ...loaded, views: { [ROOT]: spoken } })[0]!.title).toBe("delegate the review please");
    // Not deleted, not named: the file name is still the honest fallback.
    expect(build({ runs: byId([child], "runId") })[0]!.title).toBe("root.jsonl");
  });

  it("marks a group whose root is gone from the catalog as deleted, but never before the catalog has arrived", () => {
    const child = run({ runId: "r1", sessionPath: "/p/child.jsonl" });
    // An empty list is a catalog that has not loaded, not proof of a deletion.
    expect(build({ runs: byId([child], "runId") })[0]!.deleted).toBe(false);
    expect(build({ runs: byId([child], "runId"), sessionsLoaded: false })[0]!.deleted).toBe(false);
    // Loaded and empty: the root is not on disk.
    expect(build({ runs: byId([child], "runId"), sessionsLoaded: true })[0]!.deleted).toBe(true);
    // Loaded with other rows but not this root: the same.
    expect(build({ sessions: [summary({ path: "/p/child.jsonl" })], runs: byId([child], "runId") })[0]!.deleted).toBe(true);
    // An open view of the root is the client's memory, not the disk.
    expect(build({ sessions: [summary({ path: "/p/child.jsonl" })], runs: byId([child], "runId"), views: { [ROOT]: view({ path: ROOT }) } })[0]!.deleted).toBe(true);
    expect(build({ sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" })], runs: byId([child], "runId") })[0]!.deleted).toBe(false);
  });
});

describe("scopeFleet", () => {
  const mine = run({ runId: "r1", sessionPath: "/p/mine-child.jsonl", subagentName: "mine" });
  const theirs = run({ runId: "r2", sessionPath: "/p/other-child.jsonl", subagentName: "theirs", rootSessionPath: OTHER, parent: { sessionPath: OTHER, sessionId: "o" } });
  const GONE = "/p/gone.jsonl";
  const stray = run({ runId: "r3", sessionPath: "/p/stray-child.jsonl", subagentName: "stray", rootSessionPath: GONE, parent: { sessionPath: GONE, sessionId: "g" } });
  const catalog = [summary({ path: ROOT }), summary({ path: OTHER }), summary({ path: "/p/mine-child.jsonl" }), summary({ path: "/p/other-child.jsonl" }), summary({ path: "/p/stray-child.jsonl" })];
  const all = () => build({ sessions: catalog, runs: byId([mine, theirs, stray], "runId"), tasks: byId([task({ id: "t-other", sessionPath: OTHER }), task({ id: "t-gone", sessionPath: GONE })], "id") });

  it("shows only the open session's tree, and switches with the session", () => {
    const groups = all();
    expect(groups).toHaveLength(3);
    const here = scopeFleet(groups, ROOT);
    expect(here.tree?.path).toBe(ROOT);
    expect(flattenFleet(here.tree!.items).map((item) => item.title)).toEqual(["mine"]);
    const there = scopeFleet(groups, OTHER);
    expect(there.tree?.path).toBe(OTHER);
    expect(flattenFleet(there.tree!.items).map((item) => item.title)).toEqual(["theirs", "pnpm -r test"]);
    // Another session's work is that session's fleet, not this one's.
    expect(fleetSummary([here.tree!])).toMatchObject({ running: 1 });
    expect(fleetSummary([there.tree!])).toMatchObject({ running: 2 });
  });

  it("has no tree for a session with no work, and none at all when no session is open", () => {
    const groups = all();
    expect(scopeFleet(groups, "/p/quiet.jsonl").tree).toBeUndefined();
    expect(scopeFleet(groups, undefined).tree).toBeUndefined();
    expect(scopeFleet([], ROOT)).toEqual({ tree: undefined, elsewhere: [] });
  });

  it("carries work whose root session was deleted in every scope, and drops nothing else", () => {
    const groups = all();
    for (const root of [ROOT, OTHER, "/p/quiet.jsonl", undefined]) {
      const scope = scopeFleet(groups, root);
      expect(scope.elsewhere.map((group) => group.path)).toEqual([GONE]);
      expect(scope.elsewhere[0]!.deleted).toBe(true);
      // Its rows keep their Stop: it is stoppable from here.
      expect(flattenFleet(scope.elsewhere[0]!.items).map((item) => item.stop?.kind)).toEqual(["agent", "task"]);
    }
    // Reading a child of the deleted root: its tree is the tree, not a stray.
    const inside = scopeFleet(groups, GONE);
    expect(inside.tree?.path).toBe(GONE);
    expect(inside.tree?.deleted).toBe(true);
    expect(inside.elsewhere).toEqual([]);
  });

  it("never calls the tree you are inside closed", () => {
    const groups = build({ sessions: [summary({ path: ROOT }), summary({ path: "/p/mine-child.jsonl" })], runs: byId([mine], "runId"), currentPath: "/p/mine-child.jsonl" });
    expect(groups[0]!.orphaned).toBe(true);
    expect(scopeFleet(groups, ROOT).tree?.orphaned).toBe(false);
  });
});
