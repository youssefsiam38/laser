/**
 * The shell's half of the process cross-check (RP-1).
 *
 * It reports pids, Electron's own process type and a working set — and nothing
 * else. A test is the cheapest way to keep it that way: the payload is compared
 * field for field, not merely checked for the fields we wanted.
 */
import { describe, expect, it } from "vitest";
import { electronProcessReport, type ElectronAppMetric } from "../src/resource-metrics.js";

const metrics: ElectronAppMetric[] = [
  { pid: 100, type: "Browser", memory: { workingSetSize: 54_000, privateBytes: 1 } },
  { pid: 101, type: "Tab", memory: { workingSetSize: 781_000 } },
  { pid: 102, type: "GPU", memory: { workingSetSize: 69_000 } },
  { pid: 103, type: "Utility" },
];

describe("the Electron metrics report", () => {
  it("carries pid, type and bytes, and nothing a host could mistake for authority", () => {
    const report = electronProcessReport(metrics, { mainPid: 100, now: () => 1_767_690_000_000 });
    expect(report.at).toBe("2026-01-06T09:00:00.000Z");
    expect(report.main).toEqual({ pid: 100 });
    expect(report.processes).toEqual([
      // Electron reports KiB; the host compares bytes with bytes.
      { pid: 100, type: "Browser", workingSetBytes: 54_000 * 1024 },
      { pid: 101, type: "Tab", workingSetBytes: 781_000 * 1024 },
      { pid: 102, type: "GPU", workingSetBytes: 69_000 * 1024 },
      // No memory reading is not a zero.
      { pid: 103, type: "Utility" },
    ]);
    const keys = new Set(report.processes.flatMap((row) => Object.keys(row)));
    expect([...keys].sort()).toEqual(["pid", "type", "workingSetBytes"]);
  });

  it("drops a row it cannot identify rather than guessing at it", () => {
    const report = electronProcessReport(
      [{ type: "Tab", memory: { workingSetSize: 10 } }, { pid: 0, type: "Tab" }, { pid: 7 }],
      { mainPid: 100 },
    );
    expect(report.processes).toEqual([{ pid: 7, type: "Unknown" }]);
  });

  it("bounds how much one report can be", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({ pid: index + 1, type: "Tab" }));
    expect(electronProcessReport(many, { mainPid: 1 }).processes).toHaveLength(256);
  });
});
