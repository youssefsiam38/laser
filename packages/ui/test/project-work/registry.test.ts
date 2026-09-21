import { afterEach, describe, expect, it } from "vitest";

import {
  bindProjectWork,
  knownProjectWork,
  observeProjectWork,
  projectWorkFor,
  reconnectProjectWork,
  resetProjectWork,
  resolveProjectWork,
  resolvedProjectPaths,
} from "../../src/project-work/registry.js";

import { change, fakeHost, item, type FakeProject } from "./fixture.js";

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** One project the person has opened at two paths, and a second project. */
const world = (): FakeProject[] => [
  {
    projectId: "p1",
    // The project moved: the old path and the new one are the same project,
    // and a worktree under it is the same project again.
    paths: ["/old/app", "/new/app", "/new/app/.worktrees/feature"],
    seq: 4,
    items: [item({ entityId: "e1", kind: "spec", number: 1 })],
    events: [],
  },
  {
    projectId: "p2",
    paths: ["/other/app"],
    seq: 2,
    items: [item({ entityId: "z1", kind: "task", number: 1, ref: { projectId: "p2" } as never })],
    events: [],
  },
];

afterEach(() => {
  resetProjectWork();
  bindProjectWork(undefined);
});

describe("the project work registry", () => {
  it("never aliases two projects, and never splits one that moved", async () => {
    const host = fakeHost(world());
    bindProjectWork(host.request);

    const fromOldPath = await resolveProjectWork("/old/app");
    const fromNewPath = await resolveProjectWork("/new/app");
    const fromWorktree = await resolveProjectWork("/new/app/.worktrees/feature");
    const other = await resolveProjectWork("/other/app");
    await settle();

    // One cache for one project, whatever directory asked for it.
    expect(fromOldPath).toBe(fromNewPath);
    expect(fromWorktree).toBe(fromNewPath);
    expect(fromOldPath?.getSnapshot().projectId).toBe("p1");
    // And a genuinely different project is a genuinely different cache.
    expect(other).not.toBe(fromOldPath);
    expect(other?.getSnapshot().projectId).toBe("p2");

    expect([...resolvedProjectPaths().entries()].sort()).toEqual([
      ["/new/app", "p1"],
      ["/new/app/.worktrees/feature", "p1"],
      ["/old/app", "p1"],
      ["/other/app", "p2"],
    ]);
  });

  it("resolves a directory once, however many callers ask at the same time", async () => {
    const host = fakeHost(world());
    bindProjectWork(host.request);

    const [a, b, c] = await Promise.all([
      resolveProjectWork("/new/app"),
      resolveProjectWork("/new/app"),
      resolveProjectWork("/new/app"),
    ]);
    await settle();

    expect(a).toBe(b);
    expect(b).toBe(c);
    const probes = host.calls.filter((call) => (call.params as { cwd?: string }).cwd === "/new/app");
    expect(probes).toHaveLength(1);
  });

  it("does not remember a folder it could not resolve", async () => {
    const host = fakeHost(world());
    bindProjectWork(host.request);

    expect(await resolveProjectWork("/not/a/project")).toBeUndefined();
    expect(knownProjectWork("/not/a/project")).toBeUndefined();
    // The next attempt is a real attempt, not a cached refusal.
    expect(await resolveProjectWork("/not/a/project")).toBeUndefined();
    expect(host.calls.filter((call) => (call.params as { cwd?: string }).cwd === "/not/a/project")).toHaveLength(2);
  });

  it("fans an event out to the project it belongs to and to no other", async () => {
    const projects = world();
    const host = fakeHost(projects);
    bindProjectWork(host.request);
    const one = await resolveProjectWork("/new/app");
    const two = await resolveProjectWork("/other/app");
    await settle();

    projects[0]!.seq = 5;
    projects[0]!.items = [item({ entityId: "e1", kind: "spec", number: 1, title: "Moved on", updatedAt: "2026-03-01T00:00:00.000Z" })];
    projects[0]!.events = [{ seq: 5, change: change({ entityId: "e1", kind: "spec", number: 1, title: "Moved on" }) }];
    observeProjectWork("project/work/updated", { projectId: "p1", seq: 5, change: projects[0]!.events[0]!.change });
    await settle();

    expect(one?.getSnapshot().items[0]?.title).toBe("Moved on");
    expect(two?.getSnapshot().seq).toBe(2);
  });

  it("catches every project up after a reconnect, without emptying any of them", async () => {
    const projects = world();
    const host = fakeHost(projects);
    bindProjectWork(host.request);
    const one = await resolveProjectWork("/new/app");
    const two = await resolveProjectWork("/other/app");
    await settle();

    host.offline = new Error("connection closed");
    await one?.reconcile();
    host.offline = undefined;

    reconnectProjectWork();
    await settle();

    expect(one?.getSnapshot().items).toHaveLength(1);
    expect(one?.getSnapshot().behind).toBe(false);
    expect(two?.getSnapshot().behind).toBe(false);
  });

  it("answers nothing at all before a connection is bound", () => {
    expect(projectWorkFor("p1")).toBeUndefined();
  });

  it("throws the whole cache away when the environment changes", async () => {
    const host = fakeHost(world());
    bindProjectWork(host.request);
    const before = await resolveProjectWork("/new/app");
    await settle();
    expect(before?.getSnapshot().items).toHaveLength(1);

    resetProjectWork();
    expect(knownProjectWork("/new/app")).toBeUndefined();

    bindProjectWork(host.request);
    const after = await resolveProjectWork("/new/app");
    await settle();
    expect(after).not.toBe(before);
    expect(after?.getSnapshot().projectId).toBe("p1");
  });
});
