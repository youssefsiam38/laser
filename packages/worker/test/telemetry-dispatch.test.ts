/**
 * `pi/session/telemetry` through WorkerServer.handle: fence branches, turn
 * errors, and streamed snapshots only after a subscriber has asked.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, type JsonRpcMessage, type SessionState, type SessionUpdateParams } from "@lasercode/protocol";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../src/driver.js";

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  private readonly listeners = new Set<DriverListener>();
  history: { entries: unknown[]; leafId: string | null } = { entries: [], leafId: null };
  header = { id: "s1", cwd: "/tmp/fake", version: 3 };
  private st: SessionState = {
    path: "/tmp/fake/s1.jsonl",
    id: "s1",
    cwd: "/tmp/fake",
    model: { provider: "anthropic", id: "claude", contextWindow: 200000 },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 2,
    pendingMessageCount: 0,
    contextUsage: { tokens: 1200, contextWindow: 200000, percent: 1 },
  };
  async open(options: { sessionPath?: string }) {
    if (options.sessionPath) this.st = { ...this.st, path: options.sessionPath };
    return this.st;
  }
  state() { return this.st; }
  subscribe(listener: DriverListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: DriverEvent) { for (const listener of this.listeners) listener(event); }
  async prompt() { return { accepted: true, queued: false }; }
  async steer() {}
  async followUp() {}
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() {}
  async listModels() { return []; }
  async setModel() { return this.st; }
  async setThinkingLevel() { return this.st; }
  async rename() {}
  async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork() { return { state: this.st }; }
  respondToUi() {}
  async commands() { return []; }
  async prompts() { return []; }
  async entries() { return { ...this.history }; }
  entriesNow() { return { ...this.history }; }
  sessionHeader() { return this.header; }
  async dispose() { this.emit({ type: "closed", reason: "disposed" }); }
}

function harness() {
  const out: JsonRpcMessage[] = [];
  const drivers: FakeDriver[] = [];
  const server = new WorkerServer({
    cwd: "/tmp/fake",
    createDriver: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; },
    send: (message) => out.push(message),
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((message) => "id" in message && message.id === id) as { result?: unknown; error?: { code: number; message: string } };
  };
  const updates = () =>
    out.filter((message) => "method" in message && message.method === "session/update") as Array<{ params: SessionUpdateParams }>;
  return { server, drivers, call, updates };
}

const user = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } };
const assistant = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-01-01T00:00:01.000Z",
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "claude",
    content: [{ type: "text", text: "ok" }],
    usage: { input: 4, output: 2, totalTokens: 6, cost: { total: 0.01 } },
  },
};

describe("pi/session/telemetry through WorkerServer.handle", () => {
  it("answers the live snapshot and translates turn fence errors", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    driver.history = { entries: [user, assistant], leafId: "a1" };
    const answer = await h.call(2, "pi/session/telemetry", { path: "/tmp/fake/s1.jsonl" });
    expect(answer.error).toBeUndefined();
    expect(answer.result).toMatchObject({
      authority: "live",
      scope: "session",
      history: { prompts: 1, records: 2 },
      spend: { billing: "api" },
    });

    const unnamed = await h.call(3, "pi/session/telemetry", { path: "/tmp/fake/s1.jsonl", scope: "turn" });
    expect(unnamed.error?.code).toBe(ErrorCodes.InvalidParams);

    const missing = await h.call(4, "pi/session/telemetry", { path: "/tmp/fake/s1.jsonl", scope: "turn", turnId: "nope" });
    expect(missing.error?.code).toBe(ErrorCodes.InvalidParams);
    expect(missing.error?.message).toBe("That turn is not part of this conversation any more.");

    const stale = await h.call(5, "pi/session/telemetry", {
      path: "/tmp/fake/s1.jsonl",
      revision: "r1.AAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(stale.error?.code).toBe(ErrorCodes.RevisionUnavailable);
    await h.server.dispose();
  });

  it("does not stream snapshots until a subscriber has asked", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    driver.history = { entries: [user, assistant], leafId: "a1" };
    driver.emit({ type: "update", update: { kind: "message_end" } });
    expect(h.updates().at(-1)?.params.telemetry).toBeUndefined();

    await h.call(2, "pi/session/telemetry", { path: "/tmp/fake/s1.jsonl" });
    driver.emit({ type: "update", update: { kind: "message_end" } });
    expect(h.updates().at(-1)?.params.telemetry).toMatchObject({ authority: "live", history: { records: 2 } });
    await h.server.dispose();
  });
});
