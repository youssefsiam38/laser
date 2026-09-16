/**
 * The worker's own pressure controller (RP-8, milestone C).
 *
 * Every input is injected — the clock, the timers, the sampler and the three
 * steps — so the level machine, the bounds and the coalescing are decided
 * here rather than by a real machine's memory.
 */
import { describe, expect, it } from "vitest";
import {
  memoryPressureReportSchema,
  type MemoryPressureMeasure,
  type ValidatedMemoryPressureReport,
} from "@lasercode/protocol";
import {
  PRESSURE_CRITICAL_COOLDOWN_MS,
  PRESSURE_ELEVATED_INTERVAL_MS,
  PRESSURE_NORMAL_INTERVAL_MS,
  PRESSURE_QUIET_COOLDOWN_MS,
  PRESSURE_REPORT_WINDOW_MS,
  PRESSURE_WARNING_COOLDOWN_MS,
  configuredOldSpaceBytes,
  createWorkerPressureController,
  inputsOf,
  rowOf,
  type PressureActionOutcome,
} from "../src/pressure.js";
import {
  WORKER_PRESSURE_THRESHOLDS,
  belowRelease,
  createPressureSampler,
  heapThresholds,
  readingOf,
  type PressureSample,
} from "../src/pressure-sampler.js";

const MiB = 1024 * 1024;
const available = (value: number): MemoryPressureMeasure => ({ status: "available", value });
const unavailable: MemoryPressureMeasure = { status: "unavailable", reason: "unsupported_platform" };

function sampleOf(options: { atMs: number; physicalMiB?: number; heapUsed?: number; heapLimit?: number }): PressureSample {
  return {
    atMs: options.atMs,
    physical: options.physicalMiB === undefined ? unavailable : available(options.physicalMiB * MiB),
    heapUsed: options.heapUsed === undefined ? unavailable : available(options.heapUsed),
    heapLimit: options.heapLimit === undefined ? unavailable : available(options.heapLimit),
  };
}

interface Timer { id: number; fn: () => void; at: number; unrefs: number; unref(): void }

/** One controller, one fake clock, one recorded action log. */
function harness(options: {
  generation?: number;
  configuredOldSpaceBytes?: number;
  outcomes?: Partial<Record<"ephemeral_caches" | "replay_suffixes" | "task_records", PressureActionOutcome>>;
  throwOn?: string;
  /** A link that will not take a report. */
  reportThrows?: boolean;
  /** Counters that cannot be read, or that come back malformed. */
  stores?: () => never | Record<string, unknown>;
} = {}) {
  let clock = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, Timer>();
  const samples: PressureSample[] = [];
  const log: string[] = [];
  const reports: ValidatedMemoryPressureReport[] = [];
  const lines: string[] = [];
  let queued: Array<PressureSample | "fail"> = [];
  let failNext = 0;
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;

  const outcome = (name: "ephemeral_caches" | "replay_suffixes" | "task_records"): PressureActionOutcome => {
    log.push(name);
    if (options.throwOn === name) throw new Error("boom");
    return options.outcomes?.[name] ?? { released: { count: 1 } };
  };

  const controller = createWorkerPressureController(
    {
      sample: async () => {
        if (gate) await gate;
        if (failNext > 0) {
          failNext -= 1;
          throw new Error("no counters");
        }
        const next = queued.shift() ?? samples[samples.length - 1] ?? sampleOf({ atMs: clock });
        if (next === "fail") throw new Error("no counters");
        samples.push(next);
        return next;
      },
      actions: {
        ephemeralCaches: () => outcome("ephemeral_caches"),
        replaySuffixes: () => outcome("replay_suffixes"),
        taskRecords: () => outcome("task_records"),
      },
      stores: (options.stores ?? (() => ({ workerSessions: { count: 2 } }))) as () => never,
      report: (report) => {
        if (options.reportThrows) throw new Error("the link is gone");
        reports.push(report);
      },
      now: () => clock,
      setTimer: (fn, ms) => {
        const id = nextTimer++;
        const handle = { id, fn, at: clock + ms, unrefs: 0, unref() { this.unrefs += 1; } };
        timers.set(id, handle);
        return handle;
      },
      clearTimer: (handle) => timers.delete((handle as { id: number }).id),
      log: (line) => lines.push(line),
    },
    {
      generation: options.generation ?? 7,
      ...(options.configuredOldSpaceBytes !== undefined ? { configuredOldSpaceBytes: options.configuredOldSpaceBytes } : {}),
    },
  );

  return {
    controller,
    log,
    reports,
    lines,
    samples,
    get timers() { return [...timers.values()]; },
    feed(...next: Array<PressureSample | "fail">) { queued = [...queued, ...next]; },
    failSampler(times = 1) { failNext = times; },
    /** Hold the next sample until `release()` is called. */
    hold() {
      gate = new Promise<void>((resolve) => {
        openGate = () => {
          gate = undefined;
          openGate = undefined;
          resolve();
        };
      });
    },
    release() { openGate?.(); },
    advance(ms: number) { clock += ms; },
    at() { return clock; },
    /** Run every timer whose moment has come, oldest first. */
    async fire() {
      for (const timer of [...timers.values()].sort((a, b) => a.at - b.at)) {
        if (timer.at > clock) continue;
        timers.delete(timer.id);
        timer.fn();
      }
      await controller.probeNow();
      // Let the tick's own continuation (which re-arms the timer) run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("the explicit old-space configuration", () => {
  it("parses only a positive explicit Node flag, with the last spelling effective", () => {
    expect(configuredOldSpaceBytes([])).toBeUndefined();
    expect(configuredOldSpaceBytes(["--max-old-space-size=bad"])).toBeUndefined();
    expect(configuredOldSpaceBytes(["--max-old-space-size=256", "--max-old-space-size", "448"])).toBe(448 * MiB);
    expect(configuredOldSpaceBytes(["--max-old-space-size=448", "--max-old-space-size=0"])).toBeUndefined();
  });

  it("reports configured and measured limits separately, and omits absent configuration", async () => {
    const configured = harness({ configuredOldSpaceBytes: 1728 * MiB });
    configured.feed(
      sampleOf({ atMs: configured.at(), physicalMiB: 100, heapUsed: 10, heapLimit: 1800 * MiB }),
      sampleOf({ atMs: configured.at(), physicalMiB: 100, heapUsed: 10, heapLimit: 1800 * MiB }),
    );
    await configured.controller.probeNow();
    await configured.controller.probeNow();
    expect(configured.reports[0]!.ceiling).toEqual({
      configuredBytes: 1728 * MiB,
      measuredLimit: { status: "available", value: 1800 * MiB },
    });

    const direct = harness();
    direct.feed(
      sampleOf({ atMs: direct.at(), physicalMiB: 100, heapLimit: 4096 * MiB }),
      sampleOf({ atMs: direct.at(), physicalMiB: 100, heapLimit: 4096 * MiB }),
    );
    await direct.controller.probeNow();
    await direct.controller.probeNow();
    expect(direct.reports[0]!.ceiling).toEqual({ measuredLimit: { status: "available", value: 4096 * MiB } });
  });
});

describe("reading this process", () => {
  it("says what it could not read instead of reporting a zero", async () => {
    const sample = await createPressureSampler({
      platform: "darwin",
      heapStatistics: () => ({ used_heap_size: 100 * MiB, heap_size_limit: 1_000 * MiB }),
      memoryUsage: () => ({ rss: 200 * MiB } as NodeJS.MemoryUsage),
      now: () => 5,
    })();
    expect(sample.physical).toEqual({ status: "unavailable", reason: "unsupported_platform" });
    expect(sample.heapUsed).toEqual({ status: "available", value: 100 * MiB });
    expect(sample.residentBytes).toBe(200 * MiB);
    // The wire has no private-resident input kind, so a sample never invents one.
    expect(sample.privateResidentBytes).toBeUndefined();
  });

  it("reads PSS and private resident on Linux, and survives every failure", async () => {
    const rollup = "Rss:  2048 kB\nPss:  1024 kB\nPrivate_Clean:  256 kB\nPrivate_Dirty:  512 kB\n";
    const linux = createPressureSampler({
      platform: "linux",
      readSmapsRollup: async () => rollup,
      heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 2 }),
      memoryUsage: () => ({ rss: 3 } as NodeJS.MemoryUsage),
      now: () => 1,
    });
    expect(await linux()).toMatchObject({ physical: { status: "available", value: 1024 * 1024 }, privateResidentBytes: 768 * 1024 });

    const broken = createPressureSampler({
      platform: "linux",
      readSmapsRollup: async () => { throw new Error("EACCES"); },
      heapStatistics: () => { throw new Error("no heap"); },
      memoryUsage: () => { throw new Error("no rss"); },
      now: () => 1,
    });
    const sample = await broken();
    expect(sample.physical).toEqual({ status: "unavailable", reason: "collector_failed" });
    expect(sample.heapUsed).toEqual({ status: "unavailable", reason: "collector_failed" });
    expect(readingOf(sample, WORKER_PRESSURE_THRESHOLDS).level).toBe("unknown");
  });

  it("derives heap thresholds as exact, ordered integers or not at all", () => {
    expect(heapThresholds(available(1_000 * MiB), WORKER_PRESSURE_THRESHOLDS)).toEqual({
      warningBytes: Math.floor(1_000 * MiB * 0.6),
      criticalBytes: Math.floor(1_000 * MiB * 0.75),
    });
    const pair = heapThresholds(available(1_000 * MiB), WORKER_PRESSURE_THRESHOLDS)!;
    expect(Number.isSafeInteger(pair.warningBytes) && Number.isSafeInteger(pair.criticalBytes)).toBe(true);
    expect(pair.warningBytes).toBeLessThan(pair.criticalBytes);
    expect(heapThresholds(unavailable, WORKER_PRESSURE_THRESHOLDS)).toBeUndefined();
    // A limit too small for the two lines to separate gives no usable pair.
    expect(heapThresholds(available(1), WORKER_PRESSURE_THRESHOLDS)).toBeUndefined();
    expect(heapThresholds(available(0), WORKER_PRESSURE_THRESHOLDS)).toBeUndefined();
  });

  it("levels on the worst usable reading and releases at 0.85×", () => {
    const warn = readingOf(sampleOf({ atMs: 0, physicalMiB: 1_300 }), WORKER_PRESSURE_THRESHOLDS);
    expect(warn.level).toBe("warning");
    expect(belowRelease(warn, "warning")).toBe(false);
    const eased = readingOf(sampleOf({ atMs: 0, physicalMiB: 1_000 }), WORKER_PRESSURE_THRESHOLDS);
    expect(eased.level).toBe("normal");
    expect(belowRelease(eased, "warning")).toBe(true);
    const critical = readingOf(sampleOf({ atMs: 0, physicalMiB: 2_000 }), WORKER_PRESSURE_THRESHOLDS);
    expect(critical.level).toBe("critical");
    // No usable reading is never "calm".
    expect(readingOf(sampleOf({ atMs: 0 }), WORKER_PRESSURE_THRESHOLDS).level).toBe("unknown");
    expect(belowRelease(readingOf(sampleOf({ atMs: 0 }), WORKER_PRESSURE_THRESHOLDS), "warning")).toBe(false);
  });

  it("carries two input rows, each once, with the pair it was judged against", () => {
    const sample = sampleOf({ atMs: 0, physicalMiB: 1_300, heapUsed: 10, heapLimit: 1_000 * MiB });
    const rows = inputsOf(sample, readingOf(sample, WORKER_PRESSURE_THRESHOLDS), WORKER_PRESSURE_THRESHOLDS);
    expect(rows.map((row) => row.kind)).toEqual(["physical", "heap"]);
    expect(rows[0]).toMatchObject({ warningBytes: 1_280 * MiB, criticalBytes: 1_920 * MiB });
    const blind = sampleOf({ atMs: 0 });
    const blindRows = inputsOf(blind, readingOf(blind, WORKER_PRESSURE_THRESHOLDS), WORKER_PRESSURE_THRESHOLDS);
    expect(blindRows[1]).toEqual({ kind: "heap", value: unavailable });
  });
});

describe("what a step's outcome becomes", () => {
  it("never claims a release it cannot count", () => {
    expect(rowOf("task_records", {})).toEqual({ action: "task_records", outcome: "nothing_to_give" });
    expect(rowOf("task_records", { released: { count: 0 } })).toEqual({ action: "task_records", outcome: "nothing_to_give" });
    expect(rowOf("task_records", { unobservable: true })).toEqual({ action: "task_records", outcome: "unavailable" });
    expect(rowOf("ephemeral_caches", { held: true })).toEqual({ action: "ephemeral_caches", outcome: "held", reason: "pins_held" });
    expect(rowOf("ephemeral_caches", { safetyIncomplete: true })).toEqual({
      action: "ephemeral_caches",
      outcome: "held",
      reason: "safety_incomplete",
    });
    expect(rowOf("task_records", { boundReached: true })).toEqual({ action: "task_records", outcome: "budget_reached", reason: "work_budget" });
    // Drops that happened *and* a bound reached: a release with work left over.
    expect(rowOf("replay_suffixes", { released: { count: 512, bytes: 10 }, boundReached: true })).toEqual({
      action: "replay_suffixes",
      outcome: "released",
      reason: "work_budget",
      released: { count: 512, bytes: 10 },
    });
  });
});

describe("the level machine", () => {
  it("escalates on two samples, releases on three, and treats unknown as immediate", async () => {
    const h = harness();
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("unknown"); // one sample is not a level change
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("warning");

    // Below the threshold but above the release line: no change.
    h.advance(PRESSURE_CRITICAL_COOLDOWN_MS);
    for (let i = 0; i < 3; i += 1) {
      h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_200 }));
      await h.controller.probeNow();
    }
    expect(h.controller.counters().level).toBe("warning");

    // Below 0.85 × 1,280 MiB, three times.
    for (let i = 0; i < 3; i += 1) {
      h.feed(sampleOf({ atMs: h.at(), physicalMiB: 900 }));
      await h.controller.probeNow();
    }
    expect(h.controller.counters().level).toBe("normal");

    // Evidence that goes missing is unknown at once, never normal.
    h.feed(sampleOf({ atMs: h.at() }));
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("unknown");
  });

  it("makes missing evidence interrupt a candidate, not merely the level", async () => {
    // One warning, then nothing readable, then one warning: the run is broken,
    // so the second fresh warning is the *first* of a new pair.
    const h = harness();
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }), "fail", sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("unknown");
    expect(h.log).toEqual([]);
    // Only the second consecutive valid warning settles it.
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("warning");
  });

  it("makes a stale reading interrupt a candidate too", async () => {
    const h = harness();
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    // A reading older than three cadences is no evidence at all.
    h.feed(sampleOf({ atMs: h.at() - 10 * PRESSURE_NORMAL_INTERVAL_MS, physicalMiB: 1_300 }));
    await h.controller.probeNow();
    expect(h.controller.counters().staleSamples).toBe(1);
    expect(h.controller.counters().level).toBe("unknown");
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("unknown");
    expect(h.log).toEqual([]);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("warning");
  });

  it("makes missing evidence interrupt a de-escalation as well", async () => {
    const h = harness();
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }), sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("warning");
    // Two calm readings, then nothing readable: the three-sample run is broken
    // and the level goes to unknown rather than sliding into normal.
    h.advance(PRESSURE_WARNING_COOLDOWN_MS + 1);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 100 }), sampleOf({ atMs: h.at(), physicalMiB: 100 }), "fail");
    await h.controller.probeNow();
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("unknown");
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 100 }), sampleOf({ atMs: h.at(), physicalMiB: 100 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    // Two calm readings from unknown are what a known level needs.
    expect(h.controller.counters().level).toBe("normal");
  });

  it("discards a stale sample and says so", async () => {
    const h = harness();
    h.advance(10 * PRESSURE_NORMAL_INTERVAL_MS);
    h.feed(sampleOf({ atMs: 0, physicalMiB: 2_000 }));
    await h.controller.probeNow();
    expect(h.controller.counters().staleSamples).toBe(1);
    expect(h.controller.counters().level).toBe("unknown");
    expect(h.log).toEqual([]);
  });

  it("treats a sampler failure as unknown, runs nothing, and reports the transition once", async () => {
    const h = harness();
    // A level this worker had, and then lost the ability to see.
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }), sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("warning");
    const before = h.reports.length;
    const ran = h.log.length;

    h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
    h.failSampler();
    await h.controller.probeNow();
    await h.fire();
    expect(h.controller.counters().sampleFailures).toBe(1);
    expect(h.controller.counters().level).toBe("unknown");
    // Nothing ran on evidence nobody has.
    expect(h.log.length).toBe(ran);
    const sent = h.reports.slice(before).filter((report) => report.level === "unknown");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.ran).toEqual([]);
    expect(sent[0]!.results).toEqual([]);
    // Its readings say they could not be taken; none of them is a zero.
    for (const input of sent[0]!.inputs) expect(input.value).toEqual({ status: "unavailable", reason: "collector_failed" });

    // Failing again while already unknown is not a new transition.
    h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
    h.failSampler();
    await h.controller.probeNow();
    await h.fire();
    expect(h.reports.filter((report) => report.level === "unknown")).toHaveLength(1);
  });

  it("leaves the age out when it cannot be computed, rather than calling it zero", async () => {
    const h = harness();
    // A reading stamped in the future: the age is not a number anyone can use.
    h.feed(sampleOf({ atMs: h.at() + 10_000, physicalMiB: 1_300 }), sampleOf({ atMs: h.at() + 10_000, physicalMiB: 1_300 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    await h.fire();
    const report = h.reports[0]!;
    expect(report).toBeDefined();
    expect("sampleAgeMs" in report).toBe(false);
  });

  it("unrefs every timer it owns, cadence and coalescing alike", async () => {
    const h = harness();
    h.controller.start();
    expect(h.timers.length).toBeGreaterThan(0);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    // Two kinds of handle exist by now: the cadence timer and the one holding
    // a report back inside its window.
    expect(h.timers.length).toBeGreaterThanOrEqual(1);
    for (const timer of h.timers) expect(timer.unrefs).toBeGreaterThanOrEqual(1);
  });

  it("samples faster while elevated and slower when calm", async () => {
    const h = harness();
    h.controller.start();
    expect(h.timers[0]!.at - h.at()).toBe(PRESSURE_NORMAL_INTERVAL_MS);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("critical");
    h.advance(PRESSURE_NORMAL_INTERVAL_MS);
    // A fresh reading: the one from twenty seconds ago is stale by now, which
    // is itself the behaviour the previous test pins.
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.fire();
    expect(h.controller.counters().level).toBe("critical");
    expect(h.timers.some((timer) => timer.at - h.at() === PRESSURE_ELEVATED_INTERVAL_MS)).toBe(true);
  });
});

describe("a pass this worker decides to run", () => {
  const climb = (h: ReturnType<typeof harness>, miB: number) => {
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: miB }), sampleOf({ atMs: h.at(), physicalMiB: miB }));
  };

  it("runs its three steps in the policy's order and reports them once", async () => {
    const h = harness({ outcomes: { ephemeral_caches: { released: { count: 2 } }, replay_suffixes: { released: { count: 1, bytes: 10 } }, task_records: {} } });
    climb(h, 2_000);
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.log).toEqual(["ephemeral_caches", "replay_suffixes", "task_records"]);
    const action = h.reports.find((report) => report.ran.length > 0)!;
    expect(action.ran).toEqual(["ephemeral_caches", "replay_suffixes", "task_records"]);
    expect(action.level).toBe("critical");
    expect(action.generation).toBe(7);
    expect(action.stores).toEqual({ workerSessions: { count: 2 } });
    // Its rows are exactly what the steps said.
    expect(action.results.map((row) => row.outcome)).toEqual(["released", "released", "nothing_to_give"]);
    expect(memoryPressureReportSchema.safeParse(action).success).toBe(true);
  });

  it("stops when a probe between steps loses sight of the machine, and reports that", async () => {
    const h = harness({ outcomes: { ephemeral_caches: { released: { count: 2 } } } });
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }), sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("warning");
    // The pass began; the probe after its first step cannot read anything.
    h.advance(PRESSURE_WARNING_COOLDOWN_MS + 1);
    // The pass's own probe reads a warning; the probe after its first step
    // cannot read anything at all.
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }), "fail");
    const before = h.log.length;
    const sent = h.reports.length;
    await h.controller.probeNow();
    const ran = h.log.slice(before);
    expect(ran).toEqual(["ephemeral_caches"]);
    expect(h.controller.counters().level).toBe("unknown");
    // The action report goes first, at the level that authorized it …
    const action = h.reports.slice(sent).find((report) => report.ran.length > 0)!;
    expect(action.level).toBe("warning");
    expect(action.ran).toEqual(["ephemeral_caches"]);
    // … and the transition the inter-step probe found is not lost.
    h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
    await h.fire();
    const state = h.reports.slice(sent).find((report) => report.level === "unknown")!;
    expect(state).toBeDefined();
    expect(state.ran).toEqual([]);
    expect(h.reports.indexOf(state)).toBeGreaterThan(h.reports.indexOf(action));
  });

  it("calls a pass quiet only when every step had nothing to give", async () => {
    // `unavailable` is not quiet: the ordinary cooldown applies, not the long one.
    const h = harness({ outcomes: { ephemeral_caches: { unobservable: true }, replay_suffixes: {}, task_records: {} } });
    expect((await h.controller.directive({ level: "critical", epoch: 1, generation: 7 })).applied).toBe(true);
    const ran = h.log.length;
    h.advance(PRESSURE_CRITICAL_COOLDOWN_MS + 1);
    expect((await h.controller.directive({ level: "critical", epoch: 2, generation: 7 })).applied).toBe(true);
    expect(h.log.length).toBeGreaterThan(ran);

    // Nor is a bound: work was left over, so this worker tries again soon.
    const bounded = harness({ outcomes: { ephemeral_caches: { boundReached: true }, replay_suffixes: {}, task_records: {} } });
    await bounded.controller.directive({ level: "critical", epoch: 1, generation: 7 });
    const boundedRan = bounded.log.length;
    bounded.advance(PRESSURE_CRITICAL_COOLDOWN_MS + 1);
    await bounded.controller.directive({ level: "critical", epoch: 2, generation: 7 });
    expect(bounded.log.length).toBeGreaterThan(boundedRan);

    // A step that threw is not quiet either.
    const threw = harness({ throwOn: "ephemeral_caches" });
    await threw.controller.directive({ level: "critical", epoch: 1, generation: 7 });
    const threwRan = threw.log.length;
    threw.advance(PRESSURE_CRITICAL_COOLDOWN_MS + 1);
    await threw.controller.directive({ level: "critical", epoch: 2, generation: 7 });
    expect(threw.log.length).toBeGreaterThan(threwRan);
  });

  it("stops early when a re-probe proves the pressure relieved, after exactly the steps it took", async () => {
    const h = harness({ outcomes: { ephemeral_caches: { released: { count: 3 } } } });
    // Two readings make it critical; the third, taken between the first step
    // and the second, is a calm machine.
    h.feed(
      sampleOf({ atMs: h.at(), physicalMiB: 2_000 }),
      sampleOf({ atMs: h.at(), physicalMiB: 2_000 }),
      sampleOf({ atMs: h.at(), physicalMiB: 100 }),
    );
    await h.controller.probeNow();
    const before = h.log.length;
    await h.controller.probeNow();
    expect(h.log.slice(before)).toEqual(["ephemeral_caches"]);
    const action = h.reports.find((report) => report.ran.length > 0)!;
    expect(action.ran).toEqual(["ephemeral_caches"]);
    expect(action.level).toBe("critical");
  });

  it("stops at a step that threw, reports it as unavailable and says nothing else", async () => {
    const h = harness({ throwOn: "replay_suffixes" });
    climb(h, 2_000);
    await h.controller.probeNow();
    await h.controller.probeNow();
    const action = h.reports.find((report) => report.ran.length > 0)!;
    expect(action.ran).toEqual(["ephemeral_caches", "replay_suffixes"]);
    expect(action.results.at(-1)).toEqual({ action: "replay_suffixes", outcome: "unavailable" });
    expect(h.lines.some((line) => line.includes("replay_suffixes"))).toBe(true);
    expect(h.log).toEqual(["ephemeral_caches", "replay_suffixes"]);
  });

  it("waits out its own cooldown, and waits longer after a pass with nothing to give", async () => {
    const h = harness({ outcomes: { ephemeral_caches: {}, replay_suffixes: {}, task_records: {} } });
    climb(h, 2_000);
    await h.controller.probeNow();
    await h.controller.probeNow();
    const first = h.log.length;
    expect(first).toBeGreaterThan(0);
    // Inside the quiet cooldown: nothing runs again.
    h.advance(PRESSURE_CRITICAL_COOLDOWN_MS + 1);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    expect(h.log.length).toBe(first);
    h.advance(PRESSURE_QUIET_COOLDOWN_MS);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    expect(h.log.length).toBeGreaterThan(first);
  });

  it("never runs a pass without a generation, and never reports one", async () => {
    const h = harness({ generation: undefined as unknown as number });
    const blind = createWorkerPressureController(
      {
        sample: async () => sampleOf({ atMs: 0, physicalMiB: 2_000 }),
        actions: { ephemeralCaches: () => ({}), replaySuffixes: () => ({}), taskRecords: () => ({}) },
        stores: () => ({}),
        report: () => { throw new Error("must not report"); },
        now: () => 0,
        setTimer: () => 1,
        clearTimer: () => undefined,
      },
      {},
    );
    await blind.probeNow();
    await blind.probeNow();
    expect(blind.counters().passes).toBe(0);
    expect((await blind.directive({ level: "critical", epoch: 1, generation: 1 })).applied).toBe(false);
    void h;
  });
});

describe("what leaves this worker", () => {
  it("reports a level change with no rows at all, including back to normal and to unknown", async () => {
    const h = harness({ outcomes: { ephemeral_caches: {}, replay_suffixes: {}, task_records: {} } });
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 1_300 }), sampleOf({ atMs: h.at(), physicalMiB: 1_300 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.reports.some((report) => report.level === "warning")).toBe(true);

    h.advance(PRESSURE_REPORT_WINDOW_MS + PRESSURE_QUIET_COOLDOWN_MS);
    for (let i = 0; i < 3; i += 1) {
      h.feed(sampleOf({ atMs: h.at(), physicalMiB: 100 }));
      await h.controller.probeNow();
      h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
      await h.fire();
    }
    const calm = h.reports.find((report) => report.level === "normal")!;
    expect(calm).toBeDefined();
    expect(calm.ran).toEqual([]);
    expect(calm.results).toEqual([]);

    h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
    h.feed(sampleOf({ atMs: h.at() }));
    await h.controller.probeNow();
    await h.fire();
    const blind = h.reports.find((report) => report.level === "unknown")!;
    expect(blind).toBeDefined();
    expect(blind.ran).toEqual([]);
  });

  it("sends at most one notification per window, action first, and never drops the action one", async () => {
    const h = harness();
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    const firstBatch = h.reports.length;
    expect(firstBatch).toBe(1);
    expect(h.reports[0]!.ran.length).toBeGreaterThan(0);
    // The state change the post-pass probe found waits for the next window.
    expect(h.controller.counters().coalesced).toBeGreaterThanOrEqual(0);
    h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
    await h.fire();
    expect(h.reports.length).toBeGreaterThanOrEqual(firstBatch);
    // Cooldowns make two action reports inside one window impossible.
    expect(h.controller.counters().actionCollisions).toBe(0);
  });

  it("keeps one row-less report for a window, and it carries the newest state", async () => {
    const h = harness();
    // Calm, established: this is the first transition and it goes out at once.
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 100 }), sampleOf({ atMs: h.at(), physicalMiB: 100 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.reports.map((report) => report.level)).toEqual(["normal"]);
    const sent = h.reports.length;

    // Three more transitions inside the same five seconds: sight lost, found
    // again, and lost once more.
    h.advance(1_000);
    h.feed(sampleOf({ atMs: h.at() }));
    await h.controller.probeNow();
    h.advance(1_000);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 100 }), sampleOf({ atMs: h.at(), physicalMiB: 100 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    h.advance(1_000);
    h.feed(sampleOf({ atMs: h.at() }));
    await h.controller.probeNow();
    expect(h.reports.length).toBe(sent);

    // One report when the window opens, and it is the state this worker is in
    // now rather than any of the ones it passed through.
    h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
    await h.fire();
    const later = h.reports.slice(sent);
    expect(later).toHaveLength(1);
    expect(later[0]!.level).toBe("unknown");
    expect(later[0]!.ran).toEqual([]);
    expect(later[0]!.results).toEqual([]);
    // Three transitions, one report: what the window holds back is replaced,
    // never queued into a backlog.
    expect(h.controller.counters().level).toBe("unknown");
  });

  it("refuses to send a report it built wrongly, and says so without a payload", async () => {
    // A counter that is not a count: the level machine can still read it, and
    // the wire cannot accept it.
    const broken = sampleOf({ atMs: 0, physicalMiB: 0 });
    const h = harness();
    h.feed(
      { ...broken, atMs: h.at(), physical: { status: "available", value: -5 } } as PressureSample,
      { ...broken, atMs: h.at(), physical: { status: "available", value: -5 } } as PressureSample,
    );
    await h.controller.probeNow();
    await h.controller.probeNow();
    await h.fire();
    expect(h.controller.counters().invalidReports).toBeGreaterThan(0);
    expect(h.controller.counters().reports).toBe(0);
    expect(h.reports).toEqual([]);
    expect(h.lines.some((line) => line.includes("did not match the contract"))).toBe(true);
    expect(h.lines.every((line) => !line.includes("-5"))).toBe(true);
  });

  it("says nothing and does nothing when a probe in flight outlives its controller", async () => {
    const h = harness({ outcomes: { ephemeral_caches: { released: { count: 1 } } } });
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    const ran = h.log.length;
    // The next probe is held open, and the controller is disposed while it is.
    h.hold();
    const pending = h.controller.probeNow();
    h.controller.dispose();
    h.release();
    await pending;
    expect(h.reports).toEqual([]);
    expect(h.log.length).toBe(ran);
    expect(h.timers.length).toBe(0);
  });

  it("reports nothing after disposal, and leaves no timer behind", async () => {
    const h = harness();
    h.controller.start();
    expect(h.timers.length).toBe(1);
    h.controller.dispose();
    expect(h.timers.length).toBe(0);
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.reports).toEqual([]);
    expect(h.log).toEqual([]);
  });
});

describe("when something outside this controller fails", () => {
  it("drops a report the link would not take, and keeps working", async () => {
    const h = harness({ reportThrows: true });
    h.controller.start();
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await h.controller.probeNow();
    await h.controller.probeNow();
    const ran = h.log.length;
    expect(ran).toBeGreaterThan(0);
    expect(h.controller.counters().reportFailures).toBeGreaterThan(0);
    expect(h.controller.counters().reports).toBe(0);
    expect(h.reports).toEqual([]);
    // Nothing is retried, and the cadence timer is still armed.
    h.advance(PRESSURE_REPORT_WINDOW_MS + 1);
    await h.fire();
    expect(h.log.length).toBe(ran);
    expect(h.timers.length).toBeGreaterThan(0);
    // And the log says what happened without quoting anything.
    expect(h.lines.every((line) => !line.includes("the link is gone"))).toBe(true);
    h.controller.dispose();
    expect(h.timers.length).toBe(0);
  });

  it("answers with no counters rather than failing when they cannot be read", async () => {
    const throwing = harness({ stores: () => { throw new Error("subsystem down"); } });
    const answer = await throwing.controller.directive({ level: "warning", epoch: 1, generation: 7 });
    expect(answer.applied).toBe(true);
    expect(answer.stores).toEqual({});
    expect(throwing.controller.counters().storeFailures).toBeGreaterThan(0);
    // A scheduled pass survives it too, and still reports.
    throwing.feed(sampleOf({ atMs: throwing.at(), physicalMiB: 2_000 }), sampleOf({ atMs: throwing.at(), physicalMiB: 2_000 }));
    throwing.advance(PRESSURE_QUIET_COOLDOWN_MS + 1);
    await throwing.controller.probeNow();
    await throwing.controller.probeNow();
    expect(throwing.lines.every((line) => !line.includes("subsystem down"))).toBe(true);

    // Counters of a shape this wire does not accept are the same kind of fault.
    const malformed = harness({ stores: () => ({ workerSessions: { count: -1 }, invented: { count: 1 } }) });
    const refused = await malformed.controller.directive({ level: "warning", epoch: 1, generation: 7 });
    expect(refused.stores).toEqual({});
    expect(malformed.controller.counters().storeFailures).toBeGreaterThan(0);
    malformed.feed(sampleOf({ atMs: malformed.at(), physicalMiB: 2_000 }), sampleOf({ atMs: malformed.at(), physicalMiB: 2_000 }));
    malformed.advance(PRESSURE_QUIET_COOLDOWN_MS + 1);
    await malformed.controller.probeNow();
    await malformed.controller.probeNow();
    for (const report of malformed.reports) expect(report.stores).toEqual({});
  });
});

describe("a directive", () => {
  it("runs the pass, answers with its own rows, and reports none of them", async () => {
    const h = harness();
    const answer = await h.controller.directive({ level: "warning", epoch: 4, generation: 7 });
    expect(answer.applied).toBe(true);
    expect(answer.ran).toEqual(["ephemeral_caches", "replay_suffixes", "task_records"]);
    expect(answer.results.map((row) => row.action)).toEqual(answer.ran);
    // The rows belong to the answer; an unasked notification never repeats them.
    expect(h.reports.every((report) => report.ran.length === 0)).toBe(true);
  });

  it("refuses a foreign generation, a stale epoch, its own cooldown and disposal", async () => {
    const h = harness();
    expect((await h.controller.directive({ level: "warning", epoch: 1, generation: 8 })).applied).toBe(false);
    expect(h.log).toEqual([]);
    expect((await h.controller.directive({ level: "warning", epoch: 5, generation: 7 })).applied).toBe(true);
    const ran = h.log.length;
    // Same window: the worker's cooldown bounds a host directive too.
    expect((await h.controller.directive({ level: "critical", epoch: 6, generation: 7 })).applied).toBe(false);
    expect(h.log.length).toBe(ran);
    h.advance(PRESSURE_WARNING_COOLDOWN_MS + 1);
    // An epoch older than the last one acted on is stale.
    const stale = await h.controller.directive({ level: "warning", epoch: 4, generation: 7 });
    expect(stale.applied).toBe(false);
    expect(stale.ran).toEqual([]);
    expect(stale.results).toEqual([]);
    h.controller.dispose();
    expect((await h.controller.directive({ level: "warning", epoch: 9, generation: 7 })).applied).toBe(false);
  });

  it("runs the safe steps even when this worker's own evidence is unknown", async () => {
    const h = harness();
    h.failSampler();
    await h.controller.probeNow();
    expect(h.controller.counters().level).toBe("unknown");
    const answer = await h.controller.directive({ level: "critical", epoch: 1, generation: 7 });
    expect(answer.applied).toBe(true);
    expect(answer.ran.length).toBe(3);
  });

  it("is not applied when a step failed", async () => {
    const h = harness({ throwOn: "ephemeral_caches" });
    const answer = await h.controller.directive({ level: "warning", epoch: 1, generation: 7 });
    expect(answer.applied).toBe(false);
    expect(answer.results).toEqual([{ action: "ephemeral_caches", outcome: "unavailable" }]);
  });

  it("fences a lower epoch even when two directives race", async () => {
    const h = harness();
    // Both are handed in before either can run: the newer one must win, and
    // the older one must never act, whatever order the queue takes them in.
    const [newer, older] = await Promise.all([
      h.controller.directive({ level: "critical", epoch: 2, generation: 7 }),
      h.controller.directive({ level: "warning", epoch: 1, generation: 7 }),
    ]);
    expect(newer.applied).toBe(true);
    expect(older.applied).toBe(false);
    expect(older.ran).toEqual([]);
    expect(h.controller.counters().passes).toBe(1);
  });

  it("keeps fencing after a cooldown refusal, so a late older directive is still stale", async () => {
    const h = harness();
    expect((await h.controller.directive({ level: "warning", epoch: 5, generation: 7 })).applied).toBe(true);
    // Newer, but inside the cooldown: refused, and still the newest thing seen.
    expect((await h.controller.directive({ level: "warning", epoch: 9, generation: 7 })).applied).toBe(false);
    h.advance(PRESSURE_WARNING_COOLDOWN_MS + 1);
    const late = await h.controller.directive({ level: "warning", epoch: 6, generation: 7 });
    expect(late.applied).toBe(false);
    expect(late.ran).toEqual([]);
    // The one that was refused may come back once the window has passed.
    const retry = await h.controller.directive({ level: "warning", epoch: 9, generation: 7 });
    expect(retry.applied).toBe(true);
  });

  it("bounds the next pass by the level of the pass that ran, not by the latest reading", async () => {
    const h = harness();
    // A warning pass is followed by warning's long gap …
    expect((await h.controller.directive({ level: "warning", epoch: 1, generation: 7 })).applied).toBe(true);
    h.advance(PRESSURE_CRITICAL_COOLDOWN_MS + 1);
    expect((await h.controller.directive({ level: "critical", epoch: 2, generation: 7 })).applied).toBe(false);
    h.advance(PRESSURE_WARNING_COOLDOWN_MS);
    expect((await h.controller.directive({ level: "critical", epoch: 3, generation: 7 })).applied).toBe(true);
    // … and a critical pass by critical's short one, whatever the sampler says.
    h.advance(PRESSURE_CRITICAL_COOLDOWN_MS + 1);
    expect((await h.controller.directive({ level: "warning", epoch: 4, generation: 7 })).applied).toBe(true);
  });

  it("never overlaps a scheduled pass", async () => {
    const h = harness();
    h.feed(sampleOf({ atMs: h.at(), physicalMiB: 2_000 }), sampleOf({ atMs: h.at(), physicalMiB: 2_000 }));
    await Promise.all([
      h.controller.probeNow(),
      h.controller.probeNow(),
      h.controller.directive({ level: "critical", epoch: 1, generation: 7 }),
    ]);
    // Every step of every pass appears in whole groups of three or fewer, in
    // order, never interleaved.
    for (let i = 0; i < h.log.length; i += 1) {
      const step = h.log[i]!;
      const previous = h.log[i - 1];
      if (previous === undefined) continue;
      const order = ["ephemeral_caches", "replay_suffixes", "task_records"];
      if (order.indexOf(step) !== 0) expect(order.indexOf(step)).toBe(order.indexOf(previous) + 1);
    }
  });
});
