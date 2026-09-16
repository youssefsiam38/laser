/**
 * Durable revisions as a client sees them (RP-9): what the host answers for a
 * conversation nobody is driving, what a cached revision is worth against it,
 * and the two things that must never happen — a worker started for a read, and
 * the environment's raw identity leaving the host.
 */
import { ErrorCodes, PRODUCT_NAME, environmentKeyOf, environmentTagOf, isEnvironmentKey, isSessionRevision, sessionRevisionOf } from "@lasercode/protocol";
import { LOCAL_ACCESS, testAccess } from "./actors.js";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";
import { describe, expect, it, vi } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@lasercode/protocol";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { environmentIdentity, type EnvironmentIdentityFiles } from "../src/environment-identity.js";
import type { PressureAdmission } from "../src/pressure/index.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionProjection } from "../src/session-projection.js";
import { SessionRevisions } from "../src/session-revision.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";

const CWD = "/projects/a";
const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";
const ENVIRONMENT_KEY = environmentKeyOf(nodeRevisionHasher, ENVIRONMENT);
const LIVE_REVISION = sessionRevisionOf(nodeRevisionHasher, environmentTagOf(nodeRevisionHasher, ENVIRONMENT), { digest: "live", count: 0, leafId: null });

const header = (id = "session-1", version = 3) => JSON.stringify({ type: "session", version, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD });
const message = (id: string, parentId: string | null, text: string) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }] } });

function fixture(lines: string[] = [header(), message("e0", null, "one"), message("e1", "e0", "two")]) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-revision-`));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function revisions(options: { index?: SessionIndexCache } = {}): SessionRevisions {
  return new SessionRevisions({
    index: options.index ?? new SessionIndexCache(),
    environmentId: ENVIRONMENT,
  });
}

const answer = async (service: SessionRevisions, path: string, base?: string) => {
  const result = await service.read(path, base);
  if (result.kind !== "answer") throw new Error(`expected an answer, got ${result.kind}`);
  return result.result;
};

describe("the host's own answer", () => {
  it("reads a stored conversation, and says a worker did not", async () => {
    const { path, cleanup } = fixture();
    try {
      const service = revisions();
      const result = await answer(service, path);
      expect(result.authority).toBe("durable");
      expect(isSessionRevision(result.revision)).toBe(true);
      expect(isEnvironmentKey(result.environmentKey)).toBe(true);
      expect(result.base).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("proves an append is an extension of a cached view, and refuses everything else", async () => {
    const { path, cleanup } = fixture();
    try {
      const service = revisions();
      const cached = (await answer(service, path)).revision;
      expect((await answer(service, path, cached)).base).toBe("current");

      appendFileSync(path, `${message("e2", "e1", "three")}\n`);
      const grown = await answer(service, path, cached);
      expect(grown.base).toBe("prefix");
      expect(grown.revision).not.toBe(cached);

      // An edit that abandons the cached leaf: same file, different branch.
      appendFileSync(path, `${message("edit", "e0", "two, again")}\n`);
      expect((await answer(service, path, cached)).base).toBe("stale");
      // And a revision that was never ours at all.
      expect((await answer(service, path, "r1.ZZZZZZZZ.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).base).toBe("stale");
    } finally {
      cleanup();
    }
  });

  it("treats Pi-shaped compaction and branch-summary appends as replacement barriers", async () => {
    for (const type of ["compaction", "branch_summary"] as const) {
      const { path, cleanup } = fixture();
      try {
        const service = revisions();
        const cached = (await answer(service, path)).revision;
        appendFileSync(path, `${JSON.stringify({ type, id: `${type}-1`, parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z", summary: "Earlier context summarized", tokensBefore: 1000 })}\n`);
        const after = await answer(service, path, cached);
        expect(after.base).toBe("stale");
        expect(after.revision).not.toBe(cached);
      } finally {
        cleanup();
      }
    }
  });

  it("says a deleted conversation is gone, not that a cached one is still valid", async () => {
    const { path, cleanup } = fixture();
    try {
      const service = revisions();
      const cached = (await answer(service, path)).revision;
      rmSync(path);
      const result = await service.read(path, cached);
      expect(result.kind).toBe("refuse");
      if (result.kind !== "refuse") throw new Error("unreachable");
      expect(result.error.code).toBe(ErrorCodes.SessionNotFound);
    } finally {
      cleanup();
    }
  });

  it("hands an older stored format to the engine rather than guessing at it", async () => {
    const { path, cleanup } = fixture([header("session-old", 2), message("e0", null, "one")]);
    try {
      const result = await revisions().read(path);
      expect(result.kind).toBe("route-live");
      if (result.kind !== "route-live") throw new Error("unreachable");
      expect(result.reason.reason).toBe("unsupported-version");
    } finally {
      cleanup();
    }
  });
});

describe("this environment's identity", () => {
  it("is created once, kept private, and published only as an opaque key", () => {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-env-`));
    try {
      const first = environmentIdentity(dir);
      expect(environmentIdentity(dir)).toEqual(first);
      expect(isEnvironmentKey(first.key)).toBe(true);
      expect(first.key).not.toContain(first.id);
      const file = join(dir, "environment.json");
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, id: first.id });
      expect(statSync(file).mode & 0o077).toBe(0);

      // A file we cannot trust is replaced: an invalidated cache is safe, a
      // value we cannot vouch for is not.
      writeFileSync(file, "{ not json");
      const replaced = environmentIdentity(dir);
      expect(replaced.id).not.toBe(first.id);
      expect(replaced.key).not.toBe(first.key);

      // Two environments never share a key, so one can never validate the
      // other's cached conversation.
      const other = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-env-`));
      expect(environmentIdentity(other).key).not.toBe(replaced.key);
      rmSync(other, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts a winner installed after its initial read instead of replacing it", () => {
    const winner = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const contender = "11111111-2222-4333-8444-555555555555";
    const calls: string[] = [];
    let reads = 0;
    const files: EnvironmentIdentityFiles = {
      prepare: () => { calls.push("prepare"); return true; },
      read: () => { calls.push("read"); return ++reads === 1 ? undefined : winner; },
      acquire: () => { calls.push("acquire"); return { kind: "acquired", token: "A" }; },
      install: () => { calls.push("install"); return contender; },
      release: () => { calls.push("release"); },
      wait: () => { calls.push("wait"); },
      transientId: () => contender,
    };

    expect(environmentIdentity("/state", files).id).toBe(winner);
    expect(calls).toEqual(["read", "prepare", "acquire", "read", "release"]);
    expect(calls).not.toContain("install");
  });

  it("re-reads and adopts a complete winner when exclusive create reports EEXIST", () => {
    const winner = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let reads = 0;
    let waited = false;
    const files: EnvironmentIdentityFiles = {
      prepare: () => true,
      read: () => ++reads === 1 ? undefined : winner,
      acquire: () => ({ kind: "contended" }),
      install: () => { throw new Error("must not install"); },
      release: () => { throw new Error("does not own the lock"); },
      wait: () => { waited = true; },
      transientId: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };

    expect(environmentIdentity("/state", files).id).toBe(winner);
    expect(reads).toBe(2);
    expect(waited).toBe(false);
  });

  it("replaces an invalid predecessor only after the exclusive-lock reread", () => {
    const installed = "11111111-2222-4333-8444-555555555555";
    const calls: string[] = [];
    const files: EnvironmentIdentityFiles = {
      prepare: () => { calls.push("prepare"); return true; },
      read: () => { calls.push("read"); return undefined; },
      acquire: () => { calls.push("acquire"); return { kind: "acquired", token: "A" }; },
      install: () => { calls.push("install"); return installed; },
      release: () => { calls.push("release"); },
      wait: () => { calls.push("wait"); },
      transientId: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };

    expect(environmentIdentity("/state", files).id).toBe(installed);
    expect(calls).toEqual(["read", "prepare", "acquire", "read", "install", "release"]);
  });

  it("still answers when its directory cannot be written, without inventing a stored one", () => {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-env-ro-`));
    try {
      chmodSync(dir, 0o500);
      const identity = environmentIdentity(dir);
      expect(isEnvironmentKey(identity.key)).toBe(true);
      expect(() => readFileSync(join(dir, "environment.json"))).toThrow();
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("routing a revision request", () => {
  function harness(options: { open?: string[]; revisions?: SessionRevisions | undefined; projection?: SessionProjection | undefined; path: string; liveResult?: unknown; spawnedResult?: unknown; admission?: PressureAdmission } ) {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-revision-router-`));
    const rows: SessionSummary[] = [{ path: options.path, id: "session-1", cwd: CWD, createdAt: "2026-06-01T00:00:00.000Z", modifiedAt: "2026-06-01T00:00:00.000Z", messageCount: 2 }];
    const catalog = {
      list: () => rows.map((row) => ({ ...row, size: 1 })),
      get: (path: string) => rows.find((row) => row.path === path),
      getListed: vi.fn((path: string) => rows.find((row) => row.path === path)),
      cwdOfListed: vi.fn((path: string) => rows.find((row) => row.path === path)?.cwd),
      cwdOf: (path: string) => rows.find((row) => row.path === path)?.cwd,
      cwdCounts: () => new Map<string, number>(),
      invalidate: () => {},
    } as unknown as SessionCatalog;

    const workerRequests: Array<{ method: string; params: unknown }> = [];
    const owner = options.open?.includes(options.path)
      ? { request: async (method: string, params: unknown) => { workerRequests.push({ method, params }); return options.liveResult ?? { revision: LIVE_REVISION, environmentKey: ENVIRONMENT_KEY, authority: "live" }; } }
      : undefined;
    const spawned = vi.fn(async () => ({
      request: async (method: string, params: unknown) => {
        workerRequests.push({ method, params });
        return options.spawnedResult ?? { revision: LIVE_REVISION, environmentKey: ENVIRONMENT_KEY, authority: "live" };
      },
    }));
    const pool = {
      openSessions: () => options.open ?? [],
      ownerOfSession: (path: string) => (path === options.path ? owner : undefined),
      cwdOfSession: () => undefined,
      bindSession: () => {},
      get: spawned,
    } as unknown as WorkerPool;

    const attention = new AttentionTracker({});
    const projects = new ProjectRegistry({ catalog, agentDir: dir });
    projects.add(CWD);
    const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), access: testAccess(), revisions: options.revisions, projection: options.projection, admission: options.admission });
    return {
      router,
      catalog,
      spawned,
      workerRequests,
      cleanup: () => {
        projects.close();
        attention.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  const request = (router: Router, path: string, baseRevision?: string) =>
    router.handle({ jsonrpc: "2.0", id: 1, method: "session/revision", params: { path, ...(baseRevision ? { baseRevision } : {}) } }, LOCAL_ACCESS);

  it("answers a cold conversation without starting a worker", async () => {
    const { path, cleanup } = fixture();
    const h = harness({ path, revisions: revisions() });
    try {
      const response = await request(h.router, path) as { result: { authority: string; revision: string; environmentKey: string } };
      expect(response.result.authority).toBe("durable");
      expect(isSessionRevision(response.result.revision)).toBe(true);
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("lets the worker that owns a session answer for it", async () => {
    const { path, cleanup } = fixture();
    const h = harness({ path, open: [path], revisions: revisions() });
    try {
      const response = await request(h.router, path) as { result: { authority: string } };
      expect(response.result.authority).toBe("live");
      expect(h.workerRequests).toEqual([{ method: "session/revision", params: { path } }]);
      expect(h.spawned).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("asks the engine for a conversation it cannot read on its own", async () => {
    const { path, cleanup } = fixture([header("session-old", 2), message("e0", null, "one")]);
    const h = harness({ path, revisions: revisions() });
    try {
      const response = await request(h.router, path) as { result: { authority: string } };
      expect(response.result.authority).toBe("live");
      expect(h.spawned).toHaveBeenCalledTimes(1);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it.each(["not-a-session", "unreadable"] as const)("routes a path-gated %s parser result to Pi", async (reason) => {
    const { path, cleanup } = fixture();
    const index = { read: async () => ({ ok: false as const, failure: { reason } }), invalidate: () => {}, bytes: 0, paths: () => [] } as unknown as SessionIndexCache;
    const h = harness({ path, revisions: revisions({ index }) });
    try {
      const response = await request(h.router, path) as { result: { authority: string } };
      expect(response.result.authority).toBe("live");
      expect(h.spawned).toHaveBeenCalledTimes(1);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("refuses a host without a revision identity, even when a worker is already open", async () => {
    const { path, cleanup } = fixture();
    const h = harness({ path, open: [path], revisions: undefined });
    try {
      const response = await request(h.router, path) as { error: { code: number; message: string } };
      expect(response.error.code).toBe(ErrorCodes.RevisionUnavailable);
      expect(response.error.message).toMatch(/no configured revision identity/);
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it.each([
    ["another environment key", { revision: LIVE_REVISION, environmentKey: "e1.ZZZZZZZZZZZZZZZZZZZZZZ", authority: "live" }],
    ["another environment tag", { revision: "r1.ZZZZZZZZ.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ", environmentKey: ENVIRONMENT_KEY, authority: "live" }],
    ["an invalid shape", { revision: "not-a-revision", environmentKey: ENVIRONMENT_KEY, authority: "live" }],
  ])("refuses a live answer carrying %s", async (_label, liveResult) => {
    const { path, cleanup } = fixture();
    const h = harness({ path, open: [path], revisions: revisions(), liveResult });
    try {
      const response = await request(h.router, path) as { error: { code: number } };
      expect(response.error.code).toBe(ErrorCodes.RevisionUnavailable);
      expect(h.spawned).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it.each([
    ["a history window", "pi/session/entries", { path: "", window: { tail: 2 } }, { entries: [], leafId: null, window: { revision: LIVE_REVISION, environmentKey: "e1.ZZZZZZZZZZZZZZZZZZZZZZ" } }],
    ["a session load", "session/load", { path: "" }, { state: {}, revision: LIVE_REVISION, environmentKey: "e1.ZZZZZZZZZZZZZZZZZZZZZZ" }],
  ] as const)("refuses %s forwarded with another environment key", async (_label, method, rawParams, spawnedResult) => {
    const { path, cleanup } = fixture();
    const h = harness({ path, open: [path], revisions: revisions(), spawnedResult });
    try {
      const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method, params: { ...rawParams, path } }, LOCAL_ACCESS) as { error: { code: number } };
      expect(response.error.code).toBe(ErrorCodes.RevisionUnavailable);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("rejects an unknown or out-of-scope path before a revision read or worker spawn", async () => {
    const { path, cleanup } = fixture();
    const service = revisions();
    const read = vi.spyOn(service, "read");
    const h = harness({ path, revisions: service });
    try {
      const response = await request(h.router, join(path, "..", "..", "private.jsonl")) as { error: { code: number } };
      expect(response.error.code).toBe(ErrorCodes.SessionNotFound);
      expect(read).not.toHaveBeenCalled();
      expect(h.catalog.getListed).not.toHaveBeenCalled();
      expect(h.catalog.cwdOfListed).toHaveBeenCalledTimes(1);
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("answers authority:any from the durable projection without spawning, and defaults an omitted window to the tail", async () => {
    const { path, cleanup } = fixture();
    const index = new SessionIndexCache();
    const service = revisions({ index });
    const projection = new SessionProjection({ index, revisions: service });
    const h = harness({ path, revisions: service, projection });
    try {
      const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path, authority: "any" } }, LOCAL_ACCESS) as { result: { entries: unknown[]; window: { authority: string; mode: string } } };
      expect(response.result.entries).toHaveLength(2);
      expect(response.result.window).toMatchObject({ authority: "durable", mode: "replace" });
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("refuses a worker-free full durable read before projection but keeps bounded reads available", async () => {
    const { path, cleanup } = fixture();
    const index = new SessionIndexCache();
    const service = revisions({ index });
    const projection = new SessionProjection({ index, revisions: service });
    const read = vi.spyOn(projection, "read");
    const admits = vi.fn((kind: string) => kind !== "worker_free_full_read");
    const h = harness({ path, revisions: service, projection, admission: { admits, refusing: () => ["worker_free_full_read"] } });
    try {
      const refused = await h.router.handle(
        { jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path, authority: "any", window: { all: true }, bodyLimit: 4096 } },
        LOCAL_ACCESS,
      );
      expect(refused).toMatchObject({ error: { code: ErrorCodes.SessionBusy, message: expect.stringMatching(/bounded history window/) } });
      expect(read).not.toHaveBeenCalled();
      expect(h.spawned).not.toHaveBeenCalled();

      const bounded = await h.router.handle(
        { jsonrpc: "2.0", id: 2, method: "pi/session/entries", params: { path, authority: "any", window: { tail: 40 }, bodyLimit: 4096 } },
        LOCAL_ACCESS,
      );
      expect(bounded).toHaveProperty("result");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("lets a critical-pressure live owner answer the bounded all-window ensure shape", async () => {
    const { path, cleanup } = fixture();
    const index = new SessionIndexCache();
    const service = revisions({ index });
    const projection = new SessionProjection({ index, revisions: service });
    const read = vi.spyOn(projection, "read");
    const liveResult = { entries: [{ id: "live-only" }], leafId: "live-only", window: { revision: LIVE_REVISION, environmentKey: ENVIRONMENT_KEY, authority: "live", mode: "replace" } };
    const admits = vi.fn(() => false);
    const h = harness({ path, open: [path], revisions: service, projection, liveResult, admission: { admits, refusing: () => ["worker_free_full_read"] } });
    try {
      const response = await h.router.handle(
        { jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path, authority: "any", window: { all: true }, bodyLimit: 4096 } },
        LOCAL_ACCESS,
      );
      expect(response).toMatchObject({ result: liveResult });
      expect(admits).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("lets a live owner win authority:any and forwards a bounded first-screen request", async () => {
    const { path, cleanup } = fixture();
    const index = new SessionIndexCache();
    const service = revisions({ index });
    const projection = new SessionProjection({ index, revisions: service });
    const read = vi.spyOn(projection, "read");
    const liveResult = { entries: [{ id: "live-only" }], leafId: "live-only", window: { revision: LIVE_REVISION, environmentKey: ENVIRONMENT_KEY, authority: "live", mode: "replace" } };
    const h = harness({ path, open: [path], revisions: service, projection, liveResult });
    try {
      const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path, authority: "any" } }, LOCAL_ACCESS) as { result: typeof liveResult };
      expect(response.result).toEqual(liveResult);
      expect(read).not.toHaveBeenCalled();
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([{ method: "pi/session/entries", params: { path, authority: "any", window: { tail: 40 } } }]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("routes an unmigrated authority:any session to the engine and marks the live answer", async () => {
    const { path, cleanup } = fixture([header("session-old", 2), message("e0", null, "one")]);
    const index = new SessionIndexCache();
    const service = revisions({ index });
    const projection = new SessionProjection({ index, revisions: service });
    const livePage = { entries: [{ id: "migrated" }], leafId: "migrated", window: { revision: LIVE_REVISION, environmentKey: ENVIRONMENT_KEY, authority: "live", mode: "replace" } };
    const h = harness({ path, revisions: service, projection, spawnedResult: livePage });
    try {
      const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path, authority: "any", window: { tail: 40 } } }, LOCAL_ACCESS) as { result: typeof livePage };
      expect(response.result).toEqual(livePage);
      expect(h.spawned).toHaveBeenCalledTimes(1);
      expect(h.workerRequests.map(call => call.method)).toEqual(["session/load", "pi/session/entries"]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("refuses an over-cap authority:any projection without silently starting a worker", async () => {
    // session-index.test drives the real default 32k cap; this route test pins
    // what that exact failure does at the worker-spawn boundary.
    const { path, cleanup } = fixture();
    const index = { read: async () => ({ ok: false as const, failure: { reason: "too-large" as const, detail: "entries" } }), invalidate: () => {}, bytes: 0, paths: () => [] } as unknown as SessionIndexCache;
    const service = revisions({ index });
    const projection = new SessionProjection({ index, revisions: service });
    const h = harness({ path, revisions: service, projection });
    try {
      const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path, authority: "any", window: { tail: 40 } } }, LOCAL_ACCESS) as { error: { code: number } };
      expect(response.error.code).toBe(ErrorCodes.RevisionUnavailable);
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("refuses an unreadable authority:any projection without silently starting a worker", async () => {
    const { path, cleanup } = fixture();
    const index = { read: async () => ({ ok: false as const, failure: { reason: "unreadable" as const } }), invalidate: () => {}, bytes: 0, paths: () => [] } as unknown as SessionIndexCache;
    const service = revisions({ index });
    const projection = new SessionProjection({ index, revisions: service });
    const h = harness({ path, revisions: service, projection });
    try {
      const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path, authority: "any", window: { tail: 40 } } }, LOCAL_ACCESS) as { error: { code: number } };
      expect(response.error.code).toBe(ErrorCodes.RevisionUnavailable);
      expect(h.spawned).not.toHaveBeenCalled();
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("never puts the environment's raw identity in an answer", async () => {
    const { path, cleanup } = fixture();
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-env-`));
    const identity = environmentIdentity(dir);
    const service = new SessionRevisions({ index: new SessionIndexCache(), environmentId: identity.id });
    const h = harness({ path, revisions: service });
    try {
      const response = await request(h.router, path, "r1.ZZZZZZZZ.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
      expect(JSON.stringify(response)).not.toContain(identity.id);
      expect(JSON.stringify(response)).toContain(identity.key);
    } finally {
      h.cleanup();
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
