import { describe, expect, it } from "vitest";
import { commFromStat, executableLabel, ppidFromStat, processKey, startTicksFromStat } from "../../src/resources/identity.js";
import { ProcessOwnershipRegistry, UNPROVEN_ADOPTION_WINDOW_MS, type ObservedProcess } from "../../src/resources/ownership.js";

describe("parsing /proc/<pid>/stat", () => {
  it("survives an executable name with spaces and parentheses", () => {
    const stat = "42 (my (weird) name) S 7 0 0 0 0 0 0 0 0 0 11 22 0 0 0 0 0 0 4242 0 0";
    expect(commFromStat(stat)).toBe("my (weird) name");
    expect(ppidFromStat(stat)).toBe(7);
    expect(startTicksFromStat(stat)).toBe("4242");
  });

  it("has no identity for a process it cannot describe", () => {
    expect(startTicksFromStat("nonsense")).toBeUndefined();
    expect(ppidFromStat("nonsense")).toBeUndefined();
  });

  it("keys a row by pid and start token together, never a pid", () => {
    expect(processKey(10, "linux:boot:777")).toBe("10@linux:boot:777");
  });
});

const observed = (pid: number, startedAtMs: number, token = `linux:boot:${startedAtMs}`): ObservedProcess => ({ pid, startToken: token, startedAtMs });

describe("ownership records and pid reuse", () => {
  it("is a claim until a collected table proves it", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now });
    registry.noteWorker("/projects/alpha", 10);
    // Nothing is provable before a table has been read.
    expect(registry.lookup(10, "linux:boot:999_000")).toBeUndefined();

    now += 50;
    const live = registry.reconcile([observed(10, 999_950)]);
    expect(live).toHaveLength(1);
    expect(registry.lookup(10, "linux:boot:999950")?.role).toBe("project_worker");
  });

  it("refuses to adopt a process that started after the registration: that is the next owner of the pid", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now });
    registry.noteWorker("/projects/alpha", 10);
    now += 60_000;
    // The worker died and pid 10 was handed to something started later.
    expect(registry.reconcile([observed(10, 1_030_000)])).toEqual([]);
    expect(registry.lookup(10, "linux:boot:1030000")).toBeUndefined();
  });

  it("prunes a proved record the moment the table disagrees, so a reused pid is never a root", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now });
    registry.noteWorker("/projects/alpha", 10);
    registry.reconcile([observed(10, 999_990)]);
    expect(registry.size()).toBe(1);

    now += 10_000;
    const live = registry.reconcile([observed(10, 1_005_000)]);
    expect(live).toEqual([]);
    expect(registry.size()).toBe(0);
    expect(registry.lookup(10, "linux:boot:1005000")).toBeUndefined();
  });

  it("keeps a record while its process is simply missing from one table, then forgets it", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now, maxAgeMs: 30_000 });
    registry.noteWorker("/projects/alpha", 10);
    expect(registry.reconcile([])).toEqual([]);
    expect(registry.size()).toBe(1);
    now += 31_000;
    registry.reconcile([]);
    expect(registry.size()).toBe(0);
  });

  it("gives up on an unproven claim whose pid never appears in time", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now });
    registry.noteWorker("/projects/alpha", 10);
    now += UNPROVEN_ADOPTION_WINDOW_MS + 1000;
    // Present, but started far too late to be the process we registered.
    expect(registry.reconcile([observed(10, now - 1000)])).toEqual([]);
    expect(registry.size()).toBe(0);
  });

  it("lets a late exit from a dead worker delete only its own record", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now });
    const first = registry.noteWorker("/projects/alpha", 10);
    now += 10;
    const second = registry.noteWorker("/projects/beta", 10);
    expect(second).not.toBe(first);

    registry.noteExit(10, first); // the old process's exit, arriving late
    expect(registry.size()).toBe(1);
    registry.reconcile([observed(10, 1_000_005)]);
    expect(registry.lookup(10, "linux:boot:1000005")?.projectCwd).toBe("/projects/beta");

    registry.noteExit(10, second);
    expect(registry.size()).toBe(0);
  });

  it("bounds records on its own, and never evicts a live worker to do it", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now, maxRecords: 3, maxAgeMs: 10 ** 9 });
    registry.noteWorker("/projects/alpha", 1);
    registry.noteWorker("/projects/beta", 2);
    for (let pid = 10; pid < 20; pid += 1) {
      now += 1;
      registry.observeProcessRegistrations("/projects/alpha", [{ pid, role: "background_command", taskId: `t${pid}` }]);
    }
    expect(registry.size()).toBe(3);
    // Both workers survived; the oldest commands were dropped.
    expect(registry.reconcile([observed(1, 999_999), observed(2, 999_999)]).map((record) => record.projectCwd).sort()).toEqual([
      "/projects/alpha",
      "/projects/beta",
    ]);
  });

  it("does not let workers whose exits were missed push the count bound aside", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now, maxRecords: 4, maxAgeMs: 30_000 });
    // Twenty workers come and go; every exit callback is lost, and no table
    // ever shows them again.
    for (let pid = 100; pid < 120; pid += 1) {
      now += 1000;
      registry.noteWorker(`/projects/p${pid}`, pid);
      registry.reconcile([observed(pid, now - 100)]);
    }
    now += 60_000;
    // Only the one the machine still shows survives the sweep.
    registry.noteWorker("/projects/live", 200);
    const live = registry.reconcile([observed(200, now - 50)]);
    expect(live.map((record) => record.pid)).toEqual([200]);
    expect(registry.size()).toBe(1);
    expect(registry.overflow).toBeUndefined();
  });

  it("keeps every worker the machine is actually running, and says when that is over the bound", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now, maxRecords: 2, maxAgeMs: 10 ** 9 });
    const table = [];
    for (let pid = 100; pid < 105; pid += 1) {
      registry.noteWorker(`/projects/p${pid}`, pid);
      table.push(observed(pid, now - 100));
    }
    now += 10;
    expect(registry.reconcile(table)).toHaveLength(5);
    // A running worker's record is the only proof of what that process is, so
    // it is kept — and the overflow is reported rather than implied away.
    expect(registry.size()).toBe(5);
    expect(registry.overflow).toBe("live_workers");

    // Once the machine stops showing them, the bound applies again.
    now += 10 ** 6;
    registry.reconcile([]);
    expect(registry.size()).toBe(2);
    expect(registry.overflow).toBeUndefined();
  });

  it("adopts a claim only inside the platforms' own start-time resolution", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now });
    registry.noteWorker("/projects/alpha", 10);
    // A whole-second `btime` can put the start 1.4s the wrong side of the
    // registration for the very process we started.
    expect(registry.reconcile([observed(10, now + 1400)])).toHaveLength(1);

    const other = new ProcessOwnershipRegistry({}, { now: () => now });
    other.noteWorker("/projects/alpha", 11);
    // Two seconds later is the next owner of the pid, not ours.
    expect(other.reconcile([observed(11, now + 2000)])).toEqual([]);
  });

  it("forgets a command record that outlived its age bound, without touching workers", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now, maxAgeMs: 1000 });
    registry.noteWorker("/projects/alpha", 1);
    registry.observeProcessRegistrations("/projects/alpha", [{ pid: 2, role: "helper" }]);
    now += 2000;
    registry.reconcile([observed(1, 999_999)]);
    expect(registry.size()).toBe(1);
  });

  it("turns a project into an opaque id and a sanitized label, never a path", () => {
    const registry = new ProcessOwnershipRegistry();
    const identity = registry.projectIdentity("/home/someone/secret-client/alpha");
    expect(identity.label).toBe("alpha");
    expect(identity.id).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(identity)).not.toContain("secret-client");
    expect(registry.projectIdentity("/home/someone/secret-client/alpha").id).toBe(identity.id);
    expect(registry.projectIdentity("/home/someone/other/alpha").id).not.toBe(identity.id);
  });

  it("accepts only valid typed registrations from a subsystem", () => {
    let now = 1_000_000;
    const registry = new ProcessOwnershipRegistry({}, { now: () => now });
    const accepted = registry.observeProcessRegistrations("/projects/alpha", [
      { pid: 11, role: "background_command", taskId: "task-1", sessionPath: "/sessions/a.jsonl" },
      { pid: 12, role: "host" },
      { pid: 13, role: "background_command", argv: ["--token=s3cret"] },
      "not a registration",
    ]);
    expect(accepted).toBe(1);
    registry.reconcile([observed(11, 999_990)]);
    const record = registry.lookup(11, "linux:boot:999990");
    expect(record?.role).toBe("background_command");
    expect(record?.taskId).toBe("task-1");
  });
});

describe("labels", () => {
  it("keeps a basename and nothing else of a path", () => {
    expect(executableLabel("/opt/Some App/bin/node")).toBe("node");
    expect(executableLabel("C:\\Program Files\\App\\app.exe")).toBe("app.exe");
    expect(executableLabel(undefined)).toBe("unknown");
  });
});
