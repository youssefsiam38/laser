/**
 * M13-T45 · what `inspect_agent` reads from a child's transcript: the live
 * branch only, assistant text only, newest last, excerpted — from a driver's
 * entries or from the session file of a child whose driver is gone.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { assistantMessagesOf, readSessionEntries } from "../../src/agents/inspect.js";

const message = (id: string, parentId: string | null, role: string, text: string, at = "2026-09-09T10:00:00.000Z") => ({
  type: "message",
  id,
  parentId,
  timestamp: at,
  message: { role, content: [{ type: "text", text }] },
});

describe("assistantMessagesOf", () => {
  const entries = [
    { type: "session", version: 3, id: "root" },
    message("u1", null, "user", "Do the thing."),
    message("a1", "u1", "assistant", "Starting."),
    { type: "message", id: "a2", parentId: "a1", timestamp: "2026-09-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
    { type: "message", id: "t1", parentId: "a2", message: { role: "toolResult", content: "ok" } },
    message("a3", "t1", "assistant", "Half way.", "2026-09-09T10:00:03.000Z"),
    // A branch the person navigated away from: not the conversation.
    message("a3b", "t1", "assistant", "Another take."),
    message("a4", "a3", "assistant", "Done.", "2026-09-09T10:00:04.000Z"),
  ];

  it("walks the live branch from the leaf, keeps assistant text only, and returns newest last", () => {
    expect(assistantMessagesOf(entries, "a4", 10)).toEqual([
      { at: "2026-09-09T10:00:00.000Z", text: "Starting." },
      { at: "2026-09-09T10:00:03.000Z", text: "Half way." },
      { at: "2026-09-09T10:00:04.000Z", text: "Done." },
    ]);
    expect(assistantMessagesOf(entries, "a4", 1)).toEqual([{ at: "2026-09-09T10:00:04.000Z", text: "Done." }]);
    // From the abandoned leaf, that branch is the conversation.
    expect(assistantMessagesOf(entries, "a3b", 2).map((m) => m.text)).toEqual(["Starting.", "Another take."]);
  });

  it("reads nothing from a reset leaf, a zero count, or entries it cannot follow", () => {
    expect(assistantMessagesOf(entries, null, 3)).toEqual([]);
    expect(assistantMessagesOf(entries, "a4", 0)).toEqual([]);
    expect(assistantMessagesOf(entries, "nope", 3)).toEqual([]);
    expect(assistantMessagesOf([null, 1, "x", { id: "loop", parentId: "loop", type: "message", message: { role: "assistant", content: "hi" } }], "loop", 3)).toEqual([{ text: "hi" }]);
  });

  it("excerpts each message rather than handing the parent a transcript", () => {
    const long = [message("a1", null, "assistant", "x".repeat(50))];
    expect(assistantMessagesOf(long, "a1", 1, 10)).toEqual([{ at: "2026-09-09T10:00:00.000Z", text: `${"x".repeat(9)}…` }]);
    expect(assistantMessagesOf([message("a1", null, "assistant", "   ")], "a1", 1)).toEqual([]);
  });
});

describe("readSessionEntries", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a session file as the engine would, with the last entry as the leaf, and survives a torn line", async () => {
    dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-inspect-`));
    const path = join(dir, "child.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s1" }),
      JSON.stringify(message("u1", null, "user", "Go.")),
      JSON.stringify(message("a1", "u1", "assistant", "Went.")),
      '{"type":"message","id":"a2","parentId":"a1","mess',
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);
    const read = await readSessionEntries(path);
    expect(read.entries).toHaveLength(3);
    expect(read.leafId).toBe("a1");
    expect(assistantMessagesOf(read.entries, read.leafId, 5)).toEqual([{ at: "2026-09-09T10:00:00.000Z", text: "Went." }]);
  });

  it("answers an empty conversation for a file that is not there", async () => {
    expect(await readSessionEntries("/nowhere/at/all.jsonl")).toEqual({ entries: [], leafId: null });
  });
});
