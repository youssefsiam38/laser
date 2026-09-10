import { describe, expect, it, vi } from "vitest";
import { SESSION_AGENT_ENTRY_TYPE, type SessionState } from "@lasercode/protocol";
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
  runningToolCount: 0,
  ...over,
});

describe("first-turn admission", () => {
  it("accepts empty memory and saved-empty metadata without treating choices as history", () => {
    expect(() => assertFirstTurnAdmission(admission({ entries: [] }))).not.toThrow();
    expect(() => assertFirstTurnAdmission(admission({ entries: [
      { type: "custom", customType: SESSION_AGENT_ENTRY_TYPE },
      { type: "model_change" },
      { type: "thinking_level_change" },
      { type: "session_info" },
    ] }))).not.toThrow();
  });

  it.each([
    { label: "message", over: { state: state({ messageCount: 1 }) } },
    { label: "engine queue", over: { state: state({ pendingMessageCount: 1 }) } },
    { label: "stream", over: { state: state({ isStreaming: true }) } },
    { label: "compaction", over: { state: state({ isCompacting: true }) } },
    { label: "pending tray", over: { pendingTrayCount: 1 } },
    { label: "dialog", over: { dialogCount: 1 } },
    { label: "goal", over: { hasGoal: true } },
    { label: "child work", over: { hasLiveWork: true } },
    { label: "tool", over: { runningToolCount: 1 } },
    { label: "custom history", over: { entries: [{ type: "custom", customType: "other" }] } },
    { label: "message history", over: { entries: [{ type: "message" }] } },
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

  it("releases the next attempt after a failure", async () => {
    const lock = new FirstTurnLock();
    await expect(lock.run("/a", async () => { throw new Error("no"); })).rejects.toThrow("no");
    await expect(lock.run("/a", async () => "retry")).resolves.toBe("retry");
  });
});
