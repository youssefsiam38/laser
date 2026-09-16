/**
 * The numbers the host judges itself by (RP-8, D-261).
 *
 * They are here, in one file, for the same reason the worker keeps its own in
 * `pressure-sampler.ts`: the host may not import the worker (AGENTS.md
 * invariant 1), so the two processes hold the same calibrated shape twice
 * rather than reaching across a boundary for it. Every value below is either
 * D-261's or an existing calibrated number in this repository; none of them was
 * chosen here.
 */

const MiB = 1024 * 1024;

/** What the host process itself costs, and what its heap costs (D-261). */
export interface HostPressureThresholds {
  /** Physical bytes: D-261's 512 MiB and 768 MiB for the host. */
  warningBytes: number;
  criticalBytes: number;
  /** Fractions of V8's measured limit, the same pair the worker uses. */
  heapWarningRatio: number;
  heapCriticalRatio: number;
}

export const HOST_PRESSURE_THRESHOLDS: HostPressureThresholds = Object.freeze({
  warningBytes: 512 * MiB,
  criticalBytes: 768 * MiB,
  heapWarningRatio: 0.6,
  heapCriticalRatio: 0.75,
});

/**
 * How much memory the machine still has, which *falls* into trouble.
 *
 * 2,048 MiB is this repository's own calibrated "no longer safe to load" line —
 * `SAFETY.minimumAvailableBytes` in `scripts/browser-check/resource/config.mjs`,
 * which already aborts a soak run. 1,024 MiB is the point at which one more
 * project worker's settled 1,280 MiB reservation (D-261) provably cannot fit.
 */
export interface MachinePressureThresholds {
  warningBytes: number;
  criticalBytes: number;
}

export const MACHINE_PRESSURE_THRESHOLDS: MachinePressureThresholds = Object.freeze({
  warningBytes: 2_048 * MiB,
  criticalBytes: 1_024 * MiB,
});

/** How often the host looks at itself. The same cadence the worker uses. */
export const HOST_PRESSURE_NORMAL_INTERVAL_MS = 20_000;
export const HOST_PRESSURE_ELEVATED_INTERVAL_MS = 5_000;
/** A sample older than this many cadences is not evidence any more. */
export const HOST_PRESSURE_STALE_CADENCES = 3;
/** Samples that must agree before a role's level changes. */
export const HOST_PRESSURE_ESCALATE_SAMPLES = 2;
export const HOST_PRESSURE_RELEASE_SAMPLES = 3;
/** A level is left only once every reading is this far inside it. */
export const HOST_PRESSURE_RELEASE_FACTOR = 0.85;
/** At most one publication per window; only the newest pending one survives. */
export const HOST_PRESSURE_PUBLISH_WINDOW_MS = 5_000;
/**
 * How old a worker's report may be before that worker is simply unanswered.
 *
 * Three elevated cadences, measured as the host receives it plus the age the
 * worker itself reported — never the worker's clock.
 */
export const WORKER_REPORT_FRESH_MS = HOST_PRESSURE_STALE_CADENCES * HOST_PRESSURE_ELEVATED_INTERVAL_MS;
