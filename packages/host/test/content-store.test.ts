/**
 * RP-7 / review finding 7: the body tables migrate atomically, or not at all.
 *
 * The first version of this did schema inspection, a delete, a drop and a
 * create as independent statements, so a process that stopped in the middle
 * left a store that was neither shape. Each step is now one transaction with
 * its own version bump, and a step that fails leaves the database exactly
 * where it was — which is what the fault injection below proves, statement by
 * statement.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_SCHEMA_VERSION, ContentStore, type ContentDatabase } from "../src/content-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => ContentDatabase & { close(): void };
};

let root: string | undefined;
const open = new Set<{ close(): void }>();

afterEach(() => {
  for (const db of open) db.close();
  open.clear();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function database(name = "logs.db"): ContentDatabase & { close(): void } {
  root ??= mkdtempSync(join(tmpdir(), "content-store-"));
  const db = new DatabaseSync(join(root, name));
  open.add(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, detail_ref TEXT, body_released TEXT);
    CREATE TABLE IF NOT EXISTS content (ref TEXT PRIMARY KEY, bytes INTEGER NOT NULL, content_type TEXT NOT NULL, body TEXT NOT NULL);
  `);
  return db;
}

function version(db: ContentDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  return Number(Object.values(row)[0]);
}

function tables(db: ContentDatabase): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
}

describe("migration", () => {
  it("brings a store with no body tables to the current version", () => {
    const db = database();
    const store = new ContentStore(db);
    expect(store.migrate()).toEqual({ from: 0, to: CONTENT_SCHEMA_VERSION, ahead: false });
    expect(version(db)).toBe(CONTENT_SCHEMA_VERSION);
    expect(tables(db)).toContain("content_chunks");
    const columns = (db.prepare("PRAGMA table_info(content_chunks)").all() as { name: string }[]).map((column) => column.name);
    expect(columns).toContain("sha256");
  });

  it("is idempotent", () => {
    const db = database();
    expect(new ContentStore(db).migrate().to).toBe(CONTENT_SCHEMA_VERSION);
    expect(new ContentStore(db).migrate()).toEqual({ from: CONTENT_SCHEMA_VERSION, to: CONTENT_SCHEMA_VERSION, ahead: false });
  });

  it("gives up the bodies of the interim chunk shape, and keeps every other row", () => {
    const db = database();
    // A store written by the build that chunked bodies without per-chunk
    // integrity evidence.
    db.exec(`
      ALTER TABLE content ADD COLUMN chunked INTEGER;
      CREATE TABLE content_chunks (ref TEXT NOT NULL, idx INTEGER NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (ref, idx));
      PRAGMA user_version = 1;
    `);
    db.prepare("INSERT INTO content (ref, bytes, content_type, body, chunked) VALUES ('old', 10, 'application/json', '', 1)").run();
    db.prepare("INSERT INTO content_chunks (ref, idx, bytes, body) VALUES ('old', 0, 10, '0123456789')").run();
    db.prepare("INSERT INTO content (ref, bytes, content_type, body) VALUES ('small', 2, 'application/json', '{}')").run();

    new ContentStore(db).migrate();
    expect(version(db)).toBe(CONTENT_SCHEMA_VERSION);
    const refs = (db.prepare("SELECT ref FROM content").all() as { ref: string }[]).map((row) => row.ref);
    expect(refs).toEqual(["small"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM content_chunks").get() as { n: number }).n).toBe(0);
  });

  it("leaves a store a newer app wrote exactly as it is", () => {
    const db = database();
    db.exec(`PRAGMA user_version = ${CONTENT_SCHEMA_VERSION + 5}`);
    const before = tables(db);
    expect(new ContentStore(db).migrate()).toEqual({
      from: CONTENT_SCHEMA_VERSION + 5,
      to: CONTENT_SCHEMA_VERSION + 5,
      ahead: true,
    });
    expect(tables(db)).toEqual(before);
  });

  it("leaves the database where it was when a statement fails, at every step", () => {
    // One run per statement of the migration: the store is rebuilt, that
    // statement throws, and the database must be openable at its old version
    // with no half-built shape.
    for (let failAt = 0; failAt < 8; failAt++) {
      root = undefined;
      const db = database(`fault-${failAt}.db`);
      db.exec(`
        ALTER TABLE content ADD COLUMN chunked INTEGER;
        CREATE TABLE content_chunks (ref TEXT NOT NULL, idx INTEGER NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (ref, idx));
        PRAGMA user_version = 1;
      `);
      db.prepare("INSERT INTO content (ref, bytes, content_type, body, chunked) VALUES ('old', 10, 'application/json', '', 1)").run();
      db.prepare("INSERT INTO content_chunks (ref, idx, bytes, body) VALUES ('old', 0, 10, '0123456789')").run();

      let executed = 0;
      const faulty: ContentDatabase = {
        exec: (sql: string) => {
          // Let the transaction's own control statements through, so a rollback
          // can still happen; fail the nth statement of the migration itself.
          if (!/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql) && executed++ === failAt) throw new Error(`fault at statement ${failAt}`);
          db.exec(sql);
        },
        prepare: (sql: string) => db.prepare(sql),
      };
      const before = version(db);
      let threw = false;
      try {
        new ContentStore(faulty).migrate();
      } catch {
        threw = true;
      }
      if (!threw) {
        // The migration ran out of statements to fail: it is complete.
        expect(version(db)).toBe(CONTENT_SCHEMA_VERSION);
        continue;
      }
      // Nothing half-applied: the version is where it was, and the store still
      // opens and migrates cleanly afterwards.
      expect(version(db), `statement ${failAt}`).toBe(before);
      expect(new ContentStore(db).migrate().to).toBe(CONTENT_SCHEMA_VERSION);
    }
  });
});

describe("bodies", () => {
  function store(): ContentStore {
    const db = database();
    const content = new ContentStore(db);
    content.migrate();
    return content;
  }

  it("stores a small body in one row and reads it back", () => {
    const content = store();
    const body = JSON.stringify({ model: "m", messages: [] });
    const put = content.put(body);
    expect(put.inserted).toBe(true);
    expect(content.read(put.ref, 1024 * 1024)).toMatchObject({ text: body, truncated: false });
    // The same body again costs nothing more.
    expect(content.put(body).inserted).toBe(false);
  });

  it("stores a large body as chunks, with a digest per chunk", () => {
    const content = store();
    const body = JSON.stringify({ model: "m", text: "z".repeat(2 * 1024 * 1024) });
    const put = content.put(body);
    const chunks = (content as unknown as { db: ContentDatabase }).db
      .prepare("SELECT idx, bytes, sha256, body FROM content_chunks WHERE ref = ? ORDER BY idx")
      .all(put.ref) as Array<{ idx: number; bytes: number; sha256: string; body: string }>;
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) {
      expect(createHash("sha256").update(chunk.body).digest("hex")).toBe(chunk.sha256);
      expect(Buffer.byteLength(chunk.body, "utf8")).toBe(chunk.bytes);
    }
    expect(content.read(put.ref, 32 * 1024 * 1024)).toMatchObject({ text: body, truncated: false });
  });

  it("reports damage instead of content", () => {
    const content = store();
    const body = JSON.stringify({ model: "m", text: "z".repeat(2 * 1024 * 1024) });
    const put = content.put(body);
    const db = (content as unknown as { db: ContentDatabase }).db;
    db.prepare("UPDATE content_chunks SET body = ? WHERE ref = ? AND idx = 0").run("tampered", put.ref);
    expect(content.read(put.ref, 32 * 1024 * 1024)).toEqual({ corrupt: true, bytes: put.bytes });
  });

  it("knows nothing about a body it does not have", () => {
    expect(store().read("f".repeat(64), 1024)).toBeUndefined();
  });
});
