import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxProcessCollector } from "../../src/resources/linux.js";
import { ResourceService } from "../../src/resources/service.js";
import { FIXTURE_BOOT_TIME_SECONDS, FIXTURE_UPTIME_SECONDS, writeProcFixture } from "./proc-fixture.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-proc-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the Linux collector", () => {
  it("reads the counters RP-1 asks for and reconciles totals with smaps_rollup", async () => {
    writeProcFixture(root, [
      { pid: 10, ppid: 1, comm: "node", exe: "/usr/bin/node", startTicks: 500, utimeTicks: 150, stimeTicks: 50, pssKb: 1024, rssKb: 2048, privateCleanKb: 256, privateDirtyKb: 512, hwmKb: 4096, readBytes: 111, writeBytes: 222 },
      { pid: 11, ppid: 10, comm: "sh", startTicks: 800, pssKb: 64, rssKb: 128, privateCleanKb: 8, privateDirtyKb: 16, hwmKb: 200 },
    ]);
    const collector = new LinuxProcessCollector({ procRoot: root });
    const table = await collector.table();
    expect(table.map((row) => row.pid).sort()).toEqual([10, 11]);

    const parent = table.find((row) => row.pid === 10)!;
    expect(parent.ppid).toBe(1);
    expect(parent.label).toBe("node");
    // An absolute start time, from `btime` plus the process's start ticks:
    // this is what an outside claim about a pid is checked against.
    expect(parent.startedAtMs).toBe((FIXTURE_BOOT_TIME_SECONDS + 5) * 1000);
    const metrics = await collector.measure(parent);

    // The same numbers a person would read out of the fixture's own files.
    const rollup = readFileSync(join(root, "10", "smaps_rollup"), "utf8");
    const pssKb = Number(/Pss:\s+(\d+) kB/.exec(rollup)![1]);
    expect(metrics.memory.pss).toEqual({ status: "available", value: pssKb * 1024 });
    expect(metrics.memory.resident).toEqual({ status: "available", value: 2048 * 1024 });
    expect(metrics.memory.peakResident).toEqual({ status: "available", value: 4096 * 1024 });
    // Private clean + private dirty, the pages nobody else holds.
    expect(metrics.memory.privateResident).toEqual({ status: "available", value: (256 + 512) * 1024 });
    expect(metrics.cpu.seconds).toEqual({ status: "available", value: 2 });
    expect(metrics.elapsedMs).toEqual({ status: "available", value: (FIXTURE_UPTIME_SECONDS - 5) * 1000 });
    expect(metrics.io.readBytes).toEqual({ status: "available", value: 111 });
    expect(metrics.io.writeBytes).toEqual({ status: "available", value: 222 });
    // A Windows counter is not zero here; it does not exist here.
    expect(metrics.memory.commit.status).toBe("unavailable");
  });

  it("says permission_denied rather than zero when the kernel refuses a counter", async () => {
    writeProcFixture(root, [{ pid: 10, ppid: 1, comm: "node", startTicks: 100, rollupUnreadable: true, ioUnreadable: true, rssKb: 2048, hwmKb: 3000 }]);
    const collector = new LinuxProcessCollector({ procRoot: root });
    const [row] = await collector.table();
    const metrics = await collector.measure(row!);
    expect(metrics.memory.pss).toMatchObject({ status: "unavailable", reason: "permission_denied" });
    expect(metrics.memory.privateResident).toMatchObject({ status: "unavailable", reason: "permission_denied" });
    expect(metrics.io.readBytes).toMatchObject({ status: "unavailable", reason: "permission_denied" });
    // `status` still answers, so the row is not blank.
    expect(metrics.memory.resident).toEqual({ status: "available", value: 2048 * 1024 });
  });

  it("refuses to measure a pid that was reused between the table and the read", async () => {
    writeProcFixture(root, [{ pid: 10, ppid: 1, comm: "node", startTicks: 100, pssKb: 10 }]);
    const collector = new LinuxProcessCollector({ procRoot: root });
    const [row] = await collector.table();
    // The number is the same; the process behind it is not.
    writeProcFixture(root, [{ pid: 10, ppid: 1, comm: "someone-else", startTicks: 999, pssKb: 9999 }]);
    const metrics = await collector.measure(row!);
    expect(metrics.memory.pss).toMatchObject({ status: "unavailable", reason: "process_gone" });
  });

  it("never opens cmdline or environ", async () => {
    writeProcFixture(root, [
      { pid: 10, ppid: 1, comm: "node", startTicks: 100, pssKb: 10, cmdline: "node\0--token=s3cret\0", environ: "SECRET=s3cret\0" },
    ]);
    const opened: string[] = [];
    const collector = new LinuxProcessCollector({
      procRoot: root,
      readFile: async (path) => {
        opened.push(path);
        return readFile(path, "utf8");
      },
    });
    const table = await collector.table();
    await collector.measure(table[0]!);
    expect(opened.some((path) => path.endsWith("/cmdline") || path.endsWith("/environ"))).toBe(false);
    expect(opened.some((path) => path.endsWith("/smaps_rollup"))).toBe(true);
  });

  it("reconciles a whole snapshot's total with the tree's own smaps_rollup figures", async () => {
    writeProcFixture(root, [
      { pid: 10, ppid: 1, comm: "node", startTicks: 100, pssKb: 165_000, rssKb: 200_000, privateCleanKb: 1, privateDirtyKb: 2, hwmKb: 210_000 },
      { pid: 11, ppid: 10, comm: "node", startTicks: 200, pssKb: 399_000, rssKb: 500_000, privateCleanKb: 1, privateDirtyKb: 2, hwmKb: 520_000 },
      { pid: 12, ppid: 11, comm: "bash", startTicks: 300, pssKb: 3_000, rssKb: 9_000, privateCleanKb: 1, privateDirtyKb: 2, hwmKb: 9_500 },
      { pid: 99, ppid: 1, comm: "unrelated", startTicks: 400, pssKb: 999_999, rssKb: 999_999 },
    ]);
    const resources = new ResourceService({ platform: "linux", hostPid: 10, procRoot: root });
    const { snapshot } = await resources.snapshot();

    // Read the fixture's own rollups back, exactly as a person would.
    const expected = [10, 11, 12]
      .map((pid) => Number(/Pss:\s+(\d+) kB/.exec(readFileSync(join(root, String(pid), "smaps_rollup"), "utf8"))![1]) * 1024)
      .reduce((total, value) => total + value, 0);
    expect(snapshot.totals.coverage).toEqual({ processes: 3, measured: 3, complete: true });
    expect(snapshot.totals.physical).toEqual({ status: "available", value: expected });
    // Summed RSS is larger, is reported separately, and is never the total.
    expect(snapshot.totals.knownResidentBytes).toBeGreaterThan(expected);
    // A program that is nobody's descendant is not in the inventory at all.
    expect(snapshot.processes.some((row) => row.pid === 99)).toBe(false);
  });

  it("keeps the host's event loop responsive while it walks every process on this machine", async ({ skip }) => {
    if (process.platform !== "linux") return skip();
    // A synchronous traversal of /proc would stall every timer in the host for
    // as long as it took. This measures that it does not.
    const gaps: number[] = [];
    let previous = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      gaps.push(now - previous);
      previous = now;
    }, 5);
    try {
      const resources = new ResourceService({ hostPid: process.pid, minIntervalMs: 0 });
      const { snapshot } = await resources.snapshot();
      expect(snapshot.processes.length).toBeGreaterThan(0);
    } finally {
      clearInterval(ticker);
    }
    expect(gaps.length).toBeGreaterThan(2);
    expect(Math.max(...gaps)).toBeLessThan(250);
  });

  it("agrees with the kernel for a real process on this machine", async ({ skip }) => {
    if (process.platform !== "linux") return skip();
    const collector = new LinuxProcessCollector();
    const table = await collector.table();
    const self = table.find((row) => row.pid === process.pid);
    expect(self).toBeDefined();
    const metrics = await collector.measure(self!);
    if (metrics.memory.pss.status !== "available") return skip(); // smaps_rollup is a kernel option
    const rollup = readFileSync(`/proc/${process.pid}/smaps_rollup`, "utf8");
    const kernelPss = Number(/Pss:\s+(\d+) kB/.exec(rollup)![1]) * 1024;
    // The process keeps allocating between the two reads; agreement within a
    // few percent is what "the same number" means for a live process.
    const drift = Math.abs(metrics.memory.pss.value - kernelPss) / kernelPss;
    expect(drift).toBeLessThan(0.1);
  });
});
