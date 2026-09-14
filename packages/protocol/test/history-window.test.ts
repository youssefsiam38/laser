import { describe, expect, it } from "vitest";
import { boundedHistoryWindow, fitHistoryWindowPlan, historyWindow, historyWindowNode, historyWindowPlan, parseClientRequest } from "../src/index.js";

const PATH = "/project/session.jsonl";
const scope = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  epoch: "worker-one",
  seq: 10,
  revision: "r1.AAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBB",
  environmentKey: "e1.CCCCCCCCCCCCCCCCCCCCCC",
};
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

  it("distinguishes a complete active branch from unloaded versions", () => {
    const entries = history(8);
    const sibling = { type: "message", id: "fork", parentId: "e1", message: { role: "user", content: "Other branch" } };
    const snapshot = { entries: [...entries, sibling], leafId: "e7" };
    expect(historyWindow(snapshot, { tail: 40 }, scope)).toMatchObject({ entries, window: { complete: true, branchesUnloaded: true } });
    expect(historyWindow(snapshot, { tail: 4 }, scope)).toMatchObject({ window: { complete: false, branchesUnloaded: true } });
    expect(historyWindow(snapshot, { all: true }, scope)).toMatchObject({ window: { complete: true, branchesUnloaded: false } });
    expect(historyWindow({ ...snapshot, leafId: null }, { tail: 40 }, scope)).toMatchObject({ entries: [], window: { complete: true, branchesUnloaded: true } });
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
    // A restart no longer invalidates a page: the cursor binds to the session
    // and its branch lineage, which is what actually decides whether the page
    // still exists. Another session, and an older cursor shape, are refused.
    expect(historyWindow({ entries, leafId: "e11" }, { before, limit: 4 }, { ...scope, epoch: "worker-two" }).entries).toEqual(entries.slice(4, 8));
    expect(() => historyWindow({ entries, leafId: "e11" }, { before }, { ...scope, sessionId: "another" })).toThrow("history changed");
    expect(() => historyWindow({ entries, leafId: "e11" }, { before: "bad" }, scope)).toThrow("history changed");
    const v1 = Buffer.from(JSON.stringify({ path: "/project/session.jsonl", epoch: "worker-one", leaf: "e11", before: "e8" }), "utf8").toString("base64url");
    expect(() => historyWindow({ entries, leafId: "e11" }, { before: v1 }, scope)).toThrow("history changed");
  });

  it("carries the revision and environment key, and keeps storage details out of a cursor", () => {
    const entries = history(12);
    const page = historyWindow({ entries, leafId: "e11" }, { tail: 4 }, scope);
    expect(page.window.revision).toBe(scope.revision);
    expect(page.window.environmentKey).toBe(scope.environmentKey);
    expect(() => JSON.parse(page.window.before!)).toThrow();
    const cursor = JSON.parse(Buffer.from(page.window.before!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(cursor).toEqual({ v: 2, s: scope.sessionId, l: "e11", b: "e8" });
    expect(Object.keys(cursor)).not.toContain("path");
    expect(Object.keys(cursor)).not.toContain("epoch");
    expect(page.window.before).not.toContain(".jsonl");
    expect(page.window.before).not.toContain(scope.epoch);
  });

  it("plans the same display rows without bodies and supports a strict-after delta boundary", () => {
    const entries = history(12);
    const snapshot = { entries, leafId: "e11" };
    const full = historyWindow(snapshot, { tail: 4 }, scope);
    const plan = historyWindowPlan(entries.map(historyWindowNode), snapshot.leafId, { tail: 4 }, scope);
    expect(plan.entryIndices.map(index => entries[index])).toEqual(full.entries);
    expect(plan.window).toEqual((({ context: _context, ...window }) => window)(full.window));

    const delta = historyWindow(snapshot, { tail: 4 }, { ...scope, authority: "live", selection: { kind: "delta", after: "e7" } });
    expect(delta.entries).toEqual(entries.slice(8));
    expect(delta.window).toMatchObject({ authority: "live", mode: "delta", anchor: "e8" });
    expect(delta.window.before).toBeTypeOf("string");
    expect(() => JSON.parse(delta.window.before!)).toThrow();
  });

  it("bounds tail pages with logarithmic complete-turn replans and refuses one unrepresentable turn", () => {
    const entries = history(400);
    const nodes = entries.map(historyWindowNode);
    let plans = 0;
    const fitted = fitHistoryWindowPlan(nodes, "e399", { tail: 200 }, { ...scope, selection: { kind: "replace" } }, plan => {
      plans++;
      return plan.entryIndices.length <= 40;
    });
    expect(fitted?.entryIndices).toEqual(entries.slice(-40).map((_, index) => 360 + index));
    expect(plans).toBeLessThanOrEqual(9);

    const huge = [
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "x".repeat(600_000) } },
      { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "y".repeat(600_000) } },
    ];
    expect(boundedHistoryWindow({ entries: huge, leafId: "a" }, { tail: 1 }, { ...scope, selection: { kind: "replace" } })).toBeUndefined();
  });

  it("round-trips every request variant, authority and base revision, and refuses invalid values", () => {
    for (const window of [{ tail: 40 }, { before: "cursor", limit: 40 }, { from: "entry" }, { all: true }]) {
      const request = { jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path: PATH, window, authority: "any", baseRevision: scope.revision } };
      expect(parseClientRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    }
    for (const params of [
      { path: PATH, window: { tail: 0 } },
      { path: PATH, window: { tail: 1000 } },
      { path: PATH, window: { tail: 40, all: true } },
      { path: PATH, authority: "durable" },
      { path: PATH, baseRevision: "" },
    ]) {
      expect(() => parseClientRequest({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params })).toThrow();
    }
  });
});
