import { describe, expect, it, vi } from "vitest";
import { resourceAvailable, resourceUnavailable, type ResourceDesktopReport } from "@lasercode/protocol";
import { ResourceService } from "../../src/resources/service.js";
import type { ProcessCollector, ProcessRowMetrics, ProcessTableRow } from "../../src/resources/platform.js";

/**
 * A process table the test owns completely: identity, structure and numbers.
 * Nothing here needs a real machine, and every assertion is an equality.
 */
interface FakeProcess extends ProcessTableRow {
  pssBytes?: number;
  residentBytes?: number;
}

class FakeCollector implements ProcessCollector {
  readonly name = "fake";
  readonly source = "proc" as const;
  tableCalls = 0;
  measureCalls = 0;
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
  }
}

const token = (pid: number): string => `linux:boot:${pid}`;
const proc = (pid: number, ppid: number, label: string, extra: Partial<FakeProcess> = {}): FakeProcess => ({
  pid,
  ppid,
  startToken: token(pid),
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
    proc(101, 100, "electron", { residentBytes: 2000 }),
    proc(200, 100, "node"),
    proc(300, 200, "node"),
    proc(400, 300, "bash"),
    proc(999, 1, "someone-elses-program"),
  ];
}

function service(rows: FakeProcess[], options: Partial<ConstructorParameters<typeof ResourceService>[0]> = {}) {
  const collector = new FakeCollector(rows);
  const resources = new ResourceService({
    collector,
    platform: "linux",
    hostPid: 200,
    hostParentPid: 100,
    ancestorsOf: () => [{ pid: 100, startToken: token(100) }, { pid: 1, startToken: token(1) }],
    // The fixture's identities, as the machine would report them at spawn.
    startTokenOf: (pid: number) => (rows.some((row) => row.pid === pid) ? token(pid) : undefined),
    ...options,
  });
  return { collector, resources };
}

const report = (overrides: Partial<ResourceDesktopReport> = {}): ResourceDesktopReport => ({
  at: new Date().toISOString(),
  main: { pid: 100 },
  processes: [
    { pid: 100, type: "Browser", workingSetBytes: 2000 },
    { pid: 101, type: "Tab", workingSetBytes: 2000 },
  ],
  ...overrides,
});

describe("discovery", () => {
  it("collects only what descends from something the host knows", async () => {
    const { resources } = service(tree());
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot();
    // The host, its worker, the worker's child. Not the shell (no verified
    // report yet) and never an unrelated program.
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

  it("gives a reused pid neither the role nor the project of its predecessor", async () => {
    const rows = tree();
    const { resources } = service(rows);
    resources.ownership.noteWorker("/projects/alpha", 300);
    // Same number, different process: the table now reports a new start token.
    rows.splice(rows.findIndex((row) => row.pid === 300), 1, { ...proc(300, 200, "vim"), startToken: "linux:boot:reused" });
    const { snapshot } = await resources.snapshot();
    const reused = snapshot.processes.find((row) => row.pid === 300)!;
    expect(reused.role).toBe("unknown_descendant");
    expect(reused.project).toBeUndefined();
    expect(reused.associations).toBeUndefined();
  });

  it("collects because it was asked, not on a timer, and shares one collection", async () => {
    const { collector, resources } = service(tree());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collector.tableCalls).toBe(0);
    const [a, b] = await Promise.all([resources.snapshot({ refresh: true }), resources.snapshot({ refresh: true })]);
    expect(collector.tableCalls).toBe(1);
    expect(a.snapshot.id).toBe(b.snapshot.id);
    // A repeat inside the minimum interval is answered from the last snapshot.
    const again = await resources.snapshot();
    expect(again.snapshot.id).toBe(a.snapshot.id);
    expect(collector.tableCalls).toBe(1);
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
    // Resident is complete here, and is still named for what it is.
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
    const resources = new ResourceService({ platform: "sunos" as NodeJS.Platform, hostPid: 200, ancestorsOf: () => [] });
    const { snapshot } = await resources.snapshot();
    expect(snapshot.platform).toBe("other");
    expect(snapshot.health.collectors[0]).toMatchObject({ status: "unsupported" });
    expect(snapshot.processes).toEqual([]);
    expect(snapshot.totals.physical).toMatchObject({ status: "unavailable" });
  });
});

describe("the desktop cross-check", () => {
  it("believes a shell that is genuinely this host's ancestor", async () => {
    const { resources } = service(tree());
    expect(resources.receiveDesktopReport(report())).toEqual({ accepted: 2, rejected: 0, verified: true });
    const { snapshot } = await resources.snapshot({ refresh: true });
    const roles = Object.fromEntries(snapshot.processes.map((row) => [row.pid, row.role]));
    expect(roles[100]).toBe("desktop_main");
    expect(roles[101]).toBe("desktop_renderer");
    expect(snapshot.health.crossCheck.status).toBe("ok");
    // Electron's number is metadata beside our own, never the measurement.
    const renderer = snapshot.processes.find((row) => row.pid === 101)!;
    expect(renderer.electron).toMatchObject({ type: "Tab", workingSetBytes: { status: "available", value: 2000 } });
    expect(renderer.source).toBe("proc");
  });

  it("relabels nothing for a local client that is not this host's shell", async () => {
    const { resources } = service(tree());
    const result = resources.receiveDesktopReport(report({ main: { pid: 999 }, processes: [{ pid: 300, type: "Browser", workingSetBytes: 1 }] }));
    expect(result).toEqual({ accepted: 0, rejected: 1, verified: false });
    resources.ownership.noteWorker("/projects/alpha", 300);
    const { snapshot } = await resources.snapshot({ refresh: true });
    expect(snapshot.processes.find((row) => row.pid === 300)!.role).toBe("project_worker");
    expect(snapshot.processes.find((row) => row.pid === 100)).toBeUndefined();
    expect(snapshot.health.crossCheck).toMatchObject({ status: "unverified" });
  });

  it("refuses a report whose own identity for the shell disagrees with this machine", async () => {
    const { resources } = service(tree());
    const result = resources.receiveDesktopReport(report({ main: { pid: 100, startToken: "linux:boot:somebody-else" } }));
    expect(result.verified).toBe(false);
    const { snapshot } = await resources.snapshot({ refresh: true });
    expect(snapshot.health.crossCheck.status).toBe("unverified");
  });

  it("ignores a reported row that is not in the verified tree as the host sees it", async () => {
    const { resources } = service(tree());
    resources.receiveDesktopReport(report({ processes: [{ pid: 100, type: "Browser", workingSetBytes: 2000 }, { pid: 999, type: "Tab", workingSetBytes: 5 }] }));
    const { snapshot } = await resources.snapshot({ refresh: true });
    expect(snapshot.processes.find((row) => row.pid === 999)).toBeUndefined();
  });

  it("calls an old report stale and asks the shell for a fresh one", async () => {
    const refresh = vi.fn();
    const { resources } = service(tree(), { requestDesktopRefresh: refresh });
    resources.receiveDesktopReport(report({ at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    const { snapshot } = await resources.snapshot({ refresh: true });
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
    const rows = tree();
    rows.find((row) => row.pid === 101)!.residentBytes = 100;
    const { resources } = service(rows);
    resources.receiveDesktopReport(report());
    const { snapshot } = await resources.snapshot({ refresh: true });
    expect(snapshot.health.crossCheck.status).toBe("diverged");
    expect(snapshot.health.crossCheck.detail).toContain("working set");
  });
});

describe("history and export", () => {
  it("retains every snapshot it took and exports the same sanitized rows", async () => {
    const { resources } = service(tree(), { minIntervalMs: 0 });
    resources.ownership.noteWorker("/home/someone/secret-client/alpha", 300);
    await resources.snapshot({ refresh: true });
    await resources.snapshot({ refresh: true });
    const history = resources.historyPage();
    expect(history.snapshots).toHaveLength(2);
    expect(history.retention.processRows).toBe(6);

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
    const { snapshot } = await resources.snapshot({ refresh: true });
    const command = snapshot.processes.find((row) => row.pid === 400)!;
    expect(command.role).toBe("background_command");
    expect(command.associations).toMatchObject({ taskIds: ["task-3"], sessionIds: ["sess-9"] });
    expect(JSON.stringify(command)).not.toContain("/sessions/a.jsonl");
  });
});
