/**
 * M21-T13 · the design workspace is the **worker's** authority, and the host
 * only picks the worker (AGENTS.md invariant 1, `docs/design-phase.md`).
 *
 * Every `design/*` method has to reach the worker of the project the opaque
 * `projectId` names, with the directory the *host* resolved — not the one the
 * caller sent — and a project this host does not know has to be refused
 * before any worker is started at all.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";
import { LOCAL_ACCESS, testAccess } from "./actors.js";

const PROJECT_ID = "pw_9f2c1a0400000000000000000000";
const CWD = "/projects/design";

function harness(options: { root?: string | undefined; resolver?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-design-`));
  const requests: Array<{ cwd: string; method: string; params: unknown }> = [];
  const started: string[] = [];
  const catalog = {
    list: () => [],
    get: () => undefined,
    cwdOf: () => undefined,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;
  const pool = {
    openSessions: () => [],
    cwdOfSession: () => undefined,
    bindSession: () => {},
    recoverOpenedSession: async () => undefined,
    get: async (cwd: string) => {
      started.push(cwd);
      return {
        request: async (method: string, params: unknown) => {
          requests.push({ cwd, method, params });
          return { answered: method };
        },
      };
    },
  } as unknown as WorkerPool;
  const router = new Router(pool, catalog, {
    attention: new AttentionTracker({}),
    projects: new ProjectRegistry({ catalog, agentDir: dir, exclude: [] }),
    views: new ViewCache(2),
    access: testAccess(),
    ...(options.resolver === false ? {} : { projectRootOfId: (id: string) => (id === PROJECT_ID ? (options.root ?? CWD) : undefined) }),
  });
  return { router, requests, started, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["design/index/get", {}],
  ["design/index/build", { rebuild: true, maxFiles: 500, sessionPath: "/s.jsonl" }],
  ["design/index/stop", { commandId: "dib_1" }],
  ["design/index/review", { entryId: "e_button", action: "accept" }],
  ["design/host/ground", { routeOrPath: "/orders", featureSize: "large" }],
  ["design/sketch/ground", { document: "<h1>Orders</h1>" }],
];

describe("Router · design/*", () => {
  it("routes every method to the worker of the project the id names", async () => {
    const h = harness();
    try {
      let id = 0;
      for (const [method, params] of CALLS) {
        const response = await h.router.handle({ jsonrpc: "2.0", id: (id += 1), method, params: { projectId: PROJECT_ID, ...params } }, LOCAL_ACCESS);
        expect(response, method).toMatchObject({ result: { answered: method } });
      }
      expect(h.requests.map((request) => request.method)).toEqual(CALLS.map(([method]) => method));
      expect(h.requests.every((request) => request.cwd === CWD)).toBe(true);
      // The params arrive whole, with the directory added.
      expect(h.requests[3]?.params).toEqual({ projectId: PROJECT_ID, entryId: "e_button", action: "accept", cwd: CWD });
    } finally {
      h.cleanup();
    }
  });

  it("replaces a cwd the caller sent with the one it resolved", async () => {
    const h = harness();
    try {
      await h.router.handle(
        { jsonrpc: "2.0", id: 1, method: "design/index/get", params: { projectId: PROJECT_ID, cwd: "/somewhere/else" } },
        LOCAL_ACCESS,
      );
      expect(h.requests[0]?.params).toEqual({ projectId: PROJECT_ID, cwd: CWD });
    } finally {
      h.cleanup();
    }
  });

  it("resolves a worktree to the project it belongs to", async () => {
    const h = harness({ root: `${CWD}/.worktrees/feature` });
    try {
      await h.router.handle({ jsonrpc: "2.0", id: 1, method: "design/index/get", params: { projectId: PROJECT_ID } }, LOCAL_ACCESS);
      expect(h.started).toEqual([CWD]);
      expect(h.requests[0]?.params).toEqual({ projectId: PROJECT_ID, cwd: CWD });
    } finally {
      h.cleanup();
    }
  });

  it("refuses an unknown project before it starts a worker", async () => {
    const h = harness();
    try {
      const response = (await h.router.handle(
        { jsonrpc: "2.0", id: 1, method: "design/index/get", params: { projectId: "pw_000000000000000000000000000" } },
        LOCAL_ACCESS,
      )) as { error?: { message: string } };
      expect(response.error?.message).toContain("not one this app knows");
      expect(h.started).toEqual([]);
      expect(h.requests).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("says so when this host has no project work at all", async () => {
    const h = harness({ resolver: false });
    try {
      const response = (await h.router.handle(
        { jsonrpc: "2.0", id: 1, method: "design/index/get", params: { projectId: PROJECT_ID } },
        LOCAL_ACCESS,
      )) as { error?: { message: string } };
      expect(response.error?.message).toContain("without its project work");
      expect(h.started).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a malformed call before anything is routed", async () => {
    const h = harness();
    try {
      const response = (await h.router.handle(
        { jsonrpc: "2.0", id: 1, method: "design/index/review", params: { projectId: PROJECT_ID, entryId: "e1", action: "rename" } },
        LOCAL_ACCESS,
      )) as { error?: { message: string } };
      expect(response.error).toBeDefined();
      expect(h.started).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
