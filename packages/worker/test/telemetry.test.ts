import { describe, expect, it } from "vitest";
import { TelemetryFold, childSpendFoldOf, clientParamsSchemas } from "@lasercode/protocol";
import type { AgentRun, SessionState, TelemetryChildSpendSnapshot } from "@lasercode/protocol";
import { ChildTelemetryCache, computeLiveTelemetry, liveOverlay, telemetryUpdateKind } from "../src/telemetry.js";

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
      children: { sources: [], coverage: { knownChildren: 0, includedChildren: 0, unavailableChildren: 0 } },
    });
    expect(fold.recordsFolded).toBe(2);
    expect(snapshot.authority).toBe("live");
    expect(snapshot.context).toMatchObject({ tokens: 1200, contextWindow: 200000, autoCompact: { enabled: true, state: "idle", thresholdTokens: 200000 - 16384 } });
    expect(snapshot.spend?.api?.totals.turns).toBe(1);
    expect(snapshot.spend?.coverage).toEqual({ knownChildren: 0, includedChildren: 0, unavailableChildren: 0 });
    expect(snapshot.model?.id).toBe("claude");

    computeLiveTelemetry(fold, first, "a1", fence, { overlay: liveOverlay(state()) });
    expect(fold.recordsFolded).toBe(2);

    const next = [...first, user("u2", "a1"), assistant("a2", "u2")];
    const grown = computeLiveTelemetry(fold, next, "a2", fence, { overlay: liveOverlay(state()) });
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

const childEntries = (cost: number, model = "claude", suffix = "") => [
  user(`c-u${suffix}`, null),
  {
    ...assistant(`c-a${suffix}`, `c-u${suffix}`),
    message: {
      ...assistant(`c-a${suffix}`, `c-u${suffix}`).message,
      model,
      usage: { input: 8, output: 2, totalTokens: 10, cost: { total: cost } },
    },
  },
];

function spendSource(path: string, cost: number) {
  const fold = TelemetryFold.create();
  fold.ingest(childEntries(cost));
  return { sessionPath: path, spend: childSpendFoldOf(fold.state) };
}

function expectStrictSnapshot(
  baseline: TelemetryChildSpendSnapshot,
  resolved: ReturnType<ChildTelemetryCache["resolve"]>,
) {
  expect(clientParamsSchemas["pi/session/telemetry/with-sources"].safeParse({
    path: baseline.scopeSessionPath,
    snapshot: { ...baseline, sources: resolved.sources, coverage: resolved.coverage },
    subscribe: true,
  }).success).toBe(true);
}

const emptySnapshot = (path: string, generation = 1): TelemetryChildSpendSnapshot => ({
  scopeSessionPath: path,
  generation,
  sources: [],
  coverage: { knownChildren: 0, includedChildren: 0, unavailableChildren: 0 },
});

describe("host baseline plus live child overlay", () => {
  it("adds only a live descendant of the requested root", () => {
    const cache = new ChildTelemetryCache();
    const runs = [
      run({ runId: "a1", sessionPath: "/a-child.jsonl", rootSessionPath: "/a.jsonl", status: "running", model: { provider: "anthropic", id: "claude" } }),
      run({ runId: "b1", sessionPath: "/b-child.jsonl", rootSessionPath: "/b.jsonl", status: "running", model: { provider: "anthropic", id: "claude" } }),
    ];
    const live = new Map<string, unknown[]>([["/a-child.jsonl", childEntries(0.2)], ["/b-child.jsonl", childEntries(9)]]);
    const resolved = cache.resolve(emptySnapshot("/a.jsonl"), runs, (path) => live.get(path));
    expect(resolved.sources).toHaveLength(1);
    expect(resolved.coverage).toEqual({ knownChildren: 1, includedChildren: 1, unavailableChildren: 0 });
    const parent = [user("u1", null), assistant("a1", "u1")];
    const snapshot = computeLiveTelemetry(TelemetryFold.create(), parent, "a1", fence, {
      overlay: liveOverlay(state()),
      children: resolved,
    });
    expect(snapshot.spend?.api?.totals.cost).toBeCloseTo(0.21);
  });

  it("asked about a child, overlays only its grandchild", () => {
    const cache = new ChildTelemetryCache();
    const runs = [
      run({ runId: "c", sessionPath: "/a-child.jsonl", rootSessionPath: "/a.jsonl", status: "running" }),
      run({ runId: "g", sessionPath: "/a-grand.jsonl", rootSessionPath: "/a.jsonl", parent: { sessionPath: "/a-child.jsonl", sessionId: "c" }, depth: 2, status: "running" }),
      run({ runId: "s", sessionPath: "/a-sib.jsonl", rootSessionPath: "/a.jsonl", status: "running" }),
    ];
    const live = new Map<string, unknown[]>([["/a-grand.jsonl", childEntries(0.03)], ["/a-sib.jsonl", childEntries(5)]]);
    const resolved = cache.resolve(emptySnapshot("/a-child.jsonl"), runs, (path) => live.get(path));
    expect(resolved.sources.map((source) => source.sessionPath)).toEqual(["/a-grand.jsonl"]);
    expect(resolved.sources[0]?.spend?.api.cost).toBeCloseTo(0.03);
  });

  it("rejects an older baseline after a newer dirty generation", () => {
    const cache = new ChildTelemetryCache();
    expect(cache.apply(emptySnapshot("/root.jsonl", 2))).toEqual({ applied: true, generation: 2 });
    expect(cache.invalidate("/root.jsonl", 4)).toBe(4);
    expect(cache.apply(emptySnapshot("/root.jsonl", 3))).toEqual({ applied: false, generation: 4 });
    expect(cache.streaming("/root.jsonl", [], () => undefined)).toBeUndefined();
    expect(cache.apply(emptySnapshot("/root.jsonl", 4))).toEqual({ applied: true, generation: 4 });
    expect(cache.streaming("/root.jsonl", [], () => undefined)?.coverage).toEqual({
      knownChildren: 0,
      includedChildren: 0,
      unavailableChildren: 0,
    });
  });

  it("keeps an incomplete host membership baseline conservative for unknown live paths", () => {
    const cache = new ChildTelemetryCache();
    const snapshot: TelemetryChildSpendSnapshot = {
      scopeSessionPath: "/root.jsonl",
      generation: 1,
      sources: [spendSource("/serialized.jsonl", 0.2)],
      coverage: { knownChildren: 2, includedChildren: 1, unavailableChildren: 1 },
    };
    const runs = [
      run({ runId: "omitted", sessionPath: "/omitted.jsonl", rootSessionPath: "/root.jsonl", status: "running" }),
      run({ runId: "new", sessionPath: "/new.jsonl", rootSessionPath: "/root.jsonl", status: "running" }),
    ];
    const live = new Map<string, unknown[]>([
      ["/omitted.jsonl", childEntries(4)],
      ["/new.jsonl", childEntries(8)],
    ]);

    const resolved = cache.resolve(snapshot, runs, (path) => live.get(path));

    expect(resolved.sources.map((source) => source.sessionPath)).toEqual(["/serialized.jsonl"]);
    expect(resolved.coverage).toEqual({ knownChildren: 2, includedChildren: 1, unavailableChildren: 1 });
    expectStrictSnapshot(snapshot, resolved);
  });

  it("keeps live overlays inside source, model-line, and encoded snapshot bounds", () => {
    const root = "/root.jsonl";
    const sourceBounded = new ChildTelemetryCache({ sources: 1 });
    const sourceBaseline: TelemetryChildSpendSnapshot = {
      scopeSessionPath: root,
      generation: 1,
      sources: [{ sessionPath: "/known.jsonl" }],
      coverage: { knownChildren: 1, includedChildren: 0, unavailableChildren: 1 },
    };
    const sourceResolved = sourceBounded.resolve(sourceBaseline, [
      run({ runId: "new", sessionPath: "/new.jsonl", rootSessionPath: root, status: "running" }),
    ], () => childEntries(5));
    expect(sourceResolved.sources).toEqual(sourceBaseline.sources);
    expect(sourceResolved.coverage).toEqual({ knownChildren: 2, includedChildren: 0, unavailableChildren: 2 });
    expectStrictSnapshot(sourceBaseline, sourceResolved);

    const modelBounded = new ChildTelemetryCache({ modelLines: 1 });
    const unavailableBaseline: TelemetryChildSpendSnapshot = {
      scopeSessionPath: root,
      generation: 2,
      sources: [{ sessionPath: "/child.jsonl" }],
      coverage: { knownChildren: 1, includedChildren: 0, unavailableChildren: 1 },
    };
    const twoModels = [...childEntries(1, "claude", "-one"), ...childEntries(2, "gemini", "-two")];
    const modelResolved = modelBounded.resolve(unavailableBaseline, [
      run({ runId: "child", sessionPath: "/child.jsonl", rootSessionPath: root, status: "running" }),
    ], () => twoModels);
    expect(modelResolved.sources).toEqual(unavailableBaseline.sources);
    expect(modelResolved.coverage).toEqual({ knownChildren: 1, includedChildren: 0, unavailableChildren: 1 });
    expectStrictSnapshot(unavailableBaseline, modelResolved);

    const staleBaseline: TelemetryChildSpendSnapshot = {
      scopeSessionPath: root,
      generation: 3,
      sources: [spendSource("/child.jsonl", 0.1)],
      coverage: { knownChildren: 1, includedChildren: 1, unavailableChildren: 0 },
    };
    const byteBudget = new TextEncoder().encode(JSON.stringify(staleBaseline)).byteLength;
    const byteBounded = new ChildTelemetryCache({ bytes: byteBudget });
    const byteResolved = byteBounded.resolve(staleBaseline, [
      run({ runId: "child", sessionPath: "/child.jsonl", rootSessionPath: root, status: "running" }),
    ], () => childEntries(9, "model-name-that-makes-the-live-replacement-larger"));
    expect(byteResolved.sources).toEqual([{ sessionPath: "/child.jsonl" }]);
    expect(byteResolved.coverage).toEqual({ knownChildren: 1, includedChildren: 0, unavailableChildren: 1 });
    expect(new TextEncoder().encode(JSON.stringify({
      ...staleBaseline,
      sources: byteResolved.sources,
      coverage: byteResolved.coverage,
    })).byteLength).toBeLessThanOrEqual(byteBudget);
    expectStrictSnapshot(staleBaseline, byteResolved);
  });

  it("does not recount canonical membership removed by byte trimming", () => {
    const root = "/root.jsonl";
    const paths = ["/a.jsonl", "/b.jsonl", "/c.jsonl", "/d.jsonl", "/e.jsonl", "/f.jsonl"];
    const baseline: TelemetryChildSpendSnapshot = {
      scopeSessionPath: root, generation: 1,
      sources: paths.map((path) => spendSource(path, 1)),
      coverage: { knownChildren: 6, includedChildren: 6, unavailableChildren: 0 },
    };
    const resolved = new ChildTelemetryCache({ bytes: 250 }).resolve(baseline, [
      run({ runId: "new", sessionPath: "/g.jsonl", rootSessionPath: root, status: "running" }),
      run({ runId: "existing", sessionPath: "/f.jsonl", rootSessionPath: root, status: "running" }),
    ], () => childEntries(9));
    expect(resolved.coverage).toEqual({ knownChildren: 7, includedChildren: 0, unavailableChildren: 7 });
    expect(new TextEncoder().encode(JSON.stringify({ ...baseline, ...resolved })).byteLength).toBeLessThanOrEqual(250);
    expectStrictSnapshot(baseline, resolved);
  });

  it("replaces one unavailable canonical child once across duplicate active runs", () => {
    const cache = new ChildTelemetryCache();
    const snapshot: TelemetryChildSpendSnapshot = {
      scopeSessionPath: "/root.jsonl",
      generation: 1,
      sources: [{ sessionPath: "/child.jsonl", model: "anthropic/claude" }],
      coverage: { knownChildren: 1, includedChildren: 0, unavailableChildren: 1 },
    };
    const runs = [
      run({ runId: "one", sessionPath: "/child.jsonl", rootSessionPath: "/root.jsonl", status: "running" }),
      run({ runId: "two", sessionPath: "/child.jsonl", rootSessionPath: "/root.jsonl", status: "needs_input" }),
    ];
    const first = cache.resolve(snapshot, runs, () => childEntries(0.4));
    const second = cache.resolve(snapshot, runs, () => childEntries(0.4));
    expect(first.sources).toHaveLength(1);
    expect(first.coverage).toEqual({ knownChildren: 1, includedChildren: 1, unavailableChildren: 0 });
    expect(second.sources[0]?.spend).toEqual(first.sources[0]?.spend);

    const durableFold = TelemetryFold.create();
    durableFold.ingest(childEntries(0.4));
    const newer: TelemetryChildSpendSnapshot = {
      scopeSessionPath: "/root.jsonl",
      generation: 2,
      sources: [{ sessionPath: "/child.jsonl", spend: childSpendFoldOf(durableFold.state) }],
      coverage: { knownChildren: 1, includedChildren: 1, unavailableChildren: 0 },
    };
    cache.apply(newer);
    const terminal = runs.map((item) => ({ ...item, status: "completed" as const }));
    const settled = cache.streaming("/root.jsonl", terminal, () => childEntries(9));
    expect(settled?.sources[0]?.spend?.api.cost).toBeCloseTo(0.4);
  });
});
