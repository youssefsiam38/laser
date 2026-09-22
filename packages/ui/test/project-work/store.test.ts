import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, type ProjectWorkBody } from "@lasercode/protocol";

import { ProjectWorkStore, describeProjectWorkError, type ProjectWorkRequest } from "../../src/project-work/store.js";
import { attentionQueue } from "../../src/project-work/model.js";

import { change, countsOf, fakeHost, item, type FakeProject } from "./fixture.js";

const project = (): FakeProject => ({
  projectId: "p1",
  paths: ["/work/app"],
  seq: 10,
  items: [
    item({ entityId: "e1", kind: "spec", number: 1, updatedAt: "2026-01-01T10:00:00.000Z" }),
    item({ entityId: "e2", kind: "task", number: 44, updatedAt: "2026-01-01T09:00:00.000Z" }),
  ],
  events: [],
});

const settle = async (): Promise<void> => {
  // Two turns: the store's own follow-up reconcile is scheduled, not awaited.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("the project work store", () => {
  it("learns the stable project id from a directory and reads its backlog", async () => {
    const host = fakeHost([project()]);
    const store = new ProjectWorkStore({ request: host.request });
    await store.open({ cwd: "/work/app" });

    const snapshot = store.getSnapshot();
    expect(snapshot.projectId).toBe("p1");
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.seq).toBe(10);
    expect(snapshot.items.map((row) => row.key)).toEqual(["SPEC-1", "TASK-44"]);
    expect(snapshot.counts.total).toBe(2);
    // The first read named the folder; the id is what everything after uses.
    expect(host.calls[0]?.params).toMatchObject({ cwd: "/work/app" });
  });

  it("forwards one typed first-revision body unchanged at the host boundary", async () => {
    const body: ProjectWorkBody = {
      kind: "task",
      task: {
        outcome: "  **Keep exact Markdown**  ",
        nonGoals: ["No migration"],
        dependencies: [],
        scope: { packages: ["@lasercode/ui"], repositories: [], paths: [], capabilities: [] },
        acceptance: [{ id: "a1", text: "Works", machineVerifiable: false }],
        verificationCommands: [],
        visualEvidenceRequired: false,
        assignment: { policy: "person" },
      },
    };
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "project/work/create") {
        return {
          entity: { projectId: "p1", entityId: "e3", kind: "task", key: "TASK-45", keyNumber: 45, title: "Typed", state: "draft", currentRevisionId: "r1", currentDigest: "a".repeat(64), revisionCount: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          revision: { revisionId: "r1", index: 1, digest: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", origin: { actor: { kind: "person", label: "You" } } },
          ref: { projectId: "p1", kind: "task", entityId: "e3", revisionId: "r1", digest: "a".repeat(64), key: "TASK-45", label: "Typed" },
          seq: 11,
        };
      }
      return { projectId: "p1", seq: 11, items: [], counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } } };
    }) as unknown as ProjectWorkRequest;
    const store = new ProjectWorkStore({ request, projectId: "p1", newIdempotencyKey: () => "create-1" });

    const outcome = await store.create({ title: "Typed", body });

    expect(outcome.ok).toBe(true);
    expect(request).toHaveBeenCalledWith("project/work/create", {
      projectId: "p1",
      kind: "task",
      title: "Typed",
      body,
      idempotencyKey: "create-1",
    });
  });

  it("applies an in-order event and confirms it with a read at the cached sequence", async () => {
    const world = project();
    const host = fakeHost([world]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();

    world.seq = 11;
    world.items = [
      item({ entityId: "e1", kind: "spec", number: 1, title: "A renamed spec", state: "needs_review", needsAttention: true, updatedAt: "2026-01-02T00:00:00.000Z" }),
      world.items[1]!,
    ];
    world.events = [{ seq: 11, change: change({ entityId: "e1", kind: "spec", number: 1, title: "A renamed spec", state: "needs_review" }) }];

    store.observe("project/work/updated", { projectId: "p1", seq: 11, change: world.events[0]!.change });
    // The row moves in the same tick: nothing waits on a round trip to rename.
    expect(store.getSnapshot().items[0]?.title).toBe("A renamed spec");

    await settle();
    const snapshot = store.getSnapshot();
    expect(snapshot.seq).toBe(11);
    // …and the read that followed carried what the event could not.
    expect(snapshot.items[0]?.needsAttention).toBe(true);
    expect(snapshot.counts.needsAttention).toBe(1);
    const since = host.calls.filter((call) => (call.params as { sinceSeq?: number }).sinceSeq !== undefined);
    expect(since[0]?.params).toMatchObject({ sinceSeq: 10 });
  });

  it("drops a replayed or out-of-date event", async () => {
    const host = fakeHost([project()]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();
    const before = host.calls.length;

    store.observe("project/work/updated", { projectId: "p1", seq: 10, change: change({ entityId: "e1", kind: "spec", number: 1, title: "Stale" }) });
    store.observe("project/work/updated", { projectId: "p1", seq: 3, change: change({ entityId: "e1", kind: "spec", number: 1, title: "Older still" }) });
    await settle();

    expect(store.getSnapshot().items.find((row) => row.key === "SPEC-1")?.title).toBe("SPEC-1");
    expect(store.getSnapshot().seq).toBe(10);
    expect(host.calls.length).toBe(before);
  });

  it("never applies an event out of order: a gap keeps the rows and reconciles", async () => {
    const world = project();
    const host = fakeHost([world]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();

    world.seq = 14;
    world.items = [world.items[0]!, item({ entityId: "e2", kind: "task", number: 44, state: "in_progress", updatedAt: "2026-01-03T00:00:00.000Z" })];
    world.events = [
      { seq: 12, change: change({ entityId: "e2", kind: "task", number: 44, state: "ready" }) },
      { seq: 13, change: change({ entityId: "e2", kind: "task", number: 44, state: "in_progress" }) },
      { seq: 14, change: change({ entityId: "e2", kind: "task", number: 44, state: "in_progress" }) },
    ];

    // Seq 11, 12 and 13 never arrived; only 14 did.
    store.observe("project/work/updated", { projectId: "p1", seq: 14, change: world.events[2]!.change });
    // Nothing from the event is on the row yet: two states were missed, and a
    // guess about which one landed is how a list stops being true.
    expect(store.getSnapshot().items.find((row) => row.key === "TASK-44")?.state).toBe("draft");
    expect(store.getSnapshot().behind).toBe(true);

    await settle();
    const snapshot = store.getSnapshot();
    expect(snapshot.behind).toBe(false);
    expect(snapshot.seq).toBe(14);
    expect(snapshot.items.find((row) => row.key === "TASK-44")?.state).toBe("in_progress");
  });

  it("removes what the reconcile says is gone", async () => {
    const world = project();
    const host = fakeHost([world]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();

    world.seq = 11;
    world.items = [world.items[0]!];
    world.events = [{ seq: 11, change: change({ entityId: "e2", kind: "task", number: 44, change: "deleted" }) }];
    await store.reconcile();

    expect(store.getSnapshot().items.map((row) => row.key)).toEqual(["SPEC-1"]);
  });

  it("keeps its rows through a reconnect and catches up from the sequence it holds", async () => {
    const world = project();
    const host = fakeHost([world]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();

    host.offline = new Error("connection closed");
    await store.reconcile();
    const offline = store.getSnapshot();
    expect(offline.items).toHaveLength(2);
    expect(offline.phase).toBe("ready");
    expect(offline.error).toContain("connection closed");
    expect(offline.behind).toBe(true);

    host.offline = undefined;
    world.seq = 12;
    world.items = [world.items[0]!, item({ entityId: "e2", kind: "task", number: 44, state: "ready", updatedAt: "2026-01-04T00:00:00.000Z" })];
    world.events = [{ seq: 12, change: change({ entityId: "e2", kind: "task", number: 44, state: "ready" }) }];
    store.reconnected();
    await settle();

    const back = store.getSnapshot();
    expect(back.behind).toBe(false);
    expect(back.error).toBeUndefined();
    expect(back.items.find((row) => row.key === "TASK-44")?.state).toBe("ready");
    const since = host.calls.filter((call) => (call.params as { sinceSeq?: number }).sinceSeq !== undefined);
    expect(since.at(-1)?.params).toMatchObject({ sinceSeq: 10 });
  });

  it("replaces the cache only when the host says its event window moved past us", async () => {
    const world = project();
    world.windowStart = 40;
    const host = fakeHost([world]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();

    world.seq = 90;
    world.items = [item({ entityId: "e9", kind: "plan", number: 2, updatedAt: "2026-02-01T00:00:00.000Z" })];
    await store.reconcile();

    const snapshot = store.getSnapshot();
    expect(snapshot.resets).toBe(1);
    // Replaced, not merged: the rows that are gone are gone.
    expect(snapshot.items.map((row) => row.key)).toEqual(["PLAN-2"]);
    expect(snapshot.seq).toBe(90);
  });

  it("takes the newer attention count from a notification and the exact one from a read", async () => {
    const world = project();
    const host = fakeHost([world]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();
    expect(store.getSnapshot().attention.needsYou).toBe(0);

    store.observe("project/work/attention", { projectId: "p1", seq: 11, needsYou: 3, items: [] });
    expect(store.getSnapshot().attention.needsYou).toBe(3);

    // An older announcement never moves the badge back.
    store.observe("project/work/attention", { projectId: "p1", seq: 9, needsYou: 0, items: [] });
    expect(store.getSnapshot().attention.needsYou).toBe(3);

    world.items = [item({ entityId: "e1", kind: "spec", number: 1, needsAttention: true, state: "needs_review" }), world.items[1]!];
    world.seq = 12;
    await store.refresh();
    expect(store.getSnapshot().attention.needsYou).toBe(countsOf(world.items).needsAttention);
  });

  it("ignores another project's events entirely", async () => {
    const host = fakeHost([project()]);
    const store = new ProjectWorkStore({ request: host.request, projectId: "p1" });
    await store.open();
    const before = host.calls.length;

    store.observe("project/work/updated", { projectId: "p2", seq: 99, change: change({ entityId: "x", kind: "spec", number: 5 }) });
    store.observe("project/work/attention", { projectId: "p2", seq: 99, needsYou: 7, items: [] });
    await settle();

    expect(store.getSnapshot().seq).toBe(10);
    expect(store.getSnapshot().attention.needsYou).toBe(0);
    expect(host.calls.length).toBe(before);
  });

  it("derives the needs-you queue from the rows, with the host's own reasons", async () => {
    const rows = [
      item({ entityId: "a", kind: "spec", number: 1, needsAttention: true, blockingComments: 2, state: "needs_review", updatedAt: "2026-01-05T00:00:00.000Z" }),
      item({ entityId: "b", kind: "design", number: 3, needsAttention: true, state: "stale", staleBecauseKey: "SPEC-1", updatedAt: "2026-01-04T00:00:00.000Z" }),
      item({ entityId: "c", kind: "task", number: 44, needsAttention: true, state: "blocked", updatedAt: "2026-01-03T00:00:00.000Z" }),
      item({ entityId: "d", kind: "plan", number: 2, needsAttention: true, state: "needs_review", updatedAt: "2026-01-02T00:00:00.000Z" }),
      item({ entityId: "e", kind: "task", number: 45, updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(attentionQueue(rows).map((row) => [row.key, row.reason])).toEqual([
      ["SPEC-1", "blocking_comment"],
      ["DES-3", "stale"],
      ["TASK-44", "blocked_task"],
      ["PLAN-2", "gate"],
    ]);
  });
});

describe("what a failed write says", () => {
  it("decodes a conflict into the revision that is current", () => {
    const current = { projectId: "p1", kind: "spec" as const, entityId: "e1", revisionId: "r9", digest: "b".repeat(64), label: "A spec", key: "SPEC-1" };
    const failure = describeProjectWorkError(
      Object.assign(new Error("Someone else saved a newer revision of this."), {
        code: ErrorCodes.ProjectWorkConflict,
        data: { conflict: "revision", current, expectedRevisionId: "r8" },
      }),
    );
    expect(failure).toMatchObject({ kind: "conflict", current });
  });

  it("decodes a quota refusal into what to do about it", () => {
    const failure = describeProjectWorkError(
      Object.assign(new Error("This project's storage is full."), {
        code: ErrorCodes.ProjectWorkQuota,
        data: { refused: "quota", scope: "project", recovery: "Export or delete some project work.", usedBytes: 10, limitBytes: 10 },
      }),
    );
    expect(failure.kind).toBe("quota");
    expect(failure.kind === "quota" ? failure.refusal?.recovery : "").toBe("Export or delete some project work.");
  });

  it("keeps anything else as the sentence the host wrote", () => {
    expect(describeProjectWorkError(new Error("That project folder has not been trusted yet."))).toEqual({
      kind: "refused",
      message: "That project folder has not been trusted yet.",
    });
  });
});
