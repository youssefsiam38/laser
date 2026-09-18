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
    const anchored = historyWindow(snapshot, { beforeEntry: "e1960", limit: 40 }, scope);
    expect(anchored.entries).toEqual(older.entries);
    expect(anchored.window.before).toBe(older.window.before);
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
    expect(historyWindow({ entries: history(14), leafId: "e13" }, { beforeEntry: "e8", limit: 4 }, scope).entries).toEqual(entries.slice(4, 8));
    expect(() => historyWindow({ entries, leafId: "e7" }, { before }, scope)).toThrow("history changed");
    expect(() => historyWindow({ entries, leafId: "e7" }, { beforeEntry: "e8" }, scope)).toThrow("history changed");
    expect(() => historyWindow({ entries, leafId: "e11" }, { beforeEntry: "missing" }, scope)).toThrow("history changed");
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

  it("bounds tail pages with logarithmic complete-turn replans and refuses one unrepresentable record", () => {
    const entries = history(400);
    const nodes = entries.map(historyWindowNode);
    let plans = 0;
    const fitted = fitHistoryWindowPlan(nodes, "e399", { tail: 200 }, { ...scope, selection: { kind: "replace" } }, plan => {
      plans++;
      return plan.entryIndices.length <= 40;
    });
    expect(fitted?.entryIndices).toEqual(entries.slice(-40).map((_, index) => 360 + index));
    expect(plans).toBeLessThanOrEqual(9);

    plans = 0;
    const recovered = fitHistoryWindowPlan(nodes, "e399", { beforeEntry: "e360", limit: 200 }, { ...scope, selection: { kind: "replace" } }, plan => {
      plans++;
      return plan.entryIndices.length <= 40;
    });
    expect(recovered?.entryIndices).toEqual(entries.slice(320, 360).map((_, index) => 320 + index));
    expect(recovered?.window.before).toBeTypeOf("string");
    expect(plans).toBeLessThanOrEqual(9);

    const huge = [
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "x".repeat(600_000) } },
      { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "y".repeat(1_200_000) } },
    ];
    expect(boundedHistoryWindow({ entries: huge, leafId: "a" }, { tail: 1 }, { ...scope, selection: { kind: "replace" } })).toBeUndefined();
  });

  // 0.7.x: a long agent run is one turn of hundreds of tool steps. Refusing
  // any page that could not hold the whole turn left such conversations
  // unopenable ("cannot be transferred without splitting a complete turn").
  it("pages inside a turn no page can hold, never separating a tool result from its call", () => {
    const entries: unknown[] = [
      { type: "message", id: "u0", parentId: null, message: { role: "user", content: "Earlier" } },
      { type: "message", id: "a0", parentId: "u0", message: { role: "assistant", content: "Done" } },
      { type: "message", id: "u1", parentId: "a0", message: { role: "user", content: "Run the fleet" } },
    ];
    let parent = "u1";
    for (let step = 0; step < 400; step++) {
      entries.push({ type: "message", id: `a${step + 1}`, parentId: parent, message: { role: "assistant", content: [{ type: "toolCall", id: `c${step}a` }, { type: "toolCall", id: `c${step}b` }] } });
      entries.push({ type: "message", id: `r${step}a`, parentId: `a${step + 1}`, message: { role: "toolResult", toolCallId: `c${step}a`, content: "x".repeat(2_000) } });
      entries.push({ type: "message", id: `r${step}b`, parentId: `r${step}a`, message: { role: "toolResult", toolCallId: `c${step}b`, content: "y".repeat(2_000) } });
      parent = `r${step}b`;
    }
    const snapshot = { entries, leafId: parent };
    const replace = { ...scope, selection: { kind: "replace" as const } };
    const ids = (page: { entries: unknown[] }) => page.entries.map(entry => (entry as { id: string }).id);

    let page = boundedHistoryWindow(snapshot, { tail: 40 }, replace);
    expect(page).toBeDefined();
    const seen: string[] = [];
    for (let guard = 0; page && guard < 100; guard++) {
      const rows = ids(page);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(200);
      expect((page.entries[0] as { message: { role: string } }).message.role).not.toBe("toolResult");
      seen.unshift(...rows);
      if (!page.window.before) break;
      page = boundedHistoryWindow(snapshot, { before: page.window.before }, replace);
      expect(page).toBeDefined();
    }
    // Every row of the branch, once, in order.
    expect(seen).toEqual(entries.map(entry => (entry as { id: string }).id));

    // Goal context before the page is bounded by bytes, not by the page's row
    // limit: a goal that flips between states hundreds of times still pages.
    const flips: unknown[] = [];
    let prior: string | null = null;
    for (let index = 0; index < 600; index++) {
      const id = `g${index}`;
      flips.push({ type: "custom", customType: "goal-state", id, parentId: prior, data: { goal: { id: "goal", text: "Ship", status: index % 2 ? "active" : "paused", startedAt: 1, updatedAt: index } } });
      flips.push({ type: "message", id: `m${index}`, parentId: id, message: { role: "assistant", content: "Working" } });
      prior = `m${index}`;
    }
    flips.push({ type: "message", id: "last-u", parentId: prior, message: { role: "user", content: "Now" } });
    const flipped = boundedHistoryWindow({ entries: flips, leafId: "last-u" }, { tail: 40 }, replace);
    expect(flipped?.window.context).toHaveLength(600);
    expect(ids(flipped!)).toEqual(["last-u"]);

    // Turns that fit keep their complete-turn boundary.
    const small = boundedHistoryWindow({ entries: entries.slice(0, 5), leafId: "r0a" }, { tail: 1 }, replace);
    expect(ids(small!)).toEqual(["u1", "a1", "r0a"]);
  });

  it("round-trips every request variant, authority and base revision, and refuses invalid values", () => {
    for (const window of [{ tail: 40 }, { before: "cursor", limit: 40 }, { beforeEntry: "entry", limit: 40 }, { from: "entry" }, { all: true }]) {
      const request = { jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path: PATH, window, authority: "any", baseRevision: scope.revision } };
      expect(parseClientRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    }
    for (const params of [
      { path: PATH, window: { tail: 0 } },
      { path: PATH, window: { tail: 1000 } },
      { path: PATH, window: { tail: 40, all: true } },
      { path: PATH, window: { beforeEntry: "entry", before: "cursor" } },
      { path: PATH, window: { beforeEntry: "" } },
      { path: PATH, authority: "durable" },
      { path: PATH, baseRevision: "" },
    ]) {
      expect(() => parseClientRequest({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params })).toThrow();
    }
  });
});
