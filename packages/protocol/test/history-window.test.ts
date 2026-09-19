import { describe, expect, it } from "vitest";
import {
  HISTORY_EARLIER_PAGE_TURNS,
  HISTORY_FIRST_PAGE_TURNS,
  HISTORY_PAGE_BYTE_LIMIT,
  HISTORY_PAGE_ENTRY_LIMIT,
  HISTORY_PAGE_TURN_MAX,
  boundedHistoryWindow,
  fitHistoryWindowPlan,
  historyContentSerializedBytes,
  historyWindow,
  historyWindowNode,
  historyWindowPlan,
  isLiveEdgeWindow,
  parseClientRequest,
  windowTurns,
} from "../src/index.js";

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
    for (const window of [
      { tail: 40 }, { before: "cursor", limit: 40 }, { beforeEntry: "entry", limit: 40 }, { from: "entry" }, { all: true },
      // Turn windows (M16-T90), additive beside the entry-counted ones.
      { turns: HISTORY_FIRST_PAGE_TURNS }, { before: "cursor", turns: HISTORY_EARLIER_PAGE_TURNS }, { beforeEntry: "entry", turns: HISTORY_EARLIER_PAGE_TURNS },
    ]) {
      const request = { jsonrpc: "2.0", id: 1, method: "pi/session/entries", params: { path: PATH, window, authority: "any", baseRevision: scope.revision } };
      expect(parseClientRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    }
    for (const params of [
      { path: PATH, window: { tail: 0 } },
      { path: PATH, window: { tail: 1000 } },
      { path: PATH, window: { tail: 40, all: true } },
      { path: PATH, window: { before: "cursor" } },
      { path: PATH, window: { beforeEntry: "entry" } },
      { path: PATH, window: { beforeEntry: "entry", before: "cursor" }, baseRevision: scope.revision },
      { path: PATH, window: { beforeEntry: "" }, baseRevision: scope.revision },
      { path: PATH, authority: "durable" },
      { path: PATH, baseRevision: "" },
      // A turn count is a positive integer no larger than the raw-entry ceiling,
      // it is never mixed with an entry count, and an older turn page still
      // needs the revision the caller already holds.
      { path: PATH, window: { turns: 0 } },
      { path: PATH, window: { turns: HISTORY_PAGE_TURN_MAX + 1 } },
      { path: PATH, window: { turns: 2.5 } },
      { path: PATH, window: { turns: 10, tail: 10 } },
      { path: PATH, window: { turns: 10, limit: 10 } },
      { path: PATH, window: { before: "cursor", turns: 20 } },
      { path: PATH, window: { beforeEntry: "entry", turns: 20 } },
    ]) {
      expect(() => parseClientRequest({ jsonrpc: "2.0", id: 1, method: "pi/session/entries", params })).toThrow();
    }
  });
});

/**
 * M16-T90: a page is a number of **turns**, not a number of bytes.
 *
 * A turn is anchored by a user message on the rendered branch; everything after
 * it up to the next user message rides along. The first page is the last ten
 * turns, each "load earlier" is twenty more, the cursor is the identity of the
 * oldest row the page carries, and "is there more" is answered by the branch
 * rather than by a byte budget. The byte and row ceilings stay as nets: they may
 * shrink a page, never refuse one.
 */
describe("a page is a number of turns", () => {
  const replace = { ...scope, selection: { kind: "replace" as const } };
  const ids = (page: { entries: unknown[] }): string[] => page.entries.map(entry => (entry as { id: string }).id);
  const users = (page: { entries: unknown[] }): string[] =>
    page.entries.filter(entry => (entry as { message?: { role?: string } }).message?.role === "user").map(entry => (entry as { id: string }).id);

  /**
   * `count` turns of four rows each: a prompt, a reply that calls a tool, the
   * tool's result, and a closing reply. Only the prompt anchors a turn.
   */
  function turns(count: number, options: { reply?: string } = {}): unknown[] {
    const entries: unknown[] = [];
    let parent: string | null = null;
    const push = (id: string, value: Record<string, unknown>): void => {
      entries.push({ type: "message", id, parentId: parent, ...value });
      parent = id;
    };
    for (let turn = 0; turn < count; turn++) {
      push(`u${turn}`, { message: { role: "user", content: [{ type: "text", text: `Prompt ${turn}` }] } });
      push(`a${turn}`, { message: { role: "assistant", content: [{ type: "toolCall", id: `c${turn}`, name: "read", arguments: {} }] } });
      push(`r${turn}`, { message: { role: "toolResult", toolCallId: `c${turn}`, content: [{ type: "text", text: "Output" }] } });
      push(`z${turn}`, { message: { role: "assistant", content: [{ type: "text", text: options.reply ?? `Reply ${turn}` }] } });
    }
    return entries;
  }

  it("carries exactly ten user turns, with everything that rode along in them", () => {
    const entries = turns(200);
    const snapshot = { entries, leafId: "z199" };
    const page = historyWindow(snapshot, { turns: HISTORY_FIRST_PAGE_TURNS }, replace);
    expect(users(page)).toEqual(Array.from({ length: 10 }, (_, index) => `u${190 + index}`));
    // Four rows a turn: the prompt and the three rows that rode along with it.
    expect(page.entries).toEqual(entries.slice(-40));
    expect(ids(page)[0]).toBe("u190");
    expect(page.window).toMatchObject({ anchor: "u190", complete: false, userOffset: 190 });
    // The cursor is the identity of the oldest row the page carries, and its
    // presence is the answer to "is there more".
    expect(page.window.before).toBeTypeOf("string");
  });

  it("loads twenty more turns that start exactly where the last page ended", () => {
    const entries = turns(200);
    const snapshot = { entries, leafId: "z199" };
    const first = historyWindow(snapshot, { turns: HISTORY_FIRST_PAGE_TURNS }, replace);
    const earlier = historyWindow(snapshot, { before: first.window.before!, turns: HISTORY_EARLIER_PAGE_TURNS }, replace);
    expect(users(earlier)).toHaveLength(20);
    expect(earlier.entries).toEqual(entries.slice(-120, -40));
    // No gap and no duplicate across the seam.
    expect([...ids(earlier), ...ids(first)]).toEqual(entries.slice(-120).map(entry => (entry as { id: string }).id));
    // The same page is recoverable by the row it ends before (D-302's path).
    const anchored = historyWindow(snapshot, { beforeEntry: "u190", turns: HISTORY_EARLIER_PAGE_TURNS }, replace);
    expect(anchored.entries).toEqual(earlier.entries);
    expect(anchored.window.before).toBe(earlier.window.before);
  });

  it("reaches the root in bounded pages, once, in order, and only then says there is no more", () => {
    const entries = turns(200);
    const snapshot = { entries, leafId: "z199" };
    const seen: string[] = [];
    let page = historyWindow(snapshot, { turns: HISTORY_FIRST_PAGE_TURNS }, replace);
    let pages = 1;
    for (; page.window.before && pages < 100; pages++) {
      seen.unshift(...ids(page));
      page = historyWindow(snapshot, { before: page.window.before, turns: HISTORY_EARLIER_PAGE_TURNS }, replace);
    }
    seen.unshift(...ids(page));
    // Ten turns, then twenty at a time: 1 + ceil(190 / 20) pages.
    expect(pages).toBe(11);
    expect(seen).toEqual(entries.map(entry => (entry as { id: string }).id));
    // False exactly at the root, and there the window is complete.
    expect(page.window.before).toBeUndefined();
    expect(page.window).toMatchObject({ complete: false, userOffset: 0, anchor: "u0" });
    expect(historyWindow(snapshot, { turns: 200 }, replace).window).toMatchObject({ complete: true });
    expect(historyWindow(snapshot, { turns: 200 }, replace).window.before).toBeUndefined();
  });

  it("does not let a compaction, a goal record or a reply anchor a turn", () => {
    const entries = [
      { type: "message", id: "u0", parentId: null, message: { role: "user", content: "First" } },
      { type: "message", id: "a0", parentId: "u0", message: { role: "assistant", content: "Working" } },
      { type: "compaction", id: "compact", parentId: "a0", summary: "Earlier context" },
      { type: "custom", id: "goal", parentId: "compact", customType: "goal-state", data: { goal: { id: "g1" } } },
      { type: "message", id: "u1", parentId: "goal", message: { role: "user", content: "Second" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "Done" } },
    ];
    const snapshot = { entries, leafId: "a1" };
    // One turn is the last prompt and its reply. Neither the compaction nor the
    // goal record anchors a turn; both ride into the page ahead of the prompt
    // they precede, exactly as an attribution marker does for an entry window.
    const one = historyWindow(snapshot, { turns: 1 }, replace);
    expect(ids(one)).toEqual(["compact", "goal", "u1", "a1"]);
    expect(users(one)).toEqual(["u1"]);
    const two = historyWindow(snapshot, { turns: 2 }, replace);
    expect(ids(two)).toEqual(entries.map(entry => (entry as { id: string }).id));
    expect(two.window.before).toBeUndefined();
    // A branch whose newest rows are not messages still pages from its prompt.
    const trailing = { entries: [...entries, { type: "compaction", id: "compact2", parentId: "a1", summary: "Later" }], leafId: "compact2" };
    expect(users(historyWindow(trailing, { turns: 1 }, replace))).toEqual(["u1"]);
    expect(ids(historyWindow(trailing, { turns: 1 }, replace)).at(-1)).toBe("compact2");
  });

  it("bounds one page by rows when a turn drags in five hundred tool steps, and still pages through it", () => {
    const entries: unknown[] = [
      { type: "message", id: "u0", parentId: null, message: { role: "user", content: "Earlier" } },
      { type: "message", id: "z0", parentId: "u0", message: { role: "assistant", content: "Done" } },
      { type: "message", id: "u1", parentId: "z0", message: { role: "user", content: "Run the fleet" } },
    ];
    let parent = "u1";
    for (let step = 0; step < 250; step++) {
      entries.push({ type: "message", id: `a${step}`, parentId: parent, message: { role: "assistant", content: [{ type: "toolCall", id: `c${step}`, name: "bash", arguments: {} }] } });
      entries.push({ type: "message", id: `r${step}`, parentId: `a${step}`, message: { role: "toolResult", toolCallId: `c${step}`, content: [{ type: "text", text: "x".repeat(1_000) }] } });
      parent = `r${step}`;
    }
    const snapshot = { entries, leafId: parent };
    let page = boundedHistoryWindow(snapshot, { turns: HISTORY_FIRST_PAGE_TURNS }, replace);
    expect(page).toBeDefined();
    const seen: string[] = [];
    let pages = 0;
    for (; page && pages < 50; pages++) {
      const rows = ids(page);
      expect(rows.length).toBeGreaterThan(0);
      // The raw-entry ceiling bounds the page whatever the turn dragged in.
      expect(rows.length).toBeLessThanOrEqual(HISTORY_PAGE_ENTRY_LIMIT);
      // A page never begins with a tool result orphaned from its call.
      expect((page.entries[0] as { message?: { role?: string } }).message?.role).not.toBe("toolResult");
      seen.unshift(...rows);
      if (!page.window.before) break;
      page = boundedHistoryWindow(snapshot, { before: page.window.before, turns: HISTORY_EARLIER_PAGE_TURNS }, replace);
      expect(page).toBeDefined();
    }
    expect(seen).toEqual(entries.map(entry => (entry as { id: string }).id));
    expect(pages).toBeGreaterThan(1);
  });

  it("lets the byte ceiling shrink a turn page and never refuse one", () => {
    // Ten turns whose replies are 400 KB each: three turns already exceed the
    // page, and every record travels whole (no per-body limit is asked for).
    const entries = turns(10, { reply: "y".repeat(400_000) });
    const snapshot = { entries, leafId: "z9" };
    const page = boundedHistoryWindow(snapshot, { turns: HISTORY_FIRST_PAGE_TURNS }, replace);
    expect(page).toBeDefined();
    expect(users(page!).length).toBeLessThan(10);
    expect(users(page!).length).toBeGreaterThan(0);
    expect(historyContentSerializedBytes(page!.entries, page!.window.context)).toBeLessThanOrEqual(HISTORY_PAGE_BYTE_LIMIT);
    // And the pages behind it still reach the root, twenty turns at a time.
    let walked = page!;
    const seen = [...ids(walked)];
    for (let guard = 0; walked.window.before && guard < 50; guard++) {
      walked = boundedHistoryWindow(snapshot, { before: walked.window.before, turns: HISTORY_EARLIER_PAGE_TURNS }, replace)!;
      expect(walked).toBeDefined();
      seen.unshift(...ids(walked));
    }
    expect(seen).toEqual(entries.map(entry => (entry as { id: string }).id));
  });

  it("answers a newest-page turn read with a proved append delta, exactly as a tail read", () => {
    const entries = turns(4);
    const snapshot = { entries, leafId: "z3" };
    expect(isLiveEdgeWindow({ turns: 10 })).toBe(true);
    expect(isLiveEdgeWindow({ tail: 40 })).toBe(true);
    for (const window of [{ before: "cursor", turns: 20 }, { beforeEntry: "u1", turns: 20 }, { from: "u1" }, { all: true }] as const) {
      expect(isLiveEdgeWindow(window)).toBe(false);
    }
    const delta = historyWindow(snapshot, { turns: HISTORY_FIRST_PAGE_TURNS }, { ...scope, authority: "live", selection: { kind: "delta", after: "z2" } });
    expect(ids(delta)).toEqual(["u3", "a3", "r3", "z3"]);
    expect(delta.window).toMatchObject({ mode: "delta", authority: "live" });
  });

  it("refuses a turn count the wire contract already rejects, rather than answering a different question", () => {
    const entries = turns(4);
    const snapshot = { entries, leafId: "z3" };
    // The schema owns `1..HISTORY_PAGE_TURN_MAX`. An internal caller outside it
    // is a defect here; answering it as "forty entries" would hide one.
    for (const count of [0, -1, 2.5, HISTORY_PAGE_TURN_MAX + 1]) {
      expect(() => windowTurns({ turns: count })).toThrow(/turns/);
      expect(() => historyWindow(snapshot, { turns: count }, replace)).toThrow(/turns/);
    }
    expect(windowTurns({ turns: 1 })).toBe(1);
    expect(windowTurns({ tail: 40 })).toBeUndefined();
    expect(windowTurns({ before: "cursor", limit: 40 })).toBeUndefined();
  });

  it("leaves entry-counted windows exactly as they were", () => {
    const entries = turns(50);
    const snapshot = { entries, leafId: "z49" };
    // Messages, not turns: forty rows, cut at the turn boundary above them.
    const tail = historyWindow(snapshot, { tail: 40 }, replace);
    expect(tail.entries).toEqual(entries.slice(-40));
    expect(users(tail)).toHaveLength(10);
    const older = historyWindow(snapshot, { before: tail.window.before!, limit: 8 }, replace);
    expect(older.entries).toEqual(entries.slice(-48, -40));
    expect(historyWindow(snapshot, { all: true }, replace).entries).toEqual(entries);
  });
});
