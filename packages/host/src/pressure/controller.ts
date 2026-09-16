/**
 * The host's own answer for memory pressure (RP-8), milestone E1: evidence and
 * the record.
 *
 * One controller, one serialized chain, one journal. It samples this process
 * and this machine, settles a level for each of them, takes in the reports its
 * workers send unasked — bound to the exact process that delivered them — and
 * publishes one fixed-size summary to the windows on this machine.
 *
 * What it deliberately does **not** do yet: it releases nothing, asks no worker
 * for anything, unloads no conversation, retires no worker and refuses no
 * admission. Those are the host's ordered steps 1, 5, 6 and 7, and they are
 * milestones E2 and E3. Everything here is observation, arithmetic and
 * bookkeeping, so that when the acting arrives it acts on evidence that was
 * already proved.
 *
 * Three rules are structural rather than stylistic:
 *
 * - **Missing evidence is missing.** A level nothing could establish is
 *   `"unknown"`, never `"normal"`; a counter nobody could read is `unavailable`
 *   with a reason, never a zero; an age that is not an exact non-negative
 *   integer is left out rather than reported as none.
 * - **Nothing a worker sends chooses its own identity.** A report is bound to
 *   the delivering process's private numeric generation *and* to the opaque
 *   client generation, re-read inside this chain before anything is recorded.
 * - **A failure is categorical.** A sampler, a store, a publication or a parse
 *   that fails is counted and named in one fixed sentence; it never throws into
 *   a timer, never retries, and never takes the host with it.
 */
import {
  aggregateMemoryPressureLevel,
  memoryPressureReportSchema,
  parseMemoryPressurePublish,
  parseMemoryPressureSummary,
  type JsonRpcNotification,
  type MemoryPressureCoverage,
  type MemoryPressureExportSection,
  type MemoryPressureInput,
  type MemoryPressureLevel,
  type MemoryPressureLevelState,
  type MemoryPressureRole,
  type MemoryPressureRoleState,
  type MemoryPressureSummary,
  type ValidatedMemoryPressureJournalPage,
  type ValidatedMemoryPressurePublish,
  type ValidatedMemoryPressureSummary,
} from "@lasercode/protocol";
import { PressureJournal } from "./journal.js";
import {
  LEVEL_SEVERITY,
  belowRelease,
  blindSample,
  probeOf,
  type HostPressureProbe,
  type HostPressureSample,
  type PressureReading,
  type UsableInput,
} from "./sampler.js";
import {
  HOST_PRESSURE_ELEVATED_INTERVAL_MS,
  HOST_PRESSURE_ESCALATE_SAMPLES,
  HOST_PRESSURE_NORMAL_INTERVAL_MS,
  HOST_PRESSURE_PUBLISH_WINDOW_MS,
  HOST_PRESSURE_RELEASE_SAMPLES,
  HOST_PRESSURE_STALE_CADENCES,
  HOST_PRESSURE_THRESHOLDS,
  MACHINE_PRESSURE_THRESHOLDS,
  WORKER_REPORT_FRESH_MS,
  type HostPressureThresholds,
  type MachinePressureThresholds,
} from "./thresholds.js";

/** One live worker, as the host currently knows it. */
export interface HostPressureWorker {
  cwd: string;
  /** The opaque per-process identity (RP-7). Host-internal; never published. */
  clientGeneration: string;
  /** The private numeric spawn generation (D-262). Host-internal; never published. */
  workerGeneration: number;
}

export interface HostPressureDeps {
  /** This process and this machine, read by us, about us. Never throws upward. */
  sample(): Promise<HostPressureSample>;
  /** Live, ready, non-warm workers that carry a private generation. */
  workers(): HostPressureWorker[];
  /** One validated publication to the windows on this machine. Local sockets only. */
  publish(publication: ValidatedMemoryPressurePublish): void;
  /** The inventory's opaque salted project id (RP-1), when there is one. */
  projectIdOf?: (cwd: string) => string | undefined;
  /** Whether a window is connected at all, for the renderer row's coverage. */
  rendererPresent: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** A categorical line for the host's own log. Never a report, never a path. */
  log?: (line: string) => void;
}

export interface HostPressureOptions {
  hostThresholds?: HostPressureThresholds;
  machineThresholds?: MachinePressureThresholds;
  normalIntervalMs?: number;
  elevatedIntervalMs?: number;
  publishWindowMs?: number;
  /** How old a worker's report may be before that worker is unanswered. */
  workerFreshMs?: number;
  journal?: PressureJournal;
}

export interface HostPressureCounters {
  /** The level the host would act on: host, machine and the worker aggregate. */
  level: MemoryPressureLevelState;
  hostLevel: MemoryPressureLevelState;
  machineLevel: MemoryPressureLevelState;
  workerLevel: MemoryPressureLevelState;
  epoch: number;
  probes: number;
  samples: number;
  sampleFailures: number;
  staleSamples: number;
  transitions: number;
  publications: number;
  publishFailures: number;
  publishCoalesced: number;
  invalidPublications: number;
  invalidSummaries: number;
  /** Reports that arrived and were believed. */
  reportsAccepted: number;
  /** Rows those reports contributed to the journal. */
  reportRows: number;
  /** Reports refused at the boundary, by the reason they were refused. */
  reportsUnidentified: number;
  reportsMalformed: number;
  reportsGenerationMismatch: number;
  reportsStaleClient: number;
  /** Workers whose evidence was dropped because that exact process went away. */
  workersForgotten: number;
  journal: { events: number; bytes: number; lastEvictedBy?: "age" | "events" | "bytes"; refusedRows: number };
}

export interface HostPressureController {
  start(): void;
  dispose(): void;
  /**
   * Worker → host ingress. `source` is what the pool proved about the exact
   * process whose pipe delivered this message.
   */
  observeWorkerReport(
    cwd: string,
    notification: JsonRpcNotification,
    source: { generation: string; workerGeneration: number | undefined },
  ): void;
  /** That exact process is gone: its evidence stops counting immediately. */
  forgetWorker(cwd: string, clientGeneration: string): void;
  summary(): ValidatedMemoryPressureSummary;
  journalPage(): ValidatedMemoryPressureJournalPage;
  exportSection(): MemoryPressureExportSection;
  /** Run one probe now and settle. The test seam for the clock. */
  probeNow(): Promise<void>;
  counters(): HostPressureCounters;
}

interface WorkerEvidence {
  clientGeneration: string;
  workerGeneration: number;
  /** The host's own receipt time. A worker's clock is never used. */
  receiptAtMs: number;
  /** The age the worker reported, when it reported a usable one. */
  reportedAgeMs: number | undefined;
  level: MemoryPressureLevelState;
  inputs: MemoryPressureInput[];
}

interface RoleState {
  level: MemoryPressureLevelState;
  streakLevel: MemoryPressureLevelState | undefined;
  streak: number;
}

const isDirectiveLevel = (level: MemoryPressureLevelState): level is MemoryPressureLevel =>
  level === "warning" || level === "critical";

/** A role nobody could measure, said out loud. */
function unknownCoverage(): MemoryPressureCoverage {
  return { expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" };
}

/** A role with genuinely nothing in it: no live worker, no window. */
function emptyCoverage(): MemoryPressureCoverage {
  return { expected: 0, answered: 0, complete: true };
}

export function createHostPressureController(deps: HostPressureDeps, options: HostPressureOptions = {}): HostPressureController {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  /**
   * Every timer this controller owns is unref'd, whoever made it: measuring
   * memory is never a reason for a process to stay alive. The default timer is
   * asked twice, harmlessly, rather than leaving an injected one to remember.
   */
  const schedule = (fn: () => void, ms: number): unknown => {
    const handle = setTimer(fn, ms);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    return handle;
  };
  const hostThresholds = options.hostThresholds ?? HOST_PRESSURE_THRESHOLDS;
  const machineThresholds = options.machineThresholds ?? MACHINE_PRESSURE_THRESHOLDS;
  const normalIntervalMs = options.normalIntervalMs ?? HOST_PRESSURE_NORMAL_INTERVAL_MS;
  const elevatedIntervalMs = options.elevatedIntervalMs ?? HOST_PRESSURE_ELEVATED_INTERVAL_MS;
  const publishWindowMs = options.publishWindowMs ?? HOST_PRESSURE_PUBLISH_WINDOW_MS;
  const workerFreshMs = options.workerFreshMs ?? WORKER_REPORT_FRESH_MS;
  const journal = options.journal ?? new PressureJournal({ now });

  let disposed = false;
  let started = false;
  let timer: unknown;
  let chain: Promise<void> = Promise.resolve();
  let epoch = 0;
  let lastProbe: HostPressureProbe | undefined;
  const states: Record<"host" | "machine", RoleState> = {
    host: { level: "unknown", streakLevel: undefined, streak: 0 },
    machine: { level: "unknown", streakLevel: undefined, streak: 0 },
  };
  const evidence = new Map<string, WorkerEvidence>();
  let lastSignature: string | undefined;
  let lastSummary: ValidatedMemoryPressureSummary | undefined;
  let pending: { epoch: number; summary: ValidatedMemoryPressureSummary } | undefined;
  let windowUntilMs = 0;
  let publishTimer: unknown;

  const counters = {
    probes: 0,
    samples: 0,
    sampleFailures: 0,
    staleSamples: 0,
    transitions: 0,
    publications: 0,
    publishFailures: 0,
    publishCoalesced: 0,
    invalidPublications: 0,
    invalidSummaries: 0,
    reportsAccepted: 0,
    reportRows: 0,
    reportsUnidentified: 0,
    reportsMalformed: 0,
    reportsGenerationMismatch: 0,
    reportsStaleClient: 0,
    workersForgotten: 0,
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // --- levels --------------------------------------------------------------

  const forgetStreak = (state: RoleState): void => {
    state.streakLevel = undefined;
    state.streak = 0;
  };

  const settle = (state: RoleState, next: MemoryPressureLevelState): boolean => {
    // The candidate is dropped whether or not the level moves: a sample that
    // disagrees with the one before it has broken the run, and a run is what a
    // change is made of.
    forgetStreak(state);
    if (next === state.level) return false;
    state.level = next;
    counters.transitions += 1;
    return true;
  };

  /** Fold one reading into one role's level. Returns true when it changed. */
  const observe = (state: RoleState, reading: PressureReading): boolean => {
    // Unknown is immediate: evidence that has gone missing is not something to
    // wait out, and it is never allowed to settle as `normal`.
    if (reading.level === "unknown") return settle(state, "unknown");
    if (reading.level === state.level) {
      forgetStreak(state);
      return false;
    }
    const escalating = LEVEL_SEVERITY[reading.level] > LEVEL_SEVERITY[state.level] || state.level === "unknown";
    const needed = escalating ? HOST_PRESSURE_ESCALATE_SAMPLES : HOST_PRESSURE_RELEASE_SAMPLES;
    if (!escalating && isDirectiveLevel(state.level) && !belowRelease(reading, state.level)) {
      // Still above the release line: a value hovering on a threshold does not
      // get to flap.
      forgetStreak(state);
      return false;
    }
    state.streak = state.streakLevel === reading.level ? state.streak + 1 : 1;
    state.streakLevel = reading.level;
    if (state.streak < needed) return false;
    return settle(state, reading.level);
  };

  // --- workers -------------------------------------------------------------

  /**
   * How old a worker's evidence is: how long we have held it, plus the age the
   * worker said it already had. Every step is checked, and anything that is not
   * an exact non-negative integer makes the answer missing rather than zero.
   */
  const freshnessAgeMs = (record: WorkerEvidence, at: number): number | undefined => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(record.receiptAtMs)) return undefined;
    const held = at - record.receiptAtMs;
    if (!Number.isSafeInteger(held) || held < 0) return undefined;
    const reported = record.reportedAgeMs;
    if (reported === undefined || !Number.isSafeInteger(reported) || reported < 0) return undefined;
    const total = held + reported;
    return Number.isSafeInteger(total) ? total : undefined;
  };

  interface WorkerRow {
    level: MemoryPressureLevelState;
    coverage: MemoryPressureCoverage;
    inputs: MemoryPressureInput[];
    sampleAgeMs: number | undefined;
  }

  const workerRow = (at: number): WorkerRow => {
    let live: HostPressureWorker[];
    try {
      live = deps.workers();
    } catch {
      // The pool could not say what it is running. That is missing coverage,
      // not an empty fleet.
      return { level: "unknown", coverage: unknownCoverage(), inputs: [], sampleAgeMs: undefined };
    }
    if (live.length === 0) {
      // Genuinely nothing to measure: no live worker is not a missing reading.
      return { level: "normal", coverage: emptyCoverage(), inputs: [], sampleAgeMs: undefined };
    }
    const answered: Array<{ record: WorkerEvidence; age: number }> = [];
    for (const worker of live) {
      const record = evidence.get(worker.cwd);
      if (!record || record.clientGeneration !== worker.clientGeneration || record.workerGeneration !== worker.workerGeneration) continue;
      const age = freshnessAgeMs(record, at);
      if (age === undefined || age > workerFreshMs) continue;
      answered.push({ record, age });
    }
    const levels: MemoryPressureLevelState[] = answered.map((row) => row.record.level);
    // A worker that is live and has not been heard from is unanswered, and an
    // unanswered worker is unknown — never normal, and never a zero.
    if (answered.length < live.length) levels.push("unknown");
    const level = aggregateMemoryPressureLevel(levels);
    const coverage: MemoryPressureCoverage =
      answered.length === live.length
        ? { expected: live.length, answered: answered.length, complete: true }
        : { expected: live.length, answered: answered.length, complete: false, reason: "incomplete_coverage" };
    if (level === "unknown") {
      // The aggregate rests on evidence somebody could not give; showing one
      // worker's numbers beside it would explain the wrong thing.
      return { level, coverage, inputs: [], sampleAgeMs: undefined };
    }
    // One row carries one input per kind, so it carries *one* worker's: the
    // worst of them, which is the one this level came from. Ties go to the most
    // recently received.
    let chosen: { record: WorkerEvidence; age: number } | undefined;
    for (const row of answered) {
      if (!chosen) {
        chosen = row;
        continue;
      }
      const better = LEVEL_SEVERITY[row.record.level] - LEVEL_SEVERITY[chosen.record.level];
      if (better > 0 || (better === 0 && row.record.receiptAtMs > chosen.record.receiptAtMs)) chosen = row;
    }
    return {
      level,
      coverage,
      inputs: chosen ? chosen.record.inputs : [],
      sampleAgeMs: chosen?.age,
    };
  };

  // --- the summary ---------------------------------------------------------

  const inputsOfHost = (sample: HostPressureSample, usable: readonly UsableInput[]): MemoryPressureInput[] => {
    const heap = usable.find((row) => row.kind === "heap");
    const inputs: MemoryPressureInput[] = [
      {
        kind: "physical",
        value: sample.physical,
        warningBytes: hostThresholds.warningBytes,
        criticalBytes: hostThresholds.criticalBytes,
      },
      heap
        ? { kind: "heap", value: sample.heapUsed, warningBytes: heap.warningBytes, criticalBytes: heap.criticalBytes }
        : { kind: "heap", value: sample.heapUsed },
    ];
    return inputs;
  };

  const ageOf = (sample: HostPressureSample, at: number): number | undefined => {
    const age = at - sample.atMs;
    return Number.isSafeInteger(age) && age >= 0 ? age : undefined;
  };

  const roleRow = (role: MemoryPressureRole, at: number): MemoryPressureRoleState => {
    if (role === "project_worker") {
      const row = workerRow(at);
      return {
        role,
        level: row.level,
        ...(row.sampleAgeMs !== undefined ? { sampleAgeMs: row.sampleAgeMs } : {}),
        inputs: row.inputs,
        coverage: row.coverage,
      };
    }
    if (role === "desktop_renderer") {
      // Milestone F owns the producer. Until then a window that is connected but
      // has told us nothing is missing coverage, and no window at all is a role
      // with genuinely nothing in it.
      let present = false;
      try {
        present = deps.rendererPresent();
      } catch {
        present = true;
      }
      return present
        ? { role, level: "unknown", inputs: [], coverage: unknownCoverage() }
        : { role, level: "normal", inputs: [], coverage: emptyCoverage() };
    }
    const probe = lastProbe;
    if (!probe) return { role, level: "unknown", inputs: [], coverage: unknownCoverage() };
    if (role === "host") {
      const answered = probe.host.usable.length > 0;
      const age = ageOf(probe.sample, at);
      return {
        role,
        level: states.host.level,
        ...(age !== undefined ? { sampleAgeMs: age } : {}),
        inputs: inputsOfHost(probe.sample, probe.host.usable),
        ceiling: { measuredLimit: probe.sample.heapLimit },
        coverage: answered
          ? { expected: 1, answered: 1, complete: true }
          : unknownCoverage(),
      };
    }
    const answered = probe.machine.usable.length > 0;
    const age = ageOf(probe.sample, at);
    return {
      role,
      level: states.machine.level,
      ...(age !== undefined ? { sampleAgeMs: age } : {}),
      inputs: [
        {
          kind: "machine_available",
          value: probe.sample.machineAvailable,
          warningBytes: machineThresholds.warningBytes,
          criticalBytes: machineThresholds.criticalBytes,
        },
      ],
      coverage: answered ? { expected: 1, answered: 1, complete: true } : unknownCoverage(),
    };
  };

  /** A summary this module can always produce, whatever else failed. */
  const blindSummary = (): MemoryPressureSummary => ({
    level: "unknown",
    roles: (["host", "project_worker", "desktop_renderer", "machine"] as const).map((role) => ({
      role,
      level: "unknown" as const,
      inputs: [],
      coverage: unknownCoverage(),
    })),
    refusing: [],
    totals: { events: 0, released: { count: 0, bytes: 0 }, refusals: 0 },
  });

  const buildSummary = (): ValidatedMemoryPressureSummary => {
    const at = now();
    let candidate: MemoryPressureSummary;
    try {
      const roles = (["host", "project_worker", "desktop_renderer", "machine"] as const).map((role) => roleRow(role, at));
      const totals = journal.totals();
      const latestEventId = journal.latestEventId();
      candidate = {
        level: aggregateMemoryPressureLevel(roles.map((row) => row.level)),
        roles,
        // Milestone E3 owns step 7; nothing is being refused for memory yet.
        refusing: [],
        totals,
        ...(latestEventId !== undefined ? { latestEventId } : {}),
      };
    } catch {
      candidate = blindSummary();
    }
    try {
      const validated = parseMemoryPressureSummary(candidate);
      lastSummary = validated;
      return validated;
    } catch {
      // A summary this controller built wrongly is its own fault, and a surface
      // is told the last thing that was true rather than something invalid.
      counters.invalidSummaries += 1;
      deps.log?.("memory pressure: a summary did not match the contract and was not published");
      return lastSummary ?? parseMemoryPressureSummary(blindSummary());
    }
  };

  /** The decision level: this host, this machine, and its workers. */
  const decisionLevel = (summary: ValidatedMemoryPressureSummary): MemoryPressureLevelState =>
    aggregateMemoryPressureLevel(
      summary.roles.filter((row) => row.role !== "desktop_renderer").map((row) => row.level),
    );

  // --- publication ---------------------------------------------------------

  const signatureOf = (summary: ValidatedMemoryPressureSummary): string =>
    JSON.stringify([
      summary.level,
      summary.roles.map((row) => [row.role, row.level, row.coverage.expected, row.coverage.answered]),
      summary.refusing,
      summary.totals.events,
      summary.totals.released.count,
      summary.totals.released.bytes,
      summary.totals.refusals,
      summary.latestEventId ?? null,
    ]);

  const send = (publication: { epoch: number; summary: ValidatedMemoryPressureSummary }): void => {
    let validated: ValidatedMemoryPressurePublish;
    try {
      validated = parseMemoryPressurePublish(publication);
    } catch {
      counters.invalidPublications += 1;
      deps.log?.("memory pressure: a publication did not match the contract and was not sent");
      return;
    }
    try {
      deps.publish(validated);
    } catch {
      // A diagnostic that cannot be delivered is counted and forgotten: never
      // retried, never queued for later, never fatal. The next state this host
      // reaches is published on its own.
      counters.publishFailures += 1;
      deps.log?.("memory pressure: a summary could not be published and was dropped");
      return;
    }
    counters.publications += 1;
  };

  const flush = (): void => {
    if (disposed) return;
    const at = now();
    if (at < windowUntilMs) {
      if (publishTimer === undefined) {
        publishTimer = schedule(() => {
          publishTimer = undefined;
          flush();
        }, windowUntilMs - at);
      }
      return;
    }
    const next = pending;
    if (!next) return;
    pending = undefined;
    windowUntilMs = at + publishWindowMs;
    send(next);
  };

  /** Rebuild the summary and publish it when something a reader cares about moved. */
  const refresh = (): ValidatedMemoryPressureSummary => {
    const summary = buildSummary();
    const signature = signatureOf(summary);
    if (signature === lastSignature) return summary;
    lastSignature = signature;
    if (disposed) return summary;
    epoch += 1;
    // Only the newest state survives a window: an older pending publication is
    // replaced rather than queued, because the newer one says everything it did.
    if (pending) counters.publishCoalesced += 1;
    pending = { epoch, summary };
    flush();
    return summary;
  };

  // --- probing -------------------------------------------------------------

  const cadence = (): number => {
    const summary = lastSummary;
    const level = summary ? decisionLevel(summary) : "unknown";
    return isDirectiveLevel(level) ? elevatedIntervalMs : normalIntervalMs;
  };

  const blindReading: PressureReading = { level: "unknown", usable: [] };

  const probe = async (): Promise<void> => {
    let sample: HostPressureSample;
    try {
      sample = await deps.sample();
      counters.samples += 1;
    } catch {
      // A sampler that failed is still a fact about this host: the level becomes
      // unknown and the transition is published like any other, with readings
      // that say they could not be taken rather than numbers nobody read.
      counters.sampleFailures += 1;
      sample = blindSample(now());
      lastProbe = { sample, host: blindReading, machine: blindReading, level: "unknown" };
      counters.probes += 1;
      observe(states.host, blindReading);
      observe(states.machine, blindReading);
      refresh();
      return;
    }
    counters.probes += 1;
    const at = now();
    let probed = probeOf(sample, hostThresholds, machineThresholds);
    if (at - sample.atMs > HOST_PRESSURE_STALE_CADENCES * cadence()) {
      // Old enough that it is not evidence any more. Not a reason to act, and
      // not a reason to say everything is fine.
      counters.staleSamples += 1;
      probed = { sample, host: blindReading, machine: blindReading, level: "unknown" };
    }
    lastProbe = probed;
    // Both, without short-circuiting: each role settles on its own evidence.
    observe(states.host, probed.host);
    observe(states.machine, probed.machine);
    refresh();
  };

  const armTimer = (): void => {
    if (disposed || !started) return;
    if (timer !== undefined) clearTimer(timer);
    timer = schedule(() => {
      timer = undefined;
      void tick();
    }, cadence());
  };

  const tick = async (): Promise<void> => {
    try {
      await serialize(async () => {
        if (disposed) return;
        await probe();
      });
    } finally {
      armTimer();
    }
  };

  // --- ingress -------------------------------------------------------------

  const observeWorkerReport = (
    cwd: string,
    notification: JsonRpcNotification,
    source: { generation: string; workerGeneration: number | undefined },
  ): void => {
    if (disposed) return;
    // The host's own receipt time, taken before anything else: a worker's clock
    // never decides how old its evidence is here.
    const receiptAtMs = now();
    if (source.workerGeneration === undefined) {
      counters.reportsUnidentified += 1;
      return;
    }
    const parsed = memoryPressureReportSchema.safeParse(notification.params);
    if (!parsed.success) {
      // Categorical: what was wrong with it is not said, because saying it would
      // mean putting a worker's message into this host's log.
      counters.reportsMalformed += 1;
      deps.log?.("memory pressure: a worker's report did not match the contract and was dropped");
      return;
    }
    const report = parsed.data;
    if (report.generation !== source.workerGeneration) {
      counters.reportsGenerationMismatch += 1;
      return;
    }
    void serialize(async () => {
      if (disposed) return;
      // Re-read on this side of the queue: between the message arriving and its
      // turn coming, the process that sent it may have been replaced, and a
      // report from a process that is gone changes nothing.
      let live: HostPressureWorker[];
      try {
        live = deps.workers();
      } catch {
        counters.reportsStaleClient += 1;
        return;
      }
      const current = live.find((worker) => worker.cwd === cwd);
      if (!current || current.clientGeneration !== source.generation || current.workerGeneration !== source.workerGeneration) {
        counters.reportsStaleClient += 1;
        return;
      }
      evidence.set(cwd, {
        clientGeneration: current.clientGeneration,
        workerGeneration: current.workerGeneration,
        receiptAtMs,
        reportedAgeMs: report.sampleAgeMs,
        level: report.level,
        inputs: report.inputs,
      });
      counters.reportsAccepted += 1;
      // A worker's autonomous report owns the rows of the pass it ran, and those
      // rows are recorded once. The wire already guarantees there are none at
      // `normal` or `unknown`.
      if (isDirectiveLevel(report.level)) {
        let project: string | undefined;
        try {
          project = deps.projectIdOf?.(cwd);
        } catch {
          project = undefined;
        }
        for (const row of report.results) {
          const event = journal.add(row, { role: "project_worker", level: report.level, ...(project ? { project } : {}) });
          if (event) counters.reportRows += 1;
        }
      }
      refresh();
    });
  };

  const forgetWorker = (cwd: string, clientGeneration: string): void => {
    const record = evidence.get(cwd);
    if (!record || record.clientGeneration !== clientGeneration) return;
    evidence.delete(cwd);
    counters.workersForgotten += 1;
    if (!disposed) refresh();
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      armTimer();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (publishTimer !== undefined) clearTimer(publishTimer);
      publishTimer = undefined;
      pending = undefined;
      evidence.clear();
    },
    observeWorkerReport,
    forgetWorker,
    summary() {
      return buildSummary();
    },
    journalPage() {
      return journal.page();
    },
    exportSection() {
      return { summary: buildSummary(), journal: journal.page() };
    },
    probeNow() {
      return serialize(async () => {
        if (disposed) return;
        await probe();
      });
    },
    counters() {
      const summary = lastSummary;
      return {
        level: summary ? decisionLevel(summary) : "unknown",
        hostLevel: states.host.level,
        machineLevel: states.machine.level,
        workerLevel: summary?.roles.find((row) => row.role === "project_worker")?.level ?? "unknown",
        epoch,
        ...counters,
        journal: journal.counts(),
      };
    },
  };
}
