/**
 * The window's memory-pressure actor (RP-8 milestone F, D-265).
 *
 * Local by design: it measures this window, releases this window's rebuildable
 * caches and dormant transcripts, and refuses new whole-transcript hydration
 * while it is under pressure. Nothing it learns leaves this device.
 */
export {
  PRESSURE_REFUSAL_MESSAGES,
  PressureRefusedError,
  RENDERER_PRESSURE_REFUSALS,
  RENDERER_PRESSURE_STEPS,
  createRendererPressureController,
  type RendererHostPressure,
  type RendererPressureController,
  type RendererPressureCounters,
  type RendererPressureDeps,
  type RendererPressureRefusal,
  type RendererPressureRow,
  type RendererPressureState,
} from "./controller.js";
export {
  ephemeralCacheCount,
  registerEphemeralCache,
  releaseEphemeralCaches,
  type EphemeralCache,
  type EphemeralRelease,
} from "./ephemeral.js";
export { createRendererPressureSampler, type DesktopMemoryBridge, type RendererSamplerIo } from "./sampler.js";
export {
  PRESSURE_CRITICAL_COOLDOWN_MS,
  PRESSURE_ELEVATED_INTERVAL_MS,
  PRESSURE_ESCALATE_SAMPLES,
  PRESSURE_NORMAL_INTERVAL_MS,
  PRESSURE_QUIET_COOLDOWN_MS,
  PRESSURE_REFUSAL_WINDOW_MS,
  PRESSURE_RELEASE_FACTOR,
  PRESSURE_RELEASE_SAMPLES,
  PRESSURE_STALE_CADENCES,
  PRESSURE_WARNING_COOLDOWN_MS,
  RENDERER_PRESSURE_ROWS_MAX,
  RENDERER_PRESSURE_ROW_MAX_AGE_MS,
  RENDERER_PRESSURE_THRESHOLDS,
  belowRelease,
  heapThresholds,
  inputsOf,
  readingOf,
  worseLevel,
  type RendererPressureReading,
  type RendererPressureSample,
  type RendererPressureThresholds,
} from "./thresholds.js";
