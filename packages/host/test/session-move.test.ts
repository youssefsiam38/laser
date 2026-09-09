/**
 * The file half of moving a session into a project (M13-T58): the engine's
 * session-directory rule, the flat-layout exception, and a rewrite that
 * changes the header's directory and the first agent record — and nothing
 * else — atomically.
 */
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destinationFor, rewriteSessionFile, sessionDirFor } from "../src/session-move.js";

let root: string;
beforeEach(() => (root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-session-move-`))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const record = (data: unknown) => JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data });
const message = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });

describe("sessionDirFor", () => {
  it("encodes the project directory the way the engine does", () => {
    expect(sessionDirFor("/data/agent/sessions", "/home/me/code/app")).toBe("/data/agent/sessions/--home-me-code-app--");
  });

  it("keeps a flat session directory flat, and moves between per-project directories otherwise", () => {
    expect(destinationFor(root, join(root, "a.jsonl"), "/home/me/app")).toBe(join(root, "a.jsonl"));
    expect(destinationFor(root, join(root, "--chat--", "a.jsonl"), "/home/me/app")).toBe(join(root, "--home-me-app--", "a.jsonl"));
  });
});

describe("rewriteSessionFile", () => {
  it("changes the header's cwd and the first agent record, keeps every other line byte for byte, and removes the old file", () => {
    const from = join(root, "--chat--", "s.jsonl");
    mkdirSync(join(root, "--chat--"), { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-09-01T00:00:00Z", cwd: "/state/workspaces/chat" }),
      record({ agentName: "chat", kind: "chat" }),
      message("user", `a message that mentions "customType":"${SESSION_AGENT_ENTRY_TYPE}" in its text`),
      message("assistant", "and the answer"),
      record({ agentName: "other", kind: "beam" }),
      "",
    ];
    writeFileSync(from, lines.join("\n"));
    const dest = destinationFor(root, from, "/home/me/app");
    rewriteSessionFile(from, dest, { cwd: "/home/me/app", agentName: "default" });

    expect(existsSync(from)).toBe(false);
    const written = readFileSync(dest, "utf8").split("\n");
    expect(JSON.parse(written[0]!)).toEqual({ type: "session", version: 3, id: "s", timestamp: "2026-09-01T00:00:00Z", cwd: "/home/me/app" });
    // Replaced in place, with no workspace kind; never appended after.
    expect(JSON.parse(written[1]!)).toEqual({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "root" } });
    expect(written[2]).toBe(lines[2]);
    expect(written[3]).toBe(lines[3]);
    // A later record is left as it was: every reader already ignores it.
    expect(written[4]).toBe(lines[4]);
    expect(written).toHaveLength(lines.length);
    // No temporary file left beside the destination.
    expect(readdirSync(join(root, "--home-me-app--"))).toEqual(["s.jsonl"]);
  });

  it("leaves a session without an agent record without one", () => {
    const from = join(root, "s.jsonl");
    writeFileSync(from, `${JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/old" })}\n${message("user", "hi")}\n`);
    rewriteSessionFile(from, from, { cwd: "/new", agentName: "default" });
    const written = readFileSync(from, "utf8").split("\n");
    expect(JSON.parse(written[0]!).cwd).toBe("/new");
    expect(written[1]).toBe(message("user", "hi"));
    expect(written).toHaveLength(3);
  });

  it("refuses a file that is not a session and touches nothing", () => {
    const from = join(root, "junk.jsonl");
    writeFileSync(from, `${JSON.stringify({ type: "message" })}\n`);
    const dest = join(root, "--p--", "junk.jsonl");
    expect(() => rewriteSessionFile(from, dest, { cwd: "/p", agentName: "default" })).toThrow(/not a session file/);
    expect(existsSync(from)).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });
});
