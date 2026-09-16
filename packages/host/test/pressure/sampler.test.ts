/**
 * What the host can read about itself, and what it says when it cannot (RP-8).
 *
 * The load-bearing claims here are the honest ones: a counter this platform does
 * not expose is `unavailable` with a reason rather than a zero, a level derived
 * from nothing at all is `unknown` rather than `normal`, and a heap alone is
 * enough to decide a level on a platform with no proportional pages — which is
 * what makes the host useful outside Linux instead of merely truthful.
 */
import { describe, expect, it } from "vitest";
import {
  HOST_PRESSURE_THRESHOLDS,
  MACHINE_PRESSURE_THRESHOLDS,
  belowRelease,
  createHostPressureSampler,
  heapThresholds,
  hostReadingOf,
  machineReadingOf,
  probeOf,
  type HostPressureSample,
} from "../../src/pressure/index.js";

const MiB = 1024 * 1024;

const rollup = (pssKb: number): string =>
  [`Rss:${" ".repeat(15)}${pssKb * 2} kB`, `Pss:${" ".repeat(15)}${pssKb} kB`, `Private_Clean:     ${pssKb / 2} kB`, `Private_Dirty:     ${pssKb / 2} kB`, ""].join("\n");

const meminfo = (availableKb: number): string =>
  [`MemTotal:       16000000 kB`, `MemFree:         1000000 kB`, `MemAvailable:    ${availableKb} kB`, ""].join("\n");

const sampleOf = (over: Partial<HostPressureSample> = {}): HostPressureSample => ({
  atMs: 1_000,
  physical: { status: "available", value: 100 * MiB },
  heapUsed: { status: "available", value: 100 * MiB },
  heapLimit: { status: "available", value: 1_000 * MiB },
  machineAvailable: { status: "available", value: 8_000 * MiB },
  ...over,
});

describe("the host sampler", () => {
  it("reads proportional pages, the heap and the machine on Linux", async () => {
    const sample = await createHostPressureSampler({
      platform: "linux",
      readSmapsRollup: async () => rollup(600 * 1024),
      readMemInfo: async () => meminfo(3_000 * 1024),
      heapStatistics: () => ({ used_heap_size: 40 * MiB, heap_size_limit: 2_048 * MiB }),
      now: () => 7,
    })();
    expect(sample).toMatchObject({
      atMs: 7,
      physical: { status: "available", value: 600 * MiB },
      heapUsed: { status: "available", value: 40 * MiB },
      heapLimit: { status: "available", value: 2_048 * MiB },
      machineAvailable: { status: "available", value: 3_000 * MiB },
      privateResidentBytes: 600 * MiB,
    });
  });

  it("says unsupported rather than zero off Linux, and still reads the heap", async () => {
    const sample = await createHostPressureSampler({
      platform: "darwin",
      heapStatistics: () => ({ used_heap_size: 5, heap_size_limit: 100 }),
    })();
    expect(sample.physical).toEqual({ status: "unavailable", reason: "unsupported_platform" });
    expect(sample.machineAvailable).toEqual({ status: "unavailable", reason: "unsupported_platform" });
    expect(sample.heapUsed).toEqual({ status: "available", value: 5 });
  });

  it("never throws, whatever the machine does to it", async () => {
    const sample = await createHostPressureSampler({
      platform: "linux",
      readSmapsRollup: async () => {
        throw new Error("EACCES");
      },
      readMemInfo: async () => "nothing that parses",
      heapStatistics: () => {
        throw new Error("no heap");
      },
    })();
    expect(sample.physical).toEqual({ status: "unavailable", reason: "collector_failed" });
    expect(sample.machineAvailable).toEqual({ status: "unavailable", reason: "collector_failed" });
    expect(sample.heapUsed).toEqual({ status: "unavailable", reason: "collector_failed" });
    expect(sample.heapLimit).toEqual({ status: "unavailable", reason: "collector_failed" });
  });
});

describe("what a sample means", () => {
  it("uses D-261's own numbers for the host", () => {
    expect(HOST_PRESSURE_THRESHOLDS.warningBytes).toBe(512 * MiB);
    expect(HOST_PRESSURE_THRESHOLDS.criticalBytes).toBe(768 * MiB);
    expect(MACHINE_PRESSURE_THRESHOLDS.warningBytes).toBe(2_048 * MiB);
    expect(MACHINE_PRESSURE_THRESHOLDS.criticalBytes).toBe(1_024 * MiB);
  });

  it("takes the worst reading it could actually take", () => {
    const physicalWarning = hostReadingOf(sampleOf({ physical: { status: "available", value: 600 * MiB } }), HOST_PRESSURE_THRESHOLDS);
    expect(physicalWarning.level).toBe("warning");
    const heapCritical = hostReadingOf(
      sampleOf({ heapUsed: { status: "available", value: 800 * MiB }, heapLimit: { status: "available", value: 1_000 * MiB } }),
      HOST_PRESSURE_THRESHOLDS,
    );
    expect(heapCritical.level).toBe("critical");
  });

  it("is unknown only when no input is usable", () => {
    const blind = hostReadingOf(
      sampleOf({
        physical: { status: "unavailable", reason: "unsupported_platform" },
        heapUsed: { status: "unavailable", reason: "collector_failed" },
        heapLimit: { status: "unavailable", reason: "collector_failed" },
      }),
      HOST_PRESSURE_THRESHOLDS,
    );
    expect(blind.level).toBe("unknown");
    // A heap alone is a reading, on a platform with no proportional pages.
    const heapOnly = hostReadingOf(
      sampleOf({
        physical: { status: "unavailable", reason: "unsupported_platform" },
        heapUsed: { status: "available", value: 760 * MiB },
        heapLimit: { status: "available", value: 1_000 * MiB },
      }),
      HOST_PRESSURE_THRESHOLDS,
    );
    expect(heapOnly.level).toBe("critical");
    expect(heapOnly.usable).toHaveLength(1);
  });

  it("has no usable heap pair when the limit cannot be read", () => {
    expect(heapThresholds({ status: "unavailable", reason: "collector_failed" }, HOST_PRESSURE_THRESHOLDS)).toBeUndefined();
    // A limit small enough for the pair to collapse tells us nothing anyway.
    expect(heapThresholds({ status: "available", value: 1 }, HOST_PRESSURE_THRESHOLDS)).toBeUndefined();
    expect(heapThresholds({ status: "available", value: 1_000 * MiB }, HOST_PRESSURE_THRESHOLDS)).toEqual({
      warningBytes: Math.floor(1_000 * MiB * 0.6),
      criticalBytes: Math.floor(1_000 * MiB * 0.75),
    });
  });

  it("reads the machine the way it actually moves: down", () => {
    expect(machineReadingOf(sampleOf({ machineAvailable: { status: "available", value: 8_000 * MiB } }), MACHINE_PRESSURE_THRESHOLDS).level).toBe("normal");
    expect(machineReadingOf(sampleOf({ machineAvailable: { status: "available", value: 1_500 * MiB } }), MACHINE_PRESSURE_THRESHOLDS).level).toBe("warning");
    expect(machineReadingOf(sampleOf({ machineAvailable: { status: "available", value: 900 * MiB } }), MACHINE_PRESSURE_THRESHOLDS).level).toBe("critical");
    expect(machineReadingOf(sampleOf({ machineAvailable: { status: "unavailable", reason: "unsupported_platform" } }), MACHINE_PRESSURE_THRESHOLDS).level).toBe("unknown");
  });
});

describe("the probe's level", () => {
  it("is the protocol's aggregate: a known warning beats evidence nobody could read", () => {
    const probe = probeOf(
      sampleOf({
        physical: { status: "unavailable", reason: "unsupported_platform" },
        heapUsed: { status: "available", value: 620 * MiB },
        heapLimit: { status: "available", value: 1_000 * MiB },
        machineAvailable: { status: "unavailable", reason: "unsupported_platform" },
      }),
    );
    expect(probe.host.level).toBe("warning");
    expect(probe.machine.level).toBe("unknown");
    expect(probe.level).toBe("warning");
  });

  it("stays unknown when the only thing known is that nothing is wrong", () => {
    const probe = probeOf(
      sampleOf({
        physical: { status: "unavailable", reason: "unsupported_platform" },
        heapUsed: { status: "available", value: 10 * MiB },
        heapLimit: { status: "available", value: 1_000 * MiB },
        machineAvailable: { status: "unavailable", reason: "unsupported_platform" },
      }),
    );
    expect(probe.host.level).toBe("normal");
    expect(probe.level).toBe("unknown");
  });

  it("is critical when either side of it is", () => {
    expect(probeOf(sampleOf({ machineAvailable: { status: "available", value: 500 * MiB } })).level).toBe("critical");
    expect(probeOf(sampleOf({ physical: { status: "available", value: 900 * MiB } })).level).toBe("critical");
  });
});

describe("the release line", () => {
  it("holds a level until every reading is well inside it, in both directions", () => {
    const leavingWarning = probeOf(sampleOf({ physical: { status: "available", value: 500 * MiB }, heapUsed: { status: "available", value: 10 * MiB } }));
    // 500 MiB is under 512 MiB but not under 0.85 × 512 MiB.
    expect(belowRelease(leavingWarning.host, "warning")).toBe(false);
    const wellUnder = probeOf(sampleOf({ physical: { status: "available", value: 200 * MiB }, heapUsed: { status: "available", value: 10 * MiB } }));
    expect(belowRelease(wellUnder.host, "warning")).toBe(true);
    // A falling number is released by rising well above the line it crossed.
    const machineJustOver = probeOf(sampleOf({ machineAvailable: { status: "available", value: 2_100 * MiB } }));
    expect(belowRelease(machineJustOver.machine, "warning")).toBe(false);
    const machineWellOver = probeOf(sampleOf({ machineAvailable: { status: "available", value: 4_000 * MiB } }));
    expect(belowRelease(machineWellOver.machine, "warning")).toBe(true);
  });

  it("is never satisfied by no reading at all", () => {
    expect(belowRelease({ level: "unknown", usable: [] }, "critical")).toBe(false);
  });
});
