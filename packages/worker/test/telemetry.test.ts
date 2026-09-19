import { describe, expect, it } from "vitest";
import { TelemetryFold } from "@lasercode/protocol";
import { computeLiveTelemetry, liveOverlay, telemetryUpdateKind } from "../src/telemetry.js";
import type { SessionState } from "@lasercode/protocol";

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
    expect(snapshot.context).toMatchObject({ tokens: 1200, contextWindow: 200000, autoCompact: { enabled: true, state: "idle" } });
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
