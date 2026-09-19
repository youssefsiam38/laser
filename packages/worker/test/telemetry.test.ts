import { describe, expect, it } from "vitest";
import { TelemetryFold } from "@lasercode/protocol";
import type { AgentRun, SessionState } from "@lasercode/protocol";
import { ChildTelemetryCache, childSources, computeLiveTelemetry, liveOverlay, telemetryUpdateKind } from "../src/telemetry.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const user = (id: string, parentId: string | null) => ({
  type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: id },
});
const assistant = (id: string, parentId: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "claude",
    content: [{ type: "text", text: "ok" }],
    usage: { input: 4, output: 2, totalTokens: 6, cost: { total: 0.01 } },
  },
});

const fence = { revision: "r1.live", environmentKey: "e1.live" };
const state = (over: Partial<SessionState> = {}): SessionState => ({
  path: "/s.jsonl",
  id: "session-1",
  cwd: "/p",
  model: { provider: "anthropic", id: "claude", contextWindow: 200000 },
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 2,
  pendingMessageCount: 0,
  contextUsage: { tokens: 1200, contextWindow: 200000, percent: 1 },
  ...over,
});

describe("live telemetry", () => {
  it("folds incrementally and overlays live context without a second walk", () => {
    const fold = TelemetryFold.create();
    const first = [user("u1", null), assistant("a1", "u1")];
    const snapshot = computeLiveTelemetry(fold, first, "a1", fence, {
      overlay: liveOverlay(state()),
      children: [],
    });
    expect(fold.recordsFolded).toBe(2);
    expect(snapshot.authority).toBe("live");
    expect(snapshot.context).toMatchObject({ tokens: 1200, contextWindow: 200000, autoCompact: { enabled: true, state: "idle", thresholdTokens: 200000 - 16384 } });
    expect(snapshot.spend?.api?.totals.turns).toBe(1);
    expect(snapshot.model?.id).toBe("claude");

    computeLiveTelemetry(fold, first, "a1", fence, { overlay: liveOverlay(state()), children: [] });
    expect(fold.recordsFolded).toBe(2);

    const next = [...first, user("u2", "a1"), assistant("a2", "u2")];
    const grown = computeLiveTelemetry(fold, next, "a2", fence, { overlay: liveOverlay(state()), children: [] });
    expect(fold.recordsFolded).toBe(4);
    expect(grown.work?.turns).toBe(2);
  });

  it("attaches snapshots only on updates that change numbers", () => {
    expect(telemetryUpdateKind("message_end")).toBe(true);
    expect(telemetryUpdateKind("tool_execution_end")).toBe(true);
    expect(telemetryUpdateKind("text_delta")).toBe(false);
    expect(telemetryUpdateKind("thinking_delta")).toBe(false);
  });
});

function run(partial: Partial<AgentRun> & Pick<AgentRun, "runId" | "sessionPath" | "rootSessionPath">): AgentRun {
  return {
    agentName: "worker",
    subagentName: partial.subagentName ?? partial.runId,
    sessionId: `id-${partial.sessionPath}`,
    projectCwd: "/repo",
    depth: 1,
    parent: partial.parent ?? { sessionPath: partial.rootSessionPath, sessionId: "root" },
    worktree: null,
    origin: "agent",
    status: "completed",
    task: "task",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("childSources", () => {
  it("does not merge another root's children into this session's spend", () => {
    const aChild = [
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "a" } },
      {
        type: "message",
        id: "a",
        parentId: "u",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 8, output: 2, totalTokens: 10, cost: { total: 0.2 } },
        },
      },
    ];
    const bChild = [
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "b" } },
      {
        type: "message",
        id: "a",
        parentId: "u",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 90, output: 10, totalTokens: 100, cost: { total: 9 } },
        },
      },
    ];
    const runs = [
      run({ runId: "a1", sessionPath: "/a-child.jsonl", rootSessionPath: "/a.jsonl", model: { provider: "anthropic", id: "claude" } }),
      run({ runId: "b1", sessionPath: "/b-child.jsonl", rootSessionPath: "/b.jsonl", model: { provider: "anthropic", id: "claude" } }),
    ];
    const live = new Map<string, unknown[]>([
      ["/a-child.jsonl", aChild],
      ["/b-child.jsonl", bChild],
    ]);
    const sources = childSources("/a.jsonl", runs, (path) => live.get(path));
    expect(sources).toHaveLength(1);
    const fold = TelemetryFold.create();
    fold.ingest([user("u1", null), assistant("a1", "u1")]);
    const snapshot = computeLiveTelemetry(fold, [user("u1", null), assistant("a1", "u1")], "a1", fence, {
      overlay: liveOverlay(state()),
      children: sources,
    });
    expect(snapshot.spend?.api?.totals.cost).toBeCloseTo(0.21);
  });

  it("asked about a child, merges only runs beneath it", () => {
    const grand = [
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "g" } },
      {
        type: "message",
        id: "a",
        parentId: "u",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 3, output: 1, totalTokens: 4, cost: { total: 0.03 } },
        },
      },
    ];
    const sibling = [
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "s" } },
      {
        type: "message",
        id: "a",
        parentId: "u",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 50, output: 10, totalTokens: 60, cost: { total: 5 } },
        },
      },
    ];
    const runs = [
      run({ runId: "c", sessionPath: "/a-child.jsonl", rootSessionPath: "/a.jsonl" }),
      run({ runId: "g", sessionPath: "/a-grand.jsonl", rootSessionPath: "/a.jsonl", parent: { sessionPath: "/a-child.jsonl", sessionId: "c" }, depth: 2 }),
      run({ runId: "s", sessionPath: "/a-sib.jsonl", rootSessionPath: "/a.jsonl" }),
    ];
    const live = new Map<string, unknown[]>([["/a-grand.jsonl", grand], ["/a-sib.jsonl", sibling]]);
    const sources = childSources("/a-child.jsonl", runs, (path) => live.get(path));
    expect(sources).toHaveLength(1);
    expect(sources[0]?.fold?.api.cost).toBeCloseTo(0.03);
  });

  it("holds a fold per child path instead of re-reading the file every call", () => {
    const dir = mkdtempSync(join(tmpdir(), "child-fold-"));
    try {
      const path = join(dir, "child.jsonl");
      writeFileSync(path, [
        JSON.stringify({ type: "session", version: 3, id: "c", cwd: "/p" }),
        JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }),
        JSON.stringify({
          type: "message",
          id: "a",
          parentId: "u",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 4, output: 2, totalTokens: 6, cost: { total: 0.01 } },
          },
        }),
      ].join("\n") + "\n");
      const cache = new ChildTelemetryCache();
      const runs = [run({ runId: "c", sessionPath: path, rootSessionPath: "/root.jsonl" })];
      const first = cache.sources("/root.jsonl", runs, () => undefined);
      const second = cache.sources("/root.jsonl", runs, () => undefined);
      expect(first[0]?.fold?.records).toBe(2);
      expect(second[0]?.fold?.records).toBe(2);
      expect(first[0]?.fold).toEqual(second[0]?.fold);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
