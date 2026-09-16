/**
 * What this worker process costs, read from itself (RP-8).
 *
 * Self only, and cheaply: one virtual file on Linux and two counters V8 keeps
 * anyway. There is no process table here, no `/proc` walk and no import of the
 * host's inventory — the host's collector is demand-driven and walks every
 * process, which is exactly what a worker sampling itself twenty seconds apart
 * must not do.
 *
 * Nothing here decides anything. It reads, or says honestly that it could not:
 * a counter this platform does not expose is `unavailable` with a reason, never
 * a zero, and a level computed from no reading at all is `"unknown"`, never
 * `"normal"`.
 */
import { readFile } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import type { MemoryPressureLevel, MemoryPressureLevelState, MemoryPressureMeasure } from "@lasercode/protocol";

/** One reading of this process. */
export interface PressureSample {
  atMs: number;
  /**
   * Proportional physical pages (Linux `smaps_rollup`). The only physical
   * figure that goes on the wire.
   */
  physical: MemoryPressureMeasure;
  /** V8's live heap, and the limit it is measured against. */
  heapUsed: MemoryPressureMeasure;
  heapLimit: MemoryPressureMeasure;
  /**
   * Private resident and resident set, for a test and for a log line. The
   * pressure wire has no input kind for either, so neither is ever reported:
   * saying "private resident" in a `physical` row would be a different
   * number's name.
   */
  privateResidentBytes?: number;
  residentBytes?: number;
}

export interface PressureThresholds {
  /** Physical bytes (D-261: 1,280 MiB and 1,920 MiB for a project worker). */
  warningBytes: number;
  criticalBytes: number;
  /** Fractions of the heap limit (0.60 / 0.75). */
  heapWarningRatio: number;
  heapCriticalRatio: number;
}

export const WORKER_PRESSURE_THRESHOLDS: PressureThresholds = Object.freeze({
  warningBytes: 1_280 * 1024 * 1024,
  criticalBytes: 1_920 * 1024 * 1024,
  heapWarningRatio: 0.6,
  heapCriticalRatio: 0.75,
});

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

export interface SamplerIo {
  platform?: NodeJS.Platform;
  readSmapsRollup?: () => Promise<string>;
  memoryUsage?: () => NodeJS.MemoryUsage;
  heapStatistics?: () => { used_heap_size: number; heap_size_limit: number };
  now?: () => number;
}

/**
 * Read this process once.
 *
 * Never throws: a platform without the file, a permission this process does
 * not have, a line that does not parse and a counter that is not an exact
 * integer all become the same honest absence.
 */
export function createPressureSampler(io: SamplerIo = {}): () => Promise<PressureSample> {
  const platform = io.platform ?? process.platform;
  const readRollup = io.readSmapsRollup ?? (() => readFile("/proc/self/smaps_rollup", "utf8"));
  const memoryUsage = io.memoryUsage ?? (() => process.memoryUsage());
  const heapStatistics = io.heapStatistics ?? (() => getHeapStatistics());
  const now = io.now ?? Date.now;

  return async () => {
    let physical: MemoryPressureMeasure = unavailable("unsupported_platform");
    let privateResidentBytes: number | undefined;
    if (platform === "linux") {
      try {
        const rollup = await readRollup();
        const pss = kb(rollup, "Pss");
        const clean = kb(rollup, "Private_Clean");
        const dirty = kb(rollup, "Private_Dirty");
        physical = available(pss);
        if (clean !== undefined || dirty !== undefined) privateResidentBytes = (clean ?? 0) + (dirty ?? 0);
      } catch {
        physical = unavailable("collector_failed");
      }
    }
    let heapUsed: MemoryPressureMeasure = unavailable("collector_failed");
    let heapLimit: MemoryPressureMeasure = unavailable("collector_failed");
    let residentBytes: number | undefined;
    try {
      const statistics = heapStatistics();
      heapUsed = available(statistics.used_heap_size);
      heapLimit = available(statistics.heap_size_limit);
    } catch {
      // Left unavailable: a heap we cannot read is not a heap of zero.
    }
    try {
      residentBytes = memoryUsage().rss;
    } catch {
      residentBytes = undefined;
    }
    return {
      atMs: now(),
      physical,
      heapUsed,
      heapLimit,
      ...(privateResidentBytes !== undefined ? { privateResidentBytes } : {}),
      ...(residentBytes !== undefined ? { residentBytes } : {}),
    };
  };
}

/** The thresholds a heap reading is compared against, in bytes. */
export function heapThresholds(
  limit: MemoryPressureMeasure,
  thresholds: PressureThresholds,
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

function levelOf(value: number, warningBytes: number, criticalBytes: number): MemoryPressureLevel {
  if (value >= criticalBytes) return "critical";
  if (value >= warningBytes) return "warning";
  return "normal";
}

export const LEVEL_SEVERITY: Record<MemoryPressureLevelState, number> = { normal: 0, warning: 1, critical: 2, unknown: -1 };

/** One usable reading: a value with the pair it is judged against. */
export interface UsableInput {
  kind: "physical" | "heap";
  value: number;
  warningBytes: number;
  criticalBytes: number;
  level: MemoryPressureLevel;
}

/** What a sample says, and what it could not say. */
export interface PressureReading {
  level: MemoryPressureLevelState;
  usable: UsableInput[];
  /** True when at least one counter was read, whether or not it could be judged. */
  anyAvailable: boolean;
}

export function readingOf(sample: PressureSample, thresholds: PressureThresholds): PressureReading {
  const usable: UsableInput[] = [];
  if (sample.physical.status === "available") {
    usable.push({
      kind: "physical",
      value: sample.physical.value,
      warningBytes: thresholds.warningBytes,
      criticalBytes: thresholds.criticalBytes,
      level: levelOf(sample.physical.value, thresholds.warningBytes, thresholds.criticalBytes),
    });
  }
  const heap = heapThresholds(sample.heapLimit, thresholds);
  if (sample.heapUsed.status === "available" && heap) {
    usable.push({
      kind: "heap",
      value: sample.heapUsed.value,
      ...heap,
      level: levelOf(sample.heapUsed.value, heap.warningBytes, heap.criticalBytes),
    });
  }
  const anyAvailable = sample.physical.status === "available" || sample.heapUsed.status === "available";
  if (usable.length === 0) return { level: "unknown", usable, anyAvailable };
  let level: MemoryPressureLevel = "normal";
  for (const input of usable) if (LEVEL_SEVERITY[input.level] > LEVEL_SEVERITY[level]) level = input.level;
  return { level, usable, anyAvailable };
}

/**
 * Is every usable reading back under the line it crossed?
 *
 * The release line is `0.85 ×` the entry threshold of the level being left, so
 * a value hovering on a threshold cannot flap between two levels.
 */
export function belowRelease(reading: PressureReading, leaving: MemoryPressureLevel, factor = 0.85): boolean {
  if (reading.usable.length === 0) return false;
  return reading.usable.every((input) => {
    const entry = leaving === "critical" ? input.criticalBytes : input.warningBytes;
    return input.value < entry * factor;
  });
}
