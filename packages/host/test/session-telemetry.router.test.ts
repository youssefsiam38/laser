import { ErrorCodes, PRODUCT_NAME } from "@lasercode/protocol";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@lasercode/protocol";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionRevisions } from "../src/session-revision.js";
import { SessionTelemetryReader } from "../src/session-telemetry.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";
import { LOCAL_ACCESS, testAccess } from "./actors.js";

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
  const owner = options.open?.includes(options.path)
    ? { request: async (method: string, params: unknown) => { workerRequests.push({ method, params }); return options.liveResult; } }
    : undefined;
  const spawned = vi.fn(async () => ({ request: async (method: string, params: unknown) => { workerRequests.push({ method, params }); return options.liveResult; } }));
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
  const telemetry = new SessionTelemetryReader({ index, revisions });
  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: dir });
  projects.add(CWD);
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), access: testAccess(), revisions, telemetry });
  return { router, revisions, spawned, workerRequests, cleanup: () => { projects.close(); attention.close(); rmSync(dir, { recursive: true, force: true }); } };
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
      expect(h.workerRequests).toEqual([{ method: "pi/session/telemetry", params: { path: file.path } }]);
      expect(h.spawned).not.toHaveBeenCalled();
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
