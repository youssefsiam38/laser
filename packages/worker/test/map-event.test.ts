/** Pure mapping from Pi's AgentSessionEvent to protocol SessionUpdate (M0-T4). */
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mapEvent } from "../src/drivers/stable-sdk.js";

const assistant = { role: "assistant", content: [] } as unknown;
const partial = assistant as never;

describe("mapEvent", () => {
  it("maps a full prompt cycle in order and drops non-wire events", () => {
    const events = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "user", content: [] } },
      { type: "message_update", message: assistant, assistantMessageEvent: { type: "start", partial } },
      { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial } },
      { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial } },
      { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial } },
      { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello", partial } },
      { type: "message_end", message: assistant },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } },
      { type: "tool_execution_update", toolCallId: "t1", toolName: "read", args: {}, partialResult: "…" },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false },
      { type: "turn_end", message: assistant, toolResults: [] },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ] as unknown as AgentSessionEvent[];

    const kinds = events.map((e) => mapEvent(e)?.kind ?? null);
    expect(kinds).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      null, // start
      null, // text_start
      "text_delta",
      "text_delta",
      null, // text_end
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);

    const deltas = events.map((e) => mapEvent(e)).filter((u) => u?.kind === "text_delta");
    expect(deltas.map((d) => (d as { delta: string }).delta).join("")).toBe("Hello");
  });

  it("normalises roles and preserves tool payloads", () => {
    expect(mapEvent({ type: "message_start", message: { role: "toolResult" } } as never)).toEqual({
      kind: "message_start",
      role: "tool",
    });
    expect(mapEvent({ type: "message_start", message: { role: "bashExecution" } } as never)).toEqual({
      kind: "message_start",
      role: "custom",
    });
    expect(
      mapEvent({ type: "tool_execution_end", toolCallId: "x", toolName: "bash", result: { out: 1 }, isError: true } as never),
    ).toEqual({ kind: "tool_execution_end", toolCallId: "x", result: { out: 1 }, isError: true });
  });

  it("maps queue, compaction, retry and entry events", () => {
    expect(mapEvent({ type: "queue_update", steering: ["a"], followUp: [] } as never)).toEqual({
      kind: "queue_update",
      steering: ["a"],
      followUp: [],
    });
    expect(mapEvent({ type: "compaction_start", reason: "manual" } as never)).toEqual({ kind: "compaction_start" });
    expect(
      mapEvent({ type: "compaction_end", reason: "manual", result: { x: 1 }, aborted: false, willRetry: false } as never),
    ).toEqual({ kind: "compaction_end", ok: true });
    expect(
      mapEvent({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false } as never),
    ).toEqual({ kind: "compaction_end", ok: false });
    expect(mapEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "" } as never)).toEqual({
      kind: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
    });
    expect(mapEvent({ type: "entry_appended", entry: { id: "e" } } as never)).toEqual({
      kind: "entry_appended",
      entry: { id: "e" },
    });
    expect(mapEvent({ type: "session_info_changed", name: "x" } as never)).toBeUndefined();
  });
});
