/**
 * The window's pressure actor (RP-8 milestone F, D-265).
 *
 * What is proved here: a level is only ever claimed with evidence; missing
 * evidence is `unknown` and authorizes nothing; a level changes only after the
 * samples agree; a pass runs the two steps this window owns in the policy's
 * order and reports what it measured; a host summary is validated, fenced by
 * epoch and never allowed to speak for the renderer row; every callback that
 * throws is counted and forgotten; and nothing here is persisted.
 */
import { describe, expect, it, vi } from "vitest";
import {
  memoryPressureActionResultSchema,
  type MemoryPressureLevelState,
  type MemoryPressureRoleState,
} from "@lasercode/protocol";

import {
  createRendererPressureController,
  type RendererPressureController,
  type RendererPressureDeps,
} from "../../../src/runtime/pressure/controller.js";
import {
  PRESSURE_ELEVATED_INTERVAL_MS,
  PRESSURE_NORMAL_INTERVAL_MS,
  PRESSURE_STALE_CADENCES,
  RENDERER_PRESSURE_THRESHOLDS,
  heapThresholds,
  type RendererPressureSample,
} from "../../../src/runtime/pressure/thresholds.js";
import type { ReleaseOutcome, RendererViewCounters } from "../../../src/runtime/view-cache.js";

const MiB = 1024 * 1024;
const NOTHING: ReleaseOutcome = { released: [], bytesReleased: 0, refused: [] };

const counters = (bytes: number): RendererViewCounters => ({
  views: 1, hydrated: 1, pinned: 0, dormant: 0, entriesBytes: bytes, blocksBytes: 0, imagesBytes: 0, imagesEstimated: 0,
  bytes, heapEquivalentBytes: bytes, largestViewBytes: bytes, largestBlockBytes: 0, largestBodyBytes: 0,
  referencedBytes: 0, referencedImageBytes: 0, trims: 0, drafts: 0, evictions: 0,
  tailsPending: 0, tailsPendingBytes: 0, tailsDropped: 0,
  limits: { views: 6, bytes: 4 * MiB, viewBytes: 1_572_864 },
  calibration: { model: "test", fittedAt: "2026-09-16" },
});

interface Harness {
  controller: RendererPressureController;
  /** Set what the next sample says. `undefined` physical means unreadable. */
  physical(mib: number | undefined): void;
  heap(used: number | undefined, limit?: number): void;
  advance(ms: number): void;
  fireTimer(): Promise<void>;
  releaseCalls: Array<"warning" | "critical">;
  ephemeralCalls: number;
  now(): number;
  counterSnapshot(): RendererPressureController extends never ? never : ReturnType<RendererPressureController["getSnapshot"]>["counters"];
}

function harness(over: Partial<RendererPressureDeps> & { viewBytes?: () => number } = {}): Harness {
  let clock = 100_000;
  let physicalBytes: number | undefined = 100 * MiB;
  let heapUsed: number | undefined = 10 * MiB;
  let heapLimit = 4096 * MiB;
  let pending: (() => void) | undefined;
  const releaseCalls: Array<"warning" | "critical"> = [];
  let ephemeralCalls = 0;
  let viewBytes = 1_000_000;

  const sample = async (): Promise<RendererPressureSample> => ({
    atMs: clock,
    physical: physicalBytes === undefined
      ? { status: "unavailable", reason: "unsupported_platform" }
      : { status: "available", value: physicalBytes },
    heapUsed: heapUsed === undefined ? { status: "unavailable", reason: "unsupported_platform" } : { status: "available", value: heapUsed },
    heapLimit: heapUsed === undefined ? { status: "unavailable", reason: "unsupported_platform" } : { status: "available", value: heapLimit },
  });

  const controller = createRendererPressureController({
    sample,
    cache: {
      releaseUnder: (level) => { releaseCalls.push(level); viewBytes = Math.floor(viewBytes / 2); return NOTHING; },
      counters: () => counters(over.viewBytes ? over.viewBytes() : viewBytes),
    },
    ephemeral: () => { ephemeralCalls += 1; return { count: 0, bytes: 0, failures: 0 }; },
    now: () => clock,
    schedule: (run) => { pending = run; return () => { pending = undefined; }; },
    ...over,
  });

  return {
    controller,
    physical: (mib) => { physicalBytes = mib === undefined ? undefined : mib * MiB; },
    heap: (used, limit) => { heapUsed = used === undefined ? undefined : used * MiB; if (limit !== undefined) heapLimit = limit * MiB; },
    advance: (ms) => { clock += ms; },
    fireTimer: async () => { const run = pending; pending = undefined; run?.(); await controller.probeNow(); },
    releaseCalls,
    get ephemeralCalls() { return ephemeralCalls; },
    now: () => clock,
    counterSnapshot: () => controller.getSnapshot().counters,
  } as Harness;
}

/** Observe one sample at the current settings. */
const look = async (h: Harness, times = 1): Promise<void> => {
  for (let index = 0; index < times; index++) {
    h.advance(PRESSURE_ELEVATED_INTERVAL_MS);
    await h.controller.probeNow();
  }
};

const role = (name: MemoryPressureRoleState["role"], level: MemoryPressureLevelState): MemoryPressureRoleState =>
  level === "unknown"
    ? { role: name, level, inputs: [], coverage: { expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" } }
    : {
        role: name,
        level,
        inputs: [{ kind: "physical", value: { status: "available", value: 512 * MiB }, warningBytes: 512 * MiB, criticalBytes: 768 * MiB }],
        coverage: { expected: 1, answered: 1, complete: true },
      };

const publication = (epoch: number, levels: Partial<Record<MemoryPressureRoleState["role"], MemoryPressureLevelState>>) => {
  const roles = (["host", "project_worker", "desktop_renderer", "machine"] as const).map((name) => role(name, levels[name] ?? "normal"));
  const worst = roles.some((row) => row.level === "critical")
    ? "critical"
    : roles.some((row) => row.level === "warning")
      ? "warning"
      : roles.some((row) => row.level === "unknown")
        ? "unknown"
        : "normal";
  return { epoch, summary: { level: worst, roles, refusing: [], totals: { events: 0, released: { count: 0, bytes: 0 }, refusals: 0 } } };
};

describe("evidence before anything else", () => {
  it("starts unknown and stays unknown while it can read nothing", async () => {
    const h = harness();
    h.physical(undefined);
    h.heap(undefined);
    expect(h.controller.getSnapshot().level).toBe("unknown");
    await look(h, 3);
    expect(h.controller.getSnapshot().level).toBe("unknown");
    // Unknown authorizes nothing: no release, and nothing refused.
    expect(h.releaseCalls).toEqual([]);
    expect(h.controller.admits("whole_transcript")).toBe(true);
  });

  it("refuses a heap limit whose threshold pair collapses", () => {
    expect(heapThresholds({ status: "available", value: 1 }, RENDERER_PRESSURE_THRESHOLDS)).toBeUndefined();
  });

  it("decides a level from heap alone where physical cannot be read", async () => {
    const h = harness();
    h.physical(undefined);
    h.heap(3000, 4096); // 0.73 of the limit: over 0.60, under 0.75
    await look(h, 2);
    expect(h.controller.getSnapshot().level).toBe("warning");
  });

  it("never presents a missing reading as a number", async () => {
    const h = harness();
    h.physical(undefined);
    await look(h);
    const inputs = h.controller.getSnapshot().inputs;
    expect(inputs.find((input) => input.kind === "physical")?.value).toEqual({ status: "unavailable", reason: "unsupported_platform" });
  });

  it("omits an unsafe or negative sample age instead of substituting zero", async () => {
    const controller = createRendererPressureController({
      sample: async () => ({ atMs: 900_000, physical: { status: "available", value: 10 }, heapUsed: { status: "unavailable", reason: "unsupported_platform" }, heapLimit: { status: "unavailable", reason: "unsupported_platform" } }),
      cache: { releaseUnder: () => NOTHING, counters: () => counters(0) },
      now: () => 800_000,
      schedule: () => () => {},
    });
    await controller.probeNow();
    expect(controller.getSnapshot().sampleAgeMs).toBeUndefined();
  });

  it("treats a sample with no safe timestamp as stale unknown", async () => {
    const controller = createRendererPressureController({
      sample: async () => ({ physical: { status: "available", value: 2_000 * MiB }, heapUsed: { status: "unavailable", reason: "unsupported_platform" }, heapLimit: { status: "unavailable", reason: "unsupported_platform" } }),
      cache: { releaseUnder: () => NOTHING, counters: () => counters(0) },
      now: () => 800_000,
      schedule: () => () => {},
    });
    await controller.probeNow();
    await controller.probeNow();
    expect(controller.getSnapshot().level).toBe("unknown");
    expect(controller.getSnapshot().sampleAgeMs).toBeUndefined();
    expect(controller.getSnapshot().counters.staleSamples).toBe(2);
  });
});

describe("hysteresis", () => {
  it("escalates only after two agreeing samples", async () => {
    const h = harness();
    h.physical(1300); // over the 1280 MiB warning line
    await look(h);
    expect(h.controller.getSnapshot().level).toBe("unknown");
    await look(h);
    expect(h.controller.getSnapshot().level).toBe("warning");
  });

  it("releases only after three samples below the 0.85 line", async () => {
    const h = harness();
    h.physical(1300);
    await look(h, 2);
    expect(h.controller.getSnapshot().level).toBe("warning");
    // 1100 MiB is below warning but above 0.85 × 1280 = 1088 MiB: no flapping.
    h.physical(1100);
    await look(h, 5);
    expect(h.controller.getSnapshot().level).toBe("warning");
    // Below the release line, one agreeing reading is never enough. (A pass's
    // own intermediate probe is a reading too, so the run reaches three from
    // fewer looks than samples — which is why the assertion is "not after the
    // first" rather than a count of ticks.)
    h.physical(900);
    await look(h);
    expect(h.controller.getSnapshot().level).toBe("warning");
    await look(h, 2);
    expect(h.controller.getSnapshot().level).toBe("normal");
  });

  it("lets every unknown reset the streak in both directions", async () => {
    const h = harness();
    h.physical(1300);
    await look(h);
    h.physical(undefined);
    h.heap(undefined);
    await look(h);
    expect(h.controller.getSnapshot().level).toBe("unknown");
    h.physical(1300);
    h.heap(10, 4096);
    await look(h);
    expect(h.controller.getSnapshot().level).toBe("unknown");
    await look(h);
    expect(h.controller.getSnapshot().level).toBe("warning");
  });

  it("calls a sample older than three cadences unknown, not the level before it", async () => {
    const h = harness();
    h.physical(1300);
    await look(h, 2);
    expect(h.controller.getSnapshot().level).toBe("warning");
    // The clock moves without a fresh sample time: the next reading is stale.
    const stale = harness({ sample: async () => ({
      atMs: 0,
      physical: { status: "available", value: 1300 * MiB },
      heapUsed: { status: "unavailable", reason: "unsupported_platform" },
      heapLimit: { status: "unavailable", reason: "unsupported_platform" },
    }) });
    await look(stale, 2);
    expect(stale.controller.getSnapshot().level).toBe("unknown");
    expect(stale.controller.getSnapshot().counters.staleSamples).toBeGreaterThan(0);
  });

  it("counts a sampler that throws, stays unknown and keeps running", async () => {
    let fail = true;
    const h = harness({ sample: async () => { if (fail) throw new Error("no"); return { atMs: 200_000, physical: { status: "available", value: 10 * MiB }, heapUsed: { status: "unavailable", reason: "unsupported_platform" }, heapLimit: { status: "unavailable", reason: "unsupported_platform" } }; }, now: () => 200_000 });
    await h.controller.probeNow();
    expect(h.controller.getSnapshot().level).toBe("unknown");
    expect(h.controller.getSnapshot().counters.sampleFailures).toBe(1);
    fail = false;
    await h.controller.probeNow();
    await h.controller.probeNow();
    expect(h.controller.getSnapshot().level).toBe("normal");
  });
});

describe("the pass", () => {
  it("runs the two steps this window owns, in the policy's order, with measured bytes", async () => {
    const h = harness({ ephemeral: () => ({ count: 2, bytes: 4096, failures: 0 }) });
    h.physical(1300);
    await look(h, 2);
    const rows = h.controller.getSnapshot().rows;
    expect(rows.map((row) => row.action)).toEqual(["renderer_views", "ephemeral_caches"]); // newest first
    expect(rows.find((row) => row.action === "ephemeral_caches")).toMatchObject({ outcome: "released", released: { count: 2, bytes: 4096 } });
    const views = rows.find((row) => row.action === "renderer_views")!;
    expect(views).toMatchObject({ outcome: "released", level: "warning" });
    expect(views.released?.bytes).toBe(500_000); // the cache's own before/after delta
    expect(h.releaseCalls).toEqual(["warning"]);
    // Every row is built to the contract, even though none of them travels.
    for (const row of rows) expect(memoryPressureActionResultSchema.safeParse({ action: row.action, outcome: row.outcome, ...(row.released ? { released: row.released } : {}), ...(row.reason ? { reason: row.reason } : {}), ...(row.refusal ? { refusal: row.refusal } : {}) }).success).toBe(true);
  });

  it("says nothing_to_give rather than inventing a release", async () => {
    const h = harness({ viewBytes: () => 1_000_000 });
    h.physical(1300);
    await look(h, 2);
    const rows = h.controller.getSnapshot().rows;
    expect(rows.find((row) => row.action === "ephemeral_caches")?.outcome).toBe("nothing_to_give");
    expect(rows.find((row) => row.action === "renderer_views")?.outcome).toBe("nothing_to_give");
  });

  it("reports a hold when everything releasable is work somebody is doing", async () => {
    const h = harness({
      viewBytes: () => 1_000_000,
      cache: {
        releaseUnder: () => ({ released: [], bytesReleased: 0, refused: [{ path: "/p/s.jsonl", pin: "current" as const }] }),
        counters: () => counters(1_000_000),
      },
    });
    h.physical(1300);
    await look(h, 2);
    expect(h.controller.getSnapshot().rows.find((row) => row.action === "renderer_views")).toMatchObject({ outcome: "held", reason: "pins_held" });
  });

  it("stops a self pass between steps when the pressure has already gone", async () => {
    const h = harness({ ephemeral: () => ({ count: 1, bytes: 8, failures: 0 }) });
    h.physical(1300);
    await look(h);
    // The second look escalates and starts the pass; the probe between the two
    // steps sees a relieved window.
    let releasedAt = 0;
    const controller = createRendererPressureController({
      sample: async () => ({
        atMs: 300_000,
        physical: { status: "available", value: (releasedAt++ < 2 ? 1300 : 100) * MiB },
        heapUsed: { status: "unavailable", reason: "unsupported_platform" },
        heapLimit: { status: "unavailable", reason: "unsupported_platform" },
      }),
      cache: { releaseUnder: () => NOTHING, counters: () => counters(10) },
      ephemeral: () => ({ count: 1, bytes: 8, failures: 0 }),
      now: () => 300_000,
      schedule: () => () => {},
    });
    await controller.probeNow();
    await controller.probeNow();
    const rows = controller.getSnapshot().rows;
    expect(rows.map((row) => row.action)).toEqual(["ephemeral_caches"]);
    expect(controller.getSnapshot().counters.passesStoppedEarly).toBe(1);
  });

  it("keeps a step that throws categorical and stops the pass there", async () => {
    const h = harness({ ephemeral: () => { throw new Error("cache"); } });
    h.physical(1300);
    await look(h, 2);
    const rows = h.controller.getSnapshot().rows;
    expect(rows.map((row) => row.action)).toEqual(["ephemeral_caches"]);
    expect(rows[0]!.outcome).toBe("unavailable");
    expect(h.releaseCalls).toEqual([]);
    expect(h.controller.getSnapshot().counters.stepFailures).toBe(1);
  });

  it("waits out the cooldown of the level that ran, and longer after a quiet pass", async () => {
    const h = harness({ viewBytes: () => 1_000_000 });
    h.physical(1300);
    await look(h, 2);
    expect(h.releaseCalls.length).toBe(1);
    h.advance(31_000); // past warning's 30 s, but the pass gave nothing back
    await h.controller.probeNow();
    expect(h.releaseCalls.length).toBe(1);
    h.advance(30_000); // past the 60 s quiet cooldown
    await h.controller.probeNow();
    expect(h.releaseCalls.length).toBe(2);
  });

  it("treats a cache that cannot be read as unavailable, never as nothing", async () => {
    const h = harness({ ephemeral: () => ({ count: 0, bytes: 0, failures: 1 }) });
    h.physical(1300);
    await look(h, 2);
    expect(h.controller.getSnapshot().rows.find((row) => row.action === "ephemeral_caches")?.outcome).toBe("unavailable");
  });
});

describe("what this window refuses", () => {
  it("refuses whole-transcript reads only under pressure, and records one row per window", async () => {
    const h = harness();
    expect(h.controller.admits("whole_transcript")).toBe(true);
    h.physical(1300);
    await look(h, 2);
    expect(h.controller.admits("whole_transcript")).toBe(false);
    h.controller.refused("whole_transcript");
    h.controller.refused("whole_transcript");
    h.controller.refused("whole_transcript");
    const state = h.controller.getSnapshot();
    expect(state.rows.filter((row) => row.action === "admission_refused")).toHaveLength(1);
    expect(state.totals.refusals).toBe(3);
    expect(state.counters.refusalsSuppressed).toBe(2);
    // A later window records again.
    h.advance(6_000);
    h.controller.refused("whole_transcript");
    expect(h.controller.getSnapshot().rows.filter((row) => row.action === "admission_refused")).toHaveLength(2);
  });

  it("refuses nothing while the level is unknown", async () => {
    const h = harness();
    h.physical(undefined);
    h.heap(undefined);
    await look(h, 3);
    h.controller.refused("whole_transcript");
    expect(h.controller.admits("whole_transcript")).toBe(true);
    expect(h.controller.getSnapshot().rows).toHaveLength(0);
  });
});

describe("the host's summary", () => {
  it("ignores a payload it cannot read, without logging it", async () => {
    const h = harness();
    h.controller.observePublication({ epoch: 1, summary: { level: "normal" } });
    h.controller.observePublication("nonsense");
    expect(h.controller.getSnapshot().counters.directivesMalformed).toBe(2);
    expect(h.controller.getSnapshot().host.level).toBe("unknown");
  });

  it("acts on a valid newer epoch and never on an older or repeated one", async () => {
    const h = harness();
    h.controller.observePublication(publication(4, { host: "critical" }));
    await h.controller.probeNow();
    expect(h.releaseCalls).toEqual(["critical"]);
    expect(h.controller.admits("whole_transcript")).toBe(false);
    h.advance(11_000);
    h.controller.observePublication(publication(3, { host: "critical" }));
    h.controller.observePublication(publication(4, { host: "critical" }));
    await h.controller.probeNow();
    expect(h.releaseCalls).toEqual(["critical"]);
    expect(h.controller.getSnapshot().counters.directivesStale).toBe(2);
  });

  it("reads the host's level the way the host decides it, renderer row excluded", async () => {
    const h = harness();
    h.controller.observePublication(publication(1, { desktop_renderer: "critical" }));
    await h.controller.probeNow();
    expect(h.controller.getSnapshot().host.level).toBe("normal");
    expect(h.releaseCalls).toEqual([]);
    expect(h.controller.admits("whole_transcript")).toBe(true);
  });

  it("expires a silent host level without letting an older publication revive it", async () => {
    const h = harness();
    h.controller.observePublication(publication(5, { host: "warning" }));
    await h.controller.probeNow();
    expect(h.controller.admits("whole_transcript")).toBe(false);
    h.advance(PRESSURE_STALE_CADENCES * PRESSURE_ELEVATED_INTERVAL_MS + 1);
    expect(h.controller.admits("whole_transcript")).toBe(true);
    h.controller.observePublication(publication(4, { host: "warning" }));
    expect(h.controller.admits("whole_transcript")).toBe(true);
    expect(h.controller.getSnapshot().host.level).toBe("unknown");
    expect(h.controller.getSnapshot().counters.directivesStale).toBe(1);
  });

  it("hears a restarted host again after the socket opens", async () => {
    const h = harness();
    h.controller.observePublication(publication(9, { host: "warning" }));
    await h.controller.probeNow();
    expect(h.releaseCalls).toEqual(["warning"]);
    h.controller.forgetHost();
    expect(h.controller.getSnapshot().host.level).toBe("unknown");
    h.advance(60_000);
    h.controller.observePublication(publication(1, { host: "warning" }));
    await h.controller.probeNow();
    expect(h.releaseCalls).toEqual(["warning", "warning"]);
  });

  it("does not let a host pass overlap the next one", async () => {
    const h = harness();
    h.controller.observePublication(publication(1, { host: "critical" }));
    h.controller.observePublication(publication(2, { host: "critical" }));
    await h.controller.probeNow();
    expect(h.releaseCalls).toEqual(["critical"]);
  });
});

describe("lifecycle", () => {
  it("forgets everything when the environment changes, and persists nothing", async () => {
    const h = harness({ ephemeral: () => ({ count: 1, bytes: 2, failures: 0 }) });
    h.physical(1300);
    await look(h, 2);
    expect(h.controller.getSnapshot().rows.length).toBeGreaterThan(0);
    h.controller.reset();
    const state = h.controller.getSnapshot();
    expect(state.rows).toHaveLength(0);
    expect(state.level).toBe("unknown");
    expect(state.host).toEqual({ level: "unknown" });
    expect(state.totals).toEqual({ passes: 0, released: { count: 0, bytes: 0 }, refusals: 0 });
    expect(state.counters).toEqual({
      samples: 0, sampleFailures: 0, staleSamples: 0, passes: 0, passesStoppedEarly: 0,
      stepFailures: 0, directivesAccepted: 0, directivesStale: 0, directivesMalformed: 0,
      refusals: 0, refusalsSuppressed: 0, callbackFailures: 0,
    });
  });

  it("discards a late sample from the environment it just left", async () => {
    let answer: ((sample: RendererPressureSample) => void) | undefined;
    const controller = createRendererPressureController({
      sample: () => new Promise<RendererPressureSample>((resolve) => { answer = resolve; }),
      cache: { releaseUnder: () => NOTHING, counters: () => counters(10) },
      now: () => 400_000,
      schedule: () => () => {},
    });
    const oldProbe = controller.probeNow();
    await Promise.resolve();
    controller.reset();
    answer!({
      atMs: 400_000,
      physical: { status: "available", value: 2_000 * MiB },
      heapUsed: { status: "unavailable", reason: "unsupported_platform" },
      heapLimit: { status: "unavailable", reason: "unsupported_platform" },
    });
    await oldProbe;
    expect(controller.getSnapshot().level).toBe("unknown");
    expect(controller.getSnapshot().counters.samples).toBe(0);
    expect(controller.getSnapshot().rows).toHaveLength(0);
  });

  it("stops looking and stops acting once disposed", async () => {
    const h = harness();
    h.physical(1300);
    await look(h, 2);
    const before = h.releaseCalls.length;
    h.controller.dispose();
    h.advance(120_000);
    await h.controller.probeNow();
    h.controller.observePublication(publication(50, { host: "critical" }));
    await h.controller.probeNow();
    expect(h.releaseCalls.length).toBe(before);
  });

  it("counts a listener that throws and keeps the pass going", async () => {
    const h = harness();
    const listener = vi.fn(() => { throw new Error("render"); });
    h.controller.subscribe(listener);
    h.physical(1300);
    await look(h, 2);
    expect(listener).toHaveBeenCalled();
    expect(h.controller.getSnapshot().counters.callbackFailures).toBeGreaterThan(0);
    expect(h.releaseCalls).toEqual(["warning"]);
  });

  it("uses the elevated cadence under pressure and the normal one otherwise", async () => {
    let physical = 100 * MiB;
    let pending: (() => void) | undefined;
    const delays: number[] = [];
    const controller = createRendererPressureController({
      sample: async () => ({ atMs: 700_000, physical: { status: "available", value: physical }, heapUsed: { status: "unavailable", reason: "unsupported_platform" }, heapLimit: { status: "unavailable", reason: "unsupported_platform" } }),
      cache: { releaseUnder: () => NOTHING, counters: () => counters(0) },
      now: () => 700_000,
      schedule: (run, ms) => { pending = run; delays.push(ms); return () => {}; },
    });
    controller.start();
    // Flush the immediate tick, which arms the first timer.
    await controller.probeNow();
    await Promise.resolve();
    expect(delays.at(-1)).toBe(PRESSURE_NORMAL_INTERVAL_MS);
    physical = 2_000 * MiB;
    await controller.probeNow();
    await controller.probeNow();
    expect(controller.getSnapshot().level).toBe("critical");
    // Let the armed cadence finish one real tick; its replacement must use the
    // elevated interval rather than leaving the old normal timer in place.
    pending?.();
    await controller.probeNow();
    await Promise.resolve();
    expect(delays.at(-1)).toBe(PRESSURE_ELEVATED_INTERVAL_MS);
    controller.dispose();
    expect(RENDERER_PRESSURE_THRESHOLDS.criticalBytes).toBe(1920 * MiB);
  });

  it("keeps only the bounded recent record while totals remain monotonic", async () => {
    const h = harness();
    h.physical(1300);
    await look(h, 2);
    for (let index = 0; index < 55; index++) {
      h.advance(6_000);
      h.controller.refused("whole_transcript");
    }
    expect(h.controller.getSnapshot().rows).toHaveLength(50);
    expect(h.controller.getSnapshot().totals.refusals).toBe(55);
  });
});
