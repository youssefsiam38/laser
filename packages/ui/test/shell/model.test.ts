import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import type { AgentRun, SessionState, SessionSummary } from "@lasercode/protocol";

import {
  backgroundUsageSources,
  documentTitle,
  historyRows,
  inboxRows,
  isAbsolutePath,
  needYouCount,
  projectSummaries,
  recentCwds,
  sessionBillingMode,
  sessionStateLabel,
  sessionStatus,
  sessionSubtitle,
  sessionsForProject,
  trustLabel,
  usageFromEntries,
  workerChip,
} from "../../src/components/shell/model.js";
import type { SessionView } from "../../src/store.js";

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  path: "/s/a.jsonl",
  id: "aaaaaaaa-1",
  cwd: "/p/one",
  createdAt: "2026-09-05T10:00:00.000Z",
  modifiedAt: "2026-09-05T10:00:00.000Z",
  messageCount: 0,
  ...over,
});

const sessionState = (over: Partial<SessionState> = {}): SessionState => ({
  path: "/s/a.jsonl",
  id: "aaaaaaaa-1",
  cwd: "/p/one",
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
  ...over,
});

const view = (over: Partial<SessionView> = {}): SessionView => ({
  path: "/s/a.jsonl",
  state: sessionState(),
  blocks: [],
  lastSeq: 0,
  running: false,
  queue: { steering: [], followUp: [] }, pending: [], capabilities: [], goal: null,
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-05T00:00:00.000Z",
  hydrated: true,
  entries: [],
  ...over,
});

describe("projects", () => {
  it("aggregates status across sessions and folds a crashed worker in as an error", () => {
    const sessions = [summary(), summary({ path: "/s/b.jsonl", id: "b", cwd: "/p/two" })];
    const open = { "/s/a.jsonl": view({ running: true }) };
    const [one, two] = projectSummaries(["/p/one", "/p/two"], sessions, open, { "/p/two": { status: "crashed" } });
    expect(one).toMatchObject({ name: "one", status: "working", sessionCount: 1, needYou: 0 });
    expect(two).toMatchObject({ name: "two", status: "error", sessionCount: 1 });
  });

  it("counts sessions waiting for input as needing you", () => {
    const sessions = [summary(), summary({ path: "/s/b.jsonl", id: "b" })];
    const open = {
      "/s/a.jsonl": view({ dialogs: [{ method: "confirm", id: "d1", title: "?" }] }),
    };
    expect(needYouCount(sessions, open)).toBe(1);
    expect(projectSummaries(["/p/one"], sessions, open, {})[0]?.needYou).toBe(1);
  });

  it("restricts and attention-sorts sessions for one project, including unsaved open views", () => {
    const sessions = [summary({ path: "/s/old.jsonl", id: "old", modifiedAt: "2026-09-01T00:00:00.000Z" })];
    const open = {
      "/s/new.jsonl": view({ path: "/s/new.jsonl", state: sessionState({ path: "/s/new.jsonl", id: "new" }) }),
      "/s/other.jsonl": view({ path: "/s/other.jsonl", state: sessionState({ path: "/s/other.jsonl", cwd: "/p/two" }) }),
      "/s/old.jsonl": view({ path: "/s/old.jsonl", running: true }),
    };
    const rows = sessionsForProject("/p/one", sessions, open).map((s) => s.path);
    expect(rows).toEqual(["/s/old.jsonl", "/s/new.jsonl"]);
    expect(sessionsForProject(undefined, sessions, open)).toEqual([]);
  });

  it("lists recent directories by latest modification", () => {
    const sessions = [
      summary({ cwd: "/p/one", modifiedAt: "2026-09-01T00:00:00.000Z" }),
      summary({ path: "/s/b.jsonl", cwd: "/p/two", modifiedAt: "2026-09-03T00:00:00.000Z" }),
      summary({ path: "/s/c.jsonl", cwd: "/p/one", modifiedAt: "2026-09-04T00:00:00.000Z" }),
    ];
    expect(recentCwds(sessions)).toEqual(["/p/one", "/p/two"]);
    expect(recentCwds(sessions, 1)).toEqual(["/p/one"]);
  });

  it("accepts absolute paths only", () => {
    expect(isAbsolutePath("/home/me/app")).toBe(true);
    expect(isAbsolutePath("C:\\work\\app")).toBe(true);
    expect(isAbsolutePath("~/app")).toBe(true);
    expect(isAbsolutePath("app")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});

describe("session rows", () => {
  it("subtitle prefers waiting, then the last tool, then the first message", () => {
    const s = summary({ firstMessage: "fix the   build" });
    expect(sessionSubtitle(s, view({ dialogs: [{ method: "input", id: "d", title: "?" }] }))).toEqual({
      text: "Waiting for you",
      mono: false,
      tone: "attention",
    });
    const withTool = view({
      blocks: [
        { kind: "user", files: [], id: "u", text: "hi", images: [] },
        { kind: "tool", id: "t", name: "edit", args: { path: "src/a.ts" }, done: true },
      ],
    });
    expect(sessionSubtitle(s, withTool)).toEqual({ text: "edit  src/a.ts", mono: true, tone: "default" });
    expect(sessionSubtitle(s, undefined)).toEqual({ text: "fix the build", mono: false, tone: "default" });
    expect(sessionSubtitle(summary(), view())).toEqual({ text: "No messages yet", mono: false, tone: "muted" });
  });

  it("status and label share one vocabulary", () => {
    expect(sessionStatus(undefined, summary({ attention: "finished_unread" }))).toBe("finished_unread");
    expect(sessionStatus(view({ state: sessionState({ isCompacting: true }) }))).toBe("working");
    expect(sessionStateLabel(view({ state: sessionState({ isCompacting: true }) }))).toBe("Compacting context");
    expect(sessionStateLabel(view({ running: true }))).toBe("Working");
    expect(sessionStateLabel(view(), { status: "crashed" })).toBe("Worker crashed");
    expect(sessionStateLabel(view())).toBe("Idle");
    expect(sessionStateLabel(undefined)).toBe("");
  });

  it("worker chip only speaks when something is off", () => {
    expect(workerChip(undefined)).toBeUndefined();
    expect(workerChip({ status: "ready" })).toBeUndefined();
    expect(workerChip({ status: "starting" })).toEqual({
      label: "Starting the agent", tone: "attention", canRetry: false, canStartSafe: false, canTryNormal: false,
    });
    expect(workerChip({ status: "crashed", message: "exit 1" })).toEqual({
      label: "Worker crashed",
      tone: "danger",
      canRetry: true,
      canStartSafe: true,
      canTryNormal: false,
      detail: "exit 1",
    });
    // A retired worker is asleep, not broken; it can still be woken by hand.
    expect(workerChip({ status: "retired" })).toMatchObject({ tone: "muted", canRetry: true });
    expect(workerChip({ status: "ready", mode: "safe" })).toMatchObject({
      label: "Safe mode is on", canTryNormal: true, canStartSafe: false,
    });
    expect(workerChip({ status: "crashed", repair: { state: "paused", automaticAttempts: 0 } })).toMatchObject({
      label: "Automatic repair paused", canRetry: true,
    });
    expect(workerChip({
      status: "crashed",
      mode: "normal",
      failure: {
        owner: { kind: "worker", launchId: "0123456789abcdef0123456789abcdef", cwd: "/project" },
        stage: "initialize",
        category: "initialization_error",
        message: "failed",
      },
      repair: { state: "exhausted", automaticAttempts: 2 },
    })).toMatchObject({ label: "Agent couldn't start", canRetry: true });
  });

  it("inbox lists what needs you across projects, most urgent first", () => {
    const sessions = [
      summary({ path: "/s/idle.jsonl", id: "idle" }),
      summary({ path: "/s/unread.jsonl", id: "unread", attention: "finished_unread", modifiedAt: "2026-09-05T11:00:00.000Z" }),
      summary({ path: "/s/err.jsonl", id: "err", cwd: "/p/two", attention: "error" }),
      summary({ path: "/s/ask.jsonl", id: "ask", cwd: "/p/two" }),
    ];
    const open = {
      "/s/ask.jsonl": view({ path: "/s/ask.jsonl", dialogs: [{ method: "confirm", id: "d1", title: "?" }] }),
    };
    const rows = inboxRows(sessions, open);
    expect(rows.map((r) => [r.path, r.status])).toEqual([
      ["/s/ask.jsonl", "waiting_for_input"],
      ["/s/err.jsonl", "error"],
      ["/s/unread.jsonl", "finished_unread"],
    ]);
    expect(rows[0]).toMatchObject({ project: "two", sub: { text: "Waiting for you" } });
    expect(inboxRows(sessions, open, 1)).toHaveLength(1);
  });

  it("names the trust states that are worth saying out loud", () => {
    expect(trustLabel("trusted")).toBeUndefined();
    expect(trustLabel("not_required")).toBeUndefined();
    expect(trustLabel(undefined)).toBeUndefined();
    expect(trustLabel("unknown")).toMatchObject({ tone: "attention" });
    expect(trustLabel("declined")).toMatchObject({ tone: "muted" });
  });

  it("builds the tab title", () => {
    expect(documentTitle(undefined, 0)).toBe(PRODUCT_DISPLAY_NAME);
    expect(documentTitle("Refactor auth", 0)).toBe(`Refactor auth · ${PRODUCT_DISPLAY_NAME}`);
    expect(documentTitle("Refactor auth", 2)).toBe(`(2) Refactor auth · ${PRODUCT_DISPLAY_NAME}`);
  });
});

describe("entries", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-05T10:00:00.000Z", message: { role: "user", content: "hello" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-09-05T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }],
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.01 } },
      },
    },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-05T10:00:02.000Z", message: { role: "toolResult", toolCallId: "c1", content: "ok" } },
    { type: "label", id: "l1", parentId: "r1", timestamp: "2026-09-05T10:00:03.000Z", targetId: "u1", label: "start" },
    { type: "message", id: "u2", parentId: "r1", timestamp: "2026-09-05T10:00:04.000Z", message: { role: "user", content: "branch A" } },
    { type: "message", id: "u3", parentId: "r1", timestamp: "2026-09-05T10:00:05.000Z", message: { role: "user", content: "branch B" } },
    { type: "compaction", id: "cp", parentId: "u3", timestamp: "2026-09-05T10:00:06.000Z", summary: "so far", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } } },
    { type: "session_info", id: "si", parentId: "cp", timestamp: "2026-09-05T10:00:07.000Z", name: "Named" },
  ];

  it("sums usage across assistant messages and summaries", () => {
    expect(usageFromEntries(entries)).toEqual({ input: 11, output: 6, cacheRead: 2, cacheWrite: 1, total: 20, cost: 0.011, turns: 1 });
    expect(usageFromEntries([])).toBeUndefined();
  });

  it("keeps account allowance and API spend in separate billing views", () => {
    const mixed = [
      { type: "message", message: { role: "assistant", provider: "openai-codex", usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 4 } } } },
      { type: "message", message: { role: "assistant", provider: "anthropic", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.1 } } } },
    ];
    expect(sessionBillingMode(mixed)).toBe("mixed");
    expect(usageFromEntries(mixed, "api")).toMatchObject({ input: 10, output: 5, total: 15, cost: 0.1, turns: 1 });
    expect(sessionBillingMode([mixed[0]])).toBe("account");
    expect(sessionBillingMode([mixed[1]])).toBe("api");
  });

  it("puts a session in the mixed billing view when a child agent ran on another provider", () => {
    // The harness records what a run *is*, never what it spent (D-140), so a
    // child contributes its model and nothing else. That is enough to decide
    // the billing view, and inventing numbers would be worse than having none.
    const run = (runId: string, provider: string, id: string): AgentRun =>
      ({
        runId,
        agentName: "researcher",
        subagentName: "researcher",
        sessionId: runId,
        sessionPath: `/sessions/${runId}.jsonl`,
        projectCwd: "/p",
        rootSessionPath: "/sessions/root.jsonl",
        depth: 1,
        parent: null,
        worktree: null,
        origin: "agent",
        status: "completed",
        task: "look",
        model: { provider, id },
        startedAt: "2026-09-08T10:00:00.000Z",
        updatedAt: "2026-09-08T10:01:00.000Z",
      }) as AgentRun;

    const accountParent = [
      { type: "message", message: { role: "assistant", provider: "openai-codex", usage: { input: 20, output: 5, cost: { total: 1 } } } },
    ];
    const apiChild = backgroundUsageSources([run("r1", "anthropic", "claude-sonnet")]);
    expect(apiChild).toEqual([{ model: "anthropic/claude-sonnet" }]);
    expect(sessionBillingMode(accountParent, apiChild)).toBe("mixed");
    // No usage means no numbers added, not zeroes: the parent's own totals stand.
    expect(usageFromEntries(accountParent, "all", apiChild)).toMatchObject({ input: 20, output: 5, cost: 1 });

    // A child on the same account provider keeps the session in one view.
    const accountChild = backgroundUsageSources([run("r2", "openai-codex", "gpt-5.6")]);
    expect(sessionBillingMode(accountParent, accountChild)).toBe("account");
    // A run with no model recorded says nothing about billing.
    expect(backgroundUsageSources([{ ...run("r3", "anthropic", "x"), model: null } as AgentRun])).toEqual([{}]);
  });

  it("flattens the tree with branch depth, folded tool results, and labels on targets", () => {
    const rows = historyRows(entries);
    expect(rows.map((r) => [r.id, r.kind, r.depth, r.branchStart])).toEqual([
      ["u1", "user", 0, false],
      ["a1", "assistant", 0, false],
      ["u2", "user", 1, true],
      ["u3", "user", 1, true],
      ["cp", "compaction", 1, false],
      ["si", "name", 1, false],
    ]);
    expect(rows[0]?.label).toBe("start");
    expect(rows[1]).toMatchObject({ tools: 1, text: "hi", canFork: true, canJump: true });
    expect(rows[4]).toMatchObject({ text: "so far", canFork: false, canJump: true });
    expect(rows[5]).toMatchObject({ text: "Named", canFork: false, canJump: false });
  });

  it("preserves every history row kind, hidden nodes, and last label/unlabel semantics", () => {
    const specs = [
      { id: "u", type: "message", message: { role: "user", content: "question" }, timestamp: 0 },
      { id: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall" }] } },
      { id: "custom", type: "message", message: { role: "custom", content: "custom body" } },
      { id: "bash", type: "message", message: { role: "bashExecution", content: "shell body" } },
      { id: "result", type: "message", message: { role: "toolResult", content: "folded" } },
      { id: "reason", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } },
      { id: "tools", type: "message", message: { role: "assistant", content: [{ type: "toolCall" }, { type: "toolCall" }] } },
      { id: "empty", type: "message", message: { role: "assistant", content: [] } },
      { id: "cp", type: "compaction" },
      { id: "branch", type: "branch_summary", summary: "branch body" },
      { id: "notice", type: "custom_message", content: "notice body" },
      { id: "hidden", type: "custom_message", display: false, content: "not shown" },
      { id: "name", type: "session_info", name: "renamed" },
      { id: "model", type: "model_change", provider: "provider", modelId: "model" },
      { id: "thinking", type: "thinking_level_change", thinkingLevel: "high" },
      { id: "unknown", type: "unknown" },
    ];
    const input = specs.map((entry, i) => ({ ...entry, parentId: specs[i - 1]?.id ?? null }));
    const label = (id: string, targetId: string, value: string) => ({ id, parentId: "unknown", type: "label", targetId, label: value });
    const labeled = [...input, label("l1", "u", "first"), label("l2", "u", "last"), label("l3", "u", ""),
      label("l4", "a", "assistant label"), label("l5", "result", "first result"), label("l6", "result", "last result")];
    const rows = historyRows(labeled);
    expect(rows.map(r => [r.id, r.kind, r.text, r.tools, r.canFork, r.canJump])).toEqual([
      ["u", "user", "question", 0, true, true],
      ["a", "assistant", "answer", 1, true, true],
      ["custom", "custom", "custom body", 0, true, true],
      ["bash", "custom", "shell body", 0, true, true],
      ["reason", "assistant", "Reasoning only", 0, true, true],
      ["tools", "assistant", "", 2, true, true],
      ["empty", "assistant", "", 0, true, true],
      ["cp", "compaction", "Context compacted", 0, false, true],
      ["branch", "branch", "branch body", 0, false, true],
      ["notice", "custom", "notice body", 0, false, true],
      ["name", "name", "renamed", 0, false, false],
      ["model", "model", "provider/model", 0, false, false],
      ["thinking", "thinking", "high", 0, false, false],
    ]);
    expect(rows.every(r => r.depth === 0 && !r.branchStart)).toBe(true);
    expect(rows[0]).toMatchObject({ parentId: null, at: "1970-01-01T00:00:00.000Z", label: undefined });
    expect(rows[1]?.label).toBe("last result");
    expect(historyRows([...labeled, label("l7", "result", "")])[1]?.label).toBe("assistant label");
  });

  it("preserves fork depth for out-of-order and missing ancestors, without counting labels as forks", () => {
    const user = (id: string, parentId: string | null) => ({ id, parentId, type: "message", message: { role: "user", content: id } });
    const input = [user("tip", "left"), user("right", "root"), user("left", "root"), user("root", "missing"), user("other", "missing"),
      { id: "label", parentId: "left", type: "label", targetId: "tip", label: "bookmark" }];
    expect(historyRows(input).map(r => [r.id, r.depth, r.branchStart])).toEqual([
      ["tip", 2, false], ["right", 2, true], ["left", 2, true], ["root", 1, true], ["other", 1, true],
    ]);
    expect(historyRows([...input].reverse()).map(r => [r.id, r.depth, r.branchStart])).toEqual([
      ["other", 1, true], ["root", 1, true], ["left", 2, true], ["right", 2, true], ["tip", 2, false],
    ]);
  });

  it("uses linear ancestor work and no recursive stack on a reversed 10k chain", () => {
    let parentReads = 0;
    const count = 10_000;
    const input = Array.from({ length: count }, (_, i) => ({
      id: `e${i}`, get parentId() { parentReads++; return i ? `e${i - 1}` : null; },
      type: "message", message: { role: "user", content: `message ${i}` },
    })).reverse();
    const rows = historyRows(input);
    expect(rows).toHaveLength(count);
    expect(rows.every(r => r.depth === 0 && !r.branchStart)).toBe(true);
    expect(rows[0]?.id).toBe("e9999");
    expect(rows.at(-1)?.id).toBe("e0");
    // Counts source ancestor accesses, not machine-dependent elapsed time.
    expect(parentReads).toBeLessThanOrEqual(count * 10);
  });

  it("terminates cyclic ancestors with a deterministic distinct-fork depth", () => {
    const user = (id: string, parentId: string) => ({ id, parentId, type: "message", message: { role: "user", content: id } });
    const input = [user("a", "b"), user("b", "a"), user("tail", "a"), user("leaf", "tail"), user("self", "self")];
    const depths = (entries: unknown[]) => Object.fromEntries(historyRows(entries).map(r => [r.id, r.depth]));
    expect(depths(input)).toEqual({ a: 1, b: 1, tail: 1, leaf: 1, self: 0 });
    expect(depths([...input].reverse())).toEqual(depths(input));
  });

});
