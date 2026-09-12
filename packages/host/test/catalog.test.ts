import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/catalog.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-catalog-`))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(slug: string, name: string, header: object, when: Date) {
  mkdirSync(join(dir, slug), { recursive: true });
  const path = join(dir, slug, name);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, ...header })}\n{"type":"message"}\n`);
  utimesSync(path, when, when);
  return path;
}

describe("SessionCatalog", () => {
  it("assembles a 16 MiB line once and preserves split UTF-8 and partial writes", () => {
    const path = join(dir, "large.jsonl");
    const header = JSON.stringify({ type: "session", id: "large", cwd: "/project" }) + "\n";
    const prefix = '{"type":"message","message":{"role":"user","content":"';
    const text = "x".repeat(256 * 1024 - Buffer.byteLength(prefix) - 1) + "é" + "y".repeat(16 * 1024 * 1024);
    const line = prefix + text + '"}}';
    writeFileSync(path, header + line);
    const catalog = new SessionCatalog(dir);
    expect(catalog.get(path)?.messageCount).toBe(0);
    appendFileSync(path, '\n{"type":"session_info","name":"finished é"}\n');
    let copied = 0;
    const concat = Buffer.concat;
    const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
      copied += list.reduce((sum, b) => sum + b.length, 0);
      return concat(list, length);
    });
    try {
      expect(catalog.get(path)).toMatchObject({ messageCount: 1, name: "finished é", firstMessage: "x".repeat(199) + "…" });
      expect(copied).toBeLessThan(Buffer.byteLength(line) * 2);
    } finally { spy.mockRestore(); }
    // Same-size rewrite is not an append and must restart the scan.
    writeFileSync(path, header + line.replace('"user"', '"xxxx"') + '\n{"type":"session_info","name":"finished é"}\n');
    utimesSync(path, new Date("2030-01-01"), new Date("2030-01-01"));
    expect(catalog.get(path)?.messageCount).toBe(0);
  });
  it("attributes a session to its agent from the record the worker wrote, and a worktree to its project", () => {
    const child = session("--worktree--", "child.jsonl", { id: "child", cwd: "/project/.worktrees/review-auth" }, new Date("2026-01-03"));
    const catalog = new SessionCatalog(dir);
    expect(catalog.get(child)).toMatchObject({ cwd: "/project" });
    expect(catalog.get(child)?.agent).toBeUndefined();
    appendFileSync(
      child,
      JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "reviewer", kind: "child", subagentName: "review-auth", parentPath: "/sessions/root.jsonl", rootPath: "/sessions/root.jsonl", runId: "run_7", worktree: { path: "/project/.worktrees/review-auth", branch: "agent/review-auth", baseCommit: "abc" } } }) + "\n" +
        JSON.stringify({ type: "message", message: { role: "user", content: "Review the auth changes" } }) + "\n",
    );
    utimesSync(child, new Date("2026-01-04"), new Date("2026-01-04"));
    const entry = catalog.get(child)!;
    // The run id and status are the registry's, added by the router; the file gives identity only.
    expect(entry.agent).toEqual({ agentName: "reviewer", kind: "child", subagentName: "review-auth", parentPath: "/sessions/root.jsonl", rootPath: "/sessions/root.jsonl" });
    expect(entry).toMatchObject({ cwd: "/project", firstMessage: "Review the auth changes", messageCount: 1 });
    expect(catalog.list("/project").map((s) => s.id)).toEqual(["child"]);
    expect(catalog.cwdCounts().get("/project")).toBe(1);

    const beam = session("--beam--", "beam.jsonl", { id: "beam", cwd: "/data/beam" }, new Date("2026-01-05"));
    appendFileSync(beam, JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "beam", kind: "beam" } }) + "\n");
    utimesSync(beam, new Date("2026-01-06"), new Date("2026-01-06"));
    expect(catalog.get(beam)?.agent).toEqual({ agentName: "beam", kind: "beam" });
    appendFileSync(beam, JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "other", kind: "chat" } }) + "\n");
    utimesSync(beam, new Date("2026-01-07"), new Date("2026-01-07"));
    expect(catalog.get(beam)?.agent?.agentName).toBe("beam"); // the first record wins
  });

  it("uses the objective for a goal-started session without exposing its internal prompt", () => {
    const path = session("--goal--", "goal.jsonl", { id: "goal", cwd: "/project" }, new Date("2026-01-01"));
    const catalog = new SessionCatalog(dir);
    appendFileSync(path, JSON.stringify({ type: "custom", customType: "goal-state", data: { goal: { id: "guard", text: 'Compare "root Compose"  with CI' } } }) + "\n");
    expect(catalog.get(path)?.firstMessage).toBeUndefined();
    appendFileSync(path, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Internal instructions\n<goal_id>guard</goal_id>\n<!-- pi-goal-prompt:n -->" }] } }) + "\n");
    expect(catalog.get(path)?.firstMessage).toBe('Compare "root Compose" with CI');
  });
  it("lists sessions across projects newest first and resolves cwd from the header", () => {
    const a = session("--home-a--", "1_a.jsonl", { id: "a", cwd: "/home/a", timestamp: "2026-01-01T00:00:00Z" }, new Date("2026-01-01"));
    const b = session("--home-b--", "2_b.jsonl", { id: "b", cwd: "/home/b", timestamp: "2026-02-01T00:00:00Z", parentSession: a }, new Date("2026-02-01"));
    writeFileSync(join(dir, "--home-b--", "junk.jsonl"), "not json\n");
    writeFileSync(join(dir, "--home-b--", "empty.jsonl"), "");

    const catalog = new SessionCatalog(dir);
    const all = catalog.list();
    expect(all.map((s) => s.id)).toEqual(["b", "a"]);
    // A fork records where it came from and is not nested under it.
    expect(all[0]).toMatchObject({ path: b, cwd: "/home/b", forkedFrom: a });
    expect(all[0]!.parentPath).toBeUndefined();
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
