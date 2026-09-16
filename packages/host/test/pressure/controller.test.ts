/**
 * The host's pressure controller (RP-8, milestone E1).
 *
 * Everything here is about evidence: what a level is allowed to be, what a
 * summary is allowed to claim, what a worker has to prove before it is
 * believed, and what happens when something the controller depends on fails.
 * No release, no directive and no refusal exists yet, and the tests say so
 * where it matters.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseMemoryPressureSummary,
  type JsonRpcNotification,
  type MemoryPressureReportInput,
  type MemoryPressureRole,
  type MemoryPressureSummary,
  type ValidatedMemoryPressurePublish,
} from "@lasercode/protocol";
import {
  createHostPressureController,
  type HostPressureController,
  type HostPressureDeps,
  type HostPressureSample,
  type HostPressureWorker,
} from "../../src/pressure/index.js";

const MiB = 1024 * 1024;

interface Harness {
  controller: HostPressureController;
  published: ValidatedMemoryPressurePublish[];
  logs: string[];
  timers: Array<{ ms: number; fire: () => void }>;
  setSample: (sample: Partial<HostPressureSample> | "throw") => void;
  setWorkers: (workers: HostPressureWorker[]) => void;
  setRenderer: (present: boolean) => void;
  advance: (ms: number) => void;
  at: () => number;
  role: (name: MemoryPressureRole) => MemoryPressureSummary["roles"][number];
}

function harness(options: { publish?: (p: ValidatedMemoryPressurePublish) => void; workers?: HostPressureWorker[] } = {}): Harness {
  let at = 10_000;
  let sample: Partial<HostPressureSample> | "throw" = {};
  let workers: HostPressureWorker[] = options.workers ?? [];
  let renderer = false;
  const published: ValidatedMemoryPressurePublish[] = [];
  const logs: string[] = [];
  const timers: Array<{ ms: number; fire: () => void }> = [];

  const deps: HostPressureDeps = {
    sample: async () => {
      if (sample === "throw") throw new Error("no /proc here");
      return {
        atMs: at,
        physical: { status: "available", value: 100 * MiB },
        heapUsed: { status: "available", value: 100 * MiB },
        heapLimit: { status: "available", value: 1_000 * MiB },
        machineAvailable: { status: "available", value: 8_000 * MiB },
        ...sample,
      };
    },
    workers: () => workers,
    publish: (publication) => {
      if (options.publish) options.publish(publication);
      published.push(publication);
    },
    projectIdOf: () => "0123456789abcdef",
    rendererPresent: () => renderer,
    now: () => at,
    setTimer: (fn, ms) => {
      const entry = { ms, fire: fn };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { ms: number; fire: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
    log: (line) => logs.push(line),
  };

  const controller = createHostPressureController(deps, { publishWindowMs: 5_000, workerFreshMs: 15_000 });
  return {
    controller,
    published,
    logs,
    timers,
    setSample: (next) => (sample = next),
    setWorkers: (next) => (workers = next),
    setRenderer: (present) => (renderer = present),
    advance: (ms) => (at += ms),
    at: () => at,
    role: (name) => controller.summary().roles.find((row) => row.role === name)!,
  };
}

/** Probe `times` times, moving the clock past the publication window each time. */
async function probe(h: Harness, times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await h.controller.probeNow();
    h.advance(5_000);
  }
}

const reportOf = (over: Partial<MemoryPressureReportInput> = {}): MemoryPressureReportInput => ({
  generation: 7,
  level: "warning",
  sampleAgeMs: 100,
  inputs: [
    { kind: "physical", value: { status: "available", value: 1_400 * MiB }, warningBytes: 1_280 * MiB, criticalBytes: 1_920 * MiB },
  ],
  ran: ["ephemeral_caches"],
  results: [{ action: "ephemeral_caches", outcome: "released", released: { count: 1 } }],
  stores: {},
  ...over,
});

const notificationOf = (params: unknown): JsonRpcNotification => ({ jsonrpc: "2.0", method: "pi/resource/pressure", params });

describe("what the host settles on", () => {
  it("starts unknown and publishes nothing it has not measured", () => {
    const h = harness();
    const summary = h.controller.summary();
    expect(summary.level).toBe("unknown");
    expect(h.role("host").level).toBe("unknown");
    expect(h.role("machine").level).toBe("unknown");
    expect(h.role("host").coverage).toEqual({ expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" });
    expect(() => parseMemoryPressureSummary(summary)).not.toThrow();
  });

  it("needs two agreeing samples to escalate and three to come back", async () => {
    const h = harness();
    h.setSample({ physical: { status: "available", value: 600 * MiB } });
    await probe(h);
    expect(h.role("host").level).toBe("unknown"); // one sample is a candidate, not a fact
    await probe(h);
    expect(h.role("host").level).toBe("warning");

    // Well inside the release line, but not yet for long enough.
    h.setSample({ physical: { status: "available", value: 100 * MiB } });
    await probe(h, 2);
    expect(h.role("host").level).toBe("warning");
    await probe(h);
    expect(h.role("host").level).toBe("normal");
  });

  it("will not leave a level for a value hovering on its threshold", async () => {
    const h = harness();
    h.setSample({ physical: { status: "available", value: 600 * MiB } });
    await probe(h, 2);
    expect(h.role("host").level).toBe("warning");
    // Under 512 MiB, but not under 0.85 × 512 MiB.
    h.setSample({ physical: { status: "available", value: 500 * MiB } });
    await probe(h, 5);
    expect(h.role("host").level).toBe("warning");
  });

  it("goes unknown at once, and an unknown breaks every run", async () => {
    const h = harness();
    h.setSample({ physical: { status: "available", value: 600 * MiB } });
    await probe(h, 2);
    expect(h.role("host").level).toBe("warning");

    h.setSample({
      physical: { status: "unavailable", reason: "collector_failed" },
      heapUsed: { status: "unavailable", reason: "collector_failed" },
      heapLimit: { status: "unavailable", reason: "collector_failed" },
    });
    await probe(h);
    expect(h.role("host").level).toBe("unknown");

    // The run that was under way is gone: two fresh agreeing samples are needed
    // again, not one.
    h.setSample({ physical: { status: "available", value: 600 * MiB } });
    await probe(h);
    expect(h.role("host").level).toBe("unknown");
    await probe(h);
    expect(h.role("host").level).toBe("warning");
  });

  it("acts on a heap alone where there are no proportional pages", async () => {
    const h = harness();
    h.setSample({
      physical: { status: "unavailable", reason: "unsupported_platform" },
      machineAvailable: { status: "unavailable", reason: "unsupported_platform" },
      heapUsed: { status: "available", value: 800 * MiB },
      heapLimit: { status: "available", value: 1_000 * MiB },
    });
    await probe(h, 2);
    expect(h.role("host").level).toBe("critical");
    expect(h.role("machine").level).toBe("unknown");
    expect(h.controller.counters().level).toBe("critical");
  });

  it("stays unknown off Linux when all it knows is that nothing is wrong", async () => {
    const h = harness();
    h.setSample({
      physical: { status: "unavailable", reason: "unsupported_platform" },
      machineAvailable: { status: "unavailable", reason: "unsupported_platform" },
      heapUsed: { status: "available", value: 10 * MiB },
      heapLimit: { status: "available", value: 1_000 * MiB },
    });
    await probe(h, 3);
    expect(h.role("host").level).toBe("normal");
    expect(h.role("machine").level).toBe("unknown");
    // The decision the host would act on is unknown, and unknown authorizes
    // nothing.
    expect(h.controller.counters().level).toBe("unknown");
  });

  it("treats a sample older than three cadences as no sample at all", async () => {
    const h = harness();
    h.setSample({ physical: { status: "available", value: 600 * MiB } });
    await probe(h, 2);
    expect(h.role("host").level).toBe("warning");
    // A reading from two minutes ago, at a five-second cadence.
    h.setSample({ atMs: h.at() - 120_000, physical: { status: "available", value: 600 * MiB } });
    await probe(h);
    expect(h.role("host").level).toBe("unknown");
    expect(h.controller.counters().staleSamples).toBe(1);
  });

  it("publishes one row-less unknown transition when the sampler fails, and only one", async () => {
    const h = harness();
    await probe(h, 2);
    expect(h.role("host").level).toBe("normal");
    const before = h.published.length;

    h.setSample("throw");
    await probe(h);
    const first = h.published.slice(before);
    expect(first).toHaveLength(1);
    const row = first[0]!.summary.roles.find((entry) => entry.role === "host")!;
    expect(row.level).toBe("unknown");
    expect(row.inputs.every((input) => input.value.status === "unavailable")).toBe(true);
    expect(row.inputs.map((input) => (input.value.status === "unavailable" ? input.value.reason : ""))).toEqual([
      "collector_failed",
      "collector_failed",
    ]);
    expect(first[0]!.summary.totals.events).toBe(0);

    // Failing again says nothing new: the state has not moved.
    await probe(h, 3);
    expect(h.published.length).toBe(before + 1);
    expect(h.controller.counters().sampleFailures).toBe(4);
  });

  it("omits an age it cannot compute rather than reporting none", async () => {
    const h = harness();
    h.setSample({ atMs: h.at() + 5_000 }); // a sample from the future
    await h.controller.probeNow();
    expect(h.role("host").sampleAgeMs).toBeUndefined();
    h.setSample({});
    await h.controller.probeNow();
    expect(h.role("host").sampleAgeMs).toBe(0);
  });
});

describe("the summary", () => {
  it("always has four rows and validates", async () => {
    const h = harness();
    await probe(h);
    const summary = h.controller.summary();
    expect(summary.roles.map((row) => row.role).sort()).toEqual(["desktop_renderer", "host", "machine", "project_worker"]);
    expect(() => parseMemoryPressureSummary(summary)).not.toThrow();
  });

  it("calls a fleet with nothing in it calm, and one that has not answered unknown", async () => {
    const h = harness();
    await probe(h);
    expect(h.role("project_worker")).toMatchObject({ level: "normal", coverage: { expected: 0, answered: 0, complete: true } });

    h.setWorkers([{ cwd: "/p", clientGeneration: "aa", workerGeneration: 7 }]);
    expect(h.role("project_worker")).toMatchObject({
      level: "unknown",
      coverage: { expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" },
    });
  });

  it("says a window that has told it nothing is unknown, and no window is calm", async () => {
    const h = harness();
    await probe(h, 2);
    expect(h.role("desktop_renderer")).toMatchObject({ level: "normal", coverage: { expected: 0, answered: 0 } });
    expect(h.controller.counters().level).toBe("normal");

    h.setRenderer(true);
    const summary = h.controller.summary();
    expect(summary.roles.find((row) => row.role === "desktop_renderer")).toMatchObject({
      level: "unknown",
      coverage: { expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" },
    });
    // It is in what a window reads — the whole summary is unknown, and nothing
    // presents that as calm — while the host's own decision is untouched by it.
    expect(summary.level).toBe("unknown");
    expect(h.controller.counters().level).toBe("normal");
  });

  it("carries the worst worker's own readings, and its totals come from the journal", async () => {
    const h = harness();
    h.setWorkers([
      { cwd: "/a", clientGeneration: "aa", workerGeneration: 7 },
      { cwd: "/b", clientGeneration: "bb", workerGeneration: 8 },
    ]);
    h.controller.observeWorkerReport("/a", notificationOf(reportOf()), { generation: "aa", workerGeneration: 7 });
    h.controller.observeWorkerReport(
      "/b",
      notificationOf(
        reportOf({
          generation: 8,
          level: "critical",
          inputs: [
            { kind: "physical", value: { status: "available", value: 2_000 * MiB }, warningBytes: 1_280 * MiB, criticalBytes: 1_920 * MiB },
          ],
          results: [{ action: "task_records", outcome: "released", released: { count: 3, bytes: 900 } }],
          ran: ["task_records"],
        }),
      ),
      { generation: "bb", workerGeneration: 8 },
    );
    await h.controller.probeNow();

    const row = h.role("project_worker");
    expect(row.level).toBe("critical");
    expect(row.coverage).toEqual({ expected: 2, answered: 2, complete: true });
    expect(row.inputs[0]!.value).toEqual({ status: "available", value: 2_000 * MiB });
    const summary = h.controller.summary();
    expect(summary.totals).toEqual({ events: 2, released: { count: 4, bytes: 900 }, refusals: 0 });
    expect(summary.latestEventId).toBe("mp_2");
    expect(summary.refusing).toEqual([]);
  });
});

describe("a worker's report at the controller's own boundary", () => {
  const live: HostPressureWorker[] = [{ cwd: "/p", clientGeneration: "aa", workerGeneration: 7 }];

  it("is believed, recorded once, and answers for its worker", async () => {
    const h = harness({ workers: [...live] });
    h.controller.observeWorkerReport("/p", notificationOf(reportOf()), { generation: "aa", workerGeneration: 7 });
    await h.controller.probeNow();
    const counters = h.controller.counters();
    expect(counters.reportsAccepted).toBe(1);
    expect(counters.reportRows).toBe(1);
    const page = h.controller.journalPage();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ role: "project_worker", level: "warning", project: "0123456789abcdef", action: "ephemeral_caches" });
    expect(h.role("project_worker")).toMatchObject({ level: "warning", coverage: { expected: 1, answered: 1, complete: true } });
  });

  it("is dropped when the spawn that sent it was minted no generation", async () => {
    const h = harness({ workers: [...live] });
    h.controller.observeWorkerReport("/p", notificationOf(reportOf()), { generation: "aa", workerGeneration: undefined });
    await h.controller.probeNow();
    expect(h.controller.counters()).toMatchObject({ reportsUnidentified: 1, reportsAccepted: 0, reportRows: 0 });
    expect(h.controller.journalPage().events).toHaveLength(0);
  });

  it("is dropped when it does not match the contract, without saying what was in it", async () => {
    const h = harness({ workers: [...live] });
    for (const bad of [
      { ...reportOf(), level: "enormous" },
      { ...reportOf(), inputs: [{ kind: "physical", value: { status: "available", value: -1 } }] },
      { ...reportOf(), secret: "/home/someone/project" },
      { ...reportOf(), level: "normal" }, // rows beside a level that releases nothing
      "not an object",
      null,
    ]) {
      h.controller.observeWorkerReport("/p", notificationOf(bad), { generation: "aa", workerGeneration: 7 });
    }
    await h.controller.probeNow();
    expect(h.controller.counters().reportsMalformed).toBe(6);
    expect(h.controller.journalPage().events).toHaveLength(0);
    expect(h.logs.join("\n")).not.toContain("/home/someone/project");
    expect(h.logs.filter((line) => line.includes("did not match the contract"))).toHaveLength(6);
  });

  it("is dropped when the worker's own number is not the one this spawn was given", async () => {
    const h = harness({ workers: [...live] });
    h.controller.observeWorkerReport("/p", notificationOf(reportOf({ generation: 8 })), { generation: "aa", workerGeneration: 7 });
    await h.controller.probeNow();
    expect(h.controller.counters()).toMatchObject({ reportsGenerationMismatch: 1, reportsAccepted: 0 });
  });

  it("is dropped when that process has been replaced by the time its turn comes", async () => {
    const h = harness({ workers: [...live] });
    // The message arrives; before the queue reaches it, the pool replaces the
    // process behind that directory.
    h.controller.observeWorkerReport("/p", notificationOf(reportOf()), { generation: "aa", workerGeneration: 7 });
    h.setWorkers([{ cwd: "/p", clientGeneration: "cc", workerGeneration: 9 }]);
    await h.controller.probeNow();
    expect(h.controller.counters()).toMatchObject({ reportsStaleClient: 1, reportsAccepted: 0, reportRows: 0 });
    expect(h.controller.journalPage().events).toHaveLength(0);
  });

  it("is dropped when the directory has no live worker at all", async () => {
    const h = harness({ workers: [] });
    h.controller.observeWorkerReport("/p", notificationOf(reportOf()), { generation: "aa", workerGeneration: 7 });
    await h.controller.probeNow();
    expect(h.controller.counters().reportsStaleClient).toBe(1);
  });

  it("records a state-only report without inventing an event", async () => {
    const h = harness({ workers: [...live] });
    h.controller.observeWorkerReport(
      "/p",
      notificationOf(reportOf({ level: "normal", ran: [], results: [] })),
      { generation: "aa", workerGeneration: 7 },
    );
    await h.controller.probeNow();
    expect(h.controller.counters()).toMatchObject({ reportsAccepted: 1, reportRows: 0 });
    expect(h.controller.journalPage().events).toHaveLength(0);
    expect(h.role("project_worker")).toMatchObject({ level: "normal", coverage: { expected: 1, answered: 1 } });
  });
});

describe("how old a worker's evidence is", () => {
  const live: HostPressureWorker[] = [{ cwd: "/p", clientGeneration: "aa", workerGeneration: 7 }];

  it("is what we have held it plus what the worker said it already was", async () => {
    const h = harness({ workers: [...live] });
    h.controller.observeWorkerReport("/p", notificationOf(reportOf({ sampleAgeMs: 4_000 })), { generation: "aa", workerGeneration: 7 });
    await h.controller.probeNow();
    expect(h.role("project_worker").sampleAgeMs).toBe(4_000);
    h.advance(6_000);
    expect(h.role("project_worker").sampleAgeMs).toBe(10_000);
    // Past three elevated cadences it is simply not evidence any more.
    h.advance(6_000);
    expect(h.role("project_worker")).toMatchObject({ level: "unknown", coverage: { expected: 1, answered: 0, complete: false } });
    expect(h.role("project_worker").sampleAgeMs).toBeUndefined();
  });

  it("is missing, not zero, when the worker could not say how old its sample was", async () => {
    const h = harness({ workers: [...live] });
    const report = reportOf();
    delete (report as { sampleAgeMs?: number }).sampleAgeMs;
    h.controller.observeWorkerReport("/p", notificationOf(report), { generation: "aa", workerGeneration: 7 });
    await h.controller.probeNow();
    // The rows it brought are still recorded; the worker is simply unanswered.
    expect(h.controller.counters().reportRows).toBe(1);
    expect(h.role("project_worker")).toMatchObject({ level: "unknown", coverage: { expected: 1, answered: 0 } });
  });

  it("stops counting the moment that exact process goes away", async () => {
    const h = harness({ workers: [...live] });
    h.controller.observeWorkerReport("/p", notificationOf(reportOf()), { generation: "aa", workerGeneration: 7 });
    await h.controller.probeNow();
    expect(h.role("project_worker").level).toBe("warning");

    // A different process's exit changes nothing.
    h.controller.forgetWorker("/p", "zz");
    expect(h.controller.counters().workersForgotten).toBe(0);
    expect(h.role("project_worker").level).toBe("warning");

    h.controller.forgetWorker("/p", "aa");
    expect(h.controller.counters().workersForgotten).toBe(1);
    expect(h.role("project_worker")).toMatchObject({ level: "unknown", coverage: { expected: 1, answered: 0 } });
    // What that worker actually did stays in the journal: it happened.
    expect(h.controller.journalPage().events).toHaveLength(1);
  });
});

describe("publishing", () => {
  it("publishes a change once, with a strictly increasing epoch", async () => {
    const h = harness();
    h.setSample({ physical: { status: "available", value: 600 * MiB } });
    await probe(h, 2);
    expect(h.published.length).toBeGreaterThan(0);
    const epochs = h.published.map((publication) => publication.epoch);
    expect([...epochs].sort((a, b) => a - b)).toEqual(epochs);
    expect(new Set(epochs).size).toBe(epochs.length);
    expect(h.published.at(-1)!.summary.roles.find((row) => row.role === "host")!.level).toBe("warning");
  });

  it("says nothing when nothing a reader cares about moved", async () => {
    const h = harness();
    await probe(h, 4);
    const first = h.published.length;
    await probe(h, 4);
    expect(h.published.length).toBe(first);
  });

  it("keeps only the newest state inside one window", async () => {
    const h = harness();
    // Three transitions with no clock movement between them: one goes out now,
    // and the window holds the rest until it opens.
    h.setSample({ physical: { status: "available", value: 100 * MiB } });
    await h.controller.probeNow();
    await h.controller.probeNow();
    const sent = h.published.length;
    h.setSample({ physical: { status: "available", value: 900 * MiB } });
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.published.length).toBe(sent);
    expect(h.controller.counters().publishCoalesced).toBeGreaterThanOrEqual(0);

    // When the window opens, what goes out is the state as it is now.
    h.advance(5_000);
    const timer = h.timers.find((entry) => entry.ms <= 5_000);
    timer?.fire();
    expect(h.published.at(-1)!.summary.roles.find((row) => row.role === "host")!.level).toBe("critical");
  });

  it("counts a publication the socket layer refused, and never retries it", async () => {
    const failing = vi.fn(() => {
      throw new Error("no sockets");
    });
    const h = harness({ publish: failing });
    h.setSample({ physical: { status: "available", value: 600 * MiB } });
    await probe(h, 2);
    expect(h.controller.counters().publishFailures).toBeGreaterThan(0);
    const calls = failing.mock.calls.length;
    h.advance(60_000);
    for (const timer of [...h.timers]) timer.fire();
    expect(failing.mock.calls.length).toBe(calls);
  });

  it("survives a pool and an inventory that throw, and says so as one line", async () => {
    let at = 1_000;
    const controller = createHostPressureController({
      sample: async () => ({
        atMs: at,
        physical: { status: "available", value: 100 * MiB },
        heapUsed: { status: "available", value: 1 },
        heapLimit: { status: "available", value: 1_000 * MiB },
        machineAvailable: { status: "available", value: 8_000 * MiB },
      }),
      workers: () => {
        throw new Error("the pool is busy");
      },
      publish: () => undefined,
      projectIdOf: () => {
        throw new Error("no identity");
      },
      rendererPresent: () => {
        throw new Error("no idea");
      },
      now: () => at,
      setTimer: (fn, ms) => ({ fn, ms }),
      clearTimer: () => undefined,
    });
    await controller.probeNow();
    at += 10;
    const summary = controller.summary();
    // A pool that cannot answer is missing coverage, and a window it cannot ask
    // about is assumed to be there rather than assumed away.
    expect(summary.roles.find((row) => row.role === "project_worker")).toMatchObject({ level: "unknown", coverage: { expected: 1, answered: 0 } });
    expect(summary.roles.find((row) => row.role === "desktop_renderer")!.level).toBe("unknown");
    expect(() => parseMemoryPressureSummary(summary)).not.toThrow();
    controller.dispose();
  });
});

describe("the timer and the end of the host's life", () => {
  it("looks every twenty seconds, and every five under pressure", async () => {
    const h = harness();
    h.controller.start();
    expect(h.timers.at(-1)!.ms).toBe(20_000);
    h.setSample({ physical: { status: "available", value: 900 * MiB } });
    await probe(h, 2);
    h.timers.at(-1)!.fire();
    await Promise.resolve();
    await h.controller.probeNow();
    expect(h.timers.at(-1)!.ms).toBe(5_000);
    h.controller.dispose();
  });

  it("never keeps the process alive: every timer it owns is unref'd", () => {
    const unref = vi.fn();
    const controller = createHostPressureController({
      sample: async () => ({
        atMs: 0,
        physical: { status: "unavailable", reason: "collector_failed" },
        heapUsed: { status: "unavailable", reason: "collector_failed" },
        heapLimit: { status: "unavailable", reason: "collector_failed" },
        machineAvailable: { status: "unavailable", reason: "collector_failed" },
      }),
      workers: () => [],
      publish: () => undefined,
      rendererPresent: () => false,
      setTimer: () => ({ unref }),
      clearTimer: () => undefined,
    });
    controller.start();
    expect(unref).toHaveBeenCalled();
    controller.dispose();
  });

  it("publishes nothing, records nothing and logs nothing once disposed", async () => {
    const h = harness({ workers: [{ cwd: "/p", clientGeneration: "aa", workerGeneration: 7 }] });
    h.controller.start();
    await probe(h);
    const published = h.published.length;
    const logs = h.logs.length;
    h.controller.dispose();

    h.setSample({ physical: { status: "available", value: 900 * MiB } });
    await probe(h, 3);
    h.controller.observeWorkerReport("/p", notificationOf(reportOf()), { generation: "aa", workerGeneration: 7 });
    h.controller.observeWorkerReport("/p", notificationOf({ nonsense: true }), { generation: "aa", workerGeneration: 7 });
    await Promise.resolve();
    expect(h.published.length).toBe(published);
    expect(h.logs.length).toBe(logs);
    expect(h.controller.journalPage().events).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
  });
});
