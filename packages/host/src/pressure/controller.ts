/**
 * RP-8 host evidence and record. One serialized controller samples this host,
 * binds worker evidence to both private generations, publishes a fixed summary
 * locally, and invokes E2's bounded pass at settled warning/critical. Missing
 * evidence stays unknown; failures are categorical and never retried. E3
 * admission is deliberately absent.
 */
import {
  MEMORY_PRESSURE_EVENTS_MAX,
  MEMORY_PRESSURE_EVENTS_MAX_BYTES,
  MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
  aggregateMemoryPressureLevel,
  memoryPressureReportSchema,
  parseMemoryPressureJournalPage,
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
  createHostPressurePass,
  type HostPressureActions,
  type HostPressurePassCounters,
  type HostPressureWorker,
} from "./pass.js";
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

export type { HostPressureActions, HostPressureWorker } from "./pass.js";

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
  /** Absent keeps the E1 controller observational (and its tests unchanged). */
  actions?: HostPressureActions;
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
  directiveStageMs?: number;
  workerDirectiveSkipMs?: number;
}

/** The seams this controller reaches out through, for counting their failures. */
export type HostPressureCallback =
  | "sample"
  | "workers"
  | "publish"
  | "projectId"
  | "rendererPresent"
  | "log"
  | "releaseEphemeral"
  | "unloadIdle"
  | "retireIdle";

export interface HostPressureCounters extends HostPressurePassCounters {
  /**
   * The settled level of the combined probe: what E2 and E3 act on, and what a
   * transition is published for. Hysteresis lives here and nowhere else.
   */
  level: MemoryPressureLevelState;
  /** The latest *readings*, which are evidence rather than decisions. */
  hostLevel: MemoryPressureLevelState;
  machineLevel: MemoryPressureLevelState;
  workerLevel: MemoryPressureLevelState;
  /** Every seam that threw, by kind. Counted, never retried, never fatal. */
  callbackFailed: Record<HostPressureCallback, number>;
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
  hostRows: number;
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

interface DecisionState {
  level: MemoryPressureLevelState;
  streakLevel: MemoryPressureLevelState | undefined;
  streak: number;
}

const isDirectiveLevel = (level: MemoryPressureLevelState): level is "warning" | "critical" =>
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
  const directiveStageMs = options.directiveStageMs ?? 5_000;
  const workerDirectiveSkipMs = options.workerDirectiveSkipMs ?? 30_000;
  const journal = options.journal ?? new PressureJournal({ now });

  let disposed = false;
  let started = false;
  let timer: unknown;
  let chain: Promise<void> = Promise.resolve();
  let epoch = 0;
  let lastProbe: HostPressureProbe | undefined;
  /**
   * The one state machine: the settled level of the **combined** probe.
   *
   * The role rows in a summary are *readings* — what the last probe could see,
   * per role — and this is the *decision*: what E2 and E3 will act on, and what
   * a published transition is about. They are deliberately different things. A
   * role row may move on one sample, because it is evidence and a person
   * reading it is owed the newest evidence; the decision moves only on two
   * agreeing probes, and comes back only on three that are well inside the line
   * it crossed. Publication coalescing bounds how often a row's movement can
   * reach a window.
   */
  const decision: DecisionState = { level: "unknown", streakLevel: undefined, streak: 0 };
  const evidence = new Map<string, WorkerEvidence>();
  let lastSignature: string | undefined;
  let lastSummary: ValidatedMemoryPressureSummary | undefined;
  let pending: { epoch: number; summary: ValidatedMemoryPressureSummary } | undefined;
  let windowUntilMs = 0;
  let publishTimer: unknown;

  const callbackFailed: Record<HostPressureCallback, number> = {
    sample: 0,
    workers: 0,
    publish: 0,
    projectId: 0,
    rendererPresent: 0,
    log: 0,
    releaseEphemeral: 0,
    unloadIdle: 0,
    retireIdle: 0,
  };

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
    passes: 0,
    passCooldownSkips: 0,
    passFailures: 0,
    directivesSent: 0,
    directivesTimedOut: 0,
    directivesMalformed: 0,
    directivesRefused: 0,
    directivesStale: 0,
    directivesFailed: 0,
    directivesLate: 0,
    hostRows: 0,
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // --- the seams this controller reaches out through ----------------------

  /**
   * One categorical line for this host's own log, and never anything more.
   *
   * A logger that throws is a fault of the log, not of memory pressure: it is
   * counted and forgotten, and it is deliberately not logged — the only thing
   * that could carry that news is the seam that just failed.
   */
  const note = (line: string): void => {
    try {
      deps.log?.(line);
    } catch {
      callbackFailed.log += 1;
    }
  };

  /**
   * Call out of this controller without letting anything back in.
   *
   * Every dependency here belongs to another part of the host — the pool, the
   * inventory, the socket layer — and any of them may be in trouble at exactly
   * the moment memory is short. A throw is counted by kind, answered with the
   * honest fallback, never retried, and never allowed to escape into a timer,
   * into worker-notification handling or into a diagnostic read.
   */
  const safely = <T>(kind: HostPressureCallback, call: () => T, fallback: T): T => {
    try {
      return call();
    } catch {
      callbackFailed[kind] += 1;
      note(`memory pressure: the ${kind} it depends on failed and was left out`);
      return fallback;
    }
  };

  const liveWorkers = (): HostPressureWorker[] | undefined => {
    try {
      return deps.workers();
    } catch {
      // The pool could not say what it is running. That is missing coverage,
      // not an empty fleet.
      callbackFailed.workers += 1;
      note("memory pressure: the worker list could not be read and was left out");
      return undefined;
    }
  };

  // --- levels --------------------------------------------------------------

  const forgetStreak = (state: DecisionState): void => {
    state.streakLevel = undefined;
    state.streak = 0;
  };

  const settle = (state: DecisionState, next: MemoryPressureLevelState): boolean => {
    // The candidate is dropped whether or not the level moves: a sample that
    // disagrees with the one before it has broken the run, and a run is what a
    // change is made of.
    forgetStreak(state);
    if (next === state.level) return false;
    state.level = next;
    counters.transitions += 1;
    return true;
  };

  /**
   * Fold one probe into the settled decision. Returns true when it changed.
   *
   * The reading it is given is the **combined** one: the level is the
   * protocol's aggregate of this host and this machine, and the inputs are
   * every reading either of them could take, so the release line is only
   * cleared when all of them are well inside it.
   */
  const observe = (state: DecisionState, reading: PressureReading): boolean => {
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
    const live = liveWorkers();
    if (live === undefined) return { level: "unknown", coverage: unknownCoverage(), inputs: [], sampleAgeMs: undefined };
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
      // with genuinely nothing in it. A question this host cannot answer is not
      // an answer of "no window": it is missing coverage too.
      const present = safely("rendererPresent", () => deps.rendererPresent(), true);
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
        // The reading, not the decision: a row is evidence about one role, and
        // the settled level the host acts on is the combined probe's.
        level: probe.host.level,
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
      level: probe.machine.level,
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

  /**
   * One page of the journal, or an empty valid one.
   *
   * A diagnostic read is never a place to throw: a snapshot and an export are
   * taken while something is already going wrong, and a page this controller
   * could not build is reported as an empty journal rather than as a failure of
   * the document that asked for it.
   */
  const safePage = (): ValidatedMemoryPressureJournalPage => {
    try {
      return journal.page();
    } catch {
      counters.invalidSummaries += 1;
      note("memory pressure: a journal page did not match the contract and was left empty");
      return parseMemoryPressureJournalPage({
        events: [],
        retention: {
          maxEvents: MEMORY_PRESSURE_EVENTS_MAX,
          maxAgeMs: MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
          maxBytes: MEMORY_PRESSURE_EVENTS_MAX_BYTES,
          events: 0,
          bytes: 0,
        },
      });
    }
  };

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
      note("memory pressure: a summary did not match the contract and was not published");
      return lastSummary ?? parseMemoryPressureSummary(blindSummary());
    }
  };

  // --- publication ---------------------------------------------------------

  const signatureOf = (summary: ValidatedMemoryPressureSummary): string =>
    JSON.stringify([
      // The settled decision is part of what a reader is told changed, beside
      // the readings themselves: a transition is the thing E2 and E3 act on.
      decision.level,
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
      note("memory pressure: a publication did not match the contract and was not sent");
      return;
    }
    try {
      deps.publish(validated);
    } catch {
      // A diagnostic that cannot be delivered is counted and forgotten: never
      // retried, never queued for later, never fatal. The next state this host
      // reaches is published on its own.
      counters.publishFailures += 1;
      callbackFailed.publish += 1;
      note("memory pressure: a summary could not be published and was dropped");
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

  const cadence = (): number => (isDirectiveLevel(decision.level) ? elevatedIntervalMs : normalIntervalMs);

  const blindReading: PressureReading = { level: "unknown", usable: [] };

  /**
   * The probe as the decision sees it: the protocol's aggregate of this host
   * and this machine, with every reading either of them could take, so a
   * release is only granted when all of them are well inside the line.
   */
  const combined = (probed: HostPressureProbe): PressureReading => ({
    level: probed.level,
    usable: [...probed.host.usable, ...probed.machine.usable],
  });

  const probe = async (updateDecision = true): Promise<HostPressureProbe> => {
    let sample: HostPressureSample;
    try {
      sample = await deps.sample();
      counters.samples += 1;
    } catch {
      // A sampler that failed is still a fact about this host: the level becomes
      // unknown and the transition is published like any other, with readings
      // that say they could not be taken rather than numbers nobody read.
      counters.sampleFailures += 1;
      callbackFailed.sample += 1;
      sample = blindSample(now());
      lastProbe = { sample, host: blindReading, machine: blindReading, level: "unknown" };
      counters.probes += 1;
      if (updateDecision) observe(decision, blindReading);
      refresh();
      return lastProbe;
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
    // One state machine, over the combined probe: two agreeing probes to
    // escalate, three inside the release line to come back, and any unknown
    // breaks both runs at once.
    if (updateDecision) observe(decision, combined(probed));
    refresh();
    return probed;
  };

  const pressurePass = deps.actions
    ? createHostPressurePass({
        actions: deps.actions,
        now,
        workers: liveWorkers,
        freshLevel(worker, at) {
          const record = evidence.get(worker.cwd);
          if (!record || record.clientGeneration !== worker.clientGeneration || record.workerGeneration !== worker.workerGeneration) return undefined;
          const age = freshnessAgeMs(record, at);
          return age !== undefined && age <= workerFreshMs ? record.level : undefined;
        },
        projectId: (cwd) => safely("projectId", () => deps.projectIdOf?.(cwd), undefined),
        addRow(row, role, level, project) {
          const event = journal.add(row, { role, level, ...(project ? { project } : {}) });
          if (event && role === "host") counters.hostRows += 1;
        },
        async reprobe(level) {
          const reading = combined(await probe(false));
          if (reading.level === "unknown") return "unknown";
          return belowRelease(reading, level) ? "relieved" : "still_elevated";
        },
        refresh,
        serialize,
        nextEpoch: () => ++epoch,
        isDisposed: () => disposed,
        callbackFailed(kind) {
          callbackFailed[kind] += 1;
        },
        counters,
        directiveStageMs,
        workerDirectiveSkipMs,
        setTimer: schedule,
        clearTimer,
      })
    : undefined;

  const probeAndAct = async (): Promise<void> => {
    await probe(true);
    if (isDirectiveLevel(decision.level)) await pressurePass?.run(decision.level);
  };

  const armTimer = (): void => {
    if (disposed || !started) return;
    if (timer !== undefined) clearTimer(timer);
    timer = schedule(() => {
      timer = undefined;
      void tick().catch(() => {
        counters.passFailures += 1;
      });
    }, cadence());
  };

  const tick = async (): Promise<void> => {
    try {
      await serialize(async () => {
        if (disposed) return;
        await probeAndAct();
      });
    } catch {
      counters.passFailures += 1;
      note("memory pressure: the host pass failed and was dropped");
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
      note("memory pressure: a worker's report did not match the contract and was dropped");
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
      const live = liveWorkers();
      if (live === undefined) {
        // The pool could not be asked, so nothing about this report can be
        // proved. It is refused, like every other unprovable one.
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
        // An identity the inventory cannot mint leaves the row unattributed;
        // it is never a reason to lose what the worker actually did.
        const project = safely("projectId", () => deps.projectIdOf?.(cwd), undefined);
        for (const row of report.results) {
          const event = journal.add(row, { role: "project_worker", level: report.level, ...(project ? { project } : {}) });
          if (event) counters.reportRows += 1;
        }
      }
      refresh();
    });
  };

  const forgetWorker = (cwd: string, clientGeneration: string): void => {
    pressurePass?.forgetWorker(cwd, clientGeneration);
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
      return safePage();
    },
    exportSection() {
      return { summary: buildSummary(), journal: safePage() };
    },
    probeNow() {
      return serialize(async () => {
        if (disposed) return;
        await probeAndAct();
      });
    },
    counters() {
      const summary = lastSummary;
      return {
        // The settled decision, and the latest readings beside it.
        level: decision.level,
        hostLevel: lastProbe?.host.level ?? "unknown",
        machineLevel: lastProbe?.machine.level ?? "unknown",
        workerLevel: summary?.roles.find((row) => row.role === "project_worker")?.level ?? "unknown",
        epoch,
        callbackFailed: { ...callbackFailed },
        ...counters,
        journal: journal.counts(),
      };
    },
  };
}
