/**
 * M14-T2 · MCP servers are the worker's, and the host only picks the project's
 * worker (AGENTS.md invariant 1, docs/mcp.md). Every `mcp/*` method must reach
 * the worker of `params.cwd` with its parameters untouched — a method the
 * router does not know is refused, which is exactly the failure this covers.
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

const CWD = "/projects/mcp";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-mcp-`));
  const requests: Array<{ cwd: string; method: string; params: unknown }> = [];
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
    get: async (cwd: string) => ({
      request: async (method: string, params: unknown) => {
        requests.push({ cwd, method, params });
        return { answered: method };
      },
    }),
  } as unknown as WorkerPool;
  const router = new Router(pool, catalog, {
    attention: new AttentionTracker({}),
    projects: new ProjectRegistry({ catalog, agentDir: dir, exclude: [] }),
    views: new ViewCache(2),
  });
  return { router, requests, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["mcp/list", {}],
  ["mcp/save", { scope: "global", server: { name: "fixture", transport: { kind: "stdio", command: "node" } } }],
  ["mcp/remove", { scope: "global", name: "fixture" }],
  ["mcp/inspect", { scope: "global", name: "fixture" }],
  ["mcp/ping", { scope: "global", name: "fixture" }],
  ["mcp/call", { scope: "global", name: "fixture", tool: "echo", args: { text: "hi" } }],
  ["mcp/disconnect", { scope: "global", name: "fixture" }],
  ["mcp/auth/start", { scope: "global", name: "fixture" }],
  ["mcp/auth/complete", { scope: "global", name: "fixture", redirectUrl: "https://example.test/cb?code=1&state=2" }],
  ["mcp/auth/logout", { scope: "global", name: "fixture" }],
  ["mcp/import/detect", {}],
  ["mcp/import/apply", { source: "cursor", names: ["fixture"], scope: "global" }],
];

describe("Router · mcp/*", () => {
  it("routes every MCP method to the worker that owns the project", async () => {
    const h = harness();
    try {
      let id = 0;
      for (const [method, params] of CALLS) {
        const response = await h.router.handle({ jsonrpc: "2.0", id: (id += 1), method, params: { cwd: CWD, ...params } });
        expect(response, method).toMatchObject({ result: { answered: method } });
      }
      expect(h.requests.map((request) => request.method)).toEqual(CALLS.map(([method]) => method));
      expect(h.requests.every((request) => request.cwd === CWD)).toBe(true);
      expect(h.requests[1]?.params).toEqual({ cwd: CWD, ...CALLS[1]![1] });
    } finally {
      h.cleanup();
    }
  });
});
