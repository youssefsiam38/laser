/**
 * The macOS and Windows collectors, against captured command output.
 *
 * CI runs Linux, so these prove the parsing and the honesty of the resulting
 * rows — which counters are read, which are explicitly unavailable, and that a
 * refusal is never a zero. Live behavior on those platforms remains unproven
 * and is reported as such.
 */
import { describe, expect, it } from "vitest";
import { DarwinProcessCollector, parsePsCommands, parsePsTable, parseVmmapSummary } from "../../src/resources/darwin.js";
import { WindowsProcessCollector, parseCimDate, parseWindowsProcesses } from "../../src/resources/windows.js";
import { parseElapsed, parseHumanSize } from "../../src/resources/platform.js";

const PS_TABLE = [
  "    1     0  12345    05:20:11   0:11.20 Mon Jan  6 09:00:00 2026",
  "  501     1 204800 2-03:20:11  12:01.00 Mon Jan  6 09:01:02 2026",
  "garbage line",
].join("\n");

const PS_COMMANDS = ["    1 /sbin/launchd", "  501 /Applications/Some App.app/Contents/MacOS/Some App"].join("\n");

const VMMAP = [
  "Process:         node [501]",
  "Physical footprint:         412.3M",
  "Physical footprint (peak):  1.2G",
].join("\n");

describe("macOS parsing", () => {
  it("reads the table with a start time that contains spaces", () => {
    const rows = parsePsTable(PS_TABLE);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ pid: 501, ppid: 1, residentBytes: 204800 * 1024, cpuSeconds: 721 });
    expect(rows[1]!.elapsedMs).toBe((2 * 86_400 + 3 * 3600 + 20 * 60 + 11) * 1000);
    expect(rows[1]!.startToken).toBe("ps:Mon Jan 6 09:01:02 2026");
    // An absolute start time, so a claim about that pid can be checked.
    expect(rows[1]!.startedAtMs).toBe(Date.parse("Mon Jan 6 09:01:02 2026"));
  });

  it("keeps only the basename of an executable path", () => {
    const labels = parsePsCommands(PS_COMMANDS);
    expect(labels.get(1)).toBe("launchd");
    expect(labels.get(501)).toBe("Some-App");
  });

  it("reads the physical footprint, which is the figure that means something there", () => {
    expect(parseVmmapSummary(VMMAP)).toEqual({ footprintBytes: 412.3 * 1024 ** 2, peakFootprintBytes: 1.2 * 1024 ** 3 });
    expect(parseVmmapSummary("nothing useful")).toEqual({});
  });

  it("builds honest rows, and a refused vmmap is permission_denied and not zero", async () => {
    const calls: string[][] = [];
    const collector = new DarwinProcessCollector(async (command, args) => {
      calls.push([command, ...args]);
      if (command === "ps" && args[1]?.includes("comm")) return PS_COMMANDS;
      if (command === "ps") return PS_TABLE;
      throw new Error("vmmap: [error] cannot examine process 501");
    });
    const table = await collector.table();
    const metrics = await collector.measure(table.find((row) => row.pid === 501)!);
    expect(metrics.memory.resident).toEqual({ status: "available", value: 204800 * 1024 });
    expect(metrics.memory.privateResident).toMatchObject({ status: "unavailable", reason: "permission_denied" });
    expect(metrics.memory.pss).toMatchObject({ status: "unavailable", reason: "unsupported_platform" });
    expect(metrics.cpu.seconds).toEqual({ status: "available", value: 721 });
    // Never `ps -o args=`: that is the command line.
    expect(calls.flat().some((argument) => argument.includes("args"))).toBe(false);
  });

  it("takes the footprint when vmmap answers", async () => {
    const collector = new DarwinProcessCollector(async (command, args) => {
      if (command === "vmmap") return VMMAP;
      return args[1]?.includes("comm") ? PS_COMMANDS : PS_TABLE;
    });
    const table = await collector.table();
    const metrics = await collector.measure(table.find((row) => row.pid === 501)!);
    expect(metrics.memory.privateResident).toEqual({ status: "available", value: 412.3 * 1024 ** 2 });
    expect(metrics.memory.peakResident).toEqual({ status: "available", value: 1.2 * 1024 ** 3 });
  });
});

const CIM = JSON.stringify({
  processes: [
    {
      ProcessId: 4242,
      ParentProcessId: 10,
      CreationDate: "/Date(1767690000000)/",
      Name: "node.exe",
      WorkingSetSize: 120 * 1024 * 1024,
      // Documented in kilobytes on this class, unlike WorkingSetSize.
      PeakWorkingSetSize: 200 * 1024,
      KernelModeTime: 10_000_000,
      UserModeTime: 20_000_000,
      ReadTransferCount: 1234,
      WriteTransferCount: 5678,
    },
    { ProcessId: 7, CreationDate: "not a date" },
  ],
  perf: [{ IDProcess: 4242, WorkingSetPrivate: 80 * 1024 * 1024, PrivateBytes: 90 * 1024 * 1024 }],
});

describe("Windows parsing", () => {
  it("accepts every creation-date shape the serializer produces", () => {
    expect(parseCimDate("/Date(1767690000000)/")).toBe(1767690000000);
    expect(parseCimDate("20260106090000.000000+060")).toBe(Date.UTC(2026, 0, 6, 9, 0, 0) - 60 * 60_000);
    expect(parseCimDate("2026-01-06T09:00:00.000Z")).toBe(Date.parse("2026-01-06T09:00:00.000Z"));
    expect(parseCimDate("nonsense")).toBeUndefined();
  });

  it("joins both performance counters and drops a row with no provable identity", () => {
    const rows = parseWindowsProcesses(CIM);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 4242,
      ppid: 10,
      label: "node.exe",
      startToken: "cim:1767690000000",
      // Private working set and private commit both come from the performance
      // class, in bytes. `PrivatePageCount` is never treated as bytes.
      privateWorkingSetBytes: 80 * 1024 * 1024,
      commitBytes: 90 * 1024 * 1024,
      peakWorkingSetBytes: 200 * 1024 * 1024,
      cpuSeconds: 3,
    });
  });

  it("ignores PrivatePageCount even when the machine reports one", () => {
    const withPageCount = JSON.stringify({
      ...JSON.parse(CIM),
      processes: [{ ...JSON.parse(CIM).processes[0], PrivatePageCount: 42 }],
      perf: [],
    });
    const rows = parseWindowsProcesses(withPageCount);
    // A page count is not a byte count, and a number whose unit we are
    // guessing at is worse than an honest gap.
    expect(rows[0]!.commitBytes).toBeUndefined();
  });

  it("says permission_denied when the performance counters are missing, never zero", async () => {
    const withoutPerf = JSON.stringify({ ...JSON.parse(CIM), perf: [] });
    const collector = new WindowsProcessCollector(async () => withoutPerf, () => 1767690060000);
    const [row] = await collector.table();
    expect(row!.startedAtMs).toBe(1767690000000);
    const metrics = await collector.measure(row!);
    expect(metrics.memory.privateResident).toMatchObject({ status: "unavailable", reason: "permission_denied" });
    expect(metrics.memory.commit).toMatchObject({ status: "unavailable", reason: "permission_denied" });
    expect(metrics.memory.resident).toEqual({ status: "available", value: 120 * 1024 * 1024 });
    expect(metrics.elapsedMs).toEqual({ status: "available", value: 60_000 });
  });

  it("reads both counters when the performance class answers", async () => {
    const collector = new WindowsProcessCollector(async () => CIM, () => 1767690060000);
    const [row] = await collector.table();
    const metrics = await collector.measure(row!);
    expect(metrics.memory.privateResident).toEqual({ status: "available", value: 80 * 1024 * 1024 });
    expect(metrics.memory.commit).toEqual({ status: "available", value: 90 * 1024 * 1024 });
  });

  it("never asks PowerShell for a command line", async () => {
    let script = "";
    const collector = new WindowsProcessCollector(async (_command, args) => {
      script = args.join(" ");
      return CIM;
    });
    await collector.table();
    expect(script).toContain("Win32_Process");
    expect(script.toLowerCase()).not.toContain("commandline");
  });
});

describe("shared parsing", () => {
  it("reads human sizes and elapsed times, and refuses nonsense", () => {
    expect(parseHumanSize("1.5G")).toBe(1.5 * 1024 ** 3);
    expect(parseHumanSize("900")).toBe(900);
    expect(parseHumanSize("later")).toBeUndefined();
    expect(parseElapsed("01:02")).toBe(62_000);
    expect(parseElapsed("nope")).toBeUndefined();
  });
});
