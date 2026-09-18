import { describe, expect, it, vi } from "vitest";
import {
  modelKey,
  SESSION_AGENT_ENTRY_TYPE,
  SESSION_FALLBACK_ENTRY_TYPE,
  SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE,
  type FallbackModelRef,
  type SessionFallbackEntry,
  type SessionState,
} from "@lasercode/protocol";
import { assertFirstTurnAdmission, FirstTurnLock, type FirstTurnAdmission } from "../src/first-turn.js";

const state = (over: Partial<SessionState> = {}): SessionState => ({
  path: "/p/s.jsonl",
  id: "s",
  cwd: "/p",
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
  ...over,
});

const admission = (over: Partial<FirstTurnAdmission> = {}): FirstTurnAdmission => ({
  state: state(),
  entries: [{ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "root" } }],
  roleKind: "root",
  pendingTrayCount: 0,
  dialogCount: 0,
  hasGoal: false,
  hasLiveWork: false,
  ...over,
});

const A: FallbackModelRef = { provider: "stub", id: "a" };
const B: FallbackModelRef = { provider: "stub", id: "b" };
const AT = "2026-09-18T08:00:00.000Z";
const activation = {
  id: "activation",
  chainKey: modelKey(A),
  models: [A, B],
  position: 0,
  startedAt: AT,
};
const fallbackEntry = (data: SessionFallbackEntry): unknown => ({
  type: "custom",
  customType: SESSION_FALLBACK_ENTRY_TYPE,
  data,
});
const activatedSetup = (over: Partial<SessionFallbackEntry> = {}): unknown => fallbackEntry({
  version: 1,
  event: "activated",
  at: AT,
  to: A,
  activation,
  models: {},
  ...over,
});
const clearedSetup = (over: Partial<SessionFallbackEntry> = {}): unknown => fallbackEntry({
  version: 1,
  event: "cleared",
  at: AT,
  to: B,
  activation: null,
  models: {},
  ...over,
});

describe("first-turn admission", () => {
  it("accepts empty memory and validated saved-empty metadata without treating choices as history", () => {
    expect(() => assertFirstTurnAdmission(admission({ entries: [] }))).not.toThrow();
    expect(() => assertFirstTurnAdmission(admission({ entries: [
      { type: "custom", customType: SESSION_AGENT_ENTRY_TYPE },
      { type: "custom", customType: SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE },
      { type: "model_change" },
      { type: "thinking_level_change" },
      { type: "session_info" },
      activatedSetup(),
      clearedSetup(),
    ] }))).not.toThrow();
  });

  it.each([
    ["attempt failure", activatedSetup({ event: "attempt_failed", from: A, failure: { class: "provider_down", at: AT } })],
    ["switch", activatedSetup({ event: "switched", from: A, to: B, failure: { class: "provider_down", at: AT } })],
    ["return", activatedSetup({ event: "returned", from: B, to: A, failure: { class: "provider_down", at: AT } })],
    ["exhaustion", activatedSetup({ event: "exhausted", from: B, failure: { class: "provider_down", at: AT } })],
    ["failure on activation", activatedSetup({ failure: { class: "provider_down", at: AT } })],
    ["failover on activation", activatedSetup({ failover: { id: "event", startedAt: AT, attempts: [] } })],
    ["model memory on activation", activatedSetup({ models: { [modelKey(A)]: { cooldownUntil: AT } } })],
    ["prior model on activation", activatedSetup({ from: B })],
    ["moved activation", activatedSetup({ activation: { ...activation, position: 1 } })],
    ["one-model non-chain", activatedSetup({ activation: { ...activation, models: [A] } })],
    ["duplicate-model chain", activatedSetup({ activation: { ...activation, models: [A, A] } })],
    ["mismatched first model", activatedSetup({ activation: { ...activation, models: [B, A] } })],
    ["mismatched chain key", activatedSetup({ activation: { ...activation, chainKey: modelKey(B) } })],
    ["mismatched target", activatedSetup({ to: B })],
    ["missing activation", activatedSetup({ activation: null })],
    ["activation on clear", clearedSetup({ activation })],
    ["malformed fallback", { type: "custom", customType: SESSION_FALLBACK_ENTRY_TYPE, data: { event: "activated" } }],
  ])("rejects fallback history shaped as %s", (_label, entry) => {
    expect(() => assertFirstTurnAdmission(admission({ entries: [entry] }))).toThrow("already started");
  });

  it.each(["attempt_failed", "switched"] as const)("does not let a later clean setup record hide an earlier %s record", (event) => {
    const earlier = activatedSetup({
      event,
      from: A,
      to: event === "switched" ? B : undefined,
      failure: { class: "provider_down", at: AT },
    });
    expect(() => assertFirstTurnAdmission(admission({ entries: [earlier, clearedSetup(), activatedSetup()] })))
      .toThrow("already started");
  });

  it.each([
    { label: "message", over: { state: state({ messageCount: 1 }) } },
    { label: "engine queue", over: { state: state({ pendingMessageCount: 1 }) } },
    { label: "stream", over: { state: state({ isStreaming: true }) } },
    { label: "compaction", over: { state: state({ isCompacting: true }) } },
    { label: "pending tray", over: { pendingTrayCount: 1 } },
    { label: "dialog", over: { dialogCount: 1 } },
    { label: "goal", over: { hasGoal: true } },
    { label: "live child work", over: { hasLiveWork: true } },
    { label: "unknown custom history", over: { entries: [{ type: "custom", customType: "other" }] } },
    { label: "user history", over: { entries: [{ type: "message", message: { role: "user" } }] } },
    { label: "assistant history", over: { entries: [{ type: "message", message: { role: "assistant" } }] } },
    { label: "tool history", over: { entries: [{ type: "message", message: { role: "toolResult" } }] } },
    { label: "compaction history", over: { entries: [{ type: "compaction" }] } },
    { label: "child role", over: { roleKind: "child" as const } },
    { label: "Beam role", over: { roleKind: "beam" as const } },
    { label: "Chat role", over: { roleKind: "chat" as const } },
  ])("rejects $label", ({ over }) => {
    expect(() => assertFirstTurnAdmission(admission(over))).toThrow("already started");
  });
});

describe("FirstTurnLock", () => {
  it("serializes same-session attempts while leaving other sessions independent", async () => {
    const lock = new FirstTurnLock();
    let release!: () => void;
    const first = lock.run("/a", () => new Promise<void>((resolve) => { release = resolve; }));
    const secondWork = vi.fn(async () => "second");
    const second = lock.run("/a", secondWork);
    const otherWork = vi.fn(async () => "other");
    await expect(lock.run("/b", otherWork)).resolves.toBe("other");
    expect(otherWork).toHaveBeenCalledOnce();
    expect(secondWork).not.toHaveBeenCalled();
    release();
    await first;
    await expect(second).resolves.toBe("second");
  });

  it("refuses an ordinary concurrent prompt and admits it after preflight release", async () => {
    const lock = new FirstTurnLock();
    const release = await lock.acquire("/a", true);
    await expect(lock.acquire("/a", false)).resolves.toBeUndefined();
    release!();
    const next = await lock.acquire("/a", false);
    expect(next).toBeTypeOf("function");
    next!();
  });

  it("exposes one idempotent active token for causal nested admission", async () => {
    const lock = new FirstTurnLock();
    const lease = await lock.acquireLease("/a", true);
    expect(lease?.active).toBe(true);
    expect(typeof lease?.token).toBe("symbol");
    expect(lock.busy("/a")).toBe(true);
    lease?.release();
    lease?.release();
    expect(lease?.active).toBe(false);
    expect(lock.busy("/a")).toBe(false);
  });

  it("releases the next attempt after a failure", async () => {
    const lock = new FirstTurnLock();
    await expect(lock.run("/a", async () => { throw new Error("no"); })).rejects.toThrow("no");
    await expect(lock.run("/a", async () => "retry")).resolves.toBe("retry");
  });
});
