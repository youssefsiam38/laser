/**
 * The read-only session index (RP-9).
 *
 * Two properties matter more than any other here: the host must never change a
 * conversation by reading it, and the revision it derives must depend on the
 * content alone — so the same stored bytes produce the same value after the
 * cache, the worker and the whole host have gone away.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { expect, it, describe } from "vitest";
import { appendFileSync, fstatSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";
import { DEFAULT_SESSION_INDEX_LIMITS, SessionIndexCache } from "../src/session-index.js";

const TAG = "AAAAAAAA";

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-index-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const header = (id = "session-1", version = 3) => JSON.stringify({ type: "session", version, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" });
const message = (id: string, parentId: string | null, text: string) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }] } });

/** A stored conversation, written the way the engine writes one. */
function session(dir: string, name: string, lines: string[], { terminated = true } = {}): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + (terminated ? "\n" : ""));
  return path;
}

const revisionOf = async (cache: SessionIndexCache, path: string): Promise<string> => {
  const result = await cache.revision(path, TAG);
  if (!result.ok) throw new Error(`expected a revision, got ${result.failure.reason}`);
  return result.revision;
};

describe("a stored conversation's revision", () => {
  it("survives losing every cache, and changes only when the conversation does", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = session(dir, "a.jsonl", [header(), message("e0", null, "one"), message("e1", "e0", "two")]);
      const warm = new SessionIndexCache();
      const first = await revisionOf(warm, path);
      // A second host, with nothing retained, reads the same value.
      expect(await revisionOf(new SessionIndexCache(), path)).toBe(first);
      // Reading it again changes nothing.
      expect(await revisionOf(warm, path)).toBe(first);

      appendFileSync(path, `${message("e2", "e1", "three")}\n`);
      const grown = await revisionOf(warm, path);
      expect(grown).not.toBe(first);
      // The incremental fold and a cold one agree, or a restart would look
      // like a change to every cached view.
      expect(await revisionOf(new SessionIndexCache(), path)).toBe(grown);
      cleanup();
    } finally {
      cleanup();
    }
  });

  it("keeps a valid final record that has no newline yet, without writing the newline", async () => {
    const { dir, cleanup } = workspace();
    try {
      const lines = [header(), message("e0", null, "one"), message("e1", "e0", "two")];
      const path = session(dir, "a.jsonl", lines, { terminated: false });
      const before = { bytes: readFileSync(path), stats: statSync(path) };
      const cache = new SessionIndexCache();
      const index = await cache.read(path);
      if (!index.ok) throw new Error(index.failure.reason);
      // The engine keeps that record; so must this, and its leaf is that entry.
      expect(index.index.entries.map((entry) => entry.id)).toEqual(["e0", "e1"]);
      expect(index.index.leafId).toBe("e1");
      const unterminated = await revisionOf(cache, path);
      // The engine would append the newline on open. Same content, so the same
      // revision — and reading must not have been the thing that appended it.
      expect(readFileSync(path)).toEqual(before.bytes);
      appendFileSync(path, "\n");
      expect(await revisionOf(new SessionIndexCache(), path)).toBe(unterminated);
      expect(await revisionOf(cache, path)).toBe(unterminated);
      expect(before.stats.size).toBe(statSync(path).size - 1);
      cleanup();
    } finally {
      cleanup();
    }
  });

  it("excludes bytes that are not yet a record, and notices when they become one", async () => {
    const { dir, cleanup } = workspace();
    try {
      const complete = [header(), message("e0", null, "one")];
      const path = session(dir, "a.jsonl", complete);
      const cache = new SessionIndexCache();
      const settled = await revisionOf(cache, path);

      const torn = message("e1", "e0", "two");
      appendFileSync(path, torn.slice(0, torn.length - 12));
      const duringWrite = await cache.read(path);
      if (!duringWrite.ok) throw new Error(duringWrite.failure.reason);
      expect(duringWrite.index.entries.map((entry) => entry.id)).toEqual(["e0"]);
      expect(await revisionOf(cache, path)).toBe(settled);

      appendFileSync(path, `${torn.slice(torn.length - 12)}\n`);
      expect(await revisionOf(cache, path)).not.toBe(settled);
      expect(await revisionOf(new SessionIndexCache(), path)).toBe(await revisionOf(cache, path));
      cleanup();
    } finally {
      cleanup();
    }
  });

  it("never changes the conversation it reads", async () => {
    const { dir, cleanup } = workspace();
    try {
      const paths = [
        session(dir, "terminated.jsonl", [header(), message("e0", null, "one")]),
        session(dir, "unterminated.jsonl", [header(), message("e0", null, "one")], { terminated: false }),
        session(dir, "torn.jsonl", [header(), message("e0", null, "one"), '{"type":"message","id":"e1"']),
      ];
      const empty = join(dir, "empty.jsonl");
      writeFileSync(empty, "");
      const before = [...paths, empty].map((path) => ({ path, bytes: readFileSync(path), stats: statSync(path) }));
      const cache = new SessionIndexCache();
      for (let attempt = 0; attempt < 100; attempt++) for (const { path } of before) await cache.read(path);
      for (const { path, bytes, stats } of before) {
        const now = statSync(path);
        expect(readFileSync(path)).toEqual(bytes);
        expect([now.size, now.mtimeMs, now.ctimeMs, now.ino]).toEqual([stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino]);
      }
      expect(await cache.read(empty)).toMatchObject({ ok: false, failure: { reason: "not-a-session" } });
      cleanup();
    } finally {
      cleanup();
    }
  });
});

describe("a conversation that changes underneath the read", () => {
  it("re-reads a file rewritten in place at the same length, even with its timestamp restored", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = session(dir, "a.jsonl", [header(), message("e0", null, "one")]);
      const cache = new SessionIndexCache();
      const original = await revisionOf(cache, path);
      const stats = statSync(path);

      // Same size, same mtime: only ctime moves, which is exactly the case a
      // size-and-mtime check would miss.
      writeFileSync(path, [header(), message("e0", null, "ONE")].join("\n") + "\n");
      expect(statSync(path).size).toBe(stats.size);
      utimesSync(path, stats.atime, stats.mtime);
      // Restored to the same wall clock instant (the API's resolution is
      // coarser than the stat's), so only ctime still says anything happened.
      expect(statSync(path).mtimeMs).toBeCloseTo(stats.mtimeMs, 0);

      expect(await revisionOf(cache, path)).not.toBe(original);
      expect(await revisionOf(cache, path)).toBe(await revisionOf(new SessionIndexCache(), path));
      cleanup();
    } finally {
      cleanup();
    }
  });

  it("refuses a read the file was rewritten during, rather than folding a mixture", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = session(dir, "a.jsonl", [header(), message("e0", null, "one"), message("e1", "e0", "two")]);
      let calls = 0;
      let yields = 0;
      const cache = new SessionIndexCache({
        yield: async () => { yields++; },
        // Every read sees the file shrink between its two looks: the shape of
        // a compaction or a migration landing mid-read.
        stat: (fd) => {
          const stats = fstatSync(fd);
          return ++calls % 2 === 0 ? ({ ...stats, size: 0, isFile: () => true } as Stats) : stats;
        },
      });
      const result = await cache.read(path);
      expect(result).toMatchObject({ ok: false, failure: { reason: "changed" } });
      // Three attempts, two stats each: it retried rather than giving up once.
      expect(calls).toBe(6);
      expect(yields).toBe(2);
      // And nothing half-folded was kept for the next reader.
      expect(await revisionOf(new SessionIndexCache(), path)).toBe(await revisionOf(new SessionIndexCache(), path));
      cleanup();
    } finally {
      cleanup();
    }
  });
});

describe("hard bounds", () => {
  const cases: Array<{ name: string; limits: Parameters<typeof makeCache>[0]; lines: () => string[] }> = [
    { name: "one oversized record", limits: { lineBytes: 200 }, lines: () => [header(), message("e0", null, "x".repeat(400))] },
    { name: "too many records", limits: { entries: 2 }, lines: () => [header(), ...[0, 1, 2, 3].map((i) => message(`e${i}`, i ? `e${i - 1}` : null, `m${i}`))] },
    { name: "too much retained identity", limits: { indexBytes: 128 }, lines: () => [header(), ...[0, 1, 2, 3].map((i) => message(`e${i}`, i ? `e${i - 1}` : null, `m${i}`))] },
    { name: "too large a file", limits: { fileBytes: 32 }, lines: () => [header(), message("e0", null, "one")] },
  ];

  function makeCache(limits: Partial<{ lineBytes: number; entries: number; indexBytes: number; fileBytes: number; checkpoints: number }>): SessionIndexCache {
    return new SessionIndexCache({ limits });
  }

  for (const { name, limits, lines } of cases) {
    it(`reports ${name} instead of allocating without a ceiling`, async () => {
      const { dir, cleanup } = workspace();
      try {
        const path = session(dir, "a.jsonl", lines());
        const cache = makeCache(limits);
        expect(await cache.read(path)).toMatchObject({ ok: false, failure: { reason: "too-large" } });
        expect(cache.bytes).toBe(0);
        cleanup();
      } finally {
        cleanup();
      }
    });
  }

  it("keeps only the newest states a cached revision can be proved against", async () => {
    const { dir, cleanup } = workspace();
    try {
      const lines = [header(), ...Array.from({ length: 30 }, (_, i) => message(`e${i}`, i ? `e${i - 1}` : null, `m${i}`))];
      const path = session(dir, "a.jsonl", lines);
      const result = await new SessionIndexCache({ limits: { checkpoints: 5 } }).read(path);
      if (!result.ok) throw new Error(result.failure.reason);
      expect(result.index.checkpoints).toHaveLength(5);
      expect(result.index.checkpoints.map((checkpoint) => checkpoint.leafId)).toEqual(["e25", "e26", "e27", "e28", "e29"]);
      cleanup();
    } finally {
      cleanup();
    }
  });

  it("bounds what it retains across conversations and reports accounted identity estimates", async () => {
    const { dir, cleanup } = workspace();
    try {
      const paths = Array.from({ length: 4 }, (_, i) =>
        session(dir, `s${i}.jsonl`, [header(`session-${i}`), ...Array.from({ length: 20 }, (_, n) => message(`e${n}`, n ? `e${n - 1}` : null, `m${n}`))]));
      const cache = new SessionIndexCache({ sessions: 2 });
      for (const path of paths) await revisionOf(cache, path);
      expect(cache.paths()).toHaveLength(2);
      expect(cache.bytes).toBeGreaterThan(0);
      expect(cache.bytes).toBeLessThan(DEFAULT_SESSION_INDEX_LIMITS.indexBytes * 2);
      cache.clear();
      expect(cache.bytes).toBe(0);
      cleanup();
    } finally {
      cleanup();
    }
  });

  it("returns copies rather than aliases into its cached arrays", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = session(dir, "copies.jsonl", [header(), message("e0", null, "one"), message("e1", "e0", "two")]);
      const cache = new SessionIndexCache();
      const first = await cache.read(path);
      if (!first.ok) throw new Error(first.failure.reason);
      first.index.entries.splice(0);
      first.index.checkpoints.splice(0);
      first.index.header.id = "changed-by-caller";
      const second = await cache.read(path);
      if (!second.ok) throw new Error(second.failure.reason);
      expect(second.index.entries.map((entry) => entry.id)).toEqual(["e0", "e1"]);
      expect(second.index.checkpoints).toHaveLength(2);
      expect(second.index.header.id).toBe("session-1");
    } finally {
      cleanup();
    }
  });

  it("keeps cold 20k/50k scans linear and cooperative, then caches an unchanged bound failure", async () => {
    const { dir, cleanup } = workspace();
    try {
      const makeLarge = (count: number) => session(dir, `${count}.jsonl`, [
        header(`session-${count}`),
        ...Array.from({ length: count }, (_, i) => message(`e${i}`, i ? `e${i - 1}` : null, "m")),
      ]);
      const paths = [makeLarge(20_000), makeLarge(50_000)];
      expect(DEFAULT_SESSION_INDEX_LIMITS.entries).toBe(32_000);
      let hashes = 0;
      let yields = 0;
      let lastYield = performance.now();
      let maxSliceMs = 0;
      const cache = new SessionIndexCache({
        hash: (text) => { hashes++; return nodeRevisionHasher(text); },
        yieldEveryLines: 64,
        yield: async () => {
          const now = performance.now();
          maxSliceMs = Math.max(maxSliceMs, now - lastYield);
          yields++;
          await new Promise<void>((resolve) => setImmediate(resolve));
          lastYield = performance.now();
        },
      });

      const start20 = performance.now();
      const twenty = await cache.read(paths[0]!);
      const cold20Ms = performance.now() - start20;
      expect(twenty).toMatchObject({ ok: true });
      const repeat20Start = performance.now();
      expect(await cache.read(paths[0]!)).toEqual(twenty);
      const repeat20Ms = performance.now() - repeat20Start;
      expect(repeat20Ms).toBeLessThan(cold20Ms / 2);

      const start50 = performance.now();
      const fifty = await cache.read(paths[1]!);
      const cold50Ms = performance.now() - start50;
      expect(fifty).toMatchObject({ ok: false, failure: { reason: "too-large", detail: "entries" } });
      expect(yields).toBeGreaterThan(700);
      expect(maxSliceMs).toBeLessThan(50);

      const hashesAfterCold = hashes;
      const repeatStart = performance.now();
      expect(await cache.read(paths[1]!)).toEqual(fifty);
      const repeat50Ms = performance.now() - repeatStart;
      expect(hashes).toBe(hashesAfterCold);
      expect(repeat50Ms).toBeLessThan(50);
      console.info(JSON.stringify({ cold20Ms: Math.round(cold20Ms), repeat20Ms: Math.round(repeat20Ms), cold50Ms: Math.round(cold50Ms), repeat50Ms: Math.round(repeat50Ms), maxSliceMs: Number(maxSliceMs.toFixed(2)), accountedBytes: cache.bytes }));
    } finally {
      cleanup();
    }
  }, 30_000);

  it("does not re-read the 64 KiB anchor on an untouched cache hit", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = session(dir, "anchor.jsonl", [header(), ...Array.from({ length: 1000 }, (_, i) => message(`e${i}`, i ? `e${i - 1}` : null, "m"))]);
      let hashes = 0;
      const cache = new SessionIndexCache({ hash: (text) => { hashes++; return nodeRevisionHasher(text); } });
      await cache.read(path);
      const afterCold = hashes;
      await cache.read(path);
      // Header identity is checked; the anchor itself is not hashed again.
      expect(hashes - afterCold).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("what this host will not read on its own", () => {
  it("names the reason rather than guessing at it", async () => {
    const { dir, cleanup } = workspace();
    try {
      const cache = new SessionIndexCache();
      expect(await cache.read(join(dir, "gone.jsonl"))).toMatchObject({ ok: false, failure: { reason: "missing" } });

      const notASession = join(dir, "notes.jsonl");
      writeFileSync(notASession, "just some text\n");
      expect(await cache.read(notASession)).toMatchObject({ ok: false, failure: { reason: "not-a-session" } });

      // An older stored format: the engine rewrites it on open, and this must
      // not, so it is reported as something only a worker can answer.
      const old = session(dir, "old.jsonl", [header("session-old", 2), message("e0", null, "one")]);
      let stats = 0;
      const negative = new SessionIndexCache({ stat: (fd) => { stats++; return fstatSync(fd); } });
      expect(await negative.read(old)).toMatchObject({ ok: false, failure: { reason: "unsupported-version", detail: "2" } });
      expect(await negative.read(old)).toMatchObject({ ok: false, failure: { reason: "unsupported-version", detail: "2" } });
      expect(stats).toBe(1);
      cleanup();
    } finally {
      cleanup();
    }
  });
});
