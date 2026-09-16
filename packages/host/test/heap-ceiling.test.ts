import { describe, expect, it } from "vitest";
import {
  HOST_OLD_SPACE_FLOOR_MIB,
  WORKER_OLD_SPACE_CAP_MIB,
  WORKER_OLD_SPACE_FLOOR_MIB,
  configuredOldSpaceBytes,
  hostOldSpaceMiB,
  oldSpaceMiBFor,
  oldSpaceSizeFlag,
  runtimeMemoryCapacityBytes,
  workerOldSpaceMiB,
} from "../src/heap-ceiling.js";

const MiB = 1024 * 1024;

describe("the final old-space ceilings", () => {
  it("pins the host to the first 64 MiB multiple at or above twice its calibrated peak", () => {
    expect(HOST_OLD_SPACE_FLOOR_MIB).toBe(448);
    expect(hostOldSpaceMiB(16 * 1024 * MiB)).toBe(448);
    expect(oldSpaceSizeFlag(448)).toBe("--max-old-space-size=448");
  });

  it("clamps workers to the calibrated floor and cap on 64 MiB boundaries", () => {
    expect(workerOldSpaceMiB(1728 * MiB)).toBe(WORKER_OLD_SPACE_FLOOR_MIB);
    expect(workerOldSpaceMiB(1800 * MiB)).toBe(1792);
    expect(workerOldSpaceMiB(2300 * MiB)).toBe(WORKER_OLD_SPACE_CAP_MIB);
  });

  it("uses the smaller valid physical and constrained readings", () => {
    expect(runtimeMemoryCapacityBytes(4096 * MiB, 1800 * MiB)).toBe(1800 * MiB);
    expect(runtimeMemoryCapacityBytes(4096 * MiB, 0)).toBe(4096 * MiB);
    expect(runtimeMemoryCapacityBytes(Number.NaN, -1)).toBeUndefined();
  });

  it("uses the floor only for unknown capacity and refuses a known undersized runtime", () => {
    expect(oldSpaceMiBFor("host", undefined)).toBe(448);
    expect(oldSpaceMiBFor("project_worker", undefined)).toBe(1728);
    expect(() => hostOldSpaceMiB(447 * MiB)).toThrow(/needs at least 448 MiB/);
    expect(() => workerOldSpaceMiB(1727 * MiB)).toThrow(/needs at least 1728 MiB/);
  });

  it("reports only a valid explicit flag, with the last spelling effective", () => {
    expect(configuredOldSpaceBytes([])).toBeUndefined();
    expect(configuredOldSpaceBytes(["--max-old-space-size=bad"])).toBeUndefined();
    expect(configuredOldSpaceBytes(["--max-old-space-size=256", "--max-old-space-size", "448"])).toBe(448 * MiB);
    expect(configuredOldSpaceBytes(["--max-old-space-size=448", "--max-old-space-size=0"])).toBeUndefined();
  });
});
