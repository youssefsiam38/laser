/**
 * M21-T2: versioning, backups and the refusal to touch a newer database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_WORK_SCHEMA_VERSION } from "../../src/project-work/schema.js";
import { ProjectWorkUnavailableError } from "../../src/project-work/errors.js";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { person, specBody } from "./fixtures.js";

let base: string;
let file: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "project-work-migrate-"));
  file = join(base, "project-work.db");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("schema versioning", () => {
  it("creates the current version on a fresh database", () => {
    const store = new ProjectWorkStore({ file });
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
      expect(Object.values(row)[0]).toBe(PROJECT_WORK_SCHEMA_VERSION);
      db.close();
    } finally {
      store.close();
    }
  });

  it("refuses a database a newer version wrote, in words, and changes nothing", () => {
    const store = new ProjectWorkStore({ file });
    const projectId = store.projectIdFor(join(base, "alpha"))!;
    store.create({ projectId, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "one" });
    store.close();

    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${PROJECT_WORK_SCHEMA_VERSION + 5}`);
    raw.close();

    let refusal: unknown;
    try {
      new ProjectWorkStore({ file });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProjectWorkUnavailableError);
    expect((refusal as Error).message).toMatch(/newer version/);
    expect((refusal as Error).message).toMatch(/Nothing has been changed/);

    // The file is exactly as it was: same version, same row.
    const after = new DatabaseSync(file, { readOnly: true });
    const version = Object.values(after.prepare("PRAGMA user_version").get() as Record<string, unknown>)[0];
    expect(version).toBe(PROJECT_WORK_SCHEMA_VERSION + 5);
    const count = after.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
    expect(Number(count.n)).toBe(1);
    after.close();
  });

  it("copies a database that already holds work before it upgrades it", () => {
    // A file from before this schema: it has tables and no version.
    const older = new DatabaseSync(file);
    older.exec("CREATE TABLE legacy_notes (id TEXT PRIMARY KEY, text TEXT)");
    older.prepare("INSERT INTO legacy_notes (id, text) VALUES (?,?)").run("n1", "something a person wrote");
    older.exec("PRAGMA user_version = 0");
    older.close();

    const messages: string[] = [];
    const store = new ProjectWorkStore({ file, log: (message) => messages.push(message) });
    try {
      expect(existsSync(`${file}.v0.backup`)).toBe(true);
      expect(messages.join("\n")).toMatch(/copied the database/);
      // …and the upgrade itself happened.
      const projectId = store.projectIdFor(join(base, "alpha"))!;
      expect(store.create({ projectId, kind: "spec", title: "One", body: specBody(), origin: person, idempotencyKey: "one" }).entity.key).toBe("SPEC-1");
      // The backup still has what the file had before.
      const backup = new DatabaseSync(`${file}.v0.backup`, { readOnly: true });
      const row = backup.prepare("SELECT text FROM legacy_notes WHERE id = 'n1'").get() as { text: string };
      expect(row.text).toBe("something a person wrote");
      backup.close();
    } finally {
      store.close();
    }
  });

  it("leaves the version alone when a step cannot be applied", () => {
    // A table that collides with the one the first step creates: the step
    // throws, and the transaction takes the version bump back with it.
    const older = new DatabaseSync(file);
    older.exec("CREATE TABLE projects (placeholder TEXT)");
    older.exec("PRAGMA user_version = 0");
    older.close();

    expect(() => new ProjectWorkStore({ file })).toThrow();

    const after = new DatabaseSync(file, { readOnly: true });
    expect(Object.values(after.prepare("PRAGMA user_version").get() as Record<string, unknown>)[0]).toBe(0);
    const columns = after.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(["placeholder"]);
    after.close();
  });
});
