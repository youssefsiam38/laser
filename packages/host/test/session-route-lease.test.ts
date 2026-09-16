/**
 * RP-4c · the per-session route lease.
 *
 * Path-routed requests are readers, a lifetime release is the writer, and the
 * interesting cases are the ones where the host cannot prove who owns the
 * runtime: a release that failed, and a release that never finished. Both fail
 * closed — the route refuses with one temporary sentence, having run no work at
 * all — and neither leaves anything retained per path.
 *
 * Every wait here is driven by an injected timer, so nothing depends on elapsed
 * time and no test sleeps.
 */
import { ErrorCodes, PRODUCT_NAME, ProtocolError, type SessionSummary } from "@lasercode/protocol";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTE_GATE_REFUSAL, SessionRouteLeases } from "../src/session-route-lease.js";
import { SessionLifetime } from "../src/session-lifetime.js";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";
import { LOCAL_ACCESS, testAccess } from "./actors.js";

const PATH = "/sessions/a.jsonl";
const OTHER = "/sessions/b.jsonl";

/** A promise a test settles by hand, so ordering is asserted, never timed. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Leases whose route bound is fired by the test rather than by a clock. */
function leasesWithManualClock(waitMs = 10_000) {
  const timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = [];
  let next = 1;
  const leases = new SessionRouteLeases({
    waitMs,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.push({ id, fn, ms, cleared: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      const row = timers.find((entry) => entry.id === (timer as unknown as number));
      if (row) row.cleared = true;
    },
  });
  return {
    leases,
    timers,
    /** Fire every timer that is still live: the bound has passed. */
    expire: () => {
      for (const timer of timers.filter((entry) => !entry.cleared)) {
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<ProtocolError> {
  try {
    await promise;
  } catch (error) {
    return error as ProtocolError;
  }
  throw new Error("expected the route to be refused");
}

describe("SessionRouteLeases", () => {
  it("declines a release while a routed request holds the path, without asking anything", async () => {
    const leases = new SessionRouteLeases();
    const routeGate = deferred();
    const releaseWork = vi.fn(async () => ({ unloaded: true, pins: [] }));

    const routed = leases.route(PATH, async () => {
      await routeGate.promise;
      return "routed";
    });
    expect(leases.routedHolders(PATH)).toBe(1);

    const declined = await leases.release(PATH, releaseWork);
    expect(declined).toBeUndefined();
    expect(releaseWork).not.toHaveBeenCalled();
    // The decline is synchronous: no gate was ever published for the path.
    expect(leases.releasePending(PATH)).toBe(false);

    routeGate.resolve();
    expect(await routed).toBe("routed");
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });

  it("runs a routed request only after the release in flight has settled", async () => {
    const leases = new SessionRouteLeases();
    const order: string[] = [];
    const releaseGate = deferred();

    const release = leases.release(PATH, async () => {
      order.push("release:start");
      await releaseGate.promise;
      order.push("release:end");
      return { unloaded: true, pins: [] };
    });
    // The route is issued while the release is in flight, as the soak does.
    const routed = leases.route(PATH, async () => {
      order.push("route:work");
      return "ok";
    });
    await Promise.resolve();
    expect(order).toEqual(["release:start"]);
    // A route waiting on the gate is not yet a holder: it has done nothing.
    expect(leases.routedHolders(PATH)).toBe(0);

    releaseGate.resolve();
    await release;
    expect(await routed).toBe("ok");
    expect(order).toEqual(["release:start", "release:end", "route:work"]);
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });

  it("refuses every waiting route when the release fails, and runs none of their work", async () => {
    const leases = new SessionRouteLeases();
    const releaseGate = deferred();
    const work = vi.fn(async () => "never");

    const release = leases.release(PATH, async () => {
      await releaseGate.promise;
      throw new Error("the worker died mid-release");
    });
    const first = leases.route(PATH, work);
    const second = leases.route(PATH, work);
    await Promise.resolve();

    releaseGate.resolve();
    await expect(release).rejects.toThrow(/died mid-release/);

    for (const route of [first, second]) {
      const error = await refusal(route);
      expect(error).toBeInstanceOf(ProtocolError);
      expect(error.code).toBe(ErrorCodes.SessionBusy);
      expect(error.message).toBe(ROUTE_GATE_REFUSAL);
    }
    // Cleanup happened; permission did not.
    expect(work).not.toHaveBeenCalled();
    expect(leases.releasePending(PATH)).toBe(false);
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });

  it("refuses on the bound when a release never settles, having written nothing", async () => {
    const { leases, timers, expire } = leasesWithManualClock(1_234);
    const never = deferred();
    const work = vi.fn(async () => "never");

    const release = leases.release(PATH, async () => {
      await never.promise;
      return { unloaded: true, pins: [] };
    });
    const firstRoute = leases.route(PATH, work);
    const secondRoute = leases.route(PATH, work);
    await Promise.resolve();
    // One timer for the gate, not one per waiter.
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    expect(timers[0]!.ms).toBe(1_234);

    expire();
    for (const route of [firstRoute, secondRoute]) {
      const error = await refusal(route);
      expect(error.code).toBe(ErrorCodes.SessionBusy);
      expect(error.message).toBe(ROUTE_GATE_REFUSAL);
    }
    expect(work).not.toHaveBeenCalled();
    // No reader was ever counted: the route never reached the worker at all.
    expect(leases.routedHolders(PATH)).toBe(0);

    // The gate is still in flight, so the next route refuses at once rather
    // than paying the whole wait again — no timer is even created for it.
    const timersBefore = timers.length;
    const later = await refusal(leases.route(PATH, work));
    expect(later.message).toBe(ROUTE_GATE_REFUSAL);
    expect(timers).toHaveLength(timersBefore);
    expect(work).not.toHaveBeenCalled();

    // And the refusal is temporary, not a latch: once the release finishes, a
    // fresh route is evaluated normally.
    never.resolve();
    await release;
    expect(await leases.route(PATH, async () => "back")).toBe("back");
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });

  it("declines a second concurrent release for the same path, so no second unload is sent", async () => {
    const leases = new SessionRouteLeases();
    const gate = deferred();
    const second = vi.fn(async () => ({ unloaded: true, pins: [] }));

    const first = leases.release(PATH, async () => {
      await gate.promise;
      return { unloaded: true, pins: [] };
    });
    const duplicate = await leases.release(PATH, second);
    expect(duplicate).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    expect(leases.stats().releasing).toBe(1);

    gate.resolve();
    expect(await first).toEqual({ unloaded: true, pins: [] });
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });

  it("keeps paths independent: a release on one never defers a route on another", async () => {
    const leases = new SessionRouteLeases();
    const gate = deferred();
    const release = leases.release(PATH, async () => {
      await gate.promise;
      return { unloaded: true, pins: [] };
    });

    expect(await leases.route(OTHER, async () => "other")).toBe("other");
    gate.resolve();
    await release;
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });

  it("counts concurrent readers and empties its bookkeeping when they finish", async () => {
    const leases = new SessionRouteLeases();
    const gates = [deferred(), deferred()];
    const routes = gates.map((gate) => leases.route(PATH, () => gate.promise));
    await Promise.resolve();
    expect(leases.routedHolders(PATH)).toBe(2);

    gates[0]!.resolve();
    await routes[0];
    expect(leases.routedHolders(PATH)).toBe(1);
    gates[1]!.resolve();
    await routes[1];
    expect(leases.routedHolders(PATH)).toBe(0);
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });

  it("keeps a route's reader count correct when the work itself throws", async () => {
    const leases = new SessionRouteLeases();
    await expect(
      leases.route(PATH, async () => {
        throw new Error("the worker refused");
      }),
    ).rejects.toThrow(/refused/);
    expect(leases.stats()).toEqual({ routed: 0, releasing: 0 });
  });
});

describe("the sweep and the lease together", () => {
  /** The host's own wiring: membership plus the routed requests in flight. */
  function world(options: { countRoutedAsHolders: boolean }) {
    const leases = new SessionRouteLeases();
    const asked: string[] = [];
    const unloaded: string[] = [];
    const lifetime = new SessionLifetime(
      {
        holders: () => (options.countRoutedAsHolders ? leases.routedHolders(PATH) : 0),
        loadedSessions: () => [{ cwd: "/repo", path: PATH }],
        lastActivity: () => 0,
        unload: async (_cwd, path) => {
          asked.push(path);
          const answer = await leases.release(path, async () => {
            unloaded.push(path);
            return { unloaded: true, pins: [] };
          });
          return answer ?? { unloaded: false, pins: [] };
        },
        now: () => 10_000_000,
        setTimer: () => setInterval(() => {}, 1_000_000),
      },
      { workerIdleMs: 10 * 60_000 },
    );
    return { leases, lifetime, asked, unloaded };
  }

  it("never even considers a session a routed request is holding", async () => {
    const { leases, lifetime, asked } = world({ countRoutedAsHolders: true });
    const gate = deferred();
    const routed = leases.route(PATH, () => gate.promise);
    await lifetime.sweep();
    expect(asked).toEqual([]);
    expect(lifetime.counts().considered).toBe(0);
    gate.resolve();
    await routed;
  });

  it("reads a lease decline as 'left alone': no release, no refusal, no backoff", async () => {
    // The sweep picked the candidate before the route arrived, which is the
    // interleaving the lease exists for.
    const { leases, lifetime, asked, unloaded } = world({ countRoutedAsHolders: false });
    const gate = deferred();
    const routed = leases.route(PATH, () => gate.promise);

    await lifetime.sweep();
    expect(asked).toEqual([PATH]);
    // The worker was never asked, so nothing was released.
    expect(unloaded).toEqual([]);
    const counts = lifetime.counts();
    expect(counts.unloaded).toBe(0);
    expect(counts.refused).toBe(0);
    expect(counts.skippedBackoff).toBe(0);
    expect(counts.pins).toEqual({});

    gate.resolve();
    await routed;
    // A later tick reconsiders it, exactly as the policy already does.
    await lifetime.sweep();
    expect(unloaded).toEqual([PATH]);
    expect(lifetime.counts().unloaded).toBe(1);
  });
});

// ------------------------------------------------- the router under the lease

const CWD = "/projects/a";

/**
 * A Router over a pool whose membership a test moves by hand, sharing the
 * host's one lease instance — the wiring `HostServer` builds.
 *
 * The worker stub is the real refusal: a request for a path the pool no longer
 * lists is answered with the worker's own "is not open in this worker", which
 * is exactly the sentence the soak lost a prompt to.
 */
function routerHarness(options: { open: string[]; catalog?: boolean; getGate?: Promise<void> }) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-route-lease-`));
  const open = new Set(options.open);
  const rows: SessionSummary[] = options.catalog === false
    ? []
    : [{ path: PATH, id: "session-1", cwd: CWD, createdAt: "2026-06-01T00:00:00.000Z", modifiedAt: "2026-06-01T00:00:00.000Z", messageCount: 1 }];
  const catalog = {
    list: () => rows.map((row) => ({ ...row, size: 1 })),
    get: (path: string) => rows.find((row) => row.path === path),
    getListed: (path: string) => rows.find((row) => row.path === path),
    cwdOf: (path: string) => rows.find((row) => row.path === path)?.cwd ?? CWD,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;

  const leases = new SessionRouteLeases();
  const workerRequests: Array<{ method: string; params: unknown }> = [];
  const worker = {
    request: async (method: string, params: unknown) => {
      const path = (params as { path?: string }).path;
      if (method !== "session/load" && path && !open.has(path)) {
        // The worker's own refusal, verbatim in shape: it never delivered this.
        throw new ProtocolError(ErrorCodes.SessionNotFound, `session ${path} is not open in this worker`);
      }
      workerRequests.push({ method, params });
      if (method === "session/load") open.add(path!);
      return {};
    },
  };
  const pool = {
    routeLeases: leases,
    openSessions: (cwd: string) => (cwd === CWD ? [...open] : []),
    cwdOfSession: (path: string) => (open.has(path) ? CWD : undefined),
    bindSession: (path: string) => open.add(path),
    ownerOfSession: () => undefined,
    get: async () => {
      if (options.getGate) await options.getGate;
      return worker;
    },
  } as unknown as WorkerPool;

  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: dir });
  projects.add(CWD);
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), access: testAccess(), routeLeases: leases });
  const prompt = (path = PATH) =>
    router.handle(
      { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { path, content: [{ type: "text", text: "go" }] } },
      LOCAL_ACCESS,
    ) as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  return {
    router,
    leases,
    open,
    prompt,
    workerRequests,
    cleanup: () => {
      projects.close();
      attention.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("path-routed mutations under the lease", () => {
  it("re-opens instead of writing to a worker that let the runtime go", async () => {
    // `pool.get` only resolves once the release has actually dropped the
    // runtime: the losing interleaving, forced rather than waited for.
    const released = deferred();
    const harness = routerHarness({ open: [PATH], getGate: released.promise });
    const releaseGate = deferred();
    try {
      // The release the lifetime sweep is entitled to make, in flight.
      const release = harness.leases.release(PATH, async () => {
        await releaseGate.promise;
        harness.open.delete(PATH);
        released.resolve();
        return { unloaded: true, pins: [] };
      });
      // The prompt is issued while the host still believes the session open.
      const answer = harness.prompt();
      await Promise.resolve();
      releaseGate.resolve();
      await release;

      expect((await answer).error).toBeUndefined();
      // Ensure-open ran on the truth after the release, so the prompt was
      // delivered to a runtime that exists.
      expect(harness.workerRequests.map((entry) => entry.method)).toEqual(["session/load", "session/prompt"]);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses with SessionBusy and writes nothing when the release fails", async () => {
    const harness = routerHarness({ open: [PATH] });
    const releaseGate = deferred();
    try {
      const release = harness.leases.release(PATH, async () => {
        await releaseGate.promise;
        // The worker dropped the runtime and then the host lost the answer: it
        // cannot prove whose bookkeeping is right.
        harness.open.delete(PATH);
        throw new Error("the worker died mid-release");
      });
      const answer = harness.prompt();
      await Promise.resolve();
      releaseGate.resolve();
      await expect(release).rejects.toThrow(/died mid-release/);

      const refused = await answer;
      expect(refused.error?.code).toBe(ErrorCodes.SessionBusy);
      expect(refused.error?.message).toBe(ROUTE_GATE_REFUSAL);
      // Fail closed: no load, no prompt, nothing written to any worker.
      expect(harness.workerRequests).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("re-reads membership after the worker is replaced under the await", async () => {
    const replaced = deferred();
    const harness = routerHarness({ open: [PATH], getGate: replaced.promise });
    try {
      const answer = harness.prompt();
      await Promise.resolve();
      // Retirement or a crash empties the pool's membership while `pool.get`
      // is still resolving the successor worker.
      harness.open.delete(PATH);
      replaced.resolve();

      expect((await answer).error).toBeUndefined();
      expect(harness.workerRequests.map((entry) => entry.method)).toEqual(["session/load", "session/prompt"]);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps the saved-transcript guard closed after the worker is replaced", async () => {
    const replaced = deferred();
    // No catalog row and no file on disk: there is nothing to re-open.
    const harness = routerHarness({ open: [PATH], catalog: false, getGate: replaced.promise });
    try {
      const answer = harness.prompt();
      await Promise.resolve();
      harness.open.delete(PATH);
      replaced.resolve();

      const refused = await answer;
      expect(refused.error?.code).toBe(ErrorCodes.SessionNotFound);
      expect(refused.error?.message).toMatch(/no saved transcript/);
      // Above all: no `session/load` was sent, so no different session was
      // created under that filename.
      expect(harness.workerRequests).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });
});
