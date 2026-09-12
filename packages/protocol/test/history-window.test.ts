import { describe, expect, it } from "vitest";
import { historyWindow, parseClientRequest } from "../src/index.js";

const scope = { path: "/project/session.jsonl", epoch: "worker-one", seq: 10 };
function history(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }] } }));
}

describe("history windows", () => {
  it("returns the tail without transferring earlier message/image bodies, then walks complete turns backwards", () => {
    const entries = history(2000);
    (entries[0] as any).message.content.push({ type: "image", data: "large-old-image" });
    const snapshot = { entries, leafId: "e1999" };
    const tail = historyWindow(snapshot, { tail: 40 }, scope);
    expect(tail.entries).toEqual(entries.slice(-40));
    expect(JSON.stringify(tail)).not.toContain("large-old-image");
    expect(tail.window).toMatchObject({ userOffset: 980, complete: false, anchor: "e1960" });
    const older = historyWindow(snapshot, { before: tail.window.before! }, scope);
    expect(older.entries).toEqual(entries.slice(1920, 1960));
    expect(older.window.userOffset).toBe(960);
    expect(historyWindow(snapshot, { from: older.window.anchor! }, scope).entries).toEqual(entries.slice(1920));
    expect(historyWindow(snapshot, { all: true }, scope)).toMatchObject({ entries, window: { complete: true, userOffset: 0 } });
  });

  it("follows the active leaf rather than append order, and does not call a partial tree complete", () => {
    const entries = history(8);
    const sibling = { type: "message", id: "fork", parentId: "e1", message: { role: "user", content: "Other branch" } };
    const snapshot = { entries: [...entries, sibling], leafId: "e7" };
    expect(historyWindow(snapshot, { tail: 40 }, scope)).toMatchObject({ entries, window: { complete: false } });
    expect(historyWindow({ ...snapshot, leafId: null }, { tail: 40 }, scope).entries).toEqual([]);
  });

  it("retains tool calls, results, attribution markers and goal context without exposing an earlier prompt body", () => {
    const entries = [
      { type: "custom", id: "goal", parentId: null, customType: "goal-state", data: { goal: { id: "known" } } },
      { type: "message", id: "old", parentId: "goal", message: { role: "user", content: "Earlier objective" } },
      { type: "custom", id: "marker", parentId: "old", customType: "attribution", data: {} },
      { type: "message", id: "u", parentId: "marker", message: { role: "user", content: "Current prompt" } },
      { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } },
      { type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "call", content: "Output" } },
    ];
    const page = historyWindow({ entries, leafId: "r" }, { tail: 1 }, scope);
    expect(page.entries).toEqual(entries.slice(2));
    expect(page.window.context).toEqual(entries.slice(0, 1));
    expect(page.window.userOffset).toBe(1);
    expect(JSON.stringify(page)).not.toContain("Earlier objective");
  });

  it("permits append-only growth but rejects changed branches, restarts, cross-session and malformed cursors", () => {
    const entries = history(12);
    const before = historyWindow({ entries, leafId: "e11" }, { tail: 4 }, scope).window.before!;
    expect(historyWindow({ entries: history(14), leafId: "e13" }, { before, limit: 4 }, scope).entries).toEqual(entries.slice(4, 8));
    expect(() => historyWindow({ entries, leafId: "e7" }, { before }, scope)).toThrow("history changed");
    expect(() => historyWindow({ entries, leafId: "e11" }, { before }, { ...scope, epoch: "worker-two" })).toThrow("history changed");
    expect(() => historyWindow({ entries, leafId: "e11" }, { before }, { ...scope, path: "/another" })).toThrow("history changed");
    expect(() => historyWindow({ entries, leafId: "e11" }, { before: "bad" }, scope)).toThrow("history changed");
  });

  it("round-trips every request variant and refuses ambiguous or unbounded initial windows", () => {
    for (const window of [{ tail: 40 }, { before: "cursor", limit: 40 }, { from: "entry" }, { all: true }]) {
      const request = { jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path: scope.path, window } };
      expect(parseClientRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    }
    for (const window of [{ tail: 0 }, { tail: 1000 }, { tail: 40, all: true }]) {
      expect(() => parseClientRequest({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path: scope.path, window } })).toThrow();
    }
  });
});
