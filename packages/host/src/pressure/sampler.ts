/**
 * What this host process costs, and what the machine still has (RP-8).
 *
 * Self only, and cheaply: one virtual file for this process, one for the
 * machine, and two counters V8 keeps anyway. There is no process table here and
 * no call into RP-1's inventory — that collector walks every process and is
 * demand-driven, which is exactly what a host sampling itself every twenty
 * seconds must not do.
 *
 * Nothing here decides anything. It reads, or says honestly that it could not:
 * a counter this platform does not expose is `unavailable` with a reason, never
 * a zero, and a level computed from no reading at all is `"unknown"`, never
 * `"normal"`.
 */
import { readFile } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import {
  aggregateMemoryPressureLevel,
  type MemoryPressureInputKind,
  type MemoryPressureLevel,
  type MemoryPressureLevelState,
  type MemoryPressureMeasure,
} from "@lasercode/protocol";
import {
  HOST_PRESSURE_RELEASE_FACTOR,
  HOST_PRESSURE_THRESHOLDS,
  MACHINE_PRESSURE_THRESHOLDS,
  type HostPressureThresholds,
  type MachinePressureThresholds,
} from "./thresholds.js";

/** One reading of this host and of the machine it runs on. */
export interface HostPressureSample {
  atMs: number;
  /** Proportional physical pages (Linux `smaps_rollup`); the wire's `physical`. */
  physical: MemoryPressureMeasure;
  /** V8's live heap, and the limit it is measured against. */
  heapUsed: MemoryPressureMeasure;
  heapLimit: MemoryPressureMeasure;
  /** What the machine reports it could still hand out (Linux `MemAvailable`). */
  machineAvailable: MemoryPressureMeasure;
  /**
   * Private resident pages, for a local before/after observation and for a log
   * line. The pressure wire has no input kind for it, so it never travels:
   * calling it `physical` would be a different number's name.
   */
  privateResidentBytes?: number;
}

export interface HostSamplerIo {
  platform?: NodeJS.Platform;
  readSmapsRollup?: () => Promise<string>;
  readMemInfo?: () => Promise<string>;
  heapStatistics?: () => { used_heap_size: number; heap_size_limit: number };
  now?: () => number;
}

const kb = (text: string, name: string): number | undefined => {
  const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
  if (!match) return undefined;
  const value = Number(match[1]) * 1024;
  return Number.isSafeInteger(value) ? value : undefined;
};

const unavailable = (reason: "unsupported_platform" | "collector_failed"): MemoryPressureMeasure => ({
  status: "unavailable",
  reason,
});

const available = (value: number | undefined): MemoryPressureMeasure =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? { status: "available", value } : unavailable("collector_failed");

/**
 * Read this host once.
 *
 * Never throws: a platform without the files, a permission this process does
 * not have, a line that does not parse and a counter that is not an exact
 * integer all become the same honest absence.
 */
export function createHostPressureSampler(io: HostSamplerIo = {}): () => Promise<HostPressureSample> {
  const platform = io.platform ?? process.platform;
  const readRollup = io.readSmapsRollup ?? (() => readFile("/proc/self/smaps_rollup", "utf8"));
  const readMemInfo = io.readMemInfo ?? (() => readFile("/proc/meminfo", "utf8"));
  const heapStatistics = io.heapStatistics ?? (() => getHeapStatistics());
  const now = io.now ?? Date.now;

  return async () => {
    let physical: MemoryPressureMeasure = unavailable("unsupported_platform");
    let machineAvailable: MemoryPressureMeasure = unavailable("unsupported_platform");
    let privateResidentBytes: number | undefined;
    if (platform === "linux") {
      try {
        const rollup = await readRollup();
        physical = available(kb(rollup, "Pss"));
        const clean = kb(rollup, "Private_Clean");
        const dirty = kb(rollup, "Private_Dirty");
        if (clean !== undefined || dirty !== undefined) privateResidentBytes = (clean ?? 0) + (dirty ?? 0);
      } catch {
        physical = unavailable("collector_failed");
      }
      try {
        machineAvailable = available(kb(await readMemInfo(), "MemAvailable"));
      } catch {
        machineAvailable = unavailable("collector_failed");
      }
    }
    let heapUsed: MemoryPressureMeasure = unavailable("collector_failed");
    let heapLimit: MemoryPressureMeasure = unavailable("collector_failed");
    try {
      const statistics = heapStatistics();
      heapUsed = available(statistics.used_heap_size);
      heapLimit = available(statistics.heap_size_limit);
    } catch {
      // Left unavailable: a heap we cannot read is not a heap of zero.
    }
    return {
      atMs: now(),
      physical,
      heapUsed,
      heapLimit,
      machineAvailable,
      ...(privateResidentBytes !== undefined ? { privateResidentBytes } : {}),
    };
  };
}

/** The thresholds a heap reading is compared against, in bytes. */
export function heapThresholds(
  limit: MemoryPressureMeasure,
  thresholds: HostPressureThresholds,
): { warningBytes: number; criticalBytes: number } | undefined {
  if (limit.status !== "available") return undefined;
  const warningBytes = Math.floor(limit.value * thresholds.heapWarningRatio);
  const criticalBytes = Math.floor(limit.value * thresholds.heapCriticalRatio);
  // Deterministic, exact and ordered, or there is no usable pair: the wire
  // requires `warningBytes < criticalBytes`, and a limit small enough for the
  // two to collapse tells us nothing anyway.
  if (!Number.isSafeInteger(warningBytes) || !Number.isSafeInteger(criticalBytes)) return undefined;
  if (warningBytes <= 0 || warningBytes >= criticalBytes) return undefined;
  return { warningBytes, criticalBytes };
}

export const LEVEL_SEVERITY: Record<MemoryPressureLevelState, number> = { normal: 0, warning: 1, critical: 2, unknown: -1 };

/**
 * One usable reading: a value, the pair it is judged against, and which way it
 * moves. Memory in use grows into trouble; memory still available falls into it.
 */
export interface UsableInput {
  kind: MemoryPressureInputKind;
  value: number;
  warningBytes: number;
  criticalBytes: number;
  level: MemoryPressureLevel;
  falling: boolean;
}

/** What one role's sample says, and what it could not say. */
export interface PressureReading {
  level: MemoryPressureLevelState;
  usable: UsableInput[];
}

function levelOf(value: number, warningBytes: number, criticalBytes: number, falling: boolean): MemoryPressureLevel {
  if (falling) {
    if (value <= criticalBytes) return "critical";
    return value <= warningBytes ? "warning" : "normal";
  }
  if (value >= criticalBytes) return "critical";
  return value >= warningBytes ? "warning" : "normal";
}

function worst(usable: readonly UsableInput[]): PressureReading {
  if (usable.length === 0) return { level: "unknown", usable: [] };
  let level: MemoryPressureLevel = "normal";
  for (const input of usable) if (LEVEL_SEVERITY[input.level] > LEVEL_SEVERITY[level]) level = input.level;
  return { level, usable: [...usable] };
}

/**
 * The host's own reading: the worst of the readings it could actually take.
 *
 * `unknown` only when **no** input is usable. A machine that cannot report PSS
 * still has a heap, and a heap at three quarters of its limit is trouble
 * whether or not this platform exposes proportional pages — which is what makes
 * honest degradation outside Linux useful rather than merely truthful.
 */
export function hostReadingOf(sample: HostPressureSample, thresholds: HostPressureThresholds): PressureReading {
  const usable: UsableInput[] = [];
  if (sample.physical.status === "available") {
    usable.push({
      kind: "physical",
      value: sample.physical.value,
      warningBytes: thresholds.warningBytes,
      criticalBytes: thresholds.criticalBytes,
      falling: false,
      level: levelOf(sample.physical.value, thresholds.warningBytes, thresholds.criticalBytes, false),
    });
  }
  const heap = heapThresholds(sample.heapLimit, thresholds);
  if (sample.heapUsed.status === "available" && heap) {
    usable.push({
      kind: "heap",
      value: sample.heapUsed.value,
      ...heap,
      falling: false,
      level: levelOf(sample.heapUsed.value, heap.warningBytes, heap.criticalBytes, false),
    });
  }
  return worst(usable);
}

/** The machine's reading: one falling number, or nothing. */
export function machineReadingOf(sample: HostPressureSample, thresholds: MachinePressureThresholds): PressureReading {
  if (sample.machineAvailable.status !== "available") return { level: "unknown", usable: [] };
  const value = sample.machineAvailable.value;
  return worst([
    {
      kind: "machine_available",
      value,
      warningBytes: thresholds.warningBytes,
      criticalBytes: thresholds.criticalBytes,
      falling: true,
      level: levelOf(value, thresholds.warningBytes, thresholds.criticalBytes, true),
    },
  ]);
}

/** One probe: this host, this machine, and the level the two of them decide. */
export interface HostPressureProbe {
  sample: HostPressureSample;
  host: PressureReading;
  machine: PressureReading;
  /** `aggregateMemoryPressureLevel([host, machine])`: critical, then warning, then unknown, then normal. */
  level: MemoryPressureLevelState;
}

export function probeOf(
  sample: HostPressureSample,
  host: HostPressureThresholds = HOST_PRESSURE_THRESHOLDS,
  machine: MachinePressureThresholds = MACHINE_PRESSURE_THRESHOLDS,
): HostPressureProbe {
  const hostReading = hostReadingOf(sample, host);
  const machineReading = machineReadingOf(sample, machine);
  return {
    sample,
    host: hostReading,
    machine: machineReading,
    // The protocol's own rule, not a second opinion beside it: a known warning
    // or critical wins over evidence nobody could read, while a known `normal`
    // beside an `unknown` stays `unknown` and authorizes nothing.
    level: aggregateMemoryPressureLevel([hostReading.level, machineReading.level]),
  };
}

/**
 * Is every usable reading back inside the line it crossed?
 *
 * The release line is `0.85 ×` the entry threshold of the level being left for a
 * number that grows, and `entry / 0.85` for one that falls, so a value hovering
 * on a threshold cannot flap between two levels.
 */
export function belowRelease(
  reading: PressureReading,
  leaving: MemoryPressureLevel,
  factor = HOST_PRESSURE_RELEASE_FACTOR,
): boolean {
  if (reading.usable.length === 0) return false;
  return reading.usable.every((input) => {
    const entry = leaving === "critical" ? input.criticalBytes : input.warningBytes;
    return input.falling ? input.value > entry / factor : input.value < entry * factor;
  });
}

/** What a sample looks like when there was none: nothing, said out loud. */
export function blindSample(atMs: number): HostPressureSample {
  const reason = "collector_failed" as const;
  return {
    atMs: Number.isSafeInteger(atMs) && atMs >= 0 ? atMs : 0,
    physical: { status: "unavailable", reason },
    heapUsed: { status: "unavailable", reason },
    heapLimit: { status: "unavailable", reason },
    machineAvailable: { status: "unavailable", reason },
  };
}
