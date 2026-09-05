import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  it("fills name, first message and message count, and continues the scan as the file grows", () => {
    const path = join(dir, "--home-c--", "1_c.jsonl");
    mkdirSync(join(dir, "--home-c--"), { recursive: true });
    const message = (role: string, text: string) =>
      `${JSON.stringify({ type: "message", id: role + text.length, message: { role, content: [{ type: "text", text }] } })}\n`;
    writeFileSync(
      path,
      `${JSON.stringify({ type: "session", version: 3, id: "c", cwd: "/home/c" })}\n` +
        message("user", "  Fix the flaky   test\nplease ") +
        message("assistant", "On it") +
        // A tool result is not a message a person counts.
        `${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t1", content: "ok" } })}\n`,
    );
    utimesSync(path, new Date("2026-04-01"), new Date("2026-04-01"));

    const catalog = new SessionCatalog(dir);
    const first = catalog.list("/home/c")[0]!;
    expect(first).toMatchObject({ messageCount: 2, firstMessage: "Fix the flaky test please" });
    expect(first.name).toBeUndefined();

    // Append a rename and another exchange; the scan resumes from where it stopped.
    appendFileSync(
      path,
      `${JSON.stringify({ type: "session_info", name: "Flaky test" })}\n` +
        message("user", "…and the ünicode päth") +
        message("assistant", "done"),
    );
    utimesSync(path, new Date("2026-04-02"), new Date("2026-04-02"));
    const second = catalog.list("/home/c")[0]!;
    expect(second).toMatchObject({ name: "Flaky test", messageCount: 4, firstMessage: "Fix the flaky test please" });
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
