import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import type { Panel, SessionState, SessionSummary } from "@lasercode/protocol";

import {
  backgroundUsageSources,
  documentTitle,
  historyRows,
  inboxRows,
  isAbsolutePath,
  lastPromptEntryId,
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
  queue: { steering: [], followUp: [] },
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
        { kind: "user", id: "u", text: "hi", images: 0 },
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
    expect(workerChip({ status: "starting" })).toEqual({ label: "Starting the agent", tone: "attention", canRetry: false });
    expect(workerChip({ status: "crashed", message: "exit 1" })).toEqual({
      label: "Worker crashed",
      tone: "danger",
      canRetry: true,
      detail: "exit 1",
    });
    // A retired worker is asleep, not broken; it can still be woken by hand.
    expect(workerChip({ status: "retired" })).toMatchObject({ tone: "muted", canRetry: true });
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

  it("counts every subagent under the model that served it without counting plan roll-ups", () => {
    const panels: Panel[] = [
      {
        kind: "plan",
        id: "plan",
        source: "Subagents",
        title: "Parallel",
        intent: "follow",
        steps: [],
        usage: { input: 999, output: 999, costUsd: 99 },
      },
      {
        kind: "run",
        id: "child",
        source: "Subagents",
        title: "researcher",
        intent: "follow",
        lifecycle: "done",
        usage: { input: 160, output: 30, costUsd: 0.4 },
        usageByModel: [
          { model: "openai-codex/gpt-5.6", usage: { input: 100, output: 20, turns: 2, costUsd: 0 } },
          { model: "anthropic/claude-sonnet", usage: { input: 60, output: 10, turns: 1, costUsd: 0.4 } },
        ],
      },
    ];
    const background = backgroundUsageSources(panels);
    const accountParent = [
      { type: "message", message: { role: "assistant", provider: "openai-codex", usage: { input: 20, output: 5, cost: { total: 1 } } } },
    ];
    expect(background).toHaveLength(2);
    expect(sessionBillingMode(accountParent, background)).toBe("mixed");
    expect(usageFromEntries(accountParent, "api", background)).toEqual({
      input: 60,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 70,
      cost: 0.4,
      turns: 1,
    });
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

  it("finds the last prompt to fork from", () => {
    expect(lastPromptEntryId(entries)).toBe("u3");
    expect(lastPromptEntryId([])).toBeUndefined();
  });
});
