import { ErrorCodes, PRODUCT_NAME } from "@lasercode/protocol";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@lasercode/protocol";
import { AgentRunRegistry } from "../src/agents/runs.js";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionRevisions } from "../src/session-revision.js";
import { SessionTelemetryReader } from "../src/session-telemetry.js";
import { SessionTelemetryCoordinator } from "../src/session-telemetry-coordinator.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";
import { LOCAL_ACCESS, deviceAccess, testAccess } from "./actors.js";

const CWD = "/projects/a";
const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";

const header = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD });
const user = JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } });
const assistant = JSON.stringify({
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-01-01T00:00:02.000Z",
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "claude",
    content: [{ type: "text", text: "ok" }],
    usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.02 } },
  },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-telemetry-router-`));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, [header, user, assistant].join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function harness(options: { path: string; open?: string[]; liveResult?: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-telemetry-host-`));
  const rows: SessionSummary[] = [{ path: options.path, id: "session-1", cwd: CWD, createdAt: "2026-06-01T00:00:00.000Z", modifiedAt: "2026-06-01T00:00:00.000Z", messageCount: 2 }];
  const catalog = {
    list: () => rows.map(row => ({ ...row, size: 1 })),
    get: (path: string) => rows.find(row => row.path === path),
    getListed: vi.fn((path: string) => rows.find(row => row.path === path)),
    cwdOfListed: vi.fn((path: string) => rows.find(row => row.path === path)?.cwd),
    cwdOf: (path: string) => rows.find(row => row.path === path)?.cwd,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;
  const workerRequests: Array<{ method: string; params: unknown }> = [];
  const request = async (method: string, params: unknown) => {
    workerRequests.push({ method, params });
    if (method === "pi/session/telemetry/with-sources") {
      const generation = (params as { snapshot: { generation: number } }).snapshot.generation;
      return { telemetry: options.liveResult, generation, applied: true, published: false };
    }
    return options.liveResult;
  };
  const owner = options.open?.includes(options.path)
    ? { generation: "worker-1", request }
    : undefined;
  const spawned = vi.fn(async () => ({ generation: "worker-2", request }));
  const pool = {
    openSessions: () => options.open ?? [],
    ownerOfSession: (path: string) => (path === options.path ? owner : undefined),
    cwdOfSession: () => undefined,
    bindSession: () => {},
    recoverOpenedSession: async () => undefined,
    get: spawned,
  } as unknown as WorkerPool;
  const index = new SessionIndexCache();
  const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
  const runs = new AgentRunRegistry();
  const telemetry = new SessionTelemetryReader({ index, revisions, runs });
  const telemetryCoordinator = new SessionTelemetryCoordinator({
    reader: telemetry,
    runs,
    owner: () => owner as never,
    coalesceMs: 0,
  });
  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: dir });
  projects.add(CWD);
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), access: testAccess(), revisions, telemetry, telemetryCoordinator });
  return { router, revisions, spawned, workerRequests, cleanup: () => { telemetryCoordinator.close(); runs.close(); projects.close(); attention.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const call = (router: Router, params: unknown) =>
  router.handle({ jsonrpc: "2.0", id: 1, method: "pi/session/telemetry", params }, LOCAL_ACCESS) as Promise<{ result?: { authority: string; history?: { records: number } }; error?: { code: number; message: string } }>;

describe("pi/session/telemetry at the boundary", () => {
  it("answers an inactive conversation from the host without starting a worker", async () => {
    const file = fixture();
    const h = harness({ path: file.path });
    try {
      const answer = await call(h.router, { path: file.path });
      expect(answer.error?.message).toBeUndefined();
      expect(answer.result?.authority).toBe("durable");
      expect(answer.result?.history?.records).toBe(2);
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("lets the live worker win when it already owns the session", async () => {
    const file = fixture();
    const liveResult = { revision: "r1.live", environmentKey: "e1.live", authority: "live", scope: "session", history: { prompts: 1, records: 2, compactions: 0, branches: 0 } };
    const h = harness({ path: file.path, open: [file.path], liveResult });
    try {
      const answer = await call(h.router, { path: file.path });
      expect(answer.result).toEqual(liveResult);
      expect(h.workerRequests).toHaveLength(1);
      expect(h.workerRequests[0]).toMatchObject({
        method: "pi/session/telemetry/with-sources",
        params: {
          path: file.path,
          subscribe: true,
          snapshot: {
            scopeSessionPath: file.path,
            generation: 1,
            coverage: { knownChildren: 0, includedChildren: 0, unavailableChildren: 0 },
          },
        },
      });
      await call(h.router, { path: file.path, scope: "turn", turnId: "u1", include: ["spend"] });
      expect(h.workerRequests[1]).toEqual({
        method: "pi/session/telemetry",
        params: { path: file.path, scope: "turn", turnId: "u1", include: ["spend"] },
      });
      expect(h.spawned).not.toHaveBeenCalled();
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("bootstraps canonical sources on the durable fallback-to-live route", async () => {
    const file = fixture();
    writeFileSync(file.path, [
      JSON.stringify({ type: "session", version: 999, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD }),
      user,
      assistant,
    ].join("\n") + "\n");
    const liveResult = { revision: "r1.live", environmentKey: "e1.live", authority: "live", scope: "session", spend: { billing: "none", coverage: { knownChildren: 0, includedChildren: 0, unavailableChildren: 0 } } };
    const h = harness({ path: file.path, liveResult });
    try {
      const answer = await call(h.router, { path: file.path, include: ["spend"] });
      expect(answer.result?.authority).toBe("live");
      expect(h.spawned).toHaveBeenCalledOnce();
      expect(h.workerRequests.map((request) => request.method)).toEqual([
        "session/load",
        "pi/session/telemetry/with-sources",
      ]);
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("never exposes host-worker telemetry methods to normal or paired clients", async () => {
    const file = fixture();
    const h = harness({ path: file.path });
    try {
      const local = await h.router.handle({
        jsonrpc: "2.0", id: 7, method: "pi/session/telemetry/invalidate", params: { path: file.path, generation: 1 },
      }, LOCAL_ACCESS);
      expect(local).toMatchObject({ error: { code: ErrorCodes.Unsupported } });
      const paired = await h.router.handle({
        jsonrpc: "2.0", id: 8, method: "pi/session/telemetry/invalidate", params: { path: file.path, generation: 1 },
      }, deviceAccess());
      expect(paired).toHaveProperty("error");
      expect(h.workerRequests).toEqual([]);
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("refuses a stale revision without starting a worker", async () => {
    const file = fixture();
    const h = harness({ path: file.path });
    try {
      const stale = await call(h.router, { path: file.path, revision: "r1.AAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBB" });
      expect(stale.error?.code).toBe(ErrorCodes.RevisionUnavailable);
      expect(h.spawned).not.toHaveBeenCalled();
    } finally { h.cleanup(); file.cleanup(); }
  });
});
