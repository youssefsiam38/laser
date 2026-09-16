/**
 * The window's own memory-pressure controller (RP-8 milestone F, D-265).
 *
 * One serialized actor. It samples what this environment can truthfully
 * measure (`sampler.ts`), settles a level with the same hysteresis the worker
 * uses, and runs only the part of the ordered response a window owns:
 *
 *   1 · `ephemeral_caches`  — rebuildable caches, `ephemeral.ts`
 *   2 · `renderer_views`    — T5's `ViewCache.releaseUnder`, never a second cache
 *   7 · `admission_refused` — new *whole-transcript* hydration, and nothing else
 *
 * What it never does: cancel a turn, a question, an approval, an agent run, a
 * queue, a command or a live tail; drop a draft, a focus, a scroll position, a
 * find or a disclosure; write to a session; evict a view somebody is using;
 * report anything off this device (D-265); persist a pressure mode across a
 * reload; or act on evidence it does not have.
 *
 * Two things can raise this window's level: its own samples, and the host's
 * `resource/pressure` summary. The host's is fenced by epoch — a stale or
 * out-of-order publication changes nothing — and its level is read the way the
 * host itself decides, from the host, machine and worker rows only. The
 * renderer row in that summary is about windows the host cannot measure, and
 * folding it back in here would be this window reading its own echo.
 *
 * Failure is categorical: a throwing sampler, cache, step or listener is
 * counted, bounded and forgotten. Nothing is retried, nothing is queued for
 * later, and no rejection is left unhandled.
 */
import {
  aggregateMemoryPressureLevel,
  memoryPressurePublishSchema,
  type MemoryPressureAction,
  type MemoryPressureActionResult,
  type MemoryPressureDirectiveLevel,
  type MemoryPressureInput,
  type MemoryPressureLevel,
  type MemoryPressureLevelState,
  type MemoryPressureRefusal,
} from "@lasercode/protocol";

import type { ReleaseOutcome, RendererViewCounters } from "../view-cache.js";
import { releaseEphemeralCaches, type EphemeralRelease } from "./ephemeral.js";
import {
  LEVEL_SEVERITY,
  PRESSURE_CRITICAL_COOLDOWN_MS,
  PRESSURE_ELEVATED_INTERVAL_MS,
  PRESSURE_ESCALATE_SAMPLES,
  PRESSURE_NORMAL_INTERVAL_MS,
  PRESSURE_QUIET_COOLDOWN_MS,
  PRESSURE_REFUSAL_WINDOW_MS,
  PRESSURE_RELEASE_SAMPLES,
  PRESSURE_STALE_CADENCES,
  PRESSURE_WARNING_COOLDOWN_MS,
  RENDERER_PRESSURE_ROWS_MAX,
  RENDERER_PRESSURE_ROW_MAX_AGE_MS,
  RENDERER_PRESSURE_THRESHOLDS,
  belowRelease,
  inputsOf,
  isDirectiveLevel,
  readingOf,
  worseLevel,
  type RendererPressureReading,
  type RendererPressureSample,
  type RendererPressureThresholds,
} from "./thresholds.js";

/** The steps this window owns, in the policy's order. */
export const RENDERER_PRESSURE_STEPS = ["ephemeral_caches", "renderer_views"] as const satisfies readonly MemoryPressureAction[];

/** One of the two steps above; never a step another actor owns. */
export type RendererPressureStep = (typeof RENDERER_PRESSURE_STEPS)[number];

/**
 * The one thing this window refuses, and only while it is under pressure:
 * reading a whole conversation — every branch, every version — at once. Every
 * bounded read, every reconnect, every mutation and every person's word stays
 * available at any level.
 */
export const RENDERER_PRESSURE_REFUSALS = ["whole_transcript"] as const satisfies readonly MemoryPressureRefusal[];
export type RendererPressureRefusal = (typeof RENDERER_PRESSURE_REFUSALS)[number];

/**
 * What a person is told when this window will not start a whole-transcript
 * read. It says what happened and what still works, and it is thrown rather
 * than returned so no call site can mistake a refusal for an empty answer.
 */
export class PressureRefusedError extends Error {
  override readonly name = "PressureRefusedError";
  constructor(readonly refusal: MemoryPressureRefusal, message: string) {
    super(message);
  }
}

/** The sentence for the one refusal this window owns. */
export const PRESSURE_REFUSAL_MESSAGES: Record<RendererPressureRefusal, string> = {
  whole_transcript:
    "This window is low on memory, so loading a whole conversation at once is paused. Earlier messages still load a page at a time.",
};

/** One step of one pass, as it happened, with the moment and level it happened at. */
export type RendererPressureRow = MemoryPressureActionResult & { atMs: number; level: MemoryPressureLevel };

export interface RendererPressureCounters {
  samples: number;
  sampleFailures: number;
  staleSamples: number;
  passes: number;
  passesStoppedEarly: number;
  stepFailures: number;
  directivesAccepted: number;
  directivesStale: number;
  directivesMalformed: number;
  refusals: number;
  refusalsSuppressed: number;
  callbackFailures: number;
}

/** What the host's last valid publication said, as this window read it. */
export interface RendererHostPressure {
  level: MemoryPressureLevelState;
  epoch?: number;
  /** When this window received it. A local clock reading, never the host's. */
  atMs?: number;
}

export interface RendererPressureState {
  /** What this window measured about itself. `unknown` until it has evidence. */
  readonly level: MemoryPressureLevelState;
  /** The level it acts at: the worse of its own and the host's. */
  readonly effective: MemoryPressureLevelState;
  readonly sampleAgeMs?: number;
  readonly inputs: readonly MemoryPressureInput[];
  readonly refusing: readonly MemoryPressureRefusal[];
  readonly rows: readonly RendererPressureRow[];
  readonly totals: { passes: number; released: { count: number; bytes: number }; refusals: number };
  readonly host: RendererHostPressure;
  readonly counters: RendererPressureCounters;
}

/** What the controller needs. Everything is injectable; nothing is a global. */
export interface RendererPressureDeps {
  sample(): Promise<RendererPressureSample>;
  /** T5's bounded view cache. The only authority over hydrated transcripts. */
  cache: { releaseUnder(level: MemoryPressureDirectiveLevel): ReleaseOutcome; counters(): RendererViewCounters };
  /** Step 1. Defaults to the process-wide registry in `ephemeral.ts`. */
  ephemeral?: () => EphemeralRelease;
  now?: () => number;
  /** Returns a cancel. Defaults to `setTimeout`, unref'd where that exists. */
  schedule?: (run: () => void, ms: number) => () => void;
  thresholds?: RendererPressureThresholds;
  normalIntervalMs?: number;
  elevatedIntervalMs?: number;
  log?: (line: string) => void;
}

const emptyCounters = (): RendererPressureCounters => ({
  samples: 0,
  sampleFailures: 0,
  staleSamples: 0,
  passes: 0,
  passesStoppedEarly: 0,
  stepFailures: 0,
  directivesAccepted: 0,
  directivesStale: 0,
  directivesMalformed: 0,
  refusals: 0,
  refusalsSuppressed: 0,
  callbackFailures: 0,
});

export interface RendererPressureController {
  start(): void;
  dispose(): void;
  /** A new environment: this window's record belongs to the one it just left. */
  reset(): void;
  /**
   * Look now, and act if that look authorizes it: the same work the cadence
   * does, run at a moment worth looking — a page coming back from being
   * throttled, or a test stepping the clock. Cooldowns bound it exactly as
   * they bound the scheduled one.
   */
  probeNow(): Promise<void>;
  /** The host's summary arrived. Validated, fenced, and possibly acted on. */
  observePublication(params: unknown): void;
  /** A socket opened, or the environment changed: the host's epoch starts again. */
  forgetHost(): void;
  /** May this window still do that? `unknown` refuses nothing. */
  admits(kind: MemoryPressureRefusal): boolean;
  /** Record that something was refused. Coalesced; never a request's side effect. */
  refused(kind: MemoryPressureRefusal): void;
  getSnapshot(): RendererPressureState;
  subscribe(listener: () => void): () => void;
}

const EMPTY_INPUTS: readonly MemoryPressureInput[] = Object.freeze([]);
const NO_REFUSALS: readonly MemoryPressureRefusal[] = Object.freeze([]);

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  // A page has no handle to unref; a Node-shaped timer does, and giving memory
  // back is never a reason for a process to stay alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

/** A pass that had nothing to measure: said out loud, never a zero. */
const blindSample = (atMs: number): RendererPressureSample => ({
  ...(Number.isSafeInteger(atMs) ? { atMs } : {}),
  physical: { status: "unavailable", reason: "collector_failed" },
  heapUsed: { status: "unavailable", reason: "collector_failed" },
  heapLimit: { status: "unavailable", reason: "collector_failed" },
});

const BLIND_READING: RendererPressureReading = { level: "unknown", usable: [] };

export function createRendererPressureController(deps: RendererPressureDeps): RendererPressureController {
  const thresholds = deps.thresholds ?? RENDERER_PRESSURE_THRESHOLDS;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const ephemeral = deps.ephemeral ?? releaseEphemeralCaches;
  const normalIntervalMs = deps.normalIntervalMs ?? PRESSURE_NORMAL_INTERVAL_MS;
  const elevatedIntervalMs = deps.elevatedIntervalMs ?? PRESSURE_ELEVATED_INTERVAL_MS;

  let started = false;
  let disposed = false;
  let level: MemoryPressureLevelState = "unknown";
  let streakLevel: MemoryPressureLevelState | undefined;
  let streak = 0;
  let last: { sample: RendererPressureSample; reading: RendererPressureReading } | undefined;
  let lastPassAtMs: number | undefined;
  let lastPassLevel: MemoryPressureDirectiveLevel | undefined;
  let lastPassQuiet = false;
  let host: RendererHostPressure = { level: "unknown" };
  let hostEpoch: number | undefined;
  let rows: RendererPressureRow[] = [];
  const refusedAt = new Map<MemoryPressureRefusal, number>();
  const totals = { passes: 0, released: { count: 0, bytes: 0 }, refusals: 0 };
  const counters = emptyCounters();
  const listeners = new Set<() => void>();
  let snapshot: RendererPressureState | undefined;
  let cancelTimer: (() => void) | undefined;
  let chain: Promise<void> = Promise.resolve();
  let stopVisibility: (() => void) | undefined;
  /** Fences probes and queued passes that began in an environment we left. */
  let generation = 0;

  const note = (line: string): void => {
    try {
      deps.log?.(line);
    } catch {
      counters.callbackFailures += 1;
    }
  };

  const changed = (): void => {
    snapshot = undefined;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A surface that cannot take this update never stops the pass that
        // produced it, and never gets a second one for its trouble.
        counters.callbackFailures += 1;
      }
    }
  };

  /** A host publication is evidence for at most three elevated cadences. */
  const hostLevel = (): MemoryPressureLevelState => {
    if (host.atMs === undefined) return "unknown";
    const age = now() - host.atMs;
    return Number.isSafeInteger(age) && age >= 0 && age < PRESSURE_STALE_CADENCES * elevatedIntervalMs
      ? host.level
      : "unknown";
  };

  const effectiveLevel = (): MemoryPressureLevelState => worseLevel(level, hostLevel());

  const refusingNow = (): readonly MemoryPressureRefusal[] =>
    isDirectiveLevel(effectiveLevel()) ? RENDERER_PRESSURE_REFUSALS : NO_REFUSALS;

  const cadence = (): number => (isDirectiveLevel(effectiveLevel()) ? elevatedIntervalMs : normalIntervalMs);

  /**
   * How long after a pass the next one may run: from the level of the pass
   * that happened, not from whatever the sampler says now. A pass that gave
   * nothing back waits longer than either.
   */
  const cooldownMs = (): number => {
    if (lastPassQuiet) return PRESSURE_QUIET_COOLDOWN_MS;
    return lastPassLevel === "critical" ? PRESSURE_CRITICAL_COOLDOWN_MS : PRESSURE_WARNING_COOLDOWN_MS;
  };

  const inCooldown = (at: number): boolean => lastPassAtMs !== undefined && at - lastPassAtMs < cooldownMs();

  // --- the local record ----------------------------------------------------

  const record = (row: RendererPressureRow): void => {
    rows = [row, ...rows].filter((entry, index) => index < RENDERER_PRESSURE_ROWS_MAX
      && row.atMs - entry.atMs < RENDERER_PRESSURE_ROW_MAX_AGE_MS);
    if (row.outcome === "released") {
      totals.released.count += row.released.count ?? 0;
      totals.released.bytes += row.released.bytes ?? 0;
    }
    changed();
  };

  // --- levels --------------------------------------------------------------

  const forgetStreak = (): void => {
    streakLevel = undefined;
    streak = 0;
  };

  const settle = (next: MemoryPressureLevelState): boolean => {
    // A sample that disagrees with the one before it has broken the run,
    // whether or not the published level moves.
    forgetStreak();
    if (next === level) return false;
    level = next;
    return true;
  };

  const observe = (reading: RendererPressureReading): boolean => {
    // Unknown is immediate: evidence that has gone missing is not something to
    // wait out, and it never settles as `normal`.
    if (reading.level === "unknown") return settle("unknown");
    if (reading.level === level) {
      forgetStreak();
      return false;
    }
    const escalating = LEVEL_SEVERITY[reading.level] > LEVEL_SEVERITY[level] || level === "unknown";
    const needed = escalating ? PRESSURE_ESCALATE_SAMPLES : PRESSURE_RELEASE_SAMPLES;
    if (!escalating && isDirectiveLevel(level) && !belowRelease(reading, level)) {
      // Still above the release line: a value hovering on a threshold does not
      // get to flap.
      forgetStreak();
      return false;
    }
    streak = streakLevel === reading.level ? streak + 1 : 1;
    streakLevel = reading.level;
    if (streak < needed) return false;
    return settle(reading.level);
  };

  const probe = async (expectedGeneration = generation): Promise<{ sample: RendererPressureSample; reading: RendererPressureReading; moved: boolean } | undefined> => {
    let sample: RendererPressureSample;
    try {
      sample = await deps.sample();
    } catch {
      if (disposed || expectedGeneration !== generation) return undefined;
      counters.sampleFailures += 1;
      const moved = settle("unknown");
      const blind = blindSample(now());
      last = { sample: blind, reading: BLIND_READING };
      if (moved) changed();
      return { sample: blind, reading: BLIND_READING, moved };
    }
    // A sample belongs to the environment in which it began. A reset can
    // happen while an async desktop bridge is answering; that late answer has
    // no authority over the new environment and is discarded without a row.
    if (disposed || expectedGeneration !== generation) return undefined;
    counters.samples += 1;
    const at = now();
    const reading = readingOf(sample, thresholds);
    const age = sample.atMs === undefined ? undefined : at - sample.atMs;
    if (age === undefined || !Number.isSafeInteger(age) || age < 0 || age > PRESSURE_STALE_CADENCES * cadence()) {
      counters.staleSamples += 1;
      const moved = settle("unknown");
      last = { sample, reading: BLIND_READING };
      changed();
      return { sample, reading: BLIND_READING, moved };
    }
    last = { sample, reading };
    const moved = observe(reading);
    changed();
    return { sample, reading, moved };
  };

  // --- the steps -----------------------------------------------------------

  const releasedRow = (
    action: RendererPressureStep,
    released: { count: number; bytes: number },
    atMs: number,
    passLevel: MemoryPressureDirectiveLevel,
  ): RendererPressureRow => {
    if (released.count > 0 && released.bytes > 0) {
      return { action, outcome: "released", released: { count: released.count, bytes: released.bytes }, atMs, level: passLevel };
    }
    if (released.count > 0) {
      return { action, outcome: "released", released: { count: released.count }, atMs, level: passLevel };
    }
    if (released.bytes > 0) {
      return { action, outcome: "released", released: { bytes: released.bytes }, atMs, level: passLevel };
    }
    throw new Error("a released row needs measured evidence");
  };

  const ephemeralStep = (at: number, passLevel: MemoryPressureDirectiveLevel): RendererPressureRow => {
    const released = ephemeral();
    if (released.count > 0 || released.bytes > 0) return releasedRow("ephemeral_caches", released, at, passLevel);
    // A cache that threw is the only thing between "nothing was there" and
    // "we could not tell": that difference is the row.
    if (released.failures > 0) return { action: "ephemeral_caches", outcome: "unavailable", atMs: at, level: passLevel };
    return { action: "ephemeral_caches", outcome: "nothing_to_give", atMs: at, level: passLevel };
  };

  const viewsStep = (at: number, passLevel: MemoryPressureDirectiveLevel): RendererPressureRow => {
    const before = deps.cache.counters();
    const outcome: ReleaseOutcome = deps.cache.releaseUnder(passLevel);
    const after = deps.cache.counters();
    // Measured, not claimed: the cache's own byte total before and after this
    // pass, which counts the transcripts it let go of *and* the older turns it
    // trimmed out of the ones it kept.
    const delta = Math.max(0, before.bytes - after.bytes);
    const count = outcome.released.length;
    if (count > 0 || delta > 0) {
      const bytes = delta > 0 ? delta : outcome.bytesReleased;
      return releasedRow("renderer_views", { count, bytes }, at, passLevel);
    }
    // Over budget with nothing releasable means every candidate is a
    // conversation somebody is using. Work is never taken.
    if (outcome.refused.length > 0) return { action: "renderer_views", outcome: "held", reason: "pins_held", atMs: at, level: passLevel };
    return { action: "renderer_views", outcome: "nothing_to_give", atMs: at, level: passLevel };
  };

  const stepRunners: Record<RendererPressureStep, (at: number, level: MemoryPressureDirectiveLevel) => RendererPressureRow> = {
    ephemeral_caches: ephemeralStep,
    renderer_views: viewsStep,
  };

  const runStep = (action: RendererPressureStep, at: number, passLevel: MemoryPressureDirectiveLevel): RendererPressureRow | undefined => {
    try {
      return stepRunners[action](at, passLevel);
    } catch {
      counters.stepFailures += 1;
      note(`memory pressure: the ${action} step could not complete`);
      return undefined;
    }
  };

  /**
   * One pass, in the policy's order.
   *
   * A pass this window started for itself looks between the steps: pressure it
   * has already relieved does not need the rest of the list, and evidence that
   * has gone missing stops it rather than letting it act on nothing. A pass the
   * host asked for is never stopped that way — the host asked on evidence of
   * its own, and every step here is safe.
   */
  const runPass = async (passLevel: MemoryPressureDirectiveLevel, stopWhenRelieved: boolean, expectedGeneration = generation): Promise<void> => {
    if (disposed || expectedGeneration !== generation) return;
    counters.passes += 1;
    totals.passes += 1;
    const produced: RendererPressureRow[] = [];
    for (const [index, action] of RENDERER_PRESSURE_STEPS.entries()) {
      if (disposed || expectedGeneration !== generation) break;
      const row = runStep(action, now(), passLevel);
      if (disposed || expectedGeneration !== generation) break;
      if (!row) {
        // Categorical, and the pass stops here: a step that threw leaves this
        // window's own state unproven, and the next one would act on it.
        const unavailable: RendererPressureRow = { action, outcome: "unavailable", atMs: now(), level: passLevel };
        produced.push(unavailable);
        record(unavailable);
        break;
      }
      produced.push(row);
      record(row);
      if (stopWhenRelieved && index < RENDERER_PRESSURE_STEPS.length - 1) {
        const seen = await probe(expectedGeneration);
        if (!seen || disposed || expectedGeneration !== generation) break;
        const relieved = seen.reading.level === "normal" || belowRelease(seen.reading, passLevel);
        if (seen.reading.level === "unknown" || relieved) {
          counters.passesStoppedEarly += 1;
          break;
        }
      }
    }
    if (disposed || expectedGeneration !== generation) return;
    lastPassAtMs = now();
    lastPassLevel = passLevel;
    // Quiet is exactly "nothing was there to give": a step that could not be
    // measured is not quiet, and does not earn the long cooldown.
    lastPassQuiet = produced.length > 0 && produced.every((row) => row.outcome === "nothing_to_give" || row.outcome === "held");
    changed();
  };

  // --- scheduling ----------------------------------------------------------

  const serialize = (work: () => Promise<void>): Promise<void> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const armTimer = (): void => {
    if (disposed || !started) return;
    cancelTimer?.();
    cancelTimer = schedule(() => {
      cancelTimer = undefined;
      void tick();
    }, cadence());
  };

  const scheduledProbe = async (): Promise<void> => {
    if (disposed) return;
    const expectedGeneration = generation;
    const seen = await probe(expectedGeneration);
    if (!seen || disposed || expectedGeneration !== generation) return;
    const acting = effectiveLevel();
    if (!isDirectiveLevel(acting) || inCooldown(now())) return;
    // Only this window's own evidence starts a self pass; a level this window
    // holds only because the host said so was already acted on when it arrived.
    if (!isDirectiveLevel(level)) return;
    await runPass(level, true, expectedGeneration);
  };

  const tick = async (): Promise<void> => {
    try {
      await serialize(scheduledProbe);
    } finally {
      armTimer();
    }
  };

  const watchVisibility = (): void => {
    const target = (globalThis as typeof globalThis & { document?: Document }).document;
    if (!target || typeof target.addEventListener !== "function") return;
    const onVisible = (): void => {
      if (disposed || target.visibilityState !== "visible") return;
      // A hidden page's timers are throttled to about one a minute. Coming
      // back is the moment to look again rather than wait out the cadence.
      void serialize(scheduledProbe);
    };
    target.addEventListener("visibilitychange", onVisible);
    stopVisibility = () => target.removeEventListener("visibilitychange", onVisible);
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      watchVisibility();
      void tick();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelTimer?.();
      cancelTimer = undefined;
      stopVisibility?.();
      stopVisibility = undefined;
      listeners.clear();
    },
    reset() {
      // Counters, rows and the host's epoch belong to the environment this
      // device just left (RP-13). Nothing about pressure outlives it, and
      // nothing about it was ever written to storage.
      generation += 1;
      level = "unknown";
      forgetStreak();
      last = undefined;
      lastPassAtMs = undefined;
      lastPassLevel = undefined;
      lastPassQuiet = false;
      host = { level: "unknown" };
      hostEpoch = undefined;
      rows = [];
      refusedAt.clear();
      totals.passes = 0;
      totals.released = { count: 0, bytes: 0 };
      totals.refusals = 0;
      Object.assign(counters, emptyCounters());
      changed();
      armTimer();
    },
    probeNow() {
      return serialize(scheduledProbe);
    },
    observePublication(params: unknown) {
      if (disposed) return;
      const parsed = memoryPressurePublishSchema.safeParse(params);
      if (!parsed.success) {
        // A payload this window cannot read changes nothing, and its contents
        // are never logged.
        counters.directivesMalformed += 1;
        note("memory pressure: a host summary did not match the contract and was ignored");
        changed();
        return;
      }
      const publication = parsed.data;
      if (hostEpoch !== undefined && publication.epoch <= hostEpoch) {
        // Stale or out of order: an older decision never overrides a newer one,
        // and a decision already acted on is not acted on twice.
        counters.directivesStale += 1;
        changed();
        return;
      }
      hostEpoch = publication.epoch;
      counters.directivesAccepted += 1;
      // The host's own decision level: its process, the machine and the
      // workers. The renderer row in that summary is about windows the host
      // cannot measure, and is deliberately left out of this.
      const decided = aggregateMemoryPressureLevel(
        publication.summary.roles
          .filter((row) => row.role !== "desktop_renderer")
          .map((row) => row.level),
      );
      host = { level: decided, epoch: publication.epoch, atMs: now() };
      changed();
      if (!isDirectiveLevel(decided)) return;
      const expectedGeneration = generation;
      void serialize(async () => {
        if (disposed || expectedGeneration !== generation || inCooldown(now())) return;
        await runPass(decided, false, expectedGeneration);
      });
    },
    forgetHost() {
      // The host's epoch is process-local: a restarted host legitimately starts
      // again at 1, and a window that kept the old fence would never hear it.
      hostEpoch = undefined;
      if (host.level === "unknown" && host.epoch === undefined) return;
      host = { level: "unknown" };
      changed();
    },
    admits(kind) {
      return !refusingNow().includes(kind);
    },
    refused(kind) {
      if (disposed) return;
      const acting = effectiveLevel();
      if (!isDirectiveLevel(acting)) return;
      counters.refusals += 1;
      totals.refusals += 1;
      const at = now();
      const previous = refusedAt.get(kind);
      if (previous !== undefined && at - previous < PRESSURE_REFUSAL_WINDOW_MS) {
        // A person holding a control, or a surface retrying, must not fill this
        // record with the same sentence.
        counters.refusalsSuppressed += 1;
        changed();
        return;
      }
      refusedAt.set(kind, at);
      record({ action: "admission_refused", outcome: "refused", refusal: kind, atMs: at, level: acting });
    },
    getSnapshot() {
      if (snapshot) return snapshot;
      const sample = last?.sample;
      const age = sample?.atMs === undefined ? undefined : now() - sample.atMs;
      const sampleAgeMs = age !== undefined && Number.isSafeInteger(age) && age >= 0 ? age : undefined;
      return (snapshot = Object.freeze({
        level,
        effective: effectiveLevel(),
        ...(sampleAgeMs !== undefined ? { sampleAgeMs } : {}),
        inputs: sample && last ? Object.freeze(inputsOf(sample, last.reading, thresholds)) : EMPTY_INPUTS,
        refusing: refusingNow(),
        rows: Object.freeze([...rows]),
        totals: { passes: totals.passes, released: { ...totals.released }, refusals: totals.refusals },
        host: { ...host, level: hostLevel() },
        counters: { ...counters },
      }) as RendererPressureState);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
