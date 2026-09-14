/**
 * Durable revisions as a client sees them (RP-9): what the host answers for a
 * conversation nobody is driving, what a cached revision is worth against it,
 * and the two things that must never happen — a worker started for a read, and
 * the environment's raw identity leaving the host.
 */
import { ErrorCodes, PRODUCT_NAME, isEnvironmentKey, isSessionRevision } from "@lasercode/protocol";
import { describe, expect, it, vi } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@lasercode/protocol";
import { AttentionTracker } from "../src/attention.js";
import type { SessionCatalog } from "../src/catalog.js";
import { environmentIdentity } from "../src/environment-identity.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionRevisions } from "../src/session-revision.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";

const CWD = "/projects/a";
const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";

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
    environmentKey: environmentIdentity(mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-envkey-`))).key,
  });
}

const answer = (service: SessionRevisions, path: string, base?: string) => {
  const result = service.read(path, base);
  if (result.kind !== "answer") throw new Error(`expected an answer, got ${result.kind}`);
  return result.result;
};

describe("the host's own answer", () => {
  it("reads a stored conversation, and says a worker did not", () => {
    const { path, cleanup } = fixture();
    try {
      const service = revisions();
      const result = answer(service, path);
      expect(result.authority).toBe("durable");
      expect(isSessionRevision(result.revision)).toBe(true);
      expect(isEnvironmentKey(result.environmentKey)).toBe(true);
      expect(result.base).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("proves an append is an extension of a cached view, and refuses everything else", () => {
    const { path, cleanup } = fixture();
    try {
      const service = revisions();
      const cached = answer(service, path).revision;
      expect(answer(service, path, cached).base).toBe("current");

      appendFileSync(path, `${message("e2", "e1", "three")}\n`);
      const grown = answer(service, path, cached);
      expect(grown.base).toBe("prefix");
      expect(grown.revision).not.toBe(cached);

      // An edit that abandons the cached leaf: same file, different branch.
      appendFileSync(path, `${message("edit", "e0", "two, again")}\n`);
      expect(answer(service, path, cached).base).toBe("stale");
      // And a revision that was never ours at all.
      expect(answer(service, path, "r1.ZZZZZZZZ.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ").base).toBe("stale");
    } finally {
      cleanup();
    }
  });

  it("treats a compaction as a replacement, never as a suffix", () => {
    const { path, cleanup } = fixture();
    try {
      const service = revisions();
      const cached = answer(service, path).revision;
      // A compaction rewrites the stored conversation in place.
      writeFileSync(path, [header(), message("c0", null, "summary"), message("e2", "c0", "after")].join("\n") + "\n");
      const after = answer(service, path, cached);
      expect(after.base).toBe("stale");
      expect(after.revision).not.toBe(cached);
    } finally {
      cleanup();
    }
  });

  it("says a deleted conversation is gone, not that a cached one is still valid", () => {
    const { path, cleanup } = fixture();
    try {
      const service = revisions();
      const cached = answer(service, path).revision;
      rmSync(path);
      const result = service.read(path, cached);
      expect(result.kind).toBe("refuse");
      if (result.kind !== "refuse") throw new Error("unreachable");
      expect(result.error.code).toBe(ErrorCodes.SessionNotFound);
    } finally {
      cleanup();
    }
  });

  it("hands an older stored format to the engine rather than guessing at it", () => {
    const { path, cleanup } = fixture([header("session-old", 2), message("e0", null, "one")]);
    try {
      const result = revisions().read(path);
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
  function harness(options: { open?: string[]; revisions?: SessionRevisions | undefined; path: string } ) {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-revision-router-`));
    const rows: SessionSummary[] = [{ path: options.path, id: "session-1", cwd: CWD, createdAt: "2026-06-01T00:00:00.000Z", modifiedAt: "2026-06-01T00:00:00.000Z", messageCount: 2 }];
    const catalog = {
      list: () => rows.map((row) => ({ ...row, size: 1 })),
      get: (path: string) => rows.find((row) => row.path === path),
      getListed: (path: string) => rows.find((row) => row.path === path),
      cwdOf: (path: string) => rows.find((row) => row.path === path)?.cwd,
      cwdCounts: () => new Map<string, number>(),
      invalidate: () => {},
    } as unknown as SessionCatalog;

    const workerRequests: Array<{ method: string; params: unknown }> = [];
    const owner = options.open?.includes(options.path)
      ? { request: async (method: string, params: unknown) => { workerRequests.push({ method, params }); return { revision: "r1.LLLLLLLL.LLLLLLLLLLLLLLLLLLLLLLLLLLL", environmentKey: "e1.LLLLLLLLLLLLLLLLLLLLLL", authority: "live" }; } }
      : undefined;
    const spawned = vi.fn(async () => ({
      request: async (method: string, params: unknown) => {
        workerRequests.push({ method, params });
        return { revision: "r1.SSSSSSSS.SSSSSSSSSSSSSSSSSSSSSSSSSSS", environmentKey: "e1.SSSSSSSSSSSSSSSSSSSSSS", authority: "live" };
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
    const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), revisions: options.revisions });
    return {
      router,
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
    router.handle({ jsonrpc: "2.0", id: 1, method: "session/revision", params: { path, ...(baseRevision ? { baseRevision } : {}) } });

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

  it("says so plainly when this host cannot read stored conversations at all", async () => {
    const { path, cleanup } = fixture();
    const h = harness({ path, revisions: undefined });
    try {
      const response = await request(h.router, path) as { error: { code: number; message: string } };
      expect(response.error.code).toBe(ErrorCodes.RevisionUnavailable);
      expect(response.error.message).toMatch(/not open/);
      expect(h.spawned).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
      cleanup();
    }
  });

  it("never puts the environment's raw identity in an answer", async () => {
    const { path, cleanup } = fixture();
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-env-`));
    const identity = environmentIdentity(dir);
    const service = new SessionRevisions({ index: new SessionIndexCache(), environmentId: identity.id, environmentKey: identity.key });
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
