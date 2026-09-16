/**
 * What "under pressure" means for the window a person is looking at (RP-8, D-265).
 *
 * The renderer is one of the three processes that answer for their own memory,
 * and this is the arithmetic it answers with: the two numbers it can honestly
 * read about itself, the lines they are judged against, and the hysteresis that
 * keeps a value hovering on a threshold from flapping.
 *
 * Every constant here is *restated*, not imported: the UI may not import
 * `@lasercode/worker`, and the worker's controller is where these values were
 * settled (`packages/worker/src/pressure.ts`, `pressure-sampler.ts`). The
 * physical pair is D-261's renderer pair, the heap ratios and every cadence,
 * streak and cooldown are the worker's own, by value.
 *
 * Two rules are structural rather than stylistic, and the rest of this folder
 * depends on them:
 *
 * - **Missing evidence is `unknown`.** A level nobody could read is never
 *   `normal`, never a zero, and authorizes nothing — not a release, not a
 *   refusal.
 * - **A number is only ever called what it is.** The window can read its own
 *   *private resident* memory (the shell's bridge) and its own *JS heap*. It
 *   cannot read PSS, and nothing here presents heap, working set or resident
 *   set as a physical figure (`worker/src/pressure-sampler.ts:30-38`).
 */
import {
  type MemoryPressureDirectiveLevel,
  type MemoryPressureInput,
  type MemoryPressureLevel,
  type MemoryPressureLevelState,
  type MemoryPressureMeasure,
} from "@lasercode/protocol";

/** The lines this window is judged against. */
export interface RendererPressureThresholds {
  /** Physical bytes: D-261's renderer pair, 1280 MiB and 1920 MiB. */
  warningBytes: number;
  criticalBytes: number;
  /** Fractions of the heap limit (0.60 / 0.75), as the worker uses them. */
  heapWarningRatio: number;
  heapCriticalRatio: number;
}

export const RENDERER_PRESSURE_THRESHOLDS: RendererPressureThresholds = Object.freeze({
  warningBytes: 1_280 * 1024 * 1024,
  criticalBytes: 1_920 * 1024 * 1024,
  heapWarningRatio: 0.6,
  heapCriticalRatio: 0.75,
});

/** How often this window looks at itself. */
export const PRESSURE_NORMAL_INTERVAL_MS = 20_000;
export const PRESSURE_ELEVATED_INTERVAL_MS = 5_000;
/** A sample older than this many cadences is not evidence any more. */
export const PRESSURE_STALE_CADENCES = 3;
/** Samples that must agree before the level changes. */
export const PRESSURE_ESCALATE_SAMPLES = 2;
export const PRESSURE_RELEASE_SAMPLES = 3;
/** How far below the line it entered at a reading must fall to leave a level. */
export const PRESSURE_RELEASE_FACTOR = 0.85;
/** The shortest gap between two passes this window runs. */
export const PRESSURE_WARNING_COOLDOWN_MS = 30_000;
export const PRESSURE_CRITICAL_COOLDOWN_MS = 10_000;
/** After a pass that had nothing to give, it waits longer before trying again. */
export const PRESSURE_QUIET_COOLDOWN_MS = 60_000;
/** At most one refusal row per kind per window: a loop must not fill the record. */
export const PRESSURE_REFUSAL_WINDOW_MS = 5_000;
/** Rows this window keeps about its own passes, and for how long. */
export const RENDERER_PRESSURE_ROWS_MAX = 50;
export const RENDERER_PRESSURE_ROW_MAX_AGE_MS = 60 * 60_000;

export const LEVEL_SEVERITY: Record<MemoryPressureLevelState, number> = { normal: 0, warning: 1, critical: 2, unknown: -1 };

export const isDirectiveLevel = (level: MemoryPressureLevelState): level is MemoryPressureDirectiveLevel =>
  level === "warning" || level === "critical";

/** The worse of two states, with `unknown` never passing for calm. */
export const worseLevel = (left: MemoryPressureLevelState, right: MemoryPressureLevelState): MemoryPressureLevelState => {
  if (left === "critical" || right === "critical") return "critical";
  if (left === "warning" || right === "warning") return "warning";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "normal";
};

/** One reading of this window: the two measures, and when they were taken. */
export interface RendererPressureSample {
  atMs: number;
  /** Private resident memory of this window's process. Never PSS, never heap. */
  physical: MemoryPressureMeasure;
  heapUsed: MemoryPressureMeasure;
  heapLimit: MemoryPressureMeasure;
}

/** One usable reading: a value with the pair it is judged against. */
export interface UsableInput {
  kind: "physical" | "heap";
  value: number;
  warningBytes: number;
  criticalBytes: number;
  level: MemoryPressureLevel;
}

export interface RendererPressureReading {
  level: MemoryPressureLevelState;
  usable: UsableInput[];
}

/** The thresholds a heap reading is compared against, in bytes, or none. */
export function heapThresholds(
  limit: MemoryPressureMeasure,
  thresholds: RendererPressureThresholds,
): { warningBytes: number; criticalBytes: number } | undefined {
  if (limit.status !== "available") return undefined;
  const warningBytes = Math.floor(limit.value * thresholds.heapWarningRatio);
  const criticalBytes = Math.floor(limit.value * thresholds.heapCriticalRatio);
  // Exact, ordered, or there is no usable pair: the wire requires
  // `warningBytes < criticalBytes`, and a limit small enough for the two to
  // collapse tells us nothing anyway.
  if (!Number.isSafeInteger(warningBytes) || !Number.isSafeInteger(criticalBytes)) return undefined;
  if (warningBytes <= 0 || warningBytes >= criticalBytes) return undefined;
  return { warningBytes, criticalBytes };
}

const levelOf = (value: number, warningBytes: number, criticalBytes: number): MemoryPressureLevel => {
  if (value >= criticalBytes) return "critical";
  if (value >= warningBytes) return "warning";
  return "normal";
};

/**
 * What one sample says.
 *
 * The level is the worst **usable** input, where usable means the measure was
 * read *and* there is a pair to judge it by. `unknown` exactly when none was —
 * so a browser that can read only its heap still decides a level from it, and
 * a browser that can read neither decides nothing.
 */
export function readingOf(sample: RendererPressureSample, thresholds: RendererPressureThresholds): RendererPressureReading {
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
  if (usable.length === 0) return { level: "unknown", usable };
  let level: MemoryPressureLevel = "normal";
  for (const input of usable) if (LEVEL_SEVERITY[input.level] > LEVEL_SEVERITY[level]) level = input.level;
  return { level, usable };
}

/** Has every usable reading fallen far enough below the line it entered at? */
export function belowRelease(
  reading: RendererPressureReading,
  leaving: MemoryPressureLevel,
  factor = PRESSURE_RELEASE_FACTOR,
): boolean {
  if (reading.usable.length === 0) return false;
  return reading.usable.every((input) => {
    const entry = leaving === "critical" ? input.criticalBytes : input.warningBytes;
    return input.value < entry * factor;
  });
}

/**
 * The sampled inputs, in the shape the pressure contract uses.
 *
 * They never travel (D-265: this window reports nothing), but they are built to
 * the contract anyway: a measure that could not be read carries its reason, and
 * the diagnostics surface renders them with the same code that renders the
 * host's own rows.
 */
export function inputsOf(
  sample: RendererPressureSample,
  reading: RendererPressureReading,
  thresholds: RendererPressureThresholds,
): MemoryPressureInput[] {
  const heap = reading.usable.find((row) => row.kind === "heap");
  return [
    { kind: "physical", value: sample.physical, warningBytes: thresholds.warningBytes, criticalBytes: thresholds.criticalBytes },
    heap
      ? { kind: "heap", value: sample.heapUsed, warningBytes: heap.warningBytes, criticalBytes: heap.criticalBytes }
      : { kind: "heap", value: sample.heapUsed },
  ];
}
