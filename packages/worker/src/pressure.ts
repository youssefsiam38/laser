/**
 * The worker's own answer for its own memory (RP-8).
 *
 * A worker samples itself, decides its own level and runs the three steps it
 * owns — its rebuildable caches, its old replay suffixes, its finished
 * commands' records — without being asked. It never releases a renderer's
 * views, never unloads a conversation's runtime, never retires itself and
 * never refuses admission: those belong to the window and to the host. And it
 * never cancels anything: a turn, a question, an approval, a run, a queued
 * message and a running command are not memory to give back.
 *
 * Two shapes leave this file, and they never overlap:
 *
 * - the **answer to a directive**, which owns that pass's rows;
 * - an **unasked notification**, which carries only what this worker found by
 *   itself: the rows of a pass it decided to run, or — with no rows at all —
 *   the fact that its level changed, including back to `normal` and to
 *   `unknown`, so the host never keeps believing a warning this worker has
 *   left behind.
 *
 * Everything here is serialized. One promise chain carries the scheduled
 * probe, a directive and the probe that follows a pass, so two passes can
 * never run at once and a slow pass cannot stack ticks behind it. Everything
 * here is also bounded: one pass at a time, a capped number of replay drops, a
 * capped number of sessions told, and at most one notification every five
 * seconds.
 */
import {
  MEMORY_PRESSURE_WORKER_ACTIONS,
  memoryPressureStoresSchema,
  parseMemoryPressureDirectiveResult,
  parseMemoryPressureReport,
  type MemoryPressureAction,
  type MemoryPressureDirective,
  type MemoryPressureDirectiveLevel,
  type MemoryPressureDirectiveResultInput,
  type MemoryPressureInput,
  type MemoryPressureLevel,
  type MemoryPressureLevelState,
  type MemoryPressureReportInput,
  type MemoryPressureStores,
  type MemoryPressureWorkerAction,
  type MemoryPressureWorkerActionResult,
  type ValidatedMemoryPressureDirectiveResult,
  type ValidatedMemoryPressureReport,
} from "@lasercode/protocol";
import {
  LEVEL_SEVERITY,
  WORKER_PRESSURE_THRESHOLDS,
  belowRelease,
  readingOf,
  type PressureReading,
  type PressureSample,
  type PressureThresholds,
} from "./pressure-sampler.js";

/** How often this worker looks at itself. */
export const PRESSURE_NORMAL_INTERVAL_MS = 20_000;
export const PRESSURE_ELEVATED_INTERVAL_MS = 5_000;
/** A sample older than this many cadences is not evidence any more. */
export const PRESSURE_STALE_CADENCES = 3;
/** Samples that must agree before a level changes. */
export const PRESSURE_ESCALATE_SAMPLES = 2;
export const PRESSURE_RELEASE_SAMPLES = 3;
/** The shortest gap between two passes this worker runs for itself. */
export const PRESSURE_WARNING_COOLDOWN_MS = 30_000;
export const PRESSURE_CRITICAL_COOLDOWN_MS = 10_000;
/** After a pass that had nothing to give, it waits longer before trying again. */
export const PRESSURE_QUIET_COOLDOWN_MS = 60_000;
/** At most one notification per window, action first. */
export const PRESSURE_REPORT_WINDOW_MS = 5_000;
/** Replay updates one pass may drop. */
export const PRESSURE_MAX_REPLAY_DROPS = 512;
/** Sessions one pass may ask to keep less. */
export const PRESSURE_MAX_TASK_SESSIONS = 16;

const MIB = 1024 * 1024;

/** Parse configuration only from Node's explicit argv, never from a measured limit. */
export function configuredOldSpaceBytes(execArgv: readonly string[]): number | undefined {
  let raw: string | undefined;
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index]!;
    if (value === "--max-old-space-size") {
      raw = execArgv[index + 1];
      index += 1;
      continue;
    }
    if (value.startsWith("--max-old-space-size=")) raw = value.slice("--max-old-space-size=".length);
  }
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  const mib = Number(raw);
  const bytes = mib * MIB;
  return Number.isSafeInteger(mib) && Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** What one step did, as this worker measured it. */
export interface PressureActionOutcome {
  /** Things given back. Absent or zero means nothing was released. */
  released?: { count?: number; bytes?: number };
  /** Everything that could have been released is held by work. */
  held?: boolean;
  /** Work was left because a bound was reached first. */
  boundReached?: boolean;
  /** Something was attempted and its result cannot be observed. */
  unobservable?: boolean;
  /** Coverage of the safety answer was incomplete, so nothing was released. */
  safetyIncomplete?: boolean;
}

export interface PressureActions {
  ephemeralCaches(level: MemoryPressureDirectiveLevel): PressureActionOutcome;
  replaySuffixes(level: MemoryPressureDirectiveLevel): PressureActionOutcome;
  taskRecords(level: MemoryPressureDirectiveLevel): PressureActionOutcome;
}

export interface PressureDeps {
  sample(): Promise<PressureSample>;
  actions: PressureActions;
  stores(): MemoryPressureStores;
  /** Send one validated report on the worker's link to the host. */
  report(report: ValidatedMemoryPressureReport): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** A categorical line for this worker's own log. Never a report, never a path. */
  log?: (line: string) => void;
}

export interface PressureOptions {
  /**
   * Which spawn this worker is, as the host minted it (RP-8). Without one this
   * controller fails closed: it never reports and never acts on a directive,
   * because a fence it cannot prove is not a fence.
   */
  generation?: number;
  /** Explicit old-space request parsed from this process's Node argv. */
  configuredOldSpaceBytes?: number;
  thresholds?: PressureThresholds;
  normalIntervalMs?: number;
  elevatedIntervalMs?: number;
  reportWindowMs?: number;
}

export interface PressureCounters {
  level: MemoryPressureLevelState;
  samples: number;
  passes: number;
  directives: number;
  reports: number;
  /** Reports this controller built wrongly and refused to send. */
  invalidReports: number;
  /** Reports the link would not take. Counted, never retried. */
  reportFailures: number;
  /** Times the retained-store counters could not be read or trusted. */
  storeFailures: number;
  /** Notifications held back by the window and sent later. */
  coalesced: number;
  /** Action reports that met another one inside a window. Cooldowns make this 0. */
  actionCollisions: number;
  staleSamples: number;
  sampleFailures: number;
}

export interface WorkerPressureController {
  start(): void;
  directive(params: MemoryPressureDirective): Promise<ValidatedMemoryPressureDirectiveResult>;
  /** Run one scheduled probe now and settle. The test seam for the clock. */
  probeNow(): Promise<void>;
  counters(): PressureCounters;
  dispose(): void;
}

type ActionStep = { action: MemoryPressureWorkerAction; run: (level: MemoryPressureDirectiveLevel) => PressureActionOutcome };

const isDirectiveLevel = (level: MemoryPressureLevelState): level is MemoryPressureDirectiveLevel =>
  level === "warning" || level === "critical";

/** The row a step's outcome becomes, with the wire's cross-field rules held by construction. */
export function rowOf(action: MemoryPressureWorkerAction, outcome: PressureActionOutcome): MemoryPressureWorkerActionResult {
  const count = outcome.released?.count;
  const bytes = outcome.released?.bytes;
  const releasedSomething = (count !== undefined && count > 0) || (bytes !== undefined && bytes > 0);
  if (releasedSomething) {
    const released = {
      ...(count !== undefined && count > 0 ? { count } : {}),
      ...(bytes !== undefined && bytes > 0 ? { bytes } : {}),
    } as { count: number; bytes?: number } | { count?: number; bytes: number };
    // A bound reached *after* something was released is still a release; the
    // reason says the rest is still there.
    return outcome.boundReached
      ? { action, outcome: "released", reason: "work_budget", released }
      : { action, outcome: "released", released };
  }
  // Nothing measurable came back. What is said next is why, never a guess.
  if (outcome.boundReached) return { action, outcome: "budget_reached", reason: "work_budget" };
  if (outcome.safetyIncomplete) return { action, outcome: "held", reason: "safety_incomplete" };
  if (outcome.held) return { action, outcome: "held", reason: "pins_held" };
  if (outcome.unobservable) return { action, outcome: "unavailable" };
  return { action, outcome: "nothing_to_give" };
}

/** The wire's input rows for one sample. Two kinds at most, each once. */
export function inputsOf(sample: PressureSample, reading: PressureReading, thresholds: PressureThresholds): MemoryPressureInput[] {
  const physical = reading.usable.find((row) => row.kind === "physical");
  const heap = reading.usable.find((row) => row.kind === "heap");
  return [
    physical
      ? { kind: "physical", value: sample.physical, warningBytes: physical.warningBytes, criticalBytes: physical.criticalBytes }
      : { kind: "physical", value: sample.physical, warningBytes: thresholds.warningBytes, criticalBytes: thresholds.criticalBytes },
    heap
      ? { kind: "heap", value: sample.heapUsed, warningBytes: heap.warningBytes, criticalBytes: heap.criticalBytes }
      : { kind: "heap", value: sample.heapUsed },
  ];
}

export function createWorkerPressureController(deps: PressureDeps, options: PressureOptions = {}): WorkerPressureController {
  const thresholds = options.thresholds ?? WORKER_PRESSURE_THRESHOLDS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  /**
   * Every timer this controller owns is unref'd, whoever made it: giving
   * memory back is never a reason for a process to stay alive. The default
   * timer is asked twice, harmlessly, rather than leaving an injected one to
   * remember.
   */
  const schedule = (fn: () => void, ms: number): unknown => {
    const handle = setTimer(fn, ms);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    return handle;
  };
  const cancel = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const normalIntervalMs = options.normalIntervalMs ?? PRESSURE_NORMAL_INTERVAL_MS;
  const elevatedIntervalMs = options.elevatedIntervalMs ?? PRESSURE_ELEVATED_INTERVAL_MS;
  const reportWindowMs = options.reportWindowMs ?? PRESSURE_REPORT_WINDOW_MS;
  const generation = options.generation;

  const steps: ActionStep[] = [
    { action: "ephemeral_caches", run: (level) => deps.actions.ephemeralCaches(level) },
    { action: "replay_suffixes", run: (level) => deps.actions.replaySuffixes(level) },
    { action: "task_records", run: (level) => deps.actions.taskRecords(level) },
  ];

  let disposed = false;
  let started = false;
  let timer: unknown;
  let chain: Promise<void> = Promise.resolve();
  let level: MemoryPressureLevelState = "unknown";
  /** The level the last few samples agree on, and how many agreed. */
  let streakLevel: MemoryPressureLevelState | undefined;
  let streak = 0;
  let lastSample: { sample: PressureSample; reading: PressureReading } | undefined;
  let lastPassAtMs: number | undefined;
  let lastPassQuiet = false;
  /** The level of the pass that ran, which is what its cooldown is measured by. */
  let lastPassLevel: MemoryPressureDirectiveLevel | undefined;
  /**
   * The highest epoch any accepted directive has been *seen* at, recorded
   * before a cooldown can refuse it: a newer directive that arrives while this
   * worker is resting still fences an older one arriving after.
   */
  let highestEpochSeen = -1;
  /** Coalescing: one action report at most, plus the newest state-only one. */
  let pendingAction: MemoryPressureReportInput | undefined;
  let pendingState: MemoryPressureReportInput | undefined;
  let windowUntilMs = 0;
  let flushTimer: unknown;
  const counters: PressureCounters = {
    level,
    samples: 0,
    passes: 0,
    directives: 0,
    reports: 0,
    invalidReports: 0,
    reportFailures: 0,
    storeFailures: 0,
    coalesced: 0,
    actionCollisions: 0,
    staleSamples: 0,
    sampleFailures: 0,
  };

  const cadence = (): number => (isDirectiveLevel(level) ? elevatedIntervalMs : normalIntervalMs);

  /**
   * How long after a pass the next one may run.
   *
   * From the level of the pass that happened, not from whatever this worker's
   * sampler says now: a critical pass is followed by critical's short gap even
   * if the reading has since eased, and a warning pass by warning's long one
   * even if things have got worse — the sample that says so will be the one
   * that authorizes the next pass. A pass that gave nothing back waits longer
   * than either.
   */
  const cooldownMs = (): number => {
    if (lastPassQuiet) return PRESSURE_QUIET_COOLDOWN_MS;
    return lastPassLevel === "critical" ? PRESSURE_CRITICAL_COOLDOWN_MS : PRESSURE_WARNING_COOLDOWN_MS;
  };

  const inCooldown = (at: number): boolean => lastPassAtMs !== undefined && at - lastPassAtMs < cooldownMs();

  // --- reporting ----------------------------------------------------------

  const reportOf = (
    reported: MemoryPressureLevelState,
    sample: PressureSample,
    reading: PressureReading,
    ran: MemoryPressureWorkerAction[],
    results: MemoryPressureWorkerActionResult[],
    atMs: number,
  ): MemoryPressureReportInput | undefined => {
    if (generation === undefined) return undefined;
    // How old the reading is, when that is a number at all: an age nobody can
    // compute is left out, because a missing one is not an age of zero.
    const age = atMs - sample.atMs;
    const sampleAgeMs = Number.isSafeInteger(age) && age >= 0 ? age : undefined;
    return {
      generation,
      level: reported,
      ...(sampleAgeMs !== undefined ? { sampleAgeMs } : {}),
      inputs: inputsOf(sample, reading, thresholds),
      ceiling: {
        ...(options.configuredOldSpaceBytes !== undefined ? { configuredBytes: options.configuredOldSpaceBytes } : {}),
        measuredLimit: sample.heapLimit,
      },
      ran,
      results,
      stores: safeStores(),
    };
  };

  const send = (report: MemoryPressureReportInput): void => {
    let validated: ValidatedMemoryPressureReport;
    try {
      validated = parseMemoryPressureReport(report);
    } catch {
      // A report this controller cannot build correctly is a fault of its own,
      // and the host is told nothing rather than something untrue.
      counters.invalidReports += 1;
      deps.log?.("memory pressure: a report did not match the contract and was not sent");
      return;
    }
    try {
      deps.report(validated);
    } catch {
      // The link is gone, or refused it. A diagnostic that cannot be delivered
      // is counted and forgotten: it is never retried, never queued for later
      // and never allowed to take this controller — or the process — down with
      // it. The next state this worker reaches will be reported on its own.
      counters.reportFailures += 1;
      deps.log?.("memory pressure: a report could not be delivered and was dropped");
      return;
    }
    counters.reports += 1;
  };

  /**
   * The retained-store counters, or none at all.
   *
   * Reading them touches several subsystems, and a reader that throws must not
   * fail a directive, reject a scheduled probe or leave a timer's work
   * unhandled. A shape this wire would refuse is the same kind of fault. Either
   * way the answer is an empty set — evidence omitted, never invented — so what
   * leaves this controller is always something the contract accepts.
   */
  const safeStores = (): MemoryPressureStores => {
    let value: MemoryPressureStores;
    try {
      value = deps.stores();
    } catch {
      counters.storeFailures += 1;
      deps.log?.("memory pressure: the retained-store counters could not be read");
      return {};
    }
    const parsed = memoryPressureStoresSchema.safeParse(value);
    if (parsed.success) return parsed.data as MemoryPressureStores;
    counters.storeFailures += 1;
    deps.log?.("memory pressure: the retained-store counters did not match the contract");
    return {};
  };

  const flush = (): void => {
    if (disposed) return;
    const at = now();
    if (at < windowUntilMs) {
      if (flushTimer === undefined) flushTimer = schedule(() => { flushTimer = undefined; flush(); }, windowUntilMs - at);
      return;
    }
    // The action report goes first and is never dropped for a later state-only
    // one: what a pass did is the thing nothing else can tell the host.
    const next = pendingAction ?? pendingState;
    if (!next) return;
    if (pendingAction) pendingAction = undefined;
    else pendingState = undefined;
    windowUntilMs = at + reportWindowMs;
    send(next);
    if (pendingAction || pendingState) {
      counters.coalesced += 1;
      if (flushTimer === undefined) flushTimer = schedule(() => { flushTimer = undefined; flush(); }, reportWindowMs);
    }
  };

  const queue = (report: MemoryPressureReportInput | undefined, kind: "action" | "state"): void => {
    if (!report || disposed) return;
    if (kind === "action") {
      // Cooldowns make two self action passes inside one window impossible;
      // if that ever changed, the first is kept rather than lost.
      if (pendingAction) counters.actionCollisions += 1;
      else pendingAction = report;
    } else {
      pendingState = report;
    }
    flush();
  };

  // --- sampling and the level ---------------------------------------------

  /** Forget the samples that were agreeing with each other. */
  const forgetStreak = (): void => {
    streakLevel = undefined;
    streak = 0;
  };

  const settle = (next: MemoryPressureLevelState): boolean => {
    // The candidate is dropped whether or not the published level moves: a
    // sample that disagrees with the one before it has broken the run, and a
    // run is what a change is made of.
    forgetStreak();
    if (next === level) return false;
    level = next;
    counters.level = next;
    return true;
  };

  /** Fold one reading into the level. Returns true when the level changed. */
  const observe = (reading: PressureReading, at: number): boolean => {
    // Unknown is immediate: evidence that has gone missing is not something to
    // wait out, and it is never allowed to settle as `normal`.
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
    void at;
    return settle(reading.level);
  };

  /** What a reading looks like when there was none: nothing, said out loud. */
  const blindReading: PressureReading = { level: "unknown", usable: [], anyAvailable: false };
  const blindSample = (at: number): PressureSample => ({
    atMs: Number.isSafeInteger(at) ? at : 0,
    physical: { status: "unavailable", reason: "collector_failed" },
    heapUsed: { status: "unavailable", reason: "collector_failed" },
    heapLimit: { status: "unavailable", reason: "collector_failed" },
  });

  const probe = async (): Promise<{ reading: PressureReading; sample: PressureSample; changed: boolean }> => {
    let sample: PressureSample;
    try {
      sample = await deps.sample();
    } catch {
      // A sampler that failed is still a fact about this worker, and the host
      // is owed it: the level becomes unknown and the transition is reported
      // like any other, with readings that say they could not be taken rather
      // than numbers nobody read.
      counters.sampleFailures += 1;
      const changed = settle("unknown");
      const sample = blindSample(now());
      lastSample = { sample, reading: blindReading };
      return { sample, reading: blindReading, changed };
    }
    counters.samples += 1;
    const at = now();
    const reading = readingOf(sample, thresholds);
    if (at - sample.atMs > PRESSURE_STALE_CADENCES * cadence()) {
      counters.staleSamples += 1;
      const changed = settle("unknown");
      lastSample = { sample, reading: { level: "unknown", usable: [], anyAvailable: reading.anyAvailable } };
      return { sample, reading: lastSample.reading, changed };
    }
    lastSample = { sample, reading };
    const changed = observe(reading, at);
    return { sample, reading, changed };
  };

  // --- the pass ------------------------------------------------------------

  interface PassOutcome {
    completed: boolean;
    ran: MemoryPressureWorkerAction[];
    results: MemoryPressureWorkerActionResult[];
    quiet: boolean;
    /** The probe that ended a self pass, carried out so its change is not lost. */
    stopped?: { sample: PressureSample; reading: PressureReading; changed: boolean };
  }

  const runPass = async (passLevel: MemoryPressureDirectiveLevel, stopWhenRelieved: boolean): Promise<PassOutcome> => {
    const ran: MemoryPressureWorkerAction[] = [];
    const results: MemoryPressureWorkerActionResult[] = [];
    let completed = true;
    let stopped: PassOutcome["stopped"];
    counters.passes += 1;
    for (const [index, step] of steps.entries()) {
      if (disposed) {
        completed = false;
        break;
      }
      let outcome: PressureActionOutcome;
      try {
        outcome = step.run(passLevel);
      } catch {
        // Categorical, and the pass stops here: a step that threw leaves this
        // worker's own state unproven, and the next one would act on it.
        ran.push(step.action);
        results.push({ action: step.action, outcome: "unavailable" });
        deps.log?.(`memory pressure: the ${step.action} step could not complete`);
        completed = false;
        break;
      }
      ran.push(step.action);
      results.push(rowOf(step.action, outcome));
      // A cheap look between steps: pressure this worker found itself and has
      // already relieved does not need the rest of the list, and stopping
      // there is a completed pass. Evidence that has gone missing stops it
      // too: acting on nothing is exactly what this controller must not do.
      // A directive is not stopped either way — the host asked on evidence of
      // its own, and every step here is safe.
      if (stopWhenRelieved && index < steps.length - 1) {
        const seen = await probe();
        if (disposed) {
          completed = false;
          stopped = seen;
          break;
        }
        const relieved = seen.reading.level === "normal" || belowRelease(seen.reading, passLevel);
        if (seen.reading.level === "unknown" || relieved) {
          // Carried out rather than dropped: this probe may be the only place
          // the level changed, and a change nobody reports leaves the host
          // believing a warning that has passed.
          stopped = seen;
          break;
        }
      }
    }
    // Quiet is exactly "nothing was there to give": a step that could not be
    // measured, one that ran out of budget and one that threw are not quiet,
    // and none of them earns the long cooldown.
    const quiet = results.length > 0 && results.every((row) => row.outcome === "nothing_to_give" || row.outcome === "held");
    return { completed, ran, results, quiet, ...(stopped ? { stopped } : {}) };
  };

  /**
   * The level an action report carries.
   *
   * Never `normal` and never `unknown`: the wire refuses rows beside either,
   * and rightly — actions were taken because something was true. So the report
   * carries the level that authorized them, or the post-pass level when that is
   * still pressure, and any transition the post-pass probe implies is a
   * separate, row-less report.
   */
  const reportedLevelFor = (authorized: MemoryPressureDirectiveLevel): MemoryPressureDirectiveLevel =>
    isDirectiveLevel(level) ? level : authorized;

  const selfPass = async (authorized: MemoryPressureDirectiveLevel, sample: PressureSample, reading: PressureReading): Promise<void> => {
    const outcome = await runPass(authorized, true);
    lastPassAtMs = now();
    lastPassLevel = authorized;
    lastPassQuiet = outcome.quiet;
    // The probe that stopped the pass is the state of this worker now; only a
    // pass that ran to its end needs another one.
    const after = outcome.stopped ?? (await probe());
    if (disposed) return;
    if (outcome.ran.length > 0) {
      const reported = reportedLevelFor(authorized);
      // The inputs beside action rows are the ones that authorized them, unless
      // the pass ended with this worker still under pressure and a fresher
      // reading says so.
      const useAfter = isDirectiveLevel(after.reading.level);
      const rowsSample = useAfter ? after.sample : sample;
      const rowsReading = useAfter ? after.reading : reading;
      queue(reportOf(reported, rowsSample, rowsReading, outcome.ran, outcome.results, now()), "action");
    }
    if (after.changed && lastSample) {
      queue(reportOf(level, lastSample.sample, lastSample.reading, [], [], now()), "state");
    }
  };

  // --- scheduling ----------------------------------------------------------

  const armTimer = (): void => {
    if (disposed || !started) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      void tick();
    }, cadence());
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const scheduledProbe = async (): Promise<void> => {
    if (disposed) return;
    const seen = await probe();
    if (disposed) return;
    const passing = isDirectiveLevel(level) && generation !== undefined && !inCooldown(now());
    // A change that leads straight into a pass is not reported twice: the
    // action report carries this level and these readings, and a state-only
    // report before it would take the window the rows need.
    if (seen.changed && lastSample && !passing) {
      queue(reportOf(level, lastSample.sample, lastSample.reading, [], [], now()), "state");
    }
    if (!passing || !isDirectiveLevel(level)) return;
    await selfPass(level, seen.sample, seen.reading);
  };

  const tick = async (): Promise<void> => {
    try {
      await serialize(scheduledProbe);
    } finally {
      armTimer();
    }
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      armTimer();
    },
    async directive(params) {
      counters.directives += 1;
      // The answer crosses the contract's own parser before it crosses the
      // link (RP-8 §B): a row this controller built wrongly is this worker's
      // fault, and the host is told a plain refusal rather than something the
      // contract forbids.
      const validate = (result: MemoryPressureDirectiveResultInput): ValidatedMemoryPressureDirectiveResult => {
        try {
          return parseMemoryPressureDirectiveResult(result);
        } catch {
          deps.log?.("memory pressure: a directive answer did not match the contract and was refused instead");
          counters.invalidReports += 1;
          return parseMemoryPressureDirectiveResult({ applied: false, ran: [], results: [], stores: {} });
        }
      };
      const refused: MemoryPressureDirectiveResultInput = { applied: false, ran: [], results: [], stores: safeStores() };
      if (disposed) return validate(refused);
      // A fence this worker cannot prove is not a fence: without a generation
      // it refuses every directive rather than acting on an unchecked one.
      if (generation === undefined || params.generation !== generation) return validate(refused);
      // Every other decision is taken inside the queue, against the state as it
      // is when this directive's turn comes: two directives racing must not
      // both pass a check taken before either of them ran.
      return serialize(async () => {
        if (disposed) return validate({ ...refused, stores: safeStores() });
        // An epoch older than the newest one this worker has *seen* is stale,
        // whether or not that newer one was allowed to act: a cooldown refusal
        // still fences what came before it.
        if (params.epoch < highestEpochSeen) return validate({ ...refused, stores: safeStores() });
        highestEpochSeen = Math.max(highestEpochSeen, params.epoch);
        if (inCooldown(now())) return validate({ ...refused, stores: safeStores() });
        // The host asked, and every step here is safe: this worker runs them
        // even when its own evidence is unknown (D-262 §5).
        const before = lastSample;
        const outcome = await runPass(params.level, false);
        lastPassAtMs = now();
        lastPassLevel = params.level;
        lastPassQuiet = outcome.quiet;
        const after = await probe();
        // A directive's own probe may move this worker's level; that is a
        // state change of its own and is reported without any of these rows.
        if (after.changed && lastSample && !disposed) {
          queue(reportOf(level, lastSample.sample, lastSample.reading, [], [], now()), "state");
        }
        void before;
        return validate({
          applied: outcome.completed,
          ran: outcome.ran,
          results: outcome.results,
          stores: safeStores(),
        });
      });
    },
    probeNow() {
      return serialize(scheduledProbe);
    },
    counters() {
      return { ...counters, level };
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      if (flushTimer !== undefined) cancel(flushTimer);
      flushTimer = undefined;
      pendingAction = undefined;
      pendingState = undefined;
    },
  };
}

/** The three steps, named where a reader of the server can see them. */
export const WORKER_PRESSURE_STEPS: readonly MemoryPressureAction[] = MEMORY_PRESSURE_WORKER_ACTIONS;

/** Level helpers a test and the server share. */
export { LEVEL_SEVERITY };
export type { MemoryPressureLevel };
