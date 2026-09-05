import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/catalog.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "piorbit-catalog-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(slug: string, name: string, header: object, when: Date) {
  mkdirSync(join(dir, slug), { recursive: true });
  const path = join(dir, slug, name);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, ...header })}\n{"type":"message"}\n`);
  utimesSync(path, when, when);
  return path;
}

describe("SessionCatalog", () => {
  it("lists sessions across projects newest first and resolves cwd from the header", () => {
    const a = session("--home-a--", "1_a.jsonl", { id: "a", cwd: "/home/a", timestamp: "2026-01-01T00:00:00Z" }, new Date("2026-01-01"));
    const b = session("--home-b--", "2_b.jsonl", { id: "b", cwd: "/home/b", timestamp: "2026-02-01T00:00:00Z", parentSession: a }, new Date("2026-02-01"));
    writeFileSync(join(dir, "--home-b--", "junk.jsonl"), "not json\n");
    writeFileSync(join(dir, "--home-b--", "empty.jsonl"), "");

    const catalog = new SessionCatalog(dir);
    const all = catalog.list();
    expect(all.map((s) => s.id)).toEqual(["b", "a"]);
    expect(all[0]).toMatchObject({ path: b, cwd: "/home/b", parentPath: a });
    expect(catalog.list("/home/a").map((s) => s.id)).toEqual(["a"]);
    expect(catalog.cwdOf(b)).toBe("/home/b");
    expect(catalog.cwdOf(join(dir, "nope.jsonl"))).toBeUndefined();
  });

  it("also scans the flat layout Pi uses for an explicit session dir", () => {
    const flat = join(dir, "flat_s.jsonl");
    writeFileSync(flat, `${JSON.stringify({ type: "session", version: 3, id: "flat", cwd: "/f" })}\n`);
    session("--nested--", "n.jsonl", { id: "nested", cwd: "/n" }, new Date("2026-01-01"));
    const ids = new SessionCatalog(dir).list().map((s) => s.id).sort();
    expect(ids).toEqual(["flat", "nested"]);
  });

  it("returns nothing for a missing directory and re-reads when a file changes", () => {
    expect(new SessionCatalog(join(dir, "missing")).list()).toEqual([]);
    const p = session("--x--", "s.jsonl", { id: "x1", cwd: "/x" }, new Date("2026-03-01"));
    const catalog = new SessionCatalog(dir);
    expect(catalog.list()[0]?.id).toBe("x1");
    writeFileSync(p, `${JSON.stringify({ type: "session", version: 3, id: "x2", cwd: "/x" })}\n`);
    utimesSync(p, new Date("2026-03-02"), new Date("2026-03-02"));
    expect(catalog.list()[0]?.id).toBe("x2");
  });
});
