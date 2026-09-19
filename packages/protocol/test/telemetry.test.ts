import { describe, expect, it } from "vitest";
import {
  TELEMETRY_SERIES_MAX,
  TELEMETRY_TOOL_HISTOGRAM_TOP,
  TelemetryFold,
  downsampleSeries,
  runsBeneathSession,
  sessionTelemetryOf,
  turnEntryIndices,
  type TelemetryFoldState,
} from "../src/telemetry.js";

const fence = { revision: "r1.test", environmentKey: "e1.test", authority: "durable" as const };

const user = (id: string, parentId: string | null, text = id) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: text },
});

const assistant = (
  id: string,
  parentId: string,
  over: {
    provider?: string;
    model?: string;
    input?: number;
    output?: number;
    cost?: number;
    tools?: string[];
    timestamp?: string;
  } = {},
) => ({
  type: "message",
  id,
  parentId,
  timestamp: over.timestamp ?? "2026-01-01T00:00:01.000Z",
  message: {
    role: "assistant",
    provider: over.provider ?? "anthropic",
    model: over.model ?? "claude",
    content: [
      { type: "text", text: "ok" },
      ...(over.tools ?? []).map((name) => ({ type: "toolCall", name })),
    ],
    usage: {
      input: over.input ?? 10,
      output: over.output ?? 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (over.input ?? 10) + (over.output ?? 5),
      cost: { total: over.cost ?? 0.01 },
    },
  },
});

const toolResult = (id: string, parentId: string, name: string, isError = false) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:02.000Z",
  message: { role: "toolResult", toolName: name, isError, content: isError ? "no" : "ok" },
});

function fold(entries: readonly unknown[]): TelemetryFoldState {
  const telemetry = TelemetryFold.create();
  telemetry.ingest(entries);
  return telemetry.state;
}

describe("telemetry fold", () => {
  it("sums usage over every record, including compacted ranges", () => {
    const entries = [
      user("u1", null),
      assistant("a1", "u1", { input: 10, output: 5, cost: 0.01 }),
      { type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", summary: "so far", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } } },
    ];
    const snapshot = sessionTelemetryOf(fold(entries), fence, { include: ["spend", "history", "work"] });
    expect(snapshot.history).toEqual({ prompts: 1, records: 3, compactions: 1, branches: 0 });
    expect(snapshot.spend?.api?.totals).toMatchObject({ input: 11, output: 6, total: 17, cost: 0.011, turns: 1 });
    expect(snapshot.context).toBeUndefined();
    expect(snapshot.model).toBeUndefined();
  });

  it("covers a session longer than any client page", () => {
    const entries: unknown[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 30; i++) {
      const u = `u${i}`;
      const a = `a${i}`;
      entries.push(user(u, parent, `turn ${i}`), assistant(a, u, { input: 2, output: 1, cost: 0.001 }));
      parent = a;
    }
    const snapshot = sessionTelemetryOf(fold(entries), fence, { include: ["spend", "work", "history"] });
    expect(snapshot.history?.records).toBe(60);
    expect(snapshot.history?.prompts).toBe(30);
    expect(snapshot.work?.turns).toBe(30);
    expect(snapshot.spend?.api?.totals.turns).toBe(30);
    expect(snapshot.spend?.api?.totals.input).toBe(60);
    expect(snapshot.spend?.api?.series).toHaveLength(30);
  });

  it("folds only appended records on a newer revision", () => {
    const first = [user("u1", null), assistant("a1", "u1")];
    const grown = TelemetryFold.create();
    grown.ingest(first);
    expect(grown.recordsFolded).toBe(2);
    const atFirst = grown.state;
    grown.ingest(first);
    expect(grown.recordsFolded).toBe(2);
    expect(grown.state).toEqual(atFirst);

    const next = [...first, user("u2", "a1"), assistant("a2", "u2", { input: 4, output: 1, cost: 0.02 })];
    grown.ingest(next);
    expect(grown.recordsFolded).toBe(4);
    expect(grown.state.records).toBe(4);
    expect(grown.state.api.input).toBe(14);

    const resumed = TelemetryFold.resume(atFirst);
    expect(resumed.recordsFolded).toBe(0);
    resumed.ingest(next);
    expect(resumed.recordsFolded).toBe(2);
    expect(resumed.state.api.input).toBe(grown.state.api.input);
  });

  it("leaves a section the caller did not ask for absent, not empty", () => {
    const snapshot = sessionTelemetryOf(fold([user("u1", null)]), fence, { include: ["history"] });
    expect(snapshot.history).toEqual({ prompts: 1, records: 1, compactions: 0, branches: 0 });
    expect(snapshot.spend).toBeUndefined();
    expect(snapshot.work).toBeUndefined();
    expect(snapshot.model).toBeUndefined();
    expect(snapshot.context).toBeUndefined();
  });

  it("expresses a session with no API cost as one billing line", () => {
    const account = [
      user("u1", null),
      assistant("a1", "u1", { provider: "openai-codex", model: "gpt-5", cost: 4 }),
    ];
    const snapshot = sessionTelemetryOf(fold(account), fence, { include: ["spend"] });
    expect(snapshot.spend).toEqual({ billing: "account" });
    expect(snapshot.spend?.api).toBeUndefined();

    const empty = sessionTelemetryOf(fold([user("u1", null)]), fence, { include: ["spend"] });
    expect(empty.spend).toEqual({ billing: "none" });
  });

  it("ranks tools with an explicit other bucket and names failures", () => {
    const tools = Array.from({ length: TELEMETRY_TOOL_HISTOGRAM_TOP + 3 }, (_, i) => `tool-${String.fromCharCode(97 + i)}`);
    const entries = [
      user("u1", null),
      assistant("a1", "u1", { tools }),
      toolResult("r1", "a1", "tool-a", true),
    ];
    const snapshot = sessionTelemetryOf(fold(entries), fence, { include: ["work"] });
    expect(snapshot.work?.tools.total).toBe(tools.length);
    expect(snapshot.work?.tools.ranked).toHaveLength(TELEMETRY_TOOL_HISTOGRAM_TOP);
    expect(snapshot.work?.tools.other).toBe(3);
    expect(snapshot.work?.tools.failed).toEqual([{ name: "tool-a", count: 1 }]);
  });

  it("rolls child-run costs into spend and billing without inventing tokens", () => {
    const parent = fold([user("u1", null), assistant("a1", "u1", { provider: "openai-codex", model: "gpt-5", cost: 1 })]);
    const child = fold([user("c-u", null), assistant("c-a", "c-u", { provider: "anthropic", model: "claude", input: 8, output: 2, cost: 0.2 })]);
    const mixed = sessionTelemetryOf(parent, fence, {
      include: ["spend"],
      children: [{ model: "anthropic/claude", fold: child }],
    });
    expect(mixed.spend?.billing).toBe("mixed");
    expect(mixed.spend?.api?.totals).toMatchObject({ input: 8, output: 2, cost: 0.2, turns: 1 });

    const flagOnly = sessionTelemetryOf(parent, fence, {
      include: ["spend"],
      children: [{ model: "anthropic/claude" }],
    });
    expect(flagOnly.spend?.billing).toBe("mixed");
    expect(flagOnly.spend?.api).toBeUndefined();
  });

  it("an account-only session plus a compaction stays account-billed with no API spend", () => {
    const entries = [
      user("u1", null),
      assistant("a1", "u1", { provider: "openai-codex", model: "gpt-5", cost: 4 }),
      {
        type: "compaction",
        id: "c1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "so far",
        usage: { input: 80, output: 40, totalTokens: 120, cost: { total: 0.6147 } },
      },
    ];
    const snapshot = sessionTelemetryOf(fold(entries), fence, { include: ["spend"] });
    expect(snapshot.spend).toEqual({ billing: "account" });
    expect(snapshot.spend?.api).toBeUndefined();
  });

  it("caps sparkline series so a long session stays bounded", () => {
    const entries: unknown[] = [];
    let parent: string | null = null;
    for (let i = 0; i < TELEMETRY_SERIES_MAX + 40; i++) {
      const u = `u${i}`;
      const a = `a${i}`;
      entries.push(user(u, parent, `turn ${i}`), assistant(a, u, { input: 2, output: 1, cost: 0.001 }));
      parent = a;
    }
    const snapshot = sessionTelemetryOf(fold(entries), fence, { include: ["spend", "model"] });
    expect(snapshot.spend?.api?.series).toHaveLength(TELEMETRY_SERIES_MAX);
    expect(snapshot.model?.tokenSeries).toHaveLength(TELEMETRY_SERIES_MAX);
    expect(downsampleSeries([1, 2, 3], 8)).toEqual([1, 2, 3]);
  });

  it("selects children beneath the requested session, never a sibling or another root", () => {
    const runs = [
      { sessionPath: "/a-child.jsonl", rootSessionPath: "/a.jsonl", parent: { sessionPath: "/a.jsonl" } },
      { sessionPath: "/a-grand.jsonl", rootSessionPath: "/a.jsonl", parent: { sessionPath: "/a-child.jsonl" } },
      { sessionPath: "/a-sib.jsonl", rootSessionPath: "/a.jsonl", parent: { sessionPath: "/a.jsonl" } },
      { sessionPath: "/b-child.jsonl", rootSessionPath: "/b.jsonl", parent: { sessionPath: "/b.jsonl" } },
    ];
    expect(runsBeneathSession("/a.jsonl", runs).map((run) => run.sessionPath)).toEqual([
      "/a-child.jsonl",
      "/a-grand.jsonl",
      "/a-sib.jsonl",
    ]);
    expect(runsBeneathSession("/a-child.jsonl", runs).map((run) => run.sessionPath)).toEqual(["/a-grand.jsonl"]);
    expect(runsBeneathSession("/b.jsonl", runs).map((run) => run.sessionPath)).toEqual(["/b-child.jsonl"]);
  });

  it("selects one user-anchored turn on the rendered branch", () => {
    const entries = [
      user("u1", null),
      assistant("a1", "u1"),
      user("u2", "a1"),
      assistant("a2", "u2", { input: 3, output: 1, cost: 0.03, tools: ["bash"] }),
      user("u3", "a2"),
    ];
    expect(turnEntryIndices(entries, "u3", "u2")?.map((index) => (entries[index] as { id: string }).id)).toEqual(["u2", "a2"]);
    const slice = turnEntryIndices(entries, "u3", "u2")!.map((index) => entries[index]);
    const snapshot = sessionTelemetryOf(fold(slice), fence, { include: ["work", "history"], scope: "turn", turnId: "u2" });
    expect(snapshot.scope).toBe("turn");
    expect(snapshot.turnId).toBe("u2");
    expect(snapshot.work?.turns).toBe(1);
    expect(snapshot.work?.tools.total).toBe(1);
    expect(snapshot.history?.prompts).toBe(1);
  });
});
