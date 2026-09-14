import { describe, expect, it, vi } from "vitest";
import { resourceAvailable, resourceUnavailable, type ResourceDesktopReport } from "@lasercode/protocol";
import { ResourceService } from "../../src/resources/service.js";
import type { ProcessCollector, ProcessRowMetrics, ProcessTableRow } from "../../src/resources/platform.js";

/**
 * A process table the test owns completely: identity, structure, start times
 * and numbers. Nothing here needs a real machine, and every assertion is an
 * equality rather than a plausibility.
 */
interface FakeProcess extends ProcessTableRow {
  pssBytes?: number;
  residentBytes?: number;
}

/** Fixed clock, so "started before it was registered" is a fact, not a race. */
const NOW = 2_000_000_000_000;

class FakeCollector implements ProcessCollector {
  readonly name = "fake";
  readonly source = "proc" as const;
  tableCalls = 0;
  measureCalls = 0;
  inFlight = 0;
  peakInFlight = 0;
  measureDelayMs = 0;
  failTable: Error | undefined;
  failPids = new Set<number>();

  constructor(public rows: FakeProcess[]) {}

  async table(): Promise<ProcessTableRow[]> {
    this.tableCalls += 1;
    if (this.failTable) throw this.failTable;
    return this.rows.map(({ pssBytes: _p, residentBytes: _r, ...row }) => row);
  }

  async measure(row: ProcessTableRow): Promise<ProcessRowMetrics> {
    this.measureCalls += 1;
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      if (this.measureDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.measureDelayMs));
      if (this.failPids.has(row.pid)) throw new Error(`cannot read ${row.pid}`);
      const found = this.rows.find((candidate) => candidate.pid === row.pid)!;
      return {
        memory: {
          pss: found.pssBytes === undefined ? resourceUnavailable("permission_denied") : resourceAvailable(found.pssBytes),
          resident: found.residentBytes === undefined ? resourceUnavailable("permission_denied") : resourceAvailable(found.residentBytes),
          peakResident: resourceAvailable(1),
          privateResident: resourceUnavailable("unsupported_platform"),
          commit: resourceUnavailable("unsupported_platform"),
        },
        cpu: { seconds: resourceAvailable(1) },
        elapsedMs: resourceAvailable(1000),
        io: { readBytes: resourceAvailable(0), writeBytes: resourceAvailable(0) },
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

const token = (pid: number): string => `linux:boot:${pid}`;
const startedAt = (pid: number): number => NOW - 60_000 - pid;

const proc = (pid: number, ppid: number, label: string, extra: Partial<FakeProcess> = {}): FakeProcess => ({
  pid,
  ppid,
  startToken: token(pid),
  startedAtMs: startedAt(pid),
  label,
  pssBytes: 1000,
  residentBytes: 2000,
  ...extra,
});

/** shell(100) → host(200) → worker(300) → child(400), plus a renderer(101). */
function tree(): FakeProcess[] {
  return [
    proc(1, 0, "init"),
    proc(100, 1, "electron"),
    proc(101, 100, "electron"),
    proc(200, 100, "node"),
    proc(300, 200, "node"),
    proc(400, 300, "bash"),
    proc(999, 1, "someone-elses-program"),
  ];
}

/** An adopted host: it is *not* a descendant of the shell that reports. */
function adoptedTree(): FakeProcess[] {
  return [
    proc(1, 0, "init"),
    proc(100, 1, "electron"),
    proc(101, 100, "electron"),
    proc(200, 1, "node"), // started by `laser up`, adopted by the shell
    proc(300, 200, "node"),
  ];
}

function service(rows: FakeProcess[], options: Partial<ConstructorParameters<typeof ResourceService>[0]> = {}) {
  const collector = new FakeCollector(rows);
  const resources = new ResourceService({
    collector,
    platform: "linux",
    hostPid: 200,
    minIntervalMs: 0,
    now: () => NOW,
    ...options,
  });
  return { collector, resources };
}

const report = (overrides: Partial<ResourceDesktopReport> = {}): ResourceDesktopReport => ({
  at: new Date(NOW).toISOString(),
  main: { pid: 100, creationTime: startedAt(100) },
  processes: [
    { pid: 100, creationTime: startedAt(100), type: "Browser", workingSetBytes: 2000 },
    { pid: 101, creationTime: startedAt(101), type: "Tab", workingSetBytes: 2000 },
  ],
  ...overrides,
});

describe("discovery", () => {
  it("collects only what descends from something the host can prove it knows", async () => {
    const { resources } = service(tree());
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    expect(snapshot.processes.map((row) => row.pid).sort()).toEqual([200, 300, 400]);
    expect(snapshot.processes.find((row) => row.pid === 999)).toBeUndefined();
  });

  it("names roles structurally and calls an unregistered descendant what it is", async () => {
    const { resources } = service(tree());
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    const roles = Object.fromEntries(snapshot.processes.map((row) => [row.pid, row.role]));
    expect(roles).toEqual({ 200: "host", 300: "project_worker", 400: "unknown_descendant" });
    expect(snapshot.processes.find((row) => row.pid === 400)!.parentKey).toBe(`300@${token(300)}`);
  });

  it("refuses to adopt an unproven record whose pid already belongs to a later process", async () => {
    let now = NOW;
    // pid 500 is nobody's descendant: only its own record could put it in.
    const rows = [proc(1, 0, "init"), proc(200, 1, "node"), proc(500, 1, "node"), proc(501, 500, "bash")];
    const { resources } = service(rows, { now: () => now });
    resources.ownership.noteWorker("/projects/alpha", 500);
    // Before the first table, pid 500 already belongs to a later process.
    rows.splice(rows.findIndex((row) => row.pid === 500), 1, { ...proc(500, 1, "vim"), startToken: "linux:boot:later", startedAtMs: now + 30_000 });
    now += 60_000;
    const { snapshot } = await resources.snapshot();
    expect(snapshot.processes.map((row) => row.pid)).toEqual([200]);
  });

  it("gives a reused pid neither the role, the project nor the associations of its predecessor", async () => {
    const rows = tree();
    const { resources } = service(rows, {
      lookups: { sessionIdsOf: () => ["sess-1"], runIdsOf: () => ["run_7"] },
    });
    resources.ownership.noteWorker("/projects/alpha", 300);
    // One snapshot proves the record against the machine, as a real host does.
    await resources.snapshot();
    // Then the worker exits without telling us, and the kernel hands 300 on.
    rows.splice(rows.findIndex((row) => row.pid === 300), 1, {
      ...proc(300, 200, "vim"),
      startToken: "linux:boot:reused",
      startedAtMs: NOW - 1000,
    });
    const { snapshot } = await resources.snapshot();
    const reused = snapshot.processes.find((row) => row.pid === 300)!;
    expect(reused.role).toBe("unknown_descendant");
    expect(reused.project).toBeUndefined();
    expect(reused.associations).toBeUndefined();
    // And the stale record is gone, so it cannot make that subtree a root again.
    expect(resources.ownership.size()).toBe(0);
  });

  it("does not let a stale record keep a subtree in the inventory", async () => {
    const rows = [proc(1, 0, "init"), proc(200, 1, "node"), proc(500, 1, "node"), proc(501, 500, "bash")];
    const { resources } = service(rows);
    resources.ownership.noteWorker("/projects/alpha", 500);
    const first = await resources.snapshot();
    expect(first.snapshot.processes.map((row) => row.pid).sort()).toEqual([200, 500, 501]);

    // pid 500 is now somebody else's, and 501 is its child.
    rows.splice(rows.findIndex((row) => row.pid === 500), 1, { ...proc(500, 1, "vim"), startToken: "linux:boot:reused", startedAtMs: NOW - 500 });
    const second = await resources.snapshot();
    expect(second.snapshot.processes.map((row) => row.pid)).toEqual([200]);
  });

  it("collects because it was asked, not on a timer, and shares one collection", async () => {
    const { collector, resources } = service(tree());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collector.tableCalls).toBe(0);
    const [a, b] = await Promise.all([resources.snapshot(), resources.snapshot()]);
    expect(collector.tableCalls).toBe(1);
    expect(a.snapshot.id).toBe(b.snapshot.id);
  });

  it("holds the collection floor even against a client asking for a refresh in a loop", async () => {
    let now = NOW;
    const { collector, resources } = service(tree(), { minIntervalMs: 250, now: () => now });
    await resources.snapshot({ refresh: true });
    for (let attempt = 0; attempt < 20; attempt += 1) await resources.snapshot({ refresh: true });
    expect(collector.tableCalls).toBe(1);
    now += 300;
    await resources.snapshot({ refresh: true });
    expect(collector.tableCalls).toBe(2);
  });

  it("keeps a snapshot inside its deadline and says the rest was not collected", async () => {
    let now = NOW;
    const rows = [proc(1, 0, "init"), proc(200, 1, "node"), ...Array.from({ length: 40 }, (_, index) => proc(1000 + index, 200, "child"))];
    const { collector, resources } = service(rows, {
      deadlineMs: 50,
      measureConcurrency: 4,
      // Each measurement costs time on this clock, as `vmmap` does on macOS.
      now: () => now,
    });
    collector.measureDelayMs = 1;
    const original = collector.measure.bind(collector);
    collector.measure = async (row) => {
      now += 10;
      return original(row);
    };
    const { snapshot } = await resources.snapshot();
    const skipped = snapshot.processes.filter((row) => row.memory.pss.status === "unavailable" && row.memory.pss.reason === "not_collected");
    expect(skipped.length).toBeGreaterThan(0);
    expect(snapshot.health.truncated).toBe(true);
    expect(collector.peakInFlight).toBeLessThanOrEqual(4);
  });
});

describe("truncation", () => {
  it("cuts the inventory at its row bound, says so, and leaves no link to a row it did not keep", async () => {
    const rows: FakeProcess[] = [proc(1, 0, "init"), proc(200, 1, "node")];
    // A wide tree, then a deeper layer under it, so the cut lands mid-tree.
    for (let index = 0; index < 400; index += 1) rows.push(proc(1000 + index, 200, "child"));
    for (let index = 0; index < 400; index += 1) rows.push(proc(2000 + index, 1000 + index, "grandchild"));
    const { resources } = service(rows);
    const { snapshot } = await resources.snapshot();

    expect(snapshot.health.truncated).toBe(true);
    expect(snapshot.processes.length).toBeLessThanOrEqual(512);
    const keys = new Set(snapshot.processes.map((row) => row.key));
    for (const row of snapshot.processes) {
      if (row.parentKey) expect(keys.has(row.parentKey)).toBe(true);
    }
  });
});

describe("associations and owners", () => {
  it("carries session, run and task ids as associations, and no path anywhere", async () => {
    const { resources } = service(tree(), {
      lookups: {
        sessionIdsOf: () => ["sess-1", "sess-2"],
        runIdsOf: () => ["run_7"],
        taskIdsOf: () => ["task-3"],
        sessionIdOf: () => "sess-1",
      },
    });
    resources.ownership.noteWorker("/home/someone/secret-client/alpha", 300);
    const { snapshot } = await resources.snapshot();
    const worker = snapshot.processes.find((row) => row.pid === 300)!;
    expect(worker.project).toMatchObject({ label: "alpha" });
    expect(worker.associations).toEqual({ sessionIds: ["sess-1", "sess-2"], runIds: ["run_7"], taskIds: ["task-3"] });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("/home/someone");
    expect(serialized).not.toContain("secret-client");
  });

  it("gives an unregistered descendant its nearest proved ancestor's ownership context, and no role it did not earn", async () => {
    const { resources } = service(tree(), {
      lookups: { sessionIdsOf: () => ["sess-1"], runIdsOf: () => ["run_7"] },
    });
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    const child = snapshot.processes.find((row) => row.pid === 400)!;
    expect(child.role).toBe("unknown_descendant");
    expect(child.project).toMatchObject({ label: "alpha" });
    expect(child.associations).toEqual({ sessionIds: ["sess-1"], runIds: ["run_7"] });
    // Context, not allocation: the child's own memory is its own row, and the
    // worker's total does not change because a child inherited its project.
    expect(child.memory.pss).toEqual({ status: "available", value: 1000 });
  });

  it("does not let a descendant inherit from a record the table disproved", async () => {
    const rows = tree();
    const { resources } = service(rows, { lookups: { sessionIdsOf: () => ["sess-1"] } });
    resources.ownership.noteWorker("/projects/alpha", 300);
    await resources.snapshot();
    rows.splice(rows.findIndex((row) => row.pid === 300), 1, { ...proc(300, 200, "vim"), startToken: "linux:boot:reused", startedAtMs: NOW - 100 });
    const { snapshot } = await resources.snapshot();
    for (const row of snapshot.processes) {
      expect(row.project).toBeUndefined();
      expect(row.associations).toBeUndefined();
    }
  });

  it("survives a catalog that throws while answering an association", async () => {
    const { resources } = service(tree(), {
      lookups: {
        sessionIdsOf: () => {
          throw new Error("catalog is busy");
        },
      },
    });
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    expect(snapshot.processes.find((row) => row.pid === 300)!.role).toBe("project_worker");
  });
});

describe("totals", () => {
  it("refuses to call a partial sum a total, and says how much it measured", async () => {
    const rows = tree();
    rows.find((row) => row.pid === 400)!.pssBytes = undefined;
    const { resources } = service(rows);
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    expect(snapshot.totals.coverage).toEqual({ processes: 3, measured: 2, complete: false });
    expect(snapshot.totals.knownPhysicalBytes).toBe(2000);
    expect(snapshot.totals.physical).toMatchObject({ status: "unavailable", reason: "incomplete_coverage" });
    expect(snapshot.totals.residentSum).toEqual({ status: "available", value: 6000 });
  });

  it("gives a complete total when every row was measured", async () => {
    const { resources } = service(tree());
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    expect(snapshot.totals.physical).toEqual({ status: "available", value: 3000 });
    expect(snapshot.byRole.find((entry) => entry.role === "host")!.physical).toEqual({ status: "available", value: 1000 });
  });
});

describe("failure isolation", () => {
  it("answers with an empty, honest snapshot when the table cannot be read", async () => {
    const { collector, resources } = service(tree());
    collector.failTable = new Error("proc is not mounted");
    const { snapshot } = await resources.snapshot();
    expect(snapshot.processes).toEqual([]);
    expect(snapshot.health.ok).toBe(false);
    expect(snapshot.health.collectors[0]).toMatchObject({ name: "fake", status: "failed" });
    expect(snapshot.health.collectors[0]!.detail).toContain("proc is not mounted");
  });

  it("costs one unreadable process its numbers and no more", async () => {
    const { collector, resources } = service(tree());
    collector.failPids.add(400);
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    const failed = snapshot.processes.find((row) => row.pid === 400)!;
    expect(failed.memory.pss).toMatchObject({ status: "unavailable", reason: "collector_failed" });
    expect(snapshot.processes.find((row) => row.pid === 300)!.memory.pss).toEqual({ status: "available", value: 1000 });
  });

  it("reports an unsupported platform instead of inventing a collector", async () => {
    const resources = new ResourceService({ platform: "sunos" as NodeJS.Platform, hostPid: 200, minIntervalMs: 0 });
    const { snapshot } = await resources.snapshot();
    expect(snapshot.platform).toBe("other");
    expect(snapshot.health.collectors[0]).toMatchObject({ status: "unsupported" });
    expect(snapshot.processes).toEqual([]);
    expect(snapshot.totals.physical).toMatchObject({ status: "unavailable" });
  });
});

describe("the desktop cross-check", () => {
  it("believes a shell that owns a process tree this host can see, even when it did not start this host", async () => {
    const { resources } = service(adoptedTree());
    expect(resources.receiveDesktopReport(report())).toEqual({ accepted: 0, rejected: 0, verified: false, pending: true });
    const { snapshot } = await resources.snapshot();
    const roles = Object.fromEntries(snapshot.processes.map((row) => [row.pid, row.role]));
    expect(roles[100]).toBe("desktop_main");
    expect(roles[101]).toBe("desktop_renderer");
    expect(roles[200]).toBe("host");
    expect(snapshot.health.crossCheck.status).toBe("ok");
    const renderer = snapshot.processes.find((row) => row.pid === 101)!;
    expect(renderer.electron).toMatchObject({ type: "Tab", workingSetBytes: { status: "available", value: 2000 } });
    // Electron is never a measurement source.
    expect(renderer.source).toBe("proc");
  });

  it("refuses a row whose creation time is not the one this machine reports", async () => {
    const { resources } = service(adoptedTree());
    await resources.snapshot(); // a demand, so a recent table exists to check against
    const result = resources.receiveDesktopReport(
      report({
        processes: [
          { pid: 100, creationTime: startedAt(100), type: "Browser", workingSetBytes: 2000 },
          // A recycled renderer pid: same number, a process that started later.
          { pid: 101, creationTime: startedAt(101) - 600_000, type: "Tab", workingSetBytes: 999_999 },
        ],
      }),
    );
    expect(result).toEqual({ accepted: 1, rejected: 1, verified: true });
    const { snapshot } = await resources.snapshot();
    expect(snapshot.processes.find((row) => row.pid === 101)!.electron).toBeUndefined();
  });

  it("refuses a row that is outside the reported app's own subtree", async () => {
    const { resources } = service(adoptedTree());
    await resources.snapshot();
    const result = resources.receiveDesktopReport(
      report({ processes: [{ pid: 100, creationTime: startedAt(100), type: "Browser", workingSetBytes: 2000 }, { pid: 300, creationTime: startedAt(300), type: "Tab", workingSetBytes: 1 }] }),
    );
    expect(result).toEqual({ accepted: 1, rejected: 1, verified: true });
  });

  it("refuses a claim about a process that is not running here, and keeps the last verified one", async () => {
    const { resources } = service(adoptedTree());
    await resources.snapshot();
    resources.receiveDesktopReport(report());
    const bad = resources.receiveDesktopReport(report({ main: { pid: 4242, creationTime: NOW }, processes: [{ pid: 4242, creationTime: NOW, type: "Browser", workingSetBytes: 1 }] }));
    expect(bad).toEqual({ accepted: 0, rejected: 1, verified: false });
    const { snapshot } = await resources.snapshot();
    // The good report still stands; the bad one relabelled nothing.
    expect(snapshot.processes.find((row) => row.pid === 101)!.role).toBe("desktop_renderer");
    expect(snapshot.health.crossCheck.status).toBe("ok");
  });

  it("reads nothing when a report arrives, however often the app connects", async () => {
    const { collector, resources } = service(adoptedTree());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(resources.receiveDesktopReport(report())).toEqual({ accepted: 0, rejected: 0, verified: false, pending: true });
    }
    // A connection is not a question. Nothing has walked the machine yet.
    expect(collector.tableCalls).toBe(0);
    expect(collector.measureCalls).toBe(0);

    // The next demand verifies the claim it was holding.
    const { snapshot } = await resources.snapshot();
    expect(collector.tableCalls).toBe(1);
    expect(snapshot.health.crossCheck.status).toBe("ok");
    expect(snapshot.processes.find((row) => row.pid === 101)!.role).toBe("desktop_renderer");

    // With a recent table in hand, the next report is answered from it —
    // still without collecting again.
    expect(resources.receiveDesktopReport(report())).toEqual({ accepted: 2, rejected: 0, verified: true });
    expect(collector.tableCalls).toBe(1);
  });

  it("goes back to pending when the table it held has aged out", async () => {
    let now = NOW;
    const { collector, resources } = service(adoptedTree(), { now: () => now });
    await resources.snapshot();
    now += 61_000;
    expect(resources.receiveDesktopReport(report({ at: new Date(now).toISOString() }))).toMatchObject({ pending: true });
    expect(collector.tableCalls).toBe(1);
  });

  it("sanitizes the app's own process type before keeping it", async () => {
    const { resources } = service(adoptedTree());
    await resources.snapshot();
    resources.receiveDesktopReport(
      report({ processes: [{ pid: 100, creationTime: startedAt(100), type: "Browser", workingSetBytes: 2000 }, { pid: 101, creationTime: startedAt(101), type: "Tab <img src=x> s3cret/../", workingSetBytes: 2000 }] }),
    );
    const { snapshot } = await resources.snapshot();
    const renderer = snapshot.processes.find((row) => row.pid === 101)!;
    expect(renderer.electron!.type).toBe("Tab-img-src-x-s3cret-..");
    expect(JSON.stringify(snapshot)).not.toContain("<img");
  });

  it("holds the creation-time window to the platforms' own resolution", async () => {
    const { resources } = service(adoptedTree());
    await resources.snapshot();
    // A second of disagreement is what a whole-second `btime` or `lstart` can
    // produce for the same process.
    const near = resources.receiveDesktopReport(
      report({ processes: [{ pid: 101, creationTime: startedAt(101) + 1400, type: "Tab", workingSetBytes: 2000 }] }),
    );
    expect(near).toEqual({ accepted: 1, rejected: 0, verified: true });
    // Two seconds is not resolution any more; it is a different process.
    const far = resources.receiveDesktopReport(
      report({ processes: [{ pid: 101, creationTime: startedAt(101) + 2000, type: "Tab", workingSetBytes: 2000 }] }),
    );
    expect(far).toEqual({ accepted: 0, rejected: 1, verified: false });
  });

  it("refuses a renderer pid recycled seconds later", async () => {
    const { resources } = service(adoptedTree());
    await resources.snapshot();
    // The renderer died and pid 101 came back three seconds later.
    const result = resources.receiveDesktopReport(
      report({ processes: [{ pid: 101, creationTime: startedAt(101) - 3000, type: "Tab", workingSetBytes: 999_999 }] }),
    );
    expect(result).toEqual({ accepted: 0, rejected: 1, verified: false });
  });

  it("is not 'ok' when there was nothing to compare", async () => {
    const rows = adoptedTree();
    for (const row of rows) row.residentBytes = undefined; // we could not measure
    const { resources } = service(rows);
    resources.receiveDesktopReport(report());
    const { snapshot } = await resources.snapshot();
    expect(snapshot.health.crossCheck).toMatchObject({ status: "unverified" });
    expect(snapshot.health.crossCheck.detail).toContain("compare");
  });

  it("times a report by when the host received it, so a client clock cannot keep it fresh", async () => {
    let now = NOW;
    const refresh = vi.fn();
    const { resources } = service(adoptedTree(), { now: () => now, requestDesktopRefresh: refresh });
    // A client claiming the metrics were taken in the future.
    resources.receiveDesktopReport(report({ at: new Date(NOW + 10 * 60_000).toISOString() }));
    now += 10 * 60_000;
    const { snapshot } = await resources.snapshot();
    expect(snapshot.health.crossCheck.status).toBe("stale");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("is explicit about the first snapshot, before any shell has reported", async () => {
    const refresh = vi.fn();
    const { resources } = service(tree(), { requestDesktopRefresh: refresh });
    const { snapshot } = await resources.snapshot();
    expect(snapshot.health.crossCheck).toMatchObject({ status: "unavailable" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says so when Electron's own figure disagrees with ours beyond tolerance", async () => {
    const rows = adoptedTree();
    rows.find((row) => row.pid === 101)!.residentBytes = 100;
    const { resources } = service(rows);
    resources.receiveDesktopReport(report());
    const { snapshot } = await resources.snapshot();
    expect(snapshot.health.crossCheck.status).toBe("diverged");
    expect(snapshot.health.crossCheck.detail).toContain("working set");
  });
});

describe("history and export", () => {
  it("retains every snapshot it took and exports the same sanitized rows", async () => {
    const { resources } = service(tree());
    resources.ownership.noteWorker("/home/someone/secret-client/alpha", 300);
    await resources.snapshot();
    await resources.snapshot();
    const history = resources.historyPage();
    expect(history.snapshots).toHaveLength(2);
    expect(history.retention.processRows).toBe(6);
    // Spawn records are bounded on their own, and the reply says so.
    expect(history.retention).toMatchObject({ ownershipRecords: 1, maxOwnershipRecords: 512 });

    const exported = resources.export();
    expect(exported.bytes).toBe(Buffer.byteLength(exported.document, "utf8"));
    expect(exported.document).not.toContain("/home/someone");
    expect(JSON.parse(exported.document).snapshots).toHaveLength(2);
  });
});

describe("the registration contract RP-6 and RP-7 publish into", () => {
  it("names a registered background command and ties it to its session id", async () => {
    const { resources } = service(tree(), { lookups: { sessionIdOf: () => "sess-9" } });
    resources.ownership.noteWorker("/projects/alpha", 300);
    const accepted = resources.observeProcessRegistrations("/projects/alpha", [
      { pid: 400, role: "background_command", taskId: "task-3", sessionPath: "/sessions/a.jsonl" },
    ]);
    expect(accepted).toBe(1);
    const { snapshot } = await resources.snapshot();
    const command = snapshot.processes.find((row) => row.pid === 400)!;
    expect(command.role).toBe("background_command");
    expect(command.associations).toMatchObject({ taskIds: ["task-3"], sessionIds: ["sess-9"] });
    expect(JSON.stringify(command)).not.toContain("/sessions/a.jsonl");
  });
});
