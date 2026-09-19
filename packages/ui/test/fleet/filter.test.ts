import { describe, expect, it } from "vitest";
import type { BackgroundTask } from "@lasercode/protocol";

import { DEFAULT_FLEET_FILTER, filterFleetSections, filterRevealing, fleetFilterCounts, fleetFilterIsRestricting } from "../../src/fleet/filter.js";
import { buildFleet, flattenFleet, projectFleetSections } from "../../src/fleet/model.js";
import { run, summary } from "../agents/fixtures.js";

const ROOT = "/p/root.jsonl";
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

const sectionsOf = () => {
  const going = run({ runId: "r1", sessionPath: "/p/going.jsonl", subagentName: "explorer" });
  const asking = run({
    runId: "r2",
    sessionPath: "/p/asking.jsonl",
    subagentName: "reviewer",
    status: "needs_input",
    question: { id: "q", kind: "confirm", title: "Overwrite?", askedAt: "2026-09-08T10:04:00.000Z" },
  });
  const ended = run({
    runId: "r3",
    sessionPath: "/p/ended.jsonl",
    subagentName: "writer",
    status: "completed",
    endedAt: "2026-09-08T10:01:00.000Z",
  });
  const groups = buildFleet({
    sessions: [summary({ path: ROOT })],
    runs: { r1: going, r2: asking, r3: ended },
    tasks: {
      t1: task({ id: "t1", sessionPath: ROOT, title: "vite", command: "pnpm vite" }),
      t2: task({
        id: "t2",
        sessionPath: ROOT,
        title: "build",
        command: "pnpm build",
        status: "completed",
        endedAt: "2026-09-08T10:01:00.000Z",
      }),
    },
    views: {},
    now: NOW,
  });
  return projectFleetSections(groups);
};

describe("fleetFilterCounts", () => {
  it("counts going, asking, ended, agents and commands on the unfiltered tree", () => {
    expect(fleetFilterCounts(sectionsOf())).toEqual({ going: 2, asking: 1, ended: 2, agents: 3, commands: 2 });
  });
});

describe("filterFleetSections", () => {
  it("leaves the tree intact under the default filter", () => {
    const sections = sectionsOf();
    const filtered = filterFleetSections(sections, DEFAULT_FLEET_FILTER);
    expect(filtered.active.count).toBe(sections.active.count);
    expect(filtered.finished.count).toBe(sections.finished.count);
  });
  it("hides ended work when Ended is off", () => {
    const filtered = filterFleetSections(sectionsOf(), {
      lifecycle: { going: true, asking: true, ended: false },
      kind: "all",
    });
    expect(filtered.finished.count).toBe(0);
    expect(flattenFleet(filtered.active.groups.flatMap((group) => group.items.map((item) => item.item))).some((item) => item.terminal)).toBe(false);
  });
  it("keeps only asking work when Going is off", () => {
    const filtered = filterFleetSections(sectionsOf(), {
      lifecycle: { going: false, asking: true, ended: false },
      kind: "all",
    });
    const titles = flattenFleet(filtered.active.groups.flatMap((group) => group.items.map((item) => item.item))).map((item) => item.title);
    expect(titles).toContain("Reviewer");
    expect(titles).not.toContain("Explorer");
  });
  it("keeps agent context around a matching command", () => {
    const going = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
    const groups = buildFleet({
      sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" })],
      runs: { r1: going },
      tasks: { t1: task({ id: "t1", sessionPath: "/p/child.jsonl", title: "vite", command: "pnpm vite" }) },
      views: {},
      now: NOW,
    });
    const filtered = filterFleetSections(projectFleetSections(groups), { lifecycle: { going: true, asking: true, ended: true }, kind: "task" });
    const root = filtered.active.groups[0]!.items[0]!;
    expect(root.contextOnly).toBe(true);
    expect(root.item.title).toBe("Explorer");
    expect(root.children[0]).toMatchObject({ contextOnly: false, item: { title: "vite" } });
  });
});

describe("filterRevealing", () => {
  it("turns on the lifecycle flag that was hiding the target",
    () => {
      const going = flattenFleet(
        filterFleetSections(sectionsOf(), DEFAULT_FLEET_FILTER).active.groups.flatMap((group) => group.items.map((item) => item.item)),
      ).find((item) => item.title === "Explorer")!;
      const next = filterRevealing({ lifecycle: { going: false, asking: true, ended: true }, kind: "all" }, going);
      expect(next.lifecycle.going).toBe(true);
      expect(next.kind).toBe("all");
    },
  );
  it("clears a kind cut that would hide a command",
    () => {
      const command = flattenFleet(
        filterFleetSections(sectionsOf(), DEFAULT_FLEET_FILTER).active.groups.flatMap((group) => group.items.map((item) => item.item)),
      ).find((item) => item.kind === "task")!;
      const next = filterRevealing({ lifecycle: { going: true, asking: true, ended: true }, kind: "agent" }, command);
      expect(next.kind).toBe("all");
    },
  );
  it("treats a kind-only cut as restricting",
    () => {
      expect(fleetFilterIsRestricting({ lifecycle: { going: true, asking: true, ended: true }, kind: "task" })).toBe(true);
      expect(fleetFilterIsRestricting(DEFAULT_FLEET_FILTER)).toBe(false);
    },
  );
});
