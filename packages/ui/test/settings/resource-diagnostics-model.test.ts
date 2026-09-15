import { describe, expect, it } from "vitest";
import type { AgentRun, BackgroundTask, ResourceMeasure, ResourceProcess, ResourceSnapshot, SessionSummary } from "@lasercode/protocol";

import {
  physicalMeasure,
  physicalMeasureKind,
  processTree,
  resolveRunAssociation,
  resolveSessionAssociation,
  resolveTaskAssociation,
  retainedStoreRows,
  roleSummaries,
  totalPhysicalSummary,
} from "../../src/components/settings/resources/model.js";

const available = (value: number): ResourceMeasure => ({ status: "available", value });
const unavailable = (reason: "incomplete_coverage" | "unsupported_platform" = "unsupported_platform"): ResourceMeasure => ({ status: "unavailable", reason });

function process(partial: Partial<ResourceProcess> & Pick<ResourceProcess, "key" | "pid" | "role">): ResourceProcess {
  return {
    startToken: partial.key.split("@")[1] ?? "start",
    label: partial.role,
    memory: { pss: available(10), resident: available(999), peakResident: available(1_999), privateResident: available(20), commit: unavailable() },
    cpu: { seconds: available(3) },
    elapsedMs: available(4_000),
    io: { readBytes: unavailable(), writeBytes: unavailable() },
    source: "proc",
    ...partial,
  };
}

function snapshot(rows: ResourceProcess[], partial: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  const known = rows.reduce((sum, row) => sum + (row.memory.pss.status === "available" ? row.memory.pss.value : 0), 0);
  return {
    id: "rs_1",
    at: "2026-09-13T10:00:00.000Z",
    platform: "linux",
    durationMs: 12,
    processes: rows,
    totals: {
      coverage: { processes: rows.length, measured: rows.length, complete: rows.length > 0 },
      knownPhysicalBytes: known,
      physical: rows.length ? available(known) : unavailable("incomplete_coverage"),
      residentCoverage: { processes: rows.length, measured: rows.length, complete: rows.length > 0 },
      knownResidentBytes: 99_999,
      residentSum: available(99_999),
    },
    byRole: [...new Set(rows.map((row) => row.role))].map((role) => {
      const matches = rows.filter((row) => row.role === role);
      const value = matches.reduce((sum, row) => sum + (row.memory.pss.status === "available" ? row.memory.pss.value : 0), 0);
      return { role, coverage: { processes: matches.length, measured: matches.length, complete: true }, knownPhysicalBytes: value, physical: available(value) };
    }),
    health: { ok: true, collectors: [{ name: "proc", status: "ok" }], truncated: false, crossCheck: { status: "unavailable" } },
    ...partial,
  };
}

const host = process({ key: "10@host", pid: 10, role: "host", label: "host", memory: { pss: available(100), resident: available(10_000), peakResident: available(20_000), privateResident: available(90), commit: unavailable() } });
const renderer = process({ key: "11@renderer", pid: 11, role: "desktop_renderer", label: "renderer", memory: { pss: unavailable(), resident: available(8_000), peakResident: available(9_000), privateResident: available(200), commit: unavailable() } });
const worker = process({ key: "12@worker", pid: 12, role: "project_worker", label: "worker", project: { id: "opaque", label: "project" }, associations: { sessionIds: ["s1"], runIds: ["r1"], taskIds: ["t1"] }, memory: { pss: available(300), resident: available(30_000), peakResident: available(40_000), privateResident: available(250), commit: unavailable() } });

describe("resource diagnostics projection", () => {
  it("uses platform physical memory, never resident, and peaks only over complete history", () => {
    const current = snapshot([host, worker], { totals: { ...snapshot([host, worker]).totals, physical: unavailable("incomplete_coverage"), coverage: { processes: 2, measured: 1, complete: false }, knownPhysicalBytes: 100 } });
    const old = snapshot([host, worker], { id: "old", totals: { ...snapshot([host, worker]).totals, physical: available(500), knownPhysicalBytes: 500 } });
    const partial = snapshot([host, worker], { id: "partial", totals: { ...snapshot([host, worker]).totals, physical: unavailable("incomplete_coverage"), knownPhysicalBytes: 50_000 } });
    const summary = totalPhysicalSummary(current, [old, partial, current]);
    expect(summary.current).toEqual({ status: "unavailable", reason: "1 of 2 processes measured", knownValue: 100 });
    expect(summary.peak).toEqual({ status: "available", value: 500 });
    expect(summary.peak).not.toMatchObject({ value: 99_999 });
    expect(physicalMeasure(renderer)).toEqual(available(200));
    expect(physicalMeasureKind(renderer)).toBe("privateResident");
    expect(physicalMeasure(host)).toEqual(available(100));
    expect(physicalMeasureKind(host)).toBe("pss");
  });

  it("keeps renderer, host and workers visibly separate, including a missing role", () => {
    const current = snapshot([renderer, host, worker], {
      platform: "darwin",
      byRole: [
        { role: "desktop_renderer", coverage: { processes: 1, measured: 1, complete: true }, knownPhysicalBytes: 200, physical: available(200) },
        { role: "host", coverage: { processes: 1, measured: 1, complete: true }, knownPhysicalBytes: 90, physical: available(90) },
        { role: "project_worker", coverage: { processes: 1, measured: 1, complete: true }, knownPhysicalBytes: 250, physical: available(250) },
      ],
    });
    expect(roleSummaries(current, [current]).map((row) => [row.label, row.processCount, row.current, row.coverage])).toEqual([
      ["Renderer", 1, { status: "available", value: 200 }, "1 of 1 processes measured"],
      ["Host", 1, { status: "available", value: 90 }, "1 of 1 processes measured"],
      ["Workers", 1, { status: "available", value: 250 }, "1 of 1 processes measured"],
    ]);
    const withoutRenderer = roleSummaries(snapshot([host, worker]), [snapshot([host, worker])])[0]!;
    expect(withoutRenderer.current).toMatchObject({ status: "unavailable", reason: "No process with this role was discovered" });
  });

  it("uses snapshot role coverage rather than recomputing it from platform or row metrics", () => {
    const current = snapshot([renderer], {
      platform: "linux",
      byRole: [{
        role: "desktop_renderer",
        coverage: { processes: 3, measured: 2, complete: false },
        knownPhysicalBytes: 200,
        physical: unavailable("incomplete_coverage"),
      }],
    });
    const summary = roleSummaries(current, [current])[0]!;
    expect(summary.processCount).toBe(3);
    expect(summary.coverage).toBe("2 of 3 processes measured");
    expect(summary.current).toEqual({ status: "unavailable", reason: "2 of 3 processes measured", knownValue: 200 });
  });

  it("groups by role and opaque work owner using pid@startToken identity", () => {
    const child = process({ ...worker, key: "13@child", pid: 13, role: "project_worker", label: "child", parentKey: worker.key });
    const groups = processTree(snapshot([host, child, worker]));
    expect(groups.map((group) => group.label)).toEqual(["Host", "Project workers"]);
    const owners = groups[1]!.owners;
    expect(owners).toHaveLength(1);
    expect(owners[0]!.id).toBe("opaque");
    expect(owners[0]!.roots[0]!.process.key).toBe("12@worker");
    expect(owners[0]!.roots[0]!.children[0]!.process.key).toBe("13@child");
  });

  it("preserves orphaned and cyclic process rows as visible roots", () => {
    const orphan = process({ ...worker, key: "13@orphan", pid: 13, label: "orphan", parentKey: "missing@parent" });
    const cycleA = process({ ...worker, key: "14@a", pid: 14, label: "cycle a", parentKey: "15@b" });
    const cycleB = process({ ...worker, key: "15@b", pid: 15, label: "cycle b", parentKey: "14@a" });
    const roots = processTree(snapshot([orphan, cycleA, cycleB]))[0]!.owners[0]!.roots;
    expect(roots.map((node) => node.process.key)).toEqual(["14@a", "15@b", "13@orphan"]);
    expect(roots.flatMap((node) => node.children)).toHaveLength(0);
  });

  it("shows exact local facts and centralizes every unavailable counter owner", () => {
    const inherited = process({ ...worker, key: "13@child", pid: 13, role: "unknown_descendant", associations: { ...worker.associations, truncated: true } });
    const rows = retainedStoreRows({ snapshot: snapshot([host, worker, inherited]), savedSessions: 12, rendererViews: 3, pendingMessages: 2 });
    expect(rows.find((row) => row.id === "associated-runs")?.count).toEqual({ status: "available", value: 1, qualifier: "at least; association list was truncated" });
    expect(rows.find((row) => row.id === "rendererViews")?.count).toEqual({ status: "available", value: 3 });
    for (const [id, handoff] of [["workerSessions", "T4"], ["workerReplay", "T4"], ["workerCaches", "T4"], ["rendererViews", "T5"], ["taskRegistry", "T6"], ["deliveryRegistry", "T6"], ["providerQueues", "T7"]] as const) {
      const row = rows.find((candidate) => candidate.id === id)!;
      expect(row.handoff).toBe(handoff);
      expect(row.bytes).toMatchObject({ status: "unavailable" });
      expect(row.bytes.status === "unavailable" ? row.bytes.reason.toLowerCase() : "").toContain(row.owner.toLowerCase());
      expect(row.bytes.status === "unavailable" ? row.bytes.reason : "").not.toMatch(/M18|typed producer/i);
    }
    const withProducer = retainedStoreRows({ snapshot: snapshot([host]), rendererViews: 1, pendingMessages: 0, optional: { workerReplay: { count: 7, bytes: 8_192 } } });
    expect(withProducer.find((row) => row.id === "workerReplay")).toMatchObject({ count: { status: "available", value: 7 }, bytes: { status: "available", value: 8_192 } });
  });

  it("shows the counters the host actually reports instead of claiming they are unreported", () => {
    const reported = snapshot([host, worker], {
      stores: {
        entries: { taskRegistry: { count: 9, bytes: 4_096 }, deliveryRegistry: { count: 3 } },
        coverage: { workers: 2, answered: 2, complete: true },
      },
    });
    const rows = retainedStoreRows({ snapshot: reported, rendererViews: 1, pendingMessages: 0 });
    const tasks = rows.find((row) => row.id === "taskRegistry")!;
    const delivery = rows.find((row) => row.id === "deliveryRegistry")!;
    expect(tasks.count).toEqual({ status: "available", value: 9 });
    expect(tasks.bytes).toEqual({ status: "available", value: 4_096 });
    expect(delivery.count).toEqual({ status: "available", value: 3 });
    // Membership holds no payload, so its bytes stay unavailable rather than 0.
    expect(delivery.bytes).toMatchObject({ status: "unavailable" });
    // The false sentence this replaced: neither count claims non-reporting.
    for (const row of [tasks, delivery]) {
      expect(JSON.stringify(row.count)).not.toContain("not currently reported");
    }
    // A key no producer reports is still named plainly, never a zero.
    expect(rows.find((row) => row.id === "providerQueues")!.count).toEqual({
      status: "unavailable",
      reason: "This count is not currently reported by Workers",
    });
  });

  it("qualifies a worker-aggregated count as at-least while a live worker has not answered", () => {
    const partial = snapshot([host, worker], {
      stores: {
        // A byte total that arrives while two workers are still silent is a
        // partial total, whoever sent it: the surface must refuse it.
        entries: { taskRegistry: { count: 5, bytes: 9_999 }, deliveryRegistry: { count: 2 } },
        coverage: { workers: 3, answered: 1, complete: false, reason: "collector_failed" },
      },
    });
    const rows = retainedStoreRows({ snapshot: partial, rendererViews: 1, pendingMessages: 0 });
    const tasks = rows.find((row) => row.id === "taskRegistry")!;
    expect(tasks.count).toEqual({ status: "available", value: 5, qualifier: "at least; 1 of 3 workers answered" });
    expect(tasks.bytes).toEqual({
      status: "unavailable",
      reason: "Retained bytes are complete only when every live worker answers; 1 of 3 workers answered",
    });
    expect(JSON.stringify(tasks.bytes)).not.toContain("9999");
    // Host-only, so incomplete worker coverage cannot make it an estimate.
    expect(rows.find((row) => row.id === "deliveryRegistry")!.count).toEqual({ status: "available", value: 2 });
    // Nothing reported stays unreported: partial coverage does not invent one.
    expect(rows.find((row) => row.id === "workerCaches")!.count).toEqual({
      status: "unavailable",
      reason: "This count is not currently reported by Project workers",
    });
    expect(rows.find((row) => row.id === "workerCaches")!.bytes).toEqual({
      status: "unavailable",
      reason: "Retained bytes are not currently reported by Project workers",
    });
  });
});

const session = { id: "s1", path: "/p/s1.jsonl", cwd: "/p", createdAt: "2026-09-13T10:00:00.000Z", modifiedAt: "2026-09-13T10:00:00.000Z", messageCount: 1 } satisfies SessionSummary;
const run = { runId: "r1", sessionId: "s1", sessionPath: session.path, rootSessionId: "s1", rootSessionPath: session.path, agentName: "worker", task: "work", status: "running", createdAt: session.createdAt, updatedAt: session.modifiedAt, startedAt: session.createdAt } as AgentRun;
const task = { id: "t1", sessionId: "s1", sessionPath: session.path, command: "sleep", title: "sleep", status: "running", startedAt: session.createdAt, outputBytes: 0 } as BackgroundTask;

it("re-resolves exact current session, run and task ownership and rejects stale or ambiguous records", () => {
  const state = { sessions: [session], runs: { r1: run }, tasks: { t1: task }, openPaths: new Set<string>(), presence: { [session.path]: true } };
  expect(resolveSessionAssociation("s1", state)).toEqual({ path: session.path });
  expect(resolveRunAssociation("r1", state)).toMatchObject({ path: session.path, run });
  expect(resolveTaskAssociation("t1", state)).toMatchObject({ path: session.path, task });
  expect(resolveRunAssociation("gone", state).reason).toContain("not currently known");
  expect(resolveTaskAssociation("gone", state).reason).toContain("not currently known");
  expect(resolveSessionAssociation("s1", { ...state, sessions: [session, { ...session, path: "/q/s1.jsonl", cwd: "/q" }] }).reason).toContain("ambiguous");
  expect(resolveRunAssociation("r1", { ...state, presence: { [session.path]: false } }).reason).toContain("not currently reachable");
});
