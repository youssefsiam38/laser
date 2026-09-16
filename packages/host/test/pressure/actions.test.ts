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
      retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
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
      actions: { releaseEphemeral: () => false, directive: async () => result(), unloadIdle: async () => idle, retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }) },
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
      actions: { releaseEphemeral: () => true, directive, unloadIdle: unload, retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }) },
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
        unloadIdle: async (allow) => { unloadAllowed = workers.filter((w) => allow(w.cwd) === "authorized").length; return idle; },
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
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
    const firstEpoch = epochs[0]!;
    expect(new Set(epochs)).toEqual(new Set([firstEpoch]));

    // Critical's 10 s pass cooldown has elapsed, but each selected worker's
    // own 30 s skip has not: the two that did not get a turn go next.
    at += 10_001;
    await controller.probeNow();
    expect(order.slice(4)).toEqual(["/p5", "/p4"]);
    expect(new Set(epochs.slice(4))).toEqual(new Set([epochs[4]!]));
    expect(epochs[4]!).toBeGreaterThan(firstEpoch);
  });

  it("never authorizes a refused directive and keeps one monotonic epoch space", async () => {
    let at = 1_000;
    const worker = { cwd: "/p", clientGeneration: "c", workerGeneration: 1 };
    const epochs: number[] = [];
    const unloadDecisions: string[] = [];
    const retireSizes: number[] = [];
    const controller = createHostPressureController({
      sample: async () => critical(at), workers: () => [worker], publish: () => {}, rendererPresent: () => false, now: () => at,
      actions: {
        releaseEphemeral: () => false,
        directive: async (_cwd, _expect, params) => {
          epochs.push(params.epoch);
          return { applied: false, ran: [], results: [], stores: {} };
        },
        unloadIdle: async (allow) => { unloadDecisions.push(allow("/p")); return idle; },
        retireIdle: async (allow) => { retireSizes.push(allow.size); return { action: "worker_retirement", outcome: "nothing_to_give" }; },
      },
    });
    await controller.probeNow(); at += 1;
    await controller.probeNow();
    expect(unloadDecisions).toEqual(["not_in_pass"]);
    expect(retireSizes).toEqual([0]);
    expect(controller.counters().directivesRefused).toBe(1);

    // A completed all-quiet pass waits 60 s; the refused worker's own cooldown
    // cannot make the host reuse the prior epoch when it is asked again.
    at += 60_000;
    await controller.probeNow();
    expect(unloadDecisions).toEqual(["not_in_pass", "not_in_pass"]);
    expect(retireSizes).toEqual([0, 0]);
    expect(epochs).toHaveLength(2);
    expect(epochs[1]!).toBeGreaterThan(epochs[0]!);
  });

  it("does not rewrite nothing_to_give because an unrelated authorized worker moved", async () => {
    let reads = 0;
    let workers: HostPressureWorker[] = [
      { cwd: "/a", clientGeneration: "a", workerGeneration: 1 },
      { cwd: "/b", clientGeneration: "b", workerGeneration: 2 },
    ];
    const controller = createHostPressureController({
      sample: async () => {
        reads += 1;
        // Cadence 1, cadence 2, step-1 check, then the post-directive check.
        if (reads === 4) workers = [workers[0]!, { cwd: "/b", clientGeneration: "new-b", workerGeneration: 3 }];
        return critical(Date.now());
      },
      workers: () => workers, publish: () => {}, rendererPresent: () => false,
      actions: {
        releaseEphemeral: () => false, directive: async () => result(),
        // There is no candidate. In particular, this answer says nothing about B.
        unloadIdle: async () => idle,
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
      },
    });
    await controller.probeNow();
    await controller.probeNow();
    expect(controller.journalPage().events.find((row) => row.action === "idle_session_unload")).toMatchObject({ outcome: "nothing_to_give" });
  });

  it("counts only cadence probes toward hysteresis", async () => {
    let at = 1_000;
    let physical = 600 * MiB;
    const controller = createHostPressureController({
      sample: async () => ({ ...critical(at), physical: { status: "available", value: physical }, heapUsed: { status: "available", value: physical } }),
      workers: () => [], publish: () => {}, rendererPresent: () => false, now: () => at,
      actions: {
        releaseEphemeral: () => false,
        directive: async () => result(),
        unloadIdle: async () => idle,
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
      },
    });
    await controller.probeNow(); at += 1;
    await controller.probeNow();
    expect(controller.counters().level).toBe("warning");

    physical = 900 * MiB;
    at += 60_000;
    const before = controller.counters().probes;
    await controller.probeNow();
    expect(controller.counters().probes - before).toBe(4); // cadence + three read-only stage checks
    expect(controller.counters().level).toBe("warning");
  });

  it("does not call crossing the threshold relief until every input is inside 0.85×", async () => {
    let reads = 0;
    const directive = vi.fn(async () => result());
    const controller = createHostPressureController({
      sample: async () => {
        reads += 1;
        const value = reads <= 2 ? 600 * MiB : 500 * MiB;
        return { ...critical(reads), physical: { status: "available", value }, heapUsed: { status: "available", value } };
      },
      now: () => reads,
      workers: () => [{ cwd: "/p", clientGeneration: "c", workerGeneration: 1 }], publish: () => {}, rendererPresent: () => false,
      actions: {
        releaseEphemeral: () => false, directive,
        unloadIdle: async () => idle,
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
      },
    });
    await controller.probeNow();
    await controller.probeNow();
    expect(directive).toHaveBeenCalledOnce();
  });

  it("does not give an early-stopped quiet prefix the 60 second override", async () => {
    let at = 1_000;
    let reads = 0;
    const warning = () => ({ ...critical(at), physical: { status: "available", value: 600 * MiB }, heapUsed: { status: "available", value: 600 * MiB } });
    const controller = createHostPressureController({
      sample: async () => ++reads === 3 ? normal(at) : warning(),
      workers: () => [], publish: () => {}, rendererPresent: () => false, now: () => at,
      actions: {
        releaseEphemeral: () => false,
        directive: async () => result(), unloadIdle: async () => idle,
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
      },
    });
    await controller.probeNow(); at += 1;
    await controller.probeNow(); // step 1 only, then read-only relief
    expect(controller.counters().passes).toBe(1);
    expect(controller.journalPage().events.filter((row) => row.role === "host")).toHaveLength(1);
    at += 29_999;
    await controller.probeNow();
    expect(controller.counters().passes).toBe(1);
    at += 1;
    await controller.probeNow();
    expect(controller.counters().passes).toBe(2);
  });

  it("uses 30 seconds for a productive warning pass and 60 only for a completed quiet pass", async () => {
    let at = 1_000;
    let gave = true;
    const warningSample = () => ({ ...critical(at), physical: { status: "available", value: 600 * MiB }, heapUsed: { status: "available", value: 600 * MiB } });
    const controller = createHostPressureController({
      sample: async () => warningSample(), workers: () => [], publish: () => {}, rendererPresent: () => false, now: () => at,
      actions: {
        releaseEphemeral: () => { const answer = gave; gave = false; return answer; },
        directive: async () => result(), unloadIdle: async () => idle,
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
      },
    });
    await controller.probeNow(); at += 1;
    await controller.probeNow();
    expect(controller.counters().passes).toBe(1);
    at += 29_999;
    await controller.probeNow();
    expect(controller.counters().passes).toBe(1);
    at += 1;
    await controller.probeNow();
    expect(controller.counters().passes).toBe(2);

    // Pass two completed every stage with only nothing/held rows.
    at += 59_999;
    await controller.probeNow();
    expect(controller.counters().passes).toBe(2);
    at += 1;
    await controller.probeNow();
    expect(controller.counters().passes).toBe(3);
  });

  it("forgets a departed worker's directive skip even when it sent no report", async () => {
    let at = 1_000;
    let workers: HostPressureWorker[] = [{ cwd: "/p", clientGeneration: "old", workerGeneration: 1 }];
    const selected: string[] = [];
    const controller = createHostPressureController({
      sample: async () => critical(at), workers: () => workers, publish: () => {}, rendererPresent: () => false, now: () => at,
      actions: {
        releaseEphemeral: () => false,
        directive: async (_cwd, expect) => { selected.push(expect.clientGeneration); return result(); },
        unloadIdle: async () => idle,
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
      },
    });
    await controller.probeNow(); at += 1;
    await controller.probeNow();
    controller.forgetWorker("/p", "old");
    workers = [{ cwd: "/p", clientGeneration: "new", workerGeneration: 2 }];
    at += 10_000; // critical pass cooldown, still inside the worker's 30 s skip
    await controller.probeNow();
    expect(selected).toEqual(["old", "new"]);
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
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
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
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
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
    let allowed = "authorized";
    const worker = { cwd: "/p", clientGeneration: "c", workerGeneration: 1 };
    const controller = createHostPressureController({
      sample: async () => critical(Date.now()), workers: () => [worker], publish: () => {}, rendererPresent: () => false,
      projectIdOf: () => "0123456789abcdef",
      actions: {
        releaseEphemeral: () => false,
        directive: async () => pending,
        unloadIdle: async (allow) => { allowed = allow("/p"); return idle; },
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
      },
    }, { directiveStageMs: 5 });
    await controller.probeNow();
    await controller.probeNow();
    expect(allowed).toBe("not_in_pass");
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
        retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }),
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
      actions: { releaseEphemeral: () => false, directive: async () => pending, unloadIdle: async () => idle, retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }) },
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
      actions: { releaseEphemeral: () => false, directive: async () => pending, unloadIdle: async () => idle, retireIdle: async () => ({ action: "worker_retirement", outcome: "nothing_to_give" }) },
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
