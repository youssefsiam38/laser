/**
 * The `resource/*` methods at the socket boundary.
 *
 * Two things matter here and nothing else: a local shell can report metrics
 * and a remote one cannot, and a host without diagnostics refuses the family
 * in a sentence rather than answering with an invented shape.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { BROWSER_ACCESS, LOCAL_ACCESS, deviceAccess, testAccess } from "../actors.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, PRODUCT_NAME, resourceAvailable, resourceUnavailable } from "@lasercode/protocol";
import { AttentionTracker } from "../../src/attention.js";
import { ProjectRegistry } from "../../src/projects.js";
import { Router } from "../../src/router.js";
import { ViewCache } from "../../src/views.js";
import { ResourceService } from "../../src/resources/service.js";
import type { SessionCatalog } from "../../src/catalog.js";
import type { WorkerPool } from "../../src/worker-pool.js";
import type { ProcessCollector } from "../../src/resources/platform.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const NOW = 2_000_000_000_000;

const collector: ProcessCollector = {
  name: "fake",
  source: "proc",
  table: async () => [
    { pid: 100, ppid: 1, startToken: "linux:boot:100", startedAtMs: NOW - 60_000, label: "electron" },
    { pid: 200, ppid: 100, startToken: "linux:boot:200", startedAtMs: NOW - 30_000, label: "node" },
  ],
  measure: async () => ({
    memory: {
      pss: resourceAvailable(1000),
      resident: resourceAvailable(2000),
      peakResident: resourceAvailable(3000),
      privateResident: resourceUnavailable("unsupported_platform"),
      commit: resourceUnavailable("unsupported_platform"),
    },
    cpu: { seconds: resourceAvailable(1) },
    elapsedMs: resourceAvailable(10),
    io: { readBytes: resourceAvailable(0), writeBytes: resourceAvailable(0) },
  }),
};

function harness(withResources = true) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-resource-router-`));
  directories.push(dir);
  const catalog = {
    list: () => [],
    get: () => undefined,
    cwdOf: () => undefined,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;
  const pool = { openSessions: () => [], cwdOfSession: () => undefined } as unknown as WorkerPool;
  const resources = new ResourceService({ collector, platform: "linux", hostPid: 200, minIntervalMs: 0, now: () => NOW });
  const router = new Router(pool, catalog, {
    attention: new AttentionTracker({}),
    projects: new ProjectRegistry({ catalog, agentDir: dir }),
    views: new ViewCache(2),
    access: testAccess(),
    ...(withResources ? { resources } : {}),
  });
  return { router, resources };
}

const request = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0" as const, id, method, params });

describe("resource methods at the socket boundary", () => {
  it("answers a snapshot, its history and an export", async () => {
    const { router } = harness();
    const snapshot = await router.handle(request(1, "resource/snapshot", { refresh: true }), LOCAL_ACCESS);
    expect(snapshot).toMatchObject({ result: { snapshot: { platform: "linux" }, retention: { maxSnapshots: 3600 } } });

    const history = await router.handle(request(2, "resource/history", { limit: 5 }), LOCAL_ACCESS);
    expect((history as { result: { snapshots: unknown[] } }).result.snapshots).toHaveLength(1);

    const exported = await router.handle(request(3, "resource/export"), LOCAL_ACCESS);
    expect((exported as { result: { bytes: number } }).result.bytes).toBeGreaterThan(0);
  });

  it("takes Electron metrics from the local app and refuses them from anywhere else", async () => {
    const { router } = harness();
    const report = {
      at: new Date(NOW).toISOString(),
      main: { pid: 100, creationTime: NOW - 60_000 },
      processes: [{ pid: 100, creationTime: NOW - 60_000, type: "Browser", workingSetBytes: 1000 }],
    };

    // A paired device — and a page, even a local one — cannot feed the host
    // measurements of this machine's processes (RP-13, reach `native`).
    for (const access of [deviceAccess(), BROWSER_ACCESS]) {
      const remote = await router.handle(request(4, "resource/report", report), access);
      expect((remote as { error: { code: number; message: string } }).error.code).toBe(ErrorCodes.Unsupported);
      expect((remote as { error: { message: string } }).error.message).toContain("running on this machine");
    }

    // Before any demand the host has no table, and receiving a report does
    // not go and read one: it says the claim is pending.
    const pending = await router.handle(request(5, "resource/report", report), LOCAL_ACCESS);
    expect(pending).toMatchObject({ result: { verified: false, pending: true } });

    // After a snapshot it can answer from the table it already read.
    await router.handle(request(6, "resource/snapshot", {}), LOCAL_ACCESS);
    const local = await router.handle(request(7, "resource/report", report), LOCAL_ACCESS);
    expect(local).toMatchObject({ result: { verified: true, accepted: 1, rejected: 0 } });
  });

  it("refuses the family, in words, on a host started without diagnostics", async () => {
    const { router } = harness(false);
    const response = await router.handle(request(8, "resource/snapshot", {}), LOCAL_ACCESS);
    expect((response as { error: { code: number; message: string } }).error).toMatchObject({ code: ErrorCodes.Unsupported });
    expect((response as { error: { message: string } }).error.message).toContain("resource diagnostics");
  });

  it("refuses a report whose shape could name something it does not own", async () => {
    const { router } = harness();
    const response = await router.handle(
      request(9, "resource/report", { at: new Date(NOW).toISOString(), main: { pid: 100 }, processes: [{ pid: 100, type: "Browser", role: "host" }] }),
      LOCAL_ACCESS,
    );
    expect((response as { error: { code: number } }).error.code).toBe(ErrorCodes.InvalidParams);
  });
});
