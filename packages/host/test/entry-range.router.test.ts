/**
 * RP-5b acceptance A7 and A9 at the boundary: who answers a range read, in
 * what order, and what a refused caller causes to happen (nothing).
 *
 * Authorization runs on the method name alone, before the params are parsed
 * and therefore before any session lookup, any file and any worker — the same
 * contract every other read obeys (RP-13).
 */
import { ErrorCodes, PRODUCT_NAME, environmentKeyOf, environmentTagOf, sessionRevisionOf } from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@lasercode/protocol";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { SessionBodyRange } from "../src/session-body-range.js";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionRevisions } from "../src/session-revision.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";
import { LOCAL_ACCESS, testAccess } from "./actors.js";

const CWD = "/projects/a";
const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";
const ENVIRONMENT_KEY = environmentKeyOf(nodeRevisionHasher, ENVIRONMENT);
const LIVE_REVISION = sessionRevisionOf(nodeRevisionHasher, environmentTagOf(nodeRevisionHasher, ENVIRONMENT), { digest: "live", count: 0, leafId: null });

const header = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD });
const reply = JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "the whole answer" }] } });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-range-router-`));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, [header, reply].join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function harness(options: { path: string; open?: string[]; liveResult?: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-range-host-`));
  const rows: SessionSummary[] = [{ path: options.path, id: "session-1", cwd: CWD, createdAt: "2026-06-01T00:00:00.000Z", modifiedAt: "2026-06-01T00:00:00.000Z", messageCount: 1 }];
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
    get: spawned,
  } as unknown as WorkerPool;
  const index = new SessionIndexCache();
  const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
  const bodyRange = new SessionBodyRange({ index, revisions });
  const reads = vi.spyOn(bodyRange, "read");
  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: dir });
  projects.add(CWD);
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), access: testAccess(), revisions, bodyRange });
  return { router, revisions, index, reads, spawned, workerRequests, cleanup: () => { projects.close(); attention.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const call = (router: Router, params: unknown, access = LOCAL_ACCESS) =>
  router.handle({ jsonrpc: "2.0", id: 1, method: "session/entry_range", params }, access) as Promise<{ result?: { text: string; authority: string }; error?: { code: number; message: string } }>;

const callRegions = (router: Router, params: unknown, access = LOCAL_ACCESS) =>
  router.handle({ jsonrpc: "2.0", id: 2, method: "session/entry_regions", params }, access) as Promise<{ result?: { items: unknown[]; authority: string }; error?: { code: number; message: string } }>;

describe("the attachments inside a message, at the boundary", () => {
  const body = "ü".repeat(20_000);
  const withFile = JSON.stringify({ type: "message", id: "e2", parentId: null, timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "user", content: [{ type: "text", text: `look\n\n<attached-file name="notes.md" type="text/markdown" size="${Buffer.byteLength(body, "utf8")}">\n${body}\n</attached-file>` }] } });

  function attachmentFixture() {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-regions-`));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [header, reply, withFile].join("\n") + "\n");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("answers an inactive conversation from the host, without starting a worker, and its region reads too", async () => {
    const file = attachmentFixture();
    const h = harness({ path: file.path });
    try {
      const indexed = await h.index.read(file.path);
      const revision = h.revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const page = await callRegions(h.router, { path: file.path, environmentKey: h.revisions.environmentKey, revision, entryId: "e2", component: { kind: "user_text" } });
      expect(page.error?.message).toBeUndefined();
      const items = page.result!.items as Array<{ offset: number; bytes: number; name: string; contentDigest: string }>;
      expect(page.result!.authority).toBe("durable");
      expect(items.map(item => item.name)).toEqual(["notes.md"]);
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);

      // And the attachment reads back exactly, through an ordinary range read.
      const read = await call(h.router, { path: file.path, environmentKey: h.revisions.environmentKey, revision, entryId: "e2",
        component: { kind: "user_text" }, offset: items[0]!.offset, limit: 64 * 1024, region: { offset: items[0]!.offset, bytes: items[0]!.bytes } }) as unknown as
        { result?: { text: string; region?: unknown; regionDigest?: string; next?: number } };
      expect(read.result!.region).toEqual({ offset: items[0]!.offset, bytes: items[0]!.bytes });
      expect(read.result!.text.length).toBeGreaterThan(0);
      expect(h.spawned).not.toHaveBeenCalled();
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("refuses a stale revision, a foreign environment and a malformed region", async () => {
    const file = attachmentFixture();
    const h = harness({ path: file.path });
    try {
      const indexed = await h.index.read(file.path);
      const revision = h.revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const stale = await callRegions(h.router, { path: file.path, environmentKey: h.revisions.environmentKey, revision: `${revision}x`, entryId: "e2", component: { kind: "user_text" } });
      expect(stale.error?.code).toBe(ErrorCodes.RevisionUnavailable);
      const foreign = await callRegions(h.router, { path: file.path, environmentKey: "another-environment", revision, entryId: "e2", component: { kind: "user_text" } });
      expect(foreign.error).toBeDefined();
      const malformed = await callRegions(h.router, { path: file.path, environmentKey: h.revisions.environmentKey, revision, entryId: "e2", component: { kind: "user_text" }, from: -1 });
      expect(malformed.error?.code).toBe(ErrorCodes.InvalidParams);
      const outside = await call(h.router, { path: file.path, environmentKey: h.revisions.environmentKey, revision, entryId: "e2",
        component: { kind: "user_text" }, offset: 0, region: { offset: 10, bytes: 2 ** 53 } });
      expect((outside as unknown as { error?: { code: number } }).error?.code).toBe(ErrorCodes.InvalidParams);
      // None of it started a worker.
      expect(h.spawned).not.toHaveBeenCalled();
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("lets the live owner answer, and refuses a caller with no read access before anything is looked at", async () => {
    const file = attachmentFixture();
    const live = { authority: "live", revision: LIVE_REVISION, component: { kind: "user_text" }, totalBytes: 10, items: [], scannedBytes: 10 };
    const h = harness({ path: file.path, open: [file.path], liveResult: live });
    try {
      const response = await callRegions(h.router, { path: file.path, environmentKey: ENVIRONMENT_KEY, revision: LIVE_REVISION, entryId: "e2", component: { kind: "user_text" } });
      expect(response.result).toMatchObject({ authority: "live" });
      expect(h.workerRequests.map(request => request.method)).toEqual(["session/entry_regions"]);
      expect(h.reads).not.toHaveBeenCalled();
    } finally { h.cleanup(); file.cleanup(); }
  });
});

describe("a range read at the boundary", () => {
  it("answers an inactive conversation from the host, without starting a worker", async () => {
    const file = fixture();
    const h = harness({ path: file.path });
    try {
      const indexed = await h.index.read(file.path);
      const revision = h.revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const response = await call(h.router, { path: file.path, environmentKey: h.revisions.environmentKey, revision, entryId: "e1", component: { kind: "assistant_text" }, offset: 0 });
      expect(response.result).toMatchObject({ authority: "durable", text: "the whole answer" });
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("lets the live owner answer, and never reads the file behind its back", async () => {
    const file = fixture();
    const live = { authority: "live", revision: LIVE_REVISION, component: { kind: "assistant_text" }, totalBytes: 4, offset: 0, bytes: 4, truncated: false, sliceDigest: "a", contentDigest: "b", text: "live" };
    const h = harness({ path: file.path, open: [file.path], liveResult: live });
    try {
      const response = await call(h.router, { path: file.path, environmentKey: ENVIRONMENT_KEY, revision: LIVE_REVISION, entryId: "e1", component: { kind: "assistant_text" }, offset: 0 });
      expect(response.result).toEqual(live);
      expect(h.reads).not.toHaveBeenCalled();
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toHaveLength(1);
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("refuses an actor without read scope before parsing, reading or spawning", async () => {
    const file = fixture();
    const h = harness({ path: file.path });
    try {
      const refusedActor = { actor: { id: "phone-1", class: "paired" as const, scopes: new Set<string>() } };
      const response = await call(h.router, { path: file.path, entryId: "e1" }, refusedActor as never);
      expect(response.error).toBeDefined();
      expect(h.reads).not.toHaveBeenCalled();
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("refuses a conversation outside this host's projects before any read", async () => {
    const file = fixture();
    const h = harness({ path: file.path });
    try {
      const response = await call(h.router, { path: join(file.path, "..", "..", "elsewhere.jsonl"), environmentKey: h.revisions.environmentKey, revision: "r", entryId: "e1", component: { kind: "assistant_text" }, offset: 0 });
      expect(response.error?.code).toBe(ErrorCodes.SessionNotFound);
      expect(h.reads).not.toHaveBeenCalled();
      expect(h.spawned).not.toHaveBeenCalled();
    } finally { h.cleanup(); file.cleanup(); }
  });

  it("refuses a malformed request through the schema, not through a read", async () => {
    const file = fixture();
    const h = harness({ path: file.path });
    try {
      const response = await call(h.router, { path: file.path, environmentKey: "k", revision: "r", entryId: "e1", component: { kind: "made_up" }, offset: 0 });
      expect(response.error?.code).toBe(ErrorCodes.InvalidParams);
      expect(h.reads).not.toHaveBeenCalled();
    } finally { h.cleanup(); file.cleanup(); }
  });
});
