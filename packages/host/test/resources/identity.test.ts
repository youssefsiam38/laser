import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ancestorChain, commFromStat, executableLabel, ppidFromStat, processKey, processStartToken, startTicksFromStat } from "../../src/resources/identity.js";
import { ProcessOwnershipRegistry } from "../../src/resources/ownership.js";
import { FIXTURE_BOOT_ID, writeProcFixture } from "./proc-fixture.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-identity-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parsing /proc/<pid>/stat", () => {
  it("survives an executable name with spaces and parentheses", () => {
    const stat = "42 (my (weird) name) S 7 0 0 0 0 0 0 0 0 0 11 22 0 0 0 0 0 0 4242 0 0";
    expect(commFromStat(stat)).toBe("my (weird) name");
    expect(ppidFromStat(stat)).toBe(7);
    expect(startTicksFromStat(stat)).toBe("4242");
  });

  it("has no token for a process it cannot describe", () => {
    expect(startTicksFromStat("nonsense")).toBeUndefined();
    expect(processStartToken(-1, { platform: "linux", procRoot: root })).toBeUndefined();
  });
});

describe("process identity", () => {
  it("is the boot id and the start time, not the pid", () => {
    writeProcFixture(root, [{ pid: 10, ppid: 1, comm: "node", startTicks: 777 }]);
    const token = processStartToken(10, { platform: "linux", procRoot: root });
    expect(token).toBe(`linux:${FIXTURE_BOOT_ID}:777`);
    expect(processKey(10, token!)).toBe(`10@linux:${FIXTURE_BOOT_ID}:777`);
  });

  it("walks the ancestors it can prove and stops where it cannot", () => {
    writeProcFixture(root, [
      { pid: 30, ppid: 20, comm: "node", startTicks: 300 },
      { pid: 20, ppid: 10, comm: "electron", startTicks: 200 },
      { pid: 10, ppid: 1, comm: "systemd", startTicks: 100 },
    ]);
    const chain = ancestorChain(30, { platform: "linux", procRoot: root });
    expect(chain.map((entry) => entry.pid)).toEqual([20, 10]);
    expect(chain[0]!.startToken).toBe(`linux:${FIXTURE_BOOT_ID}:200`);
  });
});

describe("ownership records and pid reuse", () => {
  const io = () => ({ platform: "linux" as const, procRoot: root });

  it("attaches nothing to a pid that has become a different process", () => {
    writeProcFixture(root, [{ pid: 10, ppid: 1, comm: "node", startTicks: 500 }]);
    const registry = new ProcessOwnershipRegistry(io());
    registry.noteWorker("/projects/alpha", 10);
    const recorded = processStartToken(10, io())!;
    expect(registry.lookup(10, recorded)?.role).toBe("project_worker");

    // The worker exits and the kernel hands 10 to somebody else.
    writeProcFixture(root, [{ pid: 10, ppid: 1, comm: "vim", startTicks: 900 }]);
    const reused = processStartToken(10, io())!;
    expect(reused).not.toBe(recorded);
    expect(registry.lookup(10, reused)).toBeUndefined();
    // And the old identity does not come back either: the record is for that
    // process, and that process is gone.
    expect(registry.lookup(10, recorded)?.role).toBe("project_worker");
  });

  it("applies no record when the platform could not prove an identity at spawn", () => {
    const registry = new ProcessOwnershipRegistry({ platform: "linux", procRoot: join(root, "missing") });
    registry.noteWorker("/projects/alpha", 10);
    expect(registry.lookup(10, "linux:whatever:1")).toBeUndefined();
  });

  it("forgets a record on exit, so the next owner of the pid inherits nothing", () => {
    writeProcFixture(root, [{ pid: 10, ppid: 1, comm: "node", startTicks: 500 }]);
    const registry = new ProcessOwnershipRegistry(io());
    registry.noteWorker("/projects/alpha", 10);
    registry.noteExit(10);
    expect(registry.lookup(10, processStartToken(10, io())!)).toBeUndefined();
  });

  it("turns a project into an opaque id and a sanitized label, never a path", () => {
    const registry = new ProcessOwnershipRegistry(io());
    const identity = registry.projectIdentity("/home/someone/secret-client/alpha");
    expect(identity.label).toBe("alpha");
    expect(identity.id).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(identity)).not.toContain("secret-client");
    // Stable within one host run, so rows can be compared across snapshots.
    expect(registry.projectIdentity("/home/someone/secret-client/alpha").id).toBe(identity.id);
    // And different per directory.
    expect(registry.projectIdentity("/home/someone/other/alpha").id).not.toBe(identity.id);
  });

  it("accepts only valid typed registrations from a subsystem", () => {
    writeProcFixture(root, [{ pid: 11, ppid: 10, comm: "bash", startTicks: 600 }]);
    const registry = new ProcessOwnershipRegistry(io());
    const accepted = registry.observeProcessRegistrations("/projects/alpha", [
      { pid: 11, role: "background_command", taskId: "task-1", sessionPath: "/sessions/a.jsonl" },
      { pid: 12, role: "host" },
      { pid: 13, role: "background_command", argv: ["--token=s3cret"] },
      "not a registration",
    ]);
    expect(accepted).toBe(1);
    const record = registry.lookup(11, processStartToken(11, io())!);
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
