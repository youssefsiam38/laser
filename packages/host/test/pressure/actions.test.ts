import { describe, expect, it, vi } from "vitest";
import type { MemoryPressureActionResult, MemoryPressureDirectiveResult } from "@lasercode/protocol";
import { createHostPressureController, type HostPressureActions, type HostPressureSample, type HostPressureWorker } from "../../src/pressure/index.js";
import { SessionIndexCache } from "../../src/session-index.js";
import { ViewCache } from "../../src/views.js";

const MiB = 1024 * 1024;
const critical = (atMs: number): HostPressureSample => ({
  atMs,
  physical: { status: "available", value: 900 * MiB },
  heapUsed: { status: "available", value: 900 * MiB },
  heapLimit: { status: "available", value: 1_000 * MiB },
  machineAvailable: { status: "available", value: 8_000 * MiB },
});
const normal = (atMs: number): HostPressureSample => ({ ...critical(atMs), physical: { status: "available", value: 10 * MiB }, heapUsed: { status: "available", value: 10 * MiB } });
const result = (count = 1): MemoryPressureDirectiveResult => ({
  applied: true,
  ran: ["ephemeral_caches"],
  results: [{ action: "ephemeral_caches", outcome: "released", released: { count } }],
  stores: {},
}) as MemoryPressureDirectiveResult;
const idle: MemoryPressureActionResult = { action: "idle_session_unload", outcome: "nothing_to_give" };

describe("the host's own pressure pass", () => {
  it("reports step 1 exactly and leaves unrelated caches alone", async () => {
    let at = 1_000;
    let held = true;
    const viewCache = new ViewCache();
    const indexCache = new SessionIndexCache();
    const clearViews = vi.spyOn(viewCache, "clear");
    const clearIndex = vi.spyOn(indexCache, "clear");
    const actions: HostPressureActions = {
      releaseEphemeral: () => { const was = held; held = false; return was; },
      directive: async () => result(),
      unloadIdle: async () => idle,
      retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }),
    };
    const controller = createHostPressureController({
      sample: async () => critical(at), workers: () => [], publish: () => {}, rendererPresent: () => false,
      now: () => at, actions,
    });
    await controller.probeNow(); at += 1;
    await controller.probeNow();
    const row = controller.journalPage().events.find((event) => event.action === "ephemeral_caches")!;
    expect(row).toMatchObject({ outcome: "released", released: { count: 1 } });
    expect(clearViews).not.toHaveBeenCalled();
    expect(clearIndex).not.toHaveBeenCalled();
    expect(controller.journalPage().events.filter((event) => event.action === "ephemeral_caches" && event.role === "host")).toHaveLength(1);
  });

  it("says nothing_to_give when the body memo was already empty", async () => {
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => [], publish: () => {}, rendererPresent: () => false,
      actions: { releaseEphemeral: () => false, directive: async () => result(), unloadIdle: async () => idle, retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }) },
    });
    await controller.probeNow();
    await controller.probeNow();
    const row = controller.journalPage().events.find((event) => event.action === "ephemeral_caches")!;
    expect(row.outcome).toBe("nothing_to_give");
    expect(row).not.toHaveProperty("released");
  });

  it("journals then re-probes and stops immediately on relief", async () => {
    let reads = 0;
    const directive = vi.fn(async () => result());
    const unload = vi.fn(async () => idle);
    const controller = createHostPressureController({
      sample: async () => (++reads <= 2 ? critical(reads) : normal(reads)),
      now: () => reads,
      workers: () => [{ cwd: "/p", clientGeneration: "a", workerGeneration: 1 }],
      publish: () => {}, rendererPresent: () => false,
      actions: { releaseEphemeral: () => true, directive, unloadIdle: unload, retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }) },
    });
    await controller.probeNow();
    await controller.probeNow();
    expect(controller.journalPage().events.map((event) => event.action)).toEqual(["ephemeral_caches"]);
    expect(directive).not.toHaveBeenCalled();
    expect(unload).not.toHaveBeenCalled();
  });

  it("bounds directives at four, journals in selection order, and authorizes only fresh exact generations", async () => {
    let at = 1_000;
    const workers: HostPressureWorker[] = Array.from({ length: 6 }, (_, i) => ({ cwd: `/p${i}`, clientGeneration: `c${i}`, workerGeneration: i + 1 }));
    const order: string[] = [];
    const epochs: number[] = [];
    let unloadAllowed = 0;
    const controller = createHostPressureController({
      sample: async () => critical(at), workers: () => workers, publish: () => {}, rendererPresent: () => false,
      projectIdOf: (cwd) => `${String(workers.findIndex((w) => w.cwd === cwd) + 1).padStart(16, "0")}`,
      now: () => at,
      actions: {
        releaseEphemeral: () => false,
        directive: async (cwd, _expect, params) => { order.push(cwd); epochs.push(params.epoch); return result(Number(cwd.slice(2)) + 1); },
        unloadIdle: async (_level, allow) => { unloadAllowed = workers.filter((w) => allow(w.cwd)).length; return idle; },
        retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }),
      },
    }, { directiveStageMs: 20 });
    await controller.probeNow(); at += 1;
    await controller.probeNow();
    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
    expect(unloadAllowed).toBe(4);
    const workerRows = controller.journalPage().events.filter((event) => event.role === "project_worker");
    // Pages are newest-first; reverse to inspect insertion/selection order.
    expect(workerRows.reverse().map((row) => row.released?.count)).toEqual([1, 2, 3, 4]);
    expect(controller.counters().directivesSent).toBe(4);
    expect(new Set(epochs)).toEqual(new Set([1]));

    // Critical's 10 s pass cooldown has elapsed, but each selected worker's
    // own 30 s skip has not: the two that did not get a turn go next.
    at += 10_001;
    await controller.probeNow();
    expect(new Set(order.slice(4))).toEqual(new Set(["/p4", "/p5"]));
    expect(new Set(epochs.slice(4))).toEqual(new Set([2]));
  });

  it("selects the worst fresh worker level before a calmer one", async () => {
    const workers: HostPressureWorker[] = [
      { cwd: "/normal", clientGeneration: "n", workerGeneration: 1 },
      { cwd: "/critical", clientGeneration: "c", workerGeneration: 2 },
      { cwd: "/warning", clientGeneration: "w", workerGeneration: 3 },
    ];
    const order: string[] = [];
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => workers, publish: () => {}, rendererPresent: () => false,
      actions: {
        releaseEphemeral: () => false,
        directive: async (cwd) => { order.push(cwd); return result(); },
        unloadIdle: async () => idle,
        retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }),
      },
    });
    const levels = ["normal", "critical", "warning"] as const;
    workers.forEach((worker, index) => controller.observeWorkerReport(worker.cwd, {
      jsonrpc: "2.0", method: "pi/resource/pressure", params: {
        generation: worker.workerGeneration, level: levels[index], sampleAgeMs: 0,
        inputs: [{ kind: "physical", value: { status: "available", value: 100 }, warningBytes: 50, criticalBytes: 80 }],
        ran: [], results: [], stores: {},
      },
    }, { generation: worker.clientGeneration, workerGeneration: worker.workerGeneration }));
    await controller.probeNow();
    await controller.probeNow();
    expect(order).toEqual(["/critical", "/warning", "/normal"]);
  });

  it("re-parses every directive answer and records no invented row", async () => {
    const worker = { cwd: "/p", clientGeneration: "c", workerGeneration: 1 };
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => [worker], publish: () => {}, rendererPresent: () => false,
      actions: {
        releaseEphemeral: () => false,
        directive: async () => ({ ...result(), secret: "/private/path" }),
        unloadIdle: async () => idle,
        retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }),
      },
    }, { directiveStageMs: 10 });
    await controller.probeNow();
    await controller.probeNow();
    expect(controller.counters().directivesMalformed).toBe(1);
    expect(controller.journalPage().events.some((event) => event.role === "project_worker")).toBe(false);
    expect(JSON.stringify(controller.exportSection())).not.toContain("/private/path");
  });

  it("excludes a deadline, journals a late valid answer once, and is silent after dispose", async () => {
    let resolve!: (value: MemoryPressureDirectiveResult) => void;
    const pending = new Promise<MemoryPressureDirectiveResult>((done) => { resolve = done; });
    let allowed = false;
    const worker = { cwd: "/p", clientGeneration: "c", workerGeneration: 1 };
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => [worker], publish: () => {}, rendererPresent: () => false,
      projectIdOf: () => "0123456789abcdef",
      actions: {
        releaseEphemeral: () => false,
        directive: async () => pending,
        unloadIdle: async (_level, allow) => { allowed = allow("/p"); return idle; },
        retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }),
      },
    }, { directiveStageMs: 5 });
    await controller.probeNow();
    await controller.probeNow();
    expect(allowed).toBe(false);
    expect(controller.counters().directivesTimedOut).toBe(1);
    resolve(result(7));
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.journalPage().events.filter((event) => event.role === "project_worker")).toHaveLength(1);
    expect(controller.counters().directivesLate).toBe(1);
    const count = controller.journalPage().events.length;
    controller.dispose();
    expect(controller.journalPage().events).toHaveLength(count);
  });

  it("journals crossed late replies once in their original selection order", async () => {
    const resolvers = new Map<string, (value: MemoryPressureDirectiveResult) => void>();
    const workers: HostPressureWorker[] = [
      { cwd: "/a", clientGeneration: "a", workerGeneration: 1 },
      { cwd: "/b", clientGeneration: "b", workerGeneration: 2 },
    ];
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => workers, publish: () => {}, rendererPresent: () => false,
      projectIdOf: (cwd) => cwd === "/a" ? "000000000000000a" : "000000000000000b",
      actions: {
        releaseEphemeral: () => false,
        directive: async (cwd) => new Promise((resolve) => resolvers.set(cwd, resolve)),
        unloadIdle: async () => idle,
        retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }),
      },
    }, { directiveStageMs: 5 });
    await controller.probeNow();
    await controller.probeNow();
    resolvers.get("/b")!(result(2));
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.journalPage().events.filter((event) => event.role === "project_worker")).toHaveLength(0);
    resolvers.get("/a")!(result(1));
    await new Promise((done) => setTimeout(done, 0));
    const rows = controller.journalPage().events.filter((event) => event.role === "project_worker").reverse();
    expect(rows.map((row) => row.released?.count)).toEqual([1, 2]);
    expect(controller.counters().directivesLate).toBe(2);
  });

  it("does nothing when a timed-out answer arrives after dispose", async () => {
    let resolve!: (value: MemoryPressureDirectiveResult) => void;
    const pending = new Promise<MemoryPressureDirectiveResult>((done) => { resolve = done; });
    const worker = { cwd: "/p", clientGeneration: "c", workerGeneration: 1 };
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => [worker], publish: () => {}, rendererPresent: () => false,
      actions: { releaseEphemeral: () => false, directive: async () => pending, unloadIdle: async () => idle, retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }) },
    }, { directiveStageMs: 5 });
    await controller.probeNow();
    await controller.probeNow();
    const before = controller.journalPage().events.length;
    controller.dispose();
    resolve(result());
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.journalPage().events).toHaveLength(before);
    expect(controller.counters().directivesLate).toBe(0);
  });

  it("drops a late answer from a replaced generation and never authorizes it", async () => {
    let resolve!: (value: MemoryPressureDirectiveResult) => void;
    const pending = new Promise<MemoryPressureDirectiveResult>((done) => { resolve = done; });
    let workers: HostPressureWorker[] = [{ cwd: "/p", clientGeneration: "old", workerGeneration: 1 }];
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => workers, publish: () => {}, rendererPresent: () => false,
      actions: { releaseEphemeral: () => false, directive: async () => pending, unloadIdle: async () => idle, retireIdle: async () => ({ retired: 0, held: false, unavailable: false, generationMismatch: false }) },
    }, { directiveStageMs: 5 });
    await controller.probeNow();
    const pass = controller.probeNow();
    await new Promise((done) => setTimeout(done, 10));
    workers = [{ cwd: "/p", clientGeneration: "new", workerGeneration: 2 }];
    await pass;
    resolve(result());
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.journalPage().events.filter((event) => event.role === "project_worker")).toHaveLength(0);
    expect(controller.counters().directivesStale).toBe(1);
  });
});
