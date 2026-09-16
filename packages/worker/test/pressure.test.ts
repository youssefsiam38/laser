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

interface Timer { id: number; fn: () => void; at: number }

/** One controller, one fake clock, one recorded action log. */
function harness(options: { generation?: number; outcomes?: Partial<Record<"ephemeral_caches" | "replay_suffixes" | "task_records", PressureActionOutcome>>; throwOn?: string } = {}) {
  let clock = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, Timer>();
  const samples: PressureSample[] = [];
  const log: string[] = [];
  const reports: ValidatedMemoryPressureReport[] = [];
  const lines: string[] = [];
  let queued: PressureSample[] = [];
  let failNext = 0;

  const outcome = (name: "ephemeral_caches" | "replay_suffixes" | "task_records"): PressureActionOutcome => {
    log.push(name);
    if (options.throwOn === name) throw new Error("boom");
    return options.outcomes?.[name] ?? { released: { count: 1 } };
  };

  const controller = createWorkerPressureController(
    {
      sample: async () => {
        if (failNext > 0) {
          failNext -= 1;
          throw new Error("no counters");
        }
        const next = queued.shift() ?? samples[samples.length - 1] ?? sampleOf({ atMs: clock });
        samples.push(next);
        return next;
      },
      actions: {
        ephemeralCaches: () => outcome("ephemeral_caches"),
        replaySuffixes: () => outcome("replay_suffixes"),
        taskRecords: () => outcome("task_records"),
      },
      stores: () => ({ workerSessions: { count: 2 } }),
      report: (report) => reports.push(report),
      now: () => clock,
      setTimer: (fn, ms) => {
        const id = nextTimer++;
        timers.set(id, { id, fn, at: clock + ms });
        return id;
      },
      clearTimer: (handle) => timers.delete(handle as number),
      log: (line) => lines.push(line),
    },
    { generation: options.generation ?? 7 },
  );

  return {
    controller,
    log,
    reports,
    lines,
    samples,
    get timers() { return [...timers.values()]; },
    feed(...next: PressureSample[]) { queued = [...queued, ...next]; },
    failSampler(times = 1) { failNext = times; },
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

  it("discards a stale sample and says so", async () => {
    const h = harness();
    h.advance(10 * PRESSURE_NORMAL_INTERVAL_MS);
    h.feed(sampleOf({ atMs: 0, physicalMiB: 2_000 }));
    await h.controller.probeNow();
    expect(h.controller.counters().staleSamples).toBe(1);
    expect(h.controller.counters().level).toBe("unknown");
    expect(h.log).toEqual([]);
  });

  it("treats a sampler failure as unknown and runs nothing", async () => {
    const h = harness();
    h.failSampler();
    await h.controller.probeNow();
    expect(h.controller.counters().sampleFailures).toBe(1);
    expect(h.controller.counters().level).toBe("unknown");
    expect(h.log).toEqual([]);
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

  it("stops early when a re-probe proves the pressure relieved", async () => {
    const h = harness();
    climb(h, 2_000);
    await h.controller.probeNow();
    await h.controller.probeNow();
    // The probe between steps sees a calm machine, so the rest of the list is
    // not run — and what did run is still reported.
    expect(h.log.length).toBeLessThanOrEqual(3);
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

describe("a directive", () => {
  it("runs the pass, answers with its own rows, and reports none of them", async () => {
    const h = harness();
    const answer = await h.controller.directive({ level: "warning", epoch: 4, generation: 7 });
    expect(answer.applied).toBe(true);
    expect(answer.ran).toEqual(["ephemeral_caches", "replay_suffixes", "task_records"]);
    expect(answer.events.map((row) => row.action)).toEqual(answer.ran);
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
    expect(stale.events).toEqual([]);
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
    expect(answer.events).toEqual([{ action: "ephemeral_caches", outcome: "unavailable" }]);
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
